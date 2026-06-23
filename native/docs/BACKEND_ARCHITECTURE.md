# SV Publisher - Complete Backend Architecture Documentation

> **Scope**: Every processing step from the moment the **frontend sends configuration/data** to the **backend** until **IEC 61850 Sampled Values packets leave the NIC wire**.
> **Standards**: IEC 61850-9-2LE, IEC 61869-9 (up to 20 channels), IEC 61850-8-1 C.2 (multicast MAC).

---

## Table of Contents

1. [Technology Stack](#1-technology-stack)
2. [File Inventory](#2-file-inventory)
3. [High-Level Architecture](#3-high-level-architecture)
4. [Npcap Integration - Complete Detail](#4-npcap-integration---complete-detail)
5. [Tauri IPC - Rust Layer](#5-tauri-ipc---rust-layer)
6. [Equation Processing and Waveform Generation](#6-equation-processing-and-waveform-generation)
7. [IEC 61850-9-2LE Packet Encoding - Byte-by-Byte](#7-iec-61850-9-2le-packet-encoding---byte-by-byte)
8. [Frame Pre-Building (Cache)](#8-frame-pre-building-cache)
9. [Single-Publisher Transmission](#9-single-publisher-transmission)
10. [Multi-Publisher Architecture](#10-multi-publisher-architecture)
11. [Timing Algorithms](#11-timing-algorithms)
12. [Duration and Repeat Management](#12-duration-and-repeat-management)
13. [Statistics Tracking](#13-statistics-tracking)
14. [Complete Data Flow - Frontend to Wire](#14-complete-data-flow---frontend-to-wire)
15. [Data Structures Reference](#15-data-structures-reference)
16. [FFI Function Reference](#16-ffi-function-reference)
17. [Build System](#17-build-system)

---

## 1. Technology Stack

| Layer | Technology | Role |
|-------|-----------|------|
| Desktop Shell | **Tauri 2.0** | Window management, IPC bridge, command routing |
| Systems Language | **Rust** | Safe FFI wrappers, global state management, JSON serialization |
| Native Engine | **C++17** (MSVC) | Packet encoding, timing, Npcap interaction, waveform math |
| Network I/O | **Npcap** (wpcap.dll) | Raw Ethernet frame injection (both single-packet and batch) |
| Build | `cc` Rust crate | Compiles C++ with `/std:c++17 /EHsc /MD` flags |

---

## 2. File Inventory

### Rust Files (src-tauri/src/)

| File | Lines | Purpose |
|------|-------|---------|
| main.rs | 7 | Binary entry point, calls sv_pub_lib::run() |
| lib.rs | 101 | Tauri app init, Npcap PATH setup, registers 43 commands |
| commands.rs | 713 | All 43 Tauri IPC command handlers, global state, data structures |
| ffi.rs | 680 | extern C declarations + safe Rust wrappers for ~42 C functions |

### C++ Headers (native/include/)

| File | Purpose |
|------|---------|
| sv_native.h | Master header: NpcapInterface, TransmitStats structs, all FFI prototypes |
| sv_encoder.h | SvEncoderConfig struct, encoder API |
| sv_stats.h | Statistics API declarations |
| npcap_transmitter.h | Npcap DLL loading, interface, transmission API |
| sv_controller.h | SvController, SharedBuffer, SvPublisherInstance, PublisherConfig |
| sv_publisher.h | Aggregate include for multi-publisher system |
| sv_publisher_instance.h | SvPublisherInstance class definition |

### C++ Source (native/src/)

| File | Lines | Purpose |
|------|-------|---------|
| sv_native_refactored.cc | 962 | Single-publisher orchestrator, frame pre-building, all publisher loops, FFI exports |
| sv_encoder_impl.cc | 377 | IEC 61850-9-2LE packet encoding (single + multi ASDU) |
| npcap_transmitter_impl.cc | 456 | Npcap DLL loading, interface management, all transmission methods |
| equation_processor.cc | 470 | Equation parsing, waveform generation, C++ class wrapper |
| sv_controller.cc | 1020 | Multi-publisher: SvController singleton, SharedBuffer, writer loops |
| sv_publisher_instance.cc | 290 | Per-MU instance: config, equations, frame cache |
| sv_stats_impl.cc | 130 | Thread-safe statistics with 250ms sliding window |
| equation_processor.h | 150 | Equation processor header with C and C++ APIs |

---

## 3. High-Level Architecture

`
+---------------------------------------------------------------------+
|                        FRONTEND (Web/Tauri)                          |
|  User configures: svID, appID, MACs, sampleRate, channels,          |
|                   equations, sendMode, duration, USB settings        |
+-----+---------------+----------------+------------------+-----------+
      | set_config    | set_channels   | start_publishing | mp_*
      | (JSON IPC)    | (JSON IPC)     | (JSON IPC)       | (JSON IPC)
      v               v                v                  v
+---------------------------------------------------------------------+
|                    RUST LAYER (commands.rs + ffi.rs)                  |
|  - Deserialize JSON to Rust structs (serde)                          |
|  - Store in global state (Mutex<SvConfig>, Mutex<Vec<Channel>>)      |
|  - Convert to C types (CString, raw pointers)                        |
|  - Call extern "C" functions via FFI                                  |
+-----+---------------+----------------+------------------+-----------+
      |               |                |                  |
      v               v                v                  v
+---------------------------------------------------------------------+
|                    C++ NATIVE ENGINE                                  |
|                                                                      |
|  +--------------+  +--------------+  +-------------------------+     |
|  |  Equation    |  |  SV Encoder  |  |  Npcap Transmitter      |     |
|  |  Processor   |  |  (IEC 61850) |  |  (wpcap.dll)            |     |
|  |              |  |              |  |                         |     |
|  | parse eqs    |  | encode frame |  | load DLL                |     |
|  | gen waveform |  | ASN.1 BER    |  | list interfaces         |     |
|  | sin/cos/sq/  |  | single ASDU  |  | open (HOST_HIPREC)      |     |
|  | triangle     |  | multi ASDU   |  | send_packet             |     |
|  +------+-------+  +------+-------+  | sendqueue (batch)       |     |
|         |                 |          | padded send (USB)        |     |
|         v                 v          +----------+--------------+     |
|  +------------------------------------------------------------+      |
|  |       SINGLE-PUBLISHER (sv_native_refactored.cc)           |      |
|  | prebuild_frames -> publisher_loop_batch/immediate/single   |      |
|  +------------------------------------------------------------+      |
|                          OR                                          |
|  +------------------------------------------------------------+      |
|  |       MULTI-PUBLISHER (sv_controller.cc)                   |      |
|  | SvController -> SvPublisherInstance(s) -> SharedBuffer      |      |
|  |             -> writerLoopBatch/Immediate                    |      |
|  +------------------------------------------------------------+      |
|                          |                                           |
|                          v                                           |
|                 +-----------------+                                   |
|                 |  Statistics     |                                   |
|                 |  Tracker        |                                   |
|                 |  (250ms window) |                                   |
|                 +-----------------+                                   |
+---------------------------------------------------------------------+
                          |
                          v
                   +--------------+
                   |  NETWORK     |
                   |  (Ethernet)  |
                   +--------------+
`

---

## 4. Npcap Integration - Complete Detail

The Npcap module (npcap_transmitter_impl.cc, 456 lines) provides the raw Ethernet packet injection layer. It dynamically loads the wpcap.dll library at runtime, enumerates network interfaces with MAC address resolution, opens interfaces with high-precision configuration, and provides three distinct transmission methods.

### 4.1 Dynamic DLL Loading

**Function**: `npcap_load_dll()` - Called lazily on first interface operation.

**Search Order**:
1. `%SystemRoot%\System32\Npcap\wpcap.dll` - Standard Npcap install path
2. `wpcap.dll` - System PATH fallback (covers WinPcap or custom install)

**Implementation detail**: Uses `GetEnvironmentVariableA("SystemRoot", ...)` to build the path, then `LoadLibraryA()` to load the DLL.

**Loaded Function Pointers (15 total via GetProcAddress)**:

| Category | Function Pointer | Npcap Function | Required |
|----------|-----------------|----------------|----------|
| **Discovery** | g_findalldevs | pcap_findalldevs | Yes |
| **Discovery** | g_freealldevs | pcap_freealldevs | Yes |
| **Open** | g_open_live | pcap_open_live | Yes |
| **Close** | g_close | pcap_close | Yes |
| **Send** | g_sendpacket | pcap_sendpacket | Yes |
| **Batch** | g_queue_alloc | pcap_sendqueue_alloc | Optional |
| **Batch** | g_queue_add | pcap_sendqueue_queue | Optional |
| **Batch** | g_queue_transmit | pcap_sendqueue_transmit | Optional |
| **Batch** | g_queue_destroy | pcap_sendqueue_destroy | Optional |
| **Create** | g_pcap_create | pcap_create | Optional |
| **Create** | g_set_snaplen | pcap_set_snaplen | Optional |
| **Create** | g_set_promisc | pcap_set_promisc | Optional |
| **Create** | g_set_timeout | pcap_set_timeout | Optional |
| **Create** | g_set_tstamp_type | pcap_set_tstamp_type | Optional |
| **Create** | g_set_immediate_mode | pcap_set_immediate_mode | Optional |
| **Create** | g_activate | pcap_activate | Optional |

**Critical validation**: The 5 required functions must all resolve. If any is NULL, the DLL is unloaded (FreeLibrary) and load returns failure.

**Module State after successful load**:
`cpp
static HMODULE g_dll;        // DLL handle
static pcap_t* g_handle;     // Active capture handle (one at a time)
static char g_error[256];    // Last error message buffer
// + 15 function pointers listed above
`

### 4.2 Interface Enumeration and MAC Resolution

**Function**: `npcap_list_interfaces(NpcapInterface* interfaces, int max_count)`

**Complete Process**:

1. Calls `pcap_findalldevs()` to get linked list of Npcap devices
2. For **each** device, resolves the MAC address using the Windows `GetAdaptersInfo()` API:
   - First call with bufLen=0 -> gets required buffer size (ERROR_BUFFER_OVERFLOW)
   - Second call with allocated buffer -> gets IP_ADAPTER_INFO linked list
   - **Matching logic**: `strstr(pcap_device->name, adapter->AdapterName)` - the Npcap device name (e.g. `\\Device\\NPF_{GUID}`) contains the Windows adapter GUID
   - When match found: copies 6 MAC bytes from `ai->Address`, sets `has_mac = 1`
3. Populates the NpcapInterface struct:
`c
typedef struct NpcapInterface {
    char name[256];        // Npcap device path (e.g., "\\Device\\NPF_{GUID}")
    char description[256]; // Human-readable name (e.g., "Intel Ethernet")
    uint8_t mac[6];        // MAC address from GetAdaptersInfo
    int has_mac;           // 1 if MAC was successfully resolved
} NpcapInterface;
`
4. Calls `pcap_freealldevs()` to free the device list

**Data flow to Rust**: The FFI boundary uses a pre-allocated array of 32 NpcapInterface structs. Rust reads the #[repr(C)] matching struct, converts mac bytes to "XX:XX:XX:XX:XX:XX" format string, and returns Vec<NetworkInterface>.

### 4.3 Interface Opening (pcap_create vs pcap_open_live)

**Function**: `npcap_open(const char* device_name)`

Two code paths with automatic fallback:

#### Primary Path - pcap_create workflow (preferred)

This path provides **HOST_HIPREC** timestamps and **immediate mode**, both critical for SV publishing.

`
pcap_create(device_name, errbuf)
    |
    +-- pcap_set_snaplen(65536)         // Max capture length
    +-- pcap_set_promisc(1)             // Promiscuous mode ON
    +-- pcap_set_timeout(1)             // 1ms read timeout
    |
    +-- pcap_set_tstamp_type(PCAP_TSTAMP_HOST_HIPREC = 2)
    |     HOST_HIPREC uses QueryPerformanceCounter (QPC) internally
    |     in the Npcap kernel driver for microsecond-precision timestamps.
    |     If unsupported (code != 0), logs warning and continues with default.
    |
    +-- pcap_set_immediate_mode(1)
    |     Disables driver-level send/receive buffering.
    |     CRITICAL for USB Ethernet adapters to reduce packet batching.
    |     Without this, USB host controller batches multiple packets
    |     into a single USB transfer, causing duplicate timestamps.
    |
    +-- pcap_activate()
          Return < 0:  FAILURE -> close handle, return -1
          Return > 0:  WARNING -> log, continue (non-fatal)
          Return = 0:  SUCCESS
`

#### Fallback Path - pcap_open_live

Used only when pcap_create or any of the pcap_set_* functions aren't available in the loaded DLL:

`cpp
g_handle = g_open_live(device_name, 65536, 1, 1, errbuf);
//                      snaplen   promisc timeout
`

This older API doesn't support HOST_HIPREC or immediate mode.

### 4.4 Single-Packet Transmission

**Function**: `npcap_send_packet(const uint8_t* data, size_t len) -> int`

Direct passthrough to pcap_sendpacket(). Returns 0 on success, -1 on failure.

Used by:
- `publisher_loop_immediate()` - per-packet immediate mode
- `publisher_loop_single()` - legacy single-packet mode
- `SvController::writerLoopImmediate()` - multi-publisher immediate mode

### 4.5 SendQueue Batch Transmission

The SendQueue API is Npcap's high-performance batch transmission mechanism. All four functions must be available (checked by `npcap_sendqueue_available()`).

**Complete Lifecycle**:

`
npcap_queue_create(memsize)          ->  pcap_sendqueue_alloc(memsize)
    |                                    Allocates memory for multiple packets
    |
    +-- npcap_queue_add(queue, data, len, timestamp_us)
    |       -> pcap_sendqueue_queue(queue, &hdr, data)
    |       Adds one packet to the queue with timestamp:
    |         hdr.ts.tv_sec  = timestamp_us / 1000000
    |         hdr.ts.tv_usec = timestamp_us % 1000000
    |         hdr.caplen     = len
    |         hdr.len        = len
    |
    +-- npcap_queue_add(...)   // Repeat for each packet in batch
    |
    +-- npcap_queue_transmit(queue, sync)
    |       -> pcap_sendqueue_transmit(handle, queue, sync)
    |
    |       sync=1: Kernel paces packets using NdisMSleep between them
    |               honoring the timestamps. Good for <=4800 pps where
    |               interval (>=208us) exceeds NdisMSleep's ~15us granularity.
    |
    |       sync=0: Blasts all packets at wire speed (no inter-packet delay).
    |               The caller handles pacing externally (QPC spin-wait).
    |               Used for >4800 pps where kernel pacing is too imprecise.
    |
    |       Returns: total bytes sent (0 = failure)
    |
    +-- npcap_queue_destroy(queue)
            -> pcap_sendqueue_destroy(queue)
            Frees the queue memory
`

**Queue memory sizing formula**:
`
queue_size = batch_count * (frame_len + 24) + 4096
`
The +24 accounts for the pcap_pkthdr (16 bytes on Windows) plus alignment. The +4096 is safety padding.

### 4.6 Padded Transmission for USB Adapters

**Function**: `npcap_send_packet_padded(const uint8_t* data, size_t len, size_t pad_to) -> int`

**Purpose**: USB Ethernet adapters use bulk transfers. Multiple small Ethernet frames can be batched into a single USB transfer by the host controller, causing them to arrive simultaneously (identical timestamps in Wireshark). By padding each frame to a larger size (up to 1522 bytes), fewer frames fit per USB bulk transfer, forcing the adapter driver to submit USB Request Blocks (URBs) sooner.

**Implementation**:
`cpp
// If pad_to > len and pad_to <= 1522:
uint8_t padded[1522];
memcpy(padded, data, len);            // Copy original frame
memset(padded + len, 0, pad_to - len); // Zero-pad the rest
pcap_sendpacket(handle, padded, (int)pad_to);

// If pad_to <= len or pad_to > 1522: send unpadded
pcap_sendpacket(handle, data, (int)len);
`

**Safety**: IEC 61850-9-2 subscribers parse by the PDU length fields inside the packet, so trailing zero padding is safely ignored by compliant devices.

**Maximum**: 1522 bytes (1500 MTU + 14 Ethernet header + 4 VLAN tag + 4 FCS).

---

## 5. Tauri IPC - Rust Layer

### 5.1 Application Bootstrap (lib.rs)

`
main.rs -> sv_pub_lib::run()
              |
              +-- init_npcap_path()
              |     Adds "C:\Windows\System32\Npcap" to PATH env var
              |     so wpcap.dll can be found by LoadLibraryA
              |
              +-- tauri::Builder::default()
              |     +-- .plugin(tauri_plugin_shell::init())
              |     +-- .invoke_handler(generate_handler![...43 commands...])
              |     +-- .setup(|_app| { println!("SV PUBLISHER initialized"); })
              |
              +-- .run(tauri::generate_context!())
`

### 5.2 Global State

All global state lives in commands.rs using lazy_static! and atomics:

`ust
// Mutex-protected configuration and channels
lazy_static! {
    static ref CONFIG: Mutex<SvConfig>                   // Publisher configuration
    static ref CHANNELS: Mutex<Vec<Channel>>             // Channel definitions + equations
    static ref CURRENT_INTERFACE: Mutex<Option<String>>  // Selected interface name
}

// Lock-free atomic counters
static IS_PUBLISHING: AtomicBool   // Rust-side publishing flag
static PACKETS_SENT:  AtomicU64    // Rust-side packet counter
static BYTES_SENT:    AtomicU64    // Rust-side byte counter
static ERRORS:        AtomicU64    // Rust-side error counter
`

> **Note**: The authoritative publishing state is always in C++ (g_running atomic). Rust syncs from C++ via ffi::publisher_is_running() and ffi::mp_is_running().

### 5.3 Data Structures

#### SvConfig - Publisher Configuration
`ust
pub struct SvConfig {
    pub sv_id: String,         // Merging Unit ID (e.g., "MU01")
    pub app_id: u16,           // APPID (e.g., 0x4000)
    pub conf_rev: u32,         // Configuration revision
    pub smp_synch: u8,         // Sample synchronization (0=none, 2=GPS)
    pub sample_rate: u64,      // Samples per second (e.g., 4000, 4800, 14400)
    pub frequency: u32,        // Power system frequency (50 or 60 Hz)
    pub src_mac: [u8; 6],      // Source MAC address
    pub dst_mac: [u8; 6],      // Destination multicast MAC
    pub vlan_id: u16,          // IEEE 802.1Q VLAN ID (0 = no VLAN)
    pub vlan_priority: u8,     // VLAN priority (0-7, default 4)
    pub no_asdu: u8,           // ASDUs per packet (1, 4, or 8)
    pub channel_count: u8,     // Number of channels (1-20, default 8)
}
`

#### Channel - Per-Channel Definition
`ust
pub struct Channel {
    pub id: String,            // e.g., "Ia", "Vb", "Ch9"
    pub label: String,         // Display label
    pub channel_type: String,  // "current", "voltage", or "custom"
    pub equation: String,      // e.g., "100*sin(2*PI*50*t)"
    pub is_base: bool,         // Whether this is a base channel
}
`

#### MpPublisherConfig - Multi-Publisher Per-Instance Config
`ust
pub struct MpPublisherConfig {
    // Same fields as SvConfig, plus:
    pub channels: Vec<Channel>,  // Channels specific to this publisher
}
`

### 5.4 Command Catalog (43 Commands)

All commands are #[tauri::command] functions in commands.rs. Each command deserializes JSON from the frontend, performs operations (usually via FFI), and returns JSON results.

| Category | Command | FFI Function Called | Description |
|----------|---------|-------------------|-------------|
| **Interface** | get_interfaces | npcap_list_interfaces | List NICs with MAC addresses |
| | open_interface | npcap_open | Open NIC for packet injection |
| | close_interface | npcap_close | Close current NIC |
| | is_interface_open | npcap_is_open | Check NIC state |
| **Publishing** | start_publishing | npcap_publisher_configure + npcap_publisher_start | Configure + start single-publisher |
| | stop_publishing | npcap_publisher_stop | Stop single-publisher |
| | get_publish_status | npcap_publisher_is_running + sv_mp_is_running | Combined status |
| **SendMode** | set_send_mode | npcap_set_send_mode | 0=auto, 1=batch, 2=immediate, 3=USB |
| | get_send_mode | npcap_get_send_mode | Get current mode |
| **Config** | set_config | (stores in Mutex) | Save config from frontend |
| | get_config | (reads Mutex) | Return current config |
| | get_initial_state | Multiple | Combined bootstrap state |
| | is_native_available | (always true) | Check C++ library loaded |
| **Channels** | get_channels | (reads Mutex) | Return channel list |
| | set_channels | npcap_set_equations | Format as pipe-delimited, pass to C++ |
| **Duration** | set_duration_mode | npcap_set_duration_mode | Set duration/repeat settings |
| | get_remaining_seconds | npcap_get_remaining_seconds | Time left in current run |
| | get_current_repeat_cycle | npcap_get_current_repeat_cycle | Current repeat iteration |
| | is_duration_complete | npcap_is_duration_complete | Has duration elapsed? |
| **Statistics** | get_stats | npcap_stats_update_rates + npcap_stats_get | Full stats snapshot |
| | reset_stats | npcap_stats_reset | Reset all counters |
| **FrameInspect** | get_sample_frame | npcap_get_sample_frame | Get encoded frame bytes for display |
| | get_current_channel_values | npcap_get_current_channel_values | Live channel values (int32[]) |
| | get_current_smp_cnt | npcap_get_current_smp_cnt | Current sample counter |
| **Multi-Pub** | mp_add_publisher | sv_mp_add_publisher | Create new MU instance |
| | mp_remove_publisher | sv_mp_remove_publisher | Remove by ID |
| | mp_remove_all_publishers | sv_mp_remove_all_publishers | Clear all (session reset) |
| | mp_get_publisher_count | sv_mp_get_publisher_count | Count of publishers |
| | mp_configure_publisher | sv_mp_configure_publisher + sv_mp_set_publisher_equations | Configure + set equations |
| | mp_start_all | sv_mp_start_all | Start all (prebuild->merge->transmit) |
| | mp_stop_all | sv_mp_stop_all | Stop all + clear publishers |
| | mp_reset_all | sv_mp_reset_all | Full reset of all state |
| | mp_is_running | sv_mp_is_running | Multi-publisher running state |
| | mp_set_send_mode | sv_mp_set_send_mode | Send mode for multi-publisher |
| | mp_set_duration | sv_mp_set_duration | Duration for multi-publisher |
| | mp_get_stats | (reuses get_stats) | Stats (shared stats module) |
| **USB** | set_usb_pad_size | npcap_set_usb_pad_size | Frame padding (single-pub) |
| | get_usb_pad_size | npcap_get_usb_pad_size | Get padding size |
| | mp_set_usb_pad_size | sv_mp_set_usb_pad_size | Frame padding (multi-pub) |
| | mp_get_usb_pad_size | sv_mp_get_usb_pad_size | Get padding size |
| | set_usb_min_gap_us | npcap_set_usb_min_gap_us | Min gap (single-pub) |
| | get_usb_min_gap_us | npcap_get_usb_min_gap_us | Get gap setting |
| | mp_set_usb_min_gap_us | sv_mp_set_usb_min_gap_us | Min gap (multi-pub) |
| | mp_get_usb_min_gap_us | sv_mp_get_usb_min_gap_us | Get gap setting |

### 5.5 FFI Bindings (ffi.rs)

The FFI layer provides:

1. **C Struct Definitions** - #[repr(C)] Rust structs matching C++ layout exactly:
   - NpcapInterface (name[256], description[256], mac[6], has_mac)
   - TransmitStats (19 fields: counters, rates, timing)

2. **Extern "C" Declarations** - ~42 function signatures linked via #[link(name = "sv_native")]

3. **Safe Rust Wrappers** - Convert between Rust and C types:
   - CString::new(str) for string arguments
   - Array slices (&[u8; 6]) to raw pointers
   - Return values checked: < 0 -> Err(get_npcap_error())
   - Stats: TransmitStats::default() + npcap_stats_get(&mut stats)

---

## 6. Equation Processing Engine

### 6.1 Input Format

Channels are passed from Rust to C++ as a single pipe-delimited string:

```
"100*sin(2*PI*50*t)|200*sin(2*PI*50*t-2.094)|150*cos(2*PI*60*t)|..."
```

- Each segment between `|` is one channel equation
- The C++ EquationProcessor splits this string
- An empty segment or any parse error yields a silent channel (amplitude=0)

### 6.2 Parsing Pipeline (EquationProcessor::parseEquation)

Given equation string like: `325.27*sin(2*PI*50*t+1.5708)`

```
Step 1: Extract Amplitude
  - Regex: ([\d.]+)\s*\*\s*(?:sin|cos)
  - Match group 1 -> amplitude = 325.27
  - Default: 1.0 if no match

Step 2: Extract Frequency
  - Regex: 2\s*\*\s*(?:PI|pi|M_PI)\s*\*\s*([\d.]+)
  - Match group 1 -> frequency = 50.0
  - Default: 50.0 if no match

Step 3: Extract Phase Offset
  - Regex: \*\s*t\s*([+-])\s*([\d.]+)
  - Match sign + value -> phase = +1.5708
  - Default: 0.0 if no match

Step 4: Determine Waveform Type
  - Check if equation contains "cos" -> WaveformType::COS
  - Otherwise -> WaveformType::SIN

Result: ChannelEquation {
    amplitude: 325.27,
    frequency: 50.0,
    phase: 1.5708,
    waveform: SIN
}
```

### 6.3 Sample Value Generation

For each sample index `i` in range [0, sample_rate):

```
t = i / sample_rate    (time in seconds)

For SIN waveform:
  value = amplitude * sin(2 * PI * frequency * t + phase)

For COS waveform:
  value = amplitude * cos(2 * PI * frequency * t + phase)

Final: int32_t sample = static_cast<int32_t>(value)
```

### 6.4 Channel Ordering

Standard IEC 61850-9-2LE ordering for 8-channel mode:

| Index | Label | Description |
|-------|-------|-------------|
| 0 | Ia | Phase A current |
| 1 | Ib | Phase B current |
| 2 | Ic | Phase C current |
| 3 | In | Neutral current |
| 4 | Va | Phase A voltage |
| 5 | Vb | Phase B voltage |
| 6 | Vc | Phase C voltage |
| 7 | Vn | Neutral voltage |

IEC 61869-9 extends to up to 20 channels (numbered 0-19).

---

## 7. IEC 61850-9-2LE Packet Encoding (SvEncoder)

### 7.1 Complete Frame Structure

```
+-----------------------------------+
| Ethernet Header (14 bytes)        |  <- or 18 bytes with VLAN
+-----------------------------------+
| savPDU (TLV encoded)              |
|  +-- noASDU (count)               |
|  +-- seqOfASDU                    |
|      +-- ASDU[0]                  |
|      |  +-- svID (string)         |
|      |  +-- smpCnt (uint16)       |
|      |  +-- confRev (uint32)      |
|      |  +-- smpSynch (uint8)      |
|      |  +-- seqOfData             |
|      |     +-- Ch0 (int32, BE)    |
|      |     +-- Ch1 (int32, BE)    |
|      |     +-- ... ChN            |
|      +-- ASDU[1] (if noASDU>1)    |
|      +-- ...                      |
+-----------------------------------+
```

### 7.2 Ethernet Header

Without VLAN (14 bytes):

| Offset | Size | Field | Value |
|--------|------|-------|-------|
| 0 | 6 | Destination MAC | dst_mac (multicast, e.g., 01:0C:CD:01:00:00) |
| 6 | 6 | Source MAC | src_mac (from NIC) |
| 12 | 2 | EtherType | 0x88BA (IEC 61850 SV) |

With VLAN (18 bytes):

| Offset | Size | Field | Value |
|--------|------|-------|-------|
| 0 | 6 | Destination MAC | dst_mac |
| 6 | 6 | Source MAC | src_mac |
| 12 | 2 | TPID | 0x8100 (VLAN tag) |
| 14 | 2 | TCI | priority(3b) + DEI(1b) + VID(12b) |
| 16 | 2 | EtherType | 0x88BA |

TCI encoding: `TCI = (vlan_priority << 13) | (0 << 12) | (vlan_id & 0x0FFF)`

### 7.3 ASN.1 BER TLV Encoding

All SV PDU fields use ASN.1 BER (Basic Encoding Rules) Tag-Length-Value format.

Tag bytes used:

| Tag | Hex | Meaning |
|-----|-----|---------|
| 0x60 | savPDU | Constructed, application 0 |
| 0x80 | noASDU | Context 0, primitive |
| 0xA2 | seqOfASDU | Context 2, constructed |
| 0x30 | ASDU | Universal SEQUENCE |
| 0x80 | svID | Context 0, primitive (within ASDU) |
| 0x82 | smpCnt | Context 2, primitive |
| 0x83 | confRev | Context 3, primitive |
| 0x85 | smpSynch | Context 5, primitive |
| 0x87 | seqOfData | Context 7, primitive |

Length encoding:
- If length < 128: 1 byte (short form)
- If length < 256: 0x81 + 1 byte
- If length >= 256: 0x82 + 2 bytes (big-endian)

### 7.4 Single-ASDU Packet Layout (noASDU = 1)

For 8 channels with svID "MU01":

```
Byte-by-byte construction:
  [Ethernet header: 14 or 18 bytes]
  [0x60] [len_savPDU]                    // savPDU tag + length
  [0x80] [0x01] [0x01]                   // noASDU = 1
  [0xA2] [len_seqOfASDU]                 // sequence of ASDU
  [0x30] [len_ASDU]                      // ASDU sequence
  [0x80] [0x04] [M] [U] [0] [1]         // svID = "MU01" (4 bytes)
  [0x82] [0x02] [smpCnt_hi] [smpCnt_lo] // smpCnt (2 bytes, big-endian)
  [0x83] [0x04] [confRev 4 bytes BE]     // confRev (4 bytes, big-endian)
  [0x85] [0x01] [smpSynch]              // smpSynch (1 byte)
  [0x87] [0x20] [32 bytes of samples]   // seqOfData (8 ch x 4 bytes = 32)
```

Each channel value in seqOfData is a 32-bit signed integer in big-endian byte order.

### 7.5 Multi-ASDU Packet (noASDU = 4 or 8)

When noASDU > 1, the packet contains multiple ASDUs with incrementing smpCnt:

```
[savPDU]
  [noASDU = N]
  [seqOfASDU]
    [ASDU_0: smpCnt = base_smpCnt + 0]
    [ASDU_1: smpCnt = base_smpCnt + 1]
    ...
    [ASDU_N-1: smpCnt = base_smpCnt + (N-1)]
```

Total packet sizes:
- 1 ASDU, 8 channels: ~80 bytes payload
- 4 ASDUs, 8 channels: ~280 bytes payload
- 8 ASDUs, 8 channels: ~540 bytes payload

### 7.6 Length Calculation Formulas

```
seqOfData_len = channel_count * 4

asdu_content_len = (2 + svID_len)
                 + 4                              // smpCnt TLV
                 + 6                              // confRev TLV
                 + 3                              // smpSynch TLV
                 + 2 + ber_len_size(seqOfData_len) + seqOfData_len

single_asdu_tlv_len = 1 + ber_len_size(asdu_content_len) + asdu_content_len

seqOfASDU_content_len = noASDU * single_asdu_tlv_len

savPDU_content_len = 3
                   + 1 + ber_len_size(seqOfASDU_content_len) + seqOfASDU_content_len
```

---

## 8. Frame Pre-Building and Caching

### 8.1 Pre-Build Strategy

Rather than encoding frames in real time (which would be too slow for 4000-14400 fps), the engine pre-builds an entire second's worth of frames into a contiguous memory buffer.

### 8.2 Pre-Build Algorithm

```
1. Calculate frame_size per frame using length formulas from Section 7.6
2. Allocate buffer:
   frames_per_second = sample_rate / noASDU
   total_size = frame_size * frames_per_second
   Example: 4000 sps, noASDU=1 -> 4000 frames
            4000 sps, noASDU=4 -> 1000 frames
            14400 sps, noASDU=8 -> 1800 frames

3. For each frame index f in [0, frames_per_second):
   a. base_smpCnt = f * noASDU
   b. Write Ethernet header (same for all frames)
   c. Write savPDU tag + length
   d. Write noASDU
   e. For each ASDU a in [0, noASDU):
      - smpCnt = base_smpCnt + a
      - Compute channel values: for ch in [0, channel_count):
          value = eq_processor.evaluate(ch, smpCnt)
      - Encode ASDU with smpCnt and channel values
   f. Store frame at offset: f * frame_size in buffer
4. Record frame_count and frame_size for transmission loop
```

### 8.3 Memory Sizing

| Config | Frames/sec | Frame Size (8ch) | Buffer Size |
|--------|-----------|-------------------|-------------|
| 4000 sps, noASDU=1 | 4000 | ~80 bytes | ~320 KB |
| 4000 sps, noASDU=4 | 1000 | ~280 bytes | ~280 KB |
| 4800 sps, noASDU=8 | 600 | ~540 bytes | ~324 KB |
| 14400 sps, noASDU=8 | 1800 | ~540 bytes | ~972 KB |

The pre-built buffer is always under 1 MB, fitting in L2/L3 cache.

### 8.4 SmpCnt Wrapping

smpCnt is a 16-bit unsigned integer (0-65535). For continuous publishing:
- 4000 sps: wraps every 16.38 seconds
- 4800 sps: wraps every 13.65 seconds
- 14400 sps: wraps every 4.55 seconds

The engine handles wrapping: `smpCnt = (base + offset) % 65536`

---

## 9. Single-Publisher Transmission Engine

### 9.1 Configuration Phase (npcap_publisher_configure)

When the frontend clicks Start Publishing, Rust calls:
1. `npcap_publisher_configure(config_json)` - Parse JSON, set up encoder
2. `npcap_publisher_start()` - Launch transmission thread

npcap_publisher_configure performs:
```
1. Parse JSON -> g_config (SvConfig)
2. Set EquationProcessor channels from pipe-delimited string
3. Create SvEncoder with: svID, appID, confRev, smpSynch, noASDU,
   channelCount, srcMAC, dstMAC, vlanID, vlanPriority
4. Pre-build frames for one second:
   frames_per_second = sample_rate / noASDU
   for i in [0, frames_per_second):
     base_smpCnt = i * noASDU
     for asdu in [0, noASDU):
       compute channel values at sample (base_smpCnt + asdu)
     encode frame with all ASDUs
     store in g_prebuild_buffer at offset i * frame_size
5. Store g_frame_count, g_frame_size, g_frames_per_second
```

### 9.2 Send Mode Selection

```
SendMode::AUTO (0)
  Automatically selects based on noASDU:
    noASDU >= 4 -> BATCH (Tier 1 - pcap_sendqueue)
    noASDU == 1 -> IMMEDIATE with SLEEP pacing

SendMode::BATCH (1)
  Uses pcap_sendqueue_transmit() with sync flag
  Best for high throughput, noASDU >= 4

SendMode::IMMEDIATE (2)
  Sends frames one-by-one with tight timing loops
  Sub-modes: SLEEP / SPIN / NONE

SendMode::USB (3)
  Padded frames with minimum gap enforcement
  For USB-to-Ethernet adapters
```

### 9.3 Batch Transmission (Tier 1 + Tier 2)

Tier 1: pcap_sendqueue (noASDU >= 4):
```
Thread: publisher_thread (above-normal priority)

1. inter_frame_us = 1,000,000 / frames_per_second
2. sendqueue = pcap_sendqueue_alloc(frame_size * frames_per_second * 2)
3. Epoch loop (each iteration = 1 second):
   a. epoch_start = QueryPerformanceCounter()
   b. For f in [0, frames_per_second):
      - frame_ptr = g_prebuild_buffer + (f * frame_size)
      - timestamp.tv_sec = (f * inter_frame_us) / 1,000,000
      - timestamp.tv_usec = (f * inter_frame_us) % 1,000,000
      - pcap_sendqueue_queue(queue, header, frame_ptr)
   c. pcap_sendqueue_transmit(pcap, queue, sync=1)
      sync=1 means Npcap respects inter-packet timestamps
   d. update stats: packets_sent += frames_per_second
   e. calculate elapsed, sleep remainder of second
   f. repeat while g_running == true
```

Tier 2: Direct pcap_sendpacket loop (noASDU == 1, BATCH):
```
1. epoch_start = QPC_now()
2. for f in [0, frames_per_second):
   a. pcap_sendpacket(pcap, frame_ptr, frame_size)
   b. target_time = epoch_start + f * inter_frame_us
   c. spin-wait until QPC reaches target_time
3. next epoch
```

### 9.4 Immediate Transmission

For noASDU=1 with IMMEDIATE mode:

```
SLEEP pacing:
  inter_frame_us = 1,000,000 / sample_rate
  for each frame:
    pcap_sendpacket(pcap, frame, size)
    target_time += inter_frame_us
    if > 500us ahead: Sleep(0)  // yield to OS
    then spin-wait remaining

SPIN pacing:
  Same but NO Sleep calls at all
  Tightest timing, 100% CPU usage

NONE pacing:
  Send as fast as possible
  No timing control between packets
```

### 9.5 USB Padded Transmission

For USB-Ethernet adapters (SendMode::USB):

```
1. Each frame padded to usb_pad_size (default 512 bytes)
   - Append zeros after frame data
   - Prevents USB adapter from batching small packets
2. Enforce minimum gap of usb_min_gap_us (default 100us)
   - Prevents USB buffer overflow
3. Use QPC spin-wait for gap timing
```

---

## 10. Multi-Publisher System (SvController)

### 10.1 Architecture Overview

```
+----------------------------------------------+
|            SvController                       |
|  (Orchestrator)                               |
|                                               |
|  publishers_: vector<unique_ptr<              |
|    SvPublisherInstance>>                      |
|                                               |
|  shared_buffer_: SharedBuffer                 |
|  (merged sorted frame sequence)               |
|                                               |
|  writer_thread_: std::thread                  |
|  (single transmission thread)                 |
+------+----------------------------------------+
       | Pre-build
       v
  +---------+  +---------+  +---------+
  | MU01    |  | MU02    |  | MU03    |
  | 4000fps |  | 4800fps |  | 4000fps |
  | 8ch     |  | 12ch    |  | 4ch     |
  +----+----+  +----+----+  +----+----+
       |            |            |
       +------+-----+------+----+
              | Merge + Sort
              v
  +--------------------------------------------+
  | SharedBuffer (sorted by time)               |
  | [MU01_f0][MU02_f0][MU03_f0]               |
  | [MU01_f1][MU02_f1][MU03_f1]...            |
  +--------------------------------------------+
              |
              v
  +--------------------------------------------+
  | Single Writer Thread                        |
  | pcap_sendqueue_transmit()                   |
  | or frame-by-frame loop                      |
  +--------------------------------------------+
```

### 10.2 SvPublisherInstance

Each publisher instance encapsulates:

```cpp
class SvPublisherInstance {
    std::string id_;                    // Unique instance ID
    SvEncoder encoder_;                 // Independent encoder
    EquationProcessor eq_processor_;    // Independent equation set

    // Pre-built frames for one second
    std::vector<uint8_t> frame_buffer_;
    size_t frame_size_;
    size_t frame_count_;
    size_t sample_rate_;
    uint8_t no_asdu_;

    // Configuration
    SvConfig config_;
};
```

Key methods:
- `configure(json)` - Parse config, init encoder
- `setEquations(pipe_string)` - Parse channel equations
- `prebuildFrames()` - Pre-build one second of frames
- `getFramePtr(index)` - Pointer to frame at index
- `getFrameSize()` - Size of each frame
- `getFrameCount()` - Frames per second
- `getInterFrameUs()` - Microseconds between frames

### 10.3 SharedBuffer Merge and Sort

```
Algorithm: merge_publishers(publishers)

1. total_frames = sum(pub.frame_count for each pub)
2. Allocate entries[total_frames]
   each entry = {frame_ptr, time_us, size}
3. For each publisher p:
     inter_frame_us_p = 1,000,000 / p.frame_count
     For each frame f in [0, p.frame_count):
       entries[idx] = {
         ptr: p.getFramePtr(f),
         time_us: f * inter_frame_us_p,
         size: p.getFrameSize()
       }
       idx++
4. Sort entries by time_us (stable sort preserves order)
5. Build transmission queue from sorted entries
```

### 10.4 SvController Lifecycle

```
mp_add_publisher(config_json)
  -> Creates SvPublisherInstance, stores in publishers_ vector

mp_configure_publisher(id, config_json)
  -> instance.configure(config) + instance.setEquations(equations)

mp_start_all()
  +-- 1. For each publisher: prebuildFrames()
  +-- 2. shared_buffer_.merge(publishers_)
  +-- 3. Launch writer_thread_
  |     If BATCH: pcap_sendqueue with merged schedule
  |     If IMMEDIATE: frame-by-frame with QPC timing
  +-- 4. Set g_mp_running = true

mp_stop_all()
  +-- 1. Set g_mp_running = false
  +-- 2. Join writer_thread_
  +-- 3. Clear publishers_
```

### 10.5 Multi-Publisher Writer Thread

```
writer_loop():
  while g_mp_running:
    epoch_start = QPC_now()

    if BATCH mode:
      sendqueue = pcap_sendqueue_alloc(capacity)
      for entry in shared_buffer_.entries():
        pcap_sendqueue_queue(queue, timestamp=entry.time_us, data=entry.ptr)
      pcap_sendqueue_transmit(pcap, queue, sync=1)
      pcap_sendqueue_destroy(queue)

    elif IMMEDIATE mode:
      for entry in shared_buffer_.entries():
        pcap_sendpacket(pcap, entry.ptr, entry.size)
        spin_wait_until(epoch_start + entry.time_us)

    update_stats(total_frames, total_bytes)
    wait_for_epoch_completion()
```
