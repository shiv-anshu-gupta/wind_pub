/**
 * @file GooseService.cc
 * @brief Implementation of the GOOSE TX schedulers + RX C ABI.
 */
#include "../include/GooseService.h"
#include "../include/GooseTxScheduler.h"
#include "../include/GooseReceiver.h"

#include <cstring>
#include <memory>
#include <mutex>
#include <unordered_map>
#include <vector>

namespace {

struct Service {
    std::mutex                                                       mutex;
    std::unordered_map<uint16_t, std::unique_ptr<GooseTxScheduler>>  tx;
    std::unordered_map<uint16_t, GooseEncoderConfig>                 txConfig;
    std::unique_ptr<GooseReceiver>                                   rx;
};

Service& svc()
{
    static Service s;
    return s;
}

/* Safe string copy with truncation. */
void copy_ref(char* dst, size_t dstLen, const char* src)
{
    if (!dst || dstLen == 0) return;
    if (!src) { dst[0] = '\0'; return; }
    size_t n = strnlen(src, dstLen - 1);
    memcpy(dst, src, n);
    dst[n] = '\0';
}

}  // namespace

/*============================================================================
 * TX configure / start / stop
 *============================================================================*/

extern "C" int sv_goose_configure_tx(uint16_t streamId,
                                     const uint8_t* srcMAC, const uint8_t* dstMAC,
                                     int   vlanID, int   vlanPriority,
                                     uint16_t appID, uint32_t confRev,
                                     int   test, int   ndsCom,
                                     const char* gocbRef,
                                     const char* datSet,
                                     const char* goID)
{
    if (!srcMAC || !dstMAC || !gocbRef || !datSet || !goID) return -1;

    GooseEncoderConfig cfg{};
    memcpy(cfg.srcMAC, srcMAC, 6);
    memcpy(cfg.dstMAC, dstMAC, 6);
    cfg.vlanID       = vlanID;
    cfg.vlanPriority = vlanPriority;
    cfg.appID        = appID;
    cfg.confRev      = confRev;
    cfg.test         = test ? 1 : 0;
    cfg.ndsCom       = ndsCom ? 1 : 0;
    copy_ref(cfg.gocbRef, sizeof(cfg.gocbRef), gocbRef);
    copy_ref(cfg.datSet , sizeof(cfg.datSet),  datSet);
    copy_ref(cfg.goID   , sizeof(cfg.goID),    goID);

    std::lock_guard<std::mutex> lk(svc().mutex);
    svc().txConfig[streamId] = cfg;
    return 0;
}

extern "C" int sv_goose_start_tx(uint16_t streamId,
                                 uint32_t heartbeat_ms,
                                 uint32_t firstRetx_ms)
{
    std::lock_guard<std::mutex> lk(svc().mutex);

    auto itCfg = svc().txConfig.find(streamId);
    if (itCfg == svc().txConfig.end()) return -1;

    /* If already running, treat as success (idempotent). */
    auto itTx = svc().tx.find(streamId);
    if (itTx != svc().tx.end() && itTx->second && itTx->second->running())
        return 0;

    auto sched = std::make_unique<GooseTxScheduler>();
    sched->setConfig(itCfg->second);
    GooseTxScheduler::Settings s{};
    s.streamId        = streamId;
    s.heartbeat_ms    = (heartbeat_ms > 0) ? heartbeat_ms : 1000;
    s.firstRetx_ms    = (firstRetx_ms > 0) ? firstRetx_ms : 2;
    sched->setSettings(s);

    if (!sched->start()) return -1;
    svc().tx[streamId] = std::move(sched);
    return 0;
}

extern "C" int sv_goose_stop_tx(uint16_t streamId)
{
    std::unique_ptr<GooseTxScheduler> dying;
    {
        std::lock_guard<std::mutex> lk(svc().mutex);
        auto it = svc().tx.find(streamId);
        if (it == svc().tx.end()) return 0;
        dying = std::move(it->second);
        svc().tx.erase(it);
    }
    /* dying is destroyed outside the lock so stop()/join() don't deadlock
     * with code that takes the mutex (none today, but cheap to be safe). */
    return 0;
}

extern "C" int sv_goose_stop_all_tx(void)
{
    std::vector<std::unique_ptr<GooseTxScheduler>> dying;
    {
        std::lock_guard<std::mutex> lk(svc().mutex);
        for (auto& kv : svc().tx) dying.push_back(std::move(kv.second));
        svc().tx.clear();
    }
    return 0;
}

/*============================================================================
 * RX start / stop / registration
 *============================================================================*/

extern "C" int sv_goose_rx_start(const char* iface)
{
    if (!iface) return -1;
    std::lock_guard<std::mutex> lk(svc().mutex);
    if (svc().rx && svc().rx->running()) return 0;   /* idempotent */
    svc().rx = std::make_unique<GooseReceiver>();
    if (!svc().rx->start(iface)) {
        svc().rx.reset();
        return -1;
    }
    return 0;
}

extern "C" int sv_goose_rx_stop(void)
{
    std::unique_ptr<GooseReceiver> dying;
    {
        std::lock_guard<std::mutex> lk(svc().mutex);
        dying = std::move(svc().rx);
    }
    /* dying destructor joins the thread outside the lock */
    return 0;
}

extern "C" int sv_goose_rx_register(const char* gocbRef, uint16_t streamId)
{
    std::lock_guard<std::mutex> lk(svc().mutex);
    if (!svc().rx) return -1;
    svc().rx->registerStream(gocbRef ? gocbRef : "", streamId);
    return 0;
}

extern "C" int sv_goose_rx_clear(void)
{
    std::lock_guard<std::mutex> lk(svc().mutex);
    if (!svc().rx) return 0;
    svc().rx->clearStreams();
    return 0;
}

/*============================================================================
 * Stats
 *============================================================================*/

extern "C" void sv_goose_get_stats(uint16_t streamId,
                                   uint64_t* txSent, uint64_t* txFailed,
                                   uint64_t* rxSeen, uint64_t* rxPushed)
{
    std::lock_guard<std::mutex> lk(svc().mutex);

    if (txSent || txFailed) {
        auto it = svc().tx.find(streamId);
        if (it != svc().tx.end() && it->second) {
            if (txSent)   *txSent   = it->second->framesSent();
            if (txFailed) *txFailed = it->second->framesFailed();
        } else {
            if (txSent)   *txSent   = 0;
            if (txFailed) *txFailed = 0;
        }
    }
    if (rxSeen || rxPushed) {
        if (svc().rx) {
            if (rxSeen)   *rxSeen   = svc().rx->framesSeen();
            if (rxPushed) *rxPushed = svc().rx->framesPushed();
        } else {
            if (rxSeen)   *rxSeen   = 0;
            if (rxPushed) *rxPushed = 0;
        }
    }
}
