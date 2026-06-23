/**
 * @module Preview
 * @file components/preview.js
 * @description Packet Preview Module - Live SV Packet Structure Display.
 * Shows Ethernet Header, SV Header, and ASDU preview.
 * 
 * @author SV-PUB Team
 * @date 2025
 */

import store from '../store/index.js';

// ============================================================================
// MODULE STATE
// ============================================================================

let _initialized = false;
const _elements = {};

// ============================================================================
// DOM TEMPLATE
// ============================================================================

/**
 * Get the HTML template for packet preview
 * @memberof module:Preview
 * @returns {string} HTML template string
 */
export function getTemplate() {
    const section = 'mb-3.5 last:mb-0';
    const sectionTitle = 'text-[11px] text-[var(--gray-500)] uppercase mb-2 pb-1 border-b border-[var(--gray-200)]';
    const row = 'flex justify-between py-1 text-[13px]';
    const lbl = 'text-[var(--gray-600)]';
    const code = 'font-mono text-xs text-[var(--gray-800)] bg-[var(--gray-100)] px-1.5 py-0.5 rounded';

    return `
        <section class="card" id="preview-module">
            <div class="card-header">
                <h2>📦 Packet Preview</h2>
            </div>
            <div class="card-body">
                <div class="${section}">
                    <h5 class="${sectionTitle}">Ethernet Header</h5>
                    <div class="${row}">
                        <span class="${lbl}">Dest MAC:</span>
                        <code id="prevDestMac" class="${code}">01:0C:CD:04:00:00</code>
                    </div>
                    <div class="${row}">
                        <span class="${lbl}">Src MAC:</span>
                        <code id="prevSrcMac" class="${code}">00:00:00:00:00:01</code>
                    </div>
                    <div class="${row}">
                        <span class="${lbl}">EtherType:</span>
                        <code class="${code}">0x88BA</code>
                    </div>
                </div>
                <div class="${section}">
                    <h5 class="${sectionTitle}">SV Header</h5>
                    <div class="${row}">
                        <span class="${lbl}">APPID:</span>
                        <code id="prevAppId" class="${code}">0x4000</code>
                    </div>
                </div>
                <div class="${section}">
                    <h5 class="${sectionTitle}">ASDU</h5>
                    <div class="${row}">
                        <span class="${lbl}">svID:</span>
                        <code id="prevSvId" class="${code}">MU01</code>
                    </div>
                    <div class="${row}">
                        <span class="${lbl}">smpCnt:</span>
                        <code id="prevSmpCnt" class="${code}">0</code>
                    </div>
                    <div class="${row}">
                        <span class="${lbl}">confRev:</span>
                        <code id="prevConfRev" class="${code}">1</code>
                    </div>
                    <div class="${row}">
                        <span class="${lbl}">smpSynch:</span>
                        <code id="prevSmpSynch" class="${code}">2</code>
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
 * Initialize the Preview module
 * @memberof module:Preview
 * @param {HTMLElement} container - Container element to inject template
 */
export function init(container) {
    if (_initialized) {
        console.warn('[Preview] Already initialized');
        return;
    }
    
    console.log('[Preview] Initializing...');
    
    // Inject template
    container.innerHTML = getTemplate();
    
    // Cache elements
    _elements.destMac = document.getElementById('prevDestMac');
    _elements.srcMac = document.getElementById('prevSrcMac');
    _elements.appId = document.getElementById('prevAppId');
    _elements.svId = document.getElementById('prevSvId');
    _elements.smpCnt = document.getElementById('prevSmpCnt');
    _elements.confRev = document.getElementById('prevConfRev');
    _elements.smpSynch = document.getElementById('prevSmpSynch');
    
    // Subscribe to config changes
    _subscribeToStore();
    
    // Initial update
    updatePreview();
    
    _initialized = true;
    console.log('[Preview] ✅ Initialized');
}

// ============================================================================
// STORE SUBSCRIPTION
// ============================================================================

function _subscribeToStore() {
    // Subscribe to all config changes
    store.subscribe('config.*', () => {
        updatePreview();
    });
    
    // Also update when stats change (for smpCnt)
    store.subscribe('data.stats.smpCnt', () => {
        const smpCnt = store.get('data.stats.smpCnt') || 0;
        if (_elements.smpCnt) {
            _elements.smpCnt.textContent = smpCnt;
        }
    });
}

// ============================================================================
// UPDATE PREVIEW
// ============================================================================

/**
 * Update preview display from store values
 * @memberof module:Preview
 */
export function updatePreview() {
    const config = {
        dstMAC: store.get('config.dstMAC') || '01:0C:CD:04:00:00',
        srcMAC: store.get('config.srcMAC') || '00:00:00:00:00:01',
        appID: store.get('config.appID') || 0x4000,
        svID: store.get('config.svID') || 'MU01',
        confRev: store.get('config.confRev') || 1,
        smpSynch: store.get('config.smpSynch') || 2
    };
    
    // Update DOM elements
    if (_elements.destMac) _elements.destMac.textContent = config.dstMAC;
    if (_elements.srcMac) _elements.srcMac.textContent = config.srcMAC;
    if (_elements.appId) {
        const appIdNum = typeof config.appID === 'number' ? config.appID : parseInt(config.appID, 16);
        _elements.appId.textContent = `0x${appIdNum.toString(16).toUpperCase().padStart(4, '0')}`;
    }
    if (_elements.svId) _elements.svId.textContent = config.svID;
    if (_elements.confRev) _elements.confRev.textContent = config.confRev;
    if (_elements.smpSynch) _elements.smpSynch.textContent = config.smpSynch;
}

/**
 * Update smpCnt in preview
 * @memberof module:Preview
 * @param {number} smpCnt - Current sample count
 */
export function updatePreviewSmpCnt(smpCnt) {
    if (_elements.smpCnt) {
        _elements.smpCnt.textContent = smpCnt;
    }
}

// ============================================================================
// PUBLIC API
// ============================================================================

export const Preview = {
    init,
    getTemplate,
    updatePreview,
    updatePreviewSmpCnt
};

export default Preview;
