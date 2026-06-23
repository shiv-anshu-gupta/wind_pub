/**
 * @module StreamConfigPage
 * @file components/StreamConfigPage.js
 * @description
 *   Dedicated configuration page for per-stream communication headers
 *   (SV + GOOSE) — built for Shivani / external teammates so they can
 *   set up each stream independently without touching the main multi-
 *   publisher control panel.
 *
 *   Layout: slide-in panel from the right edge (matching the existing
 *   frame-sidebar / fault-sidebar pattern). Wide enough to feel like a
 *   distinct page. Auto-saves on every input — no save button.
 *
 *   Shares state with MultiPublisher: it reads/writes the same
 *   `_publishers` array via `MultiPublisher.getPublishers_public()`.
 *   When the user changes a value here, we call
 *   `MultiPublisher.requestRender_public()` so the main panel reflects
 *   the change.
 */

import MultiPublisher from './MultiPublisher.js';
import { defaultGooseConfig, macStringToBytes } from './GooseParameters.js';
import { showToast } from '../plugins/toast.js';

let _root      = null;     /* the slide-in container element */
let _streamsEl = null;     /* the inner scroll area */
let _isOpen    = false;

/* ============================================================================
 * Public API
 * ============================================================================ */

export function init(rootEl) {
    _root = rootEl;
    rootEl.innerHTML = getTemplate();
    _streamsEl = rootEl.querySelector('#cfgStreams');

    rootEl.querySelector('#cfgClose').addEventListener('click', close);
    rootEl.querySelector('#cfgAdd').addEventListener('click', () => {
        MultiPublisher.addPublisher_public();
        render();
    });
    rootEl.querySelector('#cfgBackdrop').addEventListener('click', close);
}

/**
 * @param {{focusLocalId?: number}} opts  If provided, scroll the panel to the
 *        matching stream card after the slide-in finishes.
 */
export function open(opts = {}) {
    if (!_root) return;
    _isOpen = true;
    _root.classList.add('cfg-open');
    document.body.style.overflow = 'hidden';
    render();

    if (opts.focusLocalId != null) {
        /* Wait for the slide-in animation (~280 ms) so scrollIntoView
         * targets the correct final position. */
        setTimeout(() => {
            const target = _streamsEl?.querySelector(
                `[data-stream-id="${opts.focusLocalId}"]`);
            if (target) {
                target.scrollIntoView({ behavior: 'smooth', block: 'center' });
                target.classList.add('cfg-card--focus');
                setTimeout(() => target.classList.remove('cfg-card--focus'), 1600);
            }
        }, 310);
    }
}

export function close() {
    if (!_root) return;
    _isOpen = false;
    _root.classList.remove('cfg-open');
    document.body.style.overflow = '';
}

export function toggle() { _isOpen ? close() : open(); }

export default { init, open, close, toggle };

/* ============================================================================
 * Templates
 * ============================================================================ */

function getTemplate() {
    return `
      <div class="cfg-backdrop" id="cfgBackdrop"></div>
      <aside class="cfg-panel" id="cfgPanel">
        <header class="cfg-header">
          <div>
            <h2>Stream Configuration</h2>
            <p class="cfg-subtitle">
              Per-stream communication headers for SV and GOOSE.
              Edits save automatically.
            </p>
          </div>
          <button class="cfg-close-btn" id="cfgClose"
                  aria-label="Close stream configuration">✕</button>
        </header>

        <div class="cfg-body">
          <div id="cfgStreams" class="cfg-streams"></div>
        </div>

        <footer class="cfg-footer">
          <button class="cfg-add-btn" id="cfgAdd">+ Add Stream</button>
        </footer>
      </aside>
    `;
}

/* ============================================================================
 * Render — list every publisher with its full header config
 * ============================================================================ */

function render() {
    if (!_streamsEl) return;

    const streams = MultiPublisher.getPublishers_public();
    if (!streams || streams.length === 0) {
        _streamsEl.innerHTML = `
          <div class="cfg-empty">
            No streams yet. Use the <strong>+ Add Stream</strong> button below
            to create one.
          </div>`;
        return;
    }

    _streamsEl.innerHTML = streams.map(streamCardHTML).join('');
    streams.forEach(pub => bindCard(pub));
}

function streamCardHTML(pub) {
    if (!pub.goose) pub.goose = defaultGooseConfig(pub.localId);

    const isGoose = pub.protocol === 'goose';
    const isExternal = pub.source === 'external';

    return `
      <article class="cfg-card" data-stream-id="${pub.localId}">
        <header class="cfg-card-header">
          <span class="cfg-card-num">#${pub.localId}</span>
          <span class="cfg-card-title">${escapeAttr(pub.svId)}</span>
          <span class="cfg-card-badge cfg-card-badge--${pub.protocol}">
            ${pub.protocol.toUpperCase()}
          </span>
          <span class="cfg-card-badge cfg-card-badge--${pub.source}">
            ${pub.source === 'external' ? 'EXTERNAL' : 'EQUATION'}
          </span>
          <button class="cfg-card-del" data-action="delete"
                  title="Remove this stream">✕</button>
        </header>

        <div class="cfg-card-body">

          <!-- Top row: Source + Protocol -->
          <div class="cfg-row">
            <label class="cfg-field">
              <span>Source</span>
              <select data-field="source">
                <option value="equation" ${pub.source==='equation'?'selected':''}>
                  Equation (formula-driven, fast path)
                </option>
                <option value="external" ${pub.source==='external'?'selected':''}>
                  External (SPSC bridge — Shivani's app)
                </option>
              </select>
            </label>
            <label class="cfg-field">
              <span>Protocol</span>
              <select data-field="protocol">
                <option value="sv"    ${pub.protocol==='sv'   ?'selected':''}>SV — Sampled Values</option>
                <option value="goose" ${pub.protocol==='goose'?'selected':''}>GOOSE — boolean events</option>
              </select>
            </label>
          </div>

          <!-- Common header fields -->
          <fieldset class="cfg-section">
            <legend>Communication Header</legend>
            <div class="cfg-row">
              <label class="cfg-field">
                <span>${isGoose ? 'gocbRef' : 'svID'}</span>
                <input type="text"
                       data-field="${isGoose ? 'gocbRefMirror' : 'svId'}"
                       value="${escapeAttr(isGoose ? pub.goose.gocbRef : pub.svId)}">
              </label>
              <label class="cfg-field">
                <span>appID (hex)</span>
                <input type="number" min="0" max="65535"
                       data-field="appId"
                       value="${pub.appId}">
              </label>
              <label class="cfg-field">
                <span>confRev</span>
                <input type="number" min="0"
                       data-field="confRev"
                       value="${pub.confRev}">
              </label>
            </div>

            <div class="cfg-row">
              <label class="cfg-field cfg-field--wide">
                <span>Destination MAC</span>
                <input type="text" placeholder="01:0C:CD:0X:00:01"
                       data-field="dstMacMirror"
                       value="${escapeAttr(
                            isGoose ? pub.goose.dstMac
                                    : (pub.dstMac || '')
                       )}">
              </label>
              ${!isGoose ? `
              <label class="cfg-field">
                <span>smpSynch</span>
                <select data-field="smpSynch">
                  <option value="0" ${pub.smpSynch===0?'selected':''}>0 — none</option>
                  <option value="1" ${pub.smpSynch===1?'selected':''}>1 — local</option>
                  <option value="2" ${pub.smpSynch===2?'selected':''}>2 — global (PTP)</option>
                </select>
              </label>
              ` : ''}
            </div>
          </fieldset>

          ${isGoose ? renderGooseExtra(pub) : renderSvExtra(pub)}

        </div>
      </article>
    `;
}

function renderGooseExtra(pub) {
    const g = pub.goose;
    return `
      <fieldset class="cfg-section">
        <legend>GOOSE-specific</legend>
        <div class="cfg-row">
          <label class="cfg-field cfg-field--wide">
            <span>datSet</span>
            <input type="text" data-field="gooseDatSet"
                   value="${escapeAttr(g.datSet)}">
          </label>
          <label class="cfg-field cfg-field--wide">
            <span>goID</span>
            <input type="text" data-field="gooseGoId"
                   value="${escapeAttr(g.goId)}">
          </label>
        </div>
        <div class="cfg-row">
          <label class="cfg-field">
            <span>Heartbeat (ms)</span>
            <input type="number" min="10" data-field="gooseHeartbeatMs"
                   value="${g.heartbeatMs}">
          </label>
          <label class="cfg-field">
            <span>First retransmit (ms)</span>
            <input type="number" min="1" data-field="gooseFirstRetxMs"
                   value="${g.firstRetxMs}">
          </label>
          <label class="cfg-checkbox">
            <input type="checkbox" data-field="gooseTest"
                   ${g.test ? 'checked' : ''}>
            <span>test mode</span>
          </label>
          <label class="cfg-checkbox">
            <input type="checkbox" data-field="gooseNdsCom"
                   ${g.ndsCom ? 'checked' : ''}>
            <span>ndsCom</span>
          </label>
        </div>
      </fieldset>
    `;
}

function renderSvExtra(pub) {
    return `
      <fieldset class="cfg-section">
        <legend>SV-specific</legend>
        <div class="cfg-row">
          <label class="cfg-field">
            <span>Channels</span>
            <input type="number" min="1" max="20" disabled
                   value="${pub.channelCount}">
          </label>
          <p class="cfg-hint">
            Channel count, equations, sample rate, and frequency are
            configured via the Data Source &amp; Stream Settings panels
            on the main page.
          </p>
        </div>
      </fieldset>
    `;
}

/* ============================================================================
 * Bind handlers — auto-save on every change
 * ============================================================================ */

function bindCard(pub) {
    const card = _streamsEl.querySelector(`[data-stream-id="${pub.localId}"]`);
    if (!card) return;

    if (!pub.goose) pub.goose = defaultGooseConfig(pub.localId);

    card.querySelectorAll('[data-field]').forEach(el => {
        el.addEventListener('change', (e) => {
            const field = e.target.dataset.field;
            const val = readVal(e.target);

            switch (field) {
                /* Stream-level scalars */
                case 'source':   pub.source   = val; break;
                case 'protocol': pub.protocol = val; break;
                case 'svId':     pub.svId     = String(val); break;
                case 'appId':    pub.appId    = Number(val) | 0; break;
                case 'confRev':  pub.confRev  = Number(val) | 0; break;
                case 'smpSynch': pub.smpSynch = Number(val) | 0; break;

                /* "Mirror" fields — written into BOTH places depending on protocol */
                case 'gocbRefMirror':
                    pub.goose.gocbRef = String(val);
                    /* SV streams don't have gocbRef; nothing else to write */
                    break;
                case 'dstMacMirror':
                    /* When protocol is GOOSE, write to pub.goose.dstMac.
                     * When SV, persist on pub.dstMac so startAll can use it. */
                    if (pub.protocol === 'goose') pub.goose.dstMac = String(val);
                    else                          pub.dstMac       = String(val);
                    break;

                /* GOOSE-specific */
                case 'gooseDatSet':       pub.goose.datSet      = String(val); break;
                case 'gooseGoId':         pub.goose.goId        = String(val); break;
                case 'gooseHeartbeatMs':  pub.goose.heartbeatMs = Number(val) | 0; break;
                case 'gooseFirstRetxMs':  pub.goose.firstRetxMs = Number(val) | 0; break;
                case 'gooseTest':         pub.goose.test        = !!val; break;
                case 'gooseNdsCom':       pub.goose.ndsCom      = !!val; break;
            }

            /* Protocol switch needs a re-render to show the right section. */
            if (field === 'protocol' || field === 'source') render();

            /* Push the change back to the main publisher panel. */
            MultiPublisher.requestRender_public();
        });
    });

    /* Delete button */
    const del = card.querySelector('[data-action="delete"]');
    if (del) {
        del.addEventListener('click', () => {
            if (!confirm(`Remove stream #${pub.localId} (${pub.svId})?`)) return;
            MultiPublisher.removePublisher_public(pub.localId);
            render();
            showToast(`Removed ${pub.svId}`);
        });
    }
}

/* ============================================================================
 * Helpers
 * ============================================================================ */

function readVal(el) {
    if (el.type === 'checkbox') return el.checked;
    if (el.type === 'number')   return Number(el.value);
    return el.value;
}

function escapeAttr(s) {
    return String(s ?? '')
        .replace(/&/g,'&amp;')
        .replace(/"/g,'&quot;')
        .replace(/</g,'&lt;')
        .replace(/>/g,'&gt;');
}
