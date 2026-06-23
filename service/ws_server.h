/*
 * ws_server.h — WebSocket server for the headless SV Publisher backend.
 *
 * Runs on Yocto (CLI). Accepts JSON config/command frames over ws://<ip>:<port>/ws
 * and drives the native publisher engine (native/include/sv_native.h):
 *
 *   { "cmd": "list_interfaces" }
 *   { "cmd": "apply_config", "interface": "...", "config": {...}, "channels": [...] }
 *   { "cmd": "start", "interface": "..." }
 *   { "cmd": "stop" }
 *   { "cmd": "stats" }
 *
 * Responses: { "type": "welcome"|"ok"|"error"|"interfaces"|"status", ... }
 *
 * Config-only: no high-speed data path (unlike the sv-hmi subscriber service).
 */
#pragma once

#include <cstdint>
#include <csignal>

/* Set from the signal handler (signal-safe); used for graceful shutdown. */
extern volatile sig_atomic_t g_shutdown_requested;

class WsServer {
public:
    void run(uint16_t port = 9001);   /* blocks in the uWS event loop */
};
