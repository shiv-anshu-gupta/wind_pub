/**
 * @file GooseTxScheduler.cc
 * @brief Per-stream GOOSE retransmit timer + state-change detector.
 */
#include "../include/GooseTxScheduler.h"
#include "../include/SpscBridge.h"
#include "../include/PcapTx.h"

#include <chrono>
#include <cstdio>
#include <cstring>

namespace {
/* Wall-clock now in ns — matches the timestamp the teammate stamps
 * SpscMessage with, and what we put into the GOOSE PDU `t` field.
 *
 * std::chrono::system_clock is the portable equivalent of CLOCK_REALTIME
 * (Unix-epoch wall time) and compiles identically on Linux and Windows, so
 * we no longer need the POSIX-only clock_gettime() call here. */
inline uint64_t now_ns_realtime()
{
    return (uint64_t)std::chrono::duration_cast<std::chrono::nanoseconds>(
               std::chrono::system_clock::now().time_since_epoch()).count();
}
}  // namespace

bool GooseTxScheduler::start()
{
    if (m_running.load(std::memory_order_acquire)) return false;
    m_running.store(true, std::memory_order_release);
    m_thread = std::thread(&GooseTxScheduler::loop, this);
    return true;
}

void GooseTxScheduler::stop()
{
    if (!m_running.load(std::memory_order_acquire)) return;
    m_running.store(false, std::memory_order_release);
    if (m_thread.joinable()) m_thread.join();
}

/* The retransmit-ramp schedule:
 *
 *   On state change:
 *     fire at t=0, t=T0, t=2*T0, t=4*T0, t=8*T0, t=16*T0, ...
 *     Cap each interval at heartbeat_ms.
 *
 *   While idle (no change since last burst):
 *     fire every heartbeat_ms.
 *
 *   On every wake we ALSO check SpscBridge for fresh values — if found and
 *   the boolean differs from the cached one, we restart the ramp. */
void GooseTxScheduler::loop()
{
    using namespace std::chrono;

    SpscBridge& bridge = SpscBridge::instance();
    bool   cachedBool   = false;
    bool   hasCached    = false;
    uint32_t sqNum      = 0;
    uint32_t stNum      = m_stNum.load(std::memory_order_relaxed);
    uint64_t lastChange = now_ns_realtime();
    uint32_t nextInterval_ms = m_settings.firstRetx_ms;

    /* Fire one frame immediately so the receiver gets initial state quickly.
     * Note: the GOOSE PDU `t` field carries the LAST-STATE-CHANGE time, not
     * the current wall-clock — so the lambda doesn't take `now`. */
    auto fire = [&]() {
        GooseFrameState st{};
        st.stNum = stNum;
        st.sqNum = sqNum;
        st.timeAllowedToLive_ms = nextInterval_ms * 2;   /* IEC 8-1 recommends 2× */
        st.t_ns          = lastChange;
        st.booleanValue  = cachedBool ? 1 : 0;

        uint8_t frame[GOOSE_MAX_FRAME_SIZE];
        size_t  frameLen = sizeof(frame);
        if (goose_encode_frame(&m_cfg, &st, frame, &frameLen) == 0) {
            if (npcap_send_packet(frame, frameLen) == 0) {
                m_framesSent.fetch_add(1, std::memory_order_relaxed);
            } else {
                m_framesFailed.fetch_add(1, std::memory_order_relaxed);
            }
        } else {
            m_framesFailed.fetch_add(1, std::memory_order_relaxed);
        }
    };

    while (m_running.load(std::memory_order_relaxed)) {
        uint64_t now = now_ns_realtime();

        /* Pull whatever the teammate has pushed since last check. */
        SpscMessage incoming;
        if (bridge.sampleAt(m_settings.streamId, now, /*period_ns*/ 0, &incoming)) {
            const bool newBool = (incoming.value.boolean != 0);
            if (!hasCached) {
                cachedBool = newBool;
                hasCached  = true;
                lastChange = (incoming.timestamp_ns != 0) ? incoming.timestamp_ns : now;
                stNum      = 1;
                sqNum      = 0;
                m_stNum.store(stNum, std::memory_order_relaxed);
                nextInterval_ms = m_settings.firstRetx_ms;
                fire();
                std::this_thread::sleep_for(milliseconds(nextInterval_ms));
                continue;
            }
            if (newBool != cachedBool) {
                cachedBool = newBool;
                lastChange = (incoming.timestamp_ns != 0) ? incoming.timestamp_ns : now;
                stNum++;
                sqNum = 0;
                m_stNum.store(stNum, std::memory_order_relaxed);
                nextInterval_ms = m_settings.firstRetx_ms;
                fire();
                std::this_thread::sleep_for(milliseconds(nextInterval_ms));
                continue;
            }
        }

        /* No state change — emit retransmit / heartbeat at current cadence. */
        if (!hasCached) {
            /* No initial value yet — idle. Park briefly and re-check. */
            std::this_thread::sleep_for(milliseconds(m_settings.heartbeat_ms));
            continue;
        }

        sqNum++;
        fire();

        /* Ramp the interval. Once we hit heartbeat, stay there. */
        if (nextInterval_ms < m_settings.heartbeat_ms) {
            uint64_t doubled = (uint64_t)nextInterval_ms * 2;
            if (doubled > m_settings.heartbeat_ms) doubled = m_settings.heartbeat_ms;
            nextInterval_ms = (uint32_t)doubled;
        }

        std::this_thread::sleep_for(milliseconds(nextInterval_ms));
    }
}
