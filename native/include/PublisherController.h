/**
 * @file PublisherController.h
 * @brief Main Controller + SharedBuffer for Multi-Publisher SV System
 *
 * Architecture:
 *
 *   PublisherController (Main Class)
 *       │
 *       ├── creates SvPublisherInstance 1  ──→  Internal Buffer 1
 *       ├── creates SvPublisherInstance 2  ──→  Internal Buffer 2
 *       └── creates SvPublisherInstance N  ──→  Internal Buffer N
 *                                                      │
 *                              ┌───────────────────────┘
 *                              ▼
 *                     SharedBuffer (merged schedule)
 *                     Sorted by timestamp, interleaved
 *                              │
 *                              ▼
 *                     Writer Thread (single)
 *                     TIME_CRITICAL priority
 *                     pcap_sendpacket / sendqueue
 *                              │
 *                              ▼
 *                         Network / NIC
 *
 * ## SharedBuffer
 * The SharedBuffer merges all publishers' internal buffers into a single
 * time-ordered interleaved schedule. Each entry points directly into the
 * publisher's pre-built frame cache (zero copy).
 *
 * This serves the same architectural role as SharedRingBuffer (teammate's
 * implementation), but optimized for the pre-built SV use case:
 *   - No Boost dependency
 *   - No locking at runtime (schedule is immutable once built)
 *   - Zero-copy (pointers into publishers' frame caches)
 *   - Timestamp-ordered (sorted during build)
 *
 * @note When SharedRingBuffer with Boost.Interprocess is available, the
 *       SharedBuffer can be replaced without changing the rest of the
 *       architecture.
 */

#ifndef SV_CONTROLLER_H
#define SV_CONTROLLER_H

#include "sv_publisher_instance.h"
#include "PcapTx.h"
#include "sv_stats.h"
#include "fault_injector.h"

#include <vector>
#include <memory>
#include <thread>
#include <atomic>
#include <mutex>
#include <algorithm>
#include <cstdio>

#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <mmsystem.h>
#pragma comment(lib, "winmm.lib")
#ifdef _MSC_VER
#include <intrin.h>
#endif
#else
#include <sched.h>
#endif

/* ScheduleEntry + SharedBuffer now live in their own files — see
 * SharedBuffer.h. Kept the include here so PublisherController users get
 * the schedule API transparently. */
#include "SharedBuffer.h"

/*============================================================================
 * PublisherController — Main Class
 *
 * Responsibilities:
 *   1. Create/manage multiple SvPublisherInstance objects
 *   2. Pre-build frames for all publishers
 *   3. Build the SharedBuffer (merged interleaved schedule)
 *   4. Run the writer thread to transmit via npcap
 *   5. Handle duration/repeat/sendMode
 *============================================================================*/

class PublisherController {
public:
    static PublisherController& instance();

    /*--- Publisher Management ---*/
    uint32_t addPublisher();
    int      removePublisher(uint32_t id);
    int      removeAllPublishers();
    SvPublisherInstance* getPublisher(uint32_t id);
    /** Returns the publisher with the lowest id, or nullptr if none.
     *  Used as a fallback when an inspection command (FrameViewer, CID
     *  export) doesn't specify an id, so "first publisher" still works
     *  after removeAll + add (where the new id is not 0). */
    SvPublisherInstance* getFirstPublisher();
    uint32_t getPublisherCount() const;

    /*--- Publisher Configuration (convenience) ---*/
    int configurePublisher(uint32_t id, const PublisherConfig& config);
    int setPublisherEquations(uint32_t id, const char* equations);

    /*--- Lifecycle ---*/
    int  startAll();
    int  stopAll();
    int  resetAll();
    bool isRunning() const { return m_running.load(); }

    /*--- Global Settings ---*/
    /* Send-mode + USB pad/gap setters removed — backend always uses
     * SendPacket (immediate). */
    int  setDuration(uint32_t seconds, bool repeat, bool infinite, uint32_t count);

    /*--- Duration / Repeat Queries ---*/
    uint32_t getRemainingSeconds() const;
    uint32_t getCurrentRepeatCycle() const { return m_repeatCycle.load(); }
    bool     isDurationComplete()   const { return m_durationComplete.load(); }

    /*--- Fault Injection ---*/
    void setFaultInjectorConfig(const FaultInjectorConfig& cfg) { m_faultInjector.setConfig(cfg); }
    FaultInjectorConfig getFaultInjectorConfig() const { return m_faultInjector.getConfig(); }
    FaultInjectorStats getFaultInjectorStats() const { return m_faultInjector.getStats(); }
    void resetFaultInjectorStats() { m_faultInjector.resetStats(); }

    const char* getLastError() const { return m_errorBuf; }

private:
    PublisherController();
    ~PublisherController();
    PublisherController(const PublisherController&) = delete;
    PublisherController& operator=(const PublisherController&) = delete;

    /*--- Publishers ---*/
    std::vector<std::unique_ptr<SvPublisherInstance>> m_publishers;
    uint32_t m_nextId = 1;
    mutable std::mutex m_mutex;

    /*--- Shared Buffer ---*/
    SharedBuffer m_sharedBuffer;

    /*--- Writer Thread ---*/
    std::thread      m_writerThread;
    std::atomic<bool> m_running{false};

    /*--- Global Settings ---*/
    uint32_t m_durationSeconds = 0;
    bool     m_repeatEnabled   = false;
    bool     m_repeatInfinite  = false;
    uint32_t m_repeatCount     = 0;
    std::atomic<uint32_t> m_repeatCycle{0};
    std::atomic<bool>     m_durationComplete{false};
    std::atomic<uint64_t> m_startTimeMs{0};

    /*--- Fault Injection ---*/
    FaultInjector m_faultInjector;
    uint8_t m_scratchFrame[1600];  /* legacy scratch buffer (single-thread path) */

    /* Serializes calls to m_faultInjector.process() from the worker pool.
     * The injector carries cross-slot state (HELD/DUPLICATE counters, RNG,
     * extra-delay queue) that must not race. Workers still SEND in
     * parallel — only the fault DECISION is mutex-protected. */
    mutable std::mutex m_faultMutex;

    char m_errorBuf[512];

    /*--- Internal ---*/
    SvPublisherInstance* findPublisher(uint32_t id);
    bool checkDurationElapsed() const;
    void writerLoop();
    void writerLoopImmediate();

    /* Multi-worker fast path: spawns N independent writer threads, each with
     * its own pcap handle and DeadlinePacer. Used when fault injection is
     * off and the user hasn't forced single-thread mode. Returns false to
     * fall back to the legacy single-thread loop. */
    bool tryParallelWriterPool();

    /* Single worker thread body for the parallel pool. Each worker sends a
     * 1/N stride of the SharedBuffer schedule using its own pcap handle. */
    void parallelWorkerLoop(int workerId, int workerCount,
                            uint64_t intervalNs,
                            std::atomic<uint64_t>* totalPackets,
                            std::atomic<uint64_t>* totalFailures);

    static inline void spinPause() {
#if defined(_MSC_VER)
        _mm_pause();
#elif defined(__x86_64__) || defined(__i386__)
        __builtin_ia32_pause();
#elif defined(__aarch64__) || defined(__arm__)
        asm volatile("yield");
#else
        sched_yield();
#endif
    }

    void elevateThreadPriority();
    void restoreThreadPriority();
};

/*============================================================================
 * Cross-module C FFI helpers
 *
 * Exposed via extern "C" so the single-publisher path (SvPublisher.cc) can
 * check whether the multi-publisher path is currently active without a
 * forward declaration. Putting it in the header makes the dependency
 * visible at compile time.
 *============================================================================*/

#ifdef __cplusplus
extern "C" {
#endif

/** 1 if the multi-publisher writer thread is running, 0 otherwise. */
int sv_mp_is_running(void);

#ifdef __cplusplus
}
#endif

#endif /* SV_CONTROLLER_H */
