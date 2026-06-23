/**
 * @file SubstationKit.cc
 * @brief Implementation of the embeddable IEC 61850 publisher library.
 *
 * Every namespace `substation::xxx::foo` forwards to the existing publisher
 * implementation under `native/src`. We don't duplicate code — we just
 * present a cleaner surface for Shivani's app to call.
 */
#include "SubstationKit.h"

/* ── Existing publisher backend ───────────────────────────────────────── */
#include "asn1_ber_encoder.h"
#include "sv_encoder.h"
#include "GooseEncoder.h"
#include "GooseService.h"   /* sv_goose_* TX/RX lifecycle */
#include "SpscBridge.h"     /* SpscBridge — used ONLY to feed GOOSE booleans */
#include "PublisherController.h"      /* PublisherController + sv_mp_* */
#include "sv_publisher_instance.h"    /* PublisherConfig + SvPublisherInstance */
#include "PcapTx.h"

/* ── Live-value ingest: one MPMC queue drained by one worker thread ────── */
#include "third_party/rigtorp/MPMCQueue.h"
#include <atomic>
#include <chrono>
#include <cstddef>
#include <thread>

namespace substation {

/*============================================================================
 * substation::ber  — forward to the existing C++ helpers (same names)
 *============================================================================*/
namespace ber {

size_t encode_tag(uint8_t* b, size_t n, uint8_t t)              { return ::ber_encode_tag(b,n,t); }
size_t encode_length(uint8_t* b, size_t n, size_t l)            { return ::ber_encode_length(b,n,l); }
size_t encode_tlv(uint8_t* b, size_t n, uint8_t t,
                  const uint8_t* v, size_t vl)                  { return ::ber_encode_tlv(b,n,t,v,vl); }
size_t encode_unsigned(uint8_t* b, size_t n, uint8_t t,
                       uint64_t v)                              { return ::ber_encode_unsigned(b,n,t,v); }
size_t encode_signed(uint8_t* b, size_t n, uint8_t t,
                     int64_t v)                                 { return ::ber_encode_signed(b,n,t,v); }
size_t encode_int32_fixed(uint8_t* b, size_t n, int32_t v)      { return ::ber_encode_int32_fixed(b,n,v); }
size_t encode_uint32_fixed(uint8_t* b, size_t n, uint32_t v)    { return ::ber_encode_uint32_fixed(b,n,v); }
size_t encode_visible_string(uint8_t* b, size_t n, uint8_t t,
                             const char* s)                     { return ::ber_encode_visible_string(b,n,t,s); }
size_t encode_octet_string(uint8_t* b, size_t n, uint8_t t,
                           const uint8_t* d, size_t dl)         { return ::ber_encode_octet_string(b,n,t,d,dl); }
size_t encode_boolean(uint8_t* b, size_t n, uint8_t t, int v)   { return ::ber_encode_boolean(b,n,t,v); }

}  // namespace ber

/*============================================================================
 * substation::sv  — forward to existing C ABI
 *============================================================================*/
namespace sv {

static_assert(sizeof(EncoderConfig) == sizeof(SvEncoderConfig),
              "sv::EncoderConfig must match SvEncoderConfig byte-for-byte");

void setConfig(const EncoderConfig& cfg) {
    sv_encoder_set_config(reinterpret_cast<const SvEncoderConfig*>(&cfg));
}
void getConfig(EncoderConfig* out) {
    sv_encoder_get_config(reinterpret_cast<SvEncoderConfig*>(out));
}
int encodePacket(uint32_t smpCnt, const int32_t* samples,
                 uint8_t* outBuffer, size_t* outSize) {
    return sv_encoder_encode_packet(smpCnt, samples, outBuffer, outSize);
}
int encodeMultiAsdu(uint32_t baseSmpCnt, const int32_t** samplesArray,
                    uint8_t* outBuffer, size_t* outSize) {
    return sv_encoder_encode_multi_asdu(baseSmpCnt, samplesArray, outBuffer, outSize);
}
size_t expectedFrameSize() { return sv_encoder_get_frame_size(); }

}  // namespace sv

/*============================================================================
 * substation::goose  — forward to existing C ABI
 *============================================================================*/
namespace goose {

static_assert(sizeof(EncoderConfig) == sizeof(GooseEncoderConfig),
              "goose::EncoderConfig must match GooseEncoderConfig byte-for-byte");
static_assert(sizeof(FrameState)    == sizeof(GooseFrameState),
              "goose::FrameState must match GooseFrameState byte-for-byte");

int encodeFrame(const EncoderConfig& cfg, const FrameState& state,
                uint8_t* out, size_t* outLen) {
    return goose_encode_frame(
        reinterpret_cast<const GooseEncoderConfig*>(&cfg),
        reinterpret_cast<const GooseFrameState*>(&state),
        out, outLen);
}

/*--- GOOSE TX/RX lifecycle — forward to the sv_goose_* C ABI -------------
 * The SPSC bridge is used here and ONLY here, purely to hand the boolean
 * state to the GooseTxScheduler. SV never uses it. */

int configureTx(uint16_t streamId, const EncoderConfig& cfg) {
    SpscBridge::instance().registerStream(streamId);   /* GOOSE stream feed */
    return sv_goose_configure_tx(
        streamId, cfg.srcMAC, cfg.dstMAC,
        cfg.vlanID, cfg.vlanPriority, cfg.appID, cfg.confRev,
        cfg.test, cfg.ndsCom, cfg.gocbRef, cfg.datSet, cfg.goID);
}

bool setValue(uint16_t streamId, bool value, uint64_t timestampNs) {
    SpscMessage msg{};
    msg.streamId      = streamId;
    msg.type          = SPSC_VALUE_BOOLEAN;
    msg.channelIndex  = 0;
    msg.value.boolean = value ? 1 : 0;
    msg.quality       = 0;
    msg.timestamp_ns  = timestampNs;
    return SpscBridge::instance().push(msg);
}

int startTx(uint16_t streamId, uint32_t heartbeatMs, uint32_t firstRetxMs) {
    return sv_goose_start_tx(streamId, heartbeatMs, firstRetxMs);
}
int stopTx(uint16_t streamId)     { return sv_goose_stop_tx(streamId); }
int stopAllTx()                   { return sv_goose_stop_all_tx(); }
int rxStart(const char* iface)    { return sv_goose_rx_start(iface); }
int rxStop()                      { return sv_goose_rx_stop(); }
int rxRegister(const char* gocbRef, uint16_t streamId) {
    return sv_goose_rx_register(gocbRef, streamId);
}
int rxClear()                     { return sv_goose_rx_clear(); }
void getStats(uint16_t streamId, uint64_t* txSent, uint64_t* txFailed,
              uint64_t* rxSeen, uint64_t* rxPushed) {
    sv_goose_get_stats(streamId, txSent, txFailed, rxSeen, rxPushed);
}

bool popDecoded(uint16_t streamId, bool* outValue, uint64_t* outTimestampNs) {
    if (!outValue) return false;
    SpscMessage msg{};
    if (!SpscBridge::instance().popOutbound(streamId, &msg)) return false;
    *outValue = (msg.value.boolean != 0);
    if (outTimestampNs) *outTimestampNs = msg.timestamp_ns;
    return true;
}

}  // namespace goose

/*============================================================================
 * substation::publisher  — forward to PublisherController (equation-driven SV)
 *============================================================================*/
namespace publisher {

static_assert(sizeof(Config) == sizeof(PublisherConfig),
              "publisher::Config must match PublisherConfig byte-for-byte");

uint32_t add() {
    return PublisherController::instance().addPublisher();
}

int configure(uint32_t id, const Config& cfg) {
    return PublisherController::instance().configurePublisher(
        id, *reinterpret_cast<const PublisherConfig*>(&cfg));
}

int setEquations(uint32_t id, const char* equations) {
    return PublisherController::instance().setPublisherEquations(id, equations);
}

int  start()        { return PublisherController::instance().startAll(); }
int  stop()         { return PublisherController::instance().stopAll(); }
bool isRunning()    { return PublisherController::instance().isRunning(); }
uint32_t count()    { return PublisherController::instance().getPublisherCount(); }
int  removeAll()    { return PublisherController::instance().removeAllPublishers(); }
const char* lastError() { return PublisherController::instance().getLastError(); }

/*----------------------------------------------------------------------------
 * Live-value ingest worker
 *
 * One multi-producer queue (the simulator's many threads push) drained by ONE
 * consumer thread. The consumer routes each message: magnitudes go to the
 * target publisher's live store (SharedBuffer re-encode path); booleans go to
 * the GOOSE scheduler via goose::setValue (SPSC bridge, GOOSE-only). This is
 * additive — it does not alter the equation path in any way.
 *--------------------------------------------------------------------------*/
namespace {

struct IngestMsg {
    uint32_t id;            /* publisher id (magnitude) or GOOSE streamId (boolean) */
    uint8_t  channel;       /* SV channel index (magnitude only) */
    uint8_t  isBoolean;     /* 0 = magnitude, 1 = boolean */
    uint16_t quality;
    float    magnitude;
    uint8_t  boolean;
    uint64_t timestampNs;
};

rigtorp::MPMCQueue<IngestMsg>* g_ingestQueue = nullptr;
std::thread                    g_ingestWorker;
std::atomic<bool>              g_ingestRunning{false};

void routeMessage(const IngestMsg& m) {
    if (m.isBoolean) {
        /* GOOSE boolean — funnel into the scheduler (SPSC bridge, GOOSE-only). */
        substation::goose::setValue(static_cast<uint16_t>(m.id),
                                    m.boolean != 0, m.timestampNs);
    } else {
        /* SV magnitude — into the publisher's live store (no SPSC bridge). */
        SvPublisherInstance* p = PublisherController::instance().getPublisher(m.id);
        if (p) p->setLiveValue(m.channel, m.magnitude, m.quality);
    }
}

void ingestWorkerLoop() {
    IngestMsg m;
    while (g_ingestRunning.load(std::memory_order_acquire)) {
        if (g_ingestQueue->try_pop(m)) {
            routeMessage(m);
        } else {
            /* Idle: brief back-off so we don't spin a core when the sim is
             * between value updates. */
            std::this_thread::sleep_for(std::chrono::microseconds(50));
        }
    }
    /* Drain anything left so the last values still land before we exit. */
    while (g_ingestQueue && g_ingestQueue->try_pop(m))
        routeMessage(m);
}

}  // namespace

int init(size_t queueCapacity) {
    if (g_ingestRunning.load(std::memory_order_acquire)) return -1;
    if (queueCapacity < 2) queueCapacity = 2;
    g_ingestQueue = new rigtorp::MPMCQueue<IngestMsg>(queueCapacity);
    g_ingestRunning.store(true, std::memory_order_release);
    g_ingestWorker = std::thread(ingestWorkerLoop);
    return 0;
}

void shutdown() {
    if (!g_ingestRunning.exchange(false, std::memory_order_acq_rel)) return;
    if (g_ingestWorker.joinable()) g_ingestWorker.join();
    delete g_ingestQueue;
    g_ingestQueue = nullptr;
}

int reset() {
    shutdown();
    return PublisherController::instance().resetAll();
}

int setExternalMode(uint32_t id, bool external) {
    SvPublisherInstance* p = PublisherController::instance().getPublisher(id);
    if (!p) return -1;
    p->setSourceMode(external ? SvPublisherInstance::SourceMode::External
                              : SvPublisherInstance::SourceMode::Equation);
    return 0;
}

bool submitMagnitude(uint32_t id, uint8_t channel, float value,
                     uint16_t quality, uint64_t timestampNs) {
    if (!g_ingestRunning.load(std::memory_order_acquire) || !g_ingestQueue)
        return false;
    IngestMsg m{};
    m.id          = id;
    m.channel     = channel;
    m.isBoolean   = 0;
    m.quality     = quality;
    m.magnitude   = value;
    m.timestampNs = timestampNs;
    return g_ingestQueue->try_push(m);
}

bool submitBoolean(uint16_t streamId, bool value,
                   uint16_t quality, uint64_t timestampNs) {
    if (!g_ingestRunning.load(std::memory_order_acquire) || !g_ingestQueue)
        return false;
    IngestMsg m{};
    m.id          = streamId;
    m.isBoolean   = 1;
    m.quality     = quality;
    m.boolean     = value ? 1 : 0;
    m.timestampNs = timestampNs;
    return g_ingestQueue->try_push(m);
}

}  // namespace publisher

/*============================================================================
 * substation::net  — forward to existing PcapTx C ABI
 *============================================================================*/
namespace net {

static_assert(sizeof(Interface) == sizeof(NpcapInterface),
              "net::Interface must match NpcapInterface byte-for-byte");

int listInterfaces(Interface* out, int max_count) {
    return npcap_list_interfaces(reinterpret_cast<NpcapInterface*>(out), max_count);
}
int  open(const char* device)                           { return npcap_open(device); }
void close()                                            { npcap_close(); }
bool isOpen()                                           { return npcap_is_open() != 0; }
int  sendPacket(const uint8_t* data, size_t len)        { return npcap_send_packet(data, len); }
int  sendBatch(const uint8_t* const* data,
               const size_t* lens, size_t count)         { return npcap_send_packet_batch(data, lens, count); }
const char* lastError()                                 { return npcap_get_last_error(); }

}  // namespace net

}  // namespace substation
