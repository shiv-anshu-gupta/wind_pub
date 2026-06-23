/**
 * @file components/index.js
 * @fileoverview Central Export Module for All UI Components
 * @module components
 * @author SV-PUB Team
 * @copyright 2025 SV Publisher
 * @license Proprietary
 * @version 1.0.0
 * 
 * @description
 * This module serves as the central hub for all UI components in the SV Publisher
 * application. Each component is self-contained and follows a consistent pattern.
 * 
 * **Component Architecture:**
 * 
 * Each component follows this pattern:
 * - `getTemplate()` - Returns HTML string
 * - `init(container)` - Initializes component in container
 * - DOM Element Cache - Cached references to elements
 * - Event Handlers - User interaction handlers
 * - Store Sync - Subscribe to store changes
 * 
 * **Three-Column Layout:**
 * 
 * | Column | Components |
 * |--------|------------|
 * | Left | DataSource, ChannelsDisplay, StandardSelector, StreamSettings |
 * | Middle | FrameViewer |
 * | Right | PublishPanel, Statistics, WiresharkHelper, Preview |
 * 
 * **Component Reference:**
 * 
 * | Component | Purpose | Store Path |
 * |-----------|---------|------------|
 * | StandardSelector | IEC standard selection | config.standard |
 * | StreamSettings | Frequency, interface, sampling | config.frequency, config.interface |
 * | DataSource | PCAP/Equation input | data.pcap, data.channels |
 * | ChannelsDisplay | Active channel list | data.channels |
 * | FrameViewer | SV frame structure | config.standardConfig |
 * | PublishPanel | Start/Stop controls | data.publishing |
 * | Statistics | Real-time stats | data.stats |
 * | WiresharkHelper | Capture filter help | config.srcMAC |
 * | Preview | Packet preview | config.*, data.channels |
 * 
 * **Component Lifecycle:**
 * 1. Import component from this module
 * 2. Call `Component.init(containerElement)`
 * 3. Component renders and subscribes to store
 * 4. User interactions update store
 * 5. Store notifies component, component re-renders
 * 
 * **Security:**
 * - All components sanitize user input
 * - Templates use validated data only
 * - Event handlers validate before processing
 * - Store updates are validated
 * 
 * @example <caption>Import Individual Components</caption>
 * import { StandardSelector, StreamSettings } from './components/index.js';
 * 
 * StandardSelector.init(document.getElementById('standard-container'));
 * 
 * @example <caption>Access Component Methods</caption>
 * import { Statistics } from './components/index.js';
 * 
 * // Components expose public methods
 * Statistics.updateStats({ packetsSent: 1000 });
 * 
 * @see {@link module:store} for state management
 * @see {@link module:app} for initialization sequence
 */

// ============================================================================
// STEP 1: Standard Selector (IEC 61850-9-2 LE, 9-2, 61869)
// ============================================================================

/**
 * @typedef {Object} StandardSelectorComponent
 * @property {Function} init - Initialize the component
 * @property {Function} getTemplate - Get HTML template
 */
import StandardSelector from './StandardSelector.js';
export { StandardSelector };

// ============================================================================
// STEP 2: Stream Settings (Interface, Frequency, Samples/Cycle, Sample Rate)
// Handles publishing & timing parameters NOT in frame structure
// ============================================================================
import StreamSettings from './StreamSettings.js';
export { StreamSettings };

// ============================================================================
// LEGACY: Keep for backwards compatibility (deprecated)
// ============================================================================
import NetworkSettings from './NetworkSettings.js';
export { NetworkSettings };
import SVParameters from './SVParameters.js';
export { SVParameters };

// ============================================================================
// STEP 4: Data Source (PCAP upload + Equation Editor tabs)
// ============================================================================
import DataSource from './DataSource.js';
export { DataSource };

// (Single-mode PublishPanel + PublishMode toggle were removed — the multi-publisher
// flow (MultiPublisher.js) is the only publishing path. To publish one stream,
// add one publisher.)

// ============================================================================
// STEP 6: Statistics - Real-time Network Statistics Display
// ============================================================================
import Statistics from './Statistics.js';
export { Statistics };

// ============================================================================
// STEP 7: Wireshark Helper (Filter + Steps)
// ============================================================================
import WiresharkHelper from './WiresharkHelper.js';
export { WiresharkHelper };

// ============================================================================
// STEP 8: Packet Preview
// ============================================================================
import Preview from './preview.js';
export { Preview };
export { updatePreview, updatePreviewSmpCnt } from './preview.js';

// ============================================================================
// STEP 9: Frame Viewer (Full SV Frame Structure)
// ============================================================================
import FrameViewer from './FrameViewer.js';
export { FrameViewer };

// ============================================================================
// Channels Display (Left Column - Active Channels List)
// ============================================================================
import ChannelsDisplay from './ChannelsDisplay.js';
export { ChannelsDisplay };

// ============================================================================
// Multi-Publisher (Right Column - Multiple SV Streams)
// ============================================================================
import MultiPublisher from './MultiPublisher.js';
export { MultiPublisher };

// ============================================================================
// Fault Injection (Right Column - Subscriber Stress Testing)
// ============================================================================
import FaultInjectionPanel from './FaultInjectionPanel.js';
export { FaultInjectionPanel };

// ============================================================================
// EQUATION EDITOR (MathLive-based, wired to the Equation tab in DataSource)
// ============================================================================
export { initEmbeddedMathEditor, isMathLiveReady, getAllEquations } from './embeddedMathEditor.js';

// ============================================================================
// CONVENIENCE: Initialize All Main Components
// ============================================================================
export function initAllComponents(containers = {}) {
    // Left column
    DataSource.init(containers.dataSource || document.getElementById('data-source-container'));
    ChannelsDisplay.init(containers.channels || document.getElementById('channels-display-container'));
    StandardSelector.init(containers.standard || document.getElementById('standard-selector-container'));
    StreamSettings.init(containers.stream || document.getElementById('stream-settings-container'));
    
    // Middle column
    FrameViewer.init(containers.frameViewer || document.getElementById('frame-viewer-container'));
    
    // Right column
    MultiPublisher.init(containers.multiPublisher || document.getElementById('multi-publisher-container'));
    Statistics.init(containers.statistics || document.getElementById('statistics-container'));
    WiresharkHelper.init(containers.wireshark || document.getElementById('wireshark-container'));
    Preview.init(containers.preview || document.getElementById('preview-container'));
    FaultInjectionPanel.init(containers.faultInjection || document.getElementById('fault-injection-container'));
    
    console.log('[Components] All main components initialized');
}

// ============================================================================
// DEFAULT EXPORT
// ============================================================================
export default {
    StandardSelector,
    StreamSettings,
    NetworkSettings,  // Legacy
    SVParameters,     // Legacy
    DataSource,
    MultiPublisher,
    Statistics,
    WiresharkHelper,
    Preview,
    FrameViewer,
    ChannelsDisplay,
    FaultInjectionPanel,
    initAllComponents
};
