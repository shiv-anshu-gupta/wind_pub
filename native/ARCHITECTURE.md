# SV Publisher — Backend Architecture

This document describes the C++ backend layer of the SV publisher. The
top-level Tauri/Rust UI calls into this layer through a stable C FFI
(every `extern "C"` function under `extern "C"` blocks).

The layout mirrors the subscriber's OOP style so a developer fluent in
one side can find their way around the other.

---

## High-Level View

```
┌─────────────────────────────────────────────────────────────────┐
│  Tauri UI (Rust + WebView)                                       │
│  src-tauri/src/commands.rs, ffi.rs                              │
└────────────────────────┬────────────────────────────────────────┘
                         │ C FFI (sv_*, npcap_*)
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│  Native C++ Backend (this folder)                                │
│                                                                  │
│  Two parallel publishing paths:                                  │
│                                                                  │
│  ┌────────────────────────────┐  ┌─────────────────────────────┐│
│  │ Single-stream path          │  │ Multi-stream path           ││
│  │  SvPublisher                │  │  PublisherController        ││
│  │   (one Merging Unit,        │  │   (N publishers, one        ││
│  │    one writer thread)       │  │    schedule, worker pool)   ││
│  └────────────┬───────────────┘  └────────────┬────────────────┘│
│               │                                │                 │
│               ▼                                ▼                 │
│           ┌──────────────────────────────────────┐               │
│           │  SvEncoder  (IEC 61850-9-2 ASN.1)    │               │
│           │  EquationProcessor (sample synth)    │               │
│           │  PcapTx (libpcap wrapper)            │               │
│           │  SvStats (counters)                  │               │
│           └──────────────────────────────────────┘               │
└─────────────────────────────────────────────────────────────────┘
                         │
                         ▼
                    Network NIC
```

---

## File Layout

| File | Class / Module | Role |
|---|---|---|
| **Singletons / entry points** | | |
| `SvPublisher.{h,cc}` | `SvPublisher` | Single-stream publisher (singleton). Wraps configure / start / stop / equations / CID export for ONE Merging Unit. |
| `PublisherController.{h,cc}` | `PublisherController` | Multi-stream coordinator (singleton). Owns N `SvPublisherInstance`s, builds the `SharedBuffer`, runs the writer pool. |
| **Per-stream object** | | |
| `sv_publisher_instance.{h,cc}` | `SvPublisherInstance` | One Merging Unit's config + own frame cache. Many of these live inside `PublisherController`. |
| **Timeline merging** | | |
| `SharedBuffer.{h,cc}` | `SharedBuffer`, `ScheduleEntry` | Merges every publisher's frame cache into one timestamp-sorted schedule. |
| **Encoder + synthesis** | | |
| `SvEncoder.cc`, `sv_encoder.h` | C-style encoder | IEC 61850-9-2 ASN.1 BER frame encoding. |
| `asn1_ber_encoder.cc` | helpers | Primitive ASN.1 BER write functions. |
| `equation_processor.{cc,h}` | `EquationProcessor` | Per-channel waveform generator (sin/cos, custom equations). |
| **I/O** | | |
| `PcapTx.{h,cc}` | C-style libpcap wrapper | Open interface, send packet, multi-handle support for the worker pool. |
| **Support** | | |
| `SvStats.cc`, `sv_stats.h` | C-style stats | Packet/byte counters, time helpers. |
| `fault_injector.{cc,h}` | `FaultInjector` | Drops / corrupts / delays packets for testing. |
| `cid_generator.{cc,h}` | C-style helpers | Writes SCL `.cid` files describing the configured streams. |
| `deadline_pacer.h` (header-only) | `sv::DeadlinePacer` | `clock_nanosleep`-based absolute deadline pacer. |
| `duration_manager.h` (header-only) | helpers | Duration / repeat-cycle utility shared by both paths. |

---

## Threading Model

| Path | Threads | Notes |
|---|---|---|
| `SvPublisher` (single stream) | 1 writer thread | SCHED_RR priority. `DeadlinePacer` parks the thread between packets. |
| `PublisherController` (multi-stream, **default**) | N worker threads | N = `min(cores − 2, schedule_size, 16)`. Each worker holds its own pcap handle and `DeadlinePacer`; strides through the `SharedBuffer` so workers never share a slot. |
| `PublisherController` (fault-injection mode) | 1 writer thread | Per-slot serial path so fault rules apply to one packet at a time. |

The hot path holds NO mutex during sending — the schedule is built once
and immutable while workers are running.

---

## Send Path In Detail (Multi-Stream)

```
[Tauri start_all]
       │
       ▼
PublisherController::startAll()
   1. For each publisher: SvPublisherInstance::prebuildFrames()
      → fills the publisher's own frame cache for one full second
   2. SharedBuffer::buildFromPublishers()
      → merges all caches into one timestamp-ordered schedule
   3. Spawn writer thread → writerLoopImmediate()
       │
       ▼
PublisherController::writerLoopImmediate()
   - tryParallelWriterPool() — multi-worker path (preferred)
       │                        │
       │                        ▼
       │             for each of N workers:
       │                ├─ npcap_open_extra_handle()   ← own pcap_t
       │                ├─ sv::DeadlinePacer(intervalN)
       │                └─ loop:
       │                     wait_due() → for each due slot:
       │                        npcap_send_with_handle(my_handle, e.frame)
       │                        advance my stride by workerCount
       │
       └─ legacy single-thread path (fault injection or N=1)
```

---

## Memory Layout & Lifetimes

- Each `SvPublisherInstance` owns its **own** contiguous frame buffer
  (`m_frameData` of size `count × SV_MAX_FRAME_SIZE`) plus a pointer array
  into it. Frames in the same publisher are cache-line-adjacent.
- `SharedBuffer::ScheduleEntry` holds **borrowed** pointers into those
  buffers. Workers must NOT free these. Publishers must outlive the
  `SharedBuffer` (controlled by `PublisherController` lifecycle).
- The legacy `SvPublisher` (single stream) used scattered heap allocations
  per frame; this was left intact because that path is configuration-only
  and not the throughput target.

---

## What Was Cleaned Up (vs the previous design)

| Before | After |
|---|---|
| `sv_native_refactored.cc` (688 lines of module globals) | `SvPublisher.h/.cc` (singleton class, no globals) |
| `sv_controller.cc/h` mixed `SharedBuffer` + controller | Split: `SharedBuffer.{h,cc}` + `PublisherController.{h,cc}` |
| `npcap_transmitter_impl.cc` (708 lines, Windows DLL loader, dead SendQueue, macOS shims) | `PcapTx.{h,cc}` (~170 lines, Linux-only libpcap, plus per-worker extra-handle API) |
| `sv_native.cc → sv_native_refactored.cc` "_refactored" suffix had no meaning | `SvPublisher.cc` |
| `npcap_loader.h` (Windows DLL loader, unused) | Deleted |
| Single writer thread (`m_writerThread`) — hard cap ~320k pps | Worker pool (auto-sized to cores) — linear scaling |

External C FFI symbol names (`npcap_*`, `sv_mp_*`) are **unchanged** so the
Rust side and any other callers continue to work.

---

## How To Trace A Packet

1. UI clicks **Start** → Rust `commands.rs` → C FFI `sv_mp_start_all()`
2. `PublisherController::startAll()` (`PublisherController.cc`) pre-builds frames
   in each `SvPublisherInstance` (`sv_publisher_instance.cc`) using
   `SvEncoder` + `EquationProcessor`
3. `SharedBuffer::buildFromPublishers()` (`SharedBuffer.cc`) merges them
4. Writer pool starts (`PublisherController::tryParallelWriterPool` in
   `PublisherController.cc`) — N workers, each calling
   `npcap_open_extra_handle()` from `PcapTx.cc`
5. Each worker walks its stride of `SharedBuffer`, calling
   `npcap_send_with_handle()` → `pcap_sendpacket()` → kernel → NIC → wire
