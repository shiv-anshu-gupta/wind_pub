#!/usr/bin/env bash
#
# grant-capabilities.sh
# ─────────────────────
# Grant the SV publisher binary the Linux capabilities it needs to:
#   • open raw Ethernet sockets (libpcap)            → CAP_NET_RAW
#   • bind to <1024 ports / set RT scheduling        → CAP_NET_ADMIN
#   • use SCHED_RR real-time priority on workers     → CAP_SYS_NICE
#   • mlockall() the hot-path memory                 → CAP_IPC_LOCK
#
# Without these, the binary either refuses to start (no raw socket) or
# silently degrades (SCHED_RR fallback to nice, mlockall returns EPERM).
#
# After running this once, the binary can be launched WITHOUT sudo by any
# user — capabilities are baked into the binary's xattrs.
#
# Run once per build (capabilities are lost when the file is overwritten):
#   ./scripts/grant-capabilities.sh           # default path
#   ./scripts/grant-capabilities.sh /path/to/binary
#
# Re-run after every `cargo build --release`.

set -euo pipefail

# Default target — Tauri release build output. Override via $1.
DEFAULT_BIN="$(dirname "$0")/../src-tauri/target/release/sv-publisher"
BIN="${1:-$DEFAULT_BIN}"

if [[ ! -f "$BIN" ]]; then
    echo "error: binary not found: $BIN" >&2
    echo "       run \`cargo build --release\` first, or pass the path explicitly." >&2
    exit 1
fi

if ! command -v setcap >/dev/null; then
    echo "error: setcap not installed. apt install libcap2-bin" >&2
    exit 1
fi

CAPS='cap_net_raw,cap_net_admin,cap_sys_nice,cap_ipc_lock+eip'

echo "── granting capabilities on: $BIN"
echo "   caps:                     $CAPS"
sudo setcap "$CAPS" "$BIN"

echo "── verifying:"
getcap "$BIN"

echo
echo "✓ done. You can now run the binary without sudo:"
echo "   $BIN"
