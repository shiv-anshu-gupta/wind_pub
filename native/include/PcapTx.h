/**
 * @file PcapTx.h
 * @brief libpcap-based Ethernet frame transmitter (Linux)
 *
 * Despite the historic "npcap_" name (carry-over from an early Windows port),
 * this module wraps **libpcap** on Linux. Every function below maps directly
 * to a libpcap call; there is no Windows / Npcap DLL code path any more.
 *
 * Thread safety:
 *   - The main handle (opened by npcap_open) is NOT safe for concurrent
 *     pcap_sendpacket() across threads.
 *   - For parallel TX, each worker thread should open its OWN handle via
 *     npcap_open_extra_handle() and call npcap_send_with_handle() on it.
 *     The kernel TX queue serialises safely below libpcap.
 */

#ifndef NPCAP_TRANSMITTER_H
#define NPCAP_TRANSMITTER_H

#include "sv_native.h"   /* NpcapInterface struct */

#ifdef __cplusplus
extern "C" {
#endif

/*============================================================================
 * Interface management
 *============================================================================*/

/** List network interfaces. Returns count, or -1 on error. */
int  npcap_list_interfaces(NpcapInterface* interfaces, int max_count);

/** Last error message from any call below. Never NULL. */
const char* npcap_get_last_error(void);

/** Open `device_name` (e.g., "enp1s0") for TX. Returns 0 on success. */
int  npcap_open(const char* device_name);

/** Close the main handle. Safe to call when none is open. */
void npcap_close(void);

/** 1 if the main handle is open, 0 otherwise. */
int  npcap_is_open(void);

/*============================================================================
 * Single-handle send (legacy single-thread path)
 *============================================================================*/

/** Send one Ethernet frame on the main handle. 0 on success, -1 on error. */
int  npcap_send_packet(const uint8_t* data, size_t len);

/**
 * Batch-send up to `count` Ethernet frames in ONE sendmmsg() syscall.
 *
 *   data[i]  →  pointer to the i'th frame
 *   lens[i]  →  length of the i'th frame
 *
 * Returns the number of frames the kernel actually accepted (≤ count). A
 * partial result is possible — the writer loop should re-try the rest in
 * the next cycle. This is the high-throughput path: at 16 frames per call
 * it collapses 16 syscalls into 1, reducing CPU at high pps by ~6×.
 *
 * Safe to call from any thread that opened the main handle. Falls back to
 * per-packet sendto internally if sendmmsg is unavailable.
 */
int  npcap_send_packet_batch(const uint8_t* const* data,
                             const size_t* lens,
                             size_t count);

/*============================================================================
 * Multi-worker support — one handle per writer thread
 *============================================================================*/

/**
 * Open an extra independent handle on the SAME interface that was last
 * passed to npcap_open(). Used so multiple worker threads can call
 * pcap_sendpacket() in parallel (one thread per handle).
 *
 * Returns an opaque handle, or NULL on error. The caller MUST close it
 * with npcap_close_extra_handle().
 */
void* npcap_open_extra_handle(void);

/** Send one frame on a specific worker handle. 0 on success, -1 on error. */
int   npcap_send_with_handle(void* handle, const uint8_t* data, size_t len);

/** Close a worker handle. Safe on NULL. */
void  npcap_close_extra_handle(void* handle);

#ifdef __cplusplus
}

/*============================================================================
 * RAII wrapper for worker handles
 *
 * Workers in the multi-thread writer pool can use this instead of the bare
 * `void*` API — the destructor guarantees the underlying pcap_t is closed
 * even if the worker exits early via an exception or a future `return`
 * path that doesn't reach the explicit close call. Move-only (a pcap_t
 * cannot be duplicated).
 *============================================================================*/

class PcapHandle {
public:
    PcapHandle() = default;
    explicit PcapHandle(void* raw) : m_raw(raw) {}
    ~PcapHandle() { reset(); }

    PcapHandle(const PcapHandle&)            = delete;
    PcapHandle& operator=(const PcapHandle&) = delete;

    PcapHandle(PcapHandle&& other) noexcept
        : m_raw(other.m_raw) { other.m_raw = nullptr; }

    PcapHandle& operator=(PcapHandle&& other) noexcept {
        if (this != &other) {
            reset();
            m_raw = other.m_raw;
            other.m_raw = nullptr;
        }
        return *this;
    }

    /** Open a fresh extra handle on the previously-opened interface. */
    static PcapHandle openExtra() {
        return PcapHandle{ npcap_open_extra_handle() };
    }

    /** True if this object holds a real handle. */
    explicit operator bool() const { return m_raw != nullptr; }

    /** Send one frame; same semantics as npcap_send_with_handle. */
    int send(const uint8_t* data, size_t len) const {
        return npcap_send_with_handle(m_raw, data, len);
    }

    /** Release + close. After this the object holds no handle. */
    void reset() {
        if (m_raw) { npcap_close_extra_handle(m_raw); m_raw = nullptr; }
    }

private:
    void* m_raw = nullptr;
};

#endif /* __cplusplus */

#endif /* NPCAP_TRANSMITTER_H */
