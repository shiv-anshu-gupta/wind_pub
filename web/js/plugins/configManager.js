/**
 * @file configManager.js
 * @fileoverview Configuration Save/Load Plugin
 * @module configManager
 * @author SV-PUB Team
 * @description
 * Provides configuration persistence - save to JSON file, load from JSON file.
 * 
 * **Features:**
 * - Export current config to JSON file
 * - Import config from JSON file
 * - Apply config to UI elements
 * 
 * @example
 * import { initConfigButtons, saveConfig, loadConfig } from './plugins/configManager.js';
 * initConfigButtons(); // Setup save/load button handlers
 */

import { showToast } from './toast.js';
import { formatDateForFilename } from '../utils/formatters.js';
import { updatePreview } from '../components/preview.js';
import store from '../store/index.js';

/**
 * Initialize config save/load buttons
 * @memberof module:configManager
 */
export function initConfigButtons() {
    const saveBtn = document.getElementById('saveConfigBtn');
    const loadBtn = document.getElementById('loadConfigBtn');

    if (saveBtn) saveBtn.addEventListener('click', saveConfig);
    if (loadBtn) loadBtn.addEventListener('click', loadConfig);
}

/**
 * Save current configuration to a JSON file
 * @memberof module:configManager
 */
export function saveConfig() {
    // Read ALL values from the store — the single source of truth
    const cfg = store.config;
    const channels = store.getChannels();
    const equations = {};
    channels.forEach(ch => { equations[ch.id] = ch.equation; });

    const config = {
        // Standard
        standard: cfg.standard,

        // Network Settings
        srcMac: cfg.srcMAC,
        destMac: cfg.dstMAC,
        appId: typeof cfg.appID === 'number'
            ? cfg.appID.toString(16).toUpperCase().padStart(4, '0')
            : cfg.appID,
        vlanId: cfg.vlanID,

        // SV Parameters
        svId: cfg.svID,
        datSet: cfg.datSet || '',
        frequency: cfg.frequency,
        samplesPerCycle: cfg.samplesPerCycle,
        smpRate: cfg.sampleRate,
        confRev: cfg.confRev,
        smpSynch: cfg.smpSynch,

        // Equations (from store channels)
        equations,

        // Selected channels order
        selectedChannels: cfg.selectedChannels,

        // Playback options (still from DOM as they're not in the store)
        loopPlayback: document.getElementById('loopPlayback')?.checked,
        playbackSpeed: document.getElementById('playbackSpeed')?.value,

        // Metadata
        savedAt: new Date().toISOString(),
        version: '2.0'
    };

    console.log('[ConfigManager] Saving config from store:', {
        frequency: config.frequency,
        samplesPerCycle: config.samplesPerCycle,
        sampleRate: config.smpRate
    });

    // Convert to JSON
    const configJson = JSON.stringify(config, null, 2);

    // Create download
    const blob = new Blob([configJson], { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = 'sv-publisher-config-' + formatDateForFilename() + '.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    showToast('Configuration saved to file');
}

/**
 * Load configuration from a JSON file
 * @memberof module:configManager
 */
export function loadConfig() {
    // Create file input
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = '.json';

    fileInput.addEventListener('change', function(e) {
        const file = e.target.files[0];
        if (!file) return;

        const reader = new FileReader();

        reader.onload = function(event) {
            try {
                const config = JSON.parse(event.target.result);
                applyConfig(config);
                showToast('Configuration loaded: ' + file.name);
            } catch (error) {
                showToast('Invalid configuration file', 'error');
                console.error('Config load error:', error);
            }
        };

        reader.readAsText(file);
    });

    fileInput.click();
}

/**
 * Apply configuration object to form inputs
 * @memberof module:configManager
 * @param {Object} config - Configuration object
 */
export function applyConfig(config) {
    console.log('[ConfigManager] Applying loaded config to store:', {
        frequency: config.frequency,
        samplesPerCycle: config.samplesPerCycle,
        sampleRate: config.smpRate
    });

    // Apply Standard first (rebuilds channels, etc.)
    if (config.standard) {
        store.setStandard(config.standard);
    }

    // Apply config values to the store in one batch
    store.batch(() => {
        // Network Settings
        if (config.srcMac) store.setConfig({ srcMAC: config.srcMac });
        if (config.destMac) store.setConfig({ dstMAC: config.destMac });
        if (config.appId) {
            const appId = typeof config.appId === 'string'
                ? parseInt(config.appId, 16)
                : config.appId;
            store.setConfig({ appID: appId || 0x4000 });
        }
        if (config.vlanId !== undefined) store.setConfig({ vlanID: parseInt(config.vlanId) || 0 });

        // SV Parameters
        if (config.svId) store.setConfig({ svID: config.svId });
        if (config.datSet !== undefined) store.setConfig({ datSet: config.datSet });
        if (config.frequency) store.setConfig({ frequency: parseInt(config.frequency) || 60 });
        if (config.samplesPerCycle) store.setConfig({ samplesPerCycle: parseInt(config.samplesPerCycle) || 80 });
        if (config.confRev) store.setConfig({ confRev: parseInt(config.confRev) || 1 });
        if (config.smpSynch !== undefined) store.setConfig({ smpSynch: parseInt(config.smpSynch) || 0 });
    });

    // Apply Equations to store channels
    if (config.equations) {
        for (const [channelId, equation] of Object.entries(config.equations)) {
            if (equation) {
                store.updateEquation(channelId, equation);
            }
        }
    }

    // Apply selected channels if present
    if (config.selectedChannels && Array.isArray(config.selectedChannels)) {
        store.setSelectedChannels(config.selectedChannels);
    }

    // Apply Playback options (still DOM-only, not in store)
    if (config.loopPlayback !== undefined) {
        const loopEl = document.getElementById('loopPlayback');
        if (loopEl) loopEl.checked = config.loopPlayback;
    }
    if (config.playbackSpeed) {
        const speedEl = document.getElementById('playbackSpeed');
        if (speedEl) speedEl.value = config.playbackSpeed;
    }

    // Update preview
    updatePreview();
    
    console.log('[ConfigManager] Config applied. Store sampleRate:', store.get('config.sampleRate'));
}
