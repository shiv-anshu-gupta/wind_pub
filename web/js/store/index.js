/**
 * @file store/index.js
 * @fileoverview Centralized State Management System (Redux-like Store)
 * @module store
 * @author SV-PUB Team
 * @copyright 2025 SV Publisher
 * @license Proprietary
 * @version 1.0.0
 * 
 * @description
 * This module implements a Redux/MobX-inspired centralized state management system
 * that serves as the **Single Source of Truth** for the entire SV Publisher application.
 * All UI components subscribe to this store and automatically update when state changes.
 * 
 * **Store Architecture:**
 * 
 *     +------------------+
 *     |   Store Object   |
 *     +------------------+
 *     | config: {}       |  --> Settings (user configuration)
 *     | data: {}         |  --> Runtime (channels, stats, publishing)
 *     | subscribers: Map |  --> Path-based callbacks
 *     +------------------+
 *            |
 *            v
 *     Components subscribe to paths and receive updates
 * 
 * **State Structure:**
 * 
 * | State | Property | Type | Description |
 * |-------|----------|------|-------------|
 * | config | standard | string | IEC standard ID ('9-2LE', '9-2', '61869') |
 * | config | standardConfig | Object | Full standard configuration |
 * | config | frequency | number | System frequency (50/60 Hz) |
 * | config | samplesPerCycle | number | Samples per power cycle |
 * | config | sampleRate | number | Computed: samplesPerCycle × frequency |
 * | config | noASDU | number | ASDUs per Ethernet frame |
 * | config | srcMAC | string | Source MAC address |
 * | config | dstMAC | string | Destination MAC address |
 * | config | svID | string | SV identifier |
 * | config | appID | number | Application ID |
 * | data | channels | Array | Active channel configurations |
 * | data | pcap | Object | PCAP file state |
 * | data | publishing | Object | Publishing state |
 * | data | stats | Object | Runtime statistics |
 * | data | connection | Object | Backend connection state |
 * 
 * **Data Flow:**
 * 1. User interacts with Component
 * 2. Component calls store.setConfig({key: value})
 * 3. Store validates and updates state
 * 4. Store notifies all subscribers for changed paths
 * 5. Subscriber callbacks re-render UI
 * 
 * **Security:**
 * - All input values validated before storage
 * - Channel equations are parsed, not eval'd
 * - MAC addresses are format-validated
 * - Numeric values have range checks
 * 
 * @requires shared/standards.js - IEC standard definitions
 * 
 * @example <caption>Basic Usage</caption>
 * import store from './store/index.js';
 * 
 * // Get current value
 * const freq = store.get('config.frequency'); // 60
 * 
 * // Update configuration
 * store.setConfig({ frequency: 50 });
 * 
 * // Subscribe to changes
 * const unsubscribe = store.subscribe('config.frequency', (newValue) => {
 *     console.log('Frequency changed to:', newValue);
 * });
 * 
 * @example <caption>Batch Updates</caption>
 * // Multiple updates in single notification
 * store.batch(() => {
 *     store.setConfig({ frequency: 50 });
 *     store.setConfig({ samplesPerCycle: 80 });
 * });
 * 
 * @example <caption>Channel Management</caption>
 * // Get all channels
 * const channels = store.data.channels;
 * 
 * // Update channel equation
 * store.updateChannelEquation('Va', '325 * sin(2 * PI * 50 * t)');
 * 
 * @see {@link module:components} for UI component integration
 */

import { STANDARDS, DEFAULT_EQUATIONS, BASE_CHANNELS, ADDITIONAL_CHANNELS, getDefaultEquations, updateEquationFrequency } from '../../shared/standards.js';

/**
 * Send a log line to the Rust process so it surfaces in the user's
 * terminal (visible alongside `eprintln!` from commands.rs). This is the
 * only reliable way to confirm data flow when devtools is locked down.
 */
function _termLog(message) {
    /* Debug-log is now a console.log only — backend no longer routes
     * a 'debug_log' command (was a Tauri-IPC artifact). */
    try { console.log('[store]', message); } catch {}
}

// ============================================================================
// INITIAL STATE CONFIGURATION
// ============================================================================

/**
 * Initial configuration state
 * @type {Object}
 * @property {string} standard - Selected IEC standard identifier
 * @property {Object} standardConfig - Full standard configuration from STANDARDS
 * @property {number} frequency - System frequency in Hz (50 or 60)
 * @property {number} samplesPerCycle - Number of samples per power cycle
 * @property {number} sampleRate - Computed sample rate (samplesPerCycle × frequency)
 * @property {number} noASDU - Number of ASDUs per Ethernet frame
 * @property {string} srcMAC - Source MAC address (XX:XX:XX:XX:XX:XX format)
 * @property {string} dstMAC - Destination MAC address (multicast for SV)
 * @property {number} vlanID - VLAN identifier (0 = no VLAN)
 * @property {number} vlanPriority - IEEE 802.1Q priority (0-7)
 * @property {number} interfaceIndex - Selected network interface index
 * @property {string} interfaceName - Selected network interface name
 * @property {string} svID - Sampled Values identifier (1-65 chars)
 * @property {number} appID - Application ID (0x0000-0x3FFF)
 * @property {number} confRev - Configuration revision number
 * @property {number} smpSynch - Sample synchronization flag (0=none, 1=local, 2=global)
 * @property {Array<string>} selectedChannels - Ordered list of channel IDs for ASDU
 * @constant
 */
const initialConfig = {
    // Standard Selection
    standard: '9-2LE',
    standardConfig: STANDARDS['9-2LE'],
    
    // Frequency & Sampling
    frequency: 60,
    samplesPerCycle: 80,
    sampleRate: 4800,  // Computed: samplesPerCycle × frequency
    
    // ASDU Configuration
    noASDU: 1,  // Number of ASDUs per frame (1 = production standard)
    
    // Network Settings
    srcMAC: '00:00:00:00:00:01',
    dstMAC: '01:0C:CD:04:00:00',
    vlanID: 0,
    vlanPriority: 4,
    interfaceIndex: 0,
    interfaceName: '',
    
    // SV Parameters
    svID: 'MU01',
    appID: 0x4000,
    confRev: 1,
    smpSynch: 2,
    
    // Selected Channels for ASDU (order matters!)
    // This is the SINGLE SOURCE OF TRUTH for which channels appear in seqData
    selectedChannels: ['Ia', 'Ib', 'Ic', 'In', 'Va', 'Vb', 'Vc', 'Vn'],

    // Multi-publisher list. MultiPublisher.js owns the working copy
    // but mirrors every mutation here so the rest of the app can react
    // to publisher add/remove/edit without reaching into a sibling module.
    // Each entry: { localId, svId, appId, confRev, smpSynch, selectedChannels:[ids] }
    publishers: [],

    // Fault-injection config. FaultInjectionPanel.js mirrors its UI state
    // here so the backend can be re-applied after reconfigure/restart
    // without losing the user's settings. Shape mirrors the JSON sent to
    // the Rust backend (see FaultInjectionPanel.buildConfigJson).
    faultInjection: null,
};

/**
 * Build initial channels array from BASE_CHANNELS and DEFAULT_EQUATIONS
 * @param {string} standardId - Standard ID to get channel order
 * @param {number} frequency - System frequency (50 or 60 Hz)
 * @returns {Array} Array of channel objects
 */
function buildInitialChannels(standardId = '9-2LE', frequency = 60) {
    const standardConfig = STANDARDS[standardId];
    const channelOrder = standardConfig?.channelOrder || ['Va', 'Vb', 'Vc', 'Vn', 'Ia', 'Ib', 'Ic', 'In'];
    const equations = getDefaultEquations(frequency);
    
    return channelOrder.map(id => {
        const base = BASE_CHANNELS.find(c => c.id === id);
        return {
            id,
            label: base?.label || id,
            type: base?.type || 'custom',
            phase: base?.phase || null,
            unit: base?.unit || '',
            equation: equations[id] || '0',
            isBase: true,
            description: `Base ${base?.type || 'channel'} ${id}`
        };
    });
}

/**
 * Initial UI state — ephemeral, not persisted, not sent to backend.
 * Tracks cross-component view state like which MU card is currently
 * being inspected in Frame Structure.
 */
const initialUi = {
    activeMu: null,        // null or { localId, svId, appId, confRev, smpSynch, channelCount }
};

const initialData = {
    // UNIFIED CHANNELS ARRAY - Single source of truth for all channels
    // Contains both base channels and custom channels
    channels: buildInitialChannels('9-2LE', initialConfig.frequency),
    
    // PCAP State
    pcap: {
        loaded: false,
        filename: '',
        frameCount: 0,
        duration: 0,
    },
    
    // Publishing State
    publishing: {
        isRunning: false,
        mode: 'equation',  // 'equation' | 'pcap'
    },
    
    // Stats
    stats: {
        packetsSent: 0,
        currentRate: 0,
        errors: 0,
        uptime: 0,
        smpCnt: 0,
    },
    
    // Connection State
    connection: {
        isConnected: false,
        reconnectAttempts: 0,
    },
};

// ============================================================================
// STORE CLASS
// ============================================================================

class Store {
    constructor() {
        // Deep clone initial state
        this._config = JSON.parse(JSON.stringify(initialConfig));
        this._data = {
            ...JSON.parse(JSON.stringify(initialData)),
            // Rebuild channels fresh (can't deep clone functions)
            channels: buildInitialChannels(this._config.standard, this._config.frequency)
        };
        this._ui = JSON.parse(JSON.stringify(initialUi));
        
        // Subscribers: Map of path -> Set of callbacks
        this._subscribers = new Map();
        
        // DOM bindings: Map of stateKey -> DOM element config
        this._domBindings = new Map();
        
        // Batch update flag
        this._isBatching = false;
        this._pendingNotifications = new Set();
        
        console.log('[Store] Initialized with:', { 
            config: this._config, 
            channelCount: this._data.channels.length,
            channels: this._data.channels.map(c => c.id)
        });
    }

    // ========================================================================
    // GETTERS
    // ========================================================================

    get config() {
        return this._config;
    }

    get data() {
        return this._data;
    }

    get ui() {
        return this._ui;
    }

    /**
     * Get a nested value by path
     * @param {string} path - Dot-separated path like 'config.frequency', 'data.stats.packetsSent', or 'ui.activeMu'
     */
    get(path) {
        const parts = path.split('.');
        let value;
        if (parts[0] === 'config') value = this._config;
        else if (parts[0] === 'data') value = this._data;
        else if (parts[0] === 'ui') value = this._ui;
        else return undefined;

        for (let i = 1; i < parts.length; i++) {
            if (value === undefined || value === null) return undefined;
            value = value[parts[i]];
        }
        return value;
    }

    // ========================================================================
    // SETTERS
    // ========================================================================

    /**
     * Update config values
     * @param {Object} updates - Partial config object
     */
    setConfig(updates) {
        // 🔍 DEBUG: Log what's being updated
        console.log('[Store.setConfig] Called with:', updates);
        
        // Capture old frequency before update (for equation sync)
        const oldFrequency = this._config.frequency;
        
        const changed = [];
        
        for (const [key, value] of Object.entries(updates)) {
            console.log(`[Store.setConfig] Checking key="${key}", old=${this._config[key]}, new=${value}`);
            if (this._config[key] !== value) {
                this._config[key] = value;
                changed.push(`config.${key}`);
                console.log(`[Store.setConfig] ✅ Updated ${key} to ${value}`);
            } else {
                console.log(`[Store.setConfig] ⏭️ Skipped ${key} (same value)`);
            }
        }
        
        // 🔍 DEBUG: Verify after update
        if (updates.noASDU !== undefined) {
            console.log(`[Store.setConfig] After update, this._config.noASDU = ${this._config.noASDU}`);
        }
        
        // Auto-compute sample rate if frequency or samplesPerCycle changed
        if (updates.frequency !== undefined || updates.samplesPerCycle !== undefined) {
            const newRate = this._config.samplesPerCycle * this._config.frequency;
            console.log(`[Store.setConfig] 📊 Auto-compute sampleRate: ${this._config.samplesPerCycle} × ${this._config.frequency} = ${newRate} (was ${this._config.sampleRate})`);
            if (this._config.sampleRate !== newRate) {
                this._config.sampleRate = newRate;
                changed.push('config.sampleRate');
            }
        }
        
        // Auto-update base channel equations when frequency changes
        if (updates.frequency !== undefined && changed.includes('config.frequency')) {
            this._updateBaseEquationsForFrequency(updates.frequency, oldFrequency);
            changed.push('data.channels');
        }
        
        // Notify subscribers
        this._notifyChanges(changed);
        
        return changed;
    }

    /**
     * Update data values (can use dot notation for nested)
     * @param {Object} updates - Partial data object or nested updates
     */
    setData(updates) {
        const changed = [];
        
        for (const [key, value] of Object.entries(updates)) {
            if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
                // Nested update (e.g., stats: { packetsSent: 100 })
                if (!this._data[key]) this._data[key] = {};
                for (const [subKey, subValue] of Object.entries(value)) {
                    if (this._data[key][subKey] !== subValue) {
                        this._data[key][subKey] = subValue;
                        changed.push(`data.${key}.${subKey}`);
                    }
                }
            } else {
                if (this._data[key] !== value) {
                    this._data[key] = value;
                    changed.push(`data.${key}`);
                }
            }
        }
        
        this._notifyChanges(changed);
        return changed;
    }

    /**
     * Update UI state values (ephemeral, not persisted).
     * For object values like `activeMu`, the comparison is reference-only —
     * any new object triggers a notification so subscribers re-render.
     * @param {Object} updates - Partial ui object
     */
    setUi(updates) {
        const changed = [];
        for (const [key, value] of Object.entries(updates)) {
            if (this._ui[key] !== value) {
                this._ui[key] = value;
                changed.push(`ui.${key}`);
            }
        }
        this._notifyChanges(changed);
        return changed;
    }

    /**
     * Set a single value by path
     * @param {string} path - Dot-separated path
     * @param {*} value - New value
     */
    set(path, value) {
        const parts = path.split('.');
        const root = parts[0];

        if (root === 'config') {
            if (parts.length === 2) {
                return this.setConfig({ [parts[1]]: value });
            }
        } else if (root === 'data') {
            if (parts.length === 2) {
                return this.setData({ [parts[1]]: value });
            } else if (parts.length === 3) {
                return this.setData({ [parts[1]]: { [parts[2]]: value } });
            }
        } else if (root === 'ui') {
            if (parts.length === 2) {
                return this.setUi({ [parts[1]]: value });
            }
        }

        return [];
    }

    // ========================================================================
    // STANDARD MANAGEMENT
    // ========================================================================

    /**
     * Set the IEC standard (updates standardConfig and rebuilds channels)
     */
    setStandard(standardId) {
        const config = STANDARDS[standardId];
        if (!config) {
            console.warn('[Store] Invalid standard:', standardId);
            return false;
        }
        
        const previous = this._config.standard;
        if (previous === standardId) {
            return false;
        }
        
        // Batch updates
        this.batch(() => {
            this.setConfig({
                standard: standardId,
                standardConfig: config,
                samplesPerCycle: config.defaultSamplesPerCycle || 80,
            });
            
            // Rebuild channels for new standard
            this._rebuildChannelsForStandard(standardId, config);
        });
        
        console.log(`[Store] Standard changed: ${previous} → ${standardId}`);
        return true;
    }

    /**
     * Rebuild channels array when standard changes
     * Preserves custom channels if allowed, otherwise resets to base only
     * @param {string} standardId 
     * @param {Object} standardConfig 
     */
    _rebuildChannelsForStandard(standardId, standardConfig) {
        const channelOrder = standardConfig.channelOrder || ['Va', 'Vb', 'Vc', 'Vn', 'Ia', 'Ib', 'Ic', 'In'];
        const oldChannels = this._data.channels;
        const equations = getDefaultEquations(this._config.frequency);
        
        // Build new base channels with correct order
        const newChannels = channelOrder.map(id => {
            const base = BASE_CHANNELS.find(c => c.id === id);
            // Try to preserve existing equation if channel existed before
            const existing = oldChannels.find(c => c.id === id);
            return {
                id,
                label: base?.label || id,
                type: base?.type || 'custom',
                phase: base?.phase || null,
                unit: base?.unit || '',
                equation: existing?.equation || equations[id] || '0',
                isBase: true,
                description: `Base ${base?.type || 'channel'} ${id}`
            };
        });
        
        // If custom channels allowed, preserve existing custom channels
        if (standardConfig.allowCustomChannels) {
            const customChannels = oldChannels.filter(c => !c.isBase);
            const maxChannels = standardConfig.maxChannels;
            const availableSlots = maxChannels - newChannels.length;
            
            // Add custom channels up to the limit
            customChannels.slice(0, availableSlots).forEach(ch => {
                newChannels.push({ ...ch });
            });
            
            if (customChannels.length > availableSlots) {
                console.warn(`[Store] Removed ${customChannels.length - availableSlots} custom channels (exceeded max ${maxChannels})`);
            }
        }
        
        this._data.channels = newChannels;
        
        // Sync selectedChannels with the new channel list
        // Keep only channels that still exist, preserve order
        const newIds = new Set(newChannels.map(c => c.id));
        const oldSelected = this._config.selectedChannels || [];
        const keptSelected = oldSelected.filter(id => newIds.has(id));
        
        // Add any new base channels that weren't previously selected
        const baseIds = (standardConfig.channelOrder || []);
        baseIds.forEach(id => {
            if (!keptSelected.includes(id) && newIds.has(id)) {
                keptSelected.push(id);
            }
        });
        
        this._config.selectedChannels = keptSelected;
        this._notifyChanges(['data.channels', 'config.selectedChannels']);
        console.log(`[Store] Rebuilt channels for ${standardId}: ${newChannels.map(c => c.id).join(', ')}`);
        console.log(`[Store] Updated selectedChannels: ${keptSelected.join(', ')}`);
    }

    /**
     * Update base channel equations when system frequency changes.
     * Detects the old frequency in each base equation and replaces it with the new one.
     * Only modifies base channels (isBase === true) whose equations still follow
     * the standard sinusoidal pattern.
     * @param {number} newFreq - New system frequency
     * @param {number} oldFreq - Previous system frequency
     */
    _updateBaseEquationsForFrequency(newFreq, oldFreq) {
        if (oldFreq === newFreq) return;
        
        const newDefaults = getDefaultEquations(newFreq);
        let updated = 0;
        
        this._data.channels.forEach(ch => {
            if (ch.isBase) {
                // Base channels: try pattern replacement, then fall back to known defaults
                const updatedEq = updateEquationFrequency(ch.equation, oldFreq, newFreq);
                
                if (updatedEq && updatedEq !== ch.equation) {
                    ch.equation = updatedEq;
                    updated++;
                } else if (newDefaults[ch.id]) {
                    const oldDefault = getDefaultEquations(oldFreq)[ch.id];
                    if (ch.equation === oldDefault) {
                        ch.equation = newDefaults[ch.id];
                        updated++;
                    }
                }
            } else {
                // Custom channels: apply pattern replacement for explicit sinusoidal equations
                const updatedEq = updateEquationFrequency(ch.equation, oldFreq, newFreq);
                if (updatedEq && updatedEq !== ch.equation) {
                    ch.equation = updatedEq;
                    updated++;
                }
            }
        });
        
        if (updated > 0) {
            console.log(`[Store] Updated ${updated} base equations: ${oldFreq}Hz → ${newFreq}Hz`);
        }
    }

    /**
     * Set the number of ASDUs per frame (for testing/performance)
     * @param {number} noASDU - Number of ASDUs (1-16)
     */
    setNoASDU(noASDU) {
        const count = parseInt(noASDU, 10);
        if (isNaN(count) || count < 1 || count > 16) {
            console.warn('[Store] Invalid noASDU:', noASDU);
            return false;
        }
        
        // Check if current standard allows configurable ASDU
        const standardConfig = this._config.standardConfig;
        if (!standardConfig?.allowConfigurableASDU && count !== 1) {
            console.warn('[Store] Current standard does not allow configurable ASDU');
            return false;
        }
        
        this.setConfig({ noASDU: count });
        console.log(`[Store] noASDU set to: ${count}`);
        return true;
    }

    // ========================================================================
    // SUBSCRIPTION SYSTEM
    // ========================================================================

    /**
     * Subscribe to state changes
     * @param {string|string[]} paths - Path(s) to watch (e.g., 'config.frequency', 'data.stats')
     * @param {Function} callback - Called with (newValue, path) when state changes
     * @returns {Function} Unsubscribe function
     */
    subscribe(paths, callback) {
        const pathArray = Array.isArray(paths) ? paths : [paths];
        
        for (const path of pathArray) {
            if (!this._subscribers.has(path)) {
                this._subscribers.set(path, new Set());
            }
            this._subscribers.get(path).add(callback);
        }
        
        // Return unsubscribe function
        return () => {
            for (const path of pathArray) {
                this._subscribers.get(path)?.delete(callback);
            }
        };
    }

    /**
     * Subscribe to all changes in a root object
     * @param {'config'|'data'} root - Root object to watch
     * @param {Function} callback - Called with full object on any change
     */
    subscribeAll(root, callback) {
        return this.subscribe(`${root}.*`, callback);
    }

    /**
     * Notify subscribers of changes
     */
    _notifyChanges(changedPaths) {
        if (this._isBatching) {
            changedPaths.forEach(p => this._pendingNotifications.add(p));
            return;
        }
        
        // Diagnostic: log sampleRate-related notifications
        const samplePaths = changedPaths.filter(p => p.includes('sample') || p.includes('frequency'));
        if (samplePaths.length > 0) {
            console.log(`[Store._notifyChanges] 📊 Notifying ${samplePaths.join(', ')} → sampleRate=${this._config.sampleRate}`);
        }
        
        const notified = new Set();
        
        for (const path of changedPaths) {
            // Notify exact path subscribers
            this._subscribers.get(path)?.forEach(cb => {
                if (!notified.has(cb)) {
                    cb(this.get(path), path);
                    notified.add(cb);
                }
            });
            
            // Notify wildcard subscribers (e.g., 'config.*')
            const root = path.split('.')[0];
            this._subscribers.get(`${root}.*`)?.forEach(cb => {
                if (!notified.has(cb)) {
                    const rootObj = root === 'config' ? this._config
                                  : root === 'data'   ? this._data
                                  : root === 'ui'     ? this._ui
                                  : undefined;
                    cb(rootObj, path);
                    notified.add(cb);
                }
            });
        }
        
        // Update DOM bindings
        this._updateDOMBindings(changedPaths);
    }

    /**
     * Batch multiple updates into one notification
     */
    batch(updateFn) {
        this._isBatching = true;
        this._pendingNotifications.clear();
        
        try {
            updateFn();
        } finally {
            this._isBatching = false;
            if (this._pendingNotifications.size > 0) {
                this._notifyChanges([...this._pendingNotifications]);
                this._pendingNotifications.clear();
            }
        }
    }

    // ========================================================================
    // DOM BINDINGS (Two-way data binding)
    // ========================================================================

    /**
     * Bind a DOM element to a state path (auto-updates UI when state changes)
     * @param {string} elementId - DOM element ID
     * @param {string} path - State path
     * @param {Object} options - { transform, event, readonly }
     */
    bindElement(elementId, path, options = {}) {
        const element = document.getElementById(elementId);
        if (!element) {
            console.warn(`[Store] Element not found: ${elementId}`);
            return;
        }
        
        const { transform, event = 'change', readonly = false, format } = options;
        
        // Store binding config
        this._domBindings.set(path, {
            elementId,
            transform,
            format,
            readonly
        });
        
        // Set initial value
        this._updateElementValue(element, this.get(path), format);
        
        // Listen for user input (two-way binding)
        if (!readonly) {
            element.addEventListener(event, (e) => {
                let value = element.type === 'checkbox' ? element.checked : element.value;
                
                // Apply transform if provided
                if (transform) {
                    value = transform(value);
                } else if (element.type === 'number') {
                    value = parseFloat(value) || 0;
                }
                
                this.set(path, value);
            });
        }
        
        // Subscribe to state changes
        this.subscribe(path, (newValue) => {
            this._updateElementValue(element, newValue, format);
        });
    }

    /**
     * Update a DOM element's value
     */
    _updateElementValue(element, value, format) {
        const formatted = format ? format(value) : value;
        
        if (element.type === 'checkbox') {
            element.checked = !!formatted;
        } else if (element.tagName === 'SELECT') {
            element.value = formatted;
        } else if (element.tagName === 'SPAN' || element.tagName === 'DIV') {
            element.textContent = formatted;
        } else {
            element.value = formatted;
        }
    }

    /**
     * Update all DOM bindings for changed paths
     */
    _updateDOMBindings(changedPaths) {
        for (const path of changedPaths) {
            const binding = this._domBindings.get(path);
            if (binding) {
                const element = document.getElementById(binding.elementId);
                if (element) {
                    this._updateElementValue(element, this.get(path), binding.format);
                }
            }
        }
    }

    // ========================================================================
    // CHANNEL MANAGEMENT (Unified channels array)
    // ========================================================================

    /**
     * Get all current channels
     * @returns {Array} Array of channel objects { id, label, equation, isBase, ... }
     */
    getChannels() {
        return this._data.channels;
    }

    /**
     * Get base channels only
     * @returns {Array}
     */
    getBaseChannels() {
        return this._data.channels.filter(c => c.isBase);
    }

    /**
     * Get custom channels only
     * @returns {Array}
     */
    getCustomChannels() {
        return this._data.channels.filter(c => !c.isBase);
    }

    /**
     * Get a single channel by ID
     * @param {string} channelId 
     * @returns {Object|null}
     */
    getChannel(channelId) {
        return this._data.channels.find(c => c.id === channelId) || null;
    }

    // ========================================================================
    // SELECTED CHANNELS MANAGEMENT (For ASDU seqData)
    // ========================================================================

    /**
     * Get selected channels in order (for seqData)
     * @returns {Array<string>} Array of channel IDs in ASDU order
     */
    getSelectedChannels() {
        return this._config.selectedChannels || [];
    }

    /**
     * Get selected channels with full details
     * @returns {Array<Object>} Array of channel objects in ASDU order
     */
    getSelectedChannelsWithDetails() {
        const selected = this._config.selectedChannels || [];
        return selected
            .map(id => this._data.channels.find(ch => ch.id === id))
            .filter(ch => ch != null);
    }

    /**
     * Set selected channels (replaces entire array)
     * @param {Array<string>} channelIds - Array of channel IDs in desired order
     */
    setSelectedChannels(channelIds) {
        // Validate all channels exist
        const valid = channelIds.filter(id => 
            this._data.channels.find(ch => ch.id === id) != null
        );
        
        this.setConfig({ selectedChannels: valid });
        console.log(`[Store] Selected channels updated: ${valid.join(', ')}`);
    }

    /**
     * Add a channel to selected list (at end)
     * @param {string} channelId 
     * @returns {boolean} Success
     */
    addSelectedChannel(channelId) {
        const channel = this.getChannel(channelId);
        if (!channel) {
            console.warn(`[Store] Channel not found: ${channelId}`);
            return false;
        }
        
        const current = this._config.selectedChannels || [];
        if (current.includes(channelId)) {
            console.warn(`[Store] Channel already selected: ${channelId}`);
            return false;
        }
        
        // Check max channels for current standard
        const maxChannels = this._config.standardConfig?.maxChannels || 20;
        if (current.length >= maxChannels) {
            console.warn(`[Store] Max channels (${maxChannels}) reached`);
            return false;
        }
        
        this.setConfig({ selectedChannels: [...current, channelId] });
        return true;
    }

    /**
     * Remove a channel from selected list
     * @param {string} channelId 
     * @returns {boolean} Success
     */
    removeSelectedChannel(channelId) {
        const current = this._config.selectedChannels || [];
        if (!current.includes(channelId)) {
            return false;
        }
        
        this.setConfig({ 
            selectedChannels: current.filter(id => id !== channelId) 
        });
        return true;
    }

    /**
     * Reorder selected channels (move channel to new position)
     * @param {number} fromIndex - Current index
     * @param {number} toIndex - Target index
     */
    reorderSelectedChannel(fromIndex, toIndex) {
        const current = [...(this._config.selectedChannels || [])];
        if (fromIndex < 0 || fromIndex >= current.length) return;
        if (toIndex < 0 || toIndex >= current.length) return;
        
        const [removed] = current.splice(fromIndex, 1);
        current.splice(toIndex, 0, removed);
        
        this.setConfig({ selectedChannels: current });
        console.log(`[Store] Reordered channel from ${fromIndex} to ${toIndex}`);
    }

    /**
     * Change channel at specific position
     * @param {number} index - Position in seqData
     * @param {string} newChannelId - New channel ID
     */
    changeSelectedChannelAt(index, newChannelId) {
        const channel = this.getChannel(newChannelId);
        if (!channel) {
            console.warn(`[Store] Channel not found: ${newChannelId}`);
            return false;
        }
        
        const current = [...(this._config.selectedChannels || [])];
        if (index < 0 || index >= current.length) return false;
        
        // Check if already exists at different position
        const existingIndex = current.indexOf(newChannelId);
        if (existingIndex !== -1 && existingIndex !== index) {
            // Swap positions
            const temp = current[index];
            current[index] = newChannelId;
            current[existingIndex] = temp;
        } else {
            current[index] = newChannelId;
        }
        
        this.setConfig({ selectedChannels: current });
        return true;
    }

    /**
     * Get available channels (not yet selected)
     * @returns {Array<Object>} Channels that can be added
     */
    getAvailableChannels() {
        const selected = this._config.selectedChannels || [];
        return this._data.channels.filter(ch => !selected.includes(ch.id));
    }

    /**
     * Check if custom channels are allowed for current standard
     * @returns {boolean}
     */
    allowsCustomChannels() {
        return this._config.standardConfig?.allowCustomChannels ?? false;
    }

    /**
     * Update an equation for a channel
     * @param {string} channelId 
     * @param {string} equation 
     */
    updateEquation(channelId, equation) {
        const channelIndex = this._data.channels.findIndex(c => c.id === channelId);
        if (channelIndex === -1) {
            console.warn(`[Store] Channel not found: ${channelId}`);
            _termLog(`updateEquation FAILED — channel not found: ${channelId}`);
            return false;
        }

        const subCount = (this._subscribers.get('data.channels')?.size || 0)
                       + (this._subscribers.get('data.*')?.size || 0);

        this._data.channels[channelIndex].equation = equation;
        _termLog(`Store.updateEquation: ${channelId} = ${equation}  (notifying ${subCount} subscriber(s))`);
        this._notifyChanges(['data.channels', `data.channels.${channelId}`]);
        console.log(`[Store] Updated equation: ${channelId} = ${equation}`);
        return true;
    }

    /**
     * Add a custom channel
     * @param {Object} channel - { id, label, equation, type, description }
     * @returns {boolean} Success
     */
    addChannel(channel) {
        if (!this.allowsCustomChannels()) {
            console.warn('[Store] Cannot add custom channels with current standard');
            return false;
        }
        
        const maxChannels = this._config.standardConfig.maxChannels;
        if (this._data.channels.length >= maxChannels) {
            console.warn(`[Store] Max channels (${maxChannels}) reached`);
            return false;
        }
        
        // Check for duplicate
        if (this._data.channels.find(c => c.id === channel.id)) {
            console.warn(`[Store] Channel ${channel.id} already exists`);
            return false;
        }
        
        // Apply current system frequency to the equation
        // This ensures new channels don't keep the hardcoded 50 Hz default
        const currentFreq = this._config.frequency;
        const correctedEquation = currentFreq !== 50
            ? updateEquationFrequency(channel.equation || '0', 50, currentFreq)
            : (channel.equation || '0');

        // Add to channels array
        const newChannel = {
            id: channel.id,
            label: channel.label || channel.id,
            type: channel.type || 'custom',
            equation: correctedEquation,
            isBase: false,
            description: channel.description || 'Custom channel',
            color: channel.color || null
        };
        
        this._data.channels.push(newChannel);
        
        // Auto-add to selectedChannels so it appears in the ASDU
        const current = this._config.selectedChannels || [];
        if (!current.includes(newChannel.id)) {
            this._config.selectedChannels = [...current, newChannel.id];
        }
        
        this._notifyChanges(['data.channels', 'config.selectedChannels']);
        console.log(`[Store] Added channel: ${channel.id} (also added to selectedChannels)`);
        return true;
    }

    /**
     * Remove a custom channel
     * @param {string} channelId 
     * @returns {boolean} Success
     */
    removeChannel(channelId) {
        const channel = this._data.channels.find(c => c.id === channelId);
        
        if (!channel) {
            console.warn(`[Store] Channel not found: ${channelId}`);
            return false;
        }
        
        if (channel.isBase) {
            console.warn(`[Store] Cannot remove base channel: ${channelId}`);
            return false;
        }
        
        this._data.channels = this._data.channels.filter(c => c.id !== channelId);
        
        // Also remove from selectedChannels to keep in sync
        const selected = this._config.selectedChannels || [];
        if (selected.includes(channelId)) {
            this._config.selectedChannels = selected.filter(id => id !== channelId);
        }
        
        this._notifyChanges(['data.channels', 'config.selectedChannels']);
        console.log(`[Store] Removed channel: ${channelId} (also removed from selectedChannels)`);
        return true;
    }

    /**
     * Parse a channel definition string and add it
     * @param {string} definition - e.g., "V0 = (Va + Vb + Vc) / 3"
     * @returns {Object|null} Created channel or null
     */
    parseAndAddChannel(definition) {
        const match = definition.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/);
        if (!match) {
            console.warn('[Store] Invalid channel definition:', definition);
            return null;
        }
        
        const [, id, equation] = match;
        
        // Find predefined additional channel
        const additional = ADDITIONAL_CHANNELS.find(c => c.id === id);
        
        const channel = {
            id,
            label: additional?.label || id,
            type: additional?.type || 'custom',
            equation: equation.trim(),
            description: additional?.description || 'Custom channel'
        };
        
        if (this.addChannel(channel)) {
            return channel;
        }
        return null;
    }

    /**
     * Subscribe to channel changes
     * @param {Function} callback 
     * @returns {Function} Unsubscribe function
     */
    onChange(callback) {
        return this.subscribe(['data.channels', 'config.standard'], () => {
            callback();
        });
    }

    /**
     * Add preset channels for testing (bulk add channels)
     * Called when selecting IEC 61869 or 9-2 standards
     * @returns {number} Number of channels added
     */
    addPresetTestChannels() {
        if (!this.allowsCustomChannels()) {
            console.warn('[Store] Cannot add preset channels - standard does not allow custom channels');
            return 0;
        }

        const maxChannels = this._config.standardConfig.maxChannels;
        const currentCount = this._data.channels.length;
        const availableSlots = maxChannels - currentCount;

        if (availableSlots <= 0) {
            console.warn('[Store] No slots available for preset channels');
            return 0;
        }

        // Generate preset test channels (up to available slots)
        const presetChannels = this._generatePresetChannels(availableSlots);
        let addedCount = 0;

        for (const channel of presetChannels) {
            // Check for duplicates
            if (this._data.channels.find(c => c.id === channel.id)) {
                continue;
            }

            this._data.channels.push({
                ...channel,
                isBase: false
            });
            addedCount++;
        }

        if (addedCount > 0) {
            this._notifyChanges(['data.channels']);
            console.log(`[Store] Added ${addedCount} preset test channels`);
        }

        return addedCount;
    }

    /**
     * Generate preset test channels with realistic equations
     * @param {number} maxCount - Maximum channels to generate
     * @returns {Array} Array of channel objects
     */
    _generatePresetChannels(maxCount) {
        const channels = [];
        const colors = ['#e74c3c', '#3498db', '#2ecc71', '#f39c12', '#9b59b6', '#1abc9c', '#e67e22', '#34495e'];
        const freq = this._config.frequency || 50;
        
        // Additional computed channels from standards.js
        const additionalFromStandards = ADDITIONAL_CHANNELS.filter(ch => 
            !this._data.channels.find(c => c.id === ch.id)
        );
        
        // Add from ADDITIONAL_CHANNELS first
        additionalFromStandards.forEach((ch, idx) => {
            if (channels.length >= maxCount) return;
            channels.push({
                id: ch.id,
                label: ch.label,
                type: ch.type || 'computed',
                equation: ch.equation,
                description: ch.description,
                color: colors[idx % colors.length]
            });
        });

        // Generate more test channels if needed
        const testChannelPatterns = [
            // Secondary voltages (scaled down)
            { id: 'Va_sec', label: 'Vₐ_sec', equation: 'Va / 100', description: 'Secondary Voltage A' },
            { id: 'Vb_sec', label: 'Vᵦ_sec', equation: 'Vb / 100', description: 'Secondary Voltage B' },
            { id: 'Vc_sec', label: 'V꜀_sec', equation: 'Vc / 100', description: 'Secondary Voltage C' },
            
            // Secondary currents (scaled)
            { id: 'Ia_sec', label: 'Iₐ_sec', equation: 'Ia / 5', description: 'Secondary Current A' },
            { id: 'Ib_sec', label: 'Iᵦ_sec', equation: 'Ib / 5', description: 'Secondary Current B' },
            { id: 'Ic_sec', label: 'I꜀_sec', equation: 'Ic / 5', description: 'Secondary Current C' },
            
            // Reactive power approximations
            { id: 'Qa', label: 'Qₐ', equation: 'Va * Ia * sin(PI/6)', description: 'Phase A Reactive Power' },
            { id: 'Qb', label: 'Qᵦ', equation: 'Vb * Ib * sin(PI/6)', description: 'Phase B Reactive Power' },
            { id: 'Qc', label: 'Q꜀', equation: 'Vc * Ic * sin(PI/6)', description: 'Phase C Reactive Power' },
            { id: 'Qtotal', label: 'Q_tot', equation: 'Qa + Qb + Qc', description: 'Total Reactive Power' },
            
            // Apparent power
            { id: 'Sa', label: 'Sₐ', equation: 'sqrt(Pa*Pa + Qa*Qa)', description: 'Phase A Apparent Power' },
            { id: 'Sb', label: 'Sᵦ', equation: 'sqrt(Pb*Pb + Qb*Qb)', description: 'Phase B Apparent Power' },
            { id: 'Sc', label: 'S꜀', equation: 'sqrt(Pc*Pc + Qc*Qc)', description: 'Phase C Apparent Power' },
            
            // Harmonics simulation (3rd, 5th, 7th)
            { id: 'Va_h3', label: 'Vₐ_h3', equation: `32.5 * sin(6 * PI * ${freq} * t)`, description: '3rd Harmonic Voltage A' },
            { id: 'Va_h5', label: 'Vₐ_h5', equation: `19.5 * sin(10 * PI * ${freq} * t)`, description: '5th Harmonic Voltage A' },
            { id: 'Va_h7', label: 'Vₐ_h7', equation: `13 * sin(14 * PI * ${freq} * t)`, description: '7th Harmonic Voltage A' },
            
            // Current harmonics
            { id: 'Ia_h3', label: 'Iₐ_h3', equation: `10 * sin(6 * PI * ${freq} * t)`, description: '3rd Harmonic Current A' },
            { id: 'Ia_h5', label: 'Iₐ_h5', equation: `6 * sin(10 * PI * ${freq} * t)`, description: '5th Harmonic Current A' },
            
            // THD approximations
            { id: 'THDv', label: 'THD_V', equation: 'sqrt(Va_h3*Va_h3 + Va_h5*Va_h5 + Va_h7*Va_h7) / 325 * 100', description: 'Voltage THD %' },
            { id: 'THDi', label: 'THD_I', equation: 'sqrt(Ia_h3*Ia_h3 + Ia_h5*Ia_h5) / 100 * 100', description: 'Current THD %' },
            
            // Power factor
            { id: 'PF', label: 'PF', equation: 'Ptotal / sqrt(Ptotal*Ptotal + Qtotal*Qtotal)', description: 'Power Factor' },
            
            // Frequency deviation simulation
            { id: 'freq_dev', label: 'f_dev', equation: '0.1 * sin(2 * PI * 0.5 * t)', description: 'Frequency Deviation' },
            
            // Temperature simulation
            { id: 'Temp1', label: 'T₁', equation: '25 + 5 * sin(2 * PI * 0.01 * t)', description: 'Temperature Sensor 1' },
            { id: 'Temp2', label: 'T₂', equation: '30 + 3 * sin(2 * PI * 0.02 * t)', description: 'Temperature Sensor 2' },
            
            // Busbar voltages
            { id: 'Vbus1', label: 'V_bus1', equation: 'Va * 1.02', description: 'Busbar 1 Voltage' },
            { id: 'Vbus2', label: 'V_bus2', equation: 'Va * 0.98', description: 'Busbar 2 Voltage' },
            
            // Feeder currents
            { id: 'If1', label: 'I_f1', equation: 'Ia * 0.7', description: 'Feeder 1 Current' },
            { id: 'If2', label: 'I_f2', equation: 'Ia * 0.3', description: 'Feeder 2 Current' },
            
            // Protection signals
            { id: 'I_pickup', label: 'I_pk', equation: '150', description: 'Overcurrent Pickup' },
            { id: 'I_ratio', label: 'I_rat', equation: 'Ia / I_pickup', description: 'Current Ratio' },
        ];

        testChannelPatterns.forEach((ch, idx) => {
            if (channels.length >= maxCount) return;
            if (this._data.channels.find(c => c.id === ch.id) || 
                channels.find(c => c.id === ch.id)) return;
            
            channels.push({
                id: ch.id,
                label: ch.label,
                type: 'computed',
                equation: ch.equation,
                description: ch.description,
                color: colors[(channels.length) % colors.length]
            });
        });

        return channels;
    }

    /**
     * Clear all custom channels (keep base channels only)
     */
    clearCustomChannels() {
        this._data.channels = this._data.channels.filter(c => c.isBase);
        this._notifyChanges(['data.channels']);
        console.log('[Store] Cleared all custom channels');
    }

    // ========================================================================
    // SERIALIZATION
    // ========================================================================

    /**
     * Convert MAC address string to byte array
     * @param {string} mac - MAC address like '00:00:00:00:00:01'
     * @returns {number[]} Array of 6 bytes
     */
    _macToBytes(mac) {
        return mac.split(':').map(hex => parseInt(hex, 16));
    }

    /**
     * ⭐ MAIN METHOD: Get complete data for sending to backend
     * Combines both config and channels in one object
     * @returns {Object} { config: {...}, channels: [...] }
     */
    getDataForServer() {
        // 🔍 DEBUG: Log the actual noASDU value being read
        console.log('╔══════════════════════════════════════════════════════════════╗');
        console.log('║  🔍 getDataForServer() - Reading config values              ║');
        console.log('╠══════════════════════════════════════════════════════════════╣');
        console.log('║  this._config.noASDU =', this._config.noASDU);
        console.log('║  📊 samplesPerCycle =', this._config.samplesPerCycle);
        console.log('║  📊 frequency =', this._config.frequency);
        console.log('║  📊 sampleRate =', this._config.sampleRate);
        console.log('║  selectedChannels =', this._config.selectedChannels);
        console.log('╚══════════════════════════════════════════════════════════════╝');
        
        // Get only selected channels in the correct order
        const selectedChannels = this._config.selectedChannels || [];
        const currentFreq = this._config.frequency;
        const channelsForServer = selectedChannels
            .map(id => this._data.channels.find(ch => ch.id === id))
            .filter(ch => ch != null)
            .map(ch => ({
                id: ch.id,
                label: ch.label,
                type: ch.type,
                // Safety net: ensure any leftover 50 Hz default is replaced with current frequency
                equation: updateEquationFrequency(ch.equation, 50, currentFreq),
                isBase: ch.isBase,
            }));
        
        return {
            // Configuration (SvConfig for Rust)
            config: {
                svId: this._config.svID,
                appId: this._config.appID,
                confRev: this._config.confRev,
                smpSynch: this._config.smpSynch,
                frequency: this._config.frequency,
                sampleRate: this._config.sampleRate,
                srcMac: this._macToBytes(this._config.srcMAC),
                dstMac: this._macToBytes(this._config.dstMAC),
                vlanId: this._config.vlanID,
                vlanPriority: this._config.vlanPriority,
                noAsdu: this._config.noASDU,
                channelCount: channelsForServer.length,  // Dynamic channel count
            },
            
            // Only SELECTED channels with equations (in order!)
            channels: channelsForServer,
            
            // Additional metadata
            meta: {
                standard: this._config.standard,
                interfaceIndex: this._config.interfaceIndex,
                channelCount: channelsForServer.length,
                selectedChannels: selectedChannels,
            }
        };
    }

    /**
     * Get config object only (for backward compatibility)
     */
    getConfigForServer() {
        return this.getDataForServer().config;
    }

    /**
     * Get channels data for sending to server
     * @returns {Array} Array of { id, equation, type, isBase } objects
     */
    getChannelsForServer() {
        return this.getDataForServer().channels;
    }

    /**
     * Get equations as key-value object (for backward compatibility)
     * @returns {Object} { channelId: equation }
     */
    getEquationsForServer() {
        const equations = {};
        this._data.channels.forEach(ch => {
            equations[ch.id] = ch.equation;
        });
        return equations;
    }

    /**
     * Export full state (for debugging or saving)
     */
    toJSON() {
        return {
            config: this._config,
            data: this._data,
        };
    }

    /**
     * Import state (for loading saved state)
     */
    fromJSON(state) {
        if (state.config) {
            this.batch(() => {
                this.setConfig(state.config);
            });
        }
        if (state.data) {
            this.batch(() => {
                this.setData(state.data);
            });
        }
    }

    // ========================================================================
    // RESET
    // ========================================================================

    /**
     * Reset config to defaults
     */
    resetConfig() {
        this.batch(() => {
            this.setConfig(JSON.parse(JSON.stringify(initialConfig)));
            // Rebuild channels for default standard
            this._data.channels = buildInitialChannels(initialConfig.standard);
            this._notifyChanges(['data.channels']);
        });
    }

    /**
     * Reset data to defaults (keeps current standard's channels)
     */
    resetData() {
        this.batch(() => {
            // Rebuild channels for current standard
            this._data.channels = buildInitialChannels(this._config.standard);
            this._data.pcap = { loaded: false, filename: '', frameCount: 0, duration: 0 };
            this._data.publishing = { isRunning: false, mode: 'equation' };
            this._data.stats = { packetsSent: 0, currentRate: 0, errors: 0, uptime: 0, smpCnt: 0 };
            this._notifyChanges(['data.channels', 'data.pcap', 'data.publishing', 'data.stats']);
        });
    }

    /**
     * Reset stats only
     */
    resetStats() {
        this.setData({
            stats: {
                packetsSent: 0,
                currentRate: 0,
                errors: 0,
                uptime: 0,
                smpCnt: 0,
                // Re-stamp the configured rate so dependent UI (Mbps denominator,
                // smpCnt progress bar) uses the LIVE config, not the last run.
                configuredRate: this._config.sampleRate,
            }
        });
    }

    /**
     * Set the publishing running flag and keep dependent state coherent.
     *
     * Transition false → true: clear any stats left over from the previous run.
     * Transition true  → false: clear stats and stamp configuredRate so the
     *   UI shows a fresh "0 / live-rate" instead of frozen numbers from the
     *   run that just stopped.
     *
     * This is the single canonical hook for publishing lifecycle — every
     * caller (PublishPanel, MultiPublisher, duration-elapsed event) should
     * funnel through here so all subscribers stay in sync.
     */
    setPublishing(isRunning) {
        const wasRunning = this._data.publishing?.isRunning;
        this.setData({ publishing: { isRunning: !!isRunning } });
        if (wasRunning !== !!isRunning) {
            this.resetStats();
        }
    }

    /**
     * Reset channels to defaults for current standard
     */
    resetChannels() {
        this._data.channels = buildInitialChannels(this._config.standard, this._config.frequency);
        this._notifyChanges(['data.channels']);
        console.log('[Store] Reset channels to defaults');
    }
}

// ============================================================================
// SINGLETON INSTANCE
// ============================================================================

const store = new Store();

// ============================================================================
// DEBUG UTILITY — window.debugConfig()
// ============================================================================

/**
 * Debug utility for verifying config alignment between store, DOM, and server data.
 * Call from browser console: debugConfig()
 */
window.debugConfig = function debugConfig() {
    const spcSelect = document.getElementById('samplesPerCycleSelect');
    const freqSelect = document.getElementById('frequency');
    const smpRateInput = document.getElementById('smpRate');

    const storeVals = {
        samplesPerCycle: store.get('config.samplesPerCycle'),
        frequency: store.get('config.frequency'),
        sampleRate: store.get('config.sampleRate'),
    };

    const domVals = {
        samplesPerCycle: spcSelect ? parseInt(spcSelect.value) : '(element missing)',
        frequency: freqSelect ? parseInt(freqSelect.value) : '(element missing)',
        sampleRate: smpRateInput ? parseInt(smpRateInput.value) : '(element missing)',
    };

    const serverData = store.getDataForServer();
    const serverVals = {
        samplesPerCycle: '(not in server payload)',
        frequency: serverData.config.frequency,
        sampleRate: serverData.config.sampleRate,
    };

    console.log('%c debugConfig() — Store vs DOM vs Server', 'font-weight:bold; font-size:14px;');
    console.table({
        'samplesPerCycle': { Store: storeVals.samplesPerCycle, DOM: domVals.samplesPerCycle, Server: serverVals.samplesPerCycle },
        'frequency':       { Store: storeVals.frequency,       DOM: domVals.frequency,       Server: serverVals.frequency },
        'sampleRate':      { Store: storeVals.sampleRate,      DOM: domVals.sampleRate,      Server: serverVals.sampleRate },
    });

    // Check alignment
    const mismatches = [];
    if (storeVals.samplesPerCycle !== domVals.samplesPerCycle) mismatches.push('samplesPerCycle: Store≠DOM');
    if (storeVals.frequency !== domVals.frequency) mismatches.push('frequency: Store≠DOM');
    if (storeVals.sampleRate !== domVals.sampleRate) mismatches.push('sampleRate: Store≠DOM');
    if (storeVals.sampleRate !== serverVals.sampleRate) mismatches.push('sampleRate: Store≠Server');
    if (storeVals.sampleRate !== storeVals.samplesPerCycle * storeVals.frequency) mismatches.push('sampleRate ≠ SPC × freq (computation broken!)');

    if (mismatches.length > 0) {
        console.warn('%c ⚠️ MISMATCHES DETECTED:', 'color:red; font-weight:bold;', mismatches.join(', '));
    } else {
        console.log('%c ✅ All values aligned', 'color:green; font-weight:bold;');
    }

    return { store: storeVals, dom: domVals, server: serverVals, mismatches };
};

// ============================================================================
// EXPORTS
// ============================================================================

export default store;
export { store, initialConfig, initialData, buildInitialChannels, STANDARDS, BASE_CHANNELS, ADDITIONAL_CHANNELS, getDefaultEquations, updateEquationFrequency };
