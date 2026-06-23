/**
 * @file SvStats.cc
 * @brief Transmission Statistics Tracker
 * 
 * Thread-safe statistics tracking for SV packet transmission.
 * Hot-path counters use relaxed atomics (no mutex, no cache-line contention).
 * Derived fields (avg_packet_size, last_packet_ms) computed lazily on poll.
 */

#include "../include/sv_stats.h"
#include <cstdio>
#include <cstring>
#include <mutex>
#include <chrono>
#include <atomic>

/*============================================================================
 * Module State
 *============================================================================*/

/* Hot-path atomic counters.
 *
 * Each counter sits on its OWN 64-byte cache line so independent counters
 * don't ping-pong across CPU caches when multiple worker threads update
 * different counters. Without alignas(64), the compiler can pack two
 * atomics onto one cache line and a write to one invalidates the other
 * on every other core (false sharing).
 *
 * For real throughput, callers should prefer the *_batch() functions
 * below — they collapse N×4 atomic ops into 4, which is the real win
 * over hot-path per-packet contention. */
struct alignas(64) PaddedCounter {
    std::atomic<uint64_t> value{0};
    char _pad[64 - sizeof(std::atomic<uint64_t>)];
};

static PaddedCounter g_packets_sent;
static PaddedCounter g_bytes_sent;
static PaddedCounter g_rate_packets;
static PaddedCounter g_rate_bytes;
static PaddedCounter g_packets_failed;

/* Cold-path state — mutex-protected, touched only on session start/end/poll */
static TransmitStats g_stats = {};
static std::mutex g_mutex;

/*============================================================================
 * Time Helper
 *============================================================================*/

uint64_t npcap_stats_get_time_ms(void) {
    using namespace std::chrono;
    return duration_cast<milliseconds>(steady_clock::now().time_since_epoch()).count();
}

/*============================================================================
 * Statistics API
 *============================================================================*/

extern "C" {

void npcap_stats_reset(void) {
    std::lock_guard<std::mutex> lock(g_mutex);
    g_packets_sent.value.store(0, std::memory_order_relaxed);
    g_bytes_sent.value.store(0, std::memory_order_relaxed);
    g_rate_packets.value.store(0, std::memory_order_relaxed);
    g_rate_bytes.value.store(0, std::memory_order_relaxed);
    g_packets_failed.value.store(0, std::memory_order_relaxed);
    memset(&g_stats, 0, sizeof(g_stats));
}

void npcap_stats_session_start(void) {
    std::lock_guard<std::mutex> lock(g_mutex);
    
    g_stats.session_start_ms = npcap_stats_get_time_ms();
    g_stats.session_end_ms = 0;
    g_stats.rate_window_start_ms = g_stats.session_start_ms;
    g_rate_bytes.value.store(0, std::memory_order_relaxed);
    g_rate_packets.value.store(0, std::memory_order_relaxed);
    g_stats.session_active = 1;
}

void npcap_stats_session_end(void) {
    std::lock_guard<std::mutex> lock(g_mutex);
    
    g_stats.session_end_ms = npcap_stats_get_time_ms();
    g_stats.last_packet_ms = g_stats.session_end_ms;
    g_stats.session_active = 0;
}

void npcap_stats_update_rates(void) {
    std::lock_guard<std::mutex> lock(g_mutex);
    
    uint64_t now = npcap_stats_get_time_ms();
    uint64_t elapsed = now - g_stats.rate_window_start_ms;

    /* Recompute once the window is at least ~200 ms wide.
     *
     * This is driven by the frontend's get_stats poll, which fires every
     * 250 ms. If this gate were also 250 ms, any poll arriving slightly
     * early (jitter/event-loop delay) would be < 250 and get SKIPPED — the
     * UI would then show a stale value that tick and the refresh would beat
     * irregularly (poll period == gate). Using 200 ms (< the 250 ms poll)
     * guarantees each poll crosses the gate, so the rate refreshes on every
     * tick. The rate magnitude is unaffected: current_bps divides by the
     * REAL elapsed window, not the gate. */
    if (elapsed >= 200) {
        /* Atomically read and reset rate counters */
        uint64_t rp = g_rate_packets.value.exchange(0, std::memory_order_relaxed);
        uint64_t rb = g_rate_bytes.value.exchange(0, std::memory_order_relaxed);
        
        double seconds = elapsed / 1000.0;
        if (seconds > 0) {
            g_stats.current_bps = (rb * 8.0) / seconds;
            g_stats.current_pps = rp / seconds;
            
            if (g_stats.current_bps > g_stats.peak_bps) g_stats.peak_bps = g_stats.current_bps;
            if (g_stats.current_pps > g_stats.peak_pps) g_stats.peak_pps = g_stats.current_pps;
        }
        
        g_stats.rate_window_start_ms = now;
    }
}

void npcap_stats_get(TransmitStats* stats) {
    std::lock_guard<std::mutex> lock(g_mutex);
    memcpy(stats, &g_stats, sizeof(TransmitStats));
    
    /* Snapshot hot counters into output */
    uint64_t pkts = g_packets_sent.value.load(std::memory_order_relaxed);
    uint64_t bytes = g_bytes_sent.value.load(std::memory_order_relaxed);
    stats->packets_sent = pkts;
    stats->bytes_sent = bytes;
    stats->packets_failed = g_packets_failed.value.load(std::memory_order_relaxed);
    stats->rate_packets_sent = g_rate_packets.value.load(std::memory_order_relaxed);
    stats->rate_bytes_sent = g_rate_bytes.value.load(std::memory_order_relaxed);
    
    /* Compute derived fields lazily (only on poll, not per-packet) */
    if (pkts > 0) {
        stats->avg_packet_size = (double)bytes / pkts;
    }
    if (g_stats.session_active) {
        stats->last_packet_ms = npcap_stats_get_time_ms();
    }
}

uint64_t npcap_stats_get_duration_ms(void) {
    std::lock_guard<std::mutex> lock(g_mutex);
    
    if (g_stats.session_start_ms == 0) return 0;
    
    if (g_stats.session_active) {
        return npcap_stats_get_time_ms() - g_stats.session_start_ms;
    }
    if (g_stats.session_end_ms > 0) {
        return g_stats.session_end_ms - g_stats.session_start_ms;
    }
    return 0;
}

void npcap_stats_format_rate(double bps, char* buf, size_t buflen) {
    if (bps >= 1e9)      snprintf(buf, buflen, "%.2f Gbps", bps / 1e9);
    else if (bps >= 1e6) snprintf(buf, buflen, "%.2f Mbps", bps / 1e6);
    else if (bps >= 1e3) snprintf(buf, buflen, "%.2f Kbps", bps / 1e3);
    else                 snprintf(buf, buflen, "%.0f bps", bps);
}

void npcap_stats_record_packet(size_t bytes) {
    /* Relaxed atomics only — no mutex, no clock read, no division */
    g_packets_sent.value.fetch_add(1, std::memory_order_relaxed);
    g_bytes_sent.value.fetch_add(bytes, std::memory_order_relaxed);
    g_rate_packets.value.fetch_add(1, std::memory_order_relaxed);
    g_rate_bytes.value.fetch_add(bytes, std::memory_order_relaxed);
}

void npcap_stats_record_failure(void) {
    g_packets_failed.value.fetch_add(1, std::memory_order_relaxed);
}

/* Batch flush from worker threads.
 *
 * Each worker accumulates its own counters locally (zero atomics in hot
 * path), then periodically flushes here. Instead of 4 atomic ops per
 * packet × N workers × M packets, we now do 4 atomic ops per flush —
 * typically once per ~256 packets. At 1 M pps with 4 workers, this
 * collapses ~16 million atomic-RMW ops/sec into ~16 thousand. */
void npcap_stats_record_packet_batch(uint64_t count, uint64_t bytes_total) {
    if (count == 0) return;
    g_packets_sent.value.fetch_add(count,       std::memory_order_relaxed);
    g_bytes_sent.value.fetch_add(bytes_total,   std::memory_order_relaxed);
    g_rate_packets.value.fetch_add(count,       std::memory_order_relaxed);
    g_rate_bytes.value.fetch_add(bytes_total,   std::memory_order_relaxed);
}

void npcap_stats_record_failure_batch(uint64_t count) {
    if (count == 0) return;
    g_packets_failed.value.fetch_add(count, std::memory_order_relaxed);
}

} /* extern "C" */
