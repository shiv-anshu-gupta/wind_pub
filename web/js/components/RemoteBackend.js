/**
 * @file RemoteBackend.js
 * @fileoverview "Remote Backend" panel — point the WHOLE app at a headless
 * publisher backend running on another machine (e.g. the Yocto over NetBird).
 *
 * How it works now:
 *   The app's single transport, tauriClient, normally talks to the embedded
 *   backend at ws://localhost:<port>/ws. Connecting here calls
 *   tauriClient.setBackend(ws://<ip>:<port>/ws), which retargets that one
 *   client — so the header Start button, MultiPublisher, GOOSE, fault
 *   injection and stats then drive the REMOTE backend exactly the same way
 *   they drive the local one. Start/Stop below call the very same
 *   MultiPublisher.startAll_public()/stopAll_public() the header uses, so a
 *   remote publish is byte-for-byte the same configuration as an Ethernet one.
 *
 * Requirement: the remote backend must speak the PubWsServer protocol
 * (mp_*, goose_*, fault_*) — i.e. the headless sv_publisher_service built from
 * PubWsServer.cc. The legacy single-publisher service (apply_config/start) does
 * not, and the full flow will report "unknown command" against it.
 */

import store from '../store/index.js';
import { showToast } from '../plugins/toast.js';
import * as tauriClient from '../utils/tauriClient.js';
import MultiPublisher from './MultiPublisher.js';
import NetworkSettings from './NetworkSettings.js';

const elements = {};
let _connecting = false;     // user asked to connect; waiting for the remote socket
let _ifaces = [];            // last interface list fetched from the remote backend

export function getTemplate() {
    return `
        <section class="card" id="remote-backend-module">
            <div class="card-header">
                <h2>Remote Backend</h2>
                <span class="card-subtitle">Drive a headless publisher over WebSocket — the whole app follows this backend</span>
            </div>
            <div class="card-body">
                <div class="rb-conn-row">
                    <div class="form-group rb-ip">
                        <label>Backend IP</label>
                        <input type="text" id="rbIp" placeholder="100.100.109.216" autocomplete="off">
                    </div>
                    <div class="form-group rb-port">
                        <label>Port</label>
                        <input type="number" id="rbPort" min="1" max="65535" value="9002">
                    </div>
                    <button class="btn btn-success btn-small rb-connect" id="rbConnectBtn" type="button">Connect</button>
                </div>

                <div class="rb-status-row">
                    <span class="status-dot" id="rbDot"></span>
                    <span class="rb-status-text" id="rbStatus">Local backend</span>
                </div>

                <div class="rb-iface-row">
                    <div class="form-group rb-iface">
                        <label>Interface (on backend)</label>
                        <input type="text" id="rbIface" list="rbIfaceList" placeholder="enp1s0f0" autocomplete="off">
                        <datalist id="rbIfaceList"></datalist>
                    </div>
                    <button class="btn btn-small" id="rbListIfaceBtn" type="button" title="Ask the backend for its network interfaces">Load</button>
                </div>

                <div class="rb-actions">
                    <button class="btn btn-success btn-small" id="rbStartBtn" type="button" title="Start ALL publishers on the backend (same as the header Start)">Start</button>
                    <button class="btn btn-danger btn-small" id="rbStopBtn" type="button" title="Stop publishing on the backend">Stop</button>
                </div>

                <pre class="rb-log" id="rbLog" aria-live="polite"></pre>
            </div>
        </section>
    `;
}

export function init(container) {
    if (!container) {
        console.warn('[RemoteBackend] No container provided');
        return;
    }
    container.innerHTML = getTemplate();

    elements.ip = document.getElementById('rbIp');
    elements.port = document.getElementById('rbPort');
    elements.connectBtn = document.getElementById('rbConnectBtn');
    elements.dot = document.getElementById('rbDot');
    elements.status = document.getElementById('rbStatus');
    elements.iface = document.getElementById('rbIface');
    elements.ifaceList = document.getElementById('rbIfaceList');
    elements.listIfaceBtn = document.getElementById('rbListIfaceBtn');
    elements.startBtn = document.getElementById('rbStartBtn');
    elements.stopBtn = document.getElementById('rbStopBtn');
    elements.log = document.getElementById('rbLog');

    // Follow the shared transport's connection state.
    tauriClient.on('connect', _onClientConnect);
    tauriClient.on('disconnect', _onClientDisconnect);

    elements.connectBtn.addEventListener('click', _toggleConnect);
    elements.listIfaceBtn.addEventListener('click', _loadInterfaces);
    elements.iface.addEventListener('change', _onIfaceChange);
    elements.startBtn.addEventListener('click', _start);
    elements.stopBtn.addEventListener('click', _stop);

    _renderState();
    console.log('[RemoteBackend] Initialized');
}

function _toggleConnect() {
    if (tauriClient.isRemote()) {
        // Revert the whole app to the embedded local backend.
        tauriClient.setBackend(null);
        _connecting = false;
        _log('Reverting to local backend …');
        return;
    }
    const ip = (elements.ip.value || '').trim();
    const port = parseInt(elements.port.value, 10) || 9002;
    if (!ip) {
        showToast('Enter the backend IP address', 'error');
        return;
    }
    const url = `ws://${ip}:${port}/ws`;
    _connecting = true;
    _log(`Connecting the app to ${url} …`);
    tauriClient.setBackend(url);
    _renderState();
}

function _onClientConnect() {
    if (tauriClient.isRemote()) {
        _connecting = false;
        _log('Connected. App is now driving the remote backend.');
        // Repopulate the main Network Settings dropdown + our datalist from the
        // remote's interfaces so Start opens the right NIC.
        try { NetworkSettings.refreshInterfaces(); } catch (_) {}
        _loadInterfaces();
        showToast('Remote backend connected', 'success');
    } else {
        // Reconnected to the local embedded backend.
        if (!_connecting) _log('Local backend connected.');
    }
    _renderState();
}

function _onClientDisconnect() {
    _log(tauriClient.isRemote() ? 'Remote backend connection dropped — retrying …'
                                : 'Backend disconnected.');
    _renderState();
}

async function _loadInterfaces() {
    if (!tauriClient.isConnected()) { showToast('Not connected to a backend', 'error'); return; }
    try {
        _ifaces = (await tauriClient.getInterfaces()) || [];
        if (elements.ifaceList) {
            elements.ifaceList.innerHTML = _ifaces
                .map(i => `<option value="${i.name}">${i.description || i.name}</option>`)
                .join('');
        }
        _log(`Backend has ${_ifaces.length} interface(s).`);
    } catch (err) {
        _log(`list interfaces failed: ${err.message || err}`);
        showToast('Failed to list backend interfaces', 'error');
    }
}

/* Selecting an interface here sets config.interfaceIndex — the same value
 * MultiPublisher.startAll() uses to open the NIC. Indices align because both
 * read from tauriClient.getInterfaces() against the same backend. */
function _onIfaceChange() {
    const name = (elements.iface.value || '').trim();
    if (!name || !_ifaces.length) return;
    const idx = _ifaces.findIndex(i => i.name === name);
    if (idx < 0) { _log(`interface "${name}" not in backend list — click Load`); return; }
    store.setConfig({ interfaceIndex: idx, interfaceName: _ifaces[idx].description || name });
    try { NetworkSettings.refreshInterfaces(); } catch (_) {}
    _log(`interface set: ${name} (index ${idx})`);
}

async function _start() {
    if (!tauriClient.isConnected()) { showToast('Connect to the backend first', 'error'); return; }
    // Exact same full multi-publisher flow as the header Start button.
    try {
        await MultiPublisher.startAll_public();
    } catch (err) {
        _log(`start failed: ${err.message || err}`);
    }
}

async function _stop() {
    try {
        await MultiPublisher.stopAll_public();
    } catch (err) {
        _log(`stop failed: ${err.message || err}`);
    }
}

function _renderState() {
    const remote = tauriClient.isRemote();
    const open = tauriClient.isConnected();
    const status = remote ? (open ? 'connected' : (_connecting ? 'connecting' : 'reconnecting'))
                          : 'local';
    if (elements.dot) {
        elements.dot.className = 'status-dot ' +
            (status === 'connected' ? 'ready' : status === 'reconnecting' ? 'error' : '');
    }
    if (elements.status) {
        elements.status.textContent = remote
            ? (open ? `Remote: ${tauriClient.getBackend().url}` : status.charAt(0).toUpperCase() + status.slice(1))
            : 'Local backend';
    }
    if (elements.connectBtn) {
        elements.connectBtn.textContent = remote ? 'Disconnect' : 'Connect';
        elements.connectBtn.classList.toggle('btn-success', !remote);
        elements.connectBtn.classList.toggle('btn-danger', remote);
    }
}

function _log(text) {
    if (!elements.log) return;
    const line = `${text}\n`;
    elements.log.textContent = (elements.log.textContent + line).split('\n').slice(-8).join('\n');
}

export const RemoteBackend = { init, getTemplate };
export default RemoteBackend;
