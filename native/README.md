# SV Publisher - Native C++ Module

## Overview

Native C++ module for IEC 61850-9-2LE Sampled Values encoding and transmission.

## Architecture

```
+-------------------+     +-------------------+     +-------------------+
|  Tauri Commands   | --> |   SV Encoder      | --> | Npcap Transmitter |
|  (JS Interface)   |     | (IEC 61850-9-2)   |     |  (Raw Packets)    |
+-------------------+     +-------------------+     +-------------------+
         |                        |                         |
         v                        v                         v
+-------------------+     +-------------------+     +-------------------+
| Equation Processor|     |  ASN.1 BER Encoder |    |   SV Statistics   |
|  (Math Parser)    |     |  (TLV Encoding)   |     |  (Performance)    |
+-------------------+     +-------------------+     +-------------------+
```

## Source Files

| File | Description |
|------|-------------|
| `SvPublisher.cc` | Main entry point, Tauri command bindings |
| `SvEncoder.cc` | IEC 61850-9-2LE packet encoding |
| `asn1_ber_encoder.cc` | ASN.1 BER/TLV encoding utilities |
| `PcapTx.cc` | Raw packet transmission via Npcap |
| `equation_processor.cc` | Mathematical equation evaluation |
| `SvStats.cc` | Publishing statistics tracking |

## Headers

| File | Description |
|------|-------------|
| `equation_processor.h` | Equation processor class definition |
| `duration_manager.h` | Publishing duration/repeat management |
| `sv_config.h` | Configuration structures |
| `sv_encoder.h` | Encoder interface |
| `sv_stats.h` | Statistics interface |
| `PcapTx.h` | Transmitter interface |

## Building

The native module is built as part of the Tauri build process:

```bash
cd src-tauri
cargo build --release
```

## Dependencies

- **Npcap SDK** - Raw packet capture/transmission
- **C++17** - Modern C++ features
- **Windows.h** - Windows API (timers, threading)

## Data Structures

### SvConfig
```cpp
struct SvConfig {
    std::string svId;           // Stream identifier
    std::string dstMac;         // Destination MAC
    std::string srcMac;         // Source MAC
    uint16_t appId;             // Application ID
    uint32_t sampleRate;        // Samples per second
    uint8_t noAsdu;             // ASDUs per frame
    uint16_t confRev;           // Configuration revision
    uint8_t smpSynch;           // Sample synchronization
};
```

### Channel
```cpp
struct Channel {
    std::string id;             // Channel identifier (Va, Vb, etc.)
    std::string equation;       // Math expression
    std::string type;           // "voltage" or "current"
    double scaleFactor;         // Amplitude scaling
    int phaseOffset;            // Phase shift in degrees
};
```

## API Reference

See generated documentation for detailed function and class descriptions.
