/**
 * @file GooseTxScheduler.h
 * @brief Per-stream GOOSE transmit timing — IEC 61850 retransmit ramp.
 *
 * Responsibilities
 * ----------------
 *   1. Poll SpscBridge::sampleAt() for the stream's current boolean.
 *   2. Detect a state change vs the previously cached value.
 *   3. On change: bump stNum, reset sqNum to 0, fire immediately, then
 *      schedule a doubling retransmit ramp: 2 ms, 4 ms, 8 ms, 16 ms,
 *      ... capped at heartbeat (T1, usually 1000 ms).
 *   4. While idle (no change): emit the heartbeat every T1.
 *
 * Threading
 * ---------
 * One scheduler thread per active GOOSE stream. The scheduler is the
 * single-consumer side of SpscBridge's inbound queue for that stream.
 *
 * Send path
 * ---------
 * Uses npcap_send_packet() (the same AF_PACKET raw socket the SV writer
 * uses). The thread sleeps between frames with std::this_thread::sleep_for
 * — no busy-wait.
 */
#pragma once

#include "GooseEncoder.h"

#include <atomic>
#include <cstdint>
#include <string>
#include <thread>

class GooseTxScheduler {
public:
    /** Runtime knobs — must be set BEFORE start(). */
    struct Settings {
        uint16_t streamId        = 0;     /* matches publisher's backendId    */
        uint32_t heartbeat_ms    = 1000;  /* T1 — period after the ramp ends  */
        uint32_t firstRetx_ms    = 2;     /* T0' — first retransmit interval  */
    };

    GooseTxScheduler() = default;
    ~GooseTxScheduler() { stop(); }

    GooseTxScheduler(const GooseTxScheduler&)            = delete;
    GooseTxScheduler& operator=(const GooseTxScheduler&) = delete;

    void setConfig(const GooseEncoderConfig& cfg) { m_cfg = cfg; }
    void setSettings(const Settings& s)           { m_settings = s; }

    /** Start the worker thread. Returns false if already running. */
    bool start();

    /** Stop the worker thread (blocks until joined). */
    void stop();

    bool running() const { return m_running.load(std::memory_order_acquire); }

    uint64_t framesSent()    const { return m_framesSent.load(std::memory_order_relaxed); }
    uint64_t framesFailed()  const { return m_framesFailed.load(std::memory_order_relaxed); }
    uint32_t stNum()         const { return m_stNum.load(std::memory_order_relaxed); }

private:
    void loop();

    GooseEncoderConfig m_cfg{};
    Settings           m_settings{};

    std::atomic<bool>     m_running{false};
    std::thread           m_thread;
    std::atomic<uint32_t> m_stNum{0};
    std::atomic<uint64_t> m_framesSent{0};
    std::atomic<uint64_t> m_framesFailed{0};
};
