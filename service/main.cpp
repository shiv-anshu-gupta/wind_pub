/*
 * main.cpp — Entry point for the headless SV Publisher WebSocket service.
 *
 * Standalone, windowless backend. It starts the SAME WebSocket server the
 * Tauri app embeds (native/src/PubWsServer.cc → sv_pub_ws_start) and then
 * blocks. A remote frontend connects to ws://<host>:<port>/ws and drives the
 * multi-publisher engine over the JSON protocol PubWsServer implements — the
 * exact protocol tauriClient.js already speaks, so nothing on the JS side
 * changes except the transport endpoint.
 *
 * Reusing PubWsServer (rather than a separate hand-written handler) keeps this
 * service in lockstep with the engine: there is no second copy of the protocol
 * to drift out of date.
 *
 * Usage:  sv_publisher_service [port]      (default: 9001)
 *         The server scans upward from `port` for the first free slot, the
 *         same way the Tauri shell does; the bound port is printed at startup.
 */
#include "PubWsServer.h"

#include <cstdio>
#include <cstdlib>
#include <csignal>

#ifdef _WIN32
#  define WIN32_LEAN_AND_MEAN
#  include <windows.h>
#else
#  include <unistd.h>
#endif

static volatile sig_atomic_t g_running = 1;

static void on_signal(int /*sig*/) {
    /* Only a signal-safe flag set; the main loop sees it and returns so the OS
     * tears down the WS thread and reclaims the pcap handle. */
    g_running = 0;
}

int main(int argc, char **argv) {
    uint16_t port = 9001;
    if (argc > 1) {
        int p = std::atoi(argv[1]);
        if (p <= 0 || p > 65535) {
            std::fprintf(stderr, "Usage: %s [port]\n", argv[0]);
            return 1;
        }
        port = static_cast<uint16_t>(p);
    }

    std::signal(SIGINT,  on_signal);
    std::signal(SIGTERM, on_signal);

    /* Starts the uWS event loop in its own thread and returns immediately. */
    if (sv_pub_ws_start(port) != 0) {
        std::fprintf(stderr, "FATAL: no free WebSocket port near %u\n", port);
        return 1;
    }
    const uint16_t bound = sv_pub_ws_get_port();
    std::fprintf(stdout,
                 "SV Publisher WebSocket Service v1.0 — ws://0.0.0.0:%u/ws\n",
                 bound);
    std::fflush(stdout);

    /* Block until Ctrl-C / SIGTERM; the server keeps running on its thread. */
    while (g_running) {
#ifdef _WIN32
        Sleep(200);
#else
        usleep(200 * 1000);
#endif
    }

    std::fprintf(stdout, "shutting down\n");
    return 0;
}
