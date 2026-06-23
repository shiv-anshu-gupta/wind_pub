/**
 * @module MultiPublisher
 * @file components/MultiPublisher.js
 * @description Multi-Publisher Management Panel.
 * 
 * Allows creating multiple SV publisher instances, each with its own
 * svID, appID, and channel configuration. All publishers share the same
 * network interface (from StreamSettings) and equations (from DataSource).
 * 
 * KEY DESIGN: Publishers are managed LOCALLY in this component.
 * No backend calls happen until "Start All" is clicked.
 * This makes the UI responsive and avoids silent failures.
 * 
 * Flow on "Start All":
 *   1. For each local publisher → mp_add_publisher (get C++ ID)
 *   2. For each → mp_configure_publisher (send config + equations)
 *   3. mp_start_all → C++ prebuild frames → transmit
 * 
 * @author SV-PUB Team
 * @date 2025
 */

import store, { updateEquationFrequency } from '../store/index.js';
import { showToast } from '../plugins/toast.js';
import * as tauriClient from '../utils/tauriClient.js';
import { defaultGooseConfig, macStringToBytes } from './GooseParameters.js';

// ============================================================================
// MODULE STATE
// ============================================================================

let _initialized = false;
let _isRunning = false;
let _pollTimer = null;

/** Auto-incrementing local ID (only for UI tracking) */
let _nextLocalId = 1;

/**
 * Local publisher list. Managed entirely in the frontend.
 * Backend IDs are assigned only when "Start All" is clicked.
 * @type {Array<{localId:number, backendId:number|null, svId:string, appId:number, confRev:number, smpSynch:number, channelCount:number, expanded:boolean}>}
 */
let _publishers = [];

/**
 * localId of the publisher currently "selected" to drive the Frame Structure
 * viewer (null = none). Clicking a publisher card's header selects it and
 * writes ui.activeMu; FrameViewer subscribes to ui.activeMu and re-renders.
 */
let _selectedLocalId = null;

/**
 * Build the ui.activeMu payload FrameViewer consumes. Each publisher owns its
 * own channel list, so the Frame Structure shows/edits THIS stream's channels
 * independently of the global config and the other streams.
 */
function _muPayload(pub) {
    return {
        localId: pub.localId,
        svId: pub.svId,
        appId: pub.appId,
        confRev: pub.confRev,
        smpSynch: pub.smpSynch,
        selectedChannels: pub.selectedChannels.slice(),
        channelCount: pub.selectedChannels.length,
    };
}

/** The publisher currently selected to drive the Frame Structure, or null. */
function _findSelectedPublisher() {
    if (_selectedLocalId == null) return null;
    return _publishers.find(p => p.localId === _selectedLocalId) || null;
}

/** Whether a channel ID exists in the global channel pool. */
function _isChannelKnown(channelId) {
    return !!store.getChannel(channelId);
}

/** Push the selected publisher's channel list to FrameViewer (ui.activeMu). */
function _syncActiveMu(pub) {
    if (!pub) return;
    pub.channelCount = pub.selectedChannels.length;
    store.set('ui.activeMu', _muPayload(pub));
}

/**
 * Resolve a publisher's channel-ID list to the global channel objects, in the
 * publisher's order. Unknown IDs are dropped. Used to send each stream's own
 * channels to the backend and to the CID exporter.
 */
function _pubChannelObjects(pub, storeChannels) {
    const list = storeChannels || store.getChannelsForServer() || [];
    const byId = new Map(list.map(c => [c.id, c]));
    return pub.selectedChannels.map(id => byId.get(id)).filter(Boolean);
}

/**
 * Resize a publisher's channel list to `n` channels. Truncates when shrinking;
 * when growing, appends channels from the global pool that aren't already in the
 * list (SV positions shouldn't duplicate a channel). Capped at the pool size.
 */
function _resizeChannels(pub, n) {
    const arr = pub.selectedChannels;
    if (n < arr.length) {
        arr.length = Math.max(0, n);
    } else if (n > arr.length) {
        const pool = (store.getChannelsForServer() || []).map(c => c.id);
        for (const id of pool) {
            if (arr.length >= n) break;
            if (!arr.includes(id)) arr.push(id);
        }
    }
    pub.channelCount = arr.length;
}

/** Cached DOM references */
const _el = {};

// ============================================================================
// HELPERS
// ============================================================================

function macToBytes(mac) {
    return mac.split(':').map(hex => parseInt(hex, 16));
}

// ============================================================================
// TEMPLATE
// ============================================================================

function getTemplate() {
    return `
        <section class="card" id="multi-publisher-module">
            <div class="card-header">
                <h2>Multi-Publisher</h2>
                <span class="card-subtitle">Simulate Multiple Merging Units</span>
                <!-- All action buttons grouped at the top-right of the header.
                     Start/Stop live in the global header (kept hidden here so their
                     listeners + disabled-state logic still run). -->
                <div class="mp-header-actions">
                    <div class="mp-controls" id="mpControls" style="display:none;">
                        <button class="btn btn-success" id="mpStartBtn" style="display:none;">▶ Start All</button>
                        <button class="btn btn-danger" id="mpStopBtn" disabled style="display:none;">⏹ Stop All</button>
                    </div>
                    <button class="btn btn-primary mp-add-btn" id="mpAddBtn" title="Add a new publisher stream">
                        <span class="icon">＋</span> Add
                    </button>
                </div>
            </div>
            <div class="card-body">

                <!-- Publishing Mode -->
                <div class="mp-setting-section" id="mpPublishModeSection">
                    <label class="mode-label">Publishing Mode:</label>
                    <div class="mp-radio-group">
                        <label><input type="radio" name="mpPublishMode" value="continuous" checked> 🔄 Continuous</label>
                        <label><input type="radio" name="mpPublishMode" value="duration"> ⏱️ Duration</label>
                    </div>
                    <div class="mp-duration-settings" id="mpDurationSettings" style="display:none;">
                        <div class="mp-field mp-field--inline">
                            <label>Duration</label>
                            <input type="number" id="mpDurationValue" value="10" min="1" max="3600" style="width:70px">
                            <select id="mpDurationUnit">
                                <option value="seconds">Seconds</option>
                                <option value="minutes">Minutes</option>
                            </select>
                        </div>
                        <div class="mp-field mp-field--inline">
                            <label><input type="checkbox" id="mpRepeatEnabled"> Repeat</label>
                            <input type="number" id="mpRepeatCount" value="1" min="1" max="999" style="width:60px" disabled>
                            <label><input type="checkbox" id="mpRepeatInfinite" disabled> Infinite</label>
                        </div>
                    </div>
                </div>

                <!-- Add Publisher button relocated to the card header (top, compact). -->

                <!-- Publisher Cards List -->
                <div class="mp-list" id="mpList"></div>

                <!-- Status -->
                <div class="mp-status" id="mpStatus">
                    <span class="status-dot ready"></span>
                    <span class="status-text">Click "Add Publisher" to create SV streams</span>
                </div>
            </div>
        </section>
    `;
}

// ============================================================================
// RENDER
// ============================================================================

function render() {
    const list = _el.list;
    if (!list) return;

    // Clear previous cards
    list.innerHTML = '';

    // Show/hide controls — always show if publishers exist OR running state
    // Reset button should always be accessible
    if (_el.controls) {
        _el.controls.style.display = 'flex';
    }

    // Render each publisher as a card
    _publishers.forEach((pub, idx) => {
        const card = document.createElement('div');
        card.className = 'mp-pub'
            + (pub.expanded ? ' mp-pub--expanded' : '')
            + (pub.localId === _selectedLocalId ? ' mp-pub--selected' : '');

        // Card UI is now FOCUSED on operational status only — every
        // communication-header field (svID, appID, confRev, protocol,
        // source, GOOSE block, etc.) lives in the Stream Configuration
        // page. The "Configure Headers" button opens that page focused
        // on this stream. No duplication.
        const protoBadgeClass = pub.protocol === 'goose'
            ? 'mp-pub-badge mp-pub-badge--goose'
            : 'mp-pub-badge mp-pub-badge--sv';
        const sourceBadgeClass = pub.source === 'external'
            ? 'mp-pub-badge mp-pub-badge--external'
            : 'mp-pub-badge mp-pub-badge--equation';

        card.innerHTML = `
            <div class="mp-pub-header">
                <span class="mp-pub-num">#${idx + 1}</span>
                <span class="mp-pub-title">${pub.svId}</span>
                <span class="${protoBadgeClass}">${(pub.protocol || 'sv').toUpperCase()}</span>
                <span class="${sourceBadgeClass}">${pub.source === 'external' ? 'EXT' : 'EQ'}</span>
                <span class="mp-pub-badge">${pub.channelCount}ch</span>
                <button class="mp-expand-btn" title="${pub.expanded ? 'Collapse' : 'Edit channels'}">${pub.expanded ? '▲' : '▼'}</button>
                <button class="mp-del-btn" title="Remove publisher">✕</button>
            </div>
            ${pub.expanded ? `
            <div class="mp-pub-body">
                <div class="mp-field">
                    <label>Channels</label>
                    <select data-field="channelCount" ${_isRunning ? 'disabled' : ''}>
                        ${Array.from({length: 20}, (_, i) => i + 1).map(n =>
                            `<option value="${n}" ${pub.channelCount === n ? 'selected' : ''}>${n}</option>`
                        ).join('')}
                    </select>
                </div>
                <button class="btn btn-outline btn-sm mp-pub-config-btn" data-action="open-config" ${_isRunning ? 'disabled' : ''}>
                    <i data-lucide="settings-2"></i>
                    Configure Headers (svID, GOOSE, Source, etc.)
                </button>
                <p class="mp-field-hint">
                    Equations come from the Data Source panel (left column).
                    All communication headers — protocol, source mode, svID,
                    appID, GOOSE fields — are edited on the Configuration page.
                </p>
            </div>` : ''}
        `;

        // --- Event bindings for this card ---

        // Select this publisher to drive the Frame Structure viewer. Clicking
        // anywhere on the header (except the expand/delete buttons) selects it
        // and publishes its frame to ui.activeMu — FrameViewer reacts to that.
        card.querySelector('.mp-pub-header').addEventListener('click', (e) => {
            if (e.target.closest('.mp-expand-btn') || e.target.closest('.mp-del-btn')) return;
            _selectedLocalId = pub.localId;
            _syncActiveMu(pub);
            render();
        });

        // Toggle expand/collapse
        card.querySelector('.mp-expand-btn').addEventListener('click', () => {
            if (_isRunning) return;
            pub.expanded = !pub.expanded;
            render();
        });

        // Delete
        card.querySelector('.mp-del-btn').addEventListener('click', () => {
            if (_isRunning) {
                showToast('Stop publishing first', 'error');
                return;
            }
            // Clear the Frame Structure selection if this was the selected MU.
            if (pub.localId === _selectedLocalId) {
                _selectedLocalId = null;
                store.set('ui.activeMu', null);
            }
            _publishers.splice(idx, 1);
            render();
            showToast(`Removed ${pub.svId}`);
        });

        // Field changes (only if expanded) — only Channels lives here now;
        // everything else is on the Configuration page.
        if (pub.expanded) {
            const chanSel = card.querySelector('[data-field="channelCount"]');
            if (chanSel) {
                chanSel.addEventListener('change', (e) => {
                    const val = parseInt(e.target.value) || 1;
                    _resizeChannels(pub, val);
                    if (pub.localId === _selectedLocalId) _syncActiveMu(pub);
                    render();
                });
            }

            // "Configure Headers" button — opens the slide-in config page and
            // hands it the streamId to scroll into view.
            const cfgBtn = card.querySelector('[data-action="open-config"]');
            if (cfgBtn) {
                cfgBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    window.dispatchEvent(new CustomEvent('open-stream-config', {
                        detail: { localId: pub.localId }
                    }));
                });
            }
        }

        list.appendChild(card);
    });

    // Update button states
    updateButtonStates();
}

function updateButtonStates() {
    if (_el.addBtn) _el.addBtn.disabled = _isRunning;
    if (_el.startBtn) _el.startBtn.disabled = _isRunning || _publishers.length === 0;
    if (_el.stopBtn) _el.stopBtn.disabled = !_isRunning;
    // Reset is always enabled — it works in any state
    if (_el.resetBtn) _el.resetBtn.disabled = false;

    // Disable publish mode controls while running (send mode is hardcoded — no UI)
    document.querySelectorAll('input[name="mpPublishMode"]').forEach(r => r.disabled = _isRunning);
    if (_el.durationValue) _el.durationValue.disabled = _isRunning;
    if (_el.durationUnit) _el.durationUnit.disabled = _isRunning;
    if (_el.repeatEnabled) _el.repeatEnabled.disabled = _isRunning;
    if (_el.repeatCount) _el.repeatCount.disabled = _isRunning;
    if (_el.repeatInfinite) _el.repeatInfinite.disabled = _isRunning;

    // Status text
    const dot = _el.status?.querySelector('.status-dot');
    const text = _el.status?.querySelector('.status-text');
    if (dot && text) {
        if (_isRunning) {
            dot.className = 'status-dot publishing';
            text.textContent = `Publishing ${_publishers.length} stream${_publishers.length !== 1 ? 's' : ''}...`;
        } else if (_publishers.length > 0) {
            dot.className = 'status-dot ready';
            text.textContent = `${_publishers.length} publisher${_publishers.length !== 1 ? 's' : ''} configured`;
        } else {
            dot.className = 'status-dot ready';
            text.textContent = 'Click "Add Publisher" to create SV streams';
        }
    }
}

// ============================================================================
// ADD PUBLISHER (local only — no backend call)
// ============================================================================

function addPublisher() {
    if (_isRunning) {
        showToast('Stop publishing first', 'error');
        return;
    }

    const idx = _publishers.length + 1;
    // Seed the new stream with its OWN copy of the current global channel order;
    // the user can then customise it independently via Frame Structure drag/drop.
    const seed = (store.get('config')?.selectedChannels || []).slice();
    const fallback = (store.getChannelsForServer() || []).map(c => c.id);
    const selectedChannels = seed.length > 0 ? seed : fallback;
    _publishers.push({
        localId: _nextLocalId++,
        backendId: null,              // assigned on Start All
        svId: `MU${String(idx).padStart(2, '0')}`,
        appId: 0x4000 + (idx - 1),
        confRev: 1,
        smpSynch: 2,
        selectedChannels,             // per-stream channel list (own copy)
        channelCount: selectedChannels.length,
        expanded: true,
        // ── Phase 2/3 additions ──
        source:   'equation',         // 'equation' | 'external'
        protocol: 'sv',               // 'sv' | 'goose'
        goose:    defaultGooseConfig(idx),
    });

    render();
    console.log(`[MultiPublisher] Added publisher #${idx} with ${selectedChannels.length} channels`);
}


// ============================================================================
// EXPORT ALL CIDs
// ============================================================================

async function exportAllCids() {
    if (_publishers.length === 0) {
        showToast('No publishers to export', 'error');
        return;
    }

    const storeConfig = store.get('config');
    const storeChannels = store.getChannelsForServer() || [];
    const basePath = '/home/powereureka/Desktop/publisher/custom';
    let exported = 0;

    for (const pub of _publishers) {
        const outputPath = `${basePath}/${pub.svId}.cid`;
        // Derive per-channel types: 0=current(TCTR), 1=voltage(TVTR)
        const pubChannels = _pubChannelObjects(pub, storeChannels);
        const channelTypes = pubChannels.map(ch => ch.type === 'voltage' ? 1 : 0);
        const cidConfig = {
            svId: pub.svId,
            appId: pub.appId,
            confRev: pub.confRev,
            smpSynch: pub.smpSynch,
            srcMac: macToBytes(storeConfig.srcMAC),
            dstMac: macToBytes(storeConfig.dstMAC),
            vlanPriority: storeConfig.vlanPriority || 4,
            vlanId: storeConfig.vlanID || 0,
            sampleRate: storeConfig.sampleRate,
            frequency: storeConfig.frequency,
            asduCount: storeConfig.noASDU || 1,
            channelCount: pub.channelCount,
            channelTypes: channelTypes,
        };

        try {
            await tauriClient.exportCidWithConfig(outputPath, cidConfig);
            exported++;
        } catch (err) {
            console.error(`[MultiPublisher] CID export failed for ${pub.svId}:`, err);
            showToast(`CID export failed for ${pub.svId}: ${err}`, 'error');
        }
    }

    if (exported > 0) {
        showToast(`Exported ${exported} CID file(s) to ${basePath}/`, 'success');
    }
}

// ============================================================================
// START ALL — sends everything to backend in one go
// ============================================================================

async function startAll() {
    if (_isRunning) return;
    if (_publishers.length === 0) {
        showToast('No publishers configured — click "Add Publisher" first', 'error');
        return;
    }

    const storeConfig = store.get('config');
    const storeChannels = store.getChannelsForServer();

    // Step 0: ALWAYS open the SELECTED interface. open_interface closes any
    // previously-open handle, so switching interfaces takes effect (the old
    // `if (!isOpen)` guard reused a stale interface from a prior run).
    try {
        const interfaces = await tauriClient.getInterfaces();
        const iface = interfaces[storeConfig.interfaceIndex || 0];
        if (iface) {
            await tauriClient.openInterface(iface.name);
        } else {
            showToast('No network interface found', 'error');
            return;
        }
    } catch (err) {
        showToast('Failed to open interface: ' + err, 'error');
        return;
    }

    // Step 1: RESET backend — remove stale publishers from previous session
    try {
        await tauriClient.mpRemoveAllPublishers();
        console.log('[MultiPublisher] Backend reset: all old publishers removed');
    } catch (err) {
        showToast('Failed to reset backend: ' + err, 'error');
        return;
    }

    // Step 2: Add all publishers in backend
    let addedCount = 0;
    for (const pub of _publishers) {
        try {
            const backendId = await tauriClient.mpAddPublisher();
            pub.backendId = backendId;
            addedCount++;
        } catch (err) {
            showToast(`Backend error adding ${pub.svId}: ${err}`, 'error');
            // Rollback: remove all publishers we just added
            try { await tauriClient.mpRemoveAllPublishers(); } catch (_) {}
            _publishers.forEach(p => p.backendId = null);
            return;
        }
    }

    // Step 3: Configure each publisher
    for (const pub of _publishers) {
        const channels = _pubChannelObjects(pub, storeChannels).map(ch => ({
            ...ch,
            // Apply current frequency — catches any leftover 50 Hz defaults
            equation: updateEquationFrequency(ch.equation, 50, storeConfig.frequency),
        }));
        const config = {
            svId: pub.svId,
            appId: pub.appId,
            confRev: pub.confRev,
            smpSynch: pub.smpSynch,
            sampleRate: storeConfig.sampleRate,
            frequency: storeConfig.frequency,
            srcMac: macToBytes(storeConfig.srcMAC),
            dstMac: macToBytes(storeConfig.dstMAC),
            vlanId: storeConfig.vlanID || 0,
            vlanPriority: storeConfig.vlanPriority || 4,
            noAsdu: storeConfig.noASDU || 1,
            channelCount: channels.length,
            channels: channels,
        };

        try {
            await tauriClient.mpConfigurePublisher(pub.backendId, config);
        } catch (err) {
            showToast(`Failed to configure ${pub.svId}: ${err}`, 'error');
            // Rollback: remove all publishers on config failure
            try { await tauriClient.mpRemoveAllPublishers(); } catch (_) {}
            _publishers.forEach(p => p.backendId = null);
            return;
        }

        // ───────────── Phase 2/3 per-stream side-config ─────────────
        // Source mode: 0 = Equation (existing fast path), 1 = External (SPSC)
        try {
            const sourceCode = (pub.source === 'external') ? 1 : 0;
            await tauriClient.mpSetPublisherSourceMode(pub.backendId, sourceCode);
        } catch (err) {
            console.warn(`[MultiPublisher] source-mode set failed for ${pub.svId}:`, err);
        }

        // Protocol: 0 = SV (default), 1 = GOOSE
        try {
            const protoCode = (pub.protocol === 'goose') ? 1 : 0;
            await tauriClient.mpSetPublisherProtocol(pub.backendId, protoCode);
        } catch (err) {
            console.warn(`[MultiPublisher] protocol set failed for ${pub.svId}:`, err);
        }

        // External-source streams need an SPSC queue pair allocated.
        if (pub.source === 'external') {
            try {
                await tauriClient.spscRegister(pub.backendId);
            } catch (err) {
                console.warn(`[MultiPublisher] spscRegister failed for ${pub.svId}:`, err);
            }
        }

        // GOOSE streams: configure encoder + spawn the retransmit scheduler.
        if (pub.protocol === 'goose') {
            const g = pub.goose || {};
            const gooseConfig = {
                streamId:     pub.backendId,
                srcMac:       macToBytes(storeConfig.srcMAC),
                dstMac:       macStringToBytes(g.dstMac),
                vlanId:       storeConfig.vlanID || -1,
                vlanPriority: storeConfig.vlanPriority || 4,
                appId:        pub.appId,
                confRev:      g.confRev | 0,
                test:         !!g.test,
                ndsCom:       !!g.ndsCom,
                gocbRef:      g.gocbRef || '',
                datSet:       g.datSet  || '',
                goId:         g.goId    || '',
            };
            try {
                await tauriClient.gooseConfigureTx(gooseConfig);
                await tauriClient.gooseStartTx(
                    pub.backendId,
                    g.heartbeatMs | 0,
                    g.firstRetxMs | 0,
                );
            } catch (err) {
                showToast(`GOOSE start failed for ${pub.svId}: ${err}`, 'error');
            }
        }
    }

    // Step 4: Read user selections for duration. Send mechanism is hardcoded in C++.
    const selectedPublishMode =
        document.querySelector('input[name="mpPublishMode"]:checked')?.value || 'continuous';

    let durationSec = 0;
    let repeatOn = false;
    let repeatInf = false;
    let repeatCnt = 0;

    if (selectedPublishMode === 'duration') {
        let val = parseInt(_el.durationValue?.value) || 10;
        if ((_el.durationUnit?.value) === 'minutes') val *= 60;
        durationSec = val;
        repeatOn = _el.repeatEnabled?.checked || false;
        repeatInf = _el.repeatInfinite?.checked || false;
        repeatCnt = parseInt(_el.repeatCount?.value) || 1;
    }

    try {
        await tauriClient.mpSetDuration(durationSec, repeatOn, repeatInf, repeatCnt);
        await tauriClient.mpStartAll();
    } catch (err) {
        showToast('Failed to start: ' + err, 'error');
        return;
    }

    _isRunning = true;
    render();
    showToast(`${_publishers.length} publisher(s) started`, 'success');

    // Bug #7: Start polling backend to detect duration completion
    startStatusPoll();
}

// ============================================================================
// STOP ALL
// ============================================================================

async function stopAll() {
    if (!_isRunning) return;

    stopStatusPoll();

    try {
        await tauriClient.mpStopAll();
    } catch (err) {
        showToast('Failed to stop: ' + err, 'error');
    }

    // Stop every GOOSE scheduler (Phase 3). No-op if nothing is running.
    try {
        await tauriClient.gooseStopAllTx();
    } catch (err) {
        console.warn('[MultiPublisher] gooseStopAllTx failed:', err);
    }

    // Clear backend IDs — they'll be re-assigned on next Start All
    _publishers.forEach(pub => pub.backendId = null);
    _isRunning = false;
    render();
    showToast('All publishers stopped');
}

// ============================================================================
// RESET ALL — complete fresh start without restarting app
// ============================================================================

async function resetAll() {
    // Stop polling
    stopStatusPoll();

    try {
        // Backend: stop transmit, free all publishers, clear buffers, reset stats
        await tauriClient.mpResetAll();
        console.log('[MultiPublisher] Backend fully reset');
    } catch (err) {
        showToast('Backend reset failed: ' + err, 'error');
        return;
    }

    // Frontend: clear all local state
    _publishers = [];
    _nextLocalId = 1;
    _isRunning = false;
    // Clear the Frame Structure selection so it doesn't point at a removed MU.
    _selectedLocalId = null;
    store.set('ui.activeMu', null);

    render();
    showToast('Full reset complete — ready for new configuration', 'success');
}

// ============================================================================
// STATUS POLLING — detects when backend stops (duration elapsed, etc.)
// ============================================================================

function startStatusPoll() {
    stopStatusPoll();
    _pollTimer = setInterval(async () => {
        try {
            const running = await tauriClient.mpIsRunning();
            if (!running && _isRunning) {
                console.log('[MultiPublisher] Backend stopped (duration complete)');
                _publishers.forEach(pub => pub.backendId = null);
                _isRunning = false;
                stopStatusPoll();
                render();
                showToast('Publishing completed (duration elapsed)');
            }
        } catch (e) {
            console.error('[MultiPublisher] Poll error:', e);
        }
    }, 1500);
}

function stopStatusPoll() {
    if (_pollTimer) {
        clearInterval(_pollTimer);
        _pollTimer = null;
    }
}

// ============================================================================
// INITIALIZATION
// ============================================================================

function init(container) {
    if (_initialized) return;
    if (!container) {
        console.warn('[MultiPublisher] No container provided');
        return;
    }

    container.innerHTML = getTemplate();

    _el.addBtn = document.getElementById('mpAddBtn');
    _el.list = document.getElementById('mpList');
    _el.controls = document.getElementById('mpControls');
    _el.startBtn = document.getElementById('mpStartBtn');
    _el.stopBtn = document.getElementById('mpStopBtn');
    _el.resetBtn = document.getElementById('mpResetBtn');
    _el.exportCidBtn = document.getElementById('mpExportCidBtn');
    _el.status = document.getElementById('mpStatus');

    // Publishing Mode controls (Send mechanism UI removed — hardcoded SendPacket)
    _el.publishModeSection = document.getElementById('mpPublishModeSection');
    _el.durationSettings = document.getElementById('mpDurationSettings');
    _el.durationValue = document.getElementById('mpDurationValue');
    _el.durationUnit = document.getElementById('mpDurationUnit');
    _el.repeatEnabled = document.getElementById('mpRepeatEnabled');
    _el.repeatCount = document.getElementById('mpRepeatCount');
    _el.repeatInfinite = document.getElementById('mpRepeatInfinite');

    // Publishing Mode toggle: show/hide duration settings
    document.querySelectorAll('input[name="mpPublishMode"]').forEach(radio => {
        radio.addEventListener('change', (e) => {
            _el.durationSettings.style.display =
                e.target.value === 'duration' ? 'block' : 'none';
        });
    });

    // Repeat checkbox logic
    _el.repeatEnabled.addEventListener('change', () => {
        const on = _el.repeatEnabled.checked;
        _el.repeatCount.disabled = !on || _el.repeatInfinite.checked;
        _el.repeatInfinite.disabled = !on;
    });
    _el.repeatInfinite.addEventListener('change', () => {
        _el.repeatCount.disabled = _el.repeatInfinite.checked;
    });

    // Send-mode UI removed — hardcoded SendPacket. No radio listeners or USB
    // pad/gap panels to wire up.

    // Bind top-level buttons
    _el.addBtn.addEventListener('click', addPublisher);
    _el.startBtn.addEventListener('click', startAll);
    _el.stopBtn.addEventListener('click', stopAll);
    // Reset is now an application-wide action in the global header (globalPublishControls.js).
    if (_el.resetBtn) _el.resetBtn.addEventListener('click', resetAll);
    // Export CID is now the single global header button (mode-aware); the in-card
    // button was removed, so guard the binding.
    if (_el.exportCidBtn) _el.exportCidBtn.addEventListener('click', exportAllCids);

    // Listen for backend stop events (duration elapsed, etc.)
    tauriClient.on('publishingStopped', () => {
        if (_isRunning) {
            _publishers.forEach(pub => pub.backendId = null);
            _isRunning = false;
            render();
        }
    });

    _initialized = true;
    console.log('[MultiPublisher] Initialized');

    // Bug #8: Sync _isRunning with backend on page load/refresh
    tauriClient.mpIsRunning().then(running => {
        if (running) {
            console.log('[MultiPublisher] Backend is running — syncing UI state');
            _isRunning = true;
            render();
            startStatusPoll();
        }
    }).catch(() => {});
}

// ============================================================================
// EXPORT
// ============================================================================

// Expose control functions for the global header
export function startAll_public() { return startAll(); }
export function stopAll_public() { return stopAll(); }
export function isRunning_public() { return _isRunning; }
/** Export a CID file per publisher (used by the global header Export CID button in multi mode). */
export function exportAllCids_public() { return exportAllCids(); }

// ----------------------------------------------------------------------------
// Per-MU channel mutation API (FrameViewer integration)
// ----------------------------------------------------------------------------
// FrameViewer calls these when a multi-stream publisher is selected. Each one
// mutates the SELECTED publisher's own `selectedChannels` list — never the
// global config — then re-syncs ui.activeMu so the Frame Structure re-renders.
// In single-stream mode (no selection) hasActiveMu() is false, so FrameViewer
// falls back to editing the global store.config.selectedChannels instead.

/** True when a publisher is selected to drive the Frame Structure. */
export function hasActiveMu() {
    return _findSelectedPublisher() !== null;
}

/** Append a channel to the selected publisher's list. */
export function addActiveMuChannel(channelId) {
    const pub = _findSelectedPublisher();
    if (!pub) return false;
    if (!_isChannelKnown(channelId)) return false;
    if (pub.selectedChannels.includes(channelId)) return false;
    pub.selectedChannels.push(channelId);
    _syncActiveMu(pub);
    render();
    return true;
}

/** Remove the channel at `index` from the selected publisher's list. */
export function removeActiveMuChannelAt(index) {
    const pub = _findSelectedPublisher();
    if (!pub) return false;
    if (index < 0 || index >= pub.selectedChannels.length) return false;
    pub.selectedChannels.splice(index, 1);
    _syncActiveMu(pub);
    render();
    return true;
}

/**
 * Replace the channel at `index`. If the new ID already exists elsewhere in the
 * list, swap their positions (matches store.changeSelectedChannelAt semantics).
 */
export function changeActiveMuChannelAt(index, newChannelId) {
    const pub = _findSelectedPublisher();
    if (!pub) return false;
    if (!_isChannelKnown(newChannelId)) return false;
    const arr = pub.selectedChannels;
    if (index < 0 || index >= arr.length) return false;
    const existingIdx = arr.indexOf(newChannelId);
    if (existingIdx !== -1 && existingIdx !== index) {
        [arr[index], arr[existingIdx]] = [arr[existingIdx], arr[index]];
    } else {
        arr[index] = newChannelId;
    }
    _syncActiveMu(pub);
    render();
    return true;
}

/** Reorder one channel within the selected publisher's list (drag/drop). */
export function reorderActiveMuChannel(fromIndex, toIndex) {
    const pub = _findSelectedPublisher();
    if (!pub) return false;
    const arr = pub.selectedChannels;
    if (fromIndex < 0 || fromIndex >= arr.length) return false;
    if (toIndex < 0 || toIndex >= arr.length) return false;
    const [moved] = arr.splice(fromIndex, 1);
    arr.splice(toIndex, 0, moved);
    _syncActiveMu(pub);
    render();
    return true;
}

// ── Cross-component bridges (for the Stream Config page) ──────────────
/** Read-only access to the live publishers array. The Config page
 *  edits these objects in place, then calls requestRender_public(). */
export function getPublishers_public() { return _publishers; }
/** Trigger a full re-render after an external edit. */
export function requestRender_public() { render(); }
/** Add a stream from outside (called by the Config page's + button). */
export function addPublisher_public() { addPublisher(); }
/** Remove by localId (called by the Config page's row delete). */
export function removePublisher_public(localId) {
    const idx = _publishers.findIndex(p => p.localId === localId);
    if (idx >= 0) {
        if (_isRunning) { showToast('Stop publishing first', 'error'); return; }
        if (_publishers[idx].localId === _selectedLocalId) {
            _selectedLocalId = null;
            store.set('ui.activeMu', null);
        }
        _publishers.splice(idx, 1);
        render();
    }
}

export const MultiPublisher = {
    init,
    getTemplate,
    startAll_public,
    stopAll_public,
    isRunning_public,
    exportAllCids_public,
    // Bridges for the Stream Configuration page:
    getPublishers_public,
    requestRender_public,
    addPublisher_public,
    removePublisher_public,
};
export default MultiPublisher;
