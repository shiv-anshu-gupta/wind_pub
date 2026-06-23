/**
 * @module tauriClient
 * @file utils/tauriClient.js
 * @description
 *   Single-file client for the publisher backend. Talks to the C++ WS
 *   server embedded in the same process.
 *
 *   Port discovery: the Rust shell calls win.eval() at .setup() to write
 *   the actual bound port (set by sv_pub_ws_start's port-scan) into
 *   `window.__PUB_WS_PORT__`. We poll for that value briefly before
 *   falling back to the historical 9100 default, so launching the
 *   publisher binary multiple times — each process binding 9100, 9101,
 *   9102, … — gives each Tauri window its own independent backend.
 */

const RECONNECT_DELAY_MS = 1000;
const CALL_TIMEOUT_MS    = 5000;
const PORT_POLL_TIMEOUT_MS = 1500;   /* total wait for the eval injection */
const PORT_POLL_INTERVAL_MS = 25;

let WS_URL = null;       /* resolved after _resolvePort() finishes */
let _localUrl = null;    /* the embedded-backend URL, so setBackend(null) reverts */

function _resolvePort() {
    return new Promise(resolve => {
        const t0 = Date.now();
        const tick = () => {
            const p = (typeof window !== 'undefined' && window.__PUB_WS_PORT__) | 0;
            if (p > 0) {
                resolve(p);
                return;
            }
            if (Date.now() - t0 >= PORT_POLL_TIMEOUT_MS) {
                console.warn('[tauriClient] __PUB_WS_PORT__ never appeared, falling back to 9100');
                resolve(9100);
                return;
            }
            setTimeout(tick, PORT_POLL_INTERVAL_MS);
        };
        tick();
    });
}

/* ------------------------------------------------------------------------- */
/* Connection — singleton, auto-reconnect                                    */
/* ------------------------------------------------------------------------- */

let _ws            = null;
let _pending       = new Map();   // cmd -> [{resolve, reject, timer}]
let _queueOnConnect = [];          // queued sends while disconnected
let _isOpen        = false;
let _welcomeSeen   = false;
const _listeners   = { connect: [], disconnect: [], message: [] };

function _emit(event, payload) {
    (_listeners[event] || []).forEach(fn => {
        try { fn(payload); } catch (e) { console.warn('listener', e); }
    });
}

function _connect() {
    if (!WS_URL) {
        /* Defer until port is resolved. _bootstrap() below sets WS_URL
         * then calls _connect(); reconnects after a drop reuse the
         * URL that was already discovered. */
        return;
    }
    try {
        _ws = new WebSocket(WS_URL);
    } catch (e) {
        console.warn('[tauriClient] ws ctor failed', e);
        setTimeout(_connect, RECONNECT_DELAY_MS);
        return;
    }

    _ws.onopen = () => {
        _isOpen = true;
        _emit('connect', { url: WS_URL });
        const q = _queueOnConnect; _queueOnConnect = [];
        q.forEach(s => _ws.send(s));
    };

    _ws.onmessage = (e) => {
        let msg;
        try { msg = JSON.parse(e.data); }
        catch { _emit('message', e.data); return; }

        if (msg.type === 'welcome') {
            _welcomeSeen = true;
            /* Fire 'init' once we know whether the backend is already mid-run
             * (covers page-reload while publishing). The mp_is_running query
             * is queued behind the welcome — it'll resolve in the same tick. */
            call('mp_is_running')
                .then(running => {
                    _lastRunning = !!running;
                    if (_lastRunning) _runStartMs = Date.now();
                    _emit('init', {
                        version: msg.version || '1',
                        isPublishing: _lastRunning,
                    });
                })
                .catch(() => _emit('init', { version: msg.version || '1', isPublishing: false }));
            return;
        }
        if (msg.type === 'event' && msg.name) {
            /* Backend can push named events (publishingStopped, etc.) */
            _emit(msg.name, msg.payload || {});
            return;
        }
        _emit('message', msg);

        const cmd = msg.cmd;
        if (!cmd || !_pending.has(cmd)) return;
        const list = _pending.get(cmd);
        const entry = list.shift();
        if (!list.length) _pending.delete(cmd);
        if (entry.timer) clearTimeout(entry.timer);
        if (msg.type === 'error') entry.reject(new Error(msg.reason || 'error'));
        else                      entry.resolve(msg.value !== undefined ? msg.value : null);
    };

    _ws.onclose = () => {
        _isOpen = false;
        _welcomeSeen = false;
        _emit('disconnect', {});
        // Fail pending calls so callers don't hang
        for (const list of _pending.values()) {
            for (const e of list) {
                if (e.timer) clearTimeout(e.timer);
                e.reject(new Error('disconnected'));
            }
        }
        _pending.clear();
        setTimeout(_connect, RECONNECT_DELAY_MS);
    };

    _ws.onerror = (err) => {
        console.warn('[tauriClient] ws error', err);
    };
}

/* Resolve the port (poll window.__PUB_WS_PORT__ briefly), build WS_URL,
 * then start the auto-reconnecting connection loop. */
(async function _bootstrap() {
    const port = await _resolvePort();
    WS_URL = `ws://localhost:${port}/ws`;
    _localUrl = WS_URL;
    console.log('[tauriClient] WS endpoint:', WS_URL);
    _connect();
})();

/* -------------------------------------------------------------------------
 * Backend state poller — single loop that does everything the UI needs:
 *   1. detect publishing run/stop edges → fire 'status' + 'publishingStopped'
 *   2. fetch get_stats + smpCnt → fire 'stats' with camelCase keys the
 *      Statistics component already subscribes to
 *   3. track elapsed session duration JS-side (the backend doesn't expose
 *      it in get_stats, so we stamp _runStartMs on the running edge)
 *
 * Runs every 250 ms when connected — matches the cadence the old Tauri
 * polling loop used so chart smoothness/responsiveness is unchanged.
 * ------------------------------------------------------------------------- */
let _lastRunning  = false;
let _runStartMs   = 0;

function _toCamelStats(raw, smpCnt, durationSec) {
    /* Backend get_stats returns snake_case; the UI subscribes to camelCase
     * keys on store.data.stats — map them here so neither side has to know
     * about the other's naming. */
    if (!raw) return null;
    return {
        packetsSent:   raw.packets_sent   ?? 0,
        packetsFailed: raw.packets_failed ?? 0,
        bytesSent:     raw.bytes_sent     ?? 0,
        currentBps:    raw.current_bps    ?? 0,
        currentPps:    raw.current_pps    ?? 0,
        peakBps:       raw.peak_bps       ?? 0,
        peakPps:       raw.peak_pps       ?? 0,
        sessionActive: !!raw.session_active,
        smpCnt:        smpCnt   | 0,
        durationSec:   durationSec | 0,
    };
}

async function _pollBackend() {
    if (!_isOpen) return;

    /* (1) running state — needed for the status/publishingStopped edges and
     * to gate duration tracking. */
    let running = false;
    try { running = !!(await call('mp_is_running')); }
    catch { return; }

    /* Running-edge transitions. */
    if (running && !_lastRunning) {
        _runStartMs = Date.now();
        _emit('status', { status: 'running' });
    } else if (!running && _lastRunning) {
        _emit('status', { status: 'stopped' });
        _emit('publishingStopped', {});
    }
    _lastRunning = running;

    /* (2) stats + (3) smpCnt — both cheap, fire in parallel. Either one can
     * fail independently (e.g. no publishers added yet); whichever returns
     * is what we publish. */
    let raw = null, vals = null;
    try {
        [raw, vals] = await Promise.all([
            call('get_stats').catch(() => null),
            call('get_current_channel_values').catch(() => null),
        ]);
    } catch { /* both failed — skip this tick */ }

    const durationSec = running && _runStartMs
        ? Math.floor((Date.now() - _runStartMs) / 1000)
        : 0;
    const smpCnt = vals && typeof vals.smpCnt === 'number' ? vals.smpCnt : 0;

    const stats = _toCamelStats(raw, smpCnt, durationSec);
    if (stats) _emit('stats', stats);
}
setInterval(_pollBackend, 250);

function _send(payload) {
    const s = JSON.stringify(payload);
    if (_isOpen && _ws && _ws.readyState === WebSocket.OPEN) _ws.send(s);
    else _queueOnConnect.push(s);
}

/**
 * Send a command and await a reply. Backend echoes the cmd name in every
 * response so we can route concurrent calls back to the right promise.
 */
function call(cmd, payload = {}) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            const list = _pending.get(cmd);
            if (!list) return;
            const idx = list.findIndex(e => e.resolve === resolve);
            if (idx >= 0) list.splice(idx, 1);
            reject(new Error(`timeout: ${cmd}`));
        }, CALL_TIMEOUT_MS);
        if (!_pending.has(cmd)) _pending.set(cmd, []);
        _pending.get(cmd).push({ resolve, reject, timer });
        _send({ cmd, ...payload });
    });
}

/* ------------------------------------------------------------------------- */
/* Public API — exact same names the rest of the app already imports         */
/* ------------------------------------------------------------------------- */

export async function connect() { /* backwards-compat no-op — auto-connects */ return _isOpen; }
export function disconnect()   { if (_ws) _ws.close(); }
export function isConnected()  { return _isOpen; }

/* -------------------------------------------------------------------------
 * Backend retargeting — local (embedded) vs remote (headless over network)
 *
 * tauriClient is the single transport the WHOLE app uses (header Start,
 * MultiPublisher, GOOSE, faults, stats). Pointing it at a remote ws:// URL
 * therefore makes every one of those drive the remote backend *identically*
 * to the local one — no per-feature rewiring. The remote backend must speak
 * the same PubWsServer protocol (mp_*, goose_*, fault_*); the headless
 * sv_publisher_service built from PubWsServer.cc does.
 * ------------------------------------------------------------------------- */

/** Retarget the backend. `url` = a ws:// endpoint for a remote backend, or
 *  null/undefined to revert to the embedded local backend. Closing the current
 *  socket triggers the existing auto-reconnect against the new WS_URL. */
export function setBackend(url) {
    const target = url || _localUrl;
    if (!target) { console.warn('[tauriClient] setBackend() before bootstrap finished'); return false; }
    if (target === WS_URL) { if (_isOpen) _emit('connect', { url: WS_URL }); return true; }
    console.log('[tauriClient] retargeting backend ->', target);
    WS_URL = target;
    if (_ws) { try { _ws.close(); } catch (_) { /* onclose reconnects */ } }
    else _connect();
    return true;
}

/** Current endpoint + whether it is a remote (non-embedded) backend. */
export function getBackend() {
    return { url: WS_URL, isRemote: !!(_localUrl && WS_URL && WS_URL !== _localUrl) };
}
export function isRemote() { return getBackend().isRemote; }
export function on(event, handler) {
    if (!_listeners[event]) _listeners[event] = [];
    _listeners[event].push(handler);
}

/* ── Interface ─────────────────────────────────────────────────────────── */
export async function getInterfaces()    { return await call('get_interfaces'); }
export async function openInterface(name){ return await call('open_interface', { name }); }
export async function closeInterface()   { return await call('close_interface'); }
export async function isInterfaceOpen()  { return await call('is_interface_open'); }

/* ── Duration / repeat ───────────────────────────────────────────────────
 * mpSetDuration() below is the canonical setter — it takes positional
 * args matching the backend field names exactly. */
export async function getRemainingSeconds()    { return await call('mp_get_remaining_seconds'); }
export async function getCurrentRepeatCycle() { return await call('mp_get_current_repeat_cycle'); }
export async function isDurationComplete()    { return await call('mp_is_duration_complete'); }

/* ── Stats ───────────────────────────────────────────────────────────────
 * The 250 ms poll loop above calls `get_stats` directly; this wrapper is
 * kept only for `resetStats` which Statistics.js uses from its reset btn. */
export async function resetStats() { return await call('reset_stats'); }

/* ── Multi-publisher ──────────────────────────────────────────────────── */
export async function mpAddPublisher()             { return await call('mp_add_publisher'); }
export async function mpRemovePublisher(id)        { return await call('mp_remove_publisher', { id }); }
export async function mpRemoveAllPublishers()      { return await call('mp_remove_all_publishers'); }
export async function mpConfigurePublisher(id, config) {
    /* Two-step:
     *   1. set basic publisher header config (svID, MAC, sampleRate, ...)
     *   2. if channels were provided, serialize and set equations
     *
     * The native equation parser (eq_load_equations in equation_processor.cc)
     * expects PIPE-DELIMITED `"id1:eq1|id2:eq2|..."`. Sending JSON.stringify
     * here silently broke every publisher — the parser tokenises on '|',
     * finds none, fails to load any equation, and the wire frames go out
     * with all-zero samples (subscriber sees 0,0,0,0,...).
     *
     * We keep the line itself "|"-safe: any '|' literal that ever appears
     * inside an equation would corrupt the wire format, so reject it loudly. */
    const { channels, ...basic } = config;
    await call('mp_configure_publisher', { id, ...basic });
    if (Array.isArray(channels) && channels.length > 0) {
        const flat = channels.map(ch => {
            const idStr = String(ch.id ?? '').trim();
            const eqStr = String(ch.equation ?? '').trim();
            if (idStr.includes('|') || idStr.includes(':')) {
                throw new Error(`Channel id "${idStr}" contains a reserved character ('|' or ':')`);
            }
            if (eqStr.includes('|')) {
                throw new Error(`Channel "${idStr}" equation contains '|' which is reserved`);
            }
            return `${idStr}:${eqStr}`;
        }).join('|');
        await call('mp_set_publisher_equations', { id, equations: flat });
    }
}
export async function mpStartAll()                 { return await call('mp_start_all'); }
export async function mpStopAll() {
    const r = await call('mp_stop_all');
    _emit('publishingStopped', {});
    return r;
}
export async function mpIsRunning()                { return await call('mp_is_running'); }
export async function mpResetAll()                 { return await call('mp_reset_all'); }
export async function mpSetDuration(seconds, repeat = false, infinite = false, count = 0) {
    return await call('mp_set_duration', { seconds, repeat, infinite, count });
}

/* ── Frame inspection (used by FrameViewer) ───────────────────────────────
 * `id` selects which publisher to inspect. If omitted, the backend picks the
 * first publisher (lowest id) so single-publisher UIs stay zero-config. */
export async function getSampleFrame(smpCnt = 0, id = 0) {
    return await call('get_sample_frame', { id, smpCnt });
}
export async function getCurrentChannelValues(id = 0) {
    return await call('get_current_channel_values', { id });
}

/* ── CID export ──────────────────────────────────────────────────────────
 * exportCid(id)              — exports the CID of a live publisher.
 * exportCidWithConfig(...)   — exports a CID from a fully-supplied config
 *                              with no publisher needed. */
export async function exportCid(outputPath, id = 0) {
    await call('export_cid', { id, outputPath });
    return outputPath;
}
export async function exportCidWithConfig(outputPath, config) {
    await call('export_cid_with_config', { outputPath, ...config });
    return outputPath;
}

/* ── Fault injection ───────────────────────────────────────────────────── */
export async function setFaultInjectionConfig(configJson) {
    return await call('fault_inject_configure', { config: configJson });
}
export async function getFaultInjectionStats() {
    return await call('fault_inject_get_stats');
}
export async function resetFaultInjectionStats() {
    return await call('fault_inject_reset_stats');
}

/* ── Source mode / protocol ────────────────────────────────────────────── */
export async function mpSetPublisherSourceMode(id, mode) {
    return await call('mp_set_publisher_source_mode', { id, mode });
}
export async function mpSetPublisherProtocol(id, protocol) {
    return await call('mp_set_publisher_protocol', { id, protocol });
}

/* ── SPSC bridge admin ─────────────────────────────────────────────────── */
export async function spscRegister(streamId)   { return await call('spsc_register',   { streamId }); }
export async function spscUnregister(streamId) { return await call('spsc_unregister', { streamId }); }
export async function spscGetStats()           { return await call('spsc_get_stats'); }

/* ── GOOSE TX/RX ───────────────────────────────────────────────────────── */
export async function gooseConfigureTx(config) {
    return await call('goose_configure_tx', config);
}
export async function gooseStartTx(streamId, heartbeatMs = 1000, firstRetxMs = 2) {
    return await call('goose_start_tx', { streamId, heartbeatMs, firstRetxMs });
}
export async function gooseStopTx(streamId)    { return await call('goose_stop_tx', { streamId }); }
export async function gooseStopAllTx()         { return await call('goose_stop_all_tx'); }
export async function gooseRxStart(iface)      { return await call('goose_rx_start', { iface }); }
export async function gooseRxStop()            { return await call('goose_rx_stop'); }
export async function gooseRxRegister(gocbRef, streamId) {
    return await call('goose_rx_register', { gocbRef, streamId });
}
export async function gooseRxClear()           { return await call('goose_rx_clear'); }
export async function gooseGetStats(streamId)  { return await call('goose_get_stats', { streamId }); }
