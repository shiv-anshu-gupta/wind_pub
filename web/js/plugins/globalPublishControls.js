/**
 * @file globalPublishControls.js
 * @fileoverview Wires global header Start/Stop buttons to MultiPublisher and
 * maintains a status indicator. The single-mode panel and PublishMode toggle
 * were removed — every publish action now goes through MultiPublisher.
 */

import * as MultiPublisher from '../components/MultiPublisher.js';
import * as tauriClient from '../utils/tauriClient.js';
import { setAppStatus } from '../utils/status.js';

const _el = {};
let _pollTimer = null;

/**
 * Initialize global header publish controls.
 * Must be called AFTER MultiPublisher.init() so its _public helpers are usable.
 */
export function initGlobalPublishControls() {
    _el.startBtn = document.getElementById('globalStartBtn');
    _el.stopBtn = document.getElementById('globalStopBtn');

    if (!_el.startBtn || !_el.stopBtn) {
        console.warn('[GlobalPublishControls] Header buttons not found in DOM');
        return;
    }

    _el.startBtn.addEventListener('click', handleStart);
    _el.stopBtn.addEventListener('click', handleStop);

    _el.resetBtn = document.getElementById('globalResetBtn');
    if (_el.resetBtn) _el.resetBtn.addEventListener('click', handleReset);

    // Listen for publishingStopped event from backend polling in tauriClient.
    // This fires when publishing ends (duration elapsed OR user stop).
    tauriClient.on('publishingStopped', () => {
        updateStatus(false);
    });

    // Poll every 500ms to detect state changes triggered from the panels themselves
    // (user clicks Start inside the old panel buttons — we still want the header to reflect it).
    startStatusPoll();

    // Initial state
    updateStatus(false);

    console.log('[GlobalPublishControls] Initialized');
}

async function handleStart() {
    console.log('[GlobalPublishControls] Start clicked');
    try {
        await MultiPublisher.startAll_public();
        updateStatus(true);
    } catch (err) {
        console.error('[GlobalPublishControls] Start failed:', err);
    }
}

async function handleStop() {
    console.log('[GlobalPublishControls] Stop clicked');
    try {
        await MultiPublisher.stopAll_public();
        updateStatus(false);
    } catch (err) {
        console.error('[GlobalPublishControls] Stop failed:', err);
    }
}

/**
 * Reset the ENTIRE application to its initial state.
 *
 * This is an application-wide reset (not just the multi-publisher): it returns
 * every component — left column (data source, channels, standard, stream
 * settings), right column (publish mode, statistics, fault injection), and the
 * Frame Structure viewer — plus all stores and the backend to their initial
 * values, so the user can reconfigure from scratch without restarting the app.
 *
 * Implementation: clean the backend (stop publishing, free all publishers,
 * clear buffers/stats), drop config-bearing persisted state, then reload the
 * frontend. The store and every component hold their working state in memory
 * only, so the reload deterministically restores all initial values. Pure
 * window preferences (theme, column layout, sidebar visibility) are kept.
 */
async function handleReset() {
    const confirmed = window.confirm(
        'Reset the entire application to its initial state?\n\n' +
        'This stops publishing and clears ALL publishers, channels, equations, ' +
        'fault injection and configuration across every panel.\n\n' +
        'Your theme and window layout are preserved. This cannot be undone.'
    );
    if (!confirmed) return;

    console.log('[GlobalPublishControls] Application reset requested');
    setAppStatus('idle');
    if (_el.resetBtn) _el.resetBtn.disabled = true;

    // 1. Clean the backend BEFORE reloading so no stale publishers/buffers survive.
    try { await tauriClient.mpResetAll(); } catch (err) {
        console.warn('[GlobalPublishControls] mpResetAll during reset failed:', err);
    }
    // Close the network interface too — otherwise it stays open in the native
    // engine across the reload, and the next Start would reuse the OLD interface.
    try { await tauriClient.closeInterface(); } catch (_) { /* none open */ }
    try { await tauriClient.resetFaultInjectionStats(); } catch (_) { /* best effort */ }

    // 2. Clear config-bearing persisted state (keep theme/layout/sidebar prefs).
    try { localStorage.removeItem('sv-pub-channels-visible-columns'); } catch (_) {}
    // Waveform-plot display config (labels/colors/scales/equation history).
    try { localStorage.removeItem('__uplot_history__'); } catch (_) {}

    // 3. Reload the frontend — restores all in-memory stores + components to initial.
    window.location.reload();
}

/**
 * Poll the actual running state from both panels.
 * Runs at 500ms — fast enough for UI feedback, slow enough to not load the browser.
 */
function startStatusPoll() {
    if (_pollTimer) return;
    _pollTimer = setInterval(() => {
        updateStatus(MultiPublisher.isRunning_public());
    }, 500);
}

function updateStatus(isRunning) {
    if (!_el.startBtn || !_el.stopBtn) return;

    _el.startBtn.disabled = isRunning;
    _el.stopBtn.disabled = !isRunning;

    // Drive the header pill via data-state — CSS handles colors + pulse.
    setAppStatus(isRunning ? 'running' : 'idle', isRunning ? 'Publishing' : 'Idle');
}
