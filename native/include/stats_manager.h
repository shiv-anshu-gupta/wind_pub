/**
 * @file stats_manager.h
 * @brief Statistics Tracking Module
 * 
 * Thread-safe statistics collection for packet transmission.
 */

#ifndef STATS_MANAGER_H
#define STATS_MANAGER_H

#include <cstdint>

// ============================================================================
// STATISTICS STRUCTURE (matches sv_native.h TransmitStats)
// ============================================================================

typedef struct StatsData {
    uint64_t packets_sent;
    uint64_t packets_failed;
    uint64_t packets_queued;
    uint64_t bytes_sent;
    uint64_t bytes_queued;
    uint64_t rate_bytes_sent;
    uint64_t rate_packets_sent;
    uint64_t rate_window_start_ms;
    double current_bps;
    double current_pps;
    double peak_bps;
    double peak_pps;
    uint64_t session_start_ms;
    uint64_t session_end_ms;
    uint64_t last_packet_ms;
    double avg_packet_size;
    double avg_interval_us;
    uint64_t last_interval_us;
    int session_active;
} StatsData;

#ifdef __cplusplus
extern "C" {
#endif

// ============================================================================
// STATS MANAGEMENT API
// ============================================================================

/**
 * Reset all statistics to zero
 */
void stats_reset(void);

/**
 * Start a new statistics session
 */
void stats_session_start(void);

/**
 * End the current statistics session
 */
void stats_session_end(void);

/**
 * Update rate calculations (call every ~250ms)
 */
void stats_update_rates(void);

/**
 * Get copy of current statistics
 */
void stats_get(StatsData* stats);

/**
 * Get session duration in milliseconds
 */
uint64_t stats_get_duration_ms(void);

/**
 * Format rate as human-readable string
 */
void stats_format_rate(double bps, char* buf, size_t buflen);

// ============================================================================
// STATS UPDATE FUNCTIONS (called from publisher)
// ============================================================================

/**
 * Record packets sent
 */
void stats_add_packets(uint32_t count, uint64_t bytes);

/**
 * Record packet failure
 */
void stats_add_failure(void);

/**
 * Update average packet size
 */
void stats_set_avg_packet_size(double size);

/**
 * Update last packet timestamp
 */
void stats_update_last_packet_time(void);

#ifdef __cplusplus
}
#endif

#endif // STATS_MANAGER_H
