/**
 * @module NetworkSettings
 * @file modules/NetworkSettings.js
 * @description Network Settings Module for interface and MAC configuration.
 * Handles network interface selection and MAC address settings.
 * 
 * @author SV-PUB Team
 * @date 2025
 */

import store from '../store/index.js';
import { showToast } from '../plugins/toast.js';
import * as tauriClient from '../utils/tauriClient.js';

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
 * @memberof module:NetworkSettings
 * @returns {string} HTML template string
 */
export function getTemplate() {
    return `
        <section class="card" id="network-settings-module">
            <div class="card-header">
                <h2>Network</h2>
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
                            [&_.input-with-button]:flex [&_.input-with-button]:gap-2 [&_.input-with-button_input]:flex-1">
                    <div class="form-group full-width">
                        <label for="networkInterface">Network Interface</label>
                        <select id="networkInterface">
                            <option value="">Loading interfaces...</option>
                        </select>
                        <span class="input-hint">Select the Ethernet adapter for packet transmission</span>
                    </div>
                    <div class="form-group">
                        <label for="srcMac">Source MAC</label>
                        <div class="input-with-button">
                            <input type="text" id="srcMac" value="00:11:22:33:44:55" placeholder="00:11:22:33:44:55">
                            <button class="btn btn-small" id="autoDetectMac" title="Auto-detect MAC from interface">Auto</button>
                        </div>
                        <span class="input-hint">Your network card address</span>
                    </div>
                    <div class="form-group">
                        <label for="destMac">Destination MAC</label>
                        <input type="text" id="destMac" value="01:0C:CD:04:00:01" placeholder="01:0C:CD:04:00:01">
                        <span class="input-hint">SV Multicast: 01:0C:CD:04:XX:XX</span>
                    </div>
                    <div class="form-group">
                        <label for="appId">APPID</label>
                        <input type="text" id="appId" value="4000" placeholder="4000">
                        <span class="input-hint">Range: 0x0000-0x3FFF (hex)</span>
                    </div>
                    <div class="form-group">
                        <label for="vlanId">VLAN ID (Optional)</label>
                        <select id="vlanId">
                            <option value="0">None</option>
                            <option value="100">100</option>
                            <option value="200">200</option>
                            <option value="custom">Custom...</option>
                        </select>
                        <span class="input-hint">Optional: 0-4095</span>
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
 * @memberof module:NetworkSettings
 * @param {HTMLElement} container - Container element to render into (optional)
 */
export function init(container = null) {
    if (initialized) {
        console.warn('[NetworkSettings] Already initialized');
        return;
    }

    // If container provided, inject template
    if (container) {
        container.innerHTML = getTemplate();
    }

    // Cache DOM elements
    elements.interfaceSelect = document.getElementById('networkInterface');
    elements.srcMac = document.getElementById('srcMac');
    elements.destMac = document.getElementById('destMac');
    elements.appId = document.getElementById('appId');
    elements.vlanId = document.getElementById('vlanId');
    elements.autoDetectBtn = document.getElementById('autoDetectMac');

    // Bind events
    bindEvents();

    // Load network interfaces
    loadNetworkInterfaces();

    // Set initial values from store
    syncFromStore();

    // Subscribe to store changes
    store.subscribe([
        'config.interfaceIndex',
        'config.srcMAC',
        'config.dstMAC',
        'config.appID',
        'config.vlanID'
    ], syncFromStore);

    initialized = true;
    console.log('[NetworkSettings] Initialized');
}

// ============================================================================
// EVENT BINDING
// ============================================================================

function bindEvents() {
    // Network interface change
    elements.interfaceSelect?.addEventListener('change', (e) => {
        const index = parseInt(e.target.value) || 0;
        const option = e.target.options[e.target.selectedIndex];
        store.setConfig({ 
            interfaceIndex: index,
            interfaceName: option?.textContent || ''
        });
    });

    // Source MAC change
    elements.srcMac?.addEventListener('change', (e) => {
        const mac = validateMAC(e.target.value);
        if (mac) {
            store.setConfig({ srcMAC: mac });
            e.target.value = mac; // Format
        } else {
            showToast('Invalid MAC address format', 'error');
            e.target.value = store.config.srcMAC;
        }
    });

    // Destination MAC change
    elements.destMac?.addEventListener('change', (e) => {
        const mac = validateMAC(e.target.value);
        if (mac) {
            store.setConfig({ dstMAC: mac });
            e.target.value = mac; // Format
        } else {
            showToast('Invalid MAC address format', 'error');
            e.target.value = store.config.dstMAC;
        }
    });

    // APPID change
    elements.appId?.addEventListener('change', (e) => {
        const value = parseInt(e.target.value, 16);
        if (!isNaN(value) && value >= 0 && value <= 0x3FFF) {
            store.setConfig({ appID: value });
            e.target.value = value.toString(16).toUpperCase().padStart(4, '0');
        } else {
            showToast('APPID must be 0x0000-0x3FFF', 'error');
            e.target.value = store.config.appID.toString(16).toUpperCase().padStart(4, '0');
        }
    });

    // VLAN ID change
    elements.vlanId?.addEventListener('change', (e) => {
        const value = parseInt(e.target.value) || 0;
        store.setConfig({ vlanID: value });
    });

    // Auto-detect MAC button
    elements.autoDetectBtn?.addEventListener('click', autoDetectMAC);
}

// ============================================================================
// NETWORK INTERFACES
// ============================================================================

/**
 * Load network interfaces from Tauri backend
 */
async function loadNetworkInterfaces() {
    if (!elements.interfaceSelect) return;

    try {
        // Use tauriClient WebSocket bridge to get interfaces
        let interfaces = [];
        try {
            interfaces = await tauriClient.getInterfaces();
        } catch {
            // Dev fallback if backend WS isn't running yet
            const response = await fetch('/api/interfaces');
            const data = await response.json();
            interfaces = data.interfaces || data;
        }

        elements.interfaceSelect.innerHTML = '';
        
        if (!interfaces || interfaces.length === 0) {
            elements.interfaceSelect.innerHTML = '<option value="">No interfaces found</option>';
            return;
        }

        let selectedIndex = 0;
        interfaces.forEach((iface, index) => {
            const option = document.createElement('option');
            option.value = index;
            option.textContent = iface.description || iface.displayName || iface.name;
            
            // Auto-select Ethernet interface
            if (iface.description?.toLowerCase().includes('ethernet')) {
                option.selected = true;
                selectedIndex = index;
            }
            
            // Store MAC address as data attribute for auto-detect
            if (iface.mac) {
                option.dataset.mac = iface.mac;
            }
            
            elements.interfaceSelect.appendChild(option);
        });

        // Update store with selected interface
        const selectedOption = elements.interfaceSelect.options[elements.interfaceSelect.selectedIndex];
        store.setConfig({
            interfaceIndex: selectedIndex,
            interfaceName: selectedOption?.textContent || ''
        });

        console.log('[NetworkSettings] Loaded', interfaces.length, 'interfaces');
    } catch (err) {
        console.error('[NetworkSettings] Failed to load interfaces:', err);
        elements.interfaceSelect.innerHTML = '<option value="">Failed to load interfaces</option>';
    }
}

/**
 * Auto-detect MAC address from selected interface
 */
async function autoDetectMAC() {
    const selectedOption = elements.interfaceSelect?.options[elements.interfaceSelect.selectedIndex];
    
    if (selectedOption?.dataset.mac) {
        // Use MAC from interface data
        const mac = selectedOption.dataset.mac;
        store.setConfig({ srcMAC: mac });
        elements.srcMac.value = mac;
        showToast('MAC address auto-detected');
    } else {
        // Try to get from backend via WS bridge
        try {
            let interfaces = [];
            try {
                interfaces = await tauriClient.getInterfaces();
            } catch {
                const response = await fetch('/api/interfaces');
                const data = await response.json();
                interfaces = data.interfaces || data;
            }
            const index = store.config.interfaceIndex;
            
            if (interfaces[index]?.mac) {
                const mac = interfaces[index].mac;
                store.setConfig({ srcMAC: mac });
                elements.srcMac.value = mac;
                showToast('MAC address auto-detected');
            } else {
                showToast('Could not detect MAC address', 'error');
            }
        } catch (e) {
            showToast('Failed to auto-detect MAC', 'error');
        }
    }
}

// ============================================================================
// VALIDATION
// ============================================================================

/**
 * Validate and format MAC address
 * @param {string} mac - MAC address input
 * @returns {string|null} Formatted MAC or null if invalid
 */
function validateMAC(mac) {
    // Remove common separators and convert to uppercase
    const cleaned = mac.replace(/[:\-\.]/g, '').toUpperCase();
    
    // Check if it's 12 hex characters
    if (!/^[0-9A-F]{12}$/.test(cleaned)) {
        return null;
    }
    
    // Format as XX:XX:XX:XX:XX:XX
    return cleaned.match(/.{2}/g).join(':');
}

// ============================================================================
// SYNC
// ============================================================================

/**
 * Sync UI from store
 */
function syncFromStore() {
    if (elements.interfaceSelect) {
        elements.interfaceSelect.value = store.config.interfaceIndex;
    }
    if (elements.srcMac) {
        elements.srcMac.value = store.config.srcMAC;
    }
    if (elements.destMac) {
        elements.destMac.value = store.config.dstMAC;
    }
    if (elements.appId) {
        elements.appId.value = store.config.appID.toString(16).toUpperCase().padStart(4, '0');
    }
    if (elements.vlanId) {
        elements.vlanId.value = store.config.vlanID;
    }
}

// ============================================================================
// PUBLIC API
// ============================================================================

/**
 * Get current network settings
 * @memberof module:NetworkSettings
 * @returns {Object} Network settings object
 */
export function getSettings() {
    return {
        interfaceIndex: store.config.interfaceIndex,
        interfaceName: store.config.interfaceName,
        srcMAC: store.config.srcMAC,
        dstMAC: store.config.dstMAC,
        appID: store.config.appID,
        vlanID: store.config.vlanID
    };
}

/**
 * Refresh network interfaces list
 * @memberof module:NetworkSettings
 */
export function refreshInterfaces() {
    loadNetworkInterfaces();
}

/**
 * Destroy module (cleanup)
 * @memberof module:NetworkSettings
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
    getSettings,
    refreshInterfaces,
    destroy
};
