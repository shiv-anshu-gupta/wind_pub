/**
 * @module DataSource
 * @file modules/DataSource.js
 * @description Data Source Module for PCAP and Equation selection.
 * Handles tabs, PCAP upload, and equation editor integration.
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
let activeTab = 'pcap';

// ============================================================================
// DOM TEMPLATE
// ============================================================================

/**
 * Get the HTML template for this module
 * @memberof module:DataSource
 * @returns {string} HTML template string
 */
export function getTemplate() {
    // `.tab`, `.tab-content`, `.active`, `.dragover` kept as JS marker classes.
    const tab = [
        'tab flex-1 flex items-center justify-center gap-2 py-2.5 px-2.5',
        'border-0 bg-transparent rounded-md text-[13px] font-medium',
        'text-[var(--gray-600)] hover:text-[var(--gray-800)] cursor-pointer',
        'transition-all duration-200',
        '[&.active]:bg-[var(--card-bg)] [&.active]:text-[var(--primary)] [&.active]:shadow-[var(--shadow)]',
    ].join(' ');
    const tabContent = 'tab-content';
    const dropZone = [
        'border-2 border-dashed border-[var(--gray-300)] rounded-[var(--radius)]',
        'py-10 px-5 text-center cursor-pointer transition-all duration-200',
        'hover:border-[var(--primary)] hover:bg-blue-500/[0.02]',
        '[&.dragover]:border-[var(--primary)] [&.dragover]:bg-blue-500/[0.05]',
    ].join(' ');
    const pcapStat = 'text-center [&_.stat-value]:block [&_.stat-value]:text-[18px] [&_.stat-value]:font-bold [&_.stat-value]:text-[var(--gray-800)] [&_.stat-label]:text-[11px] [&_.stat-label]:text-[var(--gray-500)] [&_.stat-label]:uppercase';

    return `
        <section class="card" id="data-source-module">
            <div class="card-header">
                <h2>Data Source</h2>
            </div>
            <div class="card-body">
                <!-- Tabs -->
                <div class="flex gap-1 bg-[var(--gray-100)] p-1 rounded-[var(--radius)] mb-4" id="dataSourceTabs">
                    <button class="${tab} active" data-tab="pcap">
                        <span class="text-base">📁</span>
                        PCAP File
                    </button>
                    <button class="${tab}" data-tab="equation">
                        <span class="text-base">📐</span>
                        Equation Editor
                    </button>
                </div>

                <!-- PCAP Tab -->
                <div class="${tabContent} active" id="pcap-tab">
                    <!-- Upload Area -->
                    <div class="${dropZone}" id="pcapDropZone">
                        <div class="text-5xl mb-3">📁</div>
                        <p class="font-medium text-[var(--gray-700)] mb-1">Drag & drop PCAP file here</p>
                        <p class="text-[13px] text-[var(--gray-500)]">or click to browse</p>
                        <p class="text-xs text-[var(--gray-400)] mt-2">Supports: .pcap, .pcapng</p>
                        <input type="file" id="pcapFile" accept=".pcap,.pcapng" hidden>
                    </div>

                    <!-- PCAP Info (shown after loading) -->
                    <div class="hidden bg-[var(--gray-50)] rounded-[var(--radius)] p-4" id="pcapInfo">
                        <div class="flex items-center gap-2.5 mb-4 pb-3 border-b border-[var(--gray-200)]">
                            <span class="text-2xl">📄</span>
                            <span class="flex-1 font-medium" id="pcapFileName">capture.pcap</span>
                            <button class="btn btn-small btn-danger" id="removePcap">✕ Remove</button>
                        </div>
                        <div class="grid grid-cols-4 gap-3 mb-4">
                            <div class="${pcapStat}">
                                <span class="stat-value" id="pcapPackets">0</span>
                                <span class="stat-label">Packets</span>
                            </div>
                            <div class="${pcapStat}">
                                <span class="stat-value" id="pcapDuration">0s</span>
                                <span class="stat-label">Duration</span>
                            </div>
                            <div class="${pcapStat}">
                                <span class="stat-value" id="pcapStreams">0</span>
                                <span class="stat-label">Streams</span>
                            </div>
                            <div class="${pcapStat}">
                                <span class="stat-value" id="pcapRate">0/s</span>
                                <span class="stat-label">Rate</span>
                            </div>
                        </div>
                        <div class="flex justify-between items-center">
                            <label class="flex items-center gap-2 text-sm cursor-pointer [&_input]:w-4 [&_input]:h-4 [&_input]:accent-[var(--primary)]">
                                <input type="checkbox" id="loopPlayback">
                                <span>Loop continuously</span>
                            </label>
                            <div class="flex items-center gap-2">
                                <label for="playbackSpeed" class="text-[13px] text-[var(--gray-600)]">Speed:</label>
                                <select id="playbackSpeed" class="py-1.5 px-2.5 border border-[var(--gray-300)] rounded-md text-[13px]">
                                    <option value="1" selected>1x (Real-time)</option>
                                    <option value="0">Max Speed</option>
                                </select>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- Equation Editor Tab -->
                <div class="${tabContent}" id="equation-tab">
                    <!-- Hidden inputs to store equation values (initialized from store) -->
                    ${store.getChannels().map(ch => `
                        <input type="hidden" id="eq${ch.id}" value="${ch.equation}">
                    `).join('')}

                    <!-- Embedded MathLive Editor Container -->
                    <div id="embeddedEditorContainer">
                        <div class="flex flex-col items-center justify-center p-10 text-[var(--gray-500)] gap-3 [&_.loading-icon]:text-2xl [&_.loading-icon]:animate-pulse">
                            <span class="loading-icon">⏳</span>
                            <span>Loading Equation Editor...</span>
                        </div>
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
 * @memberof module:DataSource
 * @param {HTMLElement} container - Container element to render into (optional)
 */
export function init(container = null) {
    if (initialized) {
        console.warn('[DataSource] Already initialized');
        return;
    }

    // If container provided, inject template
    if (container) {
        container.innerHTML = getTemplate();
    }

    // Cache DOM elements
    cacheElements();

    // Bind events
    bindEvents();

    // Set initial values from store
    syncFromStore();

    // Subscribe to store changes
    store.subscribe('data.pcap', syncPcapFromStore);
    store.subscribe('data.equations', syncEquationsFromStore);
    store.subscribe('data.channels', syncEquationsFromStore);
    store.subscribe('config.frequency', syncEquationsFromStore);
    store.subscribe('data.publishing.mode', (mode) => {
        activeTab = mode;
        updateActiveSource();
    });

    initialized = true;
    console.log('[DataSource] Initialized');
}

function cacheElements() {
    // Tabs
    elements.tabs = document.querySelectorAll('#dataSourceTabs .tab');
    elements.tabContents = {
        pcap: document.getElementById('pcap-tab'),
        equation: document.getElementById('equation-tab')
    };

    // PCAP elements
    elements.dropZone = document.getElementById('pcapDropZone');
    elements.fileInput = document.getElementById('pcapFile');
    elements.pcapInfo = document.getElementById('pcapInfo');
    elements.pcapFileName = document.getElementById('pcapFileName');
    elements.pcapPackets = document.getElementById('pcapPackets');
    elements.pcapDuration = document.getElementById('pcapDuration');
    elements.pcapStreams = document.getElementById('pcapStreams');
    elements.pcapRate = document.getElementById('pcapRate');
    elements.removePcap = document.getElementById('removePcap');
    elements.loopPlayback = document.getElementById('loopPlayback');
    elements.playbackSpeed = document.getElementById('playbackSpeed');

    // Equation elements (hidden inputs - dynamically built from store channels)
    elements.equations = {};
    store.getChannels().forEach(ch => {
        const el = document.getElementById(`eq${ch.id}`);
        if (el) elements.equations[ch.id] = el;
    });

    // Active source display
    elements.activeSource = document.getElementById('activeSource');
}

// ============================================================================
// EVENT BINDING
// ============================================================================

function bindEvents() {
    // Tab switching
    elements.tabs?.forEach(tab => {
        tab.addEventListener('click', () => handleTabClick(tab));
    });

    // PCAP drop zone
    if (elements.dropZone) {
        elements.dropZone.addEventListener('click', () => elements.fileInput?.click());
        elements.dropZone.addEventListener('dragover', handleDragOver);
        elements.dropZone.addEventListener('dragleave', handleDragLeave);
        elements.dropZone.addEventListener('drop', handleDrop);
    }

    // File input
    elements.fileInput?.addEventListener('change', handleFileSelect);

    // Remove PCAP button
    elements.removePcap?.addEventListener('click', removePcap);

    // Equation hidden input changes (for external editors)
    Object.entries(elements.equations).forEach(([id, input]) => {
        input?.addEventListener('change', () => {
            // Update equation in channels array
            const channels = store.data.channels || [];
            const updatedChannels = channels.map(ch => 
                ch.id === id ? { ...ch, equation: input.value } : ch
            );
            store.setData({ channels: updatedChannels });
        });
    });
}

// ============================================================================
// TAB HANDLING
// ============================================================================

function handleTabClick(tab) {
    const tabName = tab.dataset.tab;
    if (tabName === activeTab) return;

    // Update active tab
    activeTab = tabName;

    // Update tab buttons
    elements.tabs.forEach(t => {
        t.classList.toggle('active', t.dataset.tab === tabName);
    });

    // Update tab contents
    Object.entries(elements.tabContents).forEach(([name, content]) => {
        content?.classList.toggle('active', name === tabName);
    });

    // Update store
    store.setData({ publishing: { mode: tabName } });

    // Update active source display
    updateActiveSource();

    console.log('[DataSource] Tab switched to:', tabName);
}

function updateActiveSource() {
    if (elements.activeSource) {
        if (activeTab === 'pcap') {
            elements.activeSource.textContent = store.data.pcap.loaded 
                ? `PCAP: ${store.data.pcap.filename}` 
                : 'PCAP File';
        } else {
            elements.activeSource.textContent = 'Equation Editor';
        }
    }
}

// ============================================================================
// PCAP HANDLING
// ============================================================================

function handleDragOver(e) {
    e.preventDefault();
    e.stopPropagation();
    elements.dropZone.classList.add('dragover');
}

function handleDragLeave(e) {
    e.preventDefault();
    e.stopPropagation();
    elements.dropZone.classList.remove('dragover');
}

function handleDrop(e) {
    e.preventDefault();
    e.stopPropagation();
    elements.dropZone.classList.remove('dragover');

    const files = e.dataTransfer?.files;
    if (files?.length > 0) {
        uploadPcap(files[0]);
    }
}

function handleFileSelect(e) {
    const file = e.target.files?.[0];
    if (file) {
        uploadPcap(file);
    }
}

async function uploadPcap(file) {
    // Validate file type
    if (!file.name.match(/\.(pcap|pcapng)$/i)) {
        showToast('Please upload a .pcap or .pcapng file', 'error');
        return;
    }

    showToast('Uploading PCAP file...', 'info');

    const formData = new FormData();
    formData.append('pcap', file);

    try {
        const response = await fetch('/api/pcap/upload', {
            method: 'POST',
            body: formData
        });

        const result = await response.json();

        if (result.success) {
            // Update store
            store.setData({
                pcap: {
                    loaded: true,
                    filename: file.name,
                    frameCount: result.frameCount || 0,
                    duration: result.duration || 0
                }
            });

            // Update UI
            showPcapInfo(file.name, result);
            showToast(`Loaded ${result.frameCount?.toLocaleString()} packets`, 'success');
        } else {
            showToast(result.error || 'Failed to load PCAP', 'error');
        }
    } catch (err) {
        console.error('[DataSource] PCAP upload failed:', err);
        showToast('Failed to upload PCAP file', 'error');
    }
}

function showPcapInfo(filename, data) {
    elements.dropZone?.classList.add('hidden');
    elements.pcapInfo?.classList.remove('hidden');

    if (elements.pcapFileName) elements.pcapFileName.textContent = filename;
    if (elements.pcapPackets) elements.pcapPackets.textContent = (data.frameCount || 0).toLocaleString();
    if (elements.pcapDuration) elements.pcapDuration.textContent = `${(data.duration || 0).toFixed(1)}s`;
    if (elements.pcapStreams) elements.pcapStreams.textContent = data.streams || '1';
    if (elements.pcapRate) {
        const rate = data.duration > 0 ? Math.round(data.frameCount / data.duration) : 0;
        elements.pcapRate.textContent = `${rate.toLocaleString()}/s`;
    }

    updateActiveSource();
}

async function removePcap() {
    try {
        await fetch('/api/pcap', { method: 'DELETE' });
    } catch (e) {
        console.warn('[DataSource] Failed to notify server of PCAP removal');
    }

    // Update store
    store.setData({
        pcap: {
            loaded: false,
            filename: '',
            frameCount: 0,
            duration: 0
        }
    });

    // Update UI
    elements.dropZone?.classList.remove('hidden');
    elements.pcapInfo?.classList.add('hidden');
    elements.fileInput.value = '';

    updateActiveSource();
    showToast('PCAP file removed');
}

// ============================================================================
// SYNC
// ============================================================================

function syncFromStore() {
    syncPcapFromStore();
    syncEquationsFromStore();
}

function syncPcapFromStore() {
    const pcap = store.data.pcap;
    if (pcap.loaded) {
        showPcapInfo(pcap.filename, {
            frameCount: pcap.frameCount,
            duration: pcap.duration
        });
    } else {
        elements.dropZone?.classList.remove('hidden');
        elements.pcapInfo?.classList.add('hidden');
    }
}

function syncEquationsFromStore() {
    // Get equations from unified channels array
    const channels = store.data.channels || [];
    const equations = {};
    channels.forEach(ch => {
        equations[ch.id] = ch.equation;
    });
    
    // Update existing hidden inputs and create new ones for new channels
    channels.forEach(ch => {
        let input = elements.equations[ch.id] || document.getElementById(`eq${ch.id}`);
        if (input) {
            input.value = ch.equation;
        } else {
            // Create hidden input for new channel
            const container = document.getElementById('equation-tab');
            if (container) {
                input = document.createElement('input');
                input.type = 'hidden';
                input.id = `eq${ch.id}`;
                input.value = ch.equation;
                container.appendChild(input);
                elements.equations[ch.id] = input;
            }
        }
    });
}

// ============================================================================
// PUBLIC API
// ============================================================================

/**
 * Get active tab
 * @memberof module:DataSource
 * @returns {string} Active tab name
 */
export function getActiveTab() {
    return activeTab;
}

/**
 * Check if PCAP is loaded
 * @memberof module:DataSource
 * @returns {boolean}
 */
export function isPcapLoaded() {
    return store.data.pcap.loaded;
}

/**
 * Get equations
 * @memberof module:DataSource
 * @returns {Object} Channel IDs as keys and equations as values
 */
export function getEquations() {
    const channels = store.data.channels || [];
    const equations = {};
    channels.forEach(ch => {
        equations[ch.id] = ch.equation;
    });
    return equations;
}

/**
 * Set equation value
 * @memberof module:DataSource
 * @param {string} id - Channel ID
 * @param {string} value - Equation value
 */
export function setEquation(id, value) {
    const channels = store.data.channels || [];
    const updatedChannels = channels.map(ch => 
        ch.id === id ? { ...ch, equation: value } : ch
    );
    store.setData({ channels: updatedChannels });
}

/**
 * Switch to tab
 * @memberof module:DataSource
 * @param {string} tabName - Tab name to switch to
 */
export function switchTab(tabName) {
    const tab = Array.from(elements.tabs || []).find(t => t.dataset.tab === tabName);
    if (tab) {
        handleTabClick(tab);
    }
}

/**
 * Destroy module
 * @memberof module:DataSource
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
    getActiveTab,
    isPcapLoaded,
    getEquations,
    setEquation,
    switchTab,
    destroy
};
