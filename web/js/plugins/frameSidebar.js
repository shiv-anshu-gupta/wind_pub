/**
 * @file frameSidebar.js
 * @fileoverview Right-side slide-in panel that hosts the Frame Structure viewer.
 *
 * Triggered by a header toolbar button (#toggleFrameStructure) — replaces the
 * earlier vertical purple side tab (Pass 5).
 *
 * The panel is hidden via CSS transform (translateX(100%)) — NOT display:none —
 * so the FrameViewer DOM stays in the document and its store subscriptions
 * (smpCnt, channels, stats) keep updating in the background while collapsed.
 *
 * Visibility state persists across reloads via localStorage:
 *   localStorage['framePanelVisible'] === '1'   → visible
 *   localStorage['framePanelVisible'] === '0'   → hidden
 *   (anything else / missing)                    → default visible (first launch)
 */

import { setMode as setLayoutMode } from './layoutMode.js';
import { refreshAfterLayoutChange } from '../utils/resizableColumns.js';
import { closeFaultSidebar, isFaultSidebarOpen } from './faultSidebar.js';

const STORAGE_KEY = 'framePanelVisible';
const BODY_OPEN_CLASS = 'frame-sidebar-open';
const SIDEBAR_WIDTH_PX = 480;

const _el = {};

// ============================================================================
// LAYOUT SYNC
// ============================================================================

function _alignSidebarToMain() {
    const main = document.getElementById('mainContent');
    const sidebar = document.getElementById('frameSidebar');
    if (!main || !sidebar) return;
    const rect = main.getBoundingClientRect();
    sidebar.style.top = `${rect.top}px`;
    sidebar.style.height = `${rect.height}px`;
}

/** Push-layout: shrink #mainContent's width when the sidebar is open. */
function _syncBodyState() {
    const sidebar = document.getElementById('frameSidebar');
    const main = document.getElementById('mainContent');
    const open = !!(sidebar && !sidebar.classList.contains('hidden'));

    document.body.classList.toggle(BODY_OPEN_CLASS, open);

    if (main) {
        main.style.transition = 'width 0.3s ease, margin 0.3s ease';
        main.style.width = open ? `calc(100% - ${SIDEBAR_WIDTH_PX}px)` : '';
        // Pin main to the left when shrunk. Pass 5's `.main-content { margin: 0 auto }`
        // would otherwise center the shrunk main, splitting the freed sidebar
        // width into half-left / half-right empty bands.
        main.style.marginLeft = open ? '0' : '';
        main.style.marginRight = open ? '0' : '';
    }
    if (sidebar) {
        sidebar.style.width = `${SIDEBAR_WIDTH_PX}px`;
    }

    _alignSidebarToMain();

    try { refreshAfterLayoutChange(); } catch (err) {
        console.warn('[FrameSidebar] refreshAfterLayoutChange failed:', err);
    }
}

// ============================================================================
// TOGGLE BUTTON
// ============================================================================

/** Update the header button icon + active state to reflect panel visibility. */
function _renderToggleButton(isOpen) {
    if (!_el.toggleBtn) return;
    _el.toggleBtn.classList.toggle('active', isOpen);
    _el.toggleBtn.setAttribute('aria-pressed', isOpen ? 'true' : 'false');
    // Swap the inner lucide icon name and re-render via createIcons.
    _el.toggleBtn.innerHTML = isOpen
        ? '<i data-lucide="panel-right-close"></i>'
        : '<i data-lucide="panel-right"></i>';
    if (window.lucide) {
        try { window.lucide.createIcons(); }
        catch (err) { console.warn('[FrameSidebar] lucide.createIcons failed:', err); }
    }
}

function _setVisible(visible, { persist = true } = {}) {
    if (!_el.sidebar) return;
    if (visible) {
        // Both right sidebars push the layout, so only one is open at a time.
        try { if (isFaultSidebarOpen()) closeFaultSidebar(); } catch { /* ignore */ }
        _el.sidebar.classList.remove('hidden');
    } else {
        _el.sidebar.classList.add('hidden');
    }
    _renderToggleButton(visible);
    if (_el.sideTab) {
        _el.sideTab.setAttribute('aria-expanded', visible ? 'true' : 'false');
    }
    _syncBodyState();
    if (persist) {
        try { localStorage.setItem(STORAGE_KEY, visible ? '1' : '0'); }
        catch { /* quota — ignore */ }
    }
}

// ============================================================================
// PUBLIC API
// ============================================================================

export function initFrameSidebar() {
    _el.sidebar = document.getElementById('frameSidebar');
    _el.toggleBtn = document.getElementById('toggleFrameStructure');
    _el.sideTab = document.getElementById('frameSidebarTab');
    if (!_el.sidebar) {
        console.warn('[FrameSidebar] #frameSidebar not found, aborting init');
        return;
    }

    // Force 2-column main layout (no middle column inside .main-content) —
    // Frame Structure lives in the sidebar instead.
    try { setLayoutMode('2'); } catch (err) {
        console.warn('[FrameSidebar] setLayoutMode failed:', err);
    }

    // Apply saved visibility (default: visible on first launch).
    const saved = (() => {
        try { return localStorage.getItem(STORAGE_KEY); } catch { return null; }
    })();
    const initialVisible = saved === null ? true : saved === '1';
    _setVisible(initialVisible, { persist: false });

    // Header toggle
    if (_el.toggleBtn) {
        _el.toggleBtn.addEventListener('click', () => {
            const isOpenNow = !_el.sidebar.classList.contains('hidden');
            _setVisible(!isOpenNow);
        });
    }

    // Right-edge vertical side tab
    if (_el.sideTab) {
        _el.sideTab.addEventListener('click', () => {
            const isOpenNow = !_el.sidebar.classList.contains('hidden');
            _setVisible(!isOpenNow);
        });
    }

    // ✕ inside the sidebar header
    document.querySelectorAll('[data-close]').forEach(btn => {
        btn.addEventListener('click', () => {
            const targetId = btn.dataset.close;
            if (targetId === 'frameSidebar') _setVisible(false);
        });
    });

    // Escape closes — but never while focus is in an input/textarea/contenteditable
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        const active = document.activeElement;
        if (active && (active.tagName === 'INPUT' ||
                       active.tagName === 'TEXTAREA' ||
                       active.isContentEditable)) {
            return;
        }
        if (_el.sidebar && !_el.sidebar.classList.contains('hidden')) {
            _setVisible(false);
        }
    });

    // Re-align sidebar's vertical extent to #mainContent on window resize.
    window.addEventListener('resize', _alignSidebarToMain);

    console.log('[FrameSidebar] Initialized (visible =', initialVisible, ')');
}

export function isFrameSidebarOpen() {
    return _el.sidebar && !_el.sidebar.classList.contains('hidden');
}

export function openFrameSidebar() { _setVisible(true); }
export function closeFrameSidebar() { _setVisible(false); }
