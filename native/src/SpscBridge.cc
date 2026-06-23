/**
 * @file SpscBridge.cc
 * @brief Implementation of the two-way SPSC bridge.
 *
 * Almost everything here is non-blocking ring-buffer juggling. The only
 * "smart" bit is sampleAt() which linearly interpolates between the two
 * most recent inbound pushes to land on the SV sample time exactly.
 *
 * Why we never lock anywhere
 * --------------------------
 * Each (stream, direction) is a single rigtorp::SPSCQueue — wait-free.
 * Per-stream interpolation state (prev/curr) is touched only by the
 * publisher-side consumer thread for that stream. As long as a stream's
 * producer and consumer are each single threads, no mutex is needed.
 */
#include "SpscBridge.h"
#include <cstring>

/*============================================================================
 * Singleton accessor
 *============================================================================*/

SpscBridge& SpscBridge::instance() {
    static SpscBridge inst;
    return inst;
}

/*============================================================================
 * Lifecycle
 *============================================================================*/

bool SpscBridge::registerStream(uint16_t streamId) {
    if (streamId >= MAX_STREAMS) return false;
    if (streams_[streamId]) return true;   /* idempotent — already registered */
    streams_[streamId] = std::make_unique<StreamPair>(DEFAULT_DEPTH);
    return true;
}

void SpscBridge::unregisterStream(uint16_t streamId) {
    if (streamId >= MAX_STREAMS) return;
    streams_[streamId].reset();   /* destroys the queues and the cache state */
}

bool SpscBridge::isRegistered(uint16_t streamId) const {
    if (streamId >= MAX_STREAMS) return false;
    return streams_[streamId] != nullptr;
}

/*============================================================================
 * INBOUND — teammate -> publisher
 *============================================================================*/

bool SpscBridge::push(const SpscMessage& msg) {
    if (msg.streamId >= MAX_STREAMS) return false;
    auto& slot = streams_[msg.streamId];
    if (!slot) return false;

    /* try_push is non-blocking; fails (returns false) only if the ring is
     * full. With DEFAULT_DEPTH=256 and the publisher draining every encode
     * iteration, full means the consumer has stalled — count it as a drop. */
    if (!slot->inbound.try_push(msg)) {
        in_drop_total_.fetch_add(1, std::memory_order_relaxed);
        return false;
    }
    in_push_total_.fetch_add(1, std::memory_order_relaxed);
    return true;
}

bool SpscBridge::sampleAt(uint16_t streamId, uint64_t t_ns,
                          uint64_t period_ns, SpscMessage* out) {
    if (!out) return false;
    if (streamId >= MAX_STREAMS) return false;
    auto& slot = streams_[streamId];
    if (!slot) return false;

    StreamPair& s = *slot;

    /*------------------------------------------------------------------
     * Step 1: drain every pending inbound push into the sliding window.
     * The window is a ring buffer of the most recent WIN_SIZE samples,
     * in insertion order (which equals time order because the producer
     * pushes monotonically).
     *------------------------------------------------------------------*/
    while (SpscMessage* front = s.inbound.front()) {
        s.window[s.head] = *front;
        s.head = (s.head + 1) % StreamPair::WIN_SIZE;
        if (s.count < StreamPair::WIN_SIZE) s.count++;
        s.last_value = *front;
        s.has_value  = true;
        s.inbound.pop();
    }

    /*------------------------------------------------------------------
     * Step 2: no data at all — zero default + return false.
     *------------------------------------------------------------------*/
    if (!s.has_value) {
        std::memset(out, 0, sizeof(*out));
        out->streamId     = streamId;
        out->timestamp_ns = t_ns;
        return false;
    }

    /*------------------------------------------------------------------
     * Step 3: booleans don't average — return the latest value.
     *------------------------------------------------------------------*/
    if (s.last_value.type == SPSC_VALUE_BOOLEAN) {
        *out = s.last_value;
        out->timestamp_ns = t_ns;
        return true;
    }

    /*------------------------------------------------------------------
     * Step 4: magnitude — boxcar decimation.
     *
     * Scan the window once. Track three things in the same pass:
     *   - sum + n_in_window for the boxcar mean
     *   - the newest sample strictly before t_ns (for fallback interp)
     *   - the oldest sample at-or-after  t_ns (for fallback interp)
     *
     * Window for boxcar: [t_lo, t_hi] centred on t_ns with width period_ns.
     *------------------------------------------------------------------*/
    const uint64_t t_lo = (t_ns > period_ns / 2) ? (t_ns - period_ns / 2) : 0;
    const uint64_t t_hi = t_ns + period_ns / 2;

    double sum = 0.0;
    size_t n_in_window = 0;

    SpscMessage older{};   bool has_older = false;   /* newest sample with ts < t_ns */
    SpscMessage newer{};   bool has_newer = false;   /* oldest sample with ts >= t_ns */

    for (size_t i = 0; i < s.count; i++) {
        const SpscMessage& m = s.window[i];
        const uint64_t ts = m.timestamp_ns;

        if (ts >= t_lo && ts <= t_hi) {
            sum += static_cast<double>(m.value.magnitude);
            n_in_window++;
        }

        if (ts < t_ns) {
            if (!has_older || ts > older.timestamp_ns) {
                older = m; has_older = true;
            }
        } else {
            if (!has_newer || ts < newer.timestamp_ns) {
                newer = m; has_newer = true;
            }
        }
    }

    /* Case A — boxcar mean (the M:N downsampling path). */
    if (n_in_window > 0) {
        *out = s.last_value;
        out->value.magnitude = static_cast<float>(sum / n_in_window);
        out->timestamp_ns    = t_ns;
        return true;
    }

    /* Case B — empty window: linear interpolation between the surrounding
     * two samples. This is the rare-event fallback (input briefly slower
     * than output) and matches the comtrade-viewer's existing algorithm. */
    if (has_older && has_newer && newer.timestamp_ns != older.timestamp_ns) {
        const double t0 = static_cast<double>(older.timestamp_ns);
        const double t1 = static_cast<double>(newer.timestamp_ns);
        const double v0 = static_cast<double>(older.value.magnitude);
        const double v1 = static_cast<double>(newer.value.magnitude);
        const double frac = (static_cast<double>(t_ns) - t0) / (t1 - t0);

        *out = s.last_value;
        out->value.magnitude = static_cast<float>(v0 + frac * (v1 - v0));
        out->timestamp_ns    = t_ns;
        return true;
    }

    /* Case C — only one side available, or all samples ARE at t_ns
     * (zero-width interp). Hold the latest known value. */
    *out = s.last_value;
    out->timestamp_ns = t_ns;
    return true;
}

/*============================================================================
 * OUTBOUND — publisher -> teammate (GOOSE RX)
 *============================================================================*/

bool SpscBridge::pushOutbound(const SpscMessage& msg) {
    if (msg.streamId >= MAX_STREAMS) return false;
    auto& slot = streams_[msg.streamId];
    if (!slot) return false;

    if (!slot->outbound.try_push(msg)) {
        out_drop_total_.fetch_add(1, std::memory_order_relaxed);
        return false;
    }
    out_push_total_.fetch_add(1, std::memory_order_relaxed);
    return true;
}

bool SpscBridge::popOutbound(uint16_t streamId, SpscMessage* out) {
    if (!out) return false;
    if (streamId >= MAX_STREAMS) return false;
    auto& slot = streams_[streamId];
    if (!slot) return false;

    if (SpscMessage* head = slot->outbound.front()) {
        *out = *head;
        slot->outbound.pop();
        return true;
    }
    return false;
}

/*============================================================================
 * C ABI
 *============================================================================*/

extern "C" {

int sv_spsc_register(uint16_t streamId) {
    return SpscBridge::instance().registerStream(streamId) ? 0 : -1;
}

int sv_spsc_unregister(uint16_t streamId) {
    SpscBridge::instance().unregisterStream(streamId);
    return 0;
}

int sv_spsc_push(const SpscMessage* msg) {
    if (!msg) return -1;
    return SpscBridge::instance().push(*msg) ? 0 : -1;
}

int sv_spsc_pop_outbound(uint16_t streamId, SpscMessage* out) {
    if (!out) return -1;
    return SpscBridge::instance().popOutbound(streamId, out) ? 0 : -1;
}

void sv_spsc_get_stats(uint64_t* in_pushes, uint64_t* in_drops,
                       uint64_t* out_pushes, uint64_t* out_drops) {
    SpscBridge& b = SpscBridge::instance();
    if (in_pushes)  *in_pushes  = b.totalInboundPushes();
    if (in_drops)   *in_drops   = b.totalInboundDrops();
    if (out_pushes) *out_pushes = b.totalOutboundPushes();
    if (out_drops)  *out_drops  = b.totalOutboundDrops();
}

}  /* extern "C" */
