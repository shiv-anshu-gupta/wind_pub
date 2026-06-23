/**
 * @file resizableColumns.js
 * @fileoverview VS Code-style draggable column resizer.
 * @module utils/resizableColumns
 * @description
 * Enables drag-to-resize between the main layout columns. Two resize handles
 * sit between adjacent columns. Dragging a handle redistributes column widths
 * while respecting minimum width constraints.
 *
 * Supports two layout modes (see layoutMode.js / Task CD-1):
 *   - 3-column: left + handleLeft + middle + handleRight + right (5 grid tracks)
 *   - 2-column: left + handleLeft + right                        (3 grid tracks)
 *
 * Behavior mirrors VS Code's sidebar splitters:
 * - Handle highlights on hover (blue accent)
 * - Smooth dragging with no text selection
 * - Persists widths to localStorage (mode-scoped so each mode keeps its own sizing)
 * - Respects minimum column widths
 * - Double-click to reset to equal fractions
 */

/** Minimum column width in pixels */
const MIN_COLUMN_WIDTH = 200;

/** Mode-scoped LocalStorage keys. Each mode persists its own preferred sizing. */
const STORAGE_KEY_TWO_COL = 'sv-pub-column-widths-2';
const STORAGE_KEY_THREE_COL = 'sv-pub-column-widths-3';

/** Read the current layout mode from #mainContent's class list. */
function _currentMode() {
    const main = document.getElementById('mainContent');
    return (main && main.classList.contains('two-column-layout')) ? '2' : '3';
}

function _storageKey() {
    return _currentMode() === '2' ? STORAGE_KEY_TWO_COL : STORAGE_KEY_THREE_COL;
}

/**
 * Returns the columns currently participating in layout, in left-to-right order.
 * In 3-column mode, all three. In 2-column mode, left + right only.
 * @returns {HTMLElement[]}
 */
function getVisibleColumns() {
    const left = document.getElementById('leftColumn');
    const middle = document.getElementById('middleColumn');
    const right = document.getElementById('rightColumn');
    const cols = [];
    if (left) cols.push(left);
    if (middle && getComputedStyle(middle).display !== 'none') cols.push(middle);
    if (right) cols.push(right);
    return cols;
}

/**
 * Returns the resize handles that are currently visible (not display:none).
 * @returns {HTMLElement[]}
 */
function getVisibleHandles() {
    return ['resizeHandleLeft', 'resizeHandleRight']
        .map(id => document.getElementById(id))
        .filter(h => h && getComputedStyle(h).display !== 'none');
}

/**
 * Initialize resizable columns. Call once after DOM is ready.
 */
export function initResizableColumns() {
    const mainContent = document.getElementById('mainContent');
    const leftColumn = document.getElementById('leftColumn');
    const middleColumn = document.getElementById('middleColumn');
    const rightColumn = document.getElementById('rightColumn');
    const handleLeft = document.getElementById('resizeHandleLeft');
    const handleRight = document.getElementById('resizeHandleRight');

    if (!mainContent || !leftColumn || !middleColumn || !rightColumn || !handleLeft || !handleRight) {
        console.warn('[ResizableColumns] Required elements not found, skipping initialization.');
        return;
    }

    // Restore saved widths for current mode (or equal fractions)
    restoreSavedWidths();

    // Setup drag for left handle (between left & middle in 3-col, between left & right in 2-col)
    setupDragHandle(handleLeft, mainContent, leftColumn, middleColumn, rightColumn, 'left');

    // Setup drag for right handle (between middle & right) — guarded against hidden state in 2-col
    setupDragHandle(handleRight, mainContent, leftColumn, middleColumn, rightColumn, 'right');

    // Double-click either handle to reset to equal fractions for the current mode
    handleLeft.addEventListener('dblclick', resetWidths);
    handleRight.addEventListener('dblclick', resetWidths);
}

/**
 * Set up mouse drag behavior on a resize handle.
 * @param {HTMLElement} handle - The resize handle element
 * @param {HTMLElement} mainContent - The grid container
 * @param {HTMLElement} leftCol - Left column element
 * @param {HTMLElement} middleCol - Middle column element
 * @param {HTMLElement} rightCol - Right column element
 * @param {'left'|'right'} which - Which handle
 */
function setupDragHandle(handle, mainContent, leftCol, middleCol, rightCol, which) {
    let startX = 0;
    let startLeftW = 0;
    let startMiddleW = 0;
    let startRightW = 0;

    function onMouseDown(e) {
        // Guard: if this handle is hidden (e.g. right handle in 2-col mode), bail.
        if (getComputedStyle(handle).display === 'none') return;

        e.preventDefault();
        e.stopPropagation();

        startX = e.clientX;
        startLeftW = leftCol.getBoundingClientRect().width;
        startMiddleW = middleCol.getBoundingClientRect().width;
        startRightW = rightCol.getBoundingClientRect().width;

        handle.classList.add('active');
        document.body.classList.add('resizing-columns');

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
    }

    function onMouseMove(e) {
        const dx = e.clientX - startX;
        const mode = _currentMode();

        if (mode === '2') {
            // In 2-col mode there's only one active handle (the left one) and it
            // resizes leftCol ↔ rightCol. Middle is hidden and ignored.
            const totalWidth = startLeftW + startRightW;
            let newLeftW = startLeftW + dx;
            let newRightW = startRightW - dx;

            if (newLeftW < MIN_COLUMN_WIDTH) {
                newLeftW = MIN_COLUMN_WIDTH;
                newRightW = totalWidth - newLeftW;
            }
            if (newRightW < MIN_COLUMN_WIDTH) {
                newRightW = MIN_COLUMN_WIDTH;
                newLeftW = totalWidth - newRightW;
            }
            applyTwoColumnWidths(mainContent, newLeftW, newRightW);
            return;
        }

        // 3-col mode (original behavior)
        const totalWidth = startLeftW + startMiddleW + startRightW;
        let newLeftW, newMiddleW, newRightW;

        if (which === 'left') {
            newLeftW = startLeftW + dx;
            newMiddleW = startMiddleW - dx;
            newRightW = startRightW;

            if (newLeftW < MIN_COLUMN_WIDTH) {
                newLeftW = MIN_COLUMN_WIDTH;
                newMiddleW = totalWidth - newLeftW - newRightW;
            }
            if (newMiddleW < MIN_COLUMN_WIDTH) {
                newMiddleW = MIN_COLUMN_WIDTH;
                newLeftW = totalWidth - newMiddleW - newRightW;
            }
        } else {
            newLeftW = startLeftW;
            newMiddleW = startMiddleW + dx;
            newRightW = startRightW - dx;

            if (newMiddleW < MIN_COLUMN_WIDTH) {
                newMiddleW = MIN_COLUMN_WIDTH;
                newRightW = totalWidth - newLeftW - newMiddleW;
            }
            if (newRightW < MIN_COLUMN_WIDTH) {
                newRightW = MIN_COLUMN_WIDTH;
                newMiddleW = totalWidth - newLeftW - newRightW;
            }
        }

        applyThreeColumnWidths(mainContent, newLeftW, newMiddleW, newRightW);
    }

    function onMouseUp() {
        handle.classList.remove('active');
        document.body.classList.remove('resizing-columns');

        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);

        // Persist current widths under the mode-scoped key
        saveCurrentWidths();
    }

    handle.addEventListener('mousedown', onMouseDown);
}

/** Apply 3-col widths: `${L}px 4px ${M}px 4px ${R}px` */
function applyThreeColumnWidths(mainContent, leftW, middleW, rightW) {
    mainContent.style.gridTemplateColumns = `${leftW}px 4px ${middleW}px 4px ${rightW}px`;
}

/** Apply 2-col widths: `${L}px 4px ${R}px` */
function applyTwoColumnWidths(mainContent, leftW, rightW) {
    mainContent.style.gridTemplateColumns = `${leftW}px 4px ${rightW}px`;
}

/**
 * Save current visible column widths to localStorage under the mode-scoped key.
 * Stored as fractional ratios so the layout stays responsive if the window resizes.
 */
function saveCurrentWidths() {
    const cols = getVisibleColumns();
    const widths = cols.map(c => c.getBoundingClientRect().width);
    const total = widths.reduce((s, w) => s + w, 0);
    if (total <= 0) return;
    const ratios = widths.map(w => w / total);
    try {
        localStorage.setItem(_storageKey(), JSON.stringify(ratios));
    } catch { /* quota exceeded - ignore */ }
}

/**
 * Restore saved column widths for the current mode. Falls back to equal
 * fractions if nothing saved or the saved shape doesn't match current mode.
 * Also normalises the inline grid-template-columns to match the mode track
 * count — important when switching modes without a saved entry yet.
 */
function restoreSavedWidths() {
    const mainContent = document.getElementById('mainContent');
    if (!mainContent) return;

    const cols = getVisibleColumns();
    const mode = _currentMode();

    try {
        const saved = localStorage.getItem(_storageKey());
        if (saved) {
            const ratios = JSON.parse(saved);
            if (
                Array.isArray(ratios) &&
                ratios.length === cols.length &&
                ratios.every(r => typeof r === 'number' && r > 0)
            ) {
                if (mode === '2' && ratios.length === 2) {
                    mainContent.style.gridTemplateColumns =
                        `${ratios[0]}fr 4px ${ratios[1]}fr`;
                    return;
                }
                if (mode === '3' && ratios.length === 3) {
                    mainContent.style.gridTemplateColumns =
                        `${ratios[0]}fr 4px ${ratios[1]}fr 4px ${ratios[2]}fr`;
                    return;
                }
            }
        }
    } catch { /* corrupted data - fall through to defaults */ }

    // Default: equal fractions for visible columns, correct track count per mode
    mainContent.style.gridTemplateColumns =
        (mode === '2') ? '1fr 4px 1fr' : '1fr 4px 1fr 4px 1fr';
}

/**
 * Reset columns to equal fractions and clear the mode-scoped saved preference.
 * Invoked via double-click on either resize handle.
 */
function resetWidths() {
    const mainContent = document.getElementById('mainContent');
    if (!mainContent) return;
    const mode = _currentMode();
    mainContent.style.gridTemplateColumns =
        (mode === '2') ? '1fr 4px 1fr' : '1fr 4px 1fr 4px 1fr';
    try {
        localStorage.removeItem(_storageKey());
    } catch { /* ignore */ }
}

/**
 * Called by layoutMode.js after a layout switch so the resize logic
 * re-applies the correct track count and any mode-specific saved widths.
 */
export function refreshAfterLayoutChange() {
    restoreSavedWidths();
}
