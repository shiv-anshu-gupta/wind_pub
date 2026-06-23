/**
 * @file GooseReceiver.h
 * @brief Receive GOOSE frames, decode boolean payload, push to SpscBridge.
 *
 * Architecture
 * ------------
 * One receiver thread, ONE pcap handle, filtered to ether proto 0x88B8. Each
 * captured frame is matched against a small in-memory table of "what gocbRef
 * belongs to which streamId" — that table is populated by the FFI layer
 * (Phase 4). On match: extract the first BOOLEAN in allData, build an
 * SpscMessage, push to SpscBridge::pushOutbound(streamId, ...).
 *
 * Out of scope (yet): multi-value datasets, struct/array payloads, retransmit
 * suppression, time validation. The breaker use case only needs the first
 * BOOLEAN.
 */
#pragma once

#include <atomic>
#include <cstdint>
#include <mutex>
#include <string>
#include <thread>
#include <unordered_map>

class GooseReceiver {
public:
    GooseReceiver() = default;
    ~GooseReceiver() { stop(); }

    GooseReceiver(const GooseReceiver&)            = delete;
    GooseReceiver& operator=(const GooseReceiver&) = delete;

    /** Open pcap on `iface` and start the capture loop. Returns false if
     *  pcap_create / activate / setfilter fails. */
    bool start(const std::string& iface);

    /** Stop and join the worker. */
    void stop();

    bool running() const { return m_running.load(std::memory_order_acquire); }

    /** Register a (gocbRef -> streamId) mapping. The receiver only pushes to
     *  SpscBridge when an incoming frame's gocbRef matches a registered key.
     *  Empty `gocbRef` registers a CATCH-ALL — every frame is forwarded to
     *  `streamId`. Useful for early bring-up before the UI plumbs the refs. */
    void registerStream(const std::string& gocbRef, uint16_t streamId);

    /** Forget all mappings. */
    void clearStreams();

    /*--- Stats ---*/
    uint64_t framesSeen()        const { return m_framesSeen.load(std::memory_order_relaxed); }
    uint64_t framesDecoded()     const { return m_framesDecoded.load(std::memory_order_relaxed); }
    uint64_t framesPushed()      const { return m_framesPushed.load(std::memory_order_relaxed); }
    uint64_t framesUnmatched()   const { return m_framesUnmatched.load(std::memory_order_relaxed); }

private:
    void loop();

    /* pcap handle stored as void* so this header doesn't drag in pcap.h */
    void*             m_pcap = nullptr;
    std::atomic<bool> m_running{false};
    std::thread       m_thread;

    mutable std::mutex                            m_mapMutex;
    std::unordered_map<std::string, uint16_t>     m_streamMap;
    bool                                          m_haveCatchAll = false;
    uint16_t                                      m_catchAllStream = 0;

    std::atomic<uint64_t> m_framesSeen{0};
    std::atomic<uint64_t> m_framesDecoded{0};
    std::atomic<uint64_t> m_framesPushed{0};
    std::atomic<uint64_t> m_framesUnmatched{0};
};
