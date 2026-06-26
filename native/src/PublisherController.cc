/**
 * @file PublisherController.cc
 * @brief Implementation of SharedBuffer + PublisherController + Multi-Publisher FFI
 *
 * This is the core of the multi-publisher architecture:
 *
 *   1. SharedBuffer::buildFromPublishers()
 *      - Takes all publishers' internal buffers
 *      - Merges into one sorted, interleaved schedule
 *      - Staggered timestamps so packets interleave evenly
 *
 *   2. PublisherController
 *      - Creates/manages SvPublisherInstance objects
 *      - On startAll(): prebuild → merge → spawn writer thread
 *      - Writer thread iterates the SharedBuffer, sends via npcap
 *
 *   3. FFI functions (extern "C")
 *      - sv_mp_* functions for Rust/Tauri to call
 *      - Complete lifecycle: add → configure → set equations → start → stop
 *
 * Architecture flow:
 *   UI → Tauri IPC → Rust FFI → sv_mp_* → PublisherController → SharedBuffer → npcap
 */

#include "../include/PublisherController.h"
#include "../include/PcapTx.h"
#include "../include/sv_stats.h"
#include "../include/sv_publisher_instance.h"

#include <cstdio>
#include <cstring>
#include <chrono>
#include <cmath>

#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <mmsystem.h>
#ifdef _MSC_VER
#pragma comment(lib, "winmm.lib")  /* MinGW links winmm via the build system */
#endif
#else
#include <unistd.h>
#include <pthread.h>
#include <sched.h>
#include <sys/mman.h>     /* mlockall — keep hot-path memory in RAM */
#include <cerrno>
#endif
#include <thread>

#include "../include/deadline_pacer.h"

/* Portable wall-clock-now in nanoseconds. std::chrono::system_clock is the
 * cross-platform equivalent of CLOCK_REALTIME (Unix-epoch wall time), so the
 * hot loop below no longer needs the POSIX-only clock_gettime() call and
 * compiles unchanged on Windows. */
static inline uint64_t now_ns_realtime()
{
    return (uint64_t)std::chrono::duration_cast<std::chrono::nanoseconds>(
               std::chrono::system_clock::now().time_since_epoch()).count();
}

/* SharedBuffer implementation moved to SharedBuffer.cc */

/*============================================================================
 * PublisherController — Singleton
 *============================================================================*/

PublisherController& PublisherController::instance()
{
    static PublisherController s_instance;
    return s_instance;
}

PublisherController::PublisherController()
{
    m_errorBuf[0] = '\0';
}

PublisherController::~PublisherController()
{
    stopAll();
}

/*============================================================================
 * Publisher Management
 *============================================================================*/

uint32_t PublisherController::addPublisher()
{
    std::lock_guard<std::mutex> lock(m_mutex);

    uint32_t id = m_nextId++;
    auto pub = std::make_unique<SvPublisherInstance>(id);
    m_publishers.push_back(std::move(pub));

    return id;
}

int PublisherController::removePublisher(uint32_t id)
{
    std::lock_guard<std::mutex> lock(m_mutex);

    if (m_running.load()) {
        snprintf(m_errorBuf, sizeof(m_errorBuf),
                 "Cannot remove publisher while running");
        return -1;
    }

    for (auto it = m_publishers.begin(); it != m_publishers.end(); ++it) {
        if ((*it)->getId() == id) {
            m_publishers.erase(it);
            return 0;
        }
    }

    snprintf(m_errorBuf, sizeof(m_errorBuf),
             "Publisher %u not found", id);
    return -1;
}

int PublisherController::removeAllPublishers()
{
    std::lock_guard<std::mutex> lock(m_mutex);

    if (m_running.load()) {
        snprintf(m_errorBuf, sizeof(m_errorBuf),
                 "Cannot remove publishers while running");
        return -1;
    }

    m_publishers.clear();
    m_sharedBuffer.clear();
    /* Note: m_nextId is INTENTIONALLY NOT reset. If any external code
     * still holds a publisher ID (e.g. the Tauri UI's stream list, or a
     * pending FFI call from another thread), reusing the same ID for a
     * brand-new publisher would silently rebind that handle to a
     * different stream. Keeping m_nextId monotonic guarantees every ID
     * value ever returned is unique for the lifetime of this process. */
    return 0;
}

SvPublisherInstance* PublisherController::getPublisher(uint32_t id)
{
    std::lock_guard<std::mutex> lock(m_mutex);
    return findPublisher(id);
}

SvPublisherInstance* PublisherController::getFirstPublisher()
{
    std::lock_guard<std::mutex> lock(m_mutex);
    if (m_publishers.empty()) return nullptr;
    /* Return the publisher with the lowest id. m_publishers is appended to
     * by addPublisher() and shrunk by removePublisher(); ids never reset,
     * so the head of the vector is the oldest remaining publisher, which
     * always has the lowest live id. Linear scan to make this robust if
     * insertion order ever changes. */
    SvPublisherInstance* best = nullptr;
    uint32_t bestId = UINT32_MAX;
    for (auto& pub : m_publishers) {
        if (pub->getId() < bestId) { bestId = pub->getId(); best = pub.get(); }
    }
    return best;
}

SvPublisherInstance* PublisherController::findPublisher(uint32_t id)
{
    for (auto& pub : m_publishers) {
        if (pub->getId() == id) return pub.get();
    }
    return nullptr;
}

uint32_t PublisherController::getPublisherCount() const
{
    std::lock_guard<std::mutex> lock(m_mutex);
    return (uint32_t)m_publishers.size();
}

/*============================================================================
 * Publisher Configuration (convenience wrappers)
 *============================================================================*/

int PublisherController::configurePublisher(uint32_t id, const PublisherConfig& config)
{
    std::lock_guard<std::mutex> lock(m_mutex);
    auto* pub = findPublisher(id);
    if (!pub) {
        snprintf(m_errorBuf, sizeof(m_errorBuf), "Publisher %u not found", id);
        return -1;
    }
    return pub->configure(config);
}

int PublisherController::setPublisherEquations(uint32_t id, const char* equations)
{
    std::lock_guard<std::mutex> lock(m_mutex);
    auto* pub = findPublisher(id);
    if (!pub) {
        snprintf(m_errorBuf, sizeof(m_errorBuf), "Publisher %u not found", id);
        return -1;
    }
    return pub->setEquations(equations);
}

/*============================================================================
 * Global Settings
 *============================================================================*/

/* PublisherController::setSendMode removed — backend always uses SendPacket (immediate). */

int PublisherController::setDuration(uint32_t seconds, bool repeat,
                               bool infinite, uint32_t count)
{
    m_durationSeconds = seconds;
    m_repeatEnabled   = repeat;
    m_repeatInfinite  = infinite;
    m_repeatCount     = count;
    m_repeatCycle.store(0);
    return 0;
}

uint32_t PublisherController::getRemainingSeconds() const
{
    if (m_durationSeconds == 0 || !m_running.load()) return m_durationSeconds;

    uint64_t elapsed = npcap_stats_get_time_ms() - m_startTimeMs.load();
    uint64_t total   = (uint64_t)m_durationSeconds * 1000ULL;
    return (elapsed >= total) ? 0 : (uint32_t)((total - elapsed) / 1000);
}

bool PublisherController::checkDurationElapsed() const
{
    if (m_durationSeconds == 0) return false;
    uint64_t elapsed = npcap_stats_get_time_ms() - m_startTimeMs.load();
    return elapsed >= (uint64_t)m_durationSeconds * 1000ULL;
}

/*============================================================================
 * Thread Priority Helpers
 *============================================================================*/

void PublisherController::elevateThreadPriority()
{
#ifdef _WIN32
    timeBeginPeriod(1);
    SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_TIME_CRITICAL);
    printf("[controller] Writer thread: TIME_CRITICAL\n");
#else
    struct sched_param param;
    param.sched_priority = 20;
    if (pthread_setschedparam(pthread_self(), SCHED_RR, &param) == 0) {
        printf("[controller] Writer thread: SCHED_RR priority %d\n", param.sched_priority);
    } else {
        (void)nice(-10);
        printf("[controller] Writer thread: nice(-10) fallback\n");
    }
#endif
}

void PublisherController::restoreThreadPriority()
{
#ifdef _WIN32
    timeEndPeriod(1);
    SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_NORMAL);
#else
    struct sched_param param;
    param.sched_priority = 0;
    pthread_setschedparam(pthread_self(), SCHED_OTHER, &param);
#endif
}

/*============================================================================
 * Lifecycle: startAll / stopAll
 *============================================================================*/

int PublisherController::startAll()
{
    if (m_running.load()) {
        snprintf(m_errorBuf, sizeof(m_errorBuf), "Already running");
        return -1;
    }
    if (!npcap_is_open()) {
        snprintf(m_errorBuf, sizeof(m_errorBuf), "No network interface open");
        return -1;
    }

    /* Safety: join any leftover writer thread from a previous session
     * that ended naturally (duration elapsed, m_running set to false
     * by the writer loop itself). Without this, assigning a new thread
     * to m_writerThread would crash (std::terminate). */
    if (m_writerThread.joinable()) {
        printf("[controller] Joining leftover writer thread before restart\n");
        m_writerThread.join();
    }

    std::lock_guard<std::mutex> lock(m_mutex);

    if (m_publishers.empty()) {
        snprintf(m_errorBuf, sizeof(m_errorBuf), "No publishers added");
        return -1;
    }

    printf("[controller] ═══════════════════════════════════════════\n");
    printf("[controller] Starting %zu publisher(s)...\n", m_publishers.size());

    /*
     * STEP 1: Pre-build frames for each publisher (SEQUENTIAL)
     * Each publisher sets the global encoder config and builds its frames.
     * Sequential execution avoids encoder state conflicts.
     */
    for (auto& pub : m_publishers) {
        if (pub->getState() < SvPublisherInstance::CONFIGURED) {
            printf("[controller] WARNING: publisher %u not configured, skipping\n",
                   pub->getId());
            continue;
        }
        int ret = pub->prebuildFrames();
        if (ret != 0) {
            snprintf(m_errorBuf, sizeof(m_errorBuf),
                     "Publisher %u: prebuild failed: %s",
                     pub->getId(), pub->getLastError());
            return -1;
        }
    }

    /*
     * STEP 2: Build SharedBuffer (merged interleaved schedule)
     * Merges all publishers' internal buffers into one sorted timeline.
     */
    m_sharedBuffer.buildFromPublishers(m_publishers);

    if (m_sharedBuffer.empty()) {
        snprintf(m_errorBuf, sizeof(m_errorBuf),
                 "Shared buffer is empty — no frames built");
        return -1;
    }

    /*
     * STEP 3: Start writer thread
     */
    m_startTimeMs.store(npcap_stats_get_time_ms());
    m_durationComplete.store(false);
    m_repeatCycle.store(0);
    m_running.store(true);

    m_writerThread = std::thread(&PublisherController::writerLoop, this);

    printf("[controller] Writer thread started\n");
    printf("[controller] ═══════════════════════════════════════════\n");
    return 0;
}

int PublisherController::stopAll()
{
    bool wasRunning = m_running.exchange(false);

    /* ALWAYS join the writer thread if joinable — even if m_running was
     * already false (e.g., duration elapsed and the writer loop ended
     * naturally).  Without this, the next startAll() would assign a new
     * std::thread to a still-joinable m_writerThread, which calls
     * std::terminate() and crashes (STATUS_STACK_BUFFER_OVERRUN). */
    if (m_writerThread.joinable()) {
        printf("[controller] Joining writer thread...\n");
        m_writerThread.join();
    }

    m_sharedBuffer.clear();

    /* Disable fault injection on stop */
    {
        FaultInjectorConfig disabledCfg = {};
        m_faultInjector.setConfig(disabledCfg);
        m_faultInjector.resetStats();
    }

    /* Defense-in-depth: clear all publishers so stale state never persists.
     * The frontend always does removeAll + add + configure before each start,
     * so keeping old publishers serves no purpose and risks accumulation bugs.
     * m_nextId stays monotonic (see removeAllPublishers comment). */
    {
        std::lock_guard<std::mutex> lock(m_mutex);
        m_publishers.clear();
    }

    if (wasRunning)
        printf("[controller] Stopped (publishers cleared)\n");
    else
        printf("[controller] Cleaned up stale session (publishers cleared)\n");
    return 0;
}

int PublisherController::resetAll()
{
    printf("[controller] ═══════════════════════════════════════════\n");
    printf("[controller] FULL RESET — clearing all state\n");

    /* 1. Stop transmission and ALWAYS join thread (even if naturally ended) */
    m_running.store(false);
    if (m_writerThread.joinable())
        m_writerThread.join();

    /* 2. Clear shared buffer */
    m_sharedBuffer.clear();

    /* 3. Clear all publishers (frees frame caches).
     *    m_nextId stays monotonic — never reused across the lifetime of
     *    the process. See removeAllPublishers() comment for rationale. */
    {
        std::lock_guard<std::mutex> lock(m_mutex);
        m_publishers.clear();
    }

    /* 4. Reset global settings to defaults */
    m_durationSeconds  = 0;
    m_repeatEnabled    = false;
    m_repeatInfinite   = false;
    m_repeatCount      = 0;
    m_repeatCycle.store(0);
    m_durationComplete.store(false);
    m_startTimeMs.store(0);
    m_errorBuf[0] = '\0';

    /* 5. Reset stats */
    npcap_stats_reset();

    /* 6. Reset fault injector — disable AND clear config, not just stats.
     * Otherwise a previously-armed fault config would survive the reset and
     * fire on the next publish even though the UI shows it off. */
    {
        FaultInjectorConfig fcfg = FaultInjectorConfig{};   /* enabled=false, all zero */
        m_faultInjector.setConfig(fcfg);
        m_faultInjector.resetStats();
    }

    printf("[controller] Reset complete — all memory freed, all state cleared\n");
    printf("[controller] ═══════════════════════════════════════════\n");
    return 0;
}

/*============================================================================
 * Writer Thread — Entry Point
 * Dispatches to batch or immediate mode based on sendMode setting.
 *============================================================================*/

void PublisherController::writerLoop()
{
    /* Send-mode selection removed — always use immediate mode (SendPacket). */
    writerLoopImmediate();
}

/*============================================================================
 * Writer Loop — Immediate Mode (pcap_sendpacket per packet)
 *
 * Pacing modes (same as original single-publisher):
 *   <=4800 pps: SLEEP + SPIN hybrid
 *   <=50000 pps: pure SPIN (_mm_pause)
 *   >50000 pps: no pacing (max throughput)
 *============================================================================*/

/*============================================================================
 * Parallel Writer Pool
 *
 * Spawns N independent writer threads (auto-sized to CPU cores), each with
 * its OWN pcap handle and DeadlinePacer. Workers stride through the
 * SharedBuffer schedule (worker w handles entries w, w+N, w+2N, ...) so each
 * thread has equal load without any shared mutable state.
 *
 * Skipped when:
 *   - Fault injection is enabled (per-slot ordering must stay serial)
 *   - The host only has 1-2 cores (no win from parallel)
 *   - Schedule has fewer entries than candidate worker count
 *   - npcap_open_extra_handle() fails (e.g., on unsupported drivers)
 *
 * Returns true if the parallel pool ran (caller should NOT execute the
 * legacy single-thread loop on top), false to fall back to legacy.
 *============================================================================*/
bool PublisherController::tryParallelWriterPool()
{
    /* Worker pool DISABLED.
     *
     * Industry research (libIEC61850, rapid61850) shows that the standard
     * production approach for IEC 61850-9-2 publishers is a SINGLE writer
     * thread using a raw AF_PACKET socket — NOT a libpcap multi-worker
     * pool. The wire (1 Gbps = ~570k pps ceiling) is always the bottleneck
     * on this hardware, so any worker beyond the first just spins on a
     * blocked TX queue and starves the OS.
     *
     * The single-thread path below (writerLoopImmediate's legacy branch)
     * combined with the AF_PACKET path in PcapTx.cc delivers ~3× the
     * throughput of multi-worker libpcap, with no risk of saturating the
     * box. Keeping the worker pool code in place but unreachable so we
     * can re-enable it on a per-build basis if needed for testing. */
    return false;

    /* === unreachable below — preserved for reference =================== */
    const size_t   schedSize = m_sharedBuffer.size();
    const uint64_t cycle_us  = m_sharedBuffer.getCycleDuration();
    if (schedSize == 0 || cycle_us == 0)
        return false;

    /* Decide worker count — CONSERVATIVE defaults to avoid box freezes.
     *
     * Each worker can spin at near-100% CPU when its target rate exceeds
     * what the wire can absorb (e.g. 4800 smp/cyc × 20 streams asks for
     * 5.76 M pps but a 1 Gbps wire caps at ~570 k pps). With too many
     * workers, the OS / network softirqs / SSH all starve and the box
     * becomes unresponsive even WITHOUT realtime priority.
     *
     * Hard cap at 4 workers leaves AT LEAST 4 free cores on a typical
     * 8-core box for the OS to schedule itself. Tune up only after
     * verifying stability at your real target rate. */
    unsigned int cores = std::thread::hardware_concurrency();
    if (cores == 0) cores = 1;
    int workerCount = static_cast<int>(cores > 2 ? cores - 2 : 1);
    if (workerCount < 2) return false;            /* not worth the overhead */
    if (workerCount > 4) workerCount = 4;         /* SAFE ceiling — avoid OS starvation */
    if (workerCount > static_cast<int>(schedSize))
        workerCount = static_cast<int>(schedSize);

    /* Per-worker interval — each worker handles 1/N of the slots, so its
     * pacer ticks every N × (cycle_us / schedSize). Steady state: all
     * workers wake together and emit one packet each, giving the same
     * aggregate rate as the legacy loop but spread across cores. */
    const double avg_interval_us =
        (static_cast<double>(cycle_us) / static_cast<double>(schedSize))
        * static_cast<double>(workerCount);
    const uint64_t intervalNs =
        static_cast<uint64_t>(avg_interval_us * 1000.0);

    printf("[controller] Parallel writer pool: %d workers, "
           "per-worker interval=%.2f us (cores=%u, slots=%zu)\n",
           workerCount, avg_interval_us, cores, schedSize);

    /* Aggregate pps × avg frame size = target Mbps. Warn early if it
     * exceeds 1 Gbps wire capacity so the user knows they'll silently
     * sub-sample at the publisher and see wobbly receiver charts. The
     * default short-frame size (~219 B for single-ASDU SV) is hard-coded
     * because frame size doesn't vary mid-session. */
    const uint64_t aggregate_pps =
        (cycle_us > 0)
            ? (static_cast<uint64_t>(schedSize) * 1000000ULL / cycle_us)
            : 0;
    if (aggregate_pps > 0) {
        const double approx_mbps = aggregate_pps * 219.0 * 8.0 / 1e6;
        if (approx_mbps > 950.0) {
            printf("[controller] ⚠ Target %llu pps ≈ %.0f Mbps exceeds "
                   "1 Gbps wire — publisher will silently sub-sample.\n",
                   static_cast<unsigned long long>(aggregate_pps),
                   approx_mbps);
        }
    }

    /* mlockall() removed — when paired with workers saturating multiple
     * cores at high pps, it can put enough pressure on the kernel page
     * tables to make the system unresponsive. The CAP_IPC_LOCK capability
     * stays granted in case a future stable rate justifies re-enabling. */

    /* DO NOT elevate to SCHED_RR for the worker pool. With N worker
     * threads inheriting that policy + mlockall + CPU pinning, the
     * workers can starve kernel softirqs and SSH/network handlers,
     * freezing the whole box. The DeadlinePacer + CPU pinning gives us
     * the latency we need without burning the system. */
    npcap_stats_reset();
    npcap_stats_session_start();

    std::atomic<uint64_t> totalPackets{0};
    std::atomic<uint64_t> totalFailures{0};

    std::vector<std::thread> workers;
    workers.reserve(workerCount);
    for (int w = 0; w < workerCount; ++w) {
        workers.emplace_back(
            &PublisherController::parallelWorkerLoop, this,
            w, workerCount, intervalNs,
            &totalPackets, &totalFailures);
    }

    /* Join all workers. Each one exits on its own when m_running goes false
     * or duration elapses. */
    for (auto& t : workers) {
        if (t.joinable()) t.join();
    }

    /* No restoreThreadPriority() — we never elevated. */
    npcap_stats_session_end();

    if (checkDurationElapsed()) {
        m_durationComplete.store(true);
        m_running.store(false);
    }

    printf("[controller] Parallel pool done: %llu sent, %llu failed\n",
           (unsigned long long)totalPackets.load(),
           (unsigned long long)totalFailures.load());
    return true;
}

void PublisherController::parallelWorkerLoop(int workerId, int workerCount,
                                      uint64_t intervalNs,
                                      std::atomic<uint64_t>* totalPackets,
                                      std::atomic<uint64_t>* totalFailures)
{
    /* CPU pinning removed for now — with workers running at high pps,
     * pinning leaves softirqs trapped on whichever cores aren't pinned,
     * which can trigger OS starvation. Letting the kernel scheduler
     * move workers freely is safer at this scale. */

    /* Each worker opens its OWN pcap handle. pcap_t* is NOT safe for
     * concurrent pcap_sendpacket() across threads, so one handle per
     * worker is mandatory. The kernel TX queue / NIC driver handle the
     * actual concurrency safely below libpcap.
     *
     * RAII via PcapHandle ensures the handle is closed even if a future
     * change adds an early-return path before the explicit close call. */
    PcapHandle my_handle = PcapHandle::openExtra();
    if (!my_handle) {
        fprintf(stderr,
                "[controller] worker %d: npcap_open_extra_handle() failed — "
                "this worker will not send. (%s)\n",
                workerId, npcap_get_last_error());
        return;
    }

    const size_t schedSize = m_sharedBuffer.size();

    /* Use brace-init to dodge the "most vexing parse": with `(...)` the
     * compiler reads this line as a function declaration named `pacer`. */
    sv::DeadlinePacer pacer{std::chrono::nanoseconds{intervalNs}};

    /* Walk slots strided by workerCount starting at workerId, so workers
     * don't overlap. Steady state: each worker emits 1 packet per wake. */
    uint64_t schedIdx = static_cast<uint64_t>(workerId);

    /* Local accumulators — ZERO atomic ops in the hot path. We flush to
     * the global SvStats counters every FLUSH_EVERY packets, which
     * collapses 4 RMW atomics per packet into 4 per batch (~64× less
     * cache-line bouncing on the shared global counters). */
    constexpr uint64_t FLUSH_EVERY = 256;
    uint64_t batch_packets = 0;
    uint64_t batch_bytes   = 0;
    uint64_t batch_fails   = 0;
    uint64_t total_packets_worker  = 0;
    uint64_t total_failures_worker = 0;

    auto flush_local_stats = [&]() {
        if (batch_packets) {
            npcap_stats_record_packet_batch(batch_packets, batch_bytes);
            total_packets_worker += batch_packets;
            batch_packets = 0;
            batch_bytes   = 0;
        }
        if (batch_fails) {
            npcap_stats_record_failure_batch(batch_fails);
            total_failures_worker += batch_fails;
            batch_fails = 0;
        }
    };

    /* Per-worker scratch frame for fault-injected modifications.
     * FaultInjector::process() writes here when it needs to corrupt or
     * modify a packet; using a worker-local buffer means workers never
     * race on m_scratchFrame (the legacy single-thread member). */
    uint8_t workerScratch[1600];

    while (m_running.load() && !checkDurationElapsed()) {
        int due  = pacer.wait_due(sv::kMaxCatchupBurst);
        int sent = 0;
        for (; sent < due && m_running.load() && !checkDurationElapsed();
             ++sent) {
            const ScheduleEntry& e = m_sharedBuffer[schedIdx % schedSize];

            /* Publish the current frameIdx so the FrameViewer UI can show
             * "which smpCnt is going out right now." Atomic relaxed — UI
             * read is best-effort, no synchronization needed. */
            if (e.publisher) e.publisher->setCurrentSmpCnt(e.frameIdx);

            if (m_faultInjector.isEnabled()) {
                /* Fault decision is serialised across workers under
                 * m_faultMutex — the injector's HELD/DUPLICATE/RNG state
                 * must remain coherent. Send-side stays parallel: we hold
                 * the mutex ONLY for process(), unlock, then send. */
                FaultInjector::Action action;
                uint16_t              scratchLen = e.frameLen;
                bool                  interrupted;
                uint32_t              extraUs;
                {
                    std::lock_guard<std::mutex> lock(m_faultMutex);
                    interrupted = m_faultInjector.isInterrupted();
                    if (!interrupted) {
                        action = m_faultInjector.process(
                            e.framePtr, e.frameLen,
                            workerScratch, &scratchLen);
                        extraUs = m_faultInjector.getExtraDelayUs();
                    }
                }

                if (interrupted) {
                    schedIdx += static_cast<uint64_t>(workerCount);
                    continue;  /* stream interruption — drop slot */
                }

                /* Apply the chosen action OUTSIDE the mutex so sends
                 * happen in parallel across workers. */
                switch (action) {
                case FaultInjector::DROP:
                    break;
                case FaultInjector::SEND_MODIFIED:
                    if (extraUs > 0)
                        std::this_thread::sleep_for(
                            std::chrono::microseconds(extraUs));
                    if (my_handle.send(workerScratch, scratchLen) == 0) {
                        ++batch_packets; batch_bytes += scratchLen;
                    } else { ++batch_fails; }
                    break;
                case FaultInjector::DUPLICATE:
                    /* Original first, then again via the normal-send fall-through. */
                    if (my_handle.send(e.framePtr, e.frameLen) == 0) {
                        ++batch_packets; batch_bytes += e.frameLen;
                    }
                    [[fallthrough]];
                case FaultInjector::SEND_NORMAL:
                default:
                    if (extraUs > 0)
                        std::this_thread::sleep_for(
                            std::chrono::microseconds(extraUs));
                    if (my_handle.send(e.framePtr, e.frameLen) == 0) {
                        ++batch_packets; batch_bytes += e.frameLen;
                    } else { ++batch_fails; }
                    break;
                case FaultInjector::SEND_HELD_THEN_NORMAL:
                    /* Release the held (late) packet first, then send current. */
                    if (my_handle.send(workerScratch, scratchLen) == 0) {
                        ++batch_packets; batch_bytes += scratchLen;
                    } else { ++batch_fails; }
                    if (extraUs > 0)
                        std::this_thread::sleep_for(
                            std::chrono::microseconds(extraUs));
                    if (my_handle.send(e.framePtr, e.frameLen) == 0) {
                        ++batch_packets; batch_bytes += e.frameLen;
                    } else { ++batch_fails; }
                    break;
                }
            } else {
                /* Normal (no-fault) hot path. */
                if (my_handle.send(e.framePtr, e.frameLen) == 0) {
                    ++batch_packets;
                    batch_bytes += e.frameLen;
                } else {
                    ++batch_fails;
                }
            }
            schedIdx += static_cast<uint64_t>(workerCount);
        }
        pacer.advance(sent);

        /* Periodic flush so the UI sees rate counters update during long
         * runs (UI polls SvStats every ~250 ms). */
        if (batch_packets + batch_fails >= FLUSH_EVERY) flush_local_stats();

        /* Safety yield — when the configured target rate exceeds wire
         * capacity, the pacer never blocks (every wake says "already
         * due"). Without a yield, the worker monopolises its core and
         * starves kernel softirqs / SSH / the UI. sched_yield() lets the
         * OS slot in any ready work before we burn another quantum. */
        std::this_thread::yield();
    }

    /* Final flush at exit so we don't lose the tail of the session. */
    flush_local_stats();

    /* Aggregate the worker's totals into the pool-wide atomics — one
     * atomic per worker per session, not per packet. */
    if (total_packets_worker)
        totalPackets->fetch_add(total_packets_worker,
                                std::memory_order_relaxed);
    if (total_failures_worker)
        totalFailures->fetch_add(total_failures_worker,
                                 std::memory_order_relaxed);

    /* PcapHandle's destructor closes the handle automatically on scope
     * exit — no explicit close needed. */
}

void PublisherController::writerLoopImmediate()
{
    printf("[controller] Writer: IMMEDIATE mode (pcap_sendpacket)\n");

    /* Try multi-worker fast path first — it handles the common no-fault
     * high-throughput case using all available CPU cores. Falls through to
     * the legacy single-thread loop if the pool is disabled or unsuitable
     * (fault injection on, single core, etc.). */
    if (tryParallelWriterPool()) {
        /* Repeat-cycle logic mirrors the bottom of writerLoopImmediate. */
        if (checkDurationElapsed() && m_repeatEnabled) {
            m_repeatCycle.fetch_add(1);
            uint32_t cycle = m_repeatCycle.load();
            if (m_repeatInfinite || cycle < m_repeatCount) {
                printf("[controller] Repeat cycle %u (parallel)\n", cycle + 1);
                m_startTimeMs.store(npcap_stats_get_time_ms());
                m_durationComplete.store(false);
                m_running.store(true);
                writerLoopImmediate();   /* iterative re-entry */
            }
        }
        return;
    }

    printf("[controller] Writer: falling back to legacy single-thread loop\n");

    /* Outer while-loop replaces the previous `goto immediate_loop_start`.
     * Each iteration is one full duration cycle; we re-enter the body if
     * repeat is enabled and we still have cycles left. */
    uint64_t totalPackets  = 0;
    uint64_t totalFailures = 0;

    while (true) {

    elevateThreadPriority();
    npcap_stats_reset();
    npcap_stats_session_start();

    const size_t schedSize  = m_sharedBuffer.size();
    const uint64_t cycle_us = m_sharedBuffer.getCycleDuration();

    uint64_t aggregate_pps = (cycle_us > 0)
        ? (schedSize * 1000000ULL / cycle_us) : schedSize;

    /* Unified blocking pacer for ALL rates.
     *
     * The old code switched to a "NONE" mode above 50000 pps that did NO pacing
     * at all — it sent packets as fast as the CPU allowed (measured ~338k pps)
     * and spun a core at 100%. We now always pace against an absolute deadline
     * using clock_nanosleep(), so the thread sleeps between packets regardless
     * of rate. This both caps output to the configured rate and frees the CPU. */
    printf("[controller] Pacing: blocking absolute-deadline, aggregate: %llu pps\n",
           (unsigned long long)aggregate_pps);

    /* totalPackets / totalFailures live OUTSIDE the loop — they accumulate
     * across all repeat cycles. schedIdx resets per cycle. */
    uint64_t schedIdx = 0;

    /* Calculate average interval between consecutive schedule entries */
    double avg_interval_us = (aggregate_pps > 0)
        ? (1000000.0 / (double)aggregate_pps) : 250.0;
    auto intervalDur = std::chrono::nanoseconds(
        (int64_t)(avg_interval_us * 1000.0));

    /* One shared pacer drives the whole writer thread. It parks the thread in
     * the kernel until each schedule slot is due, then reports how many slots
     * are due now (1 at steady state; more only after a late wake-up). The
     * SharedBuffer schedule — built by buildFromPublishers(), already sorted and
     * staggered across every stream — is walked strictly in order here, so
     * multi-stream interleaving is untouched; the pacer only decides *when*. */
    sv::DeadlinePacer pacer(intervalDur);

    while (m_running.load() && !checkDurationElapsed()) {

        /* ===== FAULT-INJECTION MODE: strict per-slot pacing ===============
         * Each slot may carry its own action and added delay, so it is never
         * batched — one schedule slot is consumed per wake. */
        if (m_faultInjector.isEnabled()) {
            pacer.wait_due(1);   /* block until this slot is due */

            const ScheduleEntry& e = m_sharedBuffer[schedIdx % schedSize];

            /* Publish current frameIdx for FrameViewer (relaxed atomic). */
            if (e.publisher) e.publisher->setCurrentSmpCnt(e.frameIdx);

            /* SPSC live-encode hook (Phase 2).
             * Equation streams skip this and pay zero cost — well-predicted
             * branch. External streams pull fresh values from SpscBridge and
             * rewrite e.framePtr in place before the send below uses it. */
            if (e.publisher &&
                e.publisher->sourceMode() == SvPublisherInstance::SourceMode::External &&
                e.publisher->protocol()   == SvPublisherInstance::Protocol::SV)
            {
                uint64_t now_ns = now_ns_realtime();
                e.publisher->reencodeFrame((int)e.frameIdx, now_ns);
            }

            if (m_faultInjector.isInterrupted()) {
                /* Stream interruption — skip this slot entirely. */
            } else {
                uint16_t scratchLen = e.frameLen;
                FaultInjector::Action action = m_faultInjector.process(
                    e.framePtr, e.frameLen, m_scratchFrame, &scratchLen);

                bool sendCurrent = true;
                switch (action) {
                case FaultInjector::DROP:
                    sendCurrent = false;
                    break;

                case FaultInjector::SEND_MODIFIED: {
                    uint32_t extraUs = m_faultInjector.getExtraDelayUs();
                    if (extraUs > 0)
                        std::this_thread::sleep_for(std::chrono::microseconds(extraUs));
                    if (npcap_send_packet(m_scratchFrame, scratchLen) == 0) {
                        totalPackets++;
                        npcap_stats_record_packet(scratchLen);
                    } else {
                        totalFailures++;
                        npcap_stats_record_failure();
                    }
                    sendCurrent = false;
                    break;
                }

                case FaultInjector::DUPLICATE:
                    /* Send original first, then again via sendCurrent below. */
                    if (npcap_send_packet(e.framePtr, e.frameLen) == 0) {
                        totalPackets++;
                        npcap_stats_record_packet(e.frameLen);
                    }
                    break;

                case FaultInjector::SEND_HELD_THEN_NORMAL: {
                    /* Release the held (late) packet, then send the current. */
                    if (npcap_send_packet(m_scratchFrame, scratchLen) == 0) {
                        totalPackets++;
                        npcap_stats_record_packet(scratchLen);
                    } else {
                        totalFailures++;
                        npcap_stats_record_failure();
                    }
                    uint32_t extraUs = m_faultInjector.getExtraDelayUs();
                    if (extraUs > 0)
                        std::this_thread::sleep_for(std::chrono::microseconds(extraUs));
                    break;
                }

                case FaultInjector::SEND_NORMAL:
                default: {
                    uint32_t extraUs = m_faultInjector.getExtraDelayUs();
                    if (extraUs > 0)
                        std::this_thread::sleep_for(std::chrono::microseconds(extraUs));
                    break;
                }
                }

                if (sendCurrent) {
                    if (npcap_send_packet(e.framePtr, e.frameLen) == 0) {
                        totalPackets++;
                        npcap_stats_record_packet(e.frameLen);
                    } else {
                        totalFailures++;
                        npcap_stats_record_failure();
                    }
                }
            }

            schedIdx++;
            pacer.advance(1);
            continue;
        }

        /* ===== NORMAL MODE: cycle-based batched send (low-CPU pacing) =====
         *
         * Per-packet pacing breaks below the Linux scheduler precision
         * (~50 µs). Above ~20 kpps the per-packet interval drops below
         * that floor and the DeadlinePacer can't truly sleep — the
         * thread spins at 100 % CPU.
         *
         * Fix: send a small batch, then SLEEP FOR 1 ms (well above
         * scheduler precision). The kernel actually parks the thread and
         * CPU drops to ~(send-work-ms / 1 ms).
         *
         * Hard cap of MAX_BATCH = 600 keeps us at or below the 1 Gbps
         * wire ceiling (600 packets/ms × 219 B × 8 ≈ 1.05 Gbps). Without
         * this cap, very high configured rates (4800×60×20 = 5.76 Mpps
         * target) would push packets_per_cycle so high that sending
         * takes >1 ms wall-clock and the loop never sleeps.
         *
         * sleep_for is simpler than sleep_until + state tracking — no
         * stale-state pitfalls between repeat cycles. Small drift is
         * fine because the wire is the real rate limit anyway. */
        /* MAX_BATCH headroom: the cycle math has to account for the time
         * spent inside sendto() (~2 µs per packet on AF_PACKET raw). At
         * MAX_BATCH=600 the inner loop is busy ~1.2 ms by itself, leaving
         * no room to actually drain at 1 Gbps after the 1 ms sleep. We
         * raise the cap to 2000 so the wire can fill — the kernel's TX
         * queue + qdisc + NIC are still the real ceiling. */
        constexpr uint64_t MAX_BATCH       = 2000;
        constexpr auto     CYCLE_SLEEP     = std::chrono::milliseconds{1};
        const uint64_t     packets_per_cycle =
            std::min<uint64_t>(MAX_BATCH,
                std::max<uint64_t>(1, aggregate_pps / 1000));

        /* sendmmsg batching — collapse N syscalls into 1.
         *
         * We pack SEND_BATCH packet pointers into parallel arrays, then
         * flush via npcap_send_packet_batch() which wraps sendmmsg. At
         * SEND_BATCH=16 that's a 16× reduction in syscall overhead. The
         * kernel still releases packets to the wire at line rate, so
         * receiver-side HW timestamps stay clean (~1.9 µs apart on 1 Gbps
         * with 219-byte SV frames — well within typical timestamp
         * resolution). */
        constexpr size_t SEND_BATCH = 16;
        const uint8_t*   batch_data[SEND_BATCH];
        size_t           batch_lens[SEND_BATCH];
        size_t           batch_n = 0;

        auto flush_batch = [&]() {
            if (batch_n == 0) return;
            int sent = npcap_send_packet_batch(
                batch_data, batch_lens, batch_n);
            if (sent < 0) sent = 0;
            for (size_t j = 0; j < batch_n; ++j) {
                if (j < static_cast<size_t>(sent)) {
                    totalPackets++;
                    npcap_stats_record_packet(batch_lens[j]);
                } else {
                    totalFailures++;
                    npcap_stats_record_failure();
                }
            }
            batch_n = 0;
        };

        /* Read wall-clock ONCE per cycle outside the hot loop — all packets
         * in this 1 ms batch get the same "now" stamp; sub-ms staggering is
         * recreated by reencodeFrame() per ASDU using period_ns. */
        const uint64_t now_ns_batch = now_ns_realtime();

        for (uint64_t i = 0;
             i < packets_per_cycle &&
             m_running.load() && !checkDurationElapsed();
             ++i) {
            const ScheduleEntry& e = m_sharedBuffer[schedIdx % schedSize];

            /* Publish current frameIdx for FrameViewer (relaxed atomic). */
            if (e.publisher) e.publisher->setCurrentSmpCnt(e.frameIdx);

            /* SPSC live-encode hook (Phase 2). Same pattern as fault-inject
             * path above; equation streams skip via the branch. */
            if (e.publisher &&
                e.publisher->sourceMode() == SvPublisherInstance::SourceMode::External &&
                e.publisher->protocol()   == SvPublisherInstance::Protocol::SV)
            {
                e.publisher->reencodeFrame((int)e.frameIdx, now_ns_batch);
            }

            batch_data[batch_n] = e.framePtr;
            batch_lens[batch_n] = e.frameLen;
            ++batch_n;
            ++schedIdx;
            if (batch_n == SEND_BATCH) flush_batch();
        }
        flush_batch();   /* drain the tail */

        std::this_thread::sleep_for(CYCLE_SLEEP);
    }

    restoreThreadPriority();

    /* Decide whether to start another repeat cycle. */
    {
        const bool duration_done = checkDurationElapsed();
        const bool another_cycle =
            duration_done && m_repeatEnabled &&
            (m_repeatInfinite
                || (m_repeatCycle.load() + 1) < m_repeatCount);

        if (!another_cycle) break;          /* exit outer while(true) */

        m_repeatCycle.fetch_add(1);
        printf("[controller] Repeat cycle %u\n",
               m_repeatCycle.load() + 1);
        m_startTimeMs.store(npcap_stats_get_time_ms());
        m_durationComplete.store(false);
    }
    } /* end while(true) — outer repeat loop */

    npcap_stats_session_end();

    if (checkDurationElapsed()) {
        m_durationComplete.store(true);
        m_running.store(false);
    }

    printf("[controller] Immediate writer complete: %llu sent, %llu failed\n",
           (unsigned long long)totalPackets,
           (unsigned long long)totalFailures);
}

/*============================================================================
 * FFI Exports — Multi-Publisher API for Rust/Tauri
 *
 * Naming: sv_mp_*  (mp = multi-publisher)
 * All functions delegate to PublisherController::instance()
 *============================================================================*/

extern "C" {

/*--- Publisher Management ---*/

uint32_t sv_mp_add_publisher(void)
{
    return PublisherController::instance().addPublisher();
}

int sv_mp_remove_publisher(uint32_t id)
{
    return PublisherController::instance().removePublisher(id);
}

int sv_mp_remove_all_publishers(void)
{
    return PublisherController::instance().removeAllPublishers();
}

uint32_t sv_mp_get_publisher_count(void)
{
    return PublisherController::instance().getPublisherCount();
}

/*--- Publisher Configuration ---*/

int sv_mp_configure_publisher(
    uint32_t id,
    const char* svID,
    uint16_t appID,
    uint32_t confRev,
    uint8_t smpSynch,
    const uint8_t* srcMAC,
    const uint8_t* dstMAC,
    int vlanPriority,
    int vlanID,
    uint64_t sampleRate,
    double frequency,
    double voltageAmplitude,
    double currentAmplitude,
    uint8_t asduCount,
    uint8_t channelCount)
{
    PublisherConfig config = {};

    if (svID && strlen(svID) > 0)
        strncpy(config.svID, svID, sizeof(config.svID) - 1);
    else
        strncpy(config.svID, "MU01", sizeof(config.svID) - 1);

    config.appID        = appID;
    config.confRev      = confRev;
    config.smpSynch     = smpSynch;
    if (srcMAC) memcpy(config.srcMAC, srcMAC, 6);
    if (dstMAC) memcpy(config.dstMAC, dstMAC, 6);
    config.vlanPriority = vlanPriority;
    config.vlanID       = vlanID;
    config.sampleRate   = sampleRate;
    config.frequency    = frequency;
    config.voltageAmplitude = voltageAmplitude;
    config.currentAmplitude = currentAmplitude;
    config.asduCount    = asduCount;
    config.channelCount = channelCount;

    return PublisherController::instance().configurePublisher(id, config);
}

int sv_mp_set_publisher_equations(uint32_t id, const char* equations)
{
    return PublisherController::instance().setPublisherEquations(id, equations);
}

/*--- New: source mode (Equation/External) + protocol (SV/GOOSE) ---
 *  mode:     0 = Equation, 1 = External (SPSC)
 *  protocol: 0 = SV,       1 = GOOSE
 *  Returns 0 on success, -1 if the publisher doesn't exist or bad arg. */
int sv_mp_set_publisher_source_mode(uint32_t id, int mode)
{
    SvPublisherInstance* pub = PublisherController::instance().getPublisher(id);
    if (!pub) return -1;
    if (mode != 0 && mode != 1) return -1;
    pub->setSourceMode(mode == 0
        ? SvPublisherInstance::SourceMode::Equation
        : SvPublisherInstance::SourceMode::External);
    return 0;
}

int sv_mp_set_publisher_protocol(uint32_t id, int protocol)
{
    SvPublisherInstance* pub = PublisherController::instance().getPublisher(id);
    if (!pub) return -1;
    if (protocol != 0 && protocol != 1) return -1;
    pub->setProtocol(protocol == 0
        ? SvPublisherInstance::Protocol::SV
        : SvPublisherInstance::Protocol::GOOSE);
    return 0;
}

/*--- Lifecycle ---*/

int sv_mp_start_all(void)
{
    return PublisherController::instance().startAll();
}

int sv_mp_stop_all(void)
{
    return PublisherController::instance().stopAll();
}

int sv_mp_reset_all(void)
{
    return PublisherController::instance().resetAll();
}

int sv_mp_is_running(void)
{
    return PublisherController::instance().isRunning() ? 1 : 0;
}

/*--- Global Settings ---*/

/* Send-mode setter/getter removed — backend always uses SendPacket (immediate). */

int sv_mp_set_duration(uint32_t seconds, int repeat,
                       int infinite, uint32_t count)
{
    return PublisherController::instance().setDuration(
        seconds, repeat != 0, infinite != 0, count);
}

uint32_t sv_mp_get_remaining_seconds(void)
{
    return PublisherController::instance().getRemainingSeconds();
}

uint32_t sv_mp_get_current_repeat_cycle(void)
{
    return PublisherController::instance().getCurrentRepeatCycle();
}

int sv_mp_is_duration_complete(void)
{
    return PublisherController::instance().isDurationComplete() ? 1 : 0;
}

const char* sv_mp_get_last_error(void)
{
    return PublisherController::instance().getLastError();
}

/* USB pad/gap setter/getter removed — only used by USB-Optimized mode which is gone. */

/*--- Fault Injection ---*/

/**
 * Configure fault injection from JSON string.
 * Format: {"packetLossRate":0.05,"duplicateRate":0.02,...,"enabled":true}
 * Minimal JSON parser — no external dependencies.
 */
int sv_fault_inject_configure(const char* json_config)
{
    if (!json_config) return -1;

    FaultInjectorConfig cfg = {};
    const char* s = json_config;

    /* Simple JSON field extraction */
    auto findDouble = [](const char* json, const char* key) -> double {
        char search[128];
        snprintf(search, sizeof(search), "\"%s\"", key);
        const char* p = strstr(json, search);
        if (!p) return 0.0;
        p = strchr(p, ':');
        if (!p) return 0.0;
        p++;
        while (*p == ' ' || *p == '\t') p++;
        return atof(p);
    };

    auto findUint = [](const char* json, const char* key) -> uint32_t {
        char search[128];
        snprintf(search, sizeof(search), "\"%s\"", key);
        const char* p = strstr(json, search);
        if (!p) return 0;
        p = strchr(p, ':');
        if (!p) return 0;
        p++;
        while (*p == ' ' || *p == '\t') p++;
        return (uint32_t)atol(p);
    };

    auto findBool = [](const char* json, const char* key) -> bool {
        char search[128];
        snprintf(search, sizeof(search), "\"%s\"", key);
        const char* p = strstr(json, search);
        if (!p) return false;
        p = strchr(p, ':');
        if (!p) return false;
        p++;
        while (*p == ' ' || *p == '\t') p++;
        return strncmp(p, "true", 4) == 0;
    };

    cfg.packetLossRate        = findDouble(s, "packetLossRate");
    cfg.duplicateRate         = findDouble(s, "duplicateRate");
    cfg.reorderRate           = findDouble(s, "reorderRate");
    cfg.reorderSamplesAfter   = findUint(s, "reorderSamplesAfter");
    cfg.burstLossCount        = findUint(s, "burstLossCount");
    cfg.burstLossIntervalSec  = findUint(s, "burstLossIntervalSec");
    cfg.jitterMaxUs           = findUint(s, "jitterMaxUs");
    cfg.fixedDelayUs          = findUint(s, "fixedDelayUs");
    cfg.corruptSmpCntRate     = findDouble(s, "corruptSmpCntRate");
    cfg.corruptValuesRate     = findDouble(s, "corruptValuesRate");
    cfg.corruptChannelCountRate = findDouble(s, "corruptChannelCountRate");
    cfg.wrongSmpSynchRate     = findDouble(s, "wrongSmpSynchRate");
    cfg.corruptBerRate        = findDouble(s, "corruptBerRate");
    cfg.streamInterruption    = findBool(s, "streamInterruption");
    cfg.interruptDurationSec  = findUint(s, "interruptDurationSec");
    cfg.interruptIntervalSec  = findUint(s, "interruptIntervalSec");
    cfg.enabled               = findBool(s, "enabled");

    /* Clamp rates to 0.0-1.0 */
    auto clamp01 = [](double v) { return (v < 0.0) ? 0.0 : (v > 1.0 ? 1.0 : v); };
    cfg.packetLossRate        = clamp01(cfg.packetLossRate);
    cfg.duplicateRate         = clamp01(cfg.duplicateRate);
    cfg.reorderRate           = clamp01(cfg.reorderRate);
    cfg.corruptSmpCntRate     = clamp01(cfg.corruptSmpCntRate);
    cfg.corruptValuesRate     = clamp01(cfg.corruptValuesRate);
    cfg.corruptChannelCountRate = clamp01(cfg.corruptChannelCountRate);
    cfg.wrongSmpSynchRate     = clamp01(cfg.wrongSmpSynchRate);
    cfg.corruptBerRate        = clamp01(cfg.corruptBerRate);

    PublisherController::instance().setFaultInjectorConfig(cfg);
    return 0;
}

int sv_fault_inject_enable(int enable)
{
    FaultInjectorConfig cfg = PublisherController::instance().getFaultInjectorConfig();
    cfg.enabled = (enable != 0);
    PublisherController::instance().setFaultInjectorConfig(cfg);
    return 0;
}

static char g_faultStatsJson[512];

const char* sv_fault_inject_get_stats(void)
{
    FaultInjectorStats stats = PublisherController::instance().getFaultInjectorStats();
    FaultInjectorConfig cfg = PublisherController::instance().getFaultInjectorConfig();

    snprintf(g_faultStatsJson, sizeof(g_faultStatsJson),
        "{\"enabled\":%s,\"totalProcessed\":%llu,\"dropCount\":%llu,"
        "\"dupCount\":%llu,\"corruptCount\":%llu,\"interruptedCount\":%llu,"
        "\"reorderCount\":%llu}",
        cfg.enabled ? "true" : "false",
        (unsigned long long)stats.totalProcessed,
        (unsigned long long)stats.dropCount,
        (unsigned long long)stats.dupCount,
        (unsigned long long)stats.corruptCount,
        (unsigned long long)stats.interruptedCount,
        (unsigned long long)stats.reorderCount);

    return g_faultStatsJson;
}

void sv_fault_inject_reset_stats(void)
{
    PublisherController::instance().resetFaultInjectorStats();
}

} /* extern "C" */
