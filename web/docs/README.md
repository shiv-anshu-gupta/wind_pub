# SV-PUB Web Documentation

## Overview

SV-PUB is an IEC 61850 Sampled Values Publisher application built with Tauri.

## Architecture

```
+------------------+     +------------------+     +------------------+
|    Components    | --> |      Store       | --> |   Tauri Client   |
|  (UI Modules)    |     | (State Manager)  |     |  (Backend API)   |
+------------------+     +------------------+     +------------------+
         |                       |                        |
         v                       v                        v
+------------------+     +------------------+     +------------------+
|     Plugins      |     |     Utilities    |     |   Rust Backend   |
| (Toast, Config)  |     | (Math, Format)   |     |  (SV Encoding)   |
+------------------+     +------------------+     +------------------+
```

## Modules

| Module | Description |
|--------|-------------|
| **components/** | UI components (StandardSelector, NetworkSettings, etc.) |
| **store/** | Centralized state management |
| **utils/** | Helper functions (validators, formatters, math) |
| **plugins/** | Feature plugins (toast, shortcuts, config) |
| **shared/** | Shared constants and standards definitions |

## Component List

| Component | Purpose |
|-----------|---------|
| StandardSelector | IEC standard selection (9-2LE, 9-2, 61869) |
| NetworkSettings | Network interface and MAC configuration |
| SVParameters | SV stream parameters (svID, confRev, etc.) |
| StreamSettings | Frequency and sampling configuration |
| DataSource | PCAP/Equation input selection |
| ChannelsDisplay | Active channel visualization |
| FrameViewer | SV frame structure display |
| PublishPanel | Start/Stop publishing controls |
| Statistics | Real-time publishing statistics |
| Preview | Packet preview display |

## Data Flow

1. User selects IEC standard via StandardSelector
2. NetworkSettings configures interface and MACs
3. SVParameters sets stream identifiers
4. DataSource provides channel equations or PCAP data
5. FrameViewer shows frame structure
6. PublishPanel sends data to Rust backend
7. Statistics displays real-time metrics

## Getting Started

```javascript
import { initApp } from './js/app.js';

// Initialize application
document.addEventListener('DOMContentLoaded', initApp);
```

## API Reference

See individual module documentation below.
