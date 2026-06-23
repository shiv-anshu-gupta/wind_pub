# System Architecture Diagrams — IEC 61850 SV / GOOSE Publisher

> Generated from [BACKEND_FILE_REFERENCE.md](BACKEND_FILE_REFERENCE.md).
> Diagrams use **real function names** from the current codebase.
> Preview: open in VS Code Markdown preview (or view on GitHub).

This document covers **two related products** built on the same native engine:

* **Part A** — the `sv-publisher` desktop application (Tauri + WebSocket + C++).
  Diagrams D1–D7.
* **Part B** — the `substation_kit` embeddable library that re-uses the
  publisher's native sources as a standalone static library for an external
  C++ app (e.g. the simulator). Diagrams L1–L4.

The two share the IEC 61850 wire-format core (`SvEncoder`,
`GooseEncoder`, `asn1_ber_encoder`, `PcapTx`, `SvStats`) but have
completely separate runtime infrastructure — see L0 for the shared-vs-
distinct map.

| # | Question | Type | Part |
|---|---|---|---|
| D1 | What are the layers in the publisher app and how do they talk? | system overview | A |
| D2 | What happens at process startup? | sequence | A |
| D3 | What does "Add publisher → Start" do end-to-end? | sequence | A |
| D4 | How does the writer loop turn a config into wire bytes? | data flow | A |
| D5 | How does GOOSE TX (with retransmit ramp) work? | data flow | A |
| D6 | How does GOOSE RX decode and surface frames? | data flow | A |
| D7 | What drives the Statistics panel and FrameViewer? | sequence | A |
| L0 | What does the publisher app share with the library? | shared-source map | B |
| L1 | What's inside `libsubstation_kit.a`? | library layout | B |
| L2 | How does a consumer app integrate the library? | integration / build | B |
| L3 | What's the threading model when using `Engine`? | threading | B |
| L4 | What's the typical usage lifecycle? | sequence | B |

The publisher was migrated to a direct **JS ↔ C++ WebSocket** architecture
modeled on the subscriber. There is **no Tauri command layer, no Rust FFI
shim**; the JS side talks to a C++ WebSocket dispatcher (`PubWsServer.cc`)
embedded in the same process, on `ws://localhost:9100/ws`.

---

## D1 — System overview (three layers, single process)

The publisher runs as **one process** (`sv-publisher`) that hosts three
distinct concerns:

```mermaid
flowchart TB
    subgraph PROC["sv-publisher process (one binary)"]
        direction TB

        subgraph FE["① Frontend layer — JavaScript (web/js)"]
            UI["UI components<br/>MultiPublisher.js, Statistics.js,<br/>FrameViewer.js, FaultInjectionPanel.js"]
            TC["utils/tauriClient.js<br/>WebSocket client<br/>250 ms poll loop<br/>event emitter"]
            UI -->|"mpAddPublisher() / mpConfigurePublisher()<br/>mpStartAll() / mpStopAll() / etc."| TC
        end

        subgraph WS["② WebSocket boundary"]
            EP[("ws://localhost:9100/ws<br/>JSON command/reply")]
        end

        subgraph BE["③ C++ engine layer — native/"]
            direction TB
            PWS["PubWsServer.cc<br/>uWS event loop<br/>dispatches on JSON cmd"]
            PC["PublisherController<br/>(singleton)<br/>owns vector&lt;SvPublisherInstance&gt;,<br/>writer thread, FaultInjector"]
            INST["SvPublisherInstance × N<br/>per-MU config, equations,<br/>frame cache, current smpCnt"]
            EQ["EquationProcessor<br/>parses 'id:eq|id:eq|...',<br/>generate9_2LESamples(t)"]
            ENC["SvEncoder<br/>IEC 61850-9-2 LE binary frame<br/>encode_packet / encode_multi_asdu"]
            SB["SharedBuffer<br/>merged sorted schedule<br/>(immutable, zero-copy)"]
            PCAP["PcapTx<br/>npcap_send_packet_batch()<br/>(libpcap / AF_PACKET)"]

            GS["GooseService<br/>sv_goose_* C ABI"]
            GT["GooseTxScheduler<br/>(1 thread per stream)<br/>state change + retransmit ramp"]
            GE["GooseEncoder<br/>IEC 61850-8-1 binary frame"]
            GR["GooseReceiver<br/>libpcap filter 0x88b8<br/>decode + push"]

            SPSC["SpscBridge<br/>(lock-free per-stream rings)"]

            ST["SvStats<br/>(atomic counters)"]
            FI["FaultInjector"]
            CID["cid_generator<br/>sv_cid_export()"]
        end

        TC <-->|"WebSocket frames"| EP
        EP <-->|"in-process"| PWS

        PWS -->|"mp_* commands"| PC
        PWS -->|"goose_* commands"| GS
        PWS -->|"spsc_* commands"| SPSC
        PWS -->|"get_sample_frame / export_cid<br/>get_current_channel_values"| INST
        PWS -->|"fault_inject_* commands"| FI

        PC --> INST
        INST --> EQ
        INST --> ENC
        PC --> SB
        SB --> PC
        PC --> FI
        PC --> ST
        PC -->|"npcap_send_packet_batch()"| PCAP

        GS --> GT
        GS --> GR
        GT --> GE
        GT --> SPSC
        GT --> PCAP
        GR --> SPSC
    end

    NIC(["NIC / Ethernet wire<br/>(subscriber consumes binary SV / GOOSE frames)"])
    PCAP --> NIC
    NIC --> GR

    classDef frontend fill:#e3f2fd,stroke:#1565c0,color:#000;
    classDef boundary fill:#fff3e0,stroke:#e65100,color:#000;
    classDef backend  fill:#f1f8e9,stroke:#33691e,color:#000;
    class FE,UI,TC frontend;
    class WS,EP boundary;
    class BE,PWS,PC,INST,EQ,ENC,SB,PCAP,GS,GT,GE,GR,SPSC,ST,FI,CID backend;
```

**Reading it:** the JS frontend talks to the C++ engine through one
WebSocket inside the same process — no Tauri IPC, no Rust FFI. Every JS
command is a JSON message on the `/ws` endpoint that `PubWsServer.cc`
dispatches directly to the relevant C++ object. The actual SV / GOOSE
frames on the wire are binary IEC 61850 — JSON is purely the **internal**
control plane.

---

## D2 — Startup sequence

What happens between `./sv-publisher` and the first frame on the wire.

```mermaid
sequenceDiagram
    autonumber
    participant Shell as User shell
    participant Main as main.rs::main()
    participant Lib as lib.rs::run()
    participant PWS as PubWsServer.cc<br/>(C++ thread)
    participant Tauri as tauri::Builder
    participant Webview as webkit2gtk webview
    participant JS as web/js/app.js
    participant TC as tauriClient.js

    Shell->>Main: exec sv-publisher
    Main->>Lib: sv_publisher_lib::run()
    Lib->>Lib: init_npcap_path() (Windows only)
    Note over Lib,PWS: WS server starts BEFORE Tauri<br/>so it survives GTK failures
    Lib->>PWS: unsafe { sv_pub_ws_start(9100) }
    PWS->>PWS: std::thread → uWS::App::ws("/ws")
    PWS-->>Lib: returns immediately
    Lib->>Tauri: Builder::default().plugin(shell).setup(banner).run()
    Tauri->>Webview: create window, load index.html
    Tauri->>Webview: window.open_devtools() (devtools feature)
    Webview->>JS: load + execute app.js
    JS->>TC: import { ... } from './utils/tauriClient.js'
    TC->>PWS: new WebSocket('ws://localhost:9100/ws')
    PWS-->>TC: {type:"welcome", version:"1"}
    TC->>PWS: {cmd:"mp_is_running"}
    PWS-->>TC: {type:"ok", value:false}
    TC->>JS: emit('init', {version, isPublishing:false})
    Note over TC: setInterval(_pollBackend, 250)
    JS->>JS: initAllComponents()<br/>(MultiPublisher, Statistics, FrameViewer, ...)
    Note over JS,PWS: System ready. UI idle until user adds a publisher.
```

---

## D3 — Add publisher → Start (the primary workflow)

What every "Start All" click triggers, from UI button to wire frame. The
sequence includes the **equation format gotcha** (pipe-delimited, not
JSON — fixed in tauriClient).

```mermaid
sequenceDiagram
    autonumber
    participant User
    participant MP as MultiPublisher.js
    participant TC as tauriClient.js
    participant PWS as PubWsServer.cc
    participant PC as PublisherController
    participant INST as SvPublisherInstance
    participant EQ as EquationProcessor
    participant ENC as SvEncoder
    participant SB as SharedBuffer
    participant TX as PcapTx
    participant NIC as NIC / wire

    User->>MP: click "Add Publisher"
    MP->>TC: mpAddPublisher()
    TC->>PWS: {cmd:"mp_add_publisher"}
    PWS->>PC: PublisherController::instance().addPublisher()
    PC-->>PWS: id (uint32, monotonic — never reused)
    PWS-->>TC: {type:"ok", value:id}
    TC-->>MP: backendId

    User->>MP: edit equations, click "Start All"

    MP->>TC: getInterfaces() / openInterface(name)
    TC->>PWS: {cmd:"open_interface", name:"enp1s0"}
    PWS->>TX: npcap_open("enp1s0")

    MP->>TC: mpRemoveAllPublishers() (clean slate)
    TC->>PWS: {cmd:"mp_remove_all_publishers"}
    PWS->>PC: removeAllPublishers()

    loop for each publisher in MP._publishers
        MP->>TC: mpAddPublisher()
        TC->>PWS: {cmd:"mp_add_publisher"} → id
        MP->>TC: mpConfigurePublisher(id, {svId, appId, srcMac, dstMac,<br/>sampleRate, frequency, noAsdu, channelCount, channels})
        Note over TC: split: basic config + channels
        TC->>PWS: {cmd:"mp_configure_publisher", id, svId, ...}
        PWS->>PC: configurePublisher(id, PublisherConfig)
        PC->>INST: configure(config)
        Note over TC: channels.map(ch => `${ch.id}:${ch.eq}`).join("|")
        TC->>PWS: {cmd:"mp_set_publisher_equations", id, equations:"IA:sin(...)|IB:sin(...)|..."}
        PWS->>PC: setPublisherEquations(id, "IA:sin(...)|...")
        PC->>INST: setEquations(...)
        INST->>EQ: loadEquations(...) → channel count
        Note over INST: returns -1 if 0 channels parsed → toast UI<br/>(prevents silent zero-emit)
    end

    MP->>TC: mpSetDuration(seconds, repeat, infinite, count)
    TC->>PWS: {cmd:"mp_set_duration", seconds, repeat, infinite, count}
    PWS->>PC: setDuration(...)

    MP->>TC: mpStartAll()
    TC->>PWS: {cmd:"mp_start_all"}
    PWS->>PC: startAll()
    PC->>PC: check npcap_is_open(), join leftover thread

    loop sequential per CONFIGURED publisher (encoder is a global singleton)
        PC->>INST: prebuildFrames()
        INST->>ENC: sv_encoder_set_config(this publisher's SvEncoderConfig)
        loop i = 0 .. packetsPerSecond
            INST->>EQ: generate9_2LESamples(t=i/rate, samples[], channelCount)
            EQ-->>INST: int32 samples
            INST->>ENC: sv_encoder_encode_packet(smpCnt=i, samples, buf)<br/>or encode_multi_asdu for noAsdu>1
            ENC-->>INST: frame bytes → m_frames[i]
        end
    end
    PC->>SB: buildFromPublishers(m_publishers)
    SB->>SB: stagger publishers, sort by timestamp,<br/>borrow frame pointers (zero copy)
    PC->>PC: m_writerThread = std::thread(writerLoop)

    PWS-->>TC: {type:"ok", cmd:"mp_start_all"}
    TC-->>MP: success → status="publishing"

    Note over PC,NIC: Real-time writer loop (next diagram)
```

---

## D4 — SV writer loop (config → samples → bytes → wire)

The hot path. One thread inside `PublisherController` strides through the
merged schedule, paces against an absolute deadline, optionally re-encodes
External-source frames live, applies fault injection, and ships via
`PcapTx`. Per-publisher `setCurrentSmpCnt(frameIdx)` lets the FrameViewer
display the live counter.

```mermaid
flowchart TB
    EQS["User equations<br/>'IA:sin(2*PI*50*t)|...'<br/>(or WT:/WTS: wavetables)"]
    EQ["EquationProcessor::loadEquations()<br/>parse once into EqChannelData[]"]
    GEN["generate9_2LESamples(t)<br/>called per frame at prebuild"]
    ENC["SvEncoder::encode_packet()<br/>or encode_multi_asdu()<br/>builds Ethernet+VLAN+SV+ASN.1 BER"]
    CACHE["SvPublisherInstance.m_frames[]<br/>contiguous 1-second cache<br/>≤65536 frames"]
    SB["SharedBuffer<br/>vector&lt;ScheduleEntry&gt;<br/>{timestamp_us, framePtr, frameLen,<br/>publisher*, frameIdx}<br/>sorted, immutable"]

    subgraph LOOP["PublisherController::writerLoop()"]
        direction TB
        TRY{"tryParallelWriterPool()?"}
        WLI["writerLoopImmediate()<br/>(single-thread legacy path)"]
        PACER["sv::DeadlinePacer<br/>clock_nanosleep absolute"]
        WAIT["wait_due(N)"]
        ENTRY["read ScheduleEntry e =<br/>m_sharedBuffer[schedIdx % schedSize]"]
        STAMP["e.publisher->setCurrentSmpCnt(e.frameIdx)<br/>(relaxed atomic, for FrameViewer)"]
        EXT{"e.publisher->sourceMode() == External<br/>&& protocol() == SV?"}
        REENC["e.publisher->reencodeFrame(e.frameIdx, now_ns)<br/>(pulls from SpscBridge.sampleAt())"]
        FIQ{"m_faultInjector.isEnabled()?"}
        FI["m_faultInjector.process(<br/>e.framePtr, e.frameLen, scratch)<br/>→ SEND_NORMAL / DROP / DUP / MODIFIED"]
        SEND["npcap_send_packet_batch(SEND_BATCH=16)"]
        STATS["npcap_stats_record_packet_batch()<br/>(uint64 atomics)"]
        DURATION{"checkDurationElapsed()?"}
        REPEAT{"m_repeatEnabled<br/>&& (infinite || ++cycle &lt; count)?"}
    end

    TX["PcapTx<br/>libpcap pcap_inject() /<br/>AF_PACKET sendmmsg"]
    NIC(["NIC / wire — binary IEC 61850-9-2 LE frame<br/>EtherType 0x88BA"])

    EQS --> EQ --> GEN --> ENC --> CACHE
    CACHE -->|"borrowed framePtr<br/>(SvPublisherInstance.getFrame(i))"| SB
    SB --> TRY
    TRY -->|"deliberately returns false"| WLI
    WLI --> PACER --> WAIT --> ENTRY --> STAMP --> EXT
    EXT -->|"yes"| REENC --> FIQ
    EXT -->|"no"| FIQ
    FIQ -->|"yes"| FI --> SEND
    FIQ -->|"no"| SEND
    SEND --> STATS
    STATS --> DURATION
    DURATION -->|"no"| WAIT
    DURATION -->|"yes"| REPEAT
    REPEAT -->|"yes"| PACER
    REPEAT -->|"no"| DONE(["thread exits → m_running=false<br/>250 ms poller fires 'publishingStopped'"])
    SEND --> TX --> NIC

    classDef hot fill:#fff3e0,stroke:#e65100,color:#000;
    classDef store fill:#e3f2fd,stroke:#1565c0,color:#000;
    class LOOP,PACER,WAIT,ENTRY,STAMP,SEND hot;
    class CACHE,SB store;
```

---

## D5 — GOOSE TX (configure → state change → retransmit ramp)

GOOSE is a separate protocol with its own scheduler thread per stream and
its own retransmit cadence per IEC 61850-8-1. The encoder uses the shared
ASN.1 BER helper. Sample values come from `SpscBridge` (so an external app
can drive boolean state changes via the SPSC path).

```mermaid
flowchart TB
    UI["MultiPublisher.js<br/>publisher.protocol === 'goose'"]
    TC["tauriClient.gooseConfigureTx() / gooseStartTx() /<br/>gooseStopTx() / gooseStopAllTx()"]
    PWS["PubWsServer.cc<br/>cmd in goose_*"]
    GSVC["GooseService<br/>sv_goose_configure_tx()<br/>sv_goose_start_tx(streamId, hbMs, firstRetxMs)"]

    subgraph SCH["GooseTxScheduler (one std::thread per active stream)"]
        direction TB
        TIMER["clock_nanosleep until next deadline"]
        SAMPLE["SpscBridge::sampleAt(streamId, 0, ...)<br/>→ latest boolean"]
        CMP{"value changed?"}
        STATE["stNum++  sqNum=0<br/>(state change)"]
        RAMP["retransmit ramp:<br/>fire now, +firstRetx, ×2, ×4, ×8 …<br/>capped at hbMs"]
        IDLE["heartbeat: emit every hbMs"]
        ENCREQ["GooseEncoder::encode_frame()"]
    end

    GE["GooseEncoder<br/>build APPID + length + reserved +<br/>BER goosePdu (gocbRef, datSet,<br/>goID, t, stNum, sqNum,<br/>test, confRev, ndsCom, numDatSetEntries,<br/>allData)"]
    BER["asn1_ber_encoder<br/>(shared TLV helpers)"]
    TX["PcapTx<br/>npcap_send_packet()"]
    NIC(["NIC / wire<br/>EtherType 0x88B8<br/>binary IEC 61850-8-1 GOOSE"])

    UI --> TC --> PWS --> GSVC --> SCH
    TIMER --> SAMPLE --> CMP
    CMP -->|"yes"| STATE --> RAMP --> ENCREQ
    CMP -->|"no"| IDLE --> ENCREQ
    ENCREQ --> GE
    GE --> BER
    GE --> TX --> NIC
    RAMP --> TIMER
    IDLE --> TIMER

    classDef ctrl fill:#e3f2fd,stroke:#1565c0,color:#000;
    classDef sched fill:#fff3e0,stroke:#e65100,color:#000;
    class UI,TC,PWS,GSVC ctrl;
    class SCH,TIMER,SAMPLE,STATE,RAMP,IDLE sched;
```

**Retransmit ramp (per IEC 61850-8-1 §A.3):** on a state change the
scheduler emits immediately, then again at `firstRetxMs`, then `×2`, `×4`,
`×8` … capped at `heartbeatMs`. While idle it emits one heartbeat per
`heartbeatMs`. `stNum` increments per state change; `sqNum` per
retransmit within a state.

---

## D6 — GOOSE RX (NIC → decode → SpscBridge)

Inbound GOOSE frames captured from the NIC, decoded, and pushed into the
per-stream outbound ring. Anyone holding the SPSC ring's consumer end
(currently nothing in the publisher binary — exposed for future use) sees
the decoded payload.

```mermaid
flowchart TB
    UI["MultiPublisher.js / RemoteBackend.js"]
    TC["tauriClient.gooseRxStart() / gooseRxRegister() / gooseRxClear()"]
    PWS["PubWsServer.cc<br/>cmd in goose_rx_*"]
    GSVC["GooseService<br/>sv_goose_rx_start(iface) /<br/>sv_goose_rx_register(gocbRef, streamId)"]

    subgraph RX["GooseReceiver (one capture thread)"]
        direction TB
        PCAP["libpcap pcap_loop()<br/>filter 'ether proto 0x88b8'"]
        DECODE["goose_decode()<br/>parse APDU → {gocbRef, t, stNum, sqNum,<br/>boolean payload, ...}"]
        MAP{"gocbRef → streamId<br/>in registry?"}
        DROP["framesUnmatched++<br/>(stat counter)"]
    end

    NIC(["NIC / wire<br/>incoming 0x88B8"])
    BRO["SpscBridge.outbound[streamId]<br/>(rigtorp SPSCQueue&lt;SpscMessage&gt;)"]
    STATS["GOOSE RX stats:<br/>frames_seen, frames_pushed,<br/>frames_unmatched"]

    UI --> TC --> PWS --> GSVC --> RX
    NIC --> PCAP --> DECODE --> MAP
    MAP -->|"yes"| BRO
    MAP -->|"no"| DROP
    BRO --> STATS
    DROP --> STATS

    classDef ctrl fill:#e3f2fd,stroke:#1565c0,color:#000;
    classDef rx   fill:#fff3e0,stroke:#e65100,color:#000;
    class UI,TC,PWS,GSVC ctrl;
    class RX,PCAP,DECODE,MAP,DROP rx;
```

---

## D7 — Statistics + FrameViewer (the 250 ms poll loop)

The Statistics panel and FrameViewer don't push, they pull. tauriClient.js
runs one `setInterval(_pollBackend, 250)` that drives every status,
publishing-edge, stats, and current-channel-values update.

```mermaid
sequenceDiagram
    autonumber
    participant Poller as tauriClient.js<br/>_pollBackend (250 ms)
    participant PWS as PubWsServer.cc
    participant PC as PublisherController
    participant INST as SvPublisherInstance<br/>(first one)
    participant Stats as SvStats
    participant Statistics as Statistics.js
    participant FV as FrameViewer.js

    loop every 250 ms while WebSocket open
        Poller->>PWS: {cmd:"mp_is_running"}
        PWS->>PC: instance().isRunning() → atomic bool
        PWS-->>Poller: {value:true|false}

        alt running edge changed (off→on)
            Poller->>Poller: _runStartMs = Date.now()
            Poller-->>Statistics: emit('status', {status:'running'})
        else running edge changed (on→off)
            Poller-->>Statistics: emit('status', {status:'stopped'})
            Poller-->>Statistics: emit('publishingStopped', {})
        end

        par parallel fetch
            Poller->>PWS: {cmd:"get_stats"}
            PWS->>Stats: npcap_stats_update_rates() + npcap_stats_get(&s)
            PWS-->>Poller: {packets_sent, packets_failed, bytes_sent,<br/>current_bps, current_pps, peak_bps, peak_pps,<br/>session_active}
        and
            Poller->>PWS: {cmd:"get_current_channel_values"}
            PWS->>INST: getCurrentChannelValues(values[], 20)
            PWS->>INST: getCurrentSmpCnt()
            INST-->>PWS: {values, smpCnt}<br/>(smpCnt = m_currentSmpCnt, written by writer loop)
            PWS-->>Poller: {values:[...], smpCnt}
        end

        Poller->>Poller: _toCamelStats(raw, smpCnt, durationSec)<br/>(snake→camel: packets_sent→packetsSent, etc.)
        Poller-->>Statistics: emit('stats', {packetsSent, currentBps,<br/>currentPps, smpCnt, durationSec, ...})
        Statistics->>Statistics: updateStatsDisplay(stats)<br/>store.setData({stats})
    end

    Note over FV,PWS: FrameViewer pulls on demand (not 250 ms)
    FV->>PWS: {cmd:"get_sample_frame", id, smpCnt}
    PWS->>INST: pickPublisher(id) → getSampleFrame(buf, sz, &n, smpCnt)
    INST->>INST: encode one frame at smpCnt using cached config + equations<br/>(stateless peek — works whether running or not)
    PWS-->>FV: {frameSize, frameBytes:[...]}
    FV->>FV: parseRealFrame() → render tree + hex view
```

---

## Summary — what's the same / what's different vs. pre-migration

| Concern | Pre-migration | Now |
|---|---|---|
| JS → backend transport | Tauri IPC (`invoke()`) | WebSocket `ws://localhost:9100/ws` |
| Rust command layer | `commands.rs` (~50 handlers) | empty placeholder |
| Rust FFI shim | `ffi.rs` (~30 wrappers) | empty placeholder |
| Single-publisher path | `SvPublisher` singleton + `npcap_publisher_*` C ABI | **deleted** — single-stream is just multi with N=1 |
| Multi-publisher path | `PublisherController` + `SvPublisherInstance × N` | unchanged |
| Stats polling cadence | 250 ms via Tauri | 250 ms via WebSocket |
| FrameViewer inspection | `npcap_get_sample_frame` on legacy singleton | `SvPublisherInstance::getSampleFrame()` per publisher |
| Equation contract | pipe-delimited `"id:eq\|id:eq"` | unchanged (the wire was always this, JS serializer now matches) |
| Wire format | binary IEC 61850-9-2 LE / 8-1 | unchanged |

The simplification: one fewer language hop, one fewer translation layer,
one fewer parallel publisher class. Every diagram above describes the
**current** architecture only — no historical paths shown.

---

# Part B — `substation_kit` (embeddable library)

`substation_kit/` is a **standalone C++ static library** that wraps the
publisher's IEC 61850 wire-format core so an external app (the simulator
running on the same device) can produce SV/GOOSE frames without spinning
up the full publisher application. It is intentionally not linked into
the `sv-publisher` binary — see L0 for the relationship.

Folder: [`substation_kit/`](../../substation_kit/)
Header consumers `#include`: [`include/SubstationKit.h`](../../substation_kit/include/SubstationKit.h)
Public namespace: `substation::`

---

## L0 — Shared vs distinct (publisher app ↔ library)

The two products **share five native source files** (the IEC 61850
encoders, ASN.1 BER helper, libpcap TX wrapper, stats tracker) but have
**completely separate** runtime infrastructure. The library does not
depend on the publisher's WebSocket dispatcher, controller, fault
injector, equation processor, or frontend. The publisher does not
depend on the library.

```mermaid
flowchart TB
    subgraph SHARED["Shared native sources (publisher/custom/native/)"]
        direction TB
        N1["src/SvEncoder.cc + include/sv_encoder.h<br/>(IEC 61850-9-2 LE binary encoder)"]
        N2["src/GooseEncoder.cc + include/GooseEncoder.h<br/>(IEC 61850-8-1 binary encoder)"]
        N3["src/asn1_ber_encoder.cc + include/asn1_ber_encoder.h<br/>(BER TLV primitives)"]
        N4["src/PcapTx.cc + include/PcapTx.h<br/>(libpcap / AF_PACKET raw TX)"]
        N5["src/SvStats.cc + include/sv_stats.h<br/>(atomic counters)"]
    end

    subgraph PUB["sv-publisher binary (Tauri desktop app)"]
        direction TB
        PA["JS frontend (web/js)"]
        PB["PubWsServer.cc<br/>(WS dispatcher)"]
        PC["PublisherController + SvPublisherInstance × N<br/>EquationProcessor, SharedBuffer,<br/>FaultInjector, writer thread, cid_generator"]
        PD["GooseService + GooseTxScheduler + GooseReceiver"]
        PE["SpscBridge"]
    end

    subgraph LIB["libsubstation_kit.a (static archive for external apps)"]
        direction TB
        LA["substation::Engine<br/>(MPMC + worker thread + libpcap)"]
        LB["substation::sv (wraps sv_encoder.h)"]
        LC["substation::goose (wraps GooseEncoder.h)"]
        LD["substation::ber (wraps asn1_ber_encoder.h)"]
        LE["substation::net (wraps PcapTx.h)"]
        LF["substation::spsc::Queue&lt;T&gt;<br/>(rigtorp SPSC wrapper)"]
    end

    PUB ---|"compiled in via src-tauri/build.rs"| SHARED
    LIB ---|"compiled in via substation_kit/CMakeLists.txt"| SHARED
    PC -.uses.-> N1
    PC -.uses.-> N4
    PC -.uses.-> N5
    PD -.uses.-> N2
    PD -.uses.-> N3
    PD -.uses.-> N4
    LB -.wraps.-> N1
    LC -.wraps.-> N2
    LD -.wraps.-> N3
    LE -.wraps.-> N4
    LA -.uses.-> N4
    LA -.uses.-> N5

    PUB_BIN(["sv-publisher (executable)"])
    LIB_BIN(["her_simulator (her executable, links libsubstation_kit.a)"])
    PUB --> PUB_BIN
    LIB --> LIB_BIN

    classDef shared fill:#fff3e0,stroke:#e65100,color:#000;
    classDef pub fill:#e3f2fd,stroke:#1565c0,color:#000;
    classDef lib fill:#f1f8e9,stroke:#33691e,color:#000;
    class SHARED,N1,N2,N3,N4,N5 shared;
    class PUB,PA,PB,PC,PD,PE pub;
    class LIB,LA,LB,LC,LD,LE,LF lib;
```

**Why this split:** the wire-format encoders are pure functions on byte
buffers — perfect to reuse. Everything ABOVE them (UI, scheduling, live
re-encode, fault injection, retransmit ramps) is application-specific
and belongs in whichever app owns the runtime. The simulator gets to
build its own scheduling/UI on top of the same protocol primitives.

---

## L1 — What's inside `libsubstation_kit.a`

Six namespaces under `substation::`, nothing leaks into the consumer's
code. The library is **self-contained** — once linked it pulls in
libpcap + pthread only.

```mermaid
flowchart TB
    subgraph LIB["libsubstation_kit.a (one static archive)"]
        direction TB

        subgraph ENG["substation::Engine"]
            EI["Engine()<br/>~Engine() (RAII shutdown)"]
            EM["init(Config) → bool<br/>shutdown()<br/>isRunning() const"]
            ES["submitFrame(bytes, len)<br/>(any thread, non-blocking, MPMC)"]
            EQ["framesSubmitted() /<br/>framesSent() /<br/>framesDropped()"]
        end

        subgraph SV["substation::sv (IEC 61850-9-2 LE)"]
            SVK["MAX_CHANNELS=20, MAX_ASDU=8<br/>MIN_FRAME=60, MAX_FRAME=1500<br/>ETHERTYPE=0x88BA"]
            SVC["struct EncoderConfig<br/>{svID, appID, confRev, smpSynch,<br/>srcMAC, dstMAC, vlanPriority, vlanID,<br/>asduCount, channelCount}"]
            SVE["setConfig(cfg) / getConfig(&out)<br/>encodePacket(smpCnt, samples, buf, &len)<br/>encodeMultiAsdu(baseSmpCnt, samples, buf, &len)<br/>expectedFrameSize()"]
        end

        subgraph GO["substation::goose (IEC 61850-8-1)"]
            GOK["MAX_FRAME=256, MIN_FRAME=60<br/>MAX_REF_LEN=128, ETHERTYPE=0x88B8"]
            GOC["struct EncoderConfig<br/>{srcMAC, dstMAC, vlanID, vlanPriority,<br/>appID, confRev, test, ndsCom,<br/>gocbRef, datSet, goID}<br/><br/>struct FrameState<br/>{stNum, sqNum,<br/>timeAllowedToLive_ms, t_ns,<br/>booleanValue}"]
            GOE["encodeFrame(cfg, state, out, &len)"]
        end

        subgraph BER["substation::ber (ASN.1 BER primitives)"]
            BE["encode_tag / encode_length / encode_tlv<br/>encode_unsigned / encode_signed<br/>encode_int32_fixed / encode_uint32_fixed<br/>encode_visible_string / encode_octet_string<br/>encode_boolean"]
        end

        subgraph NET["substation::net (raw Ethernet TX)"]
            NL["struct Interface {name, description, mac, has_mac}<br/>listInterfaces(out, max) → count<br/>open(device) / close() / isOpen()<br/>sendPacket(data, len)<br/>sendBatch(data[], lens[], count)<br/>lastError()"]
        end

        subgraph SP["substation::spsc"]
            SQ["template &lt;typename T&gt; class Queue {<br/>  Queue(capacity)<br/>  try_push(value) / try_pop(out)<br/>  size() / capacity()<br/>}<br/>(rigtorp SPSC, lock-free)"]
        end

        EM -.opens libpcap via.-> NL
        EM -.spawns worker.-> ENG_W["worker thread:<br/>drains MPMC → net::sendBatch"]
        ES -.try_push.-> ENG_W
    end

    DEPS["External deps:<br/>• libpcap (system)<br/>• pthread (system)<br/>• libstdc++ (system)"]
    LIB --> DEPS

    classDef api fill:#e3f2fd,stroke:#1565c0,color:#000;
    classDef worker fill:#fff3e0,stroke:#e65100,color:#000;
    classDef constants fill:#f5f5f5,stroke:#616161,color:#000;
    class EI,EM,ES,EQ,SVC,SVE,GOC,GOE,BE,NL,SQ api;
    class ENG_W worker;
    class SVK,GOK constants;
```

---

## L2 — How a consumer integrates the library

The teammate copies the `substation_kit/` folder into her project, adds
three lines to her CMakeLists.txt, and `#include`s one header. Her
build doesn't see publisher native sources directly — the kit's own
CMake pulls them in.

```mermaid
flowchart LR
    subgraph HER["her_app/ (Shivani's project)"]
        direction TB
        APP["her_simulator main.cpp<br/>#include &lt;SubstationKit.h&gt;"]
        HCM["her_app/CMakeLists.txt:<br/><br/>add_subdirectory(substation_kit)<br/>target_link_libraries(her_app<br/>&nbsp;&nbsp;PRIVATE substation_kit)<br/>target_include_directories(her_app<br/>&nbsp;&nbsp;PRIVATE substation_kit/include)"]
    end

    subgraph KIT["substation_kit/<br/>(copied into her tree)"]
        SH["include/SubstationKit.h<br/>(only public header)"]
        KCM["CMakeLists.txt<br/>(builds the .a, pulls publisher sources)"]
        KSRC["src/SubstationKit.cc<br/>(implementation)"]
        EX["example/sim_example.cpp<br/>(working starter)"]
    end

    subgraph PUB["publisher/custom/native/<br/>(referenced by SUBSTATION_PUBLISHER_NATIVE,<br/>default ../native)"]
        PSV["src/SvEncoder.cc"]
        PGE["src/GooseEncoder.cc"]
        PBE["src/asn1_ber_encoder.cc"]
        PTX["src/PcapTx.cc"]
        PSS["src/SvStats.cc"]
    end

    APP -->|"#include"| SH
    HCM -->|"add_subdirectory()"| KCM
    KCM -->|"add_library STATIC"| KSRC
    KCM -->|"add_library STATIC"| PSV
    KCM -->|"add_library STATIC"| PGE
    KCM -->|"add_library STATIC"| PBE
    KCM -->|"add_library STATIC"| PTX
    KCM -->|"add_library STATIC"| PSS
    KSRC --> LIBOUT[("libsubstation_kit.a")]
    PSV --> LIBOUT
    PGE --> LIBOUT
    PBE --> LIBOUT
    PTX --> LIBOUT
    PSS --> LIBOUT

    LIBOUT -->|"target_link_libraries"| HER_BIN(["her_simulator (binary)"])

    SYS["system: -lpcap -lpthread"]
    LIBOUT --> SYS
    SYS --> HER_BIN

    CAPS["sudo setcap<br/>cap_net_raw,cap_net_admin+eip<br/>./her_simulator"]
    HER_BIN -.-> CAPS

    classDef her fill:#e3f2fd,stroke:#1565c0,color:#000;
    classDef kit fill:#f1f8e9,stroke:#33691e,color:#000;
    classDef pub fill:#fff3e0,stroke:#e65100,color:#000;
    classDef ops fill:#fce4ec,stroke:#ad1457,color:#000;
    class HER,APP,HCM her;
    class KIT,SH,KCM,KSRC,EX kit;
    class PUB,PSV,PGE,PBE,PTX,PSS pub;
    class CAPS ops;
```

---

## L3 — Threading model when `Engine` is used

Three roles, one queue. `Engine::init()` opens libpcap and spawns one
**engine worker** thread. Any number of her sim worker threads can
encode frames in parallel and push them via `submitFrame()` — the
MPMC queue funnels them to the single TX socket.

```mermaid
flowchart TB
    subgraph MAIN["her main thread"]
        INI["eng.init(cfg)<br/>net::open(iface) → fd<br/>spawn engine worker"]
        SHU["eng.shutdown()<br/>signal stop, join worker"]
        STATS["framesSubmitted() /<br/>framesSent() /<br/>framesDropped()<br/>(print every few s while debugging)"]
    end

    subgraph SIM["sim worker threads (any number — her code)"]
        S1["worker 1<br/>compute samples →<br/>sv::encodePacket(smpCnt, samples,<br/>buf, &len) →<br/>eng.submitFrame(buf, len)"]
        S2["worker 2<br/>build GOOSE state →<br/>goose::encodeFrame(cfg, state,<br/>buf, &len) →<br/>eng.submitFrame(buf, len)"]
        S3["worker N<br/>(any pattern)"]
    end

    MPMC[("rigtorp::MPMCQueue&lt;Frame&gt;<br/>cap = cfg.queue_size (default 8192)<br/>multi-producer • single-consumer<br/>non-blocking try_push / pop")]

    subgraph ENG["engine worker (spawned by init)"]
        DR["loop while running:<br/>1. pop next Frame from MPMC<br/>2. net::sendBatch(...)<br/>3. ++framesSent or ++framesDropped"]
    end

    NIC(["NIC / Ethernet wire<br/>binary 0x88BA (SV) / 0x88B8 (GOOSE)"])

    INI -.spawn.-> DR
    S1 -->|"try_push (non-blocking)"| MPMC
    S2 -->|"try_push (non-blocking)"| MPMC
    S3 -->|"try_push (non-blocking)"| MPMC
    MPMC --> DR
    DR -->|"pcap_inject / sendmmsg"| NIC
    SHU -.join.-> DR
    DR -.atomics.-> STATS

    classDef her fill:#e3f2fd,stroke:#1565c0,color:#000;
    classDef worker fill:#fff3e0,stroke:#e65100,color:#000;
    classDef hot fill:#f1f8e9,stroke:#33691e,color:#000;
    class MAIN,SIM,INI,SHU,STATS,S1,S2,S3 her;
    class ENG,DR worker;
    class MPMC,NIC hot;
```

**Threading rules** (from header docstring):

| Call | Thread context |
|---|---|
| `Engine::init` / `shutdown` | Main thread only (one thread, not concurrent) |
| `engine.submitFrame()` | **Any** number of threads (MPMC = multi-producer) |
| `sv::setConfig` | Once per TX context (encoder is a thread-singleton) |
| `sv::encodePacket` / `encodeMultiAsdu` | One thread at a time (after `setConfig`) |
| `goose::encodeFrame` | Thread-safe, stateless |
| `ber::*` | Thread-safe, stateless |
| `net::*` low-level TX | Single handle — use `engine.submitFrame()` instead |
| `spsc::Queue<T>` | One producer + one consumer thread per instance |

---

## L4 — Typical usage lifecycle (one full run)

What her code does in temporal order: configure encoders → init engine
→ hot loop (encode + submit) → shutdown. The engine worker drains in
parallel; she never blocks on the wire.

```mermaid
sequenceDiagram
    autonumber
    participant Main as her main()
    participant SV as substation::sv
    participant GO as substation::goose
    participant Eng as substation::Engine
    participant Q as MPMC queue<br/>(rigtorp)
    participant Worker as engine worker thread
    participant Net as substation::net<br/>(libpcap handle)
    participant NIC as NIC / wire

    Note over Main,NIC: ── 1. one-time configuration ──
    Main->>SV: sv::setConfig({svID:"MU01", appID:0x4000,<br/>srcMAC, dstMAC, sampleRate:4800,<br/>asduCount:1, channelCount:8, ...})
    opt also publishing GOOSE
        Main->>GO: build goose::EncoderConfig struct<br/>(no setConfig call — caller owns it)
    end

    Note over Main,NIC: ── 2. start engine ──
    Main->>Eng: Engine::Config cfg{<br/>ws_port:9100, queue_size:8192,<br/>iface:"enp1s0"}
    Main->>Eng: eng.init(cfg)
    Eng->>Net: net::open("enp1s0")
    Net-->>Eng: 0 (ok)
    Eng->>Worker: std::thread → worker loop
    Eng-->>Main: true (running)

    Note over Main,NIC: ── 3. hot loop — her sim produces frames ──
    loop her simulator runs
        Main->>SV: sv::encodePacket(smpCnt++,<br/>samples[], buf, &len)
        SV-->>Main: 0 + buf filled (frame bytes)
        Main->>Eng: eng.submitFrame(buf, len)
        Eng->>Q: try_push(Frame{copy of buf, len})
        Q-->>Eng: true (or false if full → ++framesDropped)

        opt GOOSE state change
            Main->>GO: goose::encodeFrame(cfg,<br/>state{stNum++, sqNum=0, ...}, buf, &len)
            Main->>Eng: eng.submitFrame(buf, len)
        end
    end

    Note over Worker,NIC: ── engine worker, in parallel ──
    loop while m_running
        Worker->>Q: pop next Frame
        Q-->>Worker: Frame
        Worker->>Net: net::sendBatch(data, lens, count)
        Net->>NIC: pcap_inject / sendmmsg
        Worker->>Worker: ++framesSent (or ++framesDropped on failure)
    end

    Note over Main,NIC: ── 4. shutdown ──
    Main->>Eng: eng.shutdown()
    Eng->>Worker: stop signal
    Worker-->>Eng: join
    Eng->>Net: net::close()
    Eng-->>Main: returned
    Note over Main: ~Engine() destructor would also call<br/>shutdown() — RAII-safe
```

---

## Summary — how the two products relate

| Concern | `sv-publisher` (Part A) | `substation_kit` (Part B) |
|---|---|---|
| Process model | One desktop app (Tauri webview + C++ engine + WS dispatcher) | One static library (`.a`) linked into the consumer's binary |
| Frontend | JavaScript UI, 250 ms WS poll | None — consumer's own code |
| Control plane | `PubWsServer.cc` JSON dispatcher | Direct C++ function calls |
| Multi-stream | `PublisherController` + N `SvPublisherInstance` | Caller decides — typically one `Engine` + N sim worker threads |
| Live data path | `SpscBridge` + `reencodeFrame` for External-source streams | Caller computes samples, calls `sv::encodePacket`, pushes via `submitFrame` |
| GOOSE retransmit ramp | `GooseTxScheduler` (built in) | **Not in the kit** — caller owns timing (use `goose::encodeFrame` + `Engine::submitFrame` themselves) |
| Fault injection | `FaultInjector` in the writer loop | **Not in the kit** |
| Stats | `SvStats` polled via `get_stats` JSON | `engine.framesSubmitted/Sent/Dropped()` direct calls |
| Wire format | Binary IEC 61850-9-2 LE / 8-1 | **Identical** — same encoders, byte-for-byte interoperable |
| TX path | `PcapTx` (libpcap) | `substation::net` (wraps the same `PcapTx`) |
| Capabilities required | `cap_net_admin,cap_net_raw,cap_ipc_lock,cap_sys_nice=eip` | `cap_net_raw,cap_net_admin+eip` (no SCHED_RR / mlockall) |

Both products produce indistinguishable frames on the wire — the
subscriber can decode from either with the same logic. The publisher
app is for the *operator* doing interactive configuration; the library
is for the *simulator* programmatically driving its own scenarios.
