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

5. **Npcap** — required at **runtime** to send raw Ethernet frames.
   - Install the runtime from <https://npcap.com/#download>.
   - During install, tick **"Install Npcap in WinPcap API-compatible Mode"**.
   - You do **not** need the Npcap SDK: `wpcap.dll` is loaded dynamically, so
     the app links without it and shows a clear "install Npcap" message if the
     driver is missing.

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

   It links `uv.lib` by default (override the name with `LIBUV_LINK`). libuv's
   own Windows system dependencies (`psapi`, `userenv`, `ws2_32`, …) are linked
   automatically by `build.rs`.

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
  separate Linux/Yocto target and is **not** part of the Windows Tauri build.
  Its sources are included only for reference.
