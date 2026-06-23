/**
 * @module GooseParameters
 * @file components/GooseParameters.js
 * @description Per-stream GOOSE config block — rendered inline inside a
 *   MultiPublisher row when that row's protocol is "goose".
 *
 *   Unlike SVParameters (a singleton bound to global config), this is a
 *   PURE renderer: pass in a publisher object, get HTML; pass in a row
 *   element + the publisher, install change handlers.
 *
 *   The publisher object's `goose` sub-block follows this shape:
 *     {
 *       gocbRef:    "BAY1/LLN0$GO$gcb01",
 *       datSet:     "BAY1/LLN0$Dataset1",
 *       goId:       "Bay1_Breaker_Pos",
 *       dstMac:     "01:0C:CD:01:00:01",
 *       confRev:    1,
 *       test:       false,
 *       ndsCom:     false,
 *       heartbeatMs: 1000,
 *       firstRetxMs: 2,
 *     }
 *
 *   srcMAC + vlanID + vlanPriority + appID are reused from the existing
 *   per-stream / global SV settings so the user doesn't re-enter them.
 */

/**
 * Default GOOSE config for a freshly-added publisher.
 * Stream index (1-based) is used to give each stream a distinct dst MAC
 * in the 01:0c:cd:01:00:xx range.
 */
export function defaultGooseConfig(streamIndex = 1) {
    const lastOctet = (streamIndex & 0xFF).toString(16).padStart(2, '0').toUpperCase();
    return {
        gocbRef:    `BAY${streamIndex}/LLN0$GO$gcb01`,
        datSet:     `BAY${streamIndex}/LLN0$Dataset1`,
        goId:       `Bay${streamIndex}_Breaker_Pos`,
        dstMac:     `01:0C:CD:01:00:${lastOctet}`,
        confRev:    1,
        test:       false,
        ndsCom:     false,
        heartbeatMs: 1000,
        firstRetxMs: 2,
    };
}

/**
 * Returns the HTML fragment for the GOOSE block of one publisher row.
 * Inputs carry `data-goose-field="..."` so a single delegated change handler
 * on the row can read/write the publisher.goose object.
 *
 * @param {{goose: object}} pub
 * @returns {string} HTML
 */
export function renderGooseBlock(pub) {
    const g = pub.goose || defaultGooseConfig(1);
    return `
      <div class="goose-block" style="
            padding: 8px;
            border: 1px dashed #888;
            border-radius: 4px;
            margin-top: 6px;
            background: rgba(255, 255, 255, 0.02);">

        <div style="font-weight: bold; margin-bottom: 4px;">GOOSE Parameters</div>

        <label style="display:block; font-size:12px;">
          gocbRef
          <input type="text"
                 data-goose-field="gocbRef"
                 value="${escapeAttr(g.gocbRef)}"
                 style="width:100%; font-family:monospace;">
        </label>

        <label style="display:block; font-size:12px;">
          datSet
          <input type="text"
                 data-goose-field="datSet"
                 value="${escapeAttr(g.datSet)}"
                 style="width:100%; font-family:monospace;">
        </label>

        <label style="display:block; font-size:12px;">
          goID
          <input type="text"
                 data-goose-field="goId"
                 value="${escapeAttr(g.goId)}"
                 style="width:100%; font-family:monospace;">
        </label>

        <label style="display:block; font-size:12px;">
          Destination MAC (01:0C:CD:01:xx:xx)
          <input type="text"
                 data-goose-field="dstMac"
                 value="${escapeAttr(g.dstMac)}"
                 style="width:100%; font-family:monospace;">
        </label>

        <div style="display:flex; gap:8px; margin-top:4px;">
          <label style="flex:1; font-size:12px;">
            confRev
            <input type="number" min="0"
                   data-goose-field="confRev"
                   value="${g.confRev}"
                   style="width:100%;">
          </label>
          <label style="flex:1; font-size:12px;">
            heartbeat (ms)
            <input type="number" min="10"
                   data-goose-field="heartbeatMs"
                   value="${g.heartbeatMs}"
                   style="width:100%;">
          </label>
          <label style="flex:1; font-size:12px;">
            first retx (ms)
            <input type="number" min="1"
                   data-goose-field="firstRetxMs"
                   value="${g.firstRetxMs}"
                   style="width:100%;">
          </label>
        </div>

        <div style="display:flex; gap:12px; margin-top:6px; font-size:12px;">
          <label>
            <input type="checkbox"
                   data-goose-field="test"
                   ${g.test ? 'checked' : ''}> test mode
          </label>
          <label>
            <input type="checkbox"
                   data-goose-field="ndsCom"
                   ${g.ndsCom ? 'checked' : ''}> ndsCom
          </label>
        </div>
      </div>
    `;
}

/**
 * Wires change handlers on the inputs inside `rowEl` so edits flow into
 * pub.goose. Call once after the row has been added to the DOM.
 *
 * @param {HTMLElement} rowEl     the publisher row's container
 * @param {object}      pub       the publisher object (gets pub.goose mutated)
 * @param {Function}    onChange  optional callback after every edit
 */
export function bindGooseHandlers(rowEl, pub, onChange) {
    if (!pub.goose) pub.goose = defaultGooseConfig(1);
    const inputs = rowEl.querySelectorAll('[data-goose-field]');
    inputs.forEach(el => {
        el.addEventListener('change', (e) => {
            const field = e.target.dataset.gooseField;
            let value;
            if (e.target.type === 'checkbox') value = e.target.checked;
            else if (e.target.type === 'number') value = Number(e.target.value);
            else                                  value = e.target.value;
            pub.goose[field] = value;
            if (typeof onChange === 'function') onChange(pub);
        });
    });
}

/**
 * Convert "01:0C:CD:01:00:01" into [1,12,205,1,0,1]. Returns [0,0,0,0,0,0]
 * if the string is malformed — the caller should validate before invoking
 * the encoder, but we don't crash here.
 *
 * @param {string} macStr
 * @returns {number[]}
 */
export function macStringToBytes(macStr) {
    if (typeof macStr !== 'string') return [0, 0, 0, 0, 0, 0];
    const parts = macStr.split(/[:\-]/);
    if (parts.length !== 6) return [0, 0, 0, 0, 0, 0];
    const bytes = parts.map(s => parseInt(s, 16));
    if (bytes.some(n => Number.isNaN(n) || n < 0 || n > 255))
        return [0, 0, 0, 0, 0, 0];
    return bytes;
}

/* ---------- tiny HTML-attr escaper ------------------------------------- */
function escapeAttr(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}
