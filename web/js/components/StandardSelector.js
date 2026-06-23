/**
 * @module StandardSelector
 * @file modules/StandardSelector.js
 * @description IEC Standard selection module.
 * Handles standard selection and syncs with store.
 * 
 * @author SV-PUB Team
 * @date 2025
 */

import store from '../store/index.js';
import { STANDARDS } from '../../shared/standards.js';
import { showToast } from '../plugins/toast.js';

// ============================================================================
// MODULE STATE
// ============================================================================

let initialized = false;
const elements = {};

// ============================================================================
// DOM TEMPLATE
// ============================================================================

/**
 * Get the HTML template for this module
 * @memberof module:StandardSelector
 * @returns {string} HTML template string
 */
export function getTemplate() {
    // `.radio-card` and `.active` are JS marker classes — kept for
    // bindings.js querySelector and dark-theme CSS hooks. All visual styling
    // is via Tailwind utilities below.
    const card = [
        'radio-card flex items-center gap-2.5 px-3 py-2.5',
        'border border-[var(--gray-300)] rounded cursor-pointer',
        'transition-[border-color] duration-150',
        'hover:border-[var(--primary)]',
        '[&.active]:border-[var(--primary)] [&.active]:bg-[var(--gray-50)]',
        '[&_input[type=radio]]:w-[18px] [&_input[type=radio]]:h-[18px] [&_input[type=radio]]:accent-[var(--primary)]',
    ].join(' ');
    const title = 'font-semibold block mb-0.5';
    const desc = 'text-xs text-[var(--gray-500)]';

    return `
        <section class="card" id="standard-selector-module">
            <div class="card-header">
                <h2>Standard</h2>
            </div>
            <div class="card-body">
                <div class="flex flex-col gap-2.5" id="standardRadioGroup">
                    <label class="${card} active" data-standard="9-2LE">
                        <input type="radio" name="standard" value="9-2LE" checked>
                        <div class="flex-1">
                            <span class="${title}">IEC 61850 9-2 LE</span>
                            <span class="${desc}">Light Edition - Fixed 8 channels, 80 samples/cycle</span>
                        </div>
                        <span class="px-2 py-1 rounded text-[10px] font-semibold uppercase bg-green-500/10 text-[var(--success)]">Recommended</span>
                    </label>
                    <label class="${card}" data-standard="9-2">
                        <input type="radio" name="standard" value="9-2">
                        <div class="flex-1">
                            <span class="${title}">IEC 61850 9-2</span>
                            <span class="${desc}">Full version - Configurable channels and rates</span>
                        </div>
                    </label>
                    <label class="${card}" data-standard="61869">
                        <input type="radio" name="standard" value="61869">
                        <div class="flex-1">
                            <span class="${title}">IEC 61869</span>
                            <span class="${desc}">Instrument transformers - Up to 20 channels, flexible rates</span>
                        </div>
                    </label>
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
 * @memberof module:StandardSelector
 * @param {HTMLElement} container - Container element to render into (optional)
 */
export function init(container = null) {
    if (initialized) {
        console.warn('[StandardSelector] Already initialized');
        return;
    }

    // If container provided, inject template
    if (container) {
        container.innerHTML = getTemplate();
    }

    // Cache DOM elements
    elements.radioGroup = document.getElementById('standardRadioGroup');
    elements.radios = document.querySelectorAll('input[name="standard"]');
    elements.cards = document.querySelectorAll('.radio-card[data-standard]');

    if (!elements.radioGroup) {
        console.error('[StandardSelector] Radio group not found');
        return;
    }

    // Bind events
    bindEvents();

    // Set initial state from store
    syncFromStore();

    // Subscribe to store changes
    store.subscribe('config.standard', syncFromStore);

    initialized = true;
    console.log('[StandardSelector] Initialized');
}

// ============================================================================
// EVENT BINDING
// ============================================================================

function bindEvents() {
    // Handle radio button changes
    elements.radios.forEach(radio => {
        radio.addEventListener('change', handleRadioChange);
    });

    // Handle card clicks (for better UX)
    elements.cards.forEach(card => {
        card.addEventListener('click', handleCardClick);
    });
}

function handleRadioChange(e) {
    if (e.target.checked) {
        const standardId = e.target.value;
        updateStandard(standardId);
    }
}

function handleCardClick(e) {
    const card = e.currentTarget;
    const radio = card.querySelector('input[type="radio"]');
    
    if (radio && !radio.checked) {
        radio.checked = true;
        updateStandard(radio.value);
    }
}

// ============================================================================
// STATE MANAGEMENT
// ============================================================================

/**
 * Update the selected standard
 */
function updateStandard(standardId) {
    const config = STANDARDS[standardId];
    if (!config) {
        console.warn('[StandardSelector] Invalid standard:', standardId);
        return;
    }

    const previous = store.config.standard;
    if (previous === standardId) {
        return; // No change
    }

    // Update store (triggers samplesPerCycle and sampleRate updates)
    store.setStandard(standardId);

    // Sync to server
    syncToServer(standardId);

    // Show feedback
    showToast(`Standard changed to ${config.name}`);
    
    console.log(`[StandardSelector] Changed: ${previous} → ${standardId}`);
}

/**
 * Sync UI from store
 */
function syncFromStore() {
    const currentStandard = store.config.standard;
    const standardConfig = STANDARDS[currentStandard];

    // Update radio buttons
    elements.radios.forEach(radio => {
        radio.checked = radio.value === currentStandard;
    });

    // Update card styling
    elements.cards.forEach(card => {
        const isActive = card.dataset.standard === currentStandard;
        card.classList.toggle('active', isActive);
    });
}

/**
 * Sync standard selection to server
 */
async function syncToServer(standardId) {
    try {
        const response = await fetch('/api/standard', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ standard: standardId })
        });
        
        const result = await response.json();
        if (!result.success) {
            console.warn('[StandardSelector] Server sync failed:', result.error);
        }
    } catch (e) {
        console.warn('[StandardSelector] Failed to sync to server:', e);
    }
}

// ============================================================================
// PUBLIC API
// ============================================================================

/**
 * Get current selected standard
 * @memberof module:StandardSelector
 * @returns {string} Standard ID
 */
export function getSelected() {
    return store.config.standard;
}

/**
 * Set standard programmatically
 * @memberof module:StandardSelector
 * @param {string} standardId - Standard ID to set
 */
export function setStandard(standardId) {
    updateStandard(standardId);
}

/**
 * Get standard config
 * @memberof module:StandardSelector
 * @returns {Object} Standard configuration object
 */
export function getConfig() {
    return store.config.standardConfig;
}

/**
 * Destroy module (cleanup)
 * @memberof module:StandardSelector
 */
export function destroy() {
    elements.radios?.forEach(radio => {
        radio.removeEventListener('change', handleRadioChange);
    });
    elements.cards?.forEach(card => {
        card.removeEventListener('click', handleCardClick);
    });
    initialized = false;
}

// ============================================================================
// DEFAULT EXPORT
// ============================================================================

export default {
    init,
    getTemplate,
    getSelected,
    setStandard,
    getConfig,
    destroy
};
