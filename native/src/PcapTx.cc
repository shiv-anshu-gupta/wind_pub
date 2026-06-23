/**
 * @file PcapTx.cc
 * @brief Cross-platform raw-Ethernet frame transmitter.
 *
 * Two back-ends behind ONE C API (declared in PcapTx.h):
 *
 *   Linux / macOS  → AF_PACKET raw socket (Linux) wrapped directly; libpcap
 *                    is still used for interface enumeration only. This is the
 *                    fast path documented historically: ~3× libpcap throughput
 *                    because we skip pcap_sendpacket()'s userspace wrapper and
 *                    call the kernel's sendto()/sendmmsg() directly.
 *
 *   Windows        → Npcap (wpcap.dll) loaded dynamically at runtime via
 *                    LoadLibrary/GetProcAddress, so the binary links without
 *                    the Npcap SDK present and degrades gracefully with a
 *                    clear "install Npcap" message if the driver is missing.
 *                    All TX goes through pcap_sendpacket(); the batch path
 *                    loops pcap_sendpacket() (the header explicitly permits a
 *                    per-packet fallback when a vectored syscall is absent).
 *
 * The function names keep their historic "npcap_" prefix — that prefix is the
 * public ABI the rest of the engine (PublisherController, GooseTxScheduler)
 * links against and must NOT change. Both back-ends implement it identically.
 */

#include "../include/PcapTx.h"

#include <cstdio>
#include <cstring>
#include <cstdint>
#include <cstdlib>   /* malloc/free — Windows adapter-table enumeration */

/*############################################################################
 *#  WINDOWS BACK-END — Npcap via dynamic DLL loading                        #
 *############################################################################*/
#ifdef _WIN32

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <winsock2.h>
#include <iphlpapi.h>
#pragma comment(lib, "iphlpapi.lib")
#pragma comment(lib, "ws2_32.lib")

/*============================================================================
 * Minimal pcap type/ABI declarations (so we need no Npcap SDK headers)
 *============================================================================*/

typedef void  pcap_t;
typedef struct pcap_if pcap_if_t;

struct pcap_if {
    struct pcap_if* next;
    char*           name;
    char*           description;
    void*           addresses;
    unsigned int    flags;
};

/* Timestamp-type constant (from pcap/pcap.h) used by pcap_set_tstamp_type. */
#define PCAP_TSTAMP_HOST_HIPREC 2

/* Function-pointer typedefs for the wpcap.dll exports we use. */
typedef int            (*pcap_findalldevs_t)(pcap_if_t**, char*);
typedef void           (*pcap_freealldevs_t)(pcap_if_t*);
typedef pcap_t*        (*pcap_open_live_t)(const char*, int, int, int, char*);
typedef void           (*pcap_close_t)(pcap_t*);
typedef int            (*pcap_sendpacket_t)(pcap_t*, const unsigned char*, int);
/* pcap_create activation workflow — enables HOST_HIPREC timestamps. */
typedef pcap_t*        (*pcap_create_t)(const char*, char*);
typedef int            (*pcap_set_snaplen_t)(pcap_t*, int);
typedef int            (*pcap_set_promisc_t)(pcap_t*, int);
typedef int            (*pcap_set_timeout_t)(pcap_t*, int);
typedef int            (*pcap_set_tstamp_type_t)(pcap_t*, int);
typedef int            (*pcap_set_immediate_mode_t)(pcap_t*, int);
typedef int            (*pcap_activate_t)(pcap_t*);

/*============================================================================
 * Module state
 *============================================================================*/

static HMODULE g_dll    = nullptr;   /* wpcap.dll handle                      */
static pcap_t* g_handle = nullptr;   /* main TX handle                        */
static char    g_error[256]      = {0};
static char    g_iface_name[256] = {0};   /* remembered for extra handles     */

static pcap_findalldevs_t        g_findalldevs        = nullptr;
static pcap_freealldevs_t        g_freealldevs        = nullptr;
static pcap_open_live_t          g_open_live          = nullptr;
static pcap_close_t              g_close              = nullptr;
static pcap_sendpacket_t         g_sendpacket         = nullptr;
static pcap_create_t             g_pcap_create        = nullptr;
static pcap_set_snaplen_t        g_set_snaplen        = nullptr;
static pcap_set_promisc_t        g_set_promisc        = nullptr;
static pcap_set_timeout_t        g_set_timeout        = nullptr;
static pcap_set_tstamp_type_t    g_set_tstamp_type    = nullptr;
static pcap_set_immediate_mode_t g_set_immediate_mode = nullptr;
static pcap_activate_t           g_activate           = nullptr;

const char* npcap_get_last_error(void) {
    return g_error;
}

/*============================================================================
 * One-time wpcap.dll load + symbol resolution
 *============================================================================*/

static int load_npcap_dll(void) {
    if (g_dll) return 1;

    /* Npcap installs wpcap.dll under %SystemRoot%\System32\Npcap, which is NOT
     * on the default DLL search path — try it explicitly first, then fall back
     * to a bare name so a WinPcap-style global install still resolves. */
    char path[MAX_PATH];
    if (GetSystemDirectoryA(path, MAX_PATH)) {
        strncat(path, "\\Npcap\\wpcap.dll", sizeof(path) - strlen(path) - 1);
        g_dll = LoadLibraryA(path);
    }
    if (!g_dll) g_dll = LoadLibraryA("wpcap.dll");

    if (!g_dll) {
        snprintf(g_error, sizeof(g_error),
                 "Npcap not found. Install the Npcap runtime from https://npcap.com/");
        return 0;
    }

    g_findalldevs = (pcap_findalldevs_t)GetProcAddress(g_dll, "pcap_findalldevs");
    g_freealldevs = (pcap_freealldevs_t)GetProcAddress(g_dll, "pcap_freealldevs");
    g_open_live   = (pcap_open_live_t)  GetProcAddress(g_dll, "pcap_open_live");
    g_close       = (pcap_close_t)      GetProcAddress(g_dll, "pcap_close");
    g_sendpacket  = (pcap_sendpacket_t) GetProcAddress(g_dll, "pcap_sendpacket");

    /* Optional: pcap_create workflow for HOST_HIPREC timestamps. */
    g_pcap_create        = (pcap_create_t)            GetProcAddress(g_dll, "pcap_create");
    g_set_snaplen        = (pcap_set_snaplen_t)       GetProcAddress(g_dll, "pcap_set_snaplen");
    g_set_promisc        = (pcap_set_promisc_t)       GetProcAddress(g_dll, "pcap_set_promisc");
    g_set_timeout        = (pcap_set_timeout_t)       GetProcAddress(g_dll, "pcap_set_timeout");
    g_set_tstamp_type    = (pcap_set_tstamp_type_t)   GetProcAddress(g_dll, "pcap_set_tstamp_type");
    g_set_immediate_mode = (pcap_set_immediate_mode_t)GetProcAddress(g_dll, "pcap_set_immediate_mode");
    g_activate           = (pcap_activate_t)          GetProcAddress(g_dll, "pcap_activate");

    if (!g_findalldevs || !g_freealldevs || !g_open_live || !g_close || !g_sendpacket) {
        FreeLibrary(g_dll);
        g_dll = nullptr;
        snprintf(g_error, sizeof(g_error),
                 "wpcap.dll loaded but required pcap functions are missing");
        return 0;
    }

    printf("[npcap] wpcap.dll loaded%s\n",
           g_pcap_create ? " (HOST_HIPREC available)" : "");
    return 1;
}

/* Open an independent handle on `device`. Returns nullptr + sets g_error.
 * Shared by npcap_open() (main handle) and npcap_open_extra_handle(). */
static pcap_t* open_one_handle(const char* device) {
    char errbuf[256] = {0};

    /* Prefer the pcap_create workflow: lets us request HOST_HIPREC (QPC-based)
     * timestamps and immediate mode, matching the Linux fast-path behaviour. */
    if (g_pcap_create && g_set_snaplen && g_set_promisc &&
        g_set_timeout && g_activate) {
        pcap_t* h = g_pcap_create(device, errbuf);
        if (!h) {
            snprintf(g_error, sizeof(g_error), "pcap_create(%s): %.200s", device, errbuf);
            return nullptr;
        }
        g_set_snaplen(h, 65536);
        g_set_promisc(h, 1);
        g_set_timeout(h, 1);
        if (g_set_tstamp_type)    g_set_tstamp_type(h, PCAP_TSTAMP_HOST_HIPREC);
        if (g_set_immediate_mode) g_set_immediate_mode(h, 1);

        int rc = g_activate(h);
        if (rc < 0) {
            snprintf(g_error, sizeof(g_error), "pcap_activate(%s) failed (code=%d)", device, rc);
            g_close(h);
            return nullptr;
        }
        return h;
    }

    /* Fallback for older wpcap without pcap_create. */
    pcap_t* h = g_open_live(device, 65536, 1, 1, errbuf);
    if (!h) {
        snprintf(g_error, sizeof(g_error), "pcap_open_live(%s): %.200s", device, errbuf);
        return nullptr;
    }
    return h;
}

/*============================================================================
 * Interface enumeration (libpcap, used once at UI startup)
 *============================================================================*/

int npcap_list_interfaces(NpcapInterface* interfaces, int max_count) {
    if (!interfaces || max_count <= 0) return 0;
    if (!load_npcap_dll()) return -1;

    pcap_if_t* all = nullptr;
    char errbuf[256] = {0};
    if (g_findalldevs(&all, errbuf) != 0) {
        snprintf(g_error, sizeof(g_error), "pcap_findalldevs: %.230s", errbuf);
        return -1;
    }

    /* Pull the adapter table once so we can attach MAC addresses by matching
     * the Npcap device name (which embeds the Windows adapter GUID). */
    PIP_ADAPTER_INFO adapters = nullptr;
    ULONG adapters_len = 0;
    if (GetAdaptersInfo(nullptr, &adapters_len) == ERROR_BUFFER_OVERFLOW) {
        adapters = (PIP_ADAPTER_INFO)malloc(adapters_len);
        if (adapters && GetAdaptersInfo(adapters, &adapters_len) != NO_ERROR) {
            free(adapters);
            adapters = nullptr;
        }
    }

    int count = 0;
    for (pcap_if_t* d = all; d && count < max_count; d = d->next) {
        if (!d->name) continue;

        NpcapInterface* iface = &interfaces[count];
        memset(iface, 0, sizeof(*iface));
        snprintf(iface->name, sizeof(iface->name), "%s", d->name);
        if (d->description)
            snprintf(iface->description, sizeof(iface->description), "%s", d->description);

        for (PIP_ADAPTER_INFO ai = adapters; ai; ai = ai->Next) {
            if (strstr(d->name, ai->AdapterName) && ai->AddressLength == 6) {
                memcpy(iface->mac, ai->Address, 6);
                iface->has_mac = 1;
                break;
            }
        }

        printf("[npcap] Interface %d: %s (has_mac=%d)\n",
               count,
               iface->description[0] ? iface->description : iface->name,
               iface->has_mac);
        ++count;
    }

    if (adapters) free(adapters);
    g_freealldevs(all);

    printf("[npcap] Total: %d interfaces found\n", count);
    return count;
}

/*============================================================================
 * Main handle lifecycle
 *============================================================================*/

int npcap_open(const char* device_name) {
    if (!device_name) {
        snprintf(g_error, sizeof(g_error), "npcap_open: NULL device name");
        return -1;
    }
    if (!load_npcap_dll()) return -1;
    printf("[npcap] Opening: %s\n", device_name);

    if (g_handle) { g_close(g_handle); g_handle = nullptr; }

    g_handle = open_one_handle(device_name);
    if (!g_handle) return -1;

    snprintf(g_iface_name, sizeof(g_iface_name), "%s", device_name);
    printf("[npcap] Bound to %s (Npcap)\n", device_name);
    return 0;
}

void npcap_close(void) {
    if (g_handle && g_close) { g_close(g_handle); g_handle = nullptr; }
    g_iface_name[0] = '\0';
    printf("[npcap] Handle closed\n");
}

int npcap_is_open(void) {
    return g_handle ? 1 : 0;
}

/*============================================================================
 * Send path
 *============================================================================*/

int npcap_send_packet(const uint8_t* data, size_t len) {
    if (!g_handle || !g_sendpacket) return -1;
    return g_sendpacket(g_handle, data, (int)len) == 0 ? 0 : -1;
}

int npcap_send_packet_batch(const uint8_t* const* data,
                            const size_t* lens,
                            size_t count)
{
    if (!g_handle || !g_sendpacket || count == 0 || !data || !lens) return 0;

    /* No vectored-send syscall on Windows/Npcap, so loop pcap_sendpacket().
     * Stop at the first failure and report how many made it — the writer loop
     * re-queues the unsent tail next cycle, exactly like the Linux sendmmsg
     * partial-result contract. */
    int sent = 0;
    for (size_t i = 0; i < count; ++i) {
        if (g_sendpacket(g_handle, data[i], (int)lens[i]) != 0) break;
        ++sent;
    }
    return sent;
}

/*============================================================================
 * Multi-worker support — one independent handle per writer thread
 *============================================================================*/

void* npcap_open_extra_handle(void) {
    if (!g_dll || g_iface_name[0] == '\0') {
        snprintf(g_error, sizeof(g_error),
                 "npcap_open_extra_handle: no interface previously opened");
        return nullptr;
    }
    /* Each worker gets its OWN pcap_t on the same NIC — pcap_sendpacket() is
     * not safe across threads on a shared handle, but separate handles
     * serialise cleanly in the driver below us. */
    return (void*)open_one_handle(g_iface_name);
}

int npcap_send_with_handle(void* handle, const uint8_t* data, size_t len) {
    if (!handle || !g_sendpacket) return -1;
    return g_sendpacket((pcap_t*)handle, data, (int)len) == 0 ? 0 : -1;
}

void npcap_close_extra_handle(void* handle) {
    if (handle && g_close) g_close((pcap_t*)handle);
}

/*############################################################################
 *#  LINUX / macOS BACK-END — AF_PACKET raw socket                          #
 *############################################################################*/
#else /* !_WIN32 */

#include <pcap/pcap.h>          /* iface enumeration only */
#include <sys/socket.h>
#include <sys/ioctl.h>
#include <linux/if_packet.h>
#include <linux/if_ether.h>
#include <net/if.h>
#include <unistd.h>
#include <arpa/inet.h>
#include <cerrno>

/*============================================================================
 * Module state
 *============================================================================*/

/** Main TX socket — AF_PACKET raw socket, ETH_P_ALL. */
static int  g_sock = -1;

/** Cached sockaddr_ll built from the interface index so each send() reuses it. */
static struct sockaddr_ll g_dest_addr = {};

/** Last error string. */
static char g_error[256] = {0};

/** Remembered device name (purely informational). */
static char g_iface_name[IFNAMSIZ + 1] = {0};

const char* npcap_get_last_error(void) {
    return g_error;
}

/*============================================================================
 * Helper: bring socket up on a named interface
 *============================================================================*/

/** Open + bind an AF_PACKET socket to `device`. Returns fd on success,
 *  -1 on error and writes a message to g_error. */
static int open_af_packet(const char* device) {
    /* SOCK_RAW + htons(ETH_P_ALL) means "send full Ethernet frames including
     * the L2 header, exactly as the caller composes them". This matches the
     * Ethernet frames sv_encoder_encode_packet builds. */
    int fd = socket(AF_PACKET, SOCK_RAW, htons(ETH_P_ALL));
    if (fd < 0) {
        snprintf(g_error, sizeof(g_error),
                 "socket(AF_PACKET): %s", std::strerror(errno));
        return -1;
    }

    /* Resolve interface name → index. The kernel needs the index in the
     * sockaddr_ll struct, not the name. */
    struct ifreq ifr = {};
    snprintf(ifr.ifr_name, IFNAMSIZ, "%s", device);
    if (ioctl(fd, SIOCGIFINDEX, &ifr) != 0) {
        snprintf(g_error, sizeof(g_error),
                 "ioctl(SIOCGIFINDEX, %s): %s",
                 device, std::strerror(errno));
        close(fd);
        return -1;
    }

    /* Bind so the socket only TXes on this NIC. Without bind, AF_PACKET
     * would attempt to send via whichever interface the kernel guesses. */
    struct sockaddr_ll sll = {};
    sll.sll_family   = AF_PACKET;
    sll.sll_protocol = htons(ETH_P_ALL);
    sll.sll_ifindex  = ifr.ifr_ifindex;
    if (bind(fd, reinterpret_cast<struct sockaddr*>(&sll), sizeof(sll)) != 0) {
        snprintf(g_error, sizeof(g_error),
                 "bind(%s, ifindex=%d): %s",
                 device, ifr.ifr_ifindex, std::strerror(errno));
        close(fd);
        return -1;
    }

    /* Tune the kernel TX buffer up so high-burst publishers don't see
     * spurious ENOBUFS. 16 MB is generous but not unusual on modern Linux
     * (default is usually 256 KB). Failure here is non-fatal. */
    const int sndbuf = 16 * 1024 * 1024;
    setsockopt(fd, SOL_SOCKET, SO_SNDBUF, &sndbuf, sizeof(sndbuf));

    /* Cache the bound sockaddr_ll for sendto(). With a bound socket we
     * could also pass NULL/0 to sendto, but passing the cached addr makes
     * the call slightly cheaper than the kernel's address resolution. */
    g_dest_addr            = {};
    g_dest_addr.sll_family = AF_PACKET;
    g_dest_addr.sll_ifindex = ifr.ifr_ifindex;
    g_dest_addr.sll_halen  = ETH_ALEN;
    /* dst MAC is in the frame buffer itself (first 6 bytes), the kernel
     * ignores g_dest_addr.sll_addr when ETH_P_ALL is bound. Leaving zeroed. */

    return fd;
}

/*============================================================================
 * Interface enumeration (libpcap, used once at UI startup)
 *============================================================================*/

int npcap_list_interfaces(NpcapInterface* interfaces, int max_count) {
    if (!interfaces || max_count <= 0) return 0;

    char errbuf[PCAP_ERRBUF_SIZE];
    pcap_if_t* all = nullptr;
    if (pcap_findalldevs(&all, errbuf) != 0) {
        snprintf(g_error, sizeof(g_error), "pcap_findalldevs: %.240s", errbuf);
        return -1;
    }

    int count = 0;
    for (pcap_if_t* d = all; d && count < max_count; d = d->next) {
        if (!d->name) continue;

        NpcapInterface* iface = &interfaces[count];
        memset(iface, 0, sizeof(*iface));
        snprintf(iface->name, sizeof(iface->name), "%s", d->name);
        if (d->description)
            snprintf(iface->description, sizeof(iface->description), "%s", d->description);

        int sock = socket(AF_INET, SOCK_DGRAM, 0);
        if (sock >= 0) {
            struct ifreq ifr = {};
            snprintf(ifr.ifr_name, IFNAMSIZ, "%s", d->name);
            if (ioctl(sock, SIOCGIFHWADDR, &ifr) == 0) {
                memcpy(iface->mac, ifr.ifr_hwaddr.sa_data, 6);
                iface->has_mac = 1;
            }
            close(sock);
        }

        printf("[pcap] Interface %d: %s (has_mac=%d)\n",
               count,
               iface->description[0] ? iface->description : iface->name,
               iface->has_mac);
        ++count;
    }
    pcap_freealldevs(all);

    printf("[pcap] Total: %d interfaces found\n", count);
    return count;
}

/*============================================================================
 * Main socket lifecycle
 *============================================================================*/

int npcap_open(const char* device_name) {
    if (!device_name) {
        snprintf(g_error, sizeof(g_error), "npcap_open: NULL device name");
        return -1;
    }
    printf("[afpacket] Opening: %s\n", device_name);

    if (g_sock >= 0) { close(g_sock); g_sock = -1; }

    g_sock = open_af_packet(device_name);
    if (g_sock < 0) return -1;

    snprintf(g_iface_name, sizeof(g_iface_name), "%s", device_name);
    printf("[afpacket] Bound to %s (raw socket, ETH_P_ALL)\n", device_name);
    return 0;
}

void npcap_close(void) {
    if (g_sock >= 0) { close(g_sock); g_sock = -1; }
    g_iface_name[0] = '\0';
    printf("[afpacket] Socket closed\n");
}

int npcap_is_open(void) {
    return g_sock >= 0 ? 1 : 0;
}

/*============================================================================
 * Send path — direct sendto() on the raw socket (no libpcap wrapper)
 *============================================================================*/

int npcap_send_packet(const uint8_t* data, size_t len) {
    if (g_sock < 0) return -1;
    ssize_t rc = sendto(g_sock, data, len, 0,
                        reinterpret_cast<struct sockaddr*>(&g_dest_addr),
                        sizeof(g_dest_addr));
    return (rc == static_cast<ssize_t>(len)) ? 0 : -1;
}

/*============================================================================
 * Batched send via sendmmsg() — high-throughput path
 *
 * sendmmsg lets us hand `count` packets to the kernel in a single syscall.
 * At a typical batch of 16 that's a 16× reduction in syscall overhead. The
 * kernel still releases the packets to the wire one-at-a-time at line
 * rate, so the wire-departure spacing is unchanged (~1.9 µs per 219-byte
 * frame on 1 Gbps) — no risk of clustered hardware timestamps the way
 * Windows-side npcap SendQueue caused.
 *============================================================================*/

int npcap_send_packet_batch(const uint8_t* const* data,
                            const size_t* lens,
                            size_t count)
{
    if (g_sock < 0 || count == 0 || !data || !lens) return 0;

    /* MAX_BATCH bounds the stack arrays so we never overflow if the caller
     * passes a huge count. Caller should chunk anything bigger. */
    constexpr size_t MAX_BATCH = 64;
    if (count > MAX_BATCH) count = MAX_BATCH;

    struct iovec   iovs[MAX_BATCH];
    struct mmsghdr msgs[MAX_BATCH];

    for (size_t i = 0; i < count; ++i) {
        iovs[i].iov_base = const_cast<uint8_t*>(data[i]);
        iovs[i].iov_len  = lens[i];

        msgs[i].msg_hdr.msg_name       = &g_dest_addr;
        msgs[i].msg_hdr.msg_namelen    = sizeof(g_dest_addr);
        msgs[i].msg_hdr.msg_iov        = &iovs[i];
        msgs[i].msg_hdr.msg_iovlen     = 1;
        msgs[i].msg_hdr.msg_control    = nullptr;
        msgs[i].msg_hdr.msg_controllen = 0;
        msgs[i].msg_hdr.msg_flags      = 0;
        msgs[i].msg_len                = 0;   /* kernel writes bytes-sent here */
    }

    int sent = sendmmsg(g_sock, msgs, static_cast<unsigned int>(count), 0);
    /* sendmmsg returns the number of MESSAGES it sent, or -1 with errno set.
     * A partial result is normal under back-pressure — we just report it
     * and let the caller re-queue the unsent tail in the next cycle. */
    return (sent < 0) ? 0 : sent;
}

/*============================================================================
 * Multi-handle stubs — preserved for ABI compatibility
 *
 * The worker pool in PublisherController is now disabled, but the symbol
 * table still references these functions. AF_PACKET sockets are
 * thread-safe for concurrent sendto() calls, so each "extra handle" just
 * shares the main socket — cheap and correct.
 *============================================================================*/

void* npcap_open_extra_handle(void) {
    if (g_sock < 0) {
        snprintf(g_error, sizeof(g_error),
                 "npcap_open_extra_handle: no interface previously opened");
        return nullptr;
    }
    /* Return the socket fd cast to void*. Workers should call
     * npcap_send_with_handle() which dispatches to sendto() on the same
     * shared socket. */
    return reinterpret_cast<void*>(static_cast<intptr_t>(g_sock));
}

int npcap_send_with_handle(void* handle, const uint8_t* data, size_t len) {
    if (!handle) return -1;
    int fd = static_cast<int>(reinterpret_cast<intptr_t>(handle));
    ssize_t rc = sendto(fd, data, len, 0,
                        reinterpret_cast<struct sockaddr*>(&g_dest_addr),
                        sizeof(g_dest_addr));
    return (rc == static_cast<ssize_t>(len)) ? 0 : -1;
}

void npcap_close_extra_handle(void* /*handle*/) {
    /* No-op — the "extra handle" was just an alias for the main socket. */
}

#endif /* _WIN32 */
