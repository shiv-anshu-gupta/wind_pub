/**
 * @file layoutMode.js
 * @fileoverview Runtime layout mode picker. Switches between 2-column and
 * 3-column layouts by hiding/showing the middle column and re-parenting its
 * children into the right column as needed.
 *
 * DOM re-parenting (not cloning) is used intentionally so all existing
 * event listeners, store subscriptions, and component state survive the
 * switch. For example, the FrameViewer keeps ticking smpCnt updates because
 * its DOM root is the same element — just with a different parent.
 */

import { refreshAfterLayoutChange } from '../utils/resizableColumns.js';

const STORAGE_KEY = 'sv-pub-layout-mode';
const VALID_MODES = ['2', '3'];
const DEFAULT_MODE = '3';

const _el = {};
let _currentMode = null;

// ============================================================================
// PUBLIC API
// ============================================================================

/**
 * Initialize the layout mode picker. Wires the header buttons and applies
 * any saved mode. Must be called AFTER all components have mounted.
 */
export function initLayoutMode() {
    _el.picker = document.getElementById('layoutPicker');
    _el.mainContent = document.getElementById('mainContent');
    _el.leftColumn = document.getElementById('leftColumn');
    _el.middleColumn = document.getElementById('middleColumn');
    _el.rightColumn = document.getElementById('rightColumn');

    if (!_el.picker || !_el.mainContent || !_el.middleColumn || !_el.rightColumn) {
        console.warn('[LayoutMode] Required DOM elements not found, aborting init');
        return;
    }

    // Wire button clicks
    _el.picker.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-layout-mode]');
        if (!btn) return;
        const mode = btn.dataset.layoutMode;
        if (!VALID_MODES.includes(mode)) return;
        setMode(mode);
    });

    // Apply saved mode (or default)
    const saved = localStorage.getItem(STORAGE_KEY);
    const initialMode = VALID_MODES.includes(saved) ? saved : DEFAULT_MODE;
    // Apply without animation flicker on initial load
    _applyModeSilently(initialMode);

    console.log('[LayoutMode] Initialized, mode =', initialMode);
}

/**
 * Programmatic mode setter. Called by the button handler and also available
 * for other modules (e.g., a future CD-2 maximize that wants to force-restore).
 * @param {'2'|'3'} mode
 */
export function setMode(mode) {
    if (!VALID_MODES.includes(mode)) {
        console.warn('[LayoutMode] Invalid mode:', mode);
        return;
    }
    if (mode === _currentMode) return;

    _applyMode(mode);
    localStorage.setItem(STORAGE_KEY, mode);
}

/**
 * Get the current active mode.
 * @returns {'2'|'3'|null}
 */
export function getMode() {
    return _currentMode;
}

// ============================================================================
// INTERNAL
// ============================================================================

function _applyModeSilently(mode) {
    // Disable transitions for the initial application (prevents layout flash)
    document.body.classList.add('layout-switching');
    _applyMode(mode);
    // Re-enable transitions after next frame
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            document.body.classList.remove('layout-switching');
        });
    });
}

function _applyMode(mode) {
    _currentMode = mode;

    if (mode === '2') {
        _moveFrameToRight();
        _el.mainContent.classList.remove('three-column-layout');
        _el.mainContent.classList.add('two-column-layout');
    } else {
        // mode === '3'
        _moveFrameBack();
        _el.mainContent.classList.remove('two-column-layout');
        _el.mainContent.classList.add('three-column-layout');
    }

    // Update picker button active state
    if (_el.picker) {
        _el.picker.querySelectorAll('[data-layout-mode]').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.layoutMode === mode);
        });
    }

    // Let resizableColumns re-measure for the new visible column set
    try {
        refreshAfterLayoutChange();
    } catch (err) {
        console.warn('[LayoutMode] refreshAfterLayoutChange failed:', err);
    }
}

/**
 * Move every child of #middleColumn into the top of #rightColumn, wrapped in
 * a single host div so we can find them again later.
 *
 * Safe to call multiple times — returns early if already moved.
 */
function _moveFrameToRight() {
    const middle = _el.middleColumn;
    const right = _el.rightColumn;
    if (!middle || !right) return;

    // If already moved, do nothing.
    if (right.querySelector(':scope > .inserted-frame-host')) return;

    // Create host div to hold the moved children
    const host = document.createElement('div');
    host.className = 'inserted-frame-host';
    host.setAttribute('data-frame-relocated', 'true');

    // Move (not clone) all children of middle column into the host
    while (middle.firstChild) {
        host.appendChild(middle.firstChild);
    }

    // Insert the host at the top of the right column
    right.insertBefore(host, right.firstChild);
}

/**
 * Reverse of _moveFrameToRight: take children out of the inserted-frame-host
 * and put them back into #middleColumn.
 */
function _moveFrameBack() {
    const middle = _el.middleColumn;
    const right = _el.rightColumn;
    if (!middle || !right) return;

    const host = right.querySelector(':scope > .inserted-frame-host');
    if (!host) return;  // Nothing to move back

    // Move children back
    while (host.firstChild) {
        middle.appendChild(host.firstChild);
    }

    // Remove the now-empty host
    host.remove();
}
