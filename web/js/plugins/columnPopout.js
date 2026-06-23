/**
 * @file columnPopout.js
 * @fileoverview Per-column pop-out to a draggable, resizable floating panel
 * inside the same window.
 *
 * Pop-out MOVES DOM nodes (appendChild) — it never clones. This preserves
 * all event listeners, store subscriptions, and component state. When the
 * user snaps back, the same nodes are moved back into their original parent.
 *
 * Pop-out state is transient: not persisted across reloads.
 */

import { getMode as getLayoutMode } from './layoutMode.js';
import { restore as restoreMaximize, getMaximizedColumn } from './columnMaximize.js';

const COLUMN_META = {
    leftColumn:   { name: 'Configuration',        badgeColor: 'var(--col-config, #4a90d9)' },
    middleColumn: { name: 'Frame Structure',      badgeColor: 'var(--col-frame, #8b5cf6)'  },
    rightColumn:  { name: 'Control & Monitoring', badgeColor: 'var(--col-control, #10b981)' },
};

/** Tracks active pop-outs:
 *    colId -> { panelEl, placeholderEl, host, dragCleanup, resizeCleanup }
 */
const _active = new Map();

// Panel positioning: stagger new panels slightly
let _nextOffset = 0;
const STAGGER_PX = 28;

// ============================================================================
// PUBLIC API
// ============================================================================

export function initColumnPopout() {
    const mainContent = document.getElementById('mainContent');
    if (!mainContent) {
        console.warn('[ColumnPopout] #mainContent not found, aborting');
        return;
    }

    // Event delegation on body so future buttons (snap-back, close) are caught
    document.addEventListener('click', _onDocumentClick);

    console.log('[ColumnPopout] Initialized');
}

/**
 * Programmatic accessor: returns array of column IDs currently popped out.
 * @returns {string[]}
 */
export function getPoppedOutColumns() {
    return Array.from(_active.keys());
}

/**
 * Snap back everything (e.g., emergency restore before some other operation).
 */
export function snapBackAll() {
    const ids = Array.from(_active.keys());
    ids.forEach(_snapBack);
}

// ============================================================================
// EVENT DELEGATION
// ============================================================================

function _onDocumentClick(e) {
    // Pop-out button clicked
    const popoutBtn = e.target.closest('[data-popout-target]');
    if (popoutBtn) {
        const targetId = popoutBtn.dataset.popoutTarget;
        if (COLUMN_META[targetId]) {
            _popOut(targetId);
        }
        return;
    }

    // Snap-back button clicked (on placeholder OR on panel titlebar)
    const snapBtn = e.target.closest('[data-snapback-target]');
    if (snapBtn) {
        const targetId = snapBtn.dataset.snapbackTarget;
        if (COLUMN_META[targetId]) {
            _snapBack(targetId);
        }
    }
}

// ============================================================================
// POP OUT
// ============================================================================

function _popOut(colId) {
    if (_active.has(colId)) {
        // Already popped out — bring panel to front instead
        const entry = _active.get(colId);
        _bringToFront(entry.panelEl);
        return;
    }

    // If middle column is requested to be popped while in 2-col mode, refuse.
    // (CD-1 keeps middle column's children inside #rightColumn in 2-col mode,
    // so there's nothing meaningful to pop from #middleColumn itself.)
    if (colId === 'middleColumn' && getLayoutMode() === '2') {
        console.warn('[ColumnPopout] Cannot pop middle column in 2-column mode');
        return;
    }

    // If a column is maximized, restore first to avoid mixed state.
    if (getMaximizedColumn()) {
        restoreMaximize();
    }

    const col = document.getElementById(colId);
    if (!col) return;

    // Create the host that will hold the column's children inside the panel
    const host = document.createElement('div');
    host.className = 'pop-body-host';
    host.setAttribute('data-pop-host-for', colId);

    // Move (not clone) every child of the column into the host,
    // EXCEPT the toolbar (identified by data-column-id; it stays with the
    // hidden column and is hidden too).
    const children = Array.from(col.children);
    for (const child of children) {
        if (child.hasAttribute && child.hasAttribute('data-column-id')) continue;
        host.appendChild(child);  // appendChild MOVES — doesn't clone
    }

    // Build the floating panel
    const meta = COLUMN_META[colId];
    const panel = document.createElement('div');
    // `popout-panel`, `pop-resizer` retained as JS marker classes for
    // querySelector / body-class state hooks. Visual styling is Tailwind.
    panel.className = 'popout-panel fixed bg-[var(--bg-app,#0f1419)] border border-[var(--border-strong,rgba(255,255,255,0.15))] rounded-lg shadow-[0_10px_40px_rgba(0,0,0,0.5)] flex flex-col overflow-hidden z-[500] min-w-[320px] min-h-[240px]';
    panel.setAttribute('data-popout-for', colId);
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', `${meta.name} (popped out)`);

    // Default size and position: centered-ish with stagger
    const W = 520, H = 640;
    const baseX = Math.max(20, (window.innerWidth  - W) / 2);
    const baseY = Math.max(20, (window.innerHeight - H) / 2);
    panel.style.width  = W + 'px';
    panel.style.height = H + 'px';
    panel.style.left   = (baseX + _nextOffset) + 'px';
    panel.style.top    = (baseY + _nextOffset) + 'px';
    _nextOffset = (_nextOffset + STAGGER_PX) % (STAGGER_PX * 4);

    const titlebarCls = 'flex items-center justify-between px-3 py-2 bg-[var(--bg-panel,rgba(255,255,255,0.03))] border-b border-[var(--border-strong,rgba(255,255,255,0.12))] cursor-move select-none shrink-0';
    const titleCls = 'flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.5px] text-[var(--text-secondary,#94a3b8)]';
    const badgeCls = 'w-1.5 h-1.5 rounded-full inline-block';
    const suffixCls = 'text-[var(--text-muted,#64748b)] text-[10px] ml-2 font-normal normal-case tracking-normal';
    const actionsCls = 'flex gap-1';
    const actionBtnCls = 'bg-transparent border border-transparent text-[var(--text-muted,#64748b)] py-[3px] px-2 cursor-pointer rounded-[3px] text-xs leading-none transition-all duration-150 font-[inherit] hover:bg-[var(--bg-card,rgba(255,255,255,0.08))] hover:text-[var(--text-primary,#e4e7ec)] hover:border-[var(--border,rgba(255,255,255,0.12))]';
    const bodyCls = 'pop-body flex-1 overflow-auto p-3 flex flex-col gap-2.5';
    const resizerCls = 'pop-resizer absolute right-0 bottom-0 w-4 h-4 cursor-nwse-resize z-[2] bg-[linear-gradient(135deg,transparent_50%,var(--border-strong,rgba(255,255,255,0.2))_50%)]';

    panel.innerHTML = `
        <div class="${titlebarCls}" data-drag-handle="true">
            <div class="${titleCls}">
                <span class="${badgeCls}" style="background: ${meta.badgeColor};"></span>
                ${meta.name}
                <span class="${suffixCls}">[Popped Out]</span>
            </div>
            <div class="${actionsCls}">
                <button class="${actionBtnCls}" data-snapback-target="${colId}" title="Snap back to main window" aria-label="Snap back">↩ Snap Back</button>
                <button class="${actionBtnCls}" data-snapback-target="${colId}" title="Close" aria-label="Close">✕</button>
            </div>
        </div>
        <div class="${bodyCls}"></div>
        <div class="${resizerCls}" aria-hidden="true"></div>
    `;

    // Insert the moved children into the panel body
    panel.querySelector('.pop-body').appendChild(host);

    document.body.appendChild(panel);

    // Build the placeholder in the main layout
    const placeholder = document.createElement('div');
    placeholder.className = 'flex flex-1 basis-0 min-w-[200px] flex-col items-center justify-center gap-3 bg-[var(--bg-panel,rgba(255,255,255,0.02))] border-2 border-dashed border-[var(--border-strong,rgba(255,255,255,0.15))] m-3 rounded-lg text-[var(--text-muted,#64748b)] p-5 text-center text-xs';
    placeholder.setAttribute('data-placeholder-for', colId);
    placeholder.innerHTML = `
        <div class="text-[40px] opacity-35" aria-hidden="true">⧉</div>
        <div class="font-semibold text-[var(--text-secondary,#94a3b8)] text-[13px]">${meta.name}</div>
        <div class="text-[11px] text-[var(--text-muted,#64748b)]">This column is in a floating panel</div>
        <button class="bg-[var(--bg-card,rgba(0,0,0,0.3))] text-[var(--text-primary,#e4e7ec)] border border-[var(--border,rgba(255,255,255,0.12))] py-1.5 px-3.5 rounded text-xs cursor-pointer font-[inherit] inline-flex items-center gap-1.5 transition-[background] duration-150 hover:bg-[var(--bg-card-header,rgba(255,255,255,0.08))]" data-snapback-target="${colId}" type="button">↩ Snap Back</button>
    `;

    // Place the placeholder INSIDE the (now-empty-of-children) column so the
    // column stays in its grid track — #mainContent is a 5-track grid and
    // hiding a column + its handles leaves empty tracks that caused the
    // remaining columns to look blank. Keeping the column in-place avoids that.
    col.appendChild(placeholder);
    col.classList.add('column-contains-placeholder');

    // Make the panel draggable and resizable
    const dragCleanup   = _makeDraggable(panel);
    const resizeCleanup = _makeResizable(panel);

    _active.set(colId, { panelEl: panel, placeholderEl: placeholder, host, dragCleanup, resizeCleanup });

    console.log(`[ColumnPopout] Popped out: ${colId}`);
}

// ============================================================================
// SNAP BACK
// ============================================================================

function _snapBack(colId) {
    const entry = _active.get(colId);
    if (!entry) return;

    const col = document.getElementById(colId);
    if (!col) {
        // Column gone — just remove the floating panel
        entry.panelEl.remove();
        entry.placeholderEl.remove();
        if (entry.dragCleanup)   entry.dragCleanup();
        if (entry.resizeCleanup) entry.resizeCleanup();
        _active.delete(colId);
        return;
    }

    // Remove the placeholder FIRST (it's a child of the column now) so it
    // doesn't end up mixed with the restored children.
    entry.placeholderEl.remove();

    // Move children back from the host into the column
    const host = entry.host;
    while (host.firstChild) {
        col.appendChild(host.firstChild);  // MOVES — doesn't clone
    }

    // Clean up panel
    entry.panelEl.remove();
    if (entry.dragCleanup)   entry.dragCleanup();
    if (entry.resizeCleanup) entry.resizeCleanup();

    // Clear the placeholder-mode class
    col.classList.remove('column-contains-placeholder');

    _active.delete(colId);

    console.log(`[ColumnPopout] Snapped back: ${colId}`);
}

// ============================================================================
// DRAG
// ============================================================================

function _makeDraggable(panel) {
    const titlebar = panel.querySelector('[data-drag-handle="true"]');
    if (!titlebar) return () => {};

    let startX = 0, startY = 0, origX = 0, origY = 0;
    let isDragging = false;

    const onDown = (e) => {
        // Don't drag if click was on a button inside the titlebar
        if (e.target.closest('button')) return;
        // Only left mouse button
        if (e.button !== 0) return;

        isDragging = true;
        startX = e.clientX;
        startY = e.clientY;
        const rect = panel.getBoundingClientRect();
        origX = rect.left;
        origY = rect.top;

        document.body.classList.add('popout-interacting');
        _bringToFront(panel);

        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
        e.preventDefault();
    };

    const onMove = (e) => {
        if (!isDragging) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        let newX = origX + dx;
        let newY = origY + dy;

        // Clamp to viewport — keep at least 80px of titlebar visible on screen
        const pW = panel.offsetWidth;
        const pH = panel.offsetHeight;
        newX = Math.max(-(pW - 80), Math.min(window.innerWidth - 80, newX));
        newY = Math.max(0, Math.min(window.innerHeight - 40, newY));

        panel.style.left = newX + 'px';
        panel.style.top  = newY + 'px';
    };

    const onUp = () => {
        isDragging = false;
        document.body.classList.remove('popout-interacting');
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
    };

    titlebar.addEventListener('mousedown', onDown);

    return () => {
        titlebar.removeEventListener('mousedown', onDown);
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
    };
}

// ============================================================================
// RESIZE
// ============================================================================

function _makeResizable(panel) {
    const resizer = panel.querySelector('.pop-resizer');
    if (!resizer) return () => {};

    let startX = 0, startY = 0, startW = 0, startH = 0;
    let isResizing = false;

    const onDown = (e) => {
        if (e.button !== 0) return;
        isResizing = true;
        startX = e.clientX;
        startY = e.clientY;
        startW = panel.offsetWidth;
        startH = panel.offsetHeight;

        document.body.classList.add('popout-interacting', 'popout-resizing');
        _bringToFront(panel);

        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
        e.preventDefault();
    };

    const onMove = (e) => {
        if (!isResizing) return;
        const dw = e.clientX - startX;
        const dh = e.clientY - startY;
        const newW = Math.max(320, Math.min(window.innerWidth  - 20, startW + dw));
        const newH = Math.max(240, Math.min(window.innerHeight - 20, startH + dh));
        panel.style.width  = newW + 'px';
        panel.style.height = newH + 'px';
    };

    const onUp = () => {
        isResizing = false;
        document.body.classList.remove('popout-interacting', 'popout-resizing');
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
    };

    resizer.addEventListener('mousedown', onDown);

    return () => {
        resizer.removeEventListener('mousedown', onDown);
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
    };
}

// ============================================================================
// Z-ORDER
// ============================================================================

function _bringToFront(panel) {
    // Find max z-index among all panels, set this one above
    const panels = document.querySelectorAll('.popout-panel');
    let maxZ = 500;
    panels.forEach(p => {
        const z = parseInt(getComputedStyle(p).zIndex, 10);
        if (!isNaN(z) && z > maxZ) maxZ = z;
    });
    panel.style.zIndex = (maxZ + 1).toString();
}
