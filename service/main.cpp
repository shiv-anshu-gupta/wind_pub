/*
 * main.cpp — Entry point for the headless SV Publisher WebSocket service.
 *
 * Usage:  ./sv_publisher_service [port]    (default: 9001)
 *
 * Runs on Yocto (CLI). The dev-machine frontend connects to ws://<ip>:<port>/ws
 * and pushes configuration; this service drives the native publisher engine.
 */
#include "ws_server.h"

#include <cstdio>
#include <cstdlib>
#include <csignal>

static void on_signal(int /*sig*/) {
    /* Only signal-safe operation: set a flag. Default SIGINT/SIGTERM otherwise
     * terminates the process and the OS reclaims the pcap handle. */
    g_shutdown_requested = 1;
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

    std::fprintf(stdout, "SV Publisher WebSocket Service v1.0  port=%u\n", port);

    WsServer server;
    server.run(port);   /* blocks in the uWS event loop */

    return 0;
}
