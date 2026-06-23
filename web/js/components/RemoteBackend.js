/**
 * @file RemoteBackend.js
 * @fileoverview "Remote Backend" panel — connect to the headless publisher
 * backend running on Yocto over WebSocket and push configuration to it.
 *
 * The app normally talks to its Rust/native backend through Tauri invoke();
 * when the backend instead runs headless on a remote (Yocto) device, this panel
 * opens a WebSocket to it (ws://<ip>:<port>/ws) and sends JSON config commands.
 *
 * This is the frontend half. The matching headless C++ (uWebSockets) backend
 * service is a later step. Protocol lives in utils/wsClient.js.
 */

import store from '../store/index.js';
import { showToast } from '../plugins/toast.js';
import * as wsClient from '../utils/wsClient.js';

const elements = {};
let _connected = false;

export function getTemplate() {
    return `
        <section class="card" id="remote-backend-module">
            <div class="card-header">
                <h2>Remote Backend</h2>
                <span class="card-subtitle">Configure the Yocto publisher over WebSocket</span>
            </div>
            <div class="card-body">
                <div class="rb-conn-row">
                    <div class="form-group rb-ip">
                        <label>Backend IP</label>
                        <input type="text" id="rbIp" placeholder="192.168.0.201" autocomplete="off">
                    </div>
                    <div class="form-group rb-port">
                        <label>Port</label>
                        <input type="number" id="rbPort" min="1" max="65535" value="9001">
                    </div>
                    <button class="btn btn-success btn-small rb-connect" id="rbConnectBtn" type="button">Connect</button>
                </div>

                <div class="rb-status-row">
                    <span class="status-dot" id="rbDot"></span>
                    <span class="rb-status-text" id="rbStatus">Disconnected</span>
                </div>

                <div class="rb-iface-row">
                    <div class="form-group rb-iface">
                        <label>Interface (on backend)</label>
                        <input type="text" id="rbIface" list="rbIfaceList" placeholder="eth0" autocomplete="off">
                        <datalist id="rbIfaceList"></datalist>
                    </div>
                    <button class="btn btn-small" id="rbListIfaceBtn" type="button" title="Ask the backend for its network interfaces">Load</button>
                </div>

                <div class="rb-actions">
                    <button class="btn btn-primary btn-small" id="rbApplyBtn" type="button" title="Send the current SV configuration + channels to the backend">Apply Config</button>
                    <button class="btn btn-success btn-small" id="rbStartBtn" type="button" title="Start publishing on the backend">Start</button>
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
    elements.applyBtn = document.getElementById('rbApplyBtn');
    elements.startBtn = document.getElementById('rbStartBtn');
    elements.stopBtn = document.getElementById('rbStopBtn');
    elements.log = document.getElementById('rbLog');

    wsClient.onStatus(_onStatus);
    wsClient.onMessage(_onMessage);

    elements.connectBtn.addEventListener('click', _toggleConnect);
    elements.listIfaceBtn.addEventListener('click', () => _send({ cmd: 'list_interfaces' }, 'list_interfaces'));
    elements.applyBtn.addEventListener('click', _applyConfig);
    elements.startBtn.addEventListener('click', _start);
    elements.stopBtn.addEventListener('click', _stop);

    _setActionsEnabled(false);
    console.log('[RemoteBackend] Initialized');
}

function _toggleConnect() {
    if (_connected || wsClient.isConnected()) {
        wsClient.disconnect();
        _log('Disconnect requested');
        return;
    }
    const ip = (elements.ip.value || '').trim();
    const port = parseInt(elements.port.value, 10) || 9001;
    if (!ip) {
        showToast('Enter the backend IP address', 'error');
        return;
    }
    const url = `ws://${ip}:${port}/ws`;
    _log(`Connecting to ${url} ...`);
    wsClient.connect(url);
}

function _onStatus(status, detail) {
    _connected = (status === 'connected');
    if (elements.dot) {
        elements.dot.className = 'status-dot ' +
            (status === 'connected' ? 'ready' : status === 'error' ? 'error' : '');
    }
    if (elements.status) {
        elements.status.textContent =
            status.charAt(0).toUpperCase() + status.slice(1);
    }
    if (elements.connectBtn) {
        elements.connectBtn.textContent = _connected ? 'Disconnect' : 'Connect';
        elements.connectBtn.classList.toggle('btn-success', !_connected);
        elements.connectBtn.classList.toggle('btn-danger', _connected);
    }
    _setActionsEnabled(_connected);
    if (status === 'connected') {
        _log('Connected.');
        _send({ cmd: 'list_interfaces' }, 'list_interfaces');   // auto-load backend interfaces
    } else if (status === 'disconnected') {
        _log('Disconnected.');
    }
}

function _onMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'interfaces' && Array.isArray(msg.interfaces)) {
        _populateInterfaces(msg.interfaces);
        _log(`Backend has ${msg.interfaces.length} interface(s).`);
        return;
    }
    if (msg.type === 'error') {
        showToast(`Backend: ${msg.message || 'error'}`, 'error');
    } else if (msg.type === 'ok' || msg.type === 'welcome') {
        if (msg.message) showToast(`Backend: ${msg.message}`, 'success');
    }
    _log(JSON.stringify(msg));
}

function _populateInterfaces(ifaces) {
    if (!elements.ifaceList) return;
    elements.ifaceList.innerHTML = ifaces
        .map(i => `<option value="${i.name}">${i.description || i.name}</option>`)
        .join('');
}

function _applyConfig() {
    const config = store.get('config') || {};
    const channels = store.getChannelsForServer ? store.getChannelsForServer() : store.getChannels();
    const iface = (elements.iface.value || '').trim();
    const payload = { cmd: 'apply_config', interface: iface, config, channels };
    if (_send(payload, 'apply_config')) {
        showToast('Configuration sent to backend', 'success');
    }
}

function _start() {
    const iface = (elements.iface.value || '').trim();
    if (!iface) {
        showToast('Enter the backend interface name first', 'error');
        return;
    }
    _send({ cmd: 'start', interface: iface }, 'start');
}

function _stop() {
    _send({ cmd: 'stop' }, 'stop');
}

function _send(obj, label) {
    if (!wsClient.send(obj)) {
        showToast('Not connected to backend', 'error');
        _log(`(not sent — offline) ${label || ''}`);
        return false;
    }
    _log(`-> ${label || obj.cmd}`);
    return true;
}

function _setActionsEnabled(enabled) {
    [elements.listIfaceBtn, elements.applyBtn, elements.startBtn, elements.stopBtn]
        .forEach(btn => { if (btn) btn.disabled = !enabled; });
}

function _log(text) {
    if (!elements.log) return;
    const line = `${text}\n`;
    elements.log.textContent = (elements.log.textContent + line).split('\n').slice(-8).join('\n');
}

export const RemoteBackend = { init, getTemplate };
export default RemoteBackend;
