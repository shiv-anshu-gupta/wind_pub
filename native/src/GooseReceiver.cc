/**
 * @file GooseReceiver.cc
 * @brief pcap capture + minimal GOOSE BER decoder for boolean payloads.
 *
 * The decoder is deliberately permissive: any required field can fail to
 * parse and we still try to extract the boolean from allData. This keeps
 * interop friendly with simulators that emit slightly non-conformant frames.
 */
#include "../include/GooseReceiver.h"
#include "../include/SpscBridge.h"

#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <windows.h>
#endif

#include <pcap/pcap.h>

#include <cstdio>
#include <cstring>

/*============================================================================
 * Dynamic wpcap.dll loading (Windows)
 *
 * Npcap installs wpcap.dll under %SystemRoot%\System32\Npcap, which is NOT on
 * the default DLL search path. To keep the binary launchable when Npcap is
 * absent — and, crucially, to need NO wpcap import library at link time (so the
 * build is identical under MSVC and MinGW/g++) — we resolve the pcap entry
 * points we use at runtime via LoadLibrary/GetProcAddress, then #define the
 * pcap_* names onto the resolved pointers so the capture code below is
 * unchanged. PcapTx.cc loads wpcap the same way for TX. On Linux/macOS the pcap
 * functions are linked normally (-lpcap) and none of this applies.
 *============================================================================*/
#ifdef _WIN32
namespace {

typedef pcap_t* (*pcap_create_t)(const char*, char*);
typedef int     (*pcap_set_snaplen_t)(pcap_t*, int);
typedef int     (*pcap_set_promisc_t)(pcap_t*, int);
typedef int     (*pcap_set_timeout_t)(pcap_t*, int);
typedef int     (*pcap_set_buffer_size_t)(pcap_t*, int);
typedef int     (*pcap_activate_t)(pcap_t*);
typedef int     (*pcap_compile_t)(pcap_t*, struct bpf_program*, const char*, int, bpf_u_int32);
typedef int     (*pcap_setfilter_t)(pcap_t*, struct bpf_program*);
typedef void    (*pcap_freecode_t)(struct bpf_program*);
typedef void    (*pcap_close_t)(pcap_t*);
typedef char*   (*pcap_geterr_t)(pcap_t*);
typedef void    (*pcap_breakloop_t)(pcap_t*);
typedef int     (*pcap_next_ex_t)(pcap_t*, struct pcap_pkthdr**, const u_char**);

pcap_create_t        g_pcap_create        = nullptr;
pcap_set_snaplen_t   g_pcap_set_snaplen   = nullptr;
pcap_set_promisc_t   g_pcap_set_promisc   = nullptr;
pcap_set_timeout_t   g_pcap_set_timeout   = nullptr;
pcap_set_buffer_size_t g_pcap_set_buffer_size = nullptr;
pcap_activate_t      g_pcap_activate      = nullptr;
pcap_compile_t       g_pcap_compile       = nullptr;
pcap_setfilter_t     g_pcap_setfilter     = nullptr;
pcap_freecode_t      g_pcap_freecode      = nullptr;
pcap_close_t         g_pcap_close         = nullptr;
pcap_geterr_t        g_pcap_geterr        = nullptr;
pcap_breakloop_t     g_pcap_breakloop     = nullptr;
pcap_next_ex_t       g_pcap_next_ex       = nullptr;

bool load_wpcap()
{
    if (g_pcap_create) return true;   /* already resolved */

    HMODULE dll = nullptr;
    char path[MAX_PATH];
    /* Prefer the real Npcap location; ALTERED_SEARCH_PATH lets wpcap.dll's own
     * Packet.dll dependency resolve from System32\Npcap too. */
    if (GetSystemDirectoryA(path, MAX_PATH)) {
        strncat(path, "\\Npcap\\wpcap.dll", sizeof(path) - strlen(path) - 1);
        dll = LoadLibraryExA(path, nullptr, LOAD_WITH_ALTERED_SEARCH_PATH);
    }
    if (!dll) dll = LoadLibraryA("wpcap.dll");   /* WinPcap-style global install */
    if (!dll) {
        std::fprintf(stderr, "[goose-rx] Npcap not found. Install the Npcap "
                             "runtime from https://npcap.com/#download\n");
        return false;
    }

    #define RESOLVE(sym) g_##sym = reinterpret_cast<sym##_t>(GetProcAddress(dll, #sym))
    RESOLVE(pcap_create);
    RESOLVE(pcap_set_snaplen);
    RESOLVE(pcap_set_promisc);
    RESOLVE(pcap_set_timeout);
    RESOLVE(pcap_set_buffer_size);
    RESOLVE(pcap_activate);
    RESOLVE(pcap_compile);
    RESOLVE(pcap_setfilter);
    RESOLVE(pcap_freecode);
    RESOLVE(pcap_close);
    RESOLVE(pcap_geterr);
    RESOLVE(pcap_breakloop);
    RESOLVE(pcap_next_ex);
    #undef RESOLVE

    if (!g_pcap_create || !g_pcap_set_snaplen || !g_pcap_set_promisc ||
        !g_pcap_set_timeout || !g_pcap_set_buffer_size || !g_pcap_activate ||
        !g_pcap_compile || !g_pcap_setfilter || !g_pcap_freecode ||
        !g_pcap_close || !g_pcap_geterr || !g_pcap_breakloop || !g_pcap_next_ex) {
        std::fprintf(stderr, "[goose-rx] wpcap.dll is missing expected exports\n");
        return false;
    }
    return true;
}

}  // namespace

/* Route the capture code's pcap_* calls through the dynamically-loaded
 * pointers. These macros must follow <pcap/pcap.h> (which declares the real
 * prototypes) and the loader above (which stringizes the names). */
#define pcap_create          g_pcap_create
#define pcap_set_snaplen     g_pcap_set_snaplen
#define pcap_set_promisc     g_pcap_set_promisc
#define pcap_set_timeout     g_pcap_set_timeout
#define pcap_set_buffer_size g_pcap_set_buffer_size
#define pcap_activate        g_pcap_activate
#define pcap_compile         g_pcap_compile
#define pcap_setfilter       g_pcap_setfilter
#define pcap_freecode        g_pcap_freecode
#define pcap_close           g_pcap_close
#define pcap_geterr          g_pcap_geterr
#define pcap_breakloop       g_pcap_breakloop
#define pcap_next_ex         g_pcap_next_ex
#endif  // _WIN32

namespace {

/* Decode a BER length starting at `p`, return length and advance `p`.
 * Returns SIZE_MAX on malformed input. */
size_t ber_read_len(const uint8_t** p, const uint8_t* end)
{
    if (*p >= end) return SIZE_MAX;
    uint8_t b = **p; (*p)++;
    if ((b & 0x80) == 0) return b;
    uint8_t nb = b & 0x7F;
    if (nb == 0 || nb > 4 || (*p + nb) > end) return SIZE_MAX;
    size_t v = 0;
    for (uint8_t i = 0; i < nb; ++i) v = (v << 8) | (*(*p)++);
    return v;
}

/* Find the first occurrence of `wantTag` at the top level inside [start,end].
 * Returns pointer to the VALUE bytes and writes length to *outLen. NULL on miss. */
const uint8_t* ber_find(uint8_t wantTag, const uint8_t* start, const uint8_t* end, size_t* outLen)
{
    const uint8_t* p = start;
    while (p < end) {
        if (p + 1 >= end) return nullptr;
        const uint8_t tag = *p++;
        const uint8_t* lenPos = p;
        const size_t len = ber_read_len(&p, end);
        if (len == SIZE_MAX || p + len > end) return nullptr;
        if (tag == wantTag) { *outLen = len; return p; }
        p += len;
        (void)lenPos;
    }
    return nullptr;
}

/* Extract gocbRef (tag 0x80) and boolean payload (first 0x83 inside allData
 * which is tag 0xAB). Returns true on success. */
bool goose_decode(const uint8_t* frame, size_t len,
                  std::string& gocbRef, bool& outBool, uint64_t& outT_ns)
{
    /* Skip Ethernet header. Detect 802.1Q VLAN. */
    if (len < 14) return false;
    size_t pos = 12;
    uint16_t et = ((uint16_t)frame[pos] << 8) | frame[pos+1];
    if (et == 0x8100) {  /* VLAN */
        if (len < 18) return false;
        pos = 16;
        et = ((uint16_t)frame[pos] << 8) | frame[pos+1];
    }
    if (et != 0x88B8) return false;
    pos += 2;

    /* GSE header: APPID (2) + Length (2) + Reserved (2+2) = 8 bytes. */
    if (pos + 8 > len) return false;
    pos += 8;

    /* IECGoosePdu tag 0x61. */
    if (pos >= len || frame[pos] != 0x61) return false;
    pos++;
    const uint8_t* p = frame + pos;
    const uint8_t* end = frame + len;
    size_t pduLen = ber_read_len(&p, end);
    if (pduLen == SIZE_MAX || p + pduLen > end) return false;
    const uint8_t* pduEnd = p + pduLen;

    /* Pull gocbRef [0]. */
    size_t refLen = 0;
    const uint8_t* refPtr = ber_find(0x80, p, pduEnd, &refLen);
    if (!refPtr || refLen > 256) return false;
    gocbRef.assign(reinterpret_cast<const char*>(refPtr), refLen);

    /* Pull t [4] — 8 octets UtcTime. */
    size_t tLen = 0;
    const uint8_t* tPtr = ber_find(0x84, p, pduEnd, &tLen);
    if (tPtr && tLen == 8) {
        const uint32_t secs =
            ((uint32_t)tPtr[0] << 24) | ((uint32_t)tPtr[1] << 16) |
            ((uint32_t)tPtr[2] <<  8) | ((uint32_t)tPtr[3]);
        const uint32_t frac24 =
            ((uint32_t)tPtr[4] << 16) | ((uint32_t)tPtr[5] << 8) | (uint32_t)tPtr[6];
        const uint64_t frac_ns =
            ((uint64_t)frac24 * 1000000000ULL) >> 24;
        outT_ns = (uint64_t)secs * 1000000000ULL + frac_ns;
    } else {
        outT_ns = 0;
    }

    /* Pull allData [11] then find the first BOOLEAN [3] inside it. */
    size_t allLen = 0;
    const uint8_t* allPtr = ber_find(0xAB, p, pduEnd, &allLen);
    if (!allPtr) return false;
    size_t boolLen = 0;
    const uint8_t* boolPtr = ber_find(0x83, allPtr, allPtr + allLen, &boolLen);
    if (!boolPtr || boolLen != 1) return false;
    outBool = (*boolPtr != 0);
    return true;
}

}  // namespace

/*============================================================================
 * Registration
 *============================================================================*/

void GooseReceiver::registerStream(const std::string& gocbRef, uint16_t streamId)
{
    std::lock_guard<std::mutex> lk(m_mapMutex);
    if (gocbRef.empty()) {
        m_haveCatchAll   = true;
        m_catchAllStream = streamId;
    } else {
        m_streamMap[gocbRef] = streamId;
    }
}

void GooseReceiver::clearStreams()
{
    std::lock_guard<std::mutex> lk(m_mapMutex);
    m_streamMap.clear();
    m_haveCatchAll = false;
}

/*============================================================================
 * Lifecycle
 *============================================================================*/

bool GooseReceiver::start(const std::string& iface)
{
    if (m_running.load(std::memory_order_acquire)) return false;

#ifdef _WIN32
    /* Resolve wpcap.dll exports before first use (no link-time pcap dep). */
    if (!load_wpcap()) return false;
#endif

    char errbuf[PCAP_ERRBUF_SIZE];
    pcap_t* handle = pcap_create(iface.c_str(), errbuf);
    if (!handle) {
        std::fprintf(stderr, "[goose-rx] pcap_create(%s) failed: %s\n",
                     iface.c_str(), errbuf);
        return false;
    }
    pcap_set_snaplen(handle, 256);
    pcap_set_promisc(handle, 1);
    pcap_set_timeout(handle, 10);
    pcap_set_buffer_size(handle, 1 * 1024 * 1024);

    if (pcap_activate(handle) < 0) {
        std::fprintf(stderr, "[goose-rx] pcap_activate failed: %s\n",
                     pcap_geterr(handle));
        pcap_close(handle);
        return false;
    }

    struct bpf_program fp;
    if (pcap_compile(handle, &fp, "ether proto 0x88b8", 1,
                     PCAP_NETMASK_UNKNOWN) == -1) {
        std::fprintf(stderr, "[goose-rx] pcap_compile failed: %s\n",
                     pcap_geterr(handle));
        pcap_close(handle);
        return false;
    }
    if (pcap_setfilter(handle, &fp) == -1) {
        std::fprintf(stderr, "[goose-rx] pcap_setfilter failed: %s\n",
                     pcap_geterr(handle));
        pcap_freecode(&fp);
        pcap_close(handle);
        return false;
    }
    pcap_freecode(&fp);

    m_pcap = handle;
    m_running.store(true, std::memory_order_release);
    m_thread = std::thread(&GooseReceiver::loop, this);
    std::fprintf(stdout, "[goose-rx] capture started on '%s'\n", iface.c_str());
    return true;
}

void GooseReceiver::stop()
{
    if (!m_running.load(std::memory_order_acquire)) return;
    m_running.store(false, std::memory_order_release);
    if (m_pcap) pcap_breakloop(static_cast<pcap_t*>(m_pcap));
    if (m_thread.joinable()) m_thread.join();
    if (m_pcap) { pcap_close(static_cast<pcap_t*>(m_pcap)); m_pcap = nullptr; }
}

/*============================================================================
 * Capture loop
 *============================================================================*/

void GooseReceiver::loop()
{
    pcap_t* handle = static_cast<pcap_t*>(m_pcap);
    while (m_running.load(std::memory_order_relaxed)) {
        struct pcap_pkthdr* hdr = nullptr;
        const u_char*       data = nullptr;
        int rc = pcap_next_ex(handle, &hdr, &data);
        if (rc == 1) {
            m_framesSeen.fetch_add(1, std::memory_order_relaxed);

            std::string gocbRef;
            bool        boolVal = false;
            uint64_t    t_ns    = 0;
            if (!goose_decode(data, hdr->caplen, gocbRef, boolVal, t_ns))
                continue;
            m_framesDecoded.fetch_add(1, std::memory_order_relaxed);

            uint16_t streamId = 0;
            bool     matched  = false;
            {
                std::lock_guard<std::mutex> lk(m_mapMutex);
                auto it = m_streamMap.find(gocbRef);
                if (it != m_streamMap.end()) {
                    streamId = it->second;
                    matched  = true;
                } else if (m_haveCatchAll) {
                    streamId = m_catchAllStream;
                    matched  = true;
                }
            }
            if (!matched) {
                m_framesUnmatched.fetch_add(1, std::memory_order_relaxed);
                continue;
            }

            SpscMessage msg{};
            msg.streamId      = streamId;
            msg.type          = SPSC_VALUE_BOOLEAN;
            msg.channelIndex  = 0;
            msg.value.boolean = (uint8_t)(boolVal ? 1 : 0);
            msg.quality       = 0;
            msg.timestamp_ns  = t_ns;

            if (SpscBridge::instance().pushOutbound(msg))
                m_framesPushed.fetch_add(1, std::memory_order_relaxed);
        } else if (rc == -1) {
            std::fprintf(stderr, "[goose-rx] pcap_next_ex error: %s\n",
                         pcap_geterr(handle));
        } else if (rc == -2) {
            break;
        }
    }
}
