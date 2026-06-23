/**
 * @file sv_stats.h
 * @brief Transmission Statistics Module
 * 
 * Thread-safe statistics tracking for SV publishing.
 */

#ifndef SV_STATS_H
#define SV_STATS_H

#include "sv_native.h"  // For TransmitStats struct

#ifdef __cplusplus
extern "C" {
#endif

// TransmitStats struct is defined in sv_native.h

// ============================================================================
// FUNCTIONS
// ============================================================================

/**
 * Reset all statistics to zero
 */
void npcap_stats_reset(void);

/**
 * Start a new statistics session
 */
void npcap_stats_session_start(void);

/**
 * End the current statistics session
 */
void npcap_stats_session_end(void);

/**
 * Update rate calculations (call periodically)
 */
void npcap_stats_update_rates(void);

/**
 * Get current statistics
 * @param stats Output structure
 */
void npcap_stats_get(TransmitStats* stats);

/**
 * Get session duration in milliseconds
 * @return Duration in ms
 */
uint64_t npcap_stats_get_duration_ms(void);

/**
 * Format a bit rate as human-readable string
 * @param bps Bits per second
 * @param buf Output buffer
 * @param buflen Buffer size
 */
void npcap_stats_format_rate(double bps, char* buf, size_t buflen);

/**
 * Record a successful packet transmission
 * @param bytes Number of bytes sent
 */
void npcap_stats_record_packet(size_t bytes);

/**
 * Record a failed packet transmission
 */
void npcap_stats_record_failure(void);

/**
 * Batch-record N successful packets and their total byte count in one
 * shot. Use this from worker threads that accumulate stats locally and
 * flush periodically — turns N×4 hot-path atomic ops into 4 atomic ops,
 * eliminating cache-line bouncing on the global counters.
 *
 * @param count          Number of successful packets to credit
 * @param bytes_total    Sum of all those packets' lengths
 */
void npcap_stats_record_packet_batch(uint64_t count, uint64_t bytes_total);

/**
 * Batch-record N failed packet transmissions. Pair with
 * npcap_stats_record_packet_batch() for worker periodic flushes.
 */
void npcap_stats_record_failure_batch(uint64_t count);

/**
 * Get current time in milliseconds
 * @return Milliseconds since epoch
 */
uint64_t npcap_stats_get_time_ms(void);

#ifdef __cplusplus
}
#endif

#endif // SV_STATS_H
