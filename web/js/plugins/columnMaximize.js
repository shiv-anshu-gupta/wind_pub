/**
 * @file columnMaximize.js
 * @fileoverview Per-column maximize-to-fill-window feature.
 *
 * Each column has a maximize button in its top-right corner. Clicking it
 * expands that column to fill the entire main-content area, hiding siblings.
 * Clicking again (or pressing Escape) restores the previous layout.
 *
 * Maximize is a pure CSS-class operation — NO DOM re-parenting. Unlike
 * CD-1's 2-col mode switch, this feature doesn't move any elements.
 * It just hides siblings via CSS while `.has-maximized` is on #mainContent.
 *
 * Maximize state is transient: not persisted across reloads.
 */

import { getMode as getLayoutMode } from './layoutMode.js';

const COLUMN_IDS = ['leftColumn', 'middleColumn', 'rightColumn'];

const _el = {};
/** Which column is currently maximized, or null. */
let _maximizedColId = null;

// ============================================================================
// PUBLIC API
// ============================================================================

/**
 * Initialize the column maximize feature. Wires button clicks and Escape key.
 * Must be called AFTER initLayoutMode() so we can query current layout mode.
 */
export function initColumnMaximize() {
    _el.mainContent = document.getElementById('mainContent');
    if (!_el.mainContent) {
        console.warn('[ColumnMaximize] #mainContent not found, aborting init');
        return;
    }

    // Wire all maximize buttons through event delegation on body so buttons
    // re-queried by any future DOM churn still work.
    document.addEventListener('click', _onButtonClick);

    // Escape key restores
    document.addEventListener('keydown', _onKeydown);

    console.log('[ColumnMaximize] Initialized');
}

/**
 * Programmatic accessor: which column is currently maximized.
 * @returns {string|null}
 */
export function getMaximizedColumn() {
    return _maximizedColId;
}

/**
 * Programmatic restore — called internally, also exposed for emergencies
 * (e.g., a future feature that needs to force-restore before doing something).
 */
export function restore() {
    if (!_maximizedColId) return;
    _applyRestore();
}

// ============================================================================
// INTERNAL
// ============================================================================

function _onButtonClick(e) {
    const btn = e.target.closest('[data-maximize-target]');
    if (!btn) return;

    const targetId = btn.dataset.maximizeTarget;
    if (!COLUMN_IDS.includes(targetId)) return;

    // If THIS column is already maximized, restore. Otherwise maximize it
    // (which also restores any other maximized column).
    if (_maximizedColId === targetId) {
        _applyRestore();
    } else {
        _applyMaximize(targetId);
    }
}

function _onKeydown(e) {
    if (e.key === 'Escape' && _maximizedColId) {
        // Only handle Escape if nothing else is grabbing it (inputs, dialogs)
        // Cheap heuristic: if focus is inside an input or textarea, skip.
        const active = document.activeElement;
        if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)) {
            return;
        }
        _applyRestore();
    }
}

function _applyMaximize(colId) {
    // Refuse to maximize the middle column when we're in 2-col mode — it's
    // hidden by CD-1 anyway. (Defensive: the button's container is also
    // hidden via CSS in 2-col mode, but this guard prevents edge cases.)
    if (colId === 'middleColumn' && getLayoutMode() === '2') {
        console.warn('[ColumnMaximize] Cannot maximize middle column in 2-column mode');
        return;
    }

    // Restore any previously-maximized column first
    _clearMaximizedClasses();

    const col = document.getElementById(colId);
    if (!col) return;

    col.classList.add('maximized');
    _el.mainContent.classList.add('has-maximized');

    // Mark the button itself as active
    const btn = col.querySelector('[data-maximize-target]');
    if (btn) {
        btn.classList.add('active');
        btn.title = 'Restore column';
        btn.setAttribute('aria-label', 'Restore column');
    }

    _maximizedColId = colId;
}

function _applyRestore() {
    _clearMaximizedClasses();
    _el.mainContent.classList.remove('has-maximized');
    _maximizedColId = null;
}

function _clearMaximizedClasses() {
    COLUMN_IDS.forEach(id => {
        const col = document.getElementById(id);
        if (!col) return;
        col.classList.remove('maximized');
        const btn = col.querySelector('[data-maximize-target]');
        if (btn) {
            btn.classList.remove('active');
            btn.title = 'Maximize column';
            btn.setAttribute('aria-label', `Maximize ${id} column`);
        }
    });
}
