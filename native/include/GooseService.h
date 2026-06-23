/**
 * @file GooseService.h
 * @brief Singleton holder for the GOOSE TX schedulers + the single RX.
 *
 * What lives here
 * ---------------
 * - `std::unordered_map<uint16_t, std::unique_ptr<GooseTxScheduler>>`
 *   — one scheduler per active GOOSE TX stream, keyed by streamId.
 * - `std::unique_ptr<GooseReceiver>` — at most one capture thread per
 *   interface; we only support one interface at a time in this phase.
 *
 * C ABI surface
 * -------------
 *   sv_goose_configure_tx(...)
 *   sv_goose_start_tx(streamId, heartbeat_ms, first_retx_ms)
 *   sv_goose_stop_tx(streamId)
 *   sv_goose_stop_all_tx()
 *   sv_goose_rx_start(iface)
 *   sv_goose_rx_stop()
 *   sv_goose_rx_register(gocbRef, streamId)
 *   sv_goose_rx_clear()
 *   sv_goose_get_stats(streamId, *txSent, *txFailed, *rxSeen, *rxPushed)
 *
 * Thread safety
 * -------------
 * One mutex protects the TX map (lookup/insert/erase). The receiver pointer
 * is touched only during start/stop, also under the same mutex.
 */
#pragma once

#include "GooseEncoder.h"

#include <cstdint>

#ifdef __cplusplus
extern "C" {
#endif

/** Configure (or update) the TX side of stream `streamId`. Replaces any
 *  previous config. Has no side effect on a running scheduler — call
 *  sv_goose_stop_tx() first if you need the change to take effect immediately.
 *
 *  Returns 0 on success, -1 on bad input. */
int sv_goose_configure_tx(uint16_t streamId,
                          const uint8_t* srcMAC, const uint8_t* dstMAC,
                          int   vlanID, int   vlanPriority,
                          uint16_t appID, uint32_t confRev,
                          int   test, int   ndsCom,
                          const char* gocbRef,
                          const char* datSet,
                          const char* goID);

/** Start the per-stream TX scheduler. Requires sv_goose_configure_tx() and
 *  sv_spsc_register(streamId) to have been called first.
 *
 *  Returns 0 on success, -1 if stream not configured or already running. */
int sv_goose_start_tx(uint16_t streamId,
                      uint32_t heartbeat_ms,
                      uint32_t firstRetx_ms);

/** Stop a single TX stream. Safe to call on a stream that isn't running. */
int sv_goose_stop_tx(uint16_t streamId);

/** Stop every TX stream. Useful on shutdown / "Stop All". */
int sv_goose_stop_all_tx(void);

/** Start the GOOSE receiver on `iface` (single global receiver). Returns 0
 *  on success, -1 if a receiver is already running or pcap failed. */
int sv_goose_rx_start(const char* iface);

/** Stop the receiver. Safe if none is running. */
int sv_goose_rx_stop(void);

/** Register a (gocbRef -> streamId) mapping for the receiver. Empty
 *  gocbRef ("") registers a catch-all. */
int sv_goose_rx_register(const char* gocbRef, uint16_t streamId);

/** Forget every receiver mapping. */
int sv_goose_rx_clear(void);

/** Read per-stream stats. NULL pointers skip the corresponding field.
 *  `rxSeen` / `rxPushed` are GLOBAL counters from the receiver, not
 *  per-stream — set both to NULL if you don't care. */
void sv_goose_get_stats(uint16_t streamId,
                        uint64_t* txSent, uint64_t* txFailed,
                        uint64_t* rxSeen, uint64_t* rxPushed);

#ifdef __cplusplus
}
#endif
