/**
 * @file wsClient.js
 * @fileoverview WebSocket client for the remote (Yocto) publisher backend.
 *
 * Config-only channel: sends JSON commands and receives JSON responses. Modelled
 * on the sv-hmi `ws_client.js` pattern (connect / send / disconnect with an
 * auto-reconnect backoff), minus the high-speed binary frame path — the
 * publisher only needs to push configuration to the headless backend.
 *
 * Protocol (frontend -> backend), all JSON text frames:
 *   { "cmd": "hello" }
 *   { "cmd": "list_interfaces" }
 *   { "cmd": "apply_config", "config": {...}, "channels": [...] }
 *   { "cmd": "start", "interface": "<name>" }
 *   { "cmd": "stop" }
 *
 * Responses (backend -> frontend):
 *   { "type": "welcome"|"ok"|"error"|"interfaces"|"status", ... }
 *
 * The matching headless C++ backend (uWebSockets) is built in a later step.
 */

let _ws = null;
let _url = '';
let _shouldReconnect = false;
let _reconnectDelay = 1000;          // start retrying after 1s
const MAX_DELAY = 15000;             // cap backoff at 15s
let _reconnectTimer = null;

const _handlers = {
    onStatus: null,   // (status: 'connecting'|'connected'|'disconnected'|'error', detail) => void
    onMessage: null,  // (msg: object) => void
};

/** Register a connection-status callback. */
export function onStatus(fn) { _handlers.onStatus = fn; }

/** Register a JSON-message callback (backend -> frontend). */
export function onMessage(fn) { _handlers.onMessage = fn; }

/** Is the socket currently open? */
export function isConnected() {
    return !!_ws && _ws.readyState === WebSocket.OPEN;
}

/** The URL of the current/last connection target. */
export function getUrl() { return _url; }

function _emitStatus(status, detail) {
    if (_handlers.onStatus) {
        try { _handlers.onStatus(status, detail); } catch (e) { /* ignore */ }
    }
}

/**
 * Connect to a backend. `url` is a full ws URL, e.g. "ws://192.168.0.201:9001/ws".
 * Any existing connection is closed first. Auto-reconnects with backoff until
 * disconnect() is called.
 */
export function connect(url) {
    disconnect();              // tears down any existing socket + stops reconnect
    _url = url;
    _shouldReconnect = true;
    _reconnectDelay = 1000;
    _open();
}

function _open() {
    _emitStatus('connecting', _url);
    try {
        _ws = new WebSocket(_url);
    } catch (e) {
        _emitStatus('error', String(e && e.message || e));
        _scheduleReconnect();
        return;
    }

    _ws.onopen = () => {
        _reconnectDelay = 1000;          // reset backoff on success
        _emitStatus('connected', _url);
    };

    _ws.onmessage = (e) => {
        let msg;
        try {
            msg = JSON.parse(e.data);
        } catch (err) {
            _emitStatus('error', 'Bad JSON from backend');
            return;
        }
        if (_handlers.onMessage) {
            try { _handlers.onMessage(msg); } catch (err) { /* ignore */ }
        }
    };

    _ws.onclose = () => {
        _ws = null;
        _emitStatus('disconnected', _url);
        if (_shouldReconnect) _scheduleReconnect();
    };

    _ws.onerror = () => {
        // onclose fires right after, which handles reconnect.
        _emitStatus('error', _url);
    };
}

function _scheduleReconnect() {
    clearTimeout(_reconnectTimer);
    _reconnectTimer = setTimeout(() => {
        if (_shouldReconnect) _open();
    }, _reconnectDelay);
    _reconnectDelay = Math.min(_reconnectDelay * 2, MAX_DELAY);
}

/**
 * Send a JSON command. Returns true if it was sent, false if not connected.
 */
export function send(obj) {
    if (isConnected()) {
        try {
            _ws.send(JSON.stringify(obj));
            return true;
        } catch (e) {
            _emitStatus('error', String(e && e.message || e));
            return false;
        }
    }
    return false;
}

/** Close the connection and stop auto-reconnect. */
export function disconnect() {
    _shouldReconnect = false;
    clearTimeout(_reconnectTimer);
    _reconnectTimer = null;
    if (_ws) {
        // Detach handlers so the stale socket's async onclose can't fire after a
        // subsequent reconnect, then emit the status ourselves.
        try { _ws.onclose = null; _ws.onerror = null; _ws.close(); } catch (e) { /* ignore */ }
        _ws = null;
        _emitStatus('disconnected', _url);
    }
}
