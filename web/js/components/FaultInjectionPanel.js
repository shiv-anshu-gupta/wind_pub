/**
 * @module FaultInjectionPanel
 * @file components/FaultInjectionPanel.js
 * @description Fault Injection Panel for Subscriber Stress Testing.
 * 
 * Allows injecting network/protocol faults into the SV packet stream:
 *   - Packet loss, duplication, burst loss
 *   - Timing faults (jitter, fixed delay)
 *   - Data corruption (smpCnt, values, BER, smpSynch, channel count)
 *   - Stream interruption
 * 
 * Sends config as JSON to C++ backend via Tauri FFI.
 * Stats are polled every 1 second when enabled.
 */

import * as tauriClient from '../utils/tauriClient.js';
import store from '../store/index.js';

// ============================================================================
// MODULE STATE
// ============================================================================

let _initialized = false;
let _statsTimer = null;

const _el = {};

// ============================================================================
// PRESETS
// ============================================================================

const PRESETS = {
    lightLoss: {
        label: 'Light Loss',
        desc: 'Basic robustness test',
        config: { packetLossRate: 0.02, enabled: true }
    },
    heavyLoss: {
        label: 'Heavy Loss',
        desc: '15% loss + burst',
        config: { packetLossRate: 0.15, burstLossCount: 200, burstLossIntervalSec: 10, enabled: true }
    },
    dataChaos: {
        label: 'Data Chaos',
        desc: 'Corrupt smpCnt, values, BER',
        config: { corruptSmpCntRate: 0.05, corruptValuesRate: 0.05, corruptBerRate: 0.02, enabled: true }
    },
    timingStress: {
        label: 'Timing Stress',
        desc: 'Jitter + delay',
        config: { jitterMaxUs: 50, fixedDelayUs: 5000, enabled: true }
    },
    streamFlicker: {
        label: 'Stream Flicker',
        desc: 'Stop 3s every 15s',
        config: { streamInterruption: true, interruptDurationSec: 3, interruptIntervalSec: 15, enabled: true }
    },
    reorderStorm: {
        label: 'Reorder Storm',
        desc: '5% out-of-order, release after 5',
        config: { reorderRate: 0.05, reorderSamplesAfter: 5, enabled: true }
    },
    fullChaos: {
        label: 'Full Chaos',
        desc: 'All faults moderate',
        config: {
            packetLossRate: 0.03, duplicateRate: 0.02,
            reorderRate: 0.02, reorderSamplesAfter: 4,
            burstLossCount: 100, burstLossIntervalSec: 20,
            jitterMaxUs: 30,
            corruptSmpCntRate: 0.02, corruptValuesRate: 0.02,
            wrongSmpSynchRate: 0.01, corruptBerRate: 0.01,
            streamInterruption: true, interruptDurationSec: 2, interruptIntervalSec: 30,
            enabled: true
        }
    }
};

// ============================================================================
// TEMPLATE
// ============================================================================

function getTemplate() {
    const sectionTitle = 'font-semibold text-[0.8rem] uppercase tracking-wider text-[var(--text-secondary,#718096)] mb-1.5 pb-0.5 border-b border-[var(--border-color,#e2e8f0)]';
    const sliderRow = 'grid grid-cols-[120px_1fr_55px] items-center gap-2 mb-1 text-[0.85rem]';
    const slider = 'w-full h-1 cursor-pointer';
    const valueLbl = 'text-right font-mono text-[0.8rem] text-[var(--text-secondary,#718096)]';
    const inlineFields = 'flex items-center gap-1.5 text-[0.85rem] flex-wrap mb-1';
    const numInput = 'w-[60px] px-1 py-0.5 border border-[var(--border-color,#e2e8f0)] rounded-[3px] text-[0.85rem] text-center bg-[var(--bg-primary,#fff)] text-[var(--text-primary,#1a202c)]';
    const toggleLabel = 'flex items-center gap-2 cursor-pointer font-medium';
    const stat = 'flex flex-col items-center p-1 bg-[var(--bg-secondary,#f7fafc)] rounded';

    return `
        <section class="card card-danger" id="fault-injection-module">
            <div class="card-header cursor-pointer" id="faultInjHeader">
                <h2><i data-lucide="triangle-alert" class="header-icon"></i> Fault Injection</h2>
                <span class="card-subtitle">Subscriber Stress Test</span>
            </div>
            <div class="card-body" id="faultInjBody">
                <!-- Warning Banner -->
                <div id="fiWarningBanner" class="hidden bg-red-600 text-white py-1.5 px-3 rounded font-semibold text-center mb-2.5 animate-pulse">
                    ⚠️ FAULT INJECTION ACTIVE — subscriber receiving corrupted data
                </div>

                <!-- Master Switch -->
                <div class="mb-3 py-2 border-b border-[var(--border-color,#e2e8f0)]">
                    <label class="${toggleLabel}">
                        <input type="checkbox" id="fiEnabledCheckbox">
                        <span>Enable Fault Injection</span>
                    </label>
                </div>

                <!-- Presets -->
                <div class="mb-2.5">
                    <div class="${sectionTitle}">Presets</div>
                    <div class="flex flex-wrap gap-1 mb-1" id="fiPresets">
                        <button class="btn btn-outline btn-xs text-[0.75rem] py-0.5 px-2" data-preset="lightLoss" title="Basic robustness">Light Loss</button>
                        <button class="btn btn-outline btn-xs text-[0.75rem] py-0.5 px-2" data-preset="heavyLoss" title="15% loss + burst">Heavy Loss</button>
                        <button class="btn btn-outline btn-xs text-[0.75rem] py-0.5 px-2" data-preset="dataChaos" title="Corrupt data">Data Chaos</button>
                        <button class="btn btn-outline btn-xs text-[0.75rem] py-0.5 px-2" data-preset="timingStress" title="Jitter + delay">Timing</button>
                        <button class="btn btn-outline btn-xs text-[0.75rem] py-0.5 px-2" data-preset="streamFlicker" title="Stream stop">Flicker</button>
                        <button class="btn btn-outline btn-xs text-[0.75rem] py-0.5 px-2" data-preset="reorderStorm" title="Out-of-order packets">Reorder</button>
                        <button class="btn btn-outline btn-xs text-[0.75rem] py-0.5 px-2" data-preset="fullChaos" title="Everything">Full Chaos</button>
                    </div>
                </div>

                <!-- Packet Faults -->
                <div class="mb-2.5">
                    <div class="${sectionTitle}">Packet Faults</div>
                    <div class="${sliderRow}">
                        <label>Packet Loss</label>
                        <input type="range" id="fiPacketLoss" min="0" max="50" step="0.5" value="0" class="${slider}">
                        <span class="${valueLbl}" id="fiPacketLossVal">0%</span>
                    </div>
                    <div class="${sliderRow}">
                        <label>Duplicate</label>
                        <input type="range" id="fiDuplicate" min="0" max="20" step="0.5" value="0" class="${slider}">
                        <span class="${valueLbl}" id="fiDuplicateVal">0%</span>
                    </div>
                    <div class="${inlineFields}">
                        <label>Burst Loss:</label>
                        <input type="number" id="fiBurstCount" value="0" min="0" max="10000" class="${numInput}" placeholder="pkts">
                        <span>every</span>
                        <input type="number" id="fiBurstInterval" value="0" min="0" max="300" class="${numInput}" placeholder="sec">
                        <span>sec</span>
                    </div>
                </div>

                <!-- Out-of-Order Faults -->
                <div class="mb-2.5">
                    <div class="${sectionTitle}">Out of Order</div>
                    <div class="${sliderRow}">
                        <label>Reorder Rate</label>
                        <input type="range" id="fiReorderRate" min="0" max="20" step="0.5" value="0" class="${slider}">
                        <span class="${valueLbl}" id="fiReorderRateVal">0%</span>
                    </div>
                    <div class="${inlineFields}">
                        <label>Release after:</label>
                        <input type="number" id="fiReorderSamplesAfter" value="3" min="1" max="1000" class="${numInput}">
                        <span>samples</span>
                    </div>
                </div>

                <!-- Timing Faults -->
                <div class="mb-2.5">
                    <div class="${sectionTitle}">Timing Faults</div>
                    <div class="${sliderRow}">
                        <label>Jitter</label>
                        <input type="range" id="fiJitter" min="0" max="100" step="1" value="0" class="${slider}">
                        <span class="${valueLbl}" id="fiJitterVal">0 μs</span>
                    </div>
                    <div class="${sliderRow}">
                        <label>Fixed Delay</label>
                        <input type="range" id="fiFixedDelay" min="0" max="50000" step="100" value="0" class="${slider}">
                        <span class="${valueLbl}" id="fiFixedDelayVal">0 μs</span>
                    </div>
                </div>

                <!-- Data Corruption -->
                <div class="mb-2.5">
                    <div class="${sectionTitle}">Data Corruption</div>
                    <div class="${sliderRow}">
                        <label>Corrupt smpCnt</label>
                        <input type="range" id="fiCorruptSmpCnt" min="0" max="10" step="0.1" value="0" class="${slider}">
                        <span class="${valueLbl}" id="fiCorruptSmpCntVal">0%</span>
                    </div>
                    <div class="${sliderRow}">
                        <label>Corrupt Values</label>
                        <input type="range" id="fiCorruptValues" min="0" max="10" step="0.1" value="0" class="${slider}">
                        <span class="${valueLbl}" id="fiCorruptValuesVal">0%</span>
                    </div>
                    <div class="${sliderRow}">
                        <label>Wrong Channel Count</label>
                        <input type="range" id="fiCorruptChannelCount" min="0" max="5" step="0.1" value="0" class="${slider}">
                        <span class="${valueLbl}" id="fiCorruptChannelCountVal">0%</span>
                    </div>
                    <div class="${sliderRow}">
                        <label>Wrong smpSynch</label>
                        <input type="range" id="fiWrongSmpSynch" min="0" max="10" step="0.1" value="0" class="${slider}">
                        <span class="${valueLbl}" id="fiWrongSmpSynchVal">0%</span>
                    </div>
                    <div class="${sliderRow}">
                        <label>Corrupt BER</label>
                        <input type="range" id="fiCorruptBer" min="0" max="5" step="0.1" value="0" class="${slider}">
                        <span class="${valueLbl}" id="fiCorruptBerVal">0%</span>
                    </div>
                </div>

                <!-- Stream Faults -->
                <div class="mb-2.5">
                    <div class="${sectionTitle}">Stream Faults</div>
                    <div class="${inlineFields}">
                        <label class="${toggleLabel}">
                            <input type="checkbox" id="fiStreamInterrupt">
                            <span>Stream Interruption:</span>
                        </label>
                        <span>stop</span>
                        <input type="number" id="fiInterruptDuration" value="5" min="1" max="60" class="${numInput}">
                        <span>sec every</span>
                        <input type="number" id="fiInterruptInterval" value="30" min="5" max="300" class="${numInput}">
                        <span>sec</span>
                    </div>
                </div>

                <!-- Live Stats -->
                <div class="mb-2.5" id="fiStatsSection">
                    <div class="${sectionTitle}">Live Stats</div>
                    <div class="grid grid-cols-[repeat(auto-fit,minmax(90px,1fr))] gap-1.5">
                        <div class="${stat}"><span class="text-[0.7rem] text-[var(--text-secondary,#718096)] uppercase">Processed</span><span class="text-base font-semibold font-mono" id="fiStatProcessed">0</span></div>
                        <div class="${stat}"><span class="text-[0.7rem] text-[var(--text-secondary,#718096)] uppercase">Dropped</span><span class="text-base font-semibold font-mono" id="fiStatDropped">0</span></div>
                        <div class="${stat}"><span class="text-[0.7rem] text-[var(--text-secondary,#718096)] uppercase">Duplicated</span><span class="text-base font-semibold font-mono" id="fiStatDuped">0</span></div>
                        <div class="${stat}"><span class="text-[0.7rem] text-[var(--text-secondary,#718096)] uppercase">Corrupted</span><span class="text-base font-semibold font-mono" id="fiStatCorrupt">0</span></div>
                        <div class="${stat}"><span class="text-[0.7rem] text-[var(--text-secondary,#718096)] uppercase">Interrupted</span><span class="text-base font-semibold font-mono" id="fiStatInterrupted">0</span></div>
                        <div class="${stat}"><span class="text-[0.7rem] text-[var(--text-secondary,#718096)] uppercase">Reordered</span><span class="text-base font-semibold font-mono" id="fiStatReordered">0</span></div>
                    </div>
                </div>

                <!-- Actions -->
                <div class="flex gap-2 mt-2.5">
                    <button class="btn btn-primary btn-sm" id="fiApplyBtn">Apply</button>
                    <button class="btn btn-outline btn-sm" id="fiResetBtn">Reset All to 0</button>
                </div>
            </div>
        </section>
    `;
}

// ============================================================================
// HELPERS
// ============================================================================

function formatNum(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
    return String(n);
}

/**
 * Read every slider/input into a config object.
 * Single source of truth for what gets sent to backend AND what gets
 * mirrored into the store, so re-applies always match what the UI shows.
 */
function readUiConfig() {
    return {
        packetLossRate: parseFloat(_el.packetLoss.value) / 100,
        duplicateRate: parseFloat(_el.duplicate.value) / 100,
        reorderRate: parseFloat(_el.reorderRate.value) / 100,
        reorderSamplesAfter: parseInt(_el.reorderSamplesAfter.value) || 0,
        burstLossCount: parseInt(_el.burstCount.value) || 0,
        burstLossIntervalSec: parseInt(_el.burstInterval.value) || 0,
        jitterMaxUs: parseInt(_el.jitter.value) || 0,
        fixedDelayUs: parseInt(_el.fixedDelay.value) || 0,
        corruptSmpCntRate: parseFloat(_el.corruptSmpCnt.value) / 100,
        corruptValuesRate: parseFloat(_el.corruptValues.value) / 100,
        corruptChannelCountRate: parseFloat(_el.corruptChannelCount.value) / 100,
        wrongSmpSynchRate: parseFloat(_el.wrongSmpSynch.value) / 100,
        corruptBerRate: parseFloat(_el.corruptBer.value) / 100,
        streamInterruption: _el.streamInterrupt.checked,
        interruptDurationSec: parseInt(_el.interruptDuration.value) || 5,
        interruptIntervalSec: parseInt(_el.interruptInterval.value) || 30,
        enabled: _el.enabledCheckbox.checked,
    };
}


function setSliderValues(config) {
    _el.packetLoss.value = (config.packetLossRate || 0) * 100;
    _el.duplicate.value = (config.duplicateRate || 0) * 100;
    _el.reorderRate.value = (config.reorderRate || 0) * 100;
    if (config.reorderSamplesAfter !== undefined) {
        _el.reorderSamplesAfter.value = config.reorderSamplesAfter;
    }
    _el.burstCount.value = config.burstLossCount || 0;
    _el.burstInterval.value = config.burstLossIntervalSec || 0;
    _el.jitter.value = config.jitterMaxUs || 0;
    _el.fixedDelay.value = config.fixedDelayUs || 0;
    _el.corruptSmpCnt.value = (config.corruptSmpCntRate || 0) * 100;
    _el.corruptValues.value = (config.corruptValuesRate || 0) * 100;
    _el.corruptChannelCount.value = (config.corruptChannelCountRate || 0) * 100;
    _el.wrongSmpSynch.value = (config.wrongSmpSynchRate || 0) * 100;
    _el.corruptBer.value = (config.corruptBerRate || 0) * 100;
    _el.streamInterrupt.checked = config.streamInterruption || false;
    _el.interruptDuration.value = config.interruptDurationSec || 5;
    _el.interruptInterval.value = config.interruptIntervalSec || 30;
    if (config.enabled !== undefined) {
        _el.enabledCheckbox.checked = config.enabled;
    }
    updateAllLabels();
}

function updateAllLabels() {
    _el.packetLossVal.textContent = parseFloat(_el.packetLoss.value).toFixed(1) + '%';
    _el.duplicateVal.textContent = parseFloat(_el.duplicate.value).toFixed(1) + '%';
    _el.reorderRateVal.textContent = parseFloat(_el.reorderRate.value).toFixed(1) + '%';
    _el.jitterVal.textContent = _el.jitter.value + ' μs';
    _el.fixedDelayVal.textContent = _el.fixedDelay.value + ' μs';
    _el.corruptSmpCntVal.textContent = parseFloat(_el.corruptSmpCnt.value).toFixed(1) + '%';
    _el.corruptValuesVal.textContent = parseFloat(_el.corruptValues.value).toFixed(1) + '%';
    _el.corruptChannelCountVal.textContent = parseFloat(_el.corruptChannelCount.value).toFixed(1) + '%';
    _el.wrongSmpSynchVal.textContent = parseFloat(_el.wrongSmpSynch.value).toFixed(1) + '%';
    _el.corruptBerVal.textContent = parseFloat(_el.corruptBer.value).toFixed(1) + '%';

    /* Warning banner */
    const isEnabled = _el.enabledCheckbox.checked;
    _el.warningBanner.style.display = isEnabled ? 'block' : 'none';
}

async function applyConfig() {
    try {
        const cfg = readUiConfig();
        // Mirror into store FIRST so the UI's source of truth is set even if
        // the backend RPC fails — subscribers see the intended state and a
        // restart can re-apply the same config from the store.
        store.setConfig({ faultInjection: cfg });
        await tauriClient.setFaultInjectionConfig(JSON.stringify(cfg));
        console.log('[FaultInjection] Config applied');
    } catch (e) {
        console.error('[FaultInjection] Apply failed:', e);
    }
}

async function resetAll() {
    /* Set all sliders to 0 */
    _el.packetLoss.value = 0;
    _el.duplicate.value = 0;
    _el.reorderRate.value = 0;
    _el.reorderSamplesAfter.value = 3;
    _el.burstCount.value = 0;
    _el.burstInterval.value = 0;
    _el.jitter.value = 0;
    _el.fixedDelay.value = 0;
    _el.corruptSmpCnt.value = 0;
    _el.corruptValues.value = 0;
    _el.corruptChannelCount.value = 0;
    _el.wrongSmpSynch.value = 0;
    _el.corruptBer.value = 0;
    _el.streamInterrupt.checked = false;
    _el.interruptDuration.value = 5;
    _el.interruptInterval.value = 30;
    _el.enabledCheckbox.checked = false;
    updateAllLabels();
    await applyConfig();
    /* Reset stats */
    try {
        await tauriClient.resetFaultInjectionStats();
        updateStatsDisplay({ totalProcessed: 0, dropCount: 0, dupCount: 0, corruptCount: 0, interruptedCount: 0, reorderCount: 0 });
    } catch (e) { /* ignore */ }
}

function updateStatsDisplay(stats) {
    if (_el.statProcessed) _el.statProcessed.textContent = formatNum(stats.totalProcessed || 0);
    if (_el.statDropped) _el.statDropped.textContent = formatNum(stats.dropCount || 0);
    if (_el.statDuped) _el.statDuped.textContent = formatNum(stats.dupCount || 0);
    if (_el.statCorrupt) _el.statCorrupt.textContent = formatNum(stats.corruptCount || 0);
    if (_el.statInterrupted) _el.statInterrupted.textContent = formatNum(stats.interruptedCount || 0);
    if (_el.statReordered) _el.statReordered.textContent = formatNum(stats.reorderCount || 0);
}

async function pollStats() {
    try {
        const json = await tauriClient.getFaultInjectionStats();
        const stats = typeof json === 'string' ? JSON.parse(json) : json;
        updateStatsDisplay(stats);
    } catch (e) { /* ignore polling errors */ }
}

function startStatsPoll() {
    if (_statsTimer) return;
    _statsTimer = setInterval(pollStats, 1000);
}

function stopStatsPoll() {
    if (_statsTimer) {
        clearInterval(_statsTimer);
        _statsTimer = null;
    }
}

// ============================================================================
// INIT
// ============================================================================

function init(container) {
    if (_initialized) return;
    if (!container) return;

    container.innerHTML = getTemplate();

    /* Cache DOM refs */
    _el.body = document.getElementById('faultInjBody');
    _el.warningBanner = document.getElementById('fiWarningBanner');
    _el.enabledCheckbox = document.getElementById('fiEnabledCheckbox');

    _el.packetLoss = document.getElementById('fiPacketLoss');
    _el.packetLossVal = document.getElementById('fiPacketLossVal');
    _el.duplicate = document.getElementById('fiDuplicate');
    _el.duplicateVal = document.getElementById('fiDuplicateVal');
    _el.reorderRate = document.getElementById('fiReorderRate');
    _el.reorderRateVal = document.getElementById('fiReorderRateVal');
    _el.reorderSamplesAfter = document.getElementById('fiReorderSamplesAfter');
    _el.burstCount = document.getElementById('fiBurstCount');
    _el.burstInterval = document.getElementById('fiBurstInterval');

    _el.jitter = document.getElementById('fiJitter');
    _el.jitterVal = document.getElementById('fiJitterVal');
    _el.fixedDelay = document.getElementById('fiFixedDelay');
    _el.fixedDelayVal = document.getElementById('fiFixedDelayVal');

    _el.corruptSmpCnt = document.getElementById('fiCorruptSmpCnt');
    _el.corruptSmpCntVal = document.getElementById('fiCorruptSmpCntVal');
    _el.corruptValues = document.getElementById('fiCorruptValues');
    _el.corruptValuesVal = document.getElementById('fiCorruptValuesVal');
    _el.corruptChannelCount = document.getElementById('fiCorruptChannelCount');
    _el.corruptChannelCountVal = document.getElementById('fiCorruptChannelCountVal');
    _el.wrongSmpSynch = document.getElementById('fiWrongSmpSynch');
    _el.wrongSmpSynchVal = document.getElementById('fiWrongSmpSynchVal');
    _el.corruptBer = document.getElementById('fiCorruptBer');
    _el.corruptBerVal = document.getElementById('fiCorruptBerVal');

    _el.streamInterrupt = document.getElementById('fiStreamInterrupt');
    _el.interruptDuration = document.getElementById('fiInterruptDuration');
    _el.interruptInterval = document.getElementById('fiInterruptInterval');

    _el.statProcessed = document.getElementById('fiStatProcessed');
    _el.statDropped = document.getElementById('fiStatDropped');
    _el.statDuped = document.getElementById('fiStatDuped');
    _el.statCorrupt = document.getElementById('fiStatCorrupt');
    _el.statInterrupted = document.getElementById('fiStatInterrupted');
    _el.statReordered = document.getElementById('fiStatReordered');

    _el.applyBtn = document.getElementById('fiApplyBtn');
    _el.resetBtn = document.getElementById('fiResetBtn');

    /* --- Event listeners --- */

    /* Slider live labels */
    const sliders = [
        [_el.packetLoss, _el.packetLossVal, '%'],
        [_el.duplicate, _el.duplicateVal, '%'],
        [_el.reorderRate, _el.reorderRateVal, '%'],
        [_el.jitter, _el.jitterVal, ' μs'],
        [_el.fixedDelay, _el.fixedDelayVal, ' μs'],
        [_el.corruptSmpCnt, _el.corruptSmpCntVal, '%'],
        [_el.corruptValues, _el.corruptValuesVal, '%'],
        [_el.corruptChannelCount, _el.corruptChannelCountVal, '%'],
        [_el.wrongSmpSynch, _el.wrongSmpSynchVal, '%'],
        [_el.corruptBer, _el.corruptBerVal, '%'],
    ];
    for (const [slider, label, suffix] of sliders) {
        slider.addEventListener('input', () => {
            const v = parseFloat(slider.value);
            label.textContent = (suffix === '%') ? v.toFixed(1) + '%' : v + suffix;
        });
    }

    /* Enable checkbox toggles warning banner */
    _el.enabledCheckbox.addEventListener('change', () => {
        updateAllLabels();
    });

    /* Apply button */
    _el.applyBtn.addEventListener('click', async () => {
        await applyConfig();
        if (_el.enabledCheckbox.checked) {
            startStatsPoll();
        } else {
            stopStatsPoll();
        }
    });

    /* Reset button */
    _el.resetBtn.addEventListener('click', async () => {
        await resetAll();
        stopStatsPoll();
    });

    /* Preset buttons */
    document.getElementById('fiPresets').addEventListener('click', (e) => {
        const btn = e.target.closest('[data-preset]');
        if (!btn) return;
        const presetName = btn.dataset.preset;
        const preset = PRESETS[presetName];
        if (!preset) return;

        /* Reset all to 0 first, then apply preset values */
        _el.packetLoss.value = 0;
        _el.duplicate.value = 0;
        _el.reorderRate.value = 0;
        _el.reorderSamplesAfter.value = 3;
        _el.burstCount.value = 0;
        _el.burstInterval.value = 0;
        _el.jitter.value = 0;
        _el.fixedDelay.value = 0;
        _el.corruptSmpCnt.value = 0;
        _el.corruptValues.value = 0;
        _el.corruptChannelCount.value = 0;
        _el.wrongSmpSynch.value = 0;
        _el.corruptBer.value = 0;
        _el.streamInterrupt.checked = false;
        _el.interruptDuration.value = 5;
        _el.interruptInterval.value = 30;
        _el.enabledCheckbox.checked = false;

        setSliderValues(preset.config);
        updateAllLabels();
    });

    /* Start polling if publishing state changes */
    tauriClient.on('publishingStopped', () => {
        /* Auto-disable and reset on stop. Slider values are preserved so the
         * user can re-tick "Enable" and click Apply without re-entering them. */
        _el.enabledCheckbox.checked = false;
        updateAllLabels();
        stopStatsPoll();
        applyConfig();
    });

    /* Seed UI from store on init — restores last-applied config across
     * component re-mounts and lets us treat store.config.faultInjection as
     * the durable source of truth. */
    const saved = store.get('config.faultInjection');
    if (saved && typeof saved === 'object') {
        setSliderValues(saved);
        updateAllLabels();
    }

    /* Re-apply automatically when publishing starts so the backend never
     * runs with stale fault config (e.g. user reconfigured after a stop). */
    store.subscribe('data.publishing.isRunning', (isRunning) => {
        if (!isRunning) return;
        const cfg = store.get('config.faultInjection');
        if (cfg && cfg.enabled) {
            tauriClient.setFaultInjectionConfig(JSON.stringify(cfg)).catch(() => {});
            startStatsPoll();
        }
    });

    _initialized = true;
    console.log('[FaultInjection] Panel initialized');
}

// ============================================================================
// EXPORT
// ============================================================================

const FaultInjectionPanel = { init, getTemplate };
export default FaultInjectionPanel;
export { init, getTemplate };
