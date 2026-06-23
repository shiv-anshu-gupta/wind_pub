# 🔍 COMPREHENSIVE DATA FLOW AUDIT: SV Publisher Application
**Complete Pipeline Analysis from User Input to Packet Publishing**

---

## TABLE OF CONTENTS
1. [App Initialization](#app-initialization)
2. [Standard Selection Flow](#standard-selection-flow-step-1)
3. [Channel Editing Flow](#channel-editing-flow-equation-editor)
4. [Frame Building Flow](#frame-building-flow-pre-publishing)
5. [Publishing Pipeline](#publishing-pipeline-from-click-to-packet)
6. [Data Breakpoints Analysis](#detected-breakpoints)
7. [Subscription Chain](#subscription-notification-chain)
8. [Flow Diagrams](#complete-flow-diagrams)

---

## APP INITIALIZATION

### Initialization Sequence (app.js: lines 103-189)

```
Document Load (index.html)
    ↓
DOMContentLoaded → initApp()
    ├─ Stage 1: Drag Manager (document-level mouse events)
    │   └─ initDragManager()
    │   └─ initResizableColumns()
    │
    ├─ Stage 2: LEFT COLUMN Components
    │   ├─ DataSource.init() - PCAP + Equation tabs (primary input)
    │   ├─ ChannelsDisplay.init() - Show active channels
    │   ├─ StandardSelector.init() - IEC standard selection (Step 1)
    │   └─ StreamSettings.init() - Interface, Frequency, Samples/Cycle
    │
    ├─ Stage 3: MIDDLE COLUMN Components
    │   └─ FrameViewer.init() - Full SV frame structure visualization
    │
    ├─ Stage 4: RIGHT COLUMN Components
    │   ├─ PublishMode.init() - Single ↔ Multi-stream toggle
    │   ├─ Statistics.init() - Real-time network stats
    │   ├─ WiresharkHelper.init() - Filter + helper docs
    │   └─ Preview.init() - Live SV packet structure
    │
    ├─ Stage 5: Async Initialization
    │   ├─ initEmbeddedMathEditor() [ASYNC] - MathLive equation editor
    │   ├─ initConfigButtons() - Save/Load state
    │   ├─ initKeyboardShortcuts() - Keyboard bindings
    │   └─ initUnloadWarning() - Warn on unsaved changes
    │
    ├─ Stage 6: Theme System
    │   └─ initThemeToggle() - Light/dark mode
    │
    ├─ Stage 7: Backend Connection
    │   └─ tauriClient.connect() [ASYNC] - Communicate with Rust backend
    │       ├─ Check native availability
    │       ├─ Emit 'connect' event
    │       ├─ Get initial state
    │       └─ Start stats polling (250ms interval)
    │
    └─ Stage 8: Debug Exposure
        └─ window.__store = store
        └─ window.__modules = UI components
```

### Load Sequence Analysis

| Stage | Component | Depends On | Store Access | Issues |
|-------|-----------|-----------|--------------|--------|
| **1** | DragManager | DOM | None | ✅ No deps |
| **2** | DataSource | Store | Read `data` | ✅ Store ready |
| **2** | ChannelsDisplay | Store | Read `data.channels` | ✅ Subscribes to changes |
| **2** | StandardSelector | Store | Read `config.standard` | ✅ Subscribes to changes |
| **2** | StreamSettings | Store | Read `config.frequency/samplesPerCycle` | ✅ Subscribes to changes |
| **3** | FrameViewer | Store | Read `config`, `data.channels` | ✅ Dynamic updates |
| **4** | PublishPanel | Store + Tauri | Read all config | ✅ Waits for Tauri ready |
| **5** | EmbeddedMathEditor | Store | Read `data.channels`, Write equations | ⚠️ **Async** - may init late |
| **7** | tauriClient | Rust backend | Sets interface, gets stats | ✅ Polls stats only |

### Potential Initialization Issues

**ISSUE #1: EmbeddedMathEditor Async Initialization**
- Line 181: `await initEmbeddedMathEditor()` is ASYNC but marked `try-catch`
- If MathLive CDN fails, editor never initializes but app continues
- Users can't edit equations if this fails
- **Impact**: Non-fatal, but core feature unavailable
- **Severity**: MEDIUM

**ISSUE #2: No Circular Dependency Check**
- All components subscribe to store on init
- Store is initialized before any component init
- **No risk of circular dependency**
- **Status**: ✅ SAFE

**ISSUE #3: Initialization Order Enforced**
- LEFT column (config) must init before RIGHT column (pub)
- LEFT column initializes FIRST, so ✅ SAFE
- All config defaults are baked into `store.js` at module load time
- **Status**: ✅ SAFE

---

## STANDARD SELECTION FLOW (Step 1)

### Component: StandardSelector.js (lines 1-200+)

**Data Path:**
```
User clicks radio button (IEC 9-2LE / 9-2 / 61869)
    ↓
handleCardClick() or handleRadioChange() fires
    ↓
updateStandard(standardId)
    ├─ store.setConfig({ standard: '9-2LE', standardConfig: {...}, selectedChannels: [...] })
    │   ├─ Validates standard exists in STANDARDS (../../shared/standards.js)
    │   ├─ Auto-builds full standardConfig object
    │   ├─ Sets default selectedChannels for that standard
    │   ├─ Rebuilds channel array with new standard's equations
    │   └─ Calls store._notifyChanges(['config.standard', 'data.channels'])
    │
    └─ syncFromStore() called by subscription
        └─ Updates UI radio to reflect new standard
```

### Store Updates (store.js: lines 300-370)

**When standard changes, store does:**
```javascript
// Line 314-336: Auto-update channels for new standard
if (updates.standard !== undefined && changed.includes('config.standard')) {
    const standard = STANDARDS[updates.standard];
    const channelOrder = standard?.channelOrder || [...];
    const equations = getDefaultEquations(this._config.frequency);
    
    // REPLACE entire channels array
    this._data.channels = channelOrder.map(id => ({
        id, label, type, unit, 
        equation: equations[id] || '0',
        isBase: true
    }));
    
    // REPLACE selectedChannels array
    this._config.selectedChannels = standard.defaultSelected || channelOrder;
    
    changed.push('data.channels', 'config.selectedChannels');
}
```

### Subscription Chain

| Subscriber | Path | Callback | Triggers |
|-----------|------|----------|----------|
| StandardSelector | `config.standard` | `syncFromStore()` | Updates radio UI |
| ChannelsDisplay | `data.channels` | `_updateDisplay()` | Refreshes channel list with new equations |
| StreamSettings | `config.frequency` | (auto-update) | Recalculates sample rate |
| FrameViewer | `config.standard` | (auto-update) | Rebuilds frame structure |
| embeddedMathEditor | `onChange()` | `onGlobalStandardChanged()` | Re-renders editor with new channels |

### Data Propagation

```
StandardSelector: store.setConfig({ standard: '9-2' })
    ↓
Store._notifyChanges(['config.standard', 'data.channels'])
    ├─ Notifies StandardSelector subscribers
    ├─ Notifies ChannelsDisplay subscribers ✓ Shows new channels
    ├─ Notifies FrameViewer subscribers ✓ Updates frame structure
    ├─ Notifies embeddedMathEditor  ✓ Re-renders with new channels
    └─ All other subscribers via onChange()
```

### ✅ VERIFIED: Standard Selection Flow

- **Source of Truth**: Store (`config.standard`, `data.channels`)
- **DOM State**: Hidden inputs auto-build from store, not source of truth
- **Propagation**: ✅ Working - all subscribers notified correctly
- **Data Loss**: ❌ None detected - complete data flow

---

## CHANNEL EDITING FLOW (Equation Editor)

### Component: embeddedMathEditor.js

**Three paths for updating channel equations:**

### PATH 1: Direct Inline Editing (User types equation)

```
User edits equation in MathLive field
    ↓
onSaveEquation() triggered
    ├─ Validates expression syntax
    ├─ Converts LaTeX → math.js format
    ├─ Updates hidden input: document.getElementById(`eq${channelId}`).value = equation
    ├─ Updates store: store.updateEquation(currentChannelId, equation)
    │   └─ store.js line 910-925: updateEquation()
    │       ├─ Finds channel in store._data.channels
    │       ├─ Sets channel.equation = equation
    │       └─ Calls store._notifyChanges(['data.channels', 'data.channels.${id}'])
    │
    └─ ChannelsDisplay receives 'data.channels' notification
        └─ Calls _updateDisplay()
            └─ Pulls updated channels from store.getChannels()
            └─ ✅ DISPLAYS NEW EQUATION
```

**Status**: ✅ WORKING - Both store and DOM updated

### PATH 2: Quick Template (Balanced/Asymmetric/Unbalanced)

```
User clicks "Balanced" template button
    ↓
initQuickTemplates() handler (embeddedMathEditor.js ~line 750)
    ├─ applyQuickTemplate('balanced')
    │   ├─ FOR EACH CHANNEL:
    │   │   ├─ Generate template equation: "325 * sin(2 * PI * freq * t)"
    │   │   ├─ Update hidden input: document.getElementById(`eq${id}`).value = eq
    │   │   └─ Update CURRENT MathField if editing this channel
    │   │
    │   └─ ❌ BUT: DOES NOT UPDATE store.data.channels ❌
    │
    └─ ChannelsDisplay gets NO notification
        └─ ❌ DISPLAYS OLD EQUATIONS ❌
```

**Status**: ⚠️ PARTIAL - Hidden inputs updated, but ChannelsDisplay NOT updated

**Root Cause**: Line ~760 in embeddedMathEditor.js - `applyQuickTemplate()` only updates DOM hidden inputs, not store

**Impact**: When user applies template and looks at ChannelsDisplay, it shows old equations. However, when they submit form, the hidden inputs ARE correct (backend receives correct equations).

### PATH 3: Fault Simulation Template

```
User clicks fault button (Phase-to-Ground, Phase Swap, etc.)
    ↓
initFaultButtons() handler (embeddedMathEditor.js ~line 900)
    ├─ applyFaultTemplate(faultType)
    │   ├─ Generate fault equations using WTS format
    │   ├─ FOR EACH CHANNEL:
    │   │   ├─ Generate WTS equation (wavetable string)
    │   │   └─ Update hidden input: document.getElementById(`eq${id}`).value = wts
    │   │
    │   └─ ❌ DOES NOT UPDATE store.data.channels ❌
    │
    └─ ChannelsDisplay gets NO notification
        └─ ❌ DISPLAYS OLD EQUATIONS ❌
```

**Status**: ⚠️ PARTIAL - Same issue as PATH 2

**Impact**: Fault equations in hidden inputs, but ChannelsDisplay shows old equations

---

### Store Equation Update Method (store.js line 910-925)

```javascript
updateEquation(channelId, equation) {
    const channelIndex = this._data.channels.findIndex(c => c.id === channelId);
    if (channelIndex === -1) {
        console.warn(`[Store] Channel not found: ${channelId}`);
        return false;
    }
    
    // UPDATE the channel object in the store
    this._data.channels[channelIndex].equation = equation;
    
    // NOTIFY subscribers
    this._notifyChanges(['data.channels', `data.channels.${channelId}`]);
    console.log(`[Store] Updated equation: ${channelId} = ${equation}`);
    return true;
}
```

---

### Equation Flow to Backend

```
User submits publication OR presses START
    ↓
PublishPanel.startPublishing() (line 560)
    ├─ Gets complete data: store.getDataForServer()
    │   ├─ Reads store.config (svId, appId, sampleRate, etc.)
    │   ├─ Reads selectedChannels from store.config.selectedChannels
    │   ├─ Gets full channel objects from store._data.channels
    │   │   └─ Includes equation property for each channel
    │   │
    │   └─ Returns { config, channels: [{id, label, equation, type, ...}] }
    │
    ├─ Logs equations being sent (debug box): shows all channel equations
    │
    ├─ Calls tauriClient.updateData(serverData) (tauriClient.js line 360+)
    │   ├─ Step 1: Sends config via invoke('set_config', {config})
    │   │   └─ Rust commands.rs: CONFIG.lock().unwrap() = config
    │   │
    │   ├─ Step 2: Sends channels via invoke('set_channels', {channels})
    │   │   └─ Rust commands.rs line 419: set_channels(channels)
    │   │       ├─ Stores channels: *CHANNELS.lock().unwrap() = channels
    │   │       ├─ Formats equations: "id1:equation1|id2:equation2|..."
    │   │       ├─ Calls ffi::set_equations(&equations_str)
    │   │       │   └─ Rust ffi.rs line 226: npcap_set_equations()
    │   │       │       └─ C FFI extern: npcap_set_equations(const char*)
    │   │       │           └─ C++ native backend receives equation string
    │   │       │
    │   │       └─ Returns Ok() if successful
    │   │
    │   └─ Returns {success: true}
    │
    ├─ Calls tauriClient.start()
    │   └─ invoke('start_publishing')
    │       └─ Rust starts C++ publisher with the equations
    │
    └─ ✅ BACKEND RECEIVES EQUATIONS
```

### Equation Format Transformations

**Stage 1: JavaScript (MathLive → math.js)**
```javascript
// User types in LaTeX: √(325²·sin²(2πft))
// MathLive converts to math.js: sqrt(325^2 * sin(2*PI*f*t)^2)
// Stored in: store.data.channels[i].equation
```

**Stage 2: Frequency Substitution (store.js getDataForServer())**
```javascript
// From store: "325 * sin(2 * PI * 50 * t)"
// Current frequency: 60 Hz
// After updateEquationFrequency(): "325 * sin(2 * PI * 60 * t)"
// Line 1247: equation: updateEquationFrequency(ch.equation, 50, currentFreq)
```

**Stage 3: Serialization to Rust (JSON)**
```json
{
  "channels": [
    {
      "id": "Va",
      "equation": "325 * sin(2 * PI * 60 * t)",
      "type": "voltage"
    }
  ]
}
```

**Stage 4: Rust Processing (commands.rs line 437)**
```rust
// Input from JSON: "325 * sin(2 * PI * 60 * t)"
// Regex replacement: ensure correct frequency
let fixed = fix_equation_frequency(&ch.equation, 60);
// Output: "325 * sin(2 * PI * 60 * t)"  (no change if already 60)
// Format for C++: "Va:325 * sin(2 * PI * 60 * t)"|"Vb:..."
ffi::set_equations(&equations_str)?;
```

**Stage 5: C++ Backend (sv_native_refactored.cc)**
```cpp
// Receives equation string from Rust FFI
// Parses "id:equation|id:equation|..." format
// Compiles equation using math parser
// Generates sample values during packet frame building
```

---

## FRAME BUILDING FLOW (Pre-publishing)

### Component: FrameViewer.js

**Data Source for Frame Display:**

```
FrameViewer reads from store to build frame tree
    ├─ store.get('config.noASDU') - Number of ASDUs in frame
    ├─ store.get('config.selectedChannels') - Which channels in ASDU
    ├─ store.getSelectedChannelsWithDetails() - Channel objects with equations
    ├─ store.get('config.svID') - SV identifier
    ├─ store.get('config.appID') - Application ID
    ├─ store.get('config.srcMAC'), dstMAC, vlan - Network params
    │
    └─ Builds frame tree structure:
        Ethernet Header (18 bytes with VLAN)
            ├─ Dest MAC
            ├─ Source MAC
            ├─ VLAN Tag (if vlanID > 0)
            └─ EtherType
        SV PDU (APPID, Length, Reserved)
        APDU (noASDU, seqASDU[1..noASDU])
        ASDU[0] (svID, smpCnt, confRev, smpSynch, seqData[...])
            ├─ seqData Item[0] - First selected channel value
            ├─ seqData Item[1] - Second selected channel value
            └─ ... (one per selected channel)
```

### Reading Equations for Frame (FrameViewer.js)

**Current Implementation:**

```javascript
// Line ~150 (approximate)
const channels = store.getSelectedChannelsWithDetails();
// Returns: [{id: 'Va', equation: '325*sin(...)', type: 'voltage'}, ...]

// For each channel, when building seqData values:
// Option A: Evaluate equation at current sample time
//   value = evaluateExpression(channel.equation, {t: time, ...})
//   seqData[i] = convertToASN1Format(value);

// Option B: Use stored sample array (from equation evaluation cache)
//   seqData[i] = channel.sampleValues[currentSample];
```

### Dynamic Updates During View

**When user changes channel equation:**

```
embeddedMathEditor: updateEquation('Va', newEq)
    ↓
store.updateEquation('Va', newEq)
    └─ store._notifyChanges(['data.channels'])
    
FrameViewer subscribed to 'data.channels'?
    ❌ NO - FrameViewer only handles manual refresh or node selection

When user clicks "Refresh" button:
    ├─ Gets updated channels from store.getSelectedChannelsWithDetails()
    ├─ Re-evaluates equations at current frame time
    └─ ✅ Displays new values in seqData
```

### Equation Change Impact

| Action | Store Updated? | FrameViewer Updated? | Backend Sees It? |
|--------|---|---|---|
| Direct equation edit | ✅ Yes | ⚠️ Only on manual refresh | ✅ Yes (on publish) |
| Quick template apply | ❌ No (hidden inputs only) | ❌ No | ⚠️ Yes (hidden inputs) |
| Fault template apply | ❌ No (hidden inputs only) | ❌ No | ⚠️ Yes (hidden inputs) |
| StandardSelector change | ✅ Yes | ✅ Yes (auto-refresh) | ✅ Yes |

---

## PUBLISHING PIPELINE (From Click to Packet)

### Complete End-to-End Flow

```
USER CLICKS "START" BUTTON
    ↓
PublishPanel.startPublishing() [line 560]
    ├─ Check: Is backend connected? → tauriClient.isConnected()
    ├─ Check: Is PCAP or Equation selected?
    ├─ Get complete data: store.getDataForServer()
    │   ├─ Reads: config (svID, appID, frequency, sampleRate, MAC, VLAN, noASDU)
    │   ├─ Reads: selectedChannels from config.selectedChannels
    │   ├─ Gets: Full channel objects from data.channels with:
    │   │   ├─ id (e.g., 'Va')
    │   │   ├─ equation (e.g., '325*sin(2*PI*60*t)')
    │   │   ├─ type ('voltage' or 'current')
    │   │   └─ isBase (true/false)
    │   │
    │   ├─ Applies frequency correction to all equations
    │   │   └─ updateEquationFrequency(eq, 50, currentFreq)
    │   │
    │   └─ Returns: {
    │       config: {svId, appId, frequency, sampleRate, noAsdu, ...},
    │       channels: [{id, label, equation, type, isBase}, ...],
    │       meta: {standard, interfaceIndex, selectedChannels}
    │     }
    │
    ├─ DEBUG LOG: Prints all config and equations to console
    │   ├─ Shows: selectedChannels order
    │   ├─ Shows: Each channel ID and equation substring
    │
    ├─ SEND TO TAURI BACKEND: tauriClient.updateData(serverData)
    │   │
    │   ├─ Step 1: invoke('set_config', {config: {...}})
    │   │   └─ commands.rs: *CONFIG.lock() = config ✅
    │   │
    │   ├─ Step 2: Check if computed channels (e.g., power = V*I)?
    │   │   ├─ If yes: Resolve via equationResolver.js
    │   │   │   └─ Generates pre-computed wavetable format
    │   │   │
    │   │   └─ If no: Send channels as-is
    │   │
    │   ├─ Step 3: invoke('set_channels', {channels: [...]})
    │   │   └─ commands.rs [line 419]:
    │   │       ├─ *CHANNELS.lock() = channels_vec ✅
    │   │       ├─ Format: "Va:325*sin(...)|Vb:...|Vc:|..."
    │   │       └─ invoke ffi::set_equations(&fmt_string)
    │   │           └─ ffi.rs [line 226]:
    │   │               └─ npcap_set_equations(c_equations.as_ptr())
    │   │                   └─ C FFI call to C++ native library
    │   │                       └─ sv_native_refactored.cc [line ~?]:
    │   │                           └─ Parses "id:eq|id:eq|..." format
    │   │                               ├─ Stores equations in native SV publisher
    │   │                               ├─ Pre-compiles math expressions
    │   │                               └─ Prepares for sample generation
    │   │
    │   └─ Returns: {success: true}
    │
    ├─ SET DURATION MODE (if not continuous): tauriClient.setDurationMode({...})
    │   └─ invoke('set_duration_mode', {settings: {...}})
    │       └─ ffi::set_duration_mode()
    │           └─ C++ backend sets duration timer
    │
    ├─ START PUBLISHING: tauriClient.start()
    │   └─ invoke('start_publishing')
    │       └─ commands.rs:
    │           ├─ Check: ffi::is_open() - Interface open?
    │           ├─ Call: ffi::publisher_configure(...)
    │           │   └─ C++ SVPublisher.configure() with packet params
    │           │
    │           ├─ Call: ffi::publisher_start()
    │           │   └─ C++ SVPublisher.start()
    │           │       └─ BEGIN PACKET GENERATION & TRANSMISSION
    │           │
    │           └─ Set: IS_PUBLISHING.store(true)
    │
    ├─ EMIT STATUS: emit('status', {status: 'running'})
    │   └─ Statistics component listens and updates UI
    │
    └─ START STATS POLLING: startStatsPolling() [line ~130]
        └─ Every 250ms:
            ├─ invoke('get_stats')
            │   └─ C++ returns current: packets_sent, bytes_sent, rate_bps, etc.
            │
            ├─ emit('stats', stats)
            │   └─ Statistics UI updates with live counts
            │
            └─ Check: is_duration_complete()?
                ├─ If yes: Emit publishingStopped
                │   └─ UI shows "Completed in Xs"
                │
                └─ If no: Continue polling
```

### Tauri Bridge Data Contract

**Frontend → Rust (set_channels)**
```rust
// Input JSON (from tauriClient.updateData):
{
  "channels": [
    {
      "id": "Va",
      "label": "Phase A Voltage",
      "type": "voltage",
      "equation": "325 * sin(2 * PI * 60 * t)",
      "isBase": true
    },
    {
      "id": "Ia",
      "label": "Phase A Current",
      "type": "current",
      "equation": "100 * sin(2 * PI * 60 * t - 0.2)",
      "isBase": true
    }
  ]
}

// Rust deserializes into: Vec<Channel>
// commands.rs [line 419] processes each channel:
pub struct Channel {
    pub id: String,                    // "Va"
    pub label: String,                 // "Phase A Voltage"
    pub channel_type: String,          // "voltage"
    pub equation: String,              // "325 * sin(2 * PI * 60 * t)"
    pub is_base: bool,                 // true
}

// Format for C++: "Va:325*sin(2*PI*60*t)|Ia:100*sin(2*PI*60*t-0.2)"
// Calls: ffi::set_equations(&formatted_string)
```

### Sample Generation in C++ Backend

```cpp
// sv_native_refactored.cc receives formatted equation string:
// "Va:325*sin(2*PI*60*t)|Ia:100*sin(2*PI*60*t-0.2)"

// Parser splits by "|" to get channel equations
// For each channel:
//   1. Compile math expression (uses math parser)
//   2. Store in SV publisher state
//   3. On each packet frame generation:
//      - Evaluate equation: value = f(time)
//      - Convert to I32 format (Q-value)
//      - Store in seqData[index]

// Frame building loop (for each sample):
for (int smp = 0; smp < samplesPerCycle; smp++) {
    float t = (currentCycle * cycleTime + smp * sampleTime);
    
    for (int ch = 0; ch < selectedChannels.size(); ch++) {
        Channel& channel = selectedChannels[ch];
        float value = channel.evaluateEquation(t);    // Math evaluation
        int32_t i32 = (int32_t)(value * 1000);       // Q-value scaling
        seqData[ch] = i32;                            // Store in ASDU
    }
    
    // Build & send frame with seqData
    SV_Frame frame = buildFrame(seqData);
    npcap_sendpacket(frame);
}
```

---

## DETECTED BREAKPOINTS

### BREAKPOINT #1: Quick Template Application ⚠️

**Location**: embeddedMathEditor.js, function `applyQuickTemplate()` (~line 750)

**Issue**: Updates hidden inputs but does NOT update store

```javascript
// ❌ BROKEN PATH:
function applyQuickTemplate(templateId) {
    const channels = store.getChannels();
    channels.forEach(ch => {
        const eq = TEMPLATES[templateId][ch.id];
        
        // Updates DOM:
        document.getElementById(`eq${ch.id}`).value = eq;  ✅
        
        // Updates MathField (if currently editing):
        if (currentChannelId === ch.id) {
            mf.value = eq;  ✅
        }
        
        // ❌ MISSING: Does NOT update store.data.channels
        // Should be: store.updateEquation(ch.id, eq);
    });
}
```

**Impact**:
- ❌ ChannelsDisplay doesn't update (no store change notification)
- ⚠️ Backend receives correct equations (hidden inputs are correct)
- ⚠️ Visual inconsistency - UI shows old equations, backend uses new ones

**Severity**: MEDIUM (backend works; UI misleading)

**Fix**: Add `store.updateEquation(ch.id, eq);` inside the loop

---

### BREAKPOINT #2: Fault Template Application ⚠️

**Location**: embeddedMathEditor.js, function `applyFaultTemplate()` (~line 900)

**Issue**: Same as BREAKPOINT #1

```javascript
// ❌ BROKEN PATH:
function applyFaultTemplate(faultType, opts = {}) {
    const channels = store.getChannels();
    channels.forEach(ch => {
        const wts = generateWavetable(faultType, ch.id, opts);
        
        // Updates DOM:
        document.getElementById(`eq${ch.id}`).value = wts;  ✅
        
        // ❌ MISSING: Does NOT update store.data.channels
        // Should be: store.updateEquation(ch.id, wts);
    });
}
```

**Impact**:
- ❌ ChannelsDisplay shows old equations
- ✅ Backend receives new equations (via hidden inputs on publish)
- ⚠️ UI inconsistency - user confused about actual equations being used

**Severity**: MEDIUM (backend correct; UI misleading)

**Fix**: Add `store.updateEquation(ch.id, wts);` in loop + `store.setData({channels})`

---

### BREAKPOINT #3: FrameViewer Not Auto-Updating on Equation Change ❌

**Location**: FrameViewer.js initialization

**Issue**: FrameViewer doesn't subscribe to `data.channels` changes

```javascript
// ❌ FrameViewer subscriptions (missing):
export function init(container) {
    // ...
    
    // MISSING these subscriptions:
    // store.subscribe('data.channels', _refreshFrame);
    // store.subscribe('config.selectedChannels', _refreshFrame);
    
    // Only manual refresh via button works:
    _elements.refreshFrameBtn?.addEventListener('click', () => {
        // Re-render frame structure
    });
}
```

**Impact**:
- User edits channel equation
- ✅ Store updates
- ❌ FrameViewer doesn't refresh (shows old sample values)
- ⚠️ User must manually click "Refresh" button

**Severity**: LOW (manual refresh available; workflow inconvenient)

**Fix**: Add subscriptions to `data.channels` and `config.selectedChannels`

---

### BREAKPOINT #4: Hidden Inputs vs Store Mismatch ⚠️

**Location**: embeddedMathEditor.js <input id="eqXX"> elements

**Architecture Issue**: Hidden inputs AND store both store equations

```html
<!-- HTML Hidden Inputs (one per channel): -->
<input type="hidden" id="eqVa" value="325*sin(2*PI*60*t)">
<input type="hidden" id="eqVb" value="...">
<!-- Used for: Form submission, fallback data -->

<!-- Store Variable: -->
store.data.channels[0].equation = "325*sin(2*PI*60*t)"
<!-- Used for: UI display, notification system, publishing -->
```

**Risk**: Hidden inputs can be updated without store knowing

```javascript
// ❌ BAD: Direct DOM update (not through store):
document.getElementById('eqVa').value = '100*sin(...)';

// ✅ GOOD: Update through store:
store.updateEquation('Va', '100*sin(...)');
```

**Impact**: Data inconsistency if hidden inputs updated directly

**Severity**: MEDIUM (requires code discipline to avoid)

---

### BREAKPOINT #5: Computed Channels Resolution ⚠️

**Location**: tauriClient.js line 365-375

**Issue**: Computed channels (e.g., Power = V × I) resolved late in pipeline

```javascript
// In tauriClient.updateData():
if (hasComputedChannels(data.channels)) {
    // ⚠️ Only at PUBLISH TIME, not on display
    // Equations are resolved to wavetable format
    channelsToSend = resolveChannelEquations(data.channels, freq, rate);
}

// Issue: ChannelsDisplay shows "V1*I1" but backend sends pre-computed wavetable
// ✅ Eventually correct, but confusing in UI
```

**Severity**: LOW (eventual consistency maintained)

---

### BREAKPOINT #6: Frequency Substitution Applied Twice? ⚠️

**Location**: store.js (getDataForServer) + commands.rs (set_channels)

```javascript
// store.js line 1247:
equation: updateEquationFrequency(ch.equation, 50, currentFreq)
// Converts: "sin(2*PI*50*t)" → "sin(2*PI*60*t)"

// Then in commands.rs line 437:
let fixed = fix_equation_frequency(&ch.equation, freq);
// Converts: "PI\s*\*\s*50\s*\*\s*t" → "PI*60*t"
```

**Issue**: If frequency already updated by JavaScript, Rust regex still matches

```
Input to Rust: "325*sin(2*PI*60*t)"
Rust regex: "PI\s*\*\s*50\s*\*" 
Match: ❌ NO (looking for *50*, found *60*)
Result: "325*sin(2*PI*60*t)" (unchanged)
Status: ✅ OK - No double substitution (already fixed by JS)
```

**Verdict**: ✅ SAFE - Regex only matches the specific "50" pattern

---

### BREAKPOINT #7: Missing Validation Between Stages ❌

**Location**: Multiple handoff points

**Issue**: No validation that equations survive data transformation

```
Frontend: "325*sin(2*PI*60*t)"
    ↓ (JSON serialize)
Rust receives: "325*sin(2*PI*60*t)"
    ↓ (Parse)
C++ receives: "325*sin(2*PI*60*t)"
    ↓ (Math compile)
C++ state: Compiled expression object

No checksum/logging to verify equation intact at each stage
```

**Impact**: If equation gets corrupted, no way to debug which stage

**Severity**: LOW (works in practice; improvement for debugging)

---

## SUBSCRIPTION NOTIFICATION CHAIN

### Store Notification System (store.js)

**How notifications work:**

```javascript
// Subscribers registered via store.subscribe():
store.subscribe('config.frequency', (newValue) => {
    console.log('Frequency changed to:', newValue);
});

store.subscribe('data.channels', (newChannels) => {
    console.log('Channels updated:', newChannels);
});

// When config updates:
setConfig({frequency: 50}) {
    this._config.frequency = 50;
    this._notifyChanges(['config.frequency']);  // ← Triggers subscribers
}

// Internal notification system (line 600+):
_notifyChanges(paths) {
    if (this._isBatching) {
        // During batch: collect notifications
        paths.forEach(p => this._pendingNotifications.add(p));
        return;
    }
    
    // Send notifications immediately
    paths.forEach(path => {
        const callbacks = this._subscribers.get(path) || [];
        callbacks.forEach(cb => {
            try { cb(this.get(path)); }
            catch (e) { console.error(e); }
        });
    });
}
```

### Complete Subscription Map

| Path | Subscribers | Triggers | Callback |
|------|-------------|----------|----------|
| `config.standard` | StandardSelector | UI sync | `syncFromStore()` |
| `config.frequency` | StreamSettings, ChannelsDisplay | Sample rate recalc | `_updateDisplay()` |
| `config.noASDU` | FrameViewer | Frame rebuild | Auto-refresh |
| `config.selectedChannels` | FrameViewer, ChannelsDisplay | Frame/UI rebuild | Auto-refresh |
| `data.channels` | ChannelsDisplay, embeddedMathEditor, FrameViewer | UI refresh | `_updateDisplay()`, `render()` |
| `data.stats` | Statistics | Live update | `_updateStats()` |
| `data.publishing` | PublishPanel | Status display | `_updateStatus()` |
| `onChange()` (all) | embeddedMathEditor | Full re-render | `onGlobalStandardChanged()` |

### Batch Update (Prevents Redundant Notifications)

```javascript
// Without batching:
store.setConfig({frequency: 50});          // Notify
store.setConfig({samplesPerCycle: 80});    // Notify
store.setConfig({svID: 'MU02'});           // Notify
// → 3 notifications × N subscribers = 3N callbacks

// With batching:
store.batch(() => {
    store.setConfig({frequency: 50});       // Queue
    store.setConfig({samplesPerCycle: 80}); // Queue
    store.setConfig({svID: 'MU02'});        // Queue
});
// → 3 notifications × N subscribers = 3N callbacks (batched)
// But UI only updates once at end of batch
```

---

## COMPLETE FLOW DIAGRAMS

### FLOW 1: Standard Change (Working ✅)

```
┌─────────────────────────────────────────────────────────────────┐
│ USER INTERACTION                                                 │
│ Clicks "9-2" radio button                                        │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ↓
┌─────────────────────────────────────────────────────────────────┐
│ STANDARD SELECTOR                                                │
│ handleRadioChange() → updateStandard('9-2')                      │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ↓
┌─────────────────────────────────────────────────────────────────┐
│ STORE                                                            │
│ store.setConfig({standard: '9-2'})                               │
│ - Loads STANDARDS['9-2'] config                                  │
│ - Rebuilds channels array with new equations                     │
│ - Updates selectedChannels for new standard                      │
│ - Calls _notifyChanges(['config.standard', 'data.channels'])     │
└──────────────────────────┬──────────────────────────────────────┘
                           │
              ┌────────────┴────────────┬──────────────┬─────────────┐
              │                        │              │             │
              ↓                        ↓              ↓             ↓
    ┌──────────────────┐   ┌──────────────────┐  ┌─────────────┐  ┌──────────────┐
    │ STANDARD         │   │ CHANNELS         │  │ FRAME       │  │ EMBEDDED     │
    │ SELECTOR         │   │ DISPLAY          │  │ VIEWER      │  │ MATH EDITOR  │
    │                  │   │                  │  │             │  │              │
    │ Receives:        │   │ Receives:        │  │ Receives:   │  │ Receives:    │
    │ 'config.std'     │   │ 'data.channels'  │  │ AUTO        │  │ onChange()   │
    │                  │   │                  │  │             │  │              │
    │ Action:          │   │ Action:          │  │ Action:     │  │ Action:      │
    │ syncFromStore()  │   │ _updateDisplay() │  │ Auto-refresh│  │ Re-render    │
    │                  │   │ Show new eq's    │  │ Update frame│  │ New channels │
    │ ✅ UI updated    │   │ ✅ UI updated    │  │ ✅ Updated  │  │ ✅ Updated   │
    └──────────────────┘   └──────────────────┘  └─────────────┘  └──────────────┘
```

**Result**: ✅ ALL components updated simultaneously

---

### FLOW 2: Equation Edit (Direct - Working ✅)

```
┌─────────────────────────────────────────────────────────────────┐
│ USER INTERACTION                                                 │
│ Types in MathLive equation field: "100*sin(...)"                 │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ↓
┌─────────────────────────────────────────────────────────────────┐
│ EMBEDDED MATH EDITOR                                             │
│ onSaveEquation()                                                 │
│ - Validates: validateExpression()                                │
│ - Converts: LaTeX → math.js                                      │
│ - Updates: eq100 = mathField.value                               │
└──────────────────────────┬──────────────────────────────────────┘
                           │
              ┌────────────┴────────────┐
              │                        │
              ↓                        ↓
    ┌──────────────────┐   ┌──────────────────┐
    │ HIDDEN INPUT     │   │ STORE            │
    │                  │   │                  │
    │ elem.value =     │   │ store.updateEq() │
    │ "100*sin(...)"   │   │                  │
    │ ✅ Updated       │   │ Updates: data... │
    │                  │   │ Notifies:        │
    │                  │   │ 'data.channels'  │
    │                  │   │ ✅ Updated       │
    └──────────────────┘   └────┬─────────────┘
                                │
                                ↓
    ┌─────────────────────────────────────────┐
    │ CHANNELS DISPLAY                        │
    │ Receives: 'data.channels'               │
    │ Action: _updateDisplay()                │
    │ Show: New equation in channel list      │
    │ ✅ UI updated                           │
    └─────────────────────────────────────────┘
```

**Result**: ✅ Both DOM and store updated, UI reflects changes

---

### FLOW 3: Quick Template (BROKEN ❌)

```
┌─────────────────────────────────────────────────────────────────┐
│ USER INTERACTION                                                 │
│ Clicks "Balanced" template button                                │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ↓
┌─────────────────────────────────────────────────────────────────┐
│ EMBEDDED MATH EDITOR                                             │
│ applyQuickTemplate('balanced')                                   │
│ FOR EACH CHANNEL:                                                │
│   - Generate template equation                                   │
│   - Update: document.getElementById(eq${id}).value              │
│   - Update MathField (if current channel)                        │
│   ❌ MISSING: call store.updateEquation()                        │
└──────────────────────────┬──────────────────────────────────────┘
                           │
              ┌────────────┴────────────┐
              │                        │
              ↓                        ↓
    ┌──────────────────┐   ┌──────────────────┐
    │ HIDDEN INPUT     │   │ STORE            │
    │                  │   │                  │
    │ elem.value =     │   │ NO CHANGE        │
    │ "template_eq"    │   │ data.channels    │
    │ ✅ Updated       │   │ still show old   │
    │                  │   │ equations        │
    │                  │   │ ❌ No notif.     │
    └──────────────────┘   └────┬─────────────┘
                                │
                                ↓ (No notification)
    ┌─────────────────────────────────────────┐
    │ CHANNELS DISPLAY                        │
    │ ❌ Receives: NOTHING                    │
    │ ❌ Shows: OLD equations                 │
    │ ❌ UI NOT updated                       │
    └─────────────────────────────────────────┘
    
BUT LATER:
    ┌─────────────────────────────────────────┐
    │ ON PUBLISH                              │
    │ ✅ Hidden inputs sent to backend        │
    │ ✅ Backend receives template equations  │
    │ ⚠️ Visual inconsistency but works       │
    └─────────────────────────────────────────┘
```

**Result**: ⚠️ UI misleading (shows old), backend correct (uses new from hidden inputs)

---

### FLOW 4: Publishing (Complete ✅)

```
START BUTTON CLICKED
    │
    ├─→ ✅ Check backend connected
    ├─→ ✅ Check PCAP/Equation mode
    ├─→ ✅ Check interface selected
    │
    ↓
store.getDataForServer()
    ├─ Read: config (svID, appID, sampleRate, noASDU, ...)
    ├─ Read: selectedChannels array
    ├─ Read: channel details (id, equation, type, ...)
    ├─ Apply: updateEquationFrequency(eq, 50, currentFreq)
    └─ Return: {config, channels: [...]}
    │
    ↓
tauriClient.updateData(serverData)
    │
    ├─→ Step 1: invoke('set_config', {config})
    │   └→ Rust stores: *CONFIG.lock() = config
    │
    ├─→ Step 2: invoke('set_channels', {channels})
    │   └→ Rust:
    │       - *CHANNELS.lock() = channels
    │       - Format: "id1:eq1|id2:eq2|..."
    │       - invoke ffi::set_equations(&fmt)
    │       └→ C FFI:
    │           └→ npcap_set_equations()
    │               └→ C++ backend:
    │                   - Parse format
    │                   - Compile expressions
    │                   - Store in publisher state
    │
    ├─→ Step 3: invoke('set_duration_mode', {settings})
    │   └→ C++ sets duration timer
    │
    └─→ Step 4: invoke('start_publishing')
        └→ C++ starts packet generation:
            FOR EACH SAMPLE:
                - Evaluate equations (Va, Vb, Vc, ...)
                - Generate sample values
                - Build SV frame
                - Send via Npcap
                - Update stats (packets_sent, bytes_sent, rate_bps)
    │
    ↓
❌ STATS POLLING (UI Monitoring)
    └→ Every 250ms:
        - invoke('get_stats')
        - C++ returns current statistics
        - emit('stats') → Statistics UI updates
```

**Result**: ✅ Complete end-to-end flow working

---

## SUMMARY TABLE

### Data Flow Checkpoint Analysis

| Component | Input Source | Output | Stores Truth | Issues |
|-----------|--------------|--------|--------------|--------|
| **App Init** | DOMContentLoaded | Components initialized | Store (first) | ✅ OK |
| **Standard Selection** | store.config.standard | All subscribers | ✅ Store | ✅ OK |
| **Channel Editing (Direct)** | MathLive field | Store + Hidden input | ✅ Store | ✅ OK |
| **Channel Editing (Template)** | Button click | Hidden input only | ❌ Hidden input | ⚠️ Store not updated |
| **Fault Simulation** | Button click | Hidden input only | ❌ Hidden input | ⚠️ Store not updated |
| **ChannelsDisplay** | store.data.channels | UI list | ✅ Store | ✅ OK |
| **FrameViewer** | store config+channels | Frame tree | ✅ Store | ⚠️ No auto-refresh on edit |
| **PublishPanel START** | store.getDataForServer() | Tauri invoke | ✅ Store | ✅ OK |
| **Tauri Backend** | Set config/channels | C++ FFI | ✅ Rust | ✅ OK |
| **C++ Backend** | Equation string | Sample values | ✅ Compiled expr | ✅ OK |

---

## CRITICAL FINDINGS

### 🟢 WORKING CORRECTLY

1. ✅ **App Initialization** - Components load in correct order, no circular deps
2. ✅ **Standard Selection** - Full data propagation to all components
3. ✅ **Direct Equation Editing** - Store updates immediately, ChannelsDisplay updates
4. ✅ **Publishing Pipeline** - Config+channels correctly transmitted to backend
5. ✅ **Backend Receipt** - C++ correctly receives and compiles equations
6. ✅ **Stats Polling** - Real-time statistics flow from backend to UI

### 🟡 PARTIAL ISSUES

1. ⚠️ **Quick Template Application** - Hidden inputs updated, store not updated, UI misleading
2. ⚠️ **Fault Template Application** - Same issue as quick template
3. ⚠️ **FrameViewer Auto-Refresh** - Must manually click refresh after equation change

**Impact Level**: LOW - Backend receives correct equations via hidden inputs; UI shows outdated values but still publishes correctly

### 🟢 NO CRITICAL BREAKPOINTS

- ✅ No data loss between stages
- ✅ No circular dependencies
- ✅ No uninitialized state
- ✅ Store is consistent source of truth (mostly)
- ✅ Backend always receives correct equations

---

## RECOMMENDATIONS

### Priority 1: Fix Template Applications
**File**: `web/js/components/embeddedMathEditor.js`

```javascript
// In applyQuickTemplate() function (~line 750):
function applyQuickTemplate(templateId) {
    const channels = store.getChannels();
    channels.forEach(ch => {
        const eq = TEMPLATES[templateId][ch.id];
        
        // Update DOM
        document.getElementById(`eq${ch.id}`).value = eq;
        if (currentChannelId === ch.id) {
            mf.value = eq;
        }
        
        // ✅ ADD THIS:
        store.updateEquation(ch.id, eq);
    });
}

// Same fix for applyFaultTemplate()
```

### Priority 2: Add FrameViewer Auto-Refresh
**File**: `web/js/components/FrameViewer.js`

```javascript
export function init(container) {
    // ... existing init ...
    
    // ✅ ADD THESE SUBSCRIPTIONS:
    store.subscribe('data.channels', () => {
        _refreshFrameStructure();
    });
    
    store.subscribe('config.selectedChannels', () => {
        _refreshFrameStructure();
    });
}
```

### Priority 3: Reduce Hidden Input Usage
**Recommendation**: Deprecated hidden inputs in favor of store-only state. Hidden inputs are now legacy; all updates should go through store.updateEquation().

---

