/**
 * @file faultSidebar.js
 * @fileoverview Right-side slide-in panel that hosts the Fault Injection panel.
 *
 * Triggered by a vertical side-tab button (#faultSidebarTab) pinned to the
 * right edge of the viewport.
 *
 * Overlay variant: unlike frameSidebar (which pushes main content), this panel
 * floats above #mainContent at z-index 95 so it does not interact with the
 * column resizable layout.
 *
 * The panel is hidden via CSS transform (translateX(100%)) — NOT display:none —
 * so the FaultInjectionPanel DOM stays in the document and any internal
 * intervals/listeners keep running while collapsed.
 */

import { refreshAfterLayoutChange } from '../utils/resizableColumns.js';
import { closeFrameSidebar, isFrameSidebarOpen } from './frameSidebar.js';

const STORAGE_KEY = 'faultPanelVisible';
const BODY_OPEN_CLASS = 'fault-sidebar-open';
const SIDEBAR_WIDTH_PX = 560;   // matches the w-[560px] in the markup

const _el = {};

function _alignSidebarToMain() {
    const main = document.getElementById('mainContent');
    const sidebar = _el.sidebar;
    if (!main || !sidebar) return;
    const rect = main.getBoundingClientRect();
    sidebar.style.top = `${rect.top}px`;
    sidebar.style.height = `${rect.height}px`;
}

/**
 * Push-layout: shrink #mainContent's width when the sidebar is open so the two
 * existing columns squeeze and make room on the right — same approach as
 * frameSidebar (rather than overlaying on top of the right panel).
 */
function _syncBodyState() {
    const sidebar = _el.sidebar;
    const main = document.getElementById('mainContent');
    const open = !!(sidebar && !sidebar.classList.contains('hidden'));

    document.body.classList.toggle(BODY_OPEN_CLASS, open);

    if (main) {
        main.style.transition = 'width 0.3s ease, margin 0.3s ease';
        if (open) {
            main.style.width = `calc(100% - ${SIDEBAR_WIDTH_PX}px)`;
            // Pin main left when shrunk (else `.main-content { margin: 0 auto }`
            // centres it and splits the freed band into two empty halves).
            main.style.marginLeft = '0';
            main.style.marginRight = '0';
        } else if (!isFrameSidebarOpen()) {
            // Only release the push when the frame sidebar isn't using it —
            // otherwise closing/initialising this panel would clobber frame's push.
            main.style.width = '';
            main.style.marginLeft = '';
            main.style.marginRight = '';
        }
    }
    if (sidebar) {
        sidebar.style.width = `${SIDEBAR_WIDTH_PX}px`;
    }

    _alignSidebarToMain();

    try { refreshAfterLayoutChange(); } catch (err) {
        console.warn('[FaultSidebar] refreshAfterLayoutChange failed:', err);
    }
}

function _setVisible(visible, { persist = true } = {}) {
    if (!_el.sidebar) return;
    // Frame Structure and Fault Injection both push the layout, so only one can
    // be open at a time — opening this one closes the other to avoid overlap.
    if (visible) {
        try { if (isFrameSidebarOpen()) closeFrameSidebar(); } catch { /* ignore */ }
    }
    _el.sidebar.classList.toggle('hidden', !visible);
    if (_el.tab) {
        _el.tab.setAttribute('aria-expanded', visible ? 'true' : 'false');
    }
    _syncBodyState();
    if (persist) {
        try { localStorage.setItem(STORAGE_KEY, visible ? '1' : '0'); }
        catch { /* quota — ignore */ }
    }
}

export function initFaultSidebar() {
    _el.sidebar = document.getElementById('faultSidebar');
    _el.tab = document.getElementById('faultSidebarTab');
    if (!_el.sidebar) {
        console.warn('[FaultSidebar] #faultSidebar not found, aborting init');
        return;
    }

    // Default closed on first launch — fault injection is an opt-in feature.
    const saved = (() => {
        try { return localStorage.getItem(STORAGE_KEY); } catch { return null; }
    })();
    const initialVisible = saved === '1';
    _setVisible(initialVisible, { persist: false });

    if (_el.tab) {
        _el.tab.addEventListener('click', () => {
            const isOpenNow = !_el.sidebar.classList.contains('hidden');
            _setVisible(!isOpenNow);
        });
    }

    document.querySelectorAll('[data-close="faultSidebar"]').forEach(btn => {
        btn.addEventListener('click', () => _setVisible(false));
    });

    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        const active = document.activeElement;
        if (active && (active.tagName === 'INPUT' ||
                       active.tagName === 'TEXTAREA' ||
                       active.isContentEditable)) {
            return;
        }
        if (!_el.sidebar.classList.contains('hidden')) {
            _setVisible(false);
        }
    });

    window.addEventListener('resize', _alignSidebarToMain);

    console.log('[FaultSidebar] Initialized (visible =', initialVisible, ')');
}

export function isFaultSidebarOpen() {
    return _el.sidebar && !_el.sidebar.classList.contains('hidden');
}

export function openFaultSidebar() { _setVisible(true); }
export function closeFaultSidebar() { _setVisible(false); }
