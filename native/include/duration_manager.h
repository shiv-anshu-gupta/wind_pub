/**
 * @file duration_manager.h
 * @brief Duration and Repeat Mode Manager
 * 
 * Handles timed publishing and repeat cycles.
 * All timing happens in C++ backend, NOT frontend JavaScript!
 */

#ifndef DURATION_MANAGER_H
#define DURATION_MANAGER_H

#include <cstdint>
#include <atomic>

#ifdef __cplusplus
extern "C" {
#endif

// ============================================================================
// DURATION CONFIGURATION
// ============================================================================

typedef struct DurationConfig {
    uint32_t durationSeconds;   // 0 = continuous (no limit)
    uint32_t repeatCount;       // Number of times to repeat
    bool repeatEnabled;         // true = repeat mode enabled
    bool repeatInfinite;        // true = infinite repeat
} DurationConfig;

// ============================================================================
// DURATION MANAGER API
// ============================================================================

/**
 * Set duration and repeat configuration
 */
void duration_set_config(
    uint32_t durationSeconds,
    bool repeatEnabled,
    bool repeatInfinite,
    uint32_t repeatCount
);

/**
 * Get current duration configuration
 */
void duration_get_config(DurationConfig* config);

/**
 * Reset duration state (call before starting publishing)
 */
void duration_reset(void);

/**
 * Check if duration has elapsed for current cycle
 * @return true if should stop current cycle
 */
bool duration_check_elapsed(void);

/**
 * Start next repeat cycle
 * @return true if should continue, false if all cycles complete
 */
bool duration_start_next_cycle(void);

/**
 * Get current repeat cycle number (0-based)
 */
uint32_t duration_get_current_cycle(void);

/**
 * Get total configured repeat count
 */
uint32_t duration_get_total_cycles(void);

/**
 * Check if all cycles are complete
 */
bool duration_is_complete(void);

/**
 * Mark duration as complete (called when all cycles done)
 */
void duration_mark_complete(void);

/**
 * Get remaining seconds in current cycle
 */
uint32_t duration_get_remaining_seconds(void);

/**
 * Check if in continuous mode (no duration limit)
 */
bool duration_is_continuous(void);

#ifdef __cplusplus
}
#endif

#endif // DURATION_MANAGER_H
