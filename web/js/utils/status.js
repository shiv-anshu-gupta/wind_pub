/**
 * @file status.js
 * @fileoverview Tiny helper for the header status indicator (#appStatus).
 *
 * The pill is driven by a `data-state` attribute — CSS handles all colors
 * and the pulse animation. JS only flips one string and updates the label.
 */

const VALID_STATES = ['idle', 'running', 'error', 'warning'];

/**
 * @param {'idle' | 'running' | 'error' | 'warning'} state
 * @param {string} [label] - Display text. Defaults to capitalized state.
 */
export function setAppStatus(state, label) {
    const el = document.getElementById('appStatus');
    if (!el) return;
    if (!VALID_STATES.includes(state)) {
        console.warn('[status] Unknown state:', state);
        return;
    }
    el.dataset.state = state;
    const labelEl = el.querySelector('.status-label');
    if (labelEl) {
        labelEl.textContent = label || (state.charAt(0).toUpperCase() + state.slice(1));
    }
}

export function getAppStatus() {
    const el = document.getElementById('appStatus');
    return el ? el.dataset.state : null;
}
