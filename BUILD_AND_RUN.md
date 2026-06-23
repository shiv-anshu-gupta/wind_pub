# Build & Run on Windows — Quickstart

Copy-paste, top to bottom. Run everything in **PowerShell**. For deeper detail
and troubleshooting see [WINDOWS_BUILD.md](WINDOWS_BUILD.md).

> Build **on a Windows machine** (native MSVC build). Do not cross-compile from
> Linux/WSL — the binary must be a real Windows build to use Npcap.

---

## 1. Install the prerequisites (one time)

### 1a. Visual Studio 2022 Build Tools (C++ compiler)
Download "Build Tools for Visual Studio 2022" from
<https://visualstudio.microsoft.com/downloads/> → install the
**"Desktop development with C++"** workload (includes MSVC v143 + Windows SDK).

### 1b. Rust (MSVC toolchain)
Install from <https://rustup.rs/>, then in a **new** terminal:
```powershell
rustup default stable-x86_64-pc-windows-msvc
rustc --version          # should print a version
```

### 1c. Node.js 18+
Install the LTS from <https://nodejs.org/>, then:
```powershell
node --version
```

### 1d. libuv (via vcpkg) — needed by the WebSocket layer
```powershell
git clone https://github.com/microsoft/vcpkg C:\vcpkg
C:\vcpkg\bootstrap-vcpkg.bat
C:\vcpkg\vcpkg install libuv:x64-windows-static-md
setx VCPKG_ROOT C:\vcpkg
```
Close and reopen PowerShell after `setx` so `VCPKG_ROOT` is picked up.

### 1e. Npcap (runtime — needed to send packets)
Install from <https://npcap.com/#download>. **During install, tick
"Install Npcap in WinPcap API-compatible Mode."** (Reboot if it asks.)

### 1f. Npcap SDK (build — needed to compile the GOOSE receiver)
From the same page, download the **Npcap SDK** zip and extract it to
**`C:\npcap-sdk`** (so `C:\npcap-sdk\Include\pcap\pcap.h` exists). `build.rs`
finds it there automatically (or set `NPCAP_SDK_DIR` to a custom location).

---

## 2. Build

```powershell
cd <path-to>\windows_pub

npm install              # one time — installs the Tauri CLI

# Debug build (fast, for testing):
npm run tauri build -- --debug

# OR Release build (optimized + NSIS installer):
npm run build:win
```

Output locations:
- Debug exe:    `src-tauri\target\debug\SV Publisher.exe`
- Release exe:  `src-tauri\target\release\SV Publisher.exe`
- Installer:    `src-tauri\target\release\bundle\nsis\*-setup.exe`

---

## 3. Run

Sending raw Ethernet frames needs Administrator rights (Npcap enforces this).

**Option A — run the built exe as Administrator:**
Right-click `SV Publisher.exe` → **Run as administrator**.

**Option B — from an elevated terminal** (right-click PowerShell → *Run as
administrator*):
```powershell
cd <path-to>\windows_pub
& ".\src-tauri\target\release\SV Publisher.exe"
```

**Live dev window** (rebuilds on change; also run the terminal as Administrator):
```powershell
npm run dev:win
```

When the window opens, pick your network adapter from the dropdown and start
publishing.

---

## 4. Quick sanity checks

| Check | Expected |
|-------|----------|
| App launches, shows the UI | Webview window opens (1400×900) |
| Network adapter dropdown is populated | Your NICs are listed (needs Npcap) |
| Console shows `[npcap] wpcap.dll loaded` | Npcap found and loaded |
| Console shows `[pub-ws] listening on ws://…` | C++ WebSocket backend started |
| Start a stream → frames appear in Wireshark | Packets are on the wire |

---

## 5. If something fails

| Problem | Fix |
|---------|-----|
| `cannot open input file 'uv.lib'` | libuv not installed/found → redo step 1d; make sure `VCPKG_ROOT` is set (reopen terminal). |
| `Cannot open include file: 'pcap/pcap.h'` | Npcap SDK missing → do step 1f (extract the SDK to `C:\npcap-sdk`) or set `NPCAP_SDK_DIR`. |
| `cannot open input file 'wpcap.lib'` | Npcap SDK present but no `Lib\x64` → re-extract the full SDK zip to `C:\npcap-sdk`. |
| `LNK4098 … LIBCMT conflicts` | Wrong libuv triplet → use `x64-windows-static-md` (not `x64-windows-static`). |
| `Npcap not found` at runtime | Install Npcap (step 1e) with WinPcap-compatible mode; reboot. |
| Adapter dropdown empty | Re-run the Npcap installer with "WinPcap API-compatible Mode" ticked. |
| App runs but no packets on the wire | You didn't launch as Administrator, or wrong adapter selected. |
| `link.exe not found` / no C++ compiler | Install the VS 2022 "Desktop development with C++" workload (step 1a). |

Full reference and explanations: **[WINDOWS_BUILD.md](WINDOWS_BUILD.md)**.
