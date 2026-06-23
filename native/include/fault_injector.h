/**
 * @file fault_injector.h
 * @brief Fault Injection for IEC 61850-9-2 Subscriber Stress Testing
 *
 * Injects configurable network/protocol faults into the SV packet stream:
 *   - Packet loss (random + burst)
 *   - Packet duplication
 *   - Data corruption (smpCnt, channel values, BER, smpSynch, channel count)
 *   - Timing faults (jitter, fixed delay)
 *   - Stream interruption
 *
 * Safety:
 *   - NEVER modifies the pre-built frame cache (uses scratch buffer)
 *   - Thread-safe config updates (mutex-protected copy)
 *   - Zero overhead when disabled (single atomic bool check)
 */

#ifndef FAULT_INJECTOR_H
#define FAULT_INJECTOR_H

#include <cstdint>
#include <cstring>
#include <mutex>
#include <random>
#include <atomic>
#include <chrono>

/*============================================================================
 * FaultInjectorConfig — all injection parameters
 * All defaults are 0 / false (no injection = normal operation)
 *============================================================================*/

struct FaultInjectorConfig {
    /* Packet-level faults */
    double   packetLossRate;          /* 0.0-1.0 (0.05 = 5% random drop) */
    double   duplicateRate;           /* 0.0-1.0 (0.02 = 2% random duplicate) */
    double   reorderRate;             /* 0.0-1.0 — chance to hold a packet for late delivery */
    uint32_t reorderSamplesAfter;     /* number of packets to send before releasing the held one */
    uint32_t burstLossCount;          /* drop N consecutive packets */
    uint32_t burstLossIntervalSec;    /* every M seconds (0 = disabled) */

    /* Timing faults */
    uint32_t jitterMaxUs;             /* random ±N microseconds (0 = disabled) */
    uint32_t fixedDelayUs;            /* constant delay (0 = disabled) */

    /* Data corruption faults */
    double   corruptSmpCntRate;       /* 0.0-1.0 (set smpCnt to random value) */
    double   corruptValuesRate;       /* 0.0-1.0 (set random channel to garbage) */
    double   corruptChannelCountRate; /* 0.0-1.0 (change seqData length) */

    /* Protocol faults */
    double   wrongSmpSynchRate;       /* 0.0-1.0 (flip smpSynch flag) */
    double   corruptBerRate;          /* 0.0-1.0 (corrupt random APDU byte) */

    /* Stream-level faults */
    bool     streamInterruption;      /* periodically stop sending */
    uint32_t interruptDurationSec;    /* how long to stop (e.g., 5 seconds) */
    uint32_t interruptIntervalSec;    /* every N seconds (e.g., every 30 seconds) */

    /* Master switch */
    bool     enabled;
};

/*============================================================================
 * FaultInjectorStats — counters for UI display
 *============================================================================*/

struct FaultInjectorStats {
    uint64_t totalProcessed;
    uint64_t dropCount;
    uint64_t dupCount;
    uint64_t corruptCount;
    uint64_t interruptedCount;
    uint64_t reorderCount;
};

/*============================================================================
 * FaultInjector — per-packet fault decision engine
 *
 * Called from the writer loop for every packet BEFORE sending.
 * The process() method decides: send normal, send modified, drop, or duplicate.
 *
 * IMPORTANT: framePtr points into the publisher's pre-built frame cache.
 * We NEVER modify it — corruption is applied to scratchBuf (a copy).
 *============================================================================*/

class FaultInjector {
public:
    enum Action {
        SEND_NORMAL,           /* send the original frame as-is */
        SEND_MODIFIED,         /* send the scratch buffer (corrupted copy) */
        DROP,                  /* do not send this packet */
        DUPLICATE,             /* send the original frame twice */
        SEND_HELD_THEN_NORMAL  /* send scratch (released held packet) then framePtr */
    };

    FaultInjector();

    /* Config access (thread-safe) */
    void setConfig(const FaultInjectorConfig& cfg);
    FaultInjectorConfig getConfig() const;

    /**
     * Process one packet and decide what action the writer loop should take.
     *
     * @param framePtr   pointer to the original frame (read-only!)
     * @param frameLen   length of the original frame
     * @param scratchBuf caller-owned buffer for modified copy (>= 1600 bytes)
     * @param scratchLen [out] length of modified frame in scratchBuf
     * @return action to take
     */
    Action process(const uint8_t* framePtr, uint16_t frameLen,
                   uint8_t* scratchBuf, uint16_t* scratchLen);

    /** Extra delay to add to this packet (0 = none) */
    uint32_t getExtraDelayUs();

    /** Check if we are currently in a stream-interruption window */
    bool isInterrupted();

    /** Quick check — avoids locking when disabled */
    bool isEnabled() const { return m_enabled.load(std::memory_order_relaxed); }

    /* Stats */
    FaultInjectorStats getStats() const;
    void resetStats();

private:
    /* Config protected by mutex — written from main thread, read from writer */
    mutable std::mutex m_mutex;
    FaultInjectorConfig m_cfg;

    /* Fast-path flag (avoids lock when disabled) */
    std::atomic<bool> m_enabled{false};

    /* Stats (atomic for lock-free reads from UI polling) */
    std::atomic<uint64_t> m_totalProcessed{0};
    std::atomic<uint64_t> m_dropCount{0};
    std::atomic<uint64_t> m_dupCount{0};
    std::atomic<uint64_t> m_corruptCount{0};
    std::atomic<uint64_t> m_interruptedCount{0};
    std::atomic<uint64_t> m_reorderCount{0};

    /* Reorder ("hold and release") state — protected by m_mutex */
    uint8_t  m_heldFrame[1600] = {0};
    uint16_t m_heldFrameLen     = 0;
    uint32_t m_heldCountdown    = 0;  /* packets still to send before releasing held */

    /* Burst loss state */
    uint64_t m_burstStartPacket = 0;
    uint64_t m_lastBurstTimeUs  = 0;
    bool     m_inBurst          = false;

    /* Stream interruption state */
    uint64_t m_lastInterruptTimeUs = 0;
    bool     m_inInterruption      = false;

    /* RNG */
    std::mt19937 m_rng{std::random_device{}()};
    double random01();

    /* Helpers */
    uint64_t steadyUs() const;
    bool applyCorruption(uint8_t* frame, uint16_t frameLen);
    uint8_t* findBerTag(uint8_t* apdu, uint16_t apduLen, uint8_t tag,
                        uint16_t* valueLen);
};

#endif /* FAULT_INJECTOR_H */
