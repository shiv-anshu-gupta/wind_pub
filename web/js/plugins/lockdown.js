/**
 * @file lockdown.js
 * @fileoverview Browser lockdown: blocks DevTools shortcuts, suppresses
 * native context menu, prevents accidental reload / print / view-source.
 *
 * Must be initialized FIRST in app.js, before any other plugin or component.
 */

/**
 * Shortcuts to block. Each entry is a matcher function returning true if
 * the KeyboardEvent should be blocked.
 */
const BLOCKED_SHORTCUTS = [
    // F12 — DevTools
    (e) => e.key === 'F12',
    // Ctrl+Shift+I / Cmd+Shift+I — DevTools
    (e) => (e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'I' || e.key === 'i'),
    // Ctrl+Shift+J / Cmd+Shift+J — DevTools Console
    (e) => (e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'J' || e.key === 'j'),
    // Ctrl+Shift+C / Cmd+Shift+C — DevTools Element Picker
    (e) => (e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'C' || e.key === 'c'),
    // Ctrl+U / Cmd+U — View Source
    (e) => (e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 'U' || e.key === 'u'),
    // Ctrl+R / Cmd+R — Reload
    (e) => (e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 'R' || e.key === 'r'),
    // Ctrl+Shift+R / Cmd+Shift+R — Hard Reload
    (e) => (e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'R' || e.key === 'r'),
    // F5 — Reload
    (e) => e.key === 'F5',
    // Ctrl+F5 — Hard Reload
    (e) => (e.ctrlKey || e.metaKey) && e.key === 'F5',
    // Ctrl+P / Cmd+P — Print
    (e) => (e.ctrlKey || e.metaKey) && (e.key === 'P' || e.key === 'p'),
    // Ctrl+'=' / Ctrl+'-' / Ctrl+'0' — Browser zoom (we control sizing ourselves)
    (e) => (e.ctrlKey || e.metaKey) && (e.key === '=' || e.key === '+'),
    (e) => (e.ctrlKey || e.metaKey) && e.key === '-',
    (e) => (e.ctrlKey || e.metaKey) && e.key === '0',
    // Ctrl+Shift+Delete — Clear browsing data
    (e) => (e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'Delete',
];

/**
 * Selectors where the native browser context menu IS allowed.
 * Everything else gets blocked. The application's own custom context menus
 * (e.g., the Channels table column picker) must handle `contextmenu` with
 * `preventDefault()` to suppress the native menu AND show their own.
 */
const CONTEXT_MENU_ALLOWED_SELECTORS = [
    'input',
    'textarea',
    'select',
    '[contenteditable="true"]',
];

/**
 * Initialize all lockdown features. Call once, as the very first thing
 * in app.js, before any other module imports itself.
 */
export function initLockdown() {
    blockShortcuts();
    blockContextMenu();
    blockDragDropFiles();
    blockMiddleClickAutoscroll();
    console.log('[Lockdown] Initialized');
}

function blockShortcuts() {
    // capture: true — catches the event before any other listener
    document.addEventListener('keydown', (e) => {
        for (const matcher of BLOCKED_SHORTCUTS) {
            if (matcher(e)) {
                e.preventDefault();
                e.stopPropagation();
                console.log(`[Lockdown] Blocked shortcut: ${e.ctrlKey ? 'Ctrl+' : ''}${e.metaKey ? 'Cmd+' : ''}${e.shiftKey ? 'Shift+' : ''}${e.key}`);
                return;
            }
        }
    }, true);
}

function blockContextMenu() {
    document.addEventListener('contextmenu', (e) => {
        // Allow the native menu inside form fields so users can paste/cut/copy
        for (const selector of CONTEXT_MENU_ALLOWED_SELECTORS) {
            if (e.target.matches(selector) || e.target.closest(selector)) {
                return;
            }
        }
        // Allow the app's own custom context menus — these set a data attribute
        // on themselves so we know to allow the event through, and they call
        // preventDefault() themselves to suppress the native menu.
        if (e.target.closest('[data-allow-context-menu="true"]')) {
            return;
        }
        // Block everything else
        e.preventDefault();
    }, true);
}

function blockDragDropFiles() {
    // Prevent the browser from navigating to a dropped file (which would
    // destroy the app's state). The DataSource component handles its own
    // drops explicitly via its drop zone, so this only catches accidents
    // outside that zone.
    const block = (e) => {
        // Allow drop zones that opted in with data-drop-zone="true"
        if (e.target.closest('[data-drop-zone="true"]')) {
            return;
        }
        // Also allow the PCAP drop zone (legacy — it predates data-drop-zone)
        if (e.target.closest('#pcapDropZone')) {
            return;
        }
        e.preventDefault();
    };
    document.addEventListener('dragover', block);
    document.addEventListener('drop', block);
}

function blockMiddleClickAutoscroll() {
    // Middle-click in some browsers triggers autoscroll mode (a weird
    // cursor that scrolls based on mouse movement). For a desktop app
    // it's nothing but accidental behavior.
    document.addEventListener('mousedown', (e) => {
        if (e.button === 1) {
            e.preventDefault();
        }
    });
}
