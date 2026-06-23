/**
 * @module WiresharkHelper
 * @file components/WiresharkHelper.js
 * @description Wireshark Helper Module - Quick Reference for Packet Capture.
 * Shows Wireshark filter and capture steps with copy functionality.
 * 
 * @author SV-PUB Team
 * @date 2025
 */

import { showToast } from '../plugins/toast.js';

// ============================================================================
// MODULE STATE
// ============================================================================

let _initialized = false;
const _elements = {};

// ============================================================================
// DOM TEMPLATE
// ============================================================================

/**
 * Get the HTML template for Wireshark helper
 * @memberof module:WiresharkHelper
 * @returns {string} HTML template string
 */
export function getTemplate() {
    return `
        <section class="card" id="wireshark-module">
            <div class="card-header">
                <h2>🦈 Wireshark</h2>
            </div>
            <div class="card-body">
                <p class="text-[13px] text-[var(--gray-600)] mb-2.5">Filter for SV packets:</p>
                <div class="flex items-center bg-[var(--gray-900)] rounded-[var(--radius)] px-3.5 py-2.5 mb-4">
                    <code id="wiresharkFilter" class="flex-1 font-mono text-sm text-green-500">eth.type == 0x88ba</code>
                    <button id="copyFilterBtn" class="bg-[var(--gray-700)] hover:bg-[var(--gray-600)] text-white border-0 px-3 py-1.5 rounded text-xs cursor-pointer transition-all duration-200">📋 Copy</button>
                </div>
                <div class="text-[13px] text-[var(--gray-600)]">
                    <ol class="pl-5 space-y-1 list-decimal">
                        <li>Open Wireshark</li>
                        <li>Select network interface</li>
                        <li>Paste filter above</li>
                        <li>Start capture</li>
                        <li>Click START here</li>
                        <li>Verify packets ✓</li>
                    </ol>
                </div>
            </div>
        </section>
    `;
}

// ============================================================================
// INITIALIZATION
// ============================================================================

/**
 * Initialize the Wireshark Helper module
 * @memberof module:WiresharkHelper
 * @param {HTMLElement} container - Container element to inject template
 */
export function init(container) {
    if (_initialized) {
        console.warn('[WiresharkHelper] Already initialized');
        return;
    }
    
    console.log('[WiresharkHelper] Initializing...');
    
    // Inject template
    container.innerHTML = getTemplate();
    
    // Cache elements
    _elements.filter = document.getElementById('wiresharkFilter');
    _elements.copyBtn = document.getElementById('copyFilterBtn');
    
    // Bind events
    _bindEvents();
    
    _initialized = true;
    console.log('[WiresharkHelper] ✅ Initialized');
}

// ============================================================================
// EVENT BINDING
// ============================================================================

function _bindEvents() {
    _elements.copyBtn?.addEventListener('click', _copyFilter);
}

/**
 * Copy Wireshark filter to clipboard
 */
async function _copyFilter() {
    const filterText = _elements.filter?.textContent || 'eth.type == 0x88ba';
    
    try {
        await navigator.clipboard.writeText(filterText);
        showToast('Filter copied to clipboard!', 'success');
        
        // Visual feedback
        if (_elements.copyBtn) {
            const originalText = _elements.copyBtn.textContent;
            _elements.copyBtn.textContent = '✓ Copied!';
            setTimeout(() => {
                _elements.copyBtn.textContent = originalText;
            }, 1500);
        }
    } catch (err) {
        console.error('[WiresharkHelper] Failed to copy:', err);
        showToast('Failed to copy filter', 'error');
    }
}

// ============================================================================
// PUBLIC API
// ============================================================================

export const WiresharkHelper = {
    init,
    getTemplate
};

export default WiresharkHelper;
