/**
 * @file PubWsServer.h
 * @brief Publisher's WebSocket server — mirrors the subscriber's WsServer.cc.
 *
 * Replaces the Tauri/Rust/FFI command path. The JS frontend connects to
 *   ws://localhost:<port>/ws
 * and sends JSON commands that are dispatched to the existing C++ logic
 * (PublisherController, GooseService, SpscBridge, etc.).
 *
 * Started once at process startup; runs forever in its own thread.
 */
#pragma once

#include <cstdint>

#ifdef __cplusplus
extern "C" {
#endif

/** Start the publisher WS server.
 *
 *  port_hint: starting port for the scan. The function probes
 *      [port_hint .. port_hint+99] inclusive and picks the first that
 *      bind(127.0.0.1) accepts. Pass 9100 as the historical default; pass 0
 *      to scan from 9100.
 *
 *  This change lets you launch the publisher binary multiple times — each
 *  process picks a free port instead of all collapsing onto 9100 and
 *  sharing one PublisherController. The actual port chosen is retrievable
 *  via sv_pub_ws_get_port().
 *
 *  Returns 0 on success, -1 if no port in the scan range is available.
 *  Idempotent — calling twice does nothing the second time. */
int sv_pub_ws_start(uint16_t port_hint);

/** Return the port the server actually bound to (set after sv_pub_ws_start
 *  succeeded). 0 if the server has not started yet. */
uint16_t sv_pub_ws_get_port(void);

#ifdef __cplusplus
}
#endif
