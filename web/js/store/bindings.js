/**
 * @file store/bindings.js
 * @fileoverview DOM Bindings - Connects UI elements to the Store
 * @module bindings
 * @description
 * Sets up two-way data binding between HTML elements and the store.
 * State changes update UI automatically, UI changes update state.
 */

import store from './index.js';
import { STANDARDS } from '../../shared/standards.js';

/**
 * Initialize all DOM bindings. Call once after DOM is ready.
 * @memberof module:bindings
 */
export function initBindings() {
    console.log('[Bindings] Setting up DOM bindings...');
    
    // ========================================================================
    // CONFIG BINDINGS (Two-way)
    // ========================================================================
    
    // Frequency
    store.bindElement('frequency', 'config.frequency', {
        transform: v => parseInt(v) || 60
    });
    
    // Network Settings
    store.bindElement('srcMac', 'config.srcMAC');
    store.bindElement('destMac', 'config.dstMAC');
    store.bindElement('vlanId', 'config.vlanID', {
        transform: v => parseInt(v) || 0
    });
    store.bindElement('networkInterface', 'config.interfaceIndex', {
        transform: v => parseInt(v) || 0
    });
    
    // SV Parameters
    store.bindElement('svId', 'config.svID');
    store.bindElement('appId', 'config.appID', {
        transform: v => parseInt(v, 16) || 0x4000,
        format: v => v.toString(16).toUpperCase().padStart(4, '0')
    });
    store.bindElement('confRev', 'config.confRev', {
        transform: v => parseInt(v) || 1
    });
    store.bindElement('smpSynch', 'config.smpSynch', {
        transform: v => parseInt(v) || 2
    });
    
    // Sample Rate (read-only, computed)
    store.bindElement('smpRate', 'config.sampleRate', {
        readonly: true
    });
    
    // ========================================================================
    // CUSTOM UI UPDATES (Computed/Derived values)
    // ========================================================================
    
    // Sample Rate Formula Display
    store.subscribe(['config.samplesPerCycle', 'config.frequency'], () => {
        const formula = document.getElementById('smpRateFormula');
        if (formula) {
            formula.textContent = `${store.config.samplesPerCycle} × ${store.config.frequency}`;
        }
    });
    
    // Samples Per Cycle Dropdown
    setupSamplesPerCycleBinding();
    
    // Standard Selection (Radio Cards)
    setupStandardBinding();
    
    // Stats Display
    setupStatsBindings();
    
    // Equation Bindings
    setupEquationBindings();
    
    console.log('[Bindings] DOM bindings complete');
}

/**
 * Setup samples per cycle dropdown binding
 */
function setupSamplesPerCycleBinding() {
    const select = document.getElementById('samplesPerCycleSelect');
    const input = document.getElementById('samplesPerCycleInput');
    const hint = document.getElementById('samplesPerCycleHint');
    
    if (!select) return;
    
    // Rebuild dropdown when standard changes
    store.subscribe('config.standard', () => {
        rebuildSamplesPerCycleDropdown();
    });
    
    // Handle user selection
    select.addEventListener('change', (e) => {
        const value = e.target.value;
        if (value === 'custom') {
            if (input) {
                input.classList.remove('hidden');
                input.focus();
            }
        } else {
            store.setConfig({ samplesPerCycle: parseInt(value) || 80 });
            if (input) input.classList.add('hidden');
        }
    });
    
    // Handle custom input
    if (input) {
        input.addEventListener('change', (e) => {
            const value = parseInt(e.target.value);
            if (value && value > 0) {
                store.setConfig({ samplesPerCycle: value });
            }
        });
    }
    
    // Initial build
    rebuildSamplesPerCycleDropdown();
}

/**
 * Rebuild samples per cycle dropdown based on current standard
 */
function rebuildSamplesPerCycleDropdown() {
    const select = document.getElementById('samplesPerCycleSelect');
    const input = document.getElementById('samplesPerCycleInput');
    const hint = document.getElementById('samplesPerCycleHint');
    
    if (!select) return;
    
    const config = store.config.standardConfig;
    if (!config) return;
    
    const allowedValues = config.allowedSamplesPerCycle || [80, 256];
    const canCustom = !config.fixedSamplesPerCycle;
    let currentValue = store.config.samplesPerCycle;
    
    // Ensure current value is valid for this standard
    if (!allowedValues.includes(currentValue) && !canCustom) {
        currentValue = config.defaultSamplesPerCycle || allowedValues[0];
        store.setConfig({ samplesPerCycle: currentValue });
    }
    
    // Build options
    select.innerHTML = '';
    
    const labels = {
        80: '80 (Protection)',
        96: '96 (Alternative)',
        256: '256 (Metering)',
        512: '512',
        1024: '1024',
        2048: '2048',
        4000: '4000 (Power Quality)',
        4800: '4800'
    };
    
    allowedValues.forEach(val => {
        const option = document.createElement('option');
        option.value = val;
        option.textContent = labels[val] || val.toString();
        if (val === currentValue) option.selected = true;
        select.appendChild(option);
    });
    
    // Add custom option for flexible standards
    if (canCustom) {
        const customOption = document.createElement('option');
        customOption.value = 'custom';
        customOption.textContent = 'Custom...';
        select.appendChild(customOption);
    }
    
    // Update hint text
    if (hint) {
        if (config.fixedSamplesPerCycle) {
            hint.textContent = `Fixed for ${config.name}`;
            hint.classList.add('hint-locked');
        } else {
            hint.textContent = `Flexible for ${config.name} - custom values allowed`;
            hint.classList.remove('hint-locked');
        }
    }
    
    // Show/hide custom input
    if (input) {
        input.classList.add('hidden');
        input.value = currentValue;
    }
}

/**
 * Setup standard selection binding (radio cards)
 */
function setupStandardBinding() {
    const radios = document.querySelectorAll('input[name="standard"]');
    const radioCards = document.querySelectorAll('.radio-card');
    
    // Handle radio selection
    radios.forEach(radio => {
        radio.addEventListener('change', (e) => {
            if (e.target.checked) {
                store.setStandard(e.target.value);
            }
        });
    });
    
    // Handle card click
    radioCards.forEach(card => {
        card.addEventListener('click', function() {
            const radio = this.querySelector('input[type="radio"]');
            if (radio && !radio.checked) {
                radio.checked = true;
                radio.dispatchEvent(new Event('change', { bubbles: true }));
            }
        });
    });
    
    // Update UI when store changes
    store.subscribe('config.standard', (standard) => {
        // Update radio
        radios.forEach(radio => {
            radio.checked = radio.value === standard;
        });
        
        // Update card styling
        radioCards.forEach(card => {
            const input = card.querySelector('input[name="standard"]');
            if (input) {
                card.classList.toggle('active', input.value === standard);
            }
        });
    });
    
    // Set initial value from DOM
    const checked = document.querySelector('input[name="standard"]:checked');
    if (checked) {
        store.setConfig({ 
            standard: checked.value,
            standardConfig: STANDARDS[checked.value]
        });
    }
}

/**
 * Setup stats display bindings (read-only)
 * Note: Statistics.js module now handles most stats display.
 * This remains for backward compatibility with any legacy elements.
 */
function setupStatsBindings() {
    // Subscribe to stats changes
    // Statistics.js module handles stat-* prefixed elements
    // This handles legacy elements if they exist
    store.subscribe('data.stats.*', (stats) => {
        // Legacy packetsSent element (Statistics.js uses stat-packetsSent)
        if (stats.packetsSent !== undefined) {
            const el = document.getElementById('packetsSent');
            if (el) el.textContent = stats.packetsSent.toLocaleString();
        }
        // Legacy currentRate element (Statistics.js uses stat-pps and stat-dataRate)
        if (stats.currentRate !== undefined) {
            const el = document.getElementById('currentRate');
            if (el) el.textContent = stats.currentRate.toLocaleString();
        }
        // Legacy errorCount element (Statistics.js uses stat-packetsFailed)
        if (stats.errors !== undefined) {
            const el = document.getElementById('errorCount');
            if (el) el.textContent = stats.errors.toLocaleString();
        }
        // Legacy uptime element (Statistics.js uses stat-duration)
        if (stats.uptime !== undefined) {
            const el = document.getElementById('uptime');
            if (el) el.textContent = formatTime(stats.uptime / 1000);
        }
        // Legacy smpCnt elements (Statistics.js uses stat-smpCntValue and stat-smpCntProgress)
        if (stats.smpCnt !== undefined) {
            const smpRate = store.config.sampleRate;
            const smpCntValue = document.getElementById('smpCntValue');
            const smpCntProgress = document.getElementById('smpCntProgress');
            const prevSmpCnt = document.getElementById('prevSmpCnt');
            
            if (smpCntValue) {
                smpCntValue.textContent = stats.smpCnt.toLocaleString() + ' / ' + smpRate.toLocaleString();
            }
            if (smpCntProgress) {
                const progressPercent = (stats.smpCnt / smpRate) * 100;
                smpCntProgress.style.width = progressPercent + '%';
            }
            if (prevSmpCnt) {
                prevSmpCnt.textContent = stats.smpCnt;
            }
        }
    });
}

/**
 * Setup equation bindings
 * Dynamically binds ALL channels (not just 8 base), supporting custom channels too
 */
function setupEquationBindings() {
    const baseEquationIds = ['Va', 'Vb', 'Vc', 'Vn', 'Ia', 'Ib', 'Ic', 'In'];
    
    // Bind the base 8 channels (always present as static inputs)
    baseEquationIds.forEach(id => {
        bindEquationInput(id);
    });
    
    // Also bind any additional custom channels that already exist
    const channels = store.data.channels || [];
    channels.forEach(ch => {
        if (!baseEquationIds.includes(ch.id)) {
            bindEquationInput(ch.id);
        }
    });

    // Subscribe to channel list changes to bind new custom channels dynamically
    store.subscribe('data.channels', (channels) => {
        (channels || []).forEach(ch => {
            if (!baseEquationIds.includes(ch.id)) {
                bindEquationInput(ch.id);
            }
        });
    });
}

/**
 * Bind a single equation input by channel ID
 * Safe to call multiple times for the same ID (won't double-bind)
 */
const _boundEquationIds = new Set();
function bindEquationInput(id) {
    if (_boundEquationIds.has(id)) return;
    
    const inputId = `eq${id}`;
    const input = document.getElementById(inputId);
    
    if (input) {
        _boundEquationIds.add(id);
        
        // Set initial value from store
        const channels = store.data.channels || [];
        const channel = channels.find(ch => ch.id === id);
        input.value = channel?.equation || '';
        
        // Update store on change
        input.addEventListener('change', (e) => {
            const channels = store.data.channels || [];
            const updatedChannels = channels.map(ch => 
                ch.id === id ? { ...ch, equation: e.target.value } : ch
            );
            store.setData({ channels: updatedChannels });
        });
        
        // Subscribe to store changes
        store.subscribe('data.channels', (channels) => {
            const channel = (channels || []).find(ch => ch.id === id);
            if (channel && input.value !== channel.equation) {
                input.value = channel.equation || '';
            }
        });
    }
}

/**
 * Format time in HH:MM:SS
 */
function formatTime(seconds) {
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    return `${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

export default initBindings;
