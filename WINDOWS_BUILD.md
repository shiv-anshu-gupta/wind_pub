# Building the SV Publisher on Windows

This is the **Windows port** of the IEC 61850 Sampled Values Publisher. It is a
copy of the Linux `custom/` project with the platform-specific native code made
cross-platform. The web frontend, the SV/GOOSE encoders, the publisher engine,
and the WebSocket bridge are all shared; only the OS-touching layers differ.

> The original Linux/Yocto project under `../custom/` is unchanged. Keep this
> tree (`windows_pub/`) for Windows work. The C++ files here are written
> so the **same source compiles on Linux too** (everything is behind
> `#ifdef _WIN32`), so changes can be upstreamed later.

---

## What was changed for Windows

| File | Change |
|------|--------|
| `native/src/PcapTx.cc` | The packet transmitter. Linux AF_PACKET path kept verbatim under `#else`; a Windows path was added that loads **Npcap** (`wpcap.dll`) dynamically (`LoadLibrary`/`GetProcAddress`) and transmits via `pcap_sendpacket`. Same public `npcap_*` API on both platforms. |
| `native/src/GooseTxScheduler.cc` | `clock_gettime(CLOCK_REALTIME)` → portable `std::chrono::system_clock`. |
| `native/src/PublisherController.cc` | Same `clock_gettime` → `std::chrono` change (new `now_ns_realtime()` helper). All `pthread`/`sched`/`mlockall` code was already behind `#ifdef _WIN32`. |
| `native/src/PubWsServer.cc` | The port-availability probe now uses Winsock (`<winsock2.h>`, `closesocket`, `WSAStartup`) on Windows, POSIX sockets on Linux. |
| `src-tauri/build.rs` | uSockets is now compiled on Windows with the **libuv** event backend (`LIBUS_USE_LIBUV`) instead of epoll. Adds libuv discovery, `UWS_NO_ZLIB`, and the Windows system libs. |

No other source files needed changes — the SV/GOOSE encoders, stats, equation
processor, fault injector, SPSC bridge and the JS frontend are already portable.

---

## Prerequisites

1. **Rust (MSVC toolchain)** — install via [rustup](https://rustup.rs/), then:
   ```powershell
   rustup default stable-x86_64-pc-windows-msvc
   ```

2. **Visual Studio 2022 Build Tools** with:
   - *Desktop development with C++*
   - MSVC v143 compiler
   - Windows 10/11 SDK

3. **Node.js 18+** (for the Tauri CLI / frontend build).

4. **Tauri CLI**:
   ```powershell
   npm install
   ```

5. **Npcap** — needed both to **build** and to **run**.
   - **Runtime** (to send/receive raw Ethernet frames): install from
     <https://npcap.com/#download> and tick **"Install Npcap in WinPcap
     API-compatible Mode"**. `PcapTx` loads `wpcap.dll` dynamically and shows a
     clear "install Npcap" message if the driver is missing.
   - **SDK** (to build): download the **Npcap SDK** zip from the same page and
     extract it to **`C:\npcap-sdk`** (so `C:\npcap-sdk\Include\pcap\pcap.h`
     exists). `GooseReceiver.cc` (GOOSE RX) calls the pcap API directly, so it
     needs `<pcap/pcap.h>` at compile time and `wpcap.lib` at link time.
     `build.rs` resolves the SDK from `NPCAP_SDK_DIR` (if set), else
     `C:\npcap-sdk`, and links `wpcap` from its `Lib\x64`.

6. **libuv** — required to build the WebSocket layer (uSockets uses libuv as its
   Windows event loop). Easiest via [vcpkg](https://github.com/microsoft/vcpkg).
   Use the **`x64-windows-static-md`** triplet — it links libuv *statically*
   (nothing extra to ship at runtime) while keeping the dynamic CRT that Rust
   uses, so there is no CRT-mismatch and no `uv.dll` to copy next to the binary:
   ```powershell
   git clone https://github.com/microsoft/vcpkg C:\vcpkg
   C:\vcpkg\bootstrap-vcpkg.bat
   C:\vcpkg\vcpkg install libuv:x64-windows-static-md
   setx VCPKG_ROOT C:\vcpkg
   ```
   `build.rs` resolves libuv in this order:
   - `LIBUV_DIR` (a root containing `include/` and `lib/`), else
   - `VCPKG_ROOT\installed\<LIBUV_TRIPLET>\{include,lib}`
     (`LIBUV_TRIPLET` defaults to `x64-windows-static-md`), else
   - `C:\vcpkg\installed\x64-windows-static-md\...`

   `build.rs` auto-detects the import-lib name from the lib dir — `libuv.lib`
   (recent vcpkg) or `uv.lib` (older/shared builds) — so no manual step is
   needed; override with `LIBUV_LINK` only if your libuv was packaged
   differently. libuv's own Windows system dependencies (`psapi`, `userenv`,
   `ws2_32`, …) are linked automatically by `build.rs`.

   > Prefer the **shared** build instead? Use `libuv:x64-windows`, set
   > `LIBUV_TRIPLET=x64-windows`, and copy `uv.dll` next to the built `.exe`
   > (or keep `…\installed\x64-windows\bin` on `PATH`).

---

## Build

From `windows_pub/`:

```powershell
# Debug build
npm run tauri build -- --debug

# Release build  (produces an NSIS installer under …\release\bundle\nsis\)
npm run build:win        # alias for: tauri build

# Live dev window
npm run dev:win          # alias for: tauri dev
```

The resulting binary is under `src-tauri\target\{debug,release}\`, and the
installer under `…\release\bundle\nsis\`.

> Do **not** use the plain `npm run dev` / `npm run setcap` scripts on Windows —
> they call Linux `setcap` and will fail. Use `dev:win` / `build:win` above.
> The bundle target is set to `nsis` (Windows installer); the Linux `deb`/
> `appimage` targets were removed from this Windows tree.

---

## Running

Sending raw Ethernet frames requires elevated privileges on Windows (the Npcap
driver enforces this). **Run the app as Administrator**, or launch it from an
elevated terminal.

> Linux uses `setcap cap_net_raw` (see the `setcap` npm script) — there is no
> equivalent on Windows, so Administrator is the supported path.

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `Npcap not found. Install the Npcap runtime…` at runtime | Install Npcap (step 5) and reboot if prompted. |
| Linker error `cannot open input file 'uv.lib'` | libuv not found — install it (step 6) and/or set `LIBUV_DIR`/`VCPKG_ROOT`/`LIBUV_TRIPLET`. |
| `LNK4098: defaultlib 'LIBCMT' conflicts` / CRT-mismatch | You installed the plain `x64-windows-static` triplet (static CRT). Use `x64-windows-static-md` instead. |
| Runtime: `uv.dll was not found` | Only happens with the *shared* triplet — copy `uv.dll` beside the `.exe` or switch to `x64-windows-static-md`. |
| Linker errors referencing `uv_*` symbols (psapi/userenv/etc.) | These system libs are linked by `build.rs`; ensure you did not strip the Windows link list. |
| No interfaces in the dropdown | Npcap must be in *WinPcap API-compatible mode*; re-run the Npcap installer with that box ticked. |
| `pcap_sendpacket` succeeds but nothing on the wire | Confirm you launched as Administrator and selected the correct adapter. |

---

## Notes / known differences from Linux

- **Throughput:** the Linux build uses `sendmmsg()` (one syscall per batch) and
  a raw AF_PACKET socket. Windows/Npcap has no vectored send, so the batch path
  loops `pcap_sendpacket()`. Functionally identical; per-packet syscall overhead
  is higher at very high pps.
- **Timestamp precision:** the Windows path requests Npcap's `HOST_HIPREC`
  (QPC-based) timestamps when available.
- **The `service/` directory** (standalone headless WebSocket backend) is a
  *separate* target from the Tauri app — it is not built by `tauri build`. It
  now builds and runs on Windows too; see below.

---

## Standalone headless backend (`service/`)

The same engine the Tauri window embeds, exposed over a WebSocket with **no
GUI** — run it on its own and point a remote frontend at it (the Linux/Yocto
`sv_publisher_service` workflow, now on Windows). It reuses the app's real
WebSocket server (`native/src/PubWsServer.cc`), so it speaks the exact same
JSON protocol as the embedded backend — no second copy to drift out of date.

Prerequisites are the same as the Tauri build (libuv via vcpkg, the Npcap SDK
at `C:\npcap-sdk`, MSVC). Build with CMake from `service/`:

```powershell
cd service
cmake -B build -G "Visual Studio 17 2022" -A x64
cmake --build build --config Release
```

Run it (optionally pass a starting port; default 9001, scans upward for a free
slot just like the app):

```powershell
.\build\Release\sv_publisher_service.exe 9001
# → SV Publisher WebSocket Service v1.0 — ws://0.0.0.0:9001/ws
```

It binds **all interfaces** (`0.0.0.0`), so a frontend on another machine can
connect to `ws://<this-host>:9001/ws`. Sending frames follows the same Npcap
driver-access rules as the app (Administrator only if Npcap was installed with
"Restrict driver access to Administrators only").

> The old hand-written `service/ws_server.cc` targeted the removed
> single-publisher C ABI and is intentionally **not** compiled; `main.cpp` now
> just starts `PubWsServer` and blocks.
