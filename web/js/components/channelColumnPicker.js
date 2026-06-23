/**
 * @file channelColumnPicker.js
 * @fileoverview Right-click column picker for the channels table.
 *
 * Shows a context menu with checkboxes for each possible column,
 * plus "Show All" and "Reset to Default" actions. Persists user
 * selection to localStorage.
 */

/**
 * Every column the Channels table is capable of showing.
 * `default: true` means visible in a fresh install; false means opt-in.
 * `renderer(ch)` returns the HTML for that column's cell given a channel object.
 */
export const CHANNEL_COLUMNS = [
    {
        key: 'color',
        label: 'Color',
        default: true,
        renderer: (ch) => {
            const color = ch.color || _defaultColor(ch.type);
            return `<span class="channel-color" style="background: ${color}"></span>`;
        }
    },
    {
        key: 'id',
        label: 'ID',
        default: true,
        renderer: (ch) => `<span class="channel-name">${ch.id}</span>`
    },
    {
        key: 'label',
        label: 'Label',
        default: false,
        renderer: (ch) => `<span class="channel-label">${ch.label || ch.id}</span>`
    },
    {
        key: 'equation',
        label: 'Equation',
        default: true,
        renderer: (ch) => {
            const eq = ch.equation || ch.defaultEquation || 'N/A';
            // Escape the equation for the title attribute to prevent breakage on quotes
            const safeEq = String(eq).replace(/"/g, '&quot;');
            return `<span class="channel-equation" title="${safeEq}">${_escape(eq)}</span>`;
        }
    },
    {
        key: 'type',
        label: 'Type',
        default: true,
        renderer: (ch) => `<span class="channel-type ${ch.type}">${ch.type}</span>`
    },
    {
        key: 'phase',
        label: 'Phase',
        default: false,
        renderer: (ch) => `<span class="channel-phase">${ch.phase || '-'}</span>`
    },
    {
        key: 'unit',
        label: 'Unit',
        default: false,
        renderer: (ch) => `<span class="channel-unit">${ch.unit || '-'}</span>`
    },
    {
        key: 'scale',
        label: 'Scale',
        default: false,
        renderer: (ch) => {
            const s = ch.scaleFactor != null ? ch.scaleFactor : '-';
            return `<span class="channel-scale">${s}</span>`;
        }
    },
    {
        key: 'magnitude',
        label: 'Magnitude',
        default: true,
        renderer: (ch) => {
            const mag = getMagnitudeFromEquation(ch.equation);
            const text = mag == null ? '—' : mag;
            const title = mag == null
                ? 'Custom equation — edit in the math editor'
                : 'Edit in the math editor (select this channel there)';
            return `<span class="channel-magnitude" title="${title}">${text}</span>`;
        }
    },
];

// ============================================================================
// MAGNITUDE PARSING
// ============================================================================

// Matches "<num> * sin(...)" — captures the leading numeric coefficient.
const MAG_PREFIX_RE = /^(\s*)(-?\d+(?:\.\d+)?)(\s*\*\s*sin\([\s\S]*\)\s*)$/;

/**
 * Extract the leading magnitude (coefficient) from a base-channel equation.
 * Returns null when the equation doesn't have a recognized "<num> * sin(...)"
 * shape and isn't a plain numeric constant — those should be edited via the
 * full math editor instead.
 *
 * @param {string} eq
 * @returns {number|null}
 */
export function getMagnitudeFromEquation(eq) {
    if (eq == null) return null;
    const trimmed = String(eq).trim();
    if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return parseFloat(trimmed);
    const m = trimmed.match(MAG_PREFIX_RE);
    return m ? parseFloat(m[2]) : null;
}

/**
 * Replace the magnitude in an equation while keeping the rest of the shape.
 * - "325 * sin(...)" with newMag=230 → "230 * sin(...)"
 * - Constant "0" with newMag=100 at 60Hz → "100 * sin(2 * PI * 60 * t)"
 * - Constant "0" with newMag=0 → "0"
 * Returns null when the equation shape isn't editable here.
 *
 * @param {string} eq
 * @param {number} newMag
 * @param {number} frequency - System frequency, used when synthesizing a new equation
 * @returns {string|null}
 */
export function setMagnitudeInEquation(eq, newMag, frequency) {
    const mag = Number(newMag);
    if (!Number.isFinite(mag)) return null;
    const trimmed = String(eq ?? '0').trim();

    if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
        if (mag === 0) return '0';
        return `${mag} * sin(2 * PI * ${frequency || 50} * t)`;
    }

    const m = trimmed.match(MAG_PREFIX_RE);
    if (m) return `${m[1]}${mag}${m[3]}`;

    return null;
}

const STORAGE_KEY = 'sv-pub-channels-visible-columns';

/**
 * Get the array of column keys currently visible.
 * Falls back to defaults if nothing is saved or saved data is corrupt.
 * @returns {string[]}
 */
export function getVisibleColumns() {
    try {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (!saved) return _defaultKeys();
        const parsed = JSON.parse(saved);
        if (!Array.isArray(parsed) || parsed.length === 0) return _defaultKeys();
        // Filter out any keys that no longer exist in CHANNEL_COLUMNS (schema evolution safety)
        const validKeys = CHANNEL_COLUMNS.map(c => c.key);
        const filtered = parsed.filter(k => validKeys.includes(k));
        return filtered.length > 0 ? filtered : _defaultKeys();
    } catch (err) {
        console.warn('[ChannelColumnPicker] Could not parse saved columns, using defaults:', err);
        return _defaultKeys();
    }
}

/**
 * Save the visible column list and notify any subscribers via the callback.
 * @param {string[]} keys - Array of column keys to show
 * @param {Function} [onChange] - Callback to re-render the table
 */
export function setVisibleColumns(keys, onChange) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(keys));
    if (typeof onChange === 'function') onChange();
}

/**
 * Attach the right-click column picker to a table element.
 * Call this once after rendering the table. It's safe to call again if the
 * table element was replaced — it wires listeners to the document, keyed off
 * the table's data attributes, so it works across re-renders.
 *
 * @param {HTMLElement} tableElement - The <table> element to attach to
 * @param {Function} onChange - Called after the user changes column visibility
 */
export function attachColumnPicker(tableElement, onChange) {
    if (!tableElement) {
        console.warn('[ChannelColumnPicker] No table element provided');
        return;
    }

    // Mark the table so the lockdown's contextmenu handler lets our menu through.
    tableElement.setAttribute('data-allow-context-menu', 'true');

    // Bind contextmenu on the table itself.
    // We use a named handler stored on the element so repeated calls can clean up.
    if (tableElement._columnPickerHandler) {
        tableElement.removeEventListener('contextmenu', tableElement._columnPickerHandler);
    }

    const handler = (e) => {
        e.preventDefault();
        e.stopPropagation();
        _showMenu(e.clientX, e.clientY, onChange);
    };
    tableElement._columnPickerHandler = handler;
    tableElement.addEventListener('contextmenu', handler);
}

// ============================================================================
// INTERNAL
// ============================================================================

function _defaultKeys() {
    return CHANNEL_COLUMNS.filter(c => c.default).map(c => c.key);
}

function _defaultColor(type) {
    switch (type) {
        case 'voltage':  return '#3b82f6';
        case 'current':  return '#f97316';
        case 'computed': return '#8b5cf6';
        default:         return '#6b7280';
    }
}

function _escape(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

let _menuEl = null;

function _showMenu(x, y, onChange) {
    _hideMenu();

    const visible = getVisibleColumns();

    const menu = document.createElement('div');
    menu.className = 'fixed bg-[var(--bg-card,#fff)] border border-[var(--border-strong,#aaa)] rounded-md p-1 min-w-[180px] shadow-[0_10px_30px_rgba(0,0,0,0.3)] z-[10000] text-xs text-[var(--text-primary,#111)]';
    menu.setAttribute('data-allow-context-menu', 'true');
    const itemCls = 'flex items-center gap-2 px-2.5 py-1.5 cursor-pointer rounded-[3px] select-none hover:bg-[var(--bg-card-header,rgba(0,0,0,0.06))] [&_input[type=checkbox]]:cursor-pointer [&_input[type=checkbox]]:accent-[var(--accent,#4a90d9)]';
    const actionCls = 'px-2.5 py-1.5 cursor-pointer text-[var(--text-secondary,#666)] text-[11px] rounded-[3px] hover:bg-[var(--bg-card-header,rgba(0,0,0,0.06))] hover:text-[var(--text-primary,#111)]';
    menu.innerHTML = `
        <div class="px-2.5 py-1.5 text-[var(--text-muted,#999)] text-[10px] uppercase tracking-wider border-b border-[var(--border,#ddd)] mb-1">Show Columns</div>
        <div class="flex flex-col">
            ${CHANNEL_COLUMNS.map(col => `
                <label class="${itemCls}">
                    <input type="checkbox" data-col-key="${col.key}" ${visible.includes(col.key) ? 'checked' : ''}>
                    <span>${col.label}</span>
                </label>
            `).join('')}
        </div>
        <div class="h-px bg-[var(--border,#ddd)] my-1"></div>
        <div class="${actionCls}" data-action="show-all">Show All</div>
        <div class="${actionCls}" data-action="reset">Reset to Default</div>
    `;

    // Position the menu, clamping to viewport so it doesn't overflow the screen
    document.body.appendChild(menu);
    const rect = menu.getBoundingClientRect();
    const maxX = window.innerWidth - rect.width - 8;
    const maxY = window.innerHeight - rect.height - 8;
    menu.style.left = Math.min(x, Math.max(0, maxX)) + 'px';
    menu.style.top  = Math.min(y, Math.max(0, maxY)) + 'px';

    // Handle checkbox changes
    menu.addEventListener('change', (e) => {
        if (e.target.type !== 'checkbox') return;
        const checked = Array.from(menu.querySelectorAll('input[type="checkbox"]:checked'))
            .map(cb => cb.dataset.colKey);
        // Edge case: prevent user from hiding EVERY column (table would be empty)
        if (checked.length === 0) {
            e.target.checked = true;
            return;
        }
        setVisibleColumns(checked, onChange);
    });

    // Handle action clicks (Show All, Reset)
    menu.addEventListener('click', (e) => {
        const action = e.target.dataset.action;
        if (action === 'show-all') {
            const all = CHANNEL_COLUMNS.map(c => c.key);
            setVisibleColumns(all, onChange);
            _hideMenu();
        } else if (action === 'reset') {
            setVisibleColumns(_defaultKeys(), onChange);
            _hideMenu();
        }
    });

    // Close on outside click (click-away)
    // Use capture: true so we catch the click even if downstream handlers stop it
    setTimeout(() => {
        const closeOnClickAway = (e) => {
            if (!menu.contains(e.target)) {
                _hideMenu();
                document.removeEventListener('click', closeOnClickAway, true);
                document.removeEventListener('contextmenu', closeOnClickAway, true);
            }
        };
        document.addEventListener('click', closeOnClickAway, true);
        document.addEventListener('contextmenu', closeOnClickAway, true);
    }, 0);

    // Close on Escape
    const closeOnEscape = (e) => {
        if (e.key === 'Escape') {
            _hideMenu();
            document.removeEventListener('keydown', closeOnEscape);
        }
    };
    document.addEventListener('keydown', closeOnEscape);

    _menuEl = menu;
}

function _hideMenu() {
    if (_menuEl) {
        _menuEl.remove();
        _menuEl = null;
    }
}
