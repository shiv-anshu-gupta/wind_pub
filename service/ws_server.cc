/*
 * ws_server.cc — uWebSockets server that configures the native SV publisher.
 *
 * See ws_server.h for the JSON protocol. Each command maps to the native C API
 * declared in native/include/sv_native.h.
 */
#include "ws_server.h"

#include "App.h"                         // uWebSockets
#include <nlohmann/json.hpp>

#include <cstdio>
#include <cstring>
#include <cstdlib>
#include <string>
#include <vector>

extern "C" {
#include "sv_native.h"
}

using json = nlohmann::json;

volatile sig_atomic_t g_shutdown_requested = 0;

namespace {

struct PerSocketData { int id; };

/* Parse "aa:bb:cc:dd:ee:ff" into 6 bytes. Returns true on success. */
bool parse_mac(const std::string &s, uint8_t out[6]) {
    unsigned v[6];
    if (std::sscanf(s.c_str(), "%x:%x:%x:%x:%x:%x",
                    &v[0], &v[1], &v[2], &v[3], &v[4], &v[5]) != 6)
        return false;
    for (int i = 0; i < 6; ++i) out[i] = static_cast<uint8_t>(v[i] & 0xFF);
    return true;
}

std::string resp_ok(const std::string &msg)  { return json{{"type", "ok"},    {"message", msg}}.dump(); }
std::string resp_err(const std::string &msg) { return json{{"type", "error"}, {"message", msg}}.dump(); }

/* List the backend's network interfaces via the native engine. */
std::string list_interfaces_json() {
    NpcapInterface ifaces[64];
    int n = npcap_list_interfaces(ifaces, 64);
    if (n < 0) n = 0;
    json arr = json::array();
    for (int i = 0; i < n; ++i) {
        arr.push_back({{"name", ifaces[i].name}, {"description", ifaces[i].description}});
    }
    return json{{"type", "interfaces"}, {"interfaces", arr}}.dump();
}

/* Apply an SV configuration + channel list to the native engine. */
std::string handle_apply_config(const json &j) {
    const json cfg      = j.value("config", json::object());
    const json channels = j.value("channels", json::array());

    std::string svID = cfg.value("svID", std::string("MU01"));
    uint16_t appID   = static_cast<uint16_t>(cfg.value("appID", 0x4000));
    uint32_t confRev = cfg.value("confRev", 1u);
    uint8_t  smpSynch = static_cast<uint8_t>(cfg.value("smpSynch", 2));
    uint64_t sampleRate = cfg.value("sampleRate", static_cast<uint64_t>(4800));
    double   frequency  = cfg.value("frequency", 60.0);
    int      vlanID     = cfg.value("vlanID", 0);
    int      vlanPriority = cfg.value("vlanPriority", 4);
    uint8_t  asduCount  = static_cast<uint8_t>(cfg.value("noASDU", 1));

    uint8_t srcMAC[6] = {0x00, 0x00, 0x00, 0x00, 0x00, 0x01};
    uint8_t dstMAC[6] = {0x01, 0x0C, 0xCD, 0x04, 0x00, 0x00};
    if (cfg.contains("srcMAC") && cfg["srcMAC"].is_string())
        parse_mac(cfg["srcMAC"].get<std::string>(), srcMAC);
    if (cfg.contains("dstMAC") && cfg["dstMAC"].is_string())
        parse_mac(cfg["dstMAC"].get<std::string>(), dstMAC);

    uint8_t channelCount = static_cast<uint8_t>(channels.size());
    if (channelCount == 0)
        channelCount = static_cast<uint8_t>(cfg.value("channelCount", 8));

    /* Defaults — actual per-channel waveforms come from the equations below. */
    const double voltageAmplitude = 325.0;
    const double currentAmplitude = 100.0;

    int rc = npcap_publisher_configure(
        svID.c_str(), appID, confRev, smpSynch,
        srcMAC, dstMAC, vlanPriority, vlanID,
        sampleRate, frequency, voltageAmplitude, currentAmplitude,
        asduCount, channelCount);
    if (rc != 0)
        return resp_err(std::string("configure failed: ") + sv_get_last_error());

    /* Per-channel equations ("id1:eq1|id2:eq2|...") + types (0=current,1=voltage). */
    if (!channels.empty()) {
        std::string eqs;
        std::vector<uint8_t> types;
        types.reserve(channels.size());
        for (const auto &ch : channels) {
            std::string id   = ch.value("id", std::string());
            std::string eq   = ch.value("equation", std::string());
            std::string type = ch.value("type", std::string("current"));
            if (!eqs.empty()) eqs += "|";
            eqs += id + ":" + eq;
            types.push_back(type == "voltage" ? 1 : 0);
        }
        npcap_set_equations(eqs.c_str());
        npcap_set_channel_types(types.data(), static_cast<uint8_t>(types.size()));
    }

    return resp_ok("configuration applied (" + std::to_string((int)channelCount) + " channels)");
}

std::string handle_start(const json &j) {
    std::string iface = j.value("interface", std::string());
    if (iface.empty()) return resp_err("interface required");
    if (npcap_publisher_is_running()) return resp_err("already running");
    if (npcap_open(iface.c_str()) != 0)
        return resp_err(std::string("open failed: ") + npcap_get_last_error());
    if (npcap_publisher_start() != 0) {
        npcap_close();
        return resp_err(std::string("start failed: ") + sv_get_last_error());
    }
    return resp_ok("publishing started on " + iface);
}

std::string handle_stop() {
    npcap_publisher_stop();
    npcap_close();
    return resp_ok("publishing stopped");
}

std::string handle_stats() {
    TransmitStats st;
    std::memset(&st, 0, sizeof(st));
    npcap_stats_update_rates();
    npcap_stats_get(&st);
    return json{
        {"type", "status"},
        {"running", npcap_publisher_is_running() != 0},
        {"packetsSent", st.packets_sent},
        {"packetsFailed", st.packets_failed},
        {"bps", st.current_bps},
        {"pps", st.current_pps},
    }.dump();
}

std::string dispatch(std::string_view msg, bool &alreadySent, std::string &interfacesOut) {
    json j = json::parse(msg);
    std::string cmd = j.value("cmd", std::string());
    if (cmd == "list_interfaces") { alreadySent = true; interfacesOut = list_interfaces_json(); return {}; }
    if (cmd == "apply_config")    return handle_apply_config(j);
    if (cmd == "start")           return handle_start(j);
    if (cmd == "stop")            return handle_stop();
    if (cmd == "stats")           return handle_stats();
    return resp_err("unknown command: " + cmd);
}

} // namespace

void WsServer::run(uint16_t port) {
    int next_id = 1;
    uWS::App app;

    app.ws<PerSocketData>("/ws", {
        .compression      = uWS::DISABLED,
        .maxPayloadLength = 256 * 1024,
        .idleTimeout      = 120,
        .maxBackpressure  = 1 * 1024 * 1024,

        .open = [&](auto *ws) {
            ws->getUserData()->id = next_id++;
            std::fprintf(stdout, "[ws] client #%d connected\n", ws->getUserData()->id);
            ws->send(json{{"type", "welcome"}, {"message", "ready"}}.dump(), uWS::OpCode::TEXT);
        },

        .message = [&](auto *ws, std::string_view msg, uWS::OpCode op) {
            if (op != uWS::OpCode::TEXT) return;
            std::string out;
            try {
                bool alreadySent = false;
                std::string interfaces;
                out = dispatch(msg, alreadySent, interfaces);
                if (alreadySent) { ws->send(interfaces, uWS::OpCode::TEXT); return; }
            } catch (const std::exception &e) {
                out = resp_err(std::string("bad message: ") + e.what());
            }
            ws->send(out, uWS::OpCode::TEXT);
        },

        .close = [](auto *ws, int code, std::string_view) {
            std::fprintf(stdout, "[ws] client #%d disconnected (%d)\n",
                         ws->getUserData()->id, code);
        }
    });

    app.get("/health", [](auto *res, auto * /*req*/) {
        res->writeHeader("Content-Type", "application/json");
        res->end(R"({"status":"ok"})");
    });

    app.listen(port, [port](auto *sock) {
        if (sock) std::fprintf(stdout, "[ws] listening on port %u\n", port);
        else      std::fprintf(stderr, "[ws] FAILED to listen on port %u\n", port);
    });

    app.run();   /* blocks */
}
