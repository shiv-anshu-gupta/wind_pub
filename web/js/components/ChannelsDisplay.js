/**
 * @module ChannelsDisplay
 * @file components/ChannelsDisplay.js
 * @description Active Channels Display Component.
 * Shows configured channels in a table. Right-click the table to pick which
 * columns to show. Supports mouse-based drag to FrameViewer.
 *
 * @author SV-PUB Team
 * @date 2025
 */

import store from '../store/index.js';
import { startDrag } from '../utils/dragManager.js';
import {
    CHANNEL_COLUMNS,
    getVisibleColumns,
    attachColumnPicker
} from './channelColumnPicker.js';

// ============================================================================
// MODULE STATE
// ============================================================================

let _initialized = false;
const _elements = {};
// Snapshot of last-rendered equations keyed by channel id. On each render
// we diff against this and flash any row whose equation changed — gives
// the user a no-devtools confirmation that the data flow worked end-to-end.
let _lastEquationsById = {};

// Print a line to the Rust terminal (via the debug_log Tauri command).
// Used to surface data-flow checkpoints when devtools is locked down.
function _termLog(message) {
    /* Debug-log routes to console now — backend dropped the Tauri 'debug_log' cmd. */
    try { console.log('[channels]', message); } catch {}
}

// ============================================================================
// DOM TEMPLATE
// ============================================================================

/**
 * Get the HTML template for channels display.
 * @memberof module:ChannelsDisplay
 * @returns {string} HTML template string
 */
export function getTemplate() {
    const channels = store.getChannels ? store.getChannels() : [];
    // `.card`, `.card-header`, `.card-body`, `.channels-display-card` retained
    // as marker classes for shared card-primitive cascade + module hooks.
    return `
        <section class="card channels-display-card flex flex-col" id="channels-display-module">
            <div class="card-header flex items-center justify-between gap-2 px-3.5 py-2.5 bg-[var(--bg-tertiary)] border-b border-[var(--border-color)] [&_h2]:flex-1 [&_h2]:text-sm [&_h2]:font-semibold [&_h2]:text-[var(--text-primary)]">
                <h2>Channels <span class="ml-auto bg-white/20 px-2.5 py-0.5 rounded-xl text-xs font-semibold channel-count-badge">${channels.length}</span></h2>
                <span class="text-[10px] text-[var(--text-muted,#888)] italic">💡 Right-click table to pick columns</span>
            </div>
            <div class="card-body">
                <div class="p-0 max-h-80 overflow-y-auto overflow-x-hidden [&::-webkit-scrollbar]:w-1 [&::-webkit-scrollbar-track]:bg-[var(--gray-100)] [&::-webkit-scrollbar-thumb]:bg-[var(--gray-300)] [&::-webkit-scrollbar-thumb]:rounded-[2px]" id="channelsList">
                    ${getChannelsTableHTML(channels)}
                </div>
            </div>
        </section>
    `;
}

/**
 * Generate the channels table HTML (table element + thead + tbody).
 *
 * Every row has the class `channel-draggable-source` and data attributes
 * `data-channel` + `data-channel-type` that the drag handler reads.
 */
function getChannelsTableHTML(channels) {
    if (!channels || channels.length === 0) {
        return `
            <div class="flex flex-col items-center justify-center p-6 text-[var(--gray-400)] text-[13px]">
                <span class="text-2xl mb-2">📭</span>
                <span>No channels configured</span>
            </div>
        `;
    }

    const visible = getVisibleColumns();
    const visibleCols = CHANNEL_COLUMNS.filter(c => visible.includes(c.key));

    const headerCells = visibleCols
        .map(col => `<th data-col-key="${col.key}">${col.label}</th>`)
        .join('');

    const rows = channels.map(ch => {
        const cells = visibleCols
            .map(col => `<td class="ccol-${col.key}">${col.renderer(ch)}</td>`)
            .join('');
        return `
            <tr class="channel-row channel-draggable-source"
                data-channel="${ch.id}"
                data-channel-type="${ch.type}">
                ${cells}
            </tr>
        `;
    }).join('');

    // `.channels-table` retained as marker class for the column picker
    // contextmenu hook and the row-flash animation rule. All visual styling
    // is via Tailwind utilities on the table itself and descendant variants.
    return `
        <table class="channels-table w-full border-separate border-spacing-0 text-xs table-auto
                      [&_th]:text-left [&_th]:px-2 [&_th]:py-2 [&_th]:font-semibold [&_th]:text-[11px] [&_th]:text-[var(--text-secondary,#666)] [&_th]:uppercase [&_th]:tracking-[0.3px] [&_th]:[cursor:context-menu] [&_th]:select-none [&_th]:whitespace-nowrap [&_th]:sticky [&_th]:top-0 [&_th]:bg-[var(--bg-secondary,#1e293b)] [&_th]:shadow-[0_1px_0_var(--border,#ddd)] [&_th]:z-[5]
                      [&_tbody_tr]:cursor-grab [&_tbody_tr]:select-none [&_tbody_tr]:border-t [&_tbody_tr]:border-[var(--border,#eee)] [&_tbody_tr]:transition-[background] [&_tbody_tr]:duration-100
                      [&_tbody_tr:hover]:bg-[var(--bg-card-header,rgba(0,0,0,0.04))]
                      [&_tbody_tr:active]:cursor-grabbing
                      [&_tbody_tr.dragging]:opacity-50 [&_tbody_tr.dragging]:bg-[var(--primary)] [&_tbody_tr.dragging]:text-white [&_tbody_tr.dragging]:scale-[0.98] [&_tbody_tr.dragging]:cursor-grabbing
                      [&_td]:px-2 [&_td]:py-1.5 [&_td]:align-middle [&_td]:text-[var(--text-primary,inherit)]
                      [&_.ccol-color]:w-5 [&_.ccol-color_.channel-color]:w-2.5 [&_.ccol-color_.channel-color]:h-2.5 [&_.ccol-color_.channel-color]:rounded-[2px] [&_.ccol-color_.channel-color]:inline-block
                      [&_.ccol-id_.channel-name]:font-semibold
                      [&_.ccol-equation]:font-mono [&_.ccol-equation]:text-[11px] [&_.ccol-equation]:text-[var(--text-muted,#888)] [&_.ccol-equation]:max-w-[260px] [&_.ccol-equation]:overflow-hidden [&_.ccol-equation]:text-ellipsis [&_.ccol-equation]:whitespace-nowrap
                      [&_.ccol-type_.channel-type]:inline-block [&_.ccol-type_.channel-type]:px-1.5 [&_.ccol-type_.channel-type]:py-px [&_.ccol-type_.channel-type]:rounded-[3px] [&_.ccol-type_.channel-type]:text-[10px] [&_.ccol-type_.channel-type]:uppercase [&_.ccol-type_.channel-type]:tracking-[0.3px] [&_.ccol-type_.channel-type]:bg-[var(--bg-card,rgba(0,0,0,0.05))]
                      [&_.ccol-type_.channel-type.voltage]:text-[#3b82f6] [&_.ccol-type_.channel-type.current]:text-[#f97316] [&_.ccol-type_.channel-type.computed]:text-[#8b5cf6]
                      [&_.ccol-phase]:text-[var(--text-secondary,#666)] [&_.ccol-unit]:text-[var(--text-secondary,#666)]
                      [&_.ccol-scale]:text-right [&_.ccol-scale]:font-mono
                      [&_.ccol-magnitude]:text-right [&_.ccol-magnitude]:font-mono [&_.ccol-magnitude]:text-[11px]
                      [&_.channel-magnitude]:text-[var(--text-primary,inherit)]" id="channelsTable">
            <thead>
                <tr>${headerCells}</tr>
            </thead>
            <tbody>
                ${rows}
            </tbody>
        </table>
    `;
}

// ============================================================================
// INITIALIZATION
// ============================================================================

/**
 * Initialize the Channels Display module.
 * @memberof module:ChannelsDisplay
 * @param {HTMLElement} container - Container element to inject template
 */
export function init(container) {
    if (_initialized) {
        console.warn('[ChannelsDisplay] Already initialized');
        return;
    }

    if (!container) {
        console.warn('[ChannelsDisplay] Container not provided');
        return;
    }

    console.log('[ChannelsDisplay] Initializing...');

    container.innerHTML = getTemplate();

    _elements.channelsList = document.getElementById('channelsList');

    // Setup drag and column picker
    _setupDragEvents();
    _attachColumnPicker();

    // Store subscriptions (preserved from previous version)
    if (store.onChange) {
        store.onChange(() => {
            _updateDisplay();
        });
    }
    store.subscribe('data.equations', _updateDisplay);
    store.subscribe('data.channels', _updateDisplay);
    store.subscribe('config.standard', _updateDisplay);
    store.subscribe('config.frequency', _updateDisplay);

    // Seed the equation snapshot from the initial render so the first
    // post-init store change can be diffed accurately.
    _lastEquationsById = _snapshotEquations(store.getChannels ? store.getChannels() : []);

    _initialized = true;
    console.log('[ChannelsDisplay] ✅ Initialized');
}

// ============================================================================
// INTERNAL METHODS
// ============================================================================

/**
 * Setup mouse-based drag for channel rows.
 *
 * Uses event delegation on #channelsList so one listener handles all rows,
 * current and future. Looks up the dragged row by .channel-draggable-source.
 */
function _setupDragEvents() {
    const channelsList = _elements.channelsList;
    if (!channelsList) return;

    channelsList.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;

        const row = e.target.closest('.channel-draggable-source');
        if (!row) return;

        const channelId = row.dataset.channel;
        const channelType = row.dataset.channelType || 'unknown';

        e.preventDefault();

        const color = channelType === 'voltage' ? '#3b82f6' :
                      channelType === 'current' ? '#f97316' : '#6b7280';

        startDrag({
            data: channelId,
            type: 'channel',
            label: channelId,
            color: color,
            event: e
        });

        row.classList.add('dragging');

        const cleanup = () => {
            row.classList.remove('dragging');
            document.removeEventListener('mouseup', cleanup);
        };
        document.addEventListener('mouseup', cleanup);

        console.log('[ChannelsDisplay] Mouse drag started:', channelId);
    });
}

/**
 * Attach the right-click column picker to the current table element.
 * Called once on init. On re-render we re-attach because the table element
 * is replaced.
 */
function _attachColumnPicker() {
    const table = document.getElementById('channelsTable');
    if (!table) return;
    attachColumnPicker(table, _updateDisplay);
}

/**
 * Take a {channelId: equation} snapshot for change detection.
 */
function _snapshotEquations(channels) {
    const snap = {};
    for (const ch of channels) snap[ch.id] = ch.equation;
    return snap;
}

/**
 * Re-render the channels list (called on store changes and column picker changes).
 *
 * Side effect: any row whose equation changed since the last render is
 * briefly flashed — this is a visible confirmation (no devtools needed)
 * that the store → ChannelsDisplay subscription is firing end-to-end.
 */
function _updateDisplay() {
    const channels = store.getChannels ? store.getChannels() : [];

    // Diff equations BEFORE re-rendering so we know which rows to flash.
    const newSnap = _snapshotEquations(channels);
    const changedIds = [];
    for (const id in newSnap) {
        if (_lastEquationsById[id] !== undefined && _lastEquationsById[id] !== newSnap[id]) {
            changedIds.push(id);
        }
    }
    _lastEquationsById = newSnap;

    _termLog(`ChannelsDisplay._updateDisplay fired (changed: ${changedIds.length ? changedIds.join(',') : 'none'}, total channels: ${channels.length})`);

    const badge = document.querySelector('.channel-count-badge');
    if (badge) {
        badge.textContent = channels.length;
    }

    const listEl = document.getElementById('channelsList');
    if (listEl) {
        listEl.innerHTML = getChannelsTableHTML(channels);
        // Re-attach column picker to the NEW table element (innerHTML replaces it)
        _attachColumnPicker();

        // Flash changed rows. Re-query AFTER innerHTML — the old elements are gone.
        for (const id of changedIds) {
            const row = listEl.querySelector(`tr[data-channel="${id}"]`);
            if (row) {
                row.classList.add('channel-row-flash');
                // Remove the class so the next change can retrigger the animation
                setTimeout(() => row.classList.remove('channel-row-flash'), 1400);
            }
        }
    }
}

// ============================================================================
// EXPORTS
// ============================================================================

export default {
    init,
    getTemplate
};
