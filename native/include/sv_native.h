/**
 * @file sv_native.h
 * @brief Header for Tauri FFI - C interface for Rust
 */

#ifndef SV_NATIVE_H
#define SV_NATIVE_H

#include <stdint.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

// ============================================================================
// STRUCTURES
// ============================================================================

/**
 * Network interface information
 */
typedef struct NpcapInterface {
    char name[256];
    char description[256];
    uint8_t mac[6];
    int has_mac;
} NpcapInterface;

/**
 * Transmission statistics
 */
typedef struct TransmitStats {
    uint64_t packets_sent;
    uint64_t packets_failed;
    uint64_t bytes_sent;
    uint64_t rate_bytes_sent;
    uint64_t rate_packets_sent;
    uint64_t rate_window_start_ms;
    double current_bps;
    double current_pps;
    double peak_bps;
    double peak_pps;
    uint64_t session_start_ms;
    uint64_t session_end_ms;       // Track when session ended
    uint64_t last_packet_ms;
    double avg_packet_size;
    int session_active;
} TransmitStats;

// ============================================================================
// ERROR HANDLING
// ============================================================================

const char* sv_get_last_error(void);

// ============================================================================
// NETWORK INTERFACE FUNCTIONS
// ============================================================================

int npcap_list_interfaces(NpcapInterface* interfaces, int max_count);
const char* npcap_get_last_error(void);
int npcap_open(const char* device_name);
void npcap_close(void);
int npcap_is_open(void);

// ============================================================================
// STATISTICS FUNCTIONS
// ============================================================================

void npcap_stats_reset(void);
void npcap_stats_session_start(void);
void npcap_stats_session_end(void);
void npcap_stats_update_rates(void);
void npcap_stats_get(TransmitStats* stats);
uint64_t npcap_stats_get_duration_ms(void);
void npcap_stats_format_rate(double bps, char* buf, size_t buflen);

// The legacy single-publisher C ABI (npcap_publisher_*, npcap_set_duration_mode,
// npcap_set_equations, npcap_get_sample_frame, npcap_get_current_channel_values,
// npcap_get_current_smp_cnt, npcap_export_cid*, ...) has been removed.
// Use PublisherController + SvPublisherInstance from C++ directly, the
// CID generator (sv_cid_export) from cid_generator.h, or the WebSocket
// dispatcher in PubWsServer.cc from JavaScript.

// ============================================================================
// FAULT INJECTION FUNCTIONS
// ============================================================================

/**
 * Configure fault injection from JSON string
 * @param json_config - JSON with fault parameters
 * @return 0 on success, -1 on error
 */
int sv_fault_inject_configure(const char* json_config);

/**
 * Enable or disable fault injection (master switch)
 * @param enable - 1 to enable, 0 to disable
 * @return 0 on success
 */
int sv_fault_inject_enable(int enable);

/**
 * Get fault injection statistics as JSON string
 * @return Static JSON buffer with current stats
 */
const char* sv_fault_inject_get_stats(void);

/**
 * Reset fault injection statistics counters
 */
void sv_fault_inject_reset_stats(void);

#ifdef __cplusplus
}
#endif

#endif /* SV_NATIVE_H */
