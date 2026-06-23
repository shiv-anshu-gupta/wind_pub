/**
 * @file SpscBridge.h
 * @brief Two-way SPSC bridge between a teammate's app and this publisher.
 *
 * Purpose
 * -------
 * Lets another program (e.g. Shivani's app) feed values into this publisher
 * and read values back out, without either side touching the wire-protocol
 * details. This publisher stays a translator: it accepts numbers/booleans on
 * one side and emits IEC 61850-9-2 SV or IEC 61850-8-1 GOOSE frames on the
 * other.
 *
 * Two directions per stream
 * -------------------------
 *   INBOUND  (teammate -> publisher) — used to drive SV magnitude or GOOSE
 *                                       boolean values that the publisher
 *                                       encodes onto the wire.
 *   OUTBOUND (publisher -> teammate) — used to forward booleans we decoded
 *                                       from incoming GOOSE frames (e.g.
 *                                       "trip breaker" commands).
 *
 * Contract with the teammate
 * --------------------------
 *   - Teammate pushes a new value WHENEVER their data source produces one.
 *   - For SV streams: teammate guarantees push rate >= wire sample rate.
 *     The publisher downsamples with a centred boxcar average: every input
 *     sample whose timestamp falls in [t_ns - period/2, t_ns + period/2] is
 *     averaged to produce the value at t_ns. This handles any M-to-N ratio
 *     (1:1 to thousands:1) with constant per-output cost. If the window is
 *     empty (gap in input), linear interpolation between the surrounding
 *     two samples is the fallback; if even that is impossible, the most
 *     recent value is held.
 *   - For GOOSE streams: teammate pushes on state change. The publisher
 *     latches the last value and follows the IEC 61850 retransmit schedule
 *     (0, 2ms, 4ms, 8ms, ... heartbeat) — teammate never sees stNum/sqNum.
 *   - The "never upsample" rule (input rate < wire rate) is out of scope
 *     for this bridge — slower sources are handled by a different mechanism
 *     to be specified later.
 *
 * Thread safety
 * -------------
 *   - One SPSC ring per (stream, direction). True wait-free single-producer
 *     single-consumer semantics from rigtorp.
 *   - SAFE: one writer thread per stream pushes inbound; one reader thread
 *     per stream pops inbound. Same for outbound, reversed.
 *   - NOT SAFE: two threads on the same producer side, or same consumer
 *     side, of the same queue. Callers must serialize themselves.
 */
#pragma once

#include <atomic>
#include <array>
#include <cstdint>
#include <memory>

#include "third_party/rigtorp/SPSCQueue.h"

/*============================================================================
 * Shared message — IDENTICAL definition required on both sides.
 *
 * POD (plain-old-data) so it can later be moved into shared memory without
 * any layout change. No std::string, no pointers, no constructors.
 *============================================================================*/

enum SpscValueType : uint8_t {
    SPSC_VALUE_MAGNITUDE = 0,   /* used by SV streams */
    SPSC_VALUE_BOOLEAN   = 1,   /* used by GOOSE streams */
};

struct SpscMessage {
    uint16_t streamId;          /* matches the publisher's per-stream backendId */
    uint8_t  type;              /* SpscValueType */
    uint8_t  channelIndex;      /* 0..N-1 for multi-channel SV; 0 for GOOSE */
    union {
        float   magnitude;      /* SV value in physical units (A, V, ...) */
        uint8_t boolean;        /* GOOSE: 1 = closed, 0 = open (IEC 61850-7-4) */
    } value;
    uint16_t quality;           /* IEC 61850 quality bits; 0x0000 = good */
    uint16_t _pad;              /* explicit pad to keep timestamp 8-aligned */
    uint64_t timestamp_ns;      /* UTC ns. 0 = let publisher stamp at encode. */
};
static_assert(sizeof(SpscMessage) == 24, "SpscMessage must stay 24 bytes for ABI stability");

/*============================================================================
 * SpscBridge — owns one queue PAIR per registered stream.
 *
 * Stream IDs are uint16_t in [0..MAX_STREAMS-1]. The publisher's
 * sv_mp_add_publisher() returns a uint32_t id but in practice the count is
 * small; we narrow to uint16_t at registration time.
 *============================================================================*/

class SpscBridge {
public:
    /** Max simultaneous streams. 256 is way more than any real config; cost
     *  of unused slots is one unique_ptr (8 B) per slot. */
    static constexpr uint16_t MAX_STREAMS = 256;

    /** Default ring depth per (stream, direction). 256 is enough for breakers
     *  (1 push/hour) and for SV at any cadence — the consumer reads every
     *  encode iteration, so the ring never accumulates more than a handful. */
    static constexpr size_t   DEFAULT_DEPTH = 256;

    static SpscBridge& instance();

    /*--- Lifecycle ---*/

    /** Create the queue pair for `streamId`. Idempotent: returns true if the
     *  pair is registered (newly or already). Returns false if streamId is
     *  out of range. */
    bool registerStream(uint16_t streamId);

    /** Tear down the queue pair for `streamId`. Safe on unregistered ids.
     *  CALLER must ensure no producer/consumer thread is mid-call. */
    void unregisterStream(uint16_t streamId);

    bool isRegistered(uint16_t streamId) const;

    /*--- INBOUND (teammate -> publisher) ---*/

    /** Teammate side: push a value into stream `msg.streamId`. Non-blocking.
     *  Returns false on out-of-range streamId, unregistered stream, or full
     *  queue (full = consumer is too slow; teammate should treat as drop). */
    bool push(const SpscMessage& msg);

    /** Publisher side: get the value at SV sample time `t_ns` for `streamId`,
     *  given the wire-side output `period_ns` (1e9 / sampleRate).
     *
     *  Algorithm — generalized M-to-N resampling:
     *    1. Drain all pending inbound pushes into a sliding window.
     *    2. SPSC_VALUE_MAGNITUDE:
     *         a) Average every windowed sample whose timestamp falls in
     *            [t_ns - period_ns/2, t_ns + period_ns/2]  (boxcar decimation,
     *            naturally anti-aliasing for any M:N ratio).
     *         b) If that window is empty, linearly interpolate between the
     *            two samples surrounding t_ns.
     *         c) If only one side exists, hold the most recent value.
     *    3. SPSC_VALUE_BOOLEAN: no averaging — return the most recent value.
     *    4. No data at all: fill zero default, return false.
     *
     *  Returns true if a real (averaged / interpolated / latched) value was
     *  produced. Per-call cost is O(window_size) = O(256). */
    bool sampleAt(uint16_t streamId, uint64_t t_ns, uint64_t period_ns, SpscMessage* out);

    /*--- OUTBOUND (publisher -> teammate, for GOOSE RX) ---*/

    /** Publisher's GOOSE receiver pushes a decoded boolean here.
     *  Non-blocking; returns false on full queue. */
    bool pushOutbound(const SpscMessage& msg);

    /** Teammate side: pop one outbound message. Non-blocking; returns false
     *  if queue is empty. */
    bool popOutbound(uint16_t streamId, SpscMessage* out);

    /*--- Stats (for monitoring; cheap atomic loads) ---*/

    uint64_t totalInboundPushes()   const { return in_push_total_.load(std::memory_order_relaxed); }
    uint64_t totalInboundDrops()    const { return in_drop_total_.load(std::memory_order_relaxed); }
    uint64_t totalOutboundPushes()  const { return out_push_total_.load(std::memory_order_relaxed); }
    uint64_t totalOutboundDrops()   const { return out_drop_total_.load(std::memory_order_relaxed); }

private:
    SpscBridge() = default;
    ~SpscBridge() = default;
    SpscBridge(const SpscBridge&)            = delete;
    SpscBridge& operator=(const SpscBridge&) = delete;

    /* Per-stream pair. Constructed lazily on registerStream(). */
    struct StreamPair {
        rigtorp::SPSCQueue<SpscMessage> inbound;
        rigtorp::SPSCQueue<SpscMessage> outbound;

        /* Sliding window of recent inbound samples — sized for the
         * highest reasonable M:N ratio. At 10 MHz input and 288 kHz output
         * that's ~35 samples per window; 256 is comfortable headroom.
         * Only the publisher-side consumer thread touches these fields. */
        static constexpr size_t WIN_SIZE = 256;
        SpscMessage window[WIN_SIZE];
        size_t      head        = 0;     /* next write index */
        size_t      count       = 0;     /* live entries, capped at WIN_SIZE */
        SpscMessage last_value  = {};    /* most recent push, for empty-window fallback */
        bool        has_value   = false;

        explicit StreamPair(size_t depth)
            : inbound(depth), outbound(depth) {}
    };

    std::array<std::unique_ptr<StreamPair>, MAX_STREAMS> streams_{};

    std::atomic<uint64_t> in_push_total_{0};
    std::atomic<uint64_t> in_drop_total_{0};
    std::atomic<uint64_t> out_push_total_{0};
    std::atomic<uint64_t> out_drop_total_{0};
};

/*============================================================================
 * C ABI — what Rust / the teammate's app calls.
 *
 * Style follows the existing sv_mp_* family in sv_native.h: extern "C", small
 * surface, ints for return codes (0 = ok, non-zero = error), plain pointers
 * for output params.
 *============================================================================*/

#ifdef __cplusplus
extern "C" {
#endif

/** Register stream `streamId`. 0 on success. */
int sv_spsc_register(uint16_t streamId);

/** Unregister stream `streamId`. 0 on success. */
int sv_spsc_unregister(uint16_t streamId);

/** Push one inbound message. 0 on success; -1 on bad streamId or full queue. */
int sv_spsc_push(const SpscMessage* msg);

/** Pop one outbound message for streamId. 0 on success; -1 if empty. */
int sv_spsc_pop_outbound(uint16_t streamId, SpscMessage* out);

/** Read stats. Pointers may be NULL to skip a field. */
void sv_spsc_get_stats(uint64_t* in_pushes, uint64_t* in_drops,
                       uint64_t* out_pushes, uint64_t* out_drops);

#ifdef __cplusplus
}
#endif
