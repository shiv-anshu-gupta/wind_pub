/**
 * @module SVParameters
 * @file modules/SVParameters.js
 * @description SV Parameters Module for stream configuration.
 * Handles DOM elements and syncs with the store.
 * 
 * @author SV-PUB Team
 * @date 2025
 */

import store from '../store/index.js';
import { showToast } from '../plugins/toast.js';

// ============================================================================
// MODULE STATE
// ============================================================================

let initialized = false;
const elements = {};

// Sample rate labels for dropdown
const SAMPLE_LABELS = {
    80: '80 (Protection)',
    96: '96 (Alternative)',
    256: '256 (Metering)',
    512: '512',
    1024: '1024',
    2048: '2048',
    4000: '4000 (Power Quality)',
    4800: '4800'
};

// ============================================================================
// DOM TEMPLATE
// ============================================================================

/**
 * Get the HTML template for this module
 * @memberof module:SVParameters
 * @returns {string} HTML template string
 */
export function getTemplate() {
    return `
        <section class="card" id="sv-parameters-module">
            <div class="card-header">
                <h2>SV Parameters</h2>
            </div>
            <div class="card-body">
                <div class="form-grid flex flex-col gap-3
                            [&_.form-group]:flex [&_.form-group]:flex-col [&_.form-group]:gap-1
                            [&_.form-group_label]:text-[13px] [&_.form-group_label]:font-medium [&_.form-group_label]:text-[var(--gray-700)]
                            [&_.form-group_input]:py-2.5 [&_.form-group_input]:px-3 [&_.form-group_input]:border [&_.form-group_input]:border-[var(--gray-300)] [&_.form-group_input]:rounded-[var(--radius)] [&_.form-group_input]:text-sm [&_.form-group_input]:transition-all [&_.form-group_input]:duration-200
                            [&_.form-group_select]:py-2.5 [&_.form-group_select]:px-3 [&_.form-group_select]:border [&_.form-group_select]:border-[var(--gray-300)] [&_.form-group_select]:rounded-[var(--radius)] [&_.form-group_select]:text-sm [&_.form-group_select]:transition-all [&_.form-group_select]:duration-200
                            [&_.form-group_input:focus]:outline-none [&_.form-group_input:focus]:border-[var(--primary)] [&_.form-group_input:focus]:shadow-[0_0_0_3px_rgba(59,130,246,0.1)]
                            [&_.form-group_select:focus]:outline-none [&_.form-group_select:focus]:border-[var(--primary)] [&_.form-group_select:focus]:shadow-[0_0_0_3px_rgba(59,130,246,0.1)]
                            [&_.input-hint]:text-[11px] [&_.input-hint]:text-[var(--gray-500)]
                            [&_.input-with-unit]:flex [&_.input-with-unit_input]:flex-1 [&_.input-with-unit_input]:rounded-[var(--radius)_0_0_var(--radius)]
                            [&_.input-with-unit_.unit]:py-2.5 [&_.input-with-unit_.unit]:px-3 [&_.input-with-unit_.unit]:bg-[var(--gray-100)] [&_.input-with-unit_.unit]:border [&_.input-with-unit_.unit]:border-[var(--gray-300)] [&_.input-with-unit_.unit]:border-l-0 [&_.input-with-unit_.unit]:rounded-[0_var(--radius)_var(--radius)_0] [&_.input-with-unit_.unit]:text-[13px] [&_.input-with-unit_.unit]:text-[var(--gray-600)]
                            [&_.samples-per-cycle-wrapper]:flex [&_.samples-per-cycle-wrapper]:gap-2 [&_.samples-per-cycle-wrapper_select]:flex-1 [&_.samples-per-cycle-wrapper_input]:w-[100px]
                            [&_input:read-only]:bg-[var(--gray-100)] [&_input:read-only]:cursor-not-allowed [&_input:read-only]:text-[var(--gray-600)]">
                    <div class="form-group">
                        <label for="svId">svID</label>
                        <input type="text" id="svId" value="MU01" placeholder="MU01">
                        <span class="input-hint">Stream identifier (max 65 chars)</span>
                    </div>
                    <div class="form-group">
                        <label for="datSet">datSet (Optional)</label>
                        <input type="text" id="datSet" placeholder="Optional for 9-2 LE">
                        <span class="input-hint">Dataset reference</span>
                    </div>
                    <div class="form-group">
                        <label for="frequency">System Frequency</label>
                        <select id="frequency">
                            <option value="50">50 Hz (Europe, Asia)</option>
                            <option value="60" selected>60 Hz (North America)</option>
                        </select>
                        <span class="input-hint">Power system frequency</span>
                    </div>
                    <div class="form-group">
                        <label for="samplesPerCycleSelect">Samples per Cycle</label>
                        <div class="samples-per-cycle-wrapper">
                            <select id="samplesPerCycleSelect">
                                <option value="80" selected>80 (Protection)</option>
                                <option value="256">256 (Metering)</option>
                            </select>
                            <input type="number" id="samplesPerCycleInput" value="80" min="1" max="50001" class="hidden" placeholder="Custom">
                        </div>
                        <span class="input-hint" id="samplesPerCycleHint">Fixed for IEC 9-2LE</span>
                    </div>
                    <div class="form-group">
                        <label for="smpRate">Sample Rate</label>
                        <div class="input-with-unit">
                            <input type="number" id="smpRate" value="4800" placeholder="4800" readonly>
                            <span class="unit">smp/s</span>
                        </div>
                        <span class="input-hint" id="smpRateHint">= <span id="smpRateFormula">80 × 60</span> Hz</span>
                    </div>
                    <div class="form-group">
                        <label for="confRev">confRev</label>
                        <input type="number" id="confRev" value="1" min="1" placeholder="1">
                        <span class="input-hint">Configuration revision</span>
                    </div>
                    <div class="form-group">
                        <label for="smpSynch">smpSynch</label>
                        <select id="smpSynch">
                            <option value="0">0 - Not Synchronized</option>
                            <option value="1">1 - Local Sync</option>
                            <option value="2" selected>2 - Global Sync (GPS)</option>
                        </select>
                        <span class="input-hint">Time sync status</span>
                    </div>
                </div>
            </div>
        </section>
    `;
}

// ============================================================================
// INITIALIZATION
// ============================================================================

/**
 * Initialize the module
 * @memberof module:SVParameters
 * @param {HTMLElement} container - Container element to render into (optional)
 */
export function init(container = null) {
    if (initialized) {
        console.warn('[SVParameters] Already initialized');
        return;
    }

    // If container provided, inject template
    if (container) {
        container.innerHTML = getTemplate();
    }

    // Cache DOM elements
    elements.svId = document.getElementById('svId');
    elements.datSet = document.getElementById('datSet');
    elements.frequency = document.getElementById('frequency');
    elements.samplesPerCycleSelect = document.getElementById('samplesPerCycleSelect');
    elements.samplesPerCycleInput = document.getElementById('samplesPerCycleInput');
    elements.samplesPerCycleHint = document.getElementById('samplesPerCycleHint');
    elements.smpRate = document.getElementById('smpRate');
    elements.smpRateFormula = document.getElementById('smpRateFormula');
    elements.confRev = document.getElementById('confRev');
    elements.smpSynch = document.getElementById('smpSynch');

    // Bind events
    bindEvents();

    // Build the samples per cycle dropdown for current standard
    rebuildSamplesPerCycleDropdown();

    // Set initial values from store
    syncFromStore();

    // Subscribe to store changes
    store.subscribe([
        'config.svID',
        'config.frequency',
        'config.samplesPerCycle',
        'config.sampleRate',
        'config.confRev',
        'config.smpSynch',
        'config.standard',
        'config.standardConfig'
    ], handleStoreChange);

    initialized = true;
    console.log('[SVParameters] Initialized');
}

// ============================================================================
// EVENT BINDING
// ============================================================================

function bindEvents() {
    // svID change
    elements.svId?.addEventListener('change', (e) => {
        const value = e.target.value.trim().slice(0, 65); // Max 65 chars
        store.setConfig({ svID: value || 'MU01' });
        e.target.value = store.config.svID;
    });

    // Frequency change
    elements.frequency?.addEventListener('change', (e) => {
        const freq = parseInt(e.target.value) || 60;
        store.setConfig({ frequency: freq });
        // Sample rate auto-updates via store
    });

    // Samples per cycle dropdown
    elements.samplesPerCycleSelect?.addEventListener('change', (e) => {
        const value = e.target.value;
        if (value === 'custom') {
            // Show custom input
            elements.samplesPerCycleInput?.classList.remove('hidden');
            elements.samplesPerCycleInput?.focus();
        } else {
            const spc = parseInt(value) || 80;
            store.setConfig({ samplesPerCycle: spc });
            elements.samplesPerCycleInput?.classList.add('hidden');
        }
    });

    // Samples per cycle custom input
    elements.samplesPerCycleInput?.addEventListener('change', (e) => {
        const value = parseInt(e.target.value);
        if (value && value > 0) {
            store.setConfig({ samplesPerCycle: value });
        } else {
            showToast('Samples per cycle must be 1-50001', 'error');
            e.target.value = store.config.samplesPerCycle;
        }
    });

    // confRev change
    elements.confRev?.addEventListener('change', (e) => {
        const value = parseInt(e.target.value) || 1;
        store.setConfig({ confRev: Math.max(1, value) });
        e.target.value = store.config.confRev;
    });

    // smpSynch change
    elements.smpSynch?.addEventListener('change', (e) => {
        store.setConfig({ smpSynch: parseInt(e.target.value) || 0 });
    });
}

// ============================================================================
// STORE SYNC
// ============================================================================

/**
 * Handle store changes
 */
function handleStoreChange(value, path) {
    if (path === 'config.standard' || path === 'config.standardConfig') {
        rebuildSamplesPerCycleDropdown();
    }
    syncFromStore();
}

/**
 * Sync UI from store
 */
function syncFromStore() {
    if (elements.svId) {
        elements.svId.value = store.config.svID;
    }
    if (elements.frequency) {
        elements.frequency.value = store.config.frequency;
    }
    if (elements.smpRate) {
        elements.smpRate.value = store.config.sampleRate;
    }
    if (elements.smpRateFormula) {
        elements.smpRateFormula.textContent = `${store.config.samplesPerCycle} × ${store.config.frequency}`;
    }
    if (elements.confRev) {
        elements.confRev.value = store.config.confRev;
    }
    if (elements.smpSynch) {
        elements.smpSynch.value = store.config.smpSynch;
    }
    
    // Update samples per cycle dropdown value
    if (elements.samplesPerCycleSelect) {
        const currentValue = store.config.samplesPerCycle.toString();
        const options = Array.from(elements.samplesPerCycleSelect.options);
        const hasOption = options.some(opt => opt.value === currentValue);
        
        if (hasOption) {
            elements.samplesPerCycleSelect.value = currentValue;
            elements.samplesPerCycleInput?.classList.add('hidden');
        }
    }
}

/**
 * Rebuild samples per cycle dropdown based on current standard
 */
function rebuildSamplesPerCycleDropdown() {
    if (!elements.samplesPerCycleSelect) {
        return;
    }

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

    // Clear and rebuild options
    elements.samplesPerCycleSelect.innerHTML = '';

    allowedValues.forEach(val => {
        const option = document.createElement('option');
        option.value = val;
        option.textContent = SAMPLE_LABELS[val] || val.toString();
        if (val === currentValue) option.selected = true;
        elements.samplesPerCycleSelect.appendChild(option);
    });

    // Add custom option for flexible standards
    if (canCustom) {
        const customOption = document.createElement('option');
        customOption.value = 'custom';
        customOption.textContent = 'Custom...';
        elements.samplesPerCycleSelect.appendChild(customOption);
    }

    // Update hint text
    if (elements.samplesPerCycleHint) {
        if (config.fixedSamplesPerCycle) {
            elements.samplesPerCycleHint.textContent = `Fixed for ${config.name}`;
            elements.samplesPerCycleHint.classList.add('hint-locked');
        } else {
            elements.samplesPerCycleHint.textContent = `Flexible for ${config.name} - custom values allowed`;
            elements.samplesPerCycleHint.classList.remove('hint-locked');
        }
    }

    // Hide custom input
    if (elements.samplesPerCycleInput) {
        elements.samplesPerCycleInput.classList.add('hidden');
        elements.samplesPerCycleInput.value = currentValue;
    }

}


// ============================================================================
// PUBLIC API
// ============================================================================

/**
 * Get current SV parameters
 * @memberof module:SVParameters
 * @returns {Object} SV parameters object
 */
export function getParameters() {
    return {
        svID: store.config.svID,
        frequency: store.config.frequency,
        samplesPerCycle: store.config.samplesPerCycle,
        sampleRate: store.config.sampleRate,
        confRev: store.config.confRev,
        smpSynch: store.config.smpSynch
    };
}

/**
 * Get sample rate
 * @memberof module:SVParameters
 * @returns {number} Sample rate
 */
export function getSampleRate() {
    return store.config.sampleRate;
}

/**
 * Destroy module (cleanup)
 * @memberof module:SVParameters
 */
export function destroy() {
    initialized = false;
}

// ============================================================================
// DEFAULT EXPORT
// ============================================================================

export default {
    init,
    getTemplate,
    getParameters,
    getSampleRate,
    destroy
};
