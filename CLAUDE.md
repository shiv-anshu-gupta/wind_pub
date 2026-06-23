# CLAUDE.md — Session Notes

## Machine: DEVICE2-Ubuntu

### Network Interfaces
- `enp1s0` — ethernet, static IP 192.168.0.201/16, MAC 00:e0:b4:6a:5f:b8
- `enp2s0` — ethernet, static IP 192.168.0.202/16
- `enp3s0` — ethernet, static IP 192.168.0.203/16
- `wlxe0d36283bdae` — WiFi (USB adapter), DHCP 192.168.1.237/24, connected to "MyOptimum 356bff"
- `enp5s0f0`, `enp5s0f1` — ethernet ports, NO-CARRIER (physically unplugged)
- `wt0` — NetBird WireGuard interface, IP 100.100.246.181/16

### Default Route
Default gateway is **WiFi only** (`192.168.1.1 via wlxe0d36283bdae`).
Ethernet interfaces have **no gateway configured** — local 192.168.0.x traffic only, no internet.

### NetBird
- Version: 0.66.2
- Service: `/etc/systemd/system/netbird.service`, enabled
- NetBird IP: `100.100.246.181/16`
- FQDN: `device2-ubuntu-246-181.netbird.cloud`
- Interface type: Kernel (WireGuard)
- Peers: 8/12 connected (via relay only — ICE direct connections not working)
- Management: **Disconnected** (`DeadlineExceeded`) — caused by race condition at boot (netbird starts before WiFi is up)
- Signal: Connected
- Relays: 4/4 Available

### NetBird Issues & Fixes

**Problem 1: Not connecting to management server on boot**
- Root cause: `netbird.service` used `After=network.target` (weak ordering), starts before WiFi authenticates
- Fix applied: Changed to `After=network-online.target` so it waits for actual internet connectivity
  ```
  sudo systemctl daemon-reload
  ```

**Problem 2: NetBird only connects via WiFi**
- Root cause: Ethernet connections have static IPs but **no gateway** (`ipv4.gateway: --`)
- ARP for 192.168.0.1 fails on all ethernet interfaces — no internet path via ethernet
- Fix (pending): Need to know the gateway IP on the 192.168.0.x network, then run:
  ```bash
  sudo nmcli connection modify "netplan-enp1s0" ipv4.gateway <GATEWAY_IP>
  sudo nmcli connection up "netplan-enp1s0"
  ```
  Or switch to DHCP if the ethernet router uses it:
  ```bash
  sudo nmcli connection modify "netplan-enp1s0" ipv4.method auto
  sudo nmcli connection up "netplan-enp1s0"
  ```

**Problem 3: ICE direct peer connections failing**
- All peers fall back to `PriorityRelay` — ICE stays `Disconnected`
- Likely caused by management server disconnection and/or no internet route via ethernet
- Will likely resolve once ethernet gets a proper gateway and management reconnects

### Netplan Config
- `/etc/netplan/00-installer-config.yaml` — configures enp1s0 by MAC, no IP/gateway (relies on NM)
- `/etc/netplan/01-network-manager-all.yaml` — lets NetworkManager manage all devices

### NetworkManager Connections
| Connection | Interface | Type |
|---|---|---|
| MyOptimum 356bff 1 | wlxe0d36283bdae | WiFi |
| Wired connection 1 | enp2s0 | ethernet |
| netplan-enp1s0 | enp1s0 | ethernet |
| netplan-NM-a71f8f55-... | enp3s0 | ethernet |
| wt0 | wt0 | WireGuard (NetBird) |
