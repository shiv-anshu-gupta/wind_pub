/**
 * @file PubWsServer.cc
 * @brief Publisher WebSocket server — replaces the Tauri/Rust/FFI command path.
 *
 * Architecture matches Backend/WsServer.cc in the subscriber: one uWS app
 * with a /ws endpoint, a single .message lambda that switches on the JSON
 * "cmd" field, and a tiny hand-rolled JSON scanner (no external dep).
 *
 * Every Tauri command in commands.rs has an equivalent JSON command here.
 * Field names match what tauriClient.js used to send to invoke(), so the
 * JS side only has to swap its transport (invoke -> WebSocket).
 */
#include "../include/PubWsServer.h"
#include "../include/PublisherController.h"
#include "../include/sv_publisher_instance.h"
#include "../include/SpscBridge.h"
#include "../include/GooseService.h"
#include "../include/PcapTx.h"
#include "../include/sv_stats.h"
#include "../include/sv_native.h"
#include "../include/cid_generator.h"

#include <App.h>   /* uWebSockets */

#include <atomic>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <mutex>
#include <string>
#include <string_view>
#include <thread>

/* Port-scan needs a raw socket bind() to probe availability before handing
 * the chosen port to uWS. The BSD-sockets API is near-identical on Windows
 * (Winsock2) and POSIX — only the headers, the close call, the socket type
 * and one optval cast differ, handled at each use site below. */
#ifdef _WIN32
#include <winsock2.h>
#include <ws2tcpip.h>
#ifdef _MSC_VER
#pragma comment(lib, "ws2_32.lib")  /* MinGW links ws2_32 via the build system */
#endif
#else
#include <sys/socket.h>
#include <netinet/in.h>
#include <unistd.h>
#include <arpa/inet.h>
#endif

namespace {

/*============================================================================
 * Tiny JSON helpers — same style as subscriber backend
 *============================================================================*/

std::string_view json_string(std::string_view msg, std::string_view key) {
    auto k = msg.find(key);
    if (k == std::string_view::npos) return {};
    auto colon = msg.find(':', k + key.size());
    if (colon == std::string_view::npos) return {};
    size_t i = colon + 1;
    while (i < msg.size() && (msg[i] == ' ' || msg[i] == '\t')) ++i;
    if (i >= msg.size()) return {};
    if (msg[i] == '"') {
        /* Scan for the closing quote, but SKIP backslash-escape pairs.
         * Critical for fields like "equations" whose value is itself a
         * JSON-stringified payload — has \" inside. The old simple
         * `find('"', i+1)` truncated the value at the first \". */
        size_t end = i + 1;
        while (end < msg.size()) {
            if (msg[end] == '\\' && end + 1 < msg.size()) { end += 2; continue; }
            if (msg[end] == '"') break;
            ++end;
        }
        if (end >= msg.size()) return {};
        return msg.substr(i + 1, end - i - 1);
    }
    size_t end = i;
    while (end < msg.size() && msg[end] != ',' && msg[end] != '}'
           && msg[end] != ']' && msg[end] != ' ' && msg[end] != '\n')
        ++end;
    return msg.substr(i, end - i);
}

/** Same as json_string but ALSO undoes JSON escape sequences
 *  (\" -> ", \\ -> \, \n, \t, \r, \/). Allocates — use only for fields
 *  whose value is itself a JSON document (equations, fault config). */
std::string json_string_unescaped(std::string_view msg, std::string_view key) {
    std::string_view raw = json_string(msg, key);
    std::string out; out.reserve(raw.size());
    for (size_t i = 0; i < raw.size(); ++i) {
        if (raw[i] == '\\' && i + 1 < raw.size()) {
            char c = raw[i + 1];
            switch (c) {
                case '"':  out += '"';  break;
                case '\\': out += '\\'; break;
                case '/':  out += '/';  break;
                case 'n':  out += '\n'; break;
                case 't':  out += '\t'; break;
                case 'r':  out += '\r'; break;
                default:   out += '\\'; out += c; break;  /* leave unknown */
            }
            ++i;
        } else {
            out += raw[i];
        }
    }
    return out;
}

double json_number(std::string_view msg, std::string_view key) {
    auto v = json_string(msg, key);
    if (v.empty()) return 0.0;
    return std::strtod(v.data(), nullptr);
}

bool json_bool(std::string_view msg, std::string_view key) {
    auto v = json_string(msg, key);
    return v == "true" || v == "1";
}

/** Read 6-byte MAC array from a JSON array like "srcMac":[0,1,2,3,4,5]. */
bool json_mac(std::string_view msg, std::string_view key, uint8_t out[6]) {
    auto k = msg.find(key);
    if (k == std::string_view::npos) return false;
    auto open = msg.find('[', k + key.size());
    if (open == std::string_view::npos) return false;
    size_t i = open + 1;
    for (int b = 0; b < 6; ++b) {
        while (i < msg.size() && (msg[i] == ' ' || msg[i] == ',' || msg[i] == '\n')) ++i;
        if (i >= msg.size() || msg[i] == ']') return false;
        char* end_ptr = nullptr;
        long val = std::strtol(msg.data() + i, &end_ptr, 10);
        if (end_ptr == msg.data() + i) return false;
        out[b] = (uint8_t)(val & 0xFF);
        i = (size_t)(end_ptr - msg.data());
    }
    return true;
}

/*============================================================================
 * Module state — one server, one worker thread
 *============================================================================*/

struct Module {
    std::atomic<bool>   started{false};
    std::thread         worker;
    std::mutex          start_mutex;
};
Module& mod() { static Module m; return m; }

struct PerSocketData {
    int id = 0;
};

/*============================================================================
 * The WS worker — owns the uWS event loop
 *============================================================================*/

void run_loop(uint16_t port)
{
    int next_id = 1;
    uWS::App app;

    app.ws<PerSocketData>("/ws", {
        .compression       = uWS::DISABLED,
        .maxPayloadLength  = 256 * 1024,
        .idleTimeout       = 120,
        .maxBackpressure   = 16 * 1024 * 1024,

        .open = [&](auto* ws) {
            ws->getUserData()->id = next_id++;
            std::fprintf(stdout, "[pub-ws] client #%d connected\n",
                         ws->getUserData()->id);
            ws->send(R"({"type":"welcome","version":"1"})",
                     uWS::OpCode::TEXT);
        },

        .message = [&](auto* ws, std::string_view msg, uWS::OpCode op) {
            if (op != uWS::OpCode::TEXT) return;
            char resp[1024];

            auto cmdSv = json_string(msg, "\"cmd\"");
            if (cmdSv.empty()) {
                ws->send(R"({"type":"error","reason":"missing cmd"})",
                         uWS::OpCode::TEXT);
                return;
            }
            std::string cmd(cmdSv);

            auto reply_ok_int = [&](const char* c, int64_t v) {
                int n = std::snprintf(resp, sizeof(resp),
                    R"({"type":"ok","cmd":"%s","value":%lld})",
                    c, (long long)v);
                ws->send(std::string_view(resp, (size_t)n), uWS::OpCode::TEXT);
            };
            auto reply_ok_uint = [&](const char* c, uint64_t v) {
                int n = std::snprintf(resp, sizeof(resp),
                    R"({"type":"ok","cmd":"%s","value":%llu})",
                    c, (unsigned long long)v);
                ws->send(std::string_view(resp, (size_t)n), uWS::OpCode::TEXT);
            };
            auto reply_ok_bool = [&](const char* c, bool v) {
                int n = std::snprintf(resp, sizeof(resp),
                    R"({"type":"ok","cmd":"%s","value":%s})",
                    c, v ? "true" : "false");
                ws->send(std::string_view(resp, (size_t)n), uWS::OpCode::TEXT);
            };
            auto reply_ok = [&](const char* c) {
                int n = std::snprintf(resp, sizeof(resp),
                    R"({"type":"ok","cmd":"%s"})", c);
                ws->send(std::string_view(resp, (size_t)n), uWS::OpCode::TEXT);
            };
            auto reply_error = [&](const char* c, const char* reason) {
                int n = std::snprintf(resp, sizeof(resp),
                    R"({"type":"error","cmd":"%s","reason":"%s"})", c, reason);
                ws->send(std::string_view(resp, (size_t)n), uWS::OpCode::TEXT);
            };

            /* ── INTERFACE ─────────────────────────────────────────────── */
            if (cmd == "get_interfaces") {
                NpcapInterface ifaces[64];
                int n = npcap_list_interfaces(ifaces, 64);
                if (n < 0) { reply_error(cmd.c_str(), "list failed"); return; }
                std::string out = R"({"type":"ok","cmd":"get_interfaces","value":[)";
                for (int i = 0; i < n; ++i) {
                    char buf[768];
                    int wn = std::snprintf(buf, sizeof(buf),
                        R"({"name":"%s","description":"%s","mac":[%u,%u,%u,%u,%u,%u],"has_mac":%d})",
                        ifaces[i].name, ifaces[i].description,
                        ifaces[i].mac[0], ifaces[i].mac[1], ifaces[i].mac[2],
                        ifaces[i].mac[3], ifaces[i].mac[4], ifaces[i].mac[5],
                        ifaces[i].has_mac);
                    if (i > 0) out += ",";
                    out.append(buf, (size_t)wn);
                }
                out += "]}";
                ws->send(out, uWS::OpCode::TEXT);
                return;
            }
            if (cmd == "open_interface") {
                auto name = json_string(msg, "\"name\"");
                std::string n(name);
                if (npcap_open(n.c_str()) == 0) reply_ok(cmd.c_str());
                else                            reply_error(cmd.c_str(), npcap_get_last_error());
                return;
            }
            if (cmd == "close_interface") {
                npcap_close();
                reply_ok(cmd.c_str());
                return;
            }
            if (cmd == "is_interface_open") {
                reply_ok_bool(cmd.c_str(), npcap_is_open() != 0);
                return;
            }

            /* ── MULTI-PUBLISHER LIFECYCLE ─────────────────────────────── */
            if (cmd == "mp_add_publisher") {
                uint32_t id = PublisherController::instance().addPublisher();
                reply_ok_uint(cmd.c_str(), id);
                return;
            }
            if (cmd == "mp_remove_publisher") {
                uint32_t id = (uint32_t)json_number(msg, "\"id\"");
                int rc = PublisherController::instance().removePublisher(id);
                if (rc == 0) reply_ok(cmd.c_str());
                else         reply_error(cmd.c_str(), "remove failed");
                return;
            }
            if (cmd == "mp_remove_all_publishers") {
                PublisherController::instance().removeAllPublishers();
                reply_ok(cmd.c_str());
                return;
            }
            if (cmd == "mp_get_publisher_count") {
                reply_ok_uint(cmd.c_str(), PublisherController::instance().getPublisherCount());
                return;
            }
            if (cmd == "mp_start_all") {
                int rc = PublisherController::instance().startAll();
                if (rc == 0) reply_ok(cmd.c_str());
                else         reply_error(cmd.c_str(), PublisherController::instance().getLastError());
                return;
            }
            if (cmd == "mp_stop_all") {
                PublisherController::instance().stopAll();
                reply_ok(cmd.c_str());
                return;
            }
            if (cmd == "mp_reset_all") {
                PublisherController::instance().resetAll();
                reply_ok(cmd.c_str());
                return;
            }
            if (cmd == "mp_is_running") {
                reply_ok_bool(cmd.c_str(), PublisherController::instance().isRunning());
                return;
            }
            if (cmd == "mp_set_duration") {
                uint32_t s   = (uint32_t)json_number(msg, "\"seconds\"");
                bool repeat  = json_bool(msg, "\"repeat\"");
                bool inf     = json_bool(msg, "\"infinite\"");
                uint32_t cnt = (uint32_t)json_number(msg, "\"count\"");
                PublisherController::instance().setDuration(s, repeat, inf, cnt);
                reply_ok(cmd.c_str());
                return;
            }
            if (cmd == "mp_configure_publisher") {
                uint32_t id = (uint32_t)json_number(msg, "\"id\"");
                PublisherConfig cfg{};
                auto svID = json_string(msg, "\"svId\"");
                std::snprintf(cfg.svID, sizeof(cfg.svID), "%.*s",
                              (int)svID.size(), svID.data());
                cfg.appID        = (uint16_t)json_number(msg, "\"appId\"");
                cfg.confRev      = (uint32_t)json_number(msg, "\"confRev\"");
                cfg.smpSynch     = (uint8_t)json_number(msg, "\"smpSynch\"");
                json_mac(msg, "\"srcMac\"", cfg.srcMAC);
                json_mac(msg, "\"dstMac\"", cfg.dstMAC);
                cfg.vlanID       = (int)json_number(msg, "\"vlanId\"");
                cfg.vlanPriority = (int)json_number(msg, "\"vlanPriority\"");
                cfg.sampleRate   = (uint64_t)json_number(msg, "\"sampleRate\"");
                cfg.frequency    = json_number(msg, "\"frequency\"");
                cfg.asduCount    = (uint8_t)json_number(msg, "\"noAsdu\"");
                cfg.channelCount = (uint8_t)json_number(msg, "\"channelCount\"");
                if (cfg.asduCount == 0) cfg.asduCount = 1;
                int rc = PublisherController::instance().configurePublisher(id, cfg);
                if (rc == 0) reply_ok(cmd.c_str());
                else         reply_error(cmd.c_str(), "configure failed");
                return;
            }
            if (cmd == "mp_set_publisher_equations") {
                uint32_t id = (uint32_t)json_number(msg, "\"id\"");
                /* equations is a stringified JSON array — needs unescape so
                 * the equation processor sees real " not \". */
                std::string eqs = json_string_unescaped(msg, "\"equations\"");
                int rc = PublisherController::instance().setPublisherEquations(id, eqs.c_str());
                if (rc == 0) reply_ok(cmd.c_str());
                else         reply_error(cmd.c_str(), "set equations failed");
                return;
            }
            if (cmd == "mp_set_publisher_source_mode") {
                uint32_t id = (uint32_t)json_number(msg, "\"id\"");
                int mode = (int)json_number(msg, "\"mode\"");
                SvPublisherInstance* pub = PublisherController::instance().getPublisher(id);
                if (!pub) { reply_error(cmd.c_str(), "no such publisher"); return; }
                pub->setSourceMode(mode == 1
                    ? SvPublisherInstance::SourceMode::External
                    : SvPublisherInstance::SourceMode::Equation);
                reply_ok(cmd.c_str());
                return;
            }
            if (cmd == "mp_set_publisher_protocol") {
                uint32_t id = (uint32_t)json_number(msg, "\"id\"");
                int proto = (int)json_number(msg, "\"protocol\"");
                SvPublisherInstance* pub = PublisherController::instance().getPublisher(id);
                if (!pub) { reply_error(cmd.c_str(), "no such publisher"); return; }
                pub->setProtocol(proto == 1
                    ? SvPublisherInstance::Protocol::GOOSE
                    : SvPublisherInstance::Protocol::SV);
                reply_ok(cmd.c_str());
                return;
            }
            if (cmd == "mp_get_remaining_seconds") {
                reply_ok_uint(cmd.c_str(), PublisherController::instance().getRemainingSeconds());
                return;
            }
            if (cmd == "mp_get_current_repeat_cycle") {
                reply_ok_uint(cmd.c_str(), PublisherController::instance().getCurrentRepeatCycle());
                return;
            }
            if (cmd == "mp_is_duration_complete") {
                reply_ok_bool(cmd.c_str(), PublisherController::instance().isDurationComplete());
                return;
            }

            /* ── STATS ─────────────────────────────────────────────────── */
            if (cmd == "get_stats") {
                npcap_stats_update_rates();
                TransmitStats s{}; npcap_stats_get(&s);
                int n = std::snprintf(resp, sizeof(resp),
                    R"({"type":"ok","cmd":"get_stats","value":{"packets_sent":%llu,"packets_failed":%llu,"bytes_sent":%llu,"current_bps":%g,"current_pps":%g,"peak_bps":%g,"peak_pps":%g,"session_active":%d}})",
                    (unsigned long long)s.packets_sent, (unsigned long long)s.packets_failed,
                    (unsigned long long)s.bytes_sent,
                    s.current_bps, s.current_pps, s.peak_bps, s.peak_pps,
                    s.session_active);
                ws->send(std::string_view(resp, (size_t)n), uWS::OpCode::TEXT);
                return;
            }
            if (cmd == "reset_stats") {
                npcap_stats_reset();
                reply_ok(cmd.c_str());
                return;
            }
            if (cmd == "mp_get_stats") {
                /* Mirror the Tauri command output: per-publisher stats + total. */
                npcap_stats_update_rates();
                TransmitStats s{}; npcap_stats_get(&s);
                int n = std::snprintf(resp, sizeof(resp),
                    R"({"type":"ok","cmd":"mp_get_stats","value":{"running":%d,"packets_sent":%llu,"current_bps":%g,"current_pps":%g}})",
                    PublisherController::instance().isRunning() ? 1 : 0,
                    (unsigned long long)s.packets_sent, s.current_bps, s.current_pps);
                ws->send(std::string_view(resp, (size_t)n), uWS::OpCode::TEXT);
                return;
            }

            /* ── SPSC BRIDGE ───────────────────────────────────────────── */
            if (cmd == "spsc_register") {
                uint16_t sid = (uint16_t)json_number(msg, "\"streamId\"");
                if (SpscBridge::instance().registerStream(sid)) reply_ok(cmd.c_str());
                else                                            reply_error(cmd.c_str(), "register failed");
                return;
            }
            if (cmd == "spsc_unregister") {
                uint16_t sid = (uint16_t)json_number(msg, "\"streamId\"");
                SpscBridge::instance().unregisterStream(sid);
                reply_ok(cmd.c_str());
                return;
            }
            if (cmd == "spsc_get_stats") {
                int n = std::snprintf(resp, sizeof(resp),
                    R"({"type":"ok","cmd":"spsc_get_stats","value":{"inbound_pushes":%llu,"inbound_drops":%llu,"outbound_pushes":%llu,"outbound_drops":%llu}})",
                    (unsigned long long)SpscBridge::instance().totalInboundPushes(),
                    (unsigned long long)SpscBridge::instance().totalInboundDrops(),
                    (unsigned long long)SpscBridge::instance().totalOutboundPushes(),
                    (unsigned long long)SpscBridge::instance().totalOutboundDrops());
                ws->send(std::string_view(resp, (size_t)n), uWS::OpCode::TEXT);
                return;
            }

            /* ── GOOSE ─────────────────────────────────────────────────── */
            if (cmd == "goose_configure_tx") {
                uint16_t sid       = (uint16_t)json_number(msg, "\"streamId\"");
                int      vlanID    = (int)json_number(msg, "\"vlanId\"");
                int      vlanPrio  = (int)json_number(msg, "\"vlanPriority\"");
                uint16_t appID     = (uint16_t)json_number(msg, "\"appId\"");
                uint32_t confRev   = (uint32_t)json_number(msg, "\"confRev\"");
                int      test      = json_bool(msg, "\"test\"") ? 1 : 0;
                int      ndsCom    = json_bool(msg, "\"ndsCom\"") ? 1 : 0;
                uint8_t srcMAC[6]{}, dstMAC[6]{};
                json_mac(msg, "\"srcMac\"", srcMAC);
                json_mac(msg, "\"dstMac\"", dstMAC);
                auto gocb = json_string(msg, "\"gocbRef\"");
                auto ds   = json_string(msg, "\"datSet\"");
                auto goid = json_string(msg, "\"goId\"");
                std::string gocbS(gocb), dsS(ds), goidS(goid);
                int rc = sv_goose_configure_tx(sid, srcMAC, dstMAC,
                            vlanID, vlanPrio, appID, confRev, test, ndsCom,
                            gocbS.c_str(), dsS.c_str(), goidS.c_str());
                if (rc == 0) reply_ok(cmd.c_str());
                else         reply_error(cmd.c_str(), "configure failed");
                return;
            }
            if (cmd == "goose_start_tx") {
                uint16_t sid = (uint16_t)json_number(msg, "\"streamId\"");
                uint32_t hb  = (uint32_t)json_number(msg, "\"heartbeatMs\"");
                uint32_t fr  = (uint32_t)json_number(msg, "\"firstRetxMs\"");
                int rc = sv_goose_start_tx(sid, hb, fr);
                if (rc == 0) reply_ok(cmd.c_str());
                else         reply_error(cmd.c_str(), "start failed");
                return;
            }
            if (cmd == "goose_stop_tx") {
                uint16_t sid = (uint16_t)json_number(msg, "\"streamId\"");
                sv_goose_stop_tx(sid);
                reply_ok(cmd.c_str());
                return;
            }
            if (cmd == "goose_stop_all_tx") {
                sv_goose_stop_all_tx();
                reply_ok(cmd.c_str());
                return;
            }
            if (cmd == "goose_rx_start") {
                auto iface = json_string(msg, "\"iface\"");
                std::string i(iface);
                int rc = sv_goose_rx_start(i.c_str());
                if (rc == 0) reply_ok(cmd.c_str());
                else         reply_error(cmd.c_str(), "rx start failed");
                return;
            }
            if (cmd == "goose_rx_stop") {
                sv_goose_rx_stop();
                reply_ok(cmd.c_str());
                return;
            }
            if (cmd == "goose_rx_register") {
                auto gocb = json_string(msg, "\"gocbRef\"");
                uint16_t sid = (uint16_t)json_number(msg, "\"streamId\"");
                std::string g(gocb);
                int rc = sv_goose_rx_register(g.c_str(), sid);
                if (rc == 0) reply_ok(cmd.c_str());
                else         reply_error(cmd.c_str(), "register failed");
                return;
            }
            if (cmd == "goose_rx_clear") {
                sv_goose_rx_clear();
                reply_ok(cmd.c_str());
                return;
            }
            if (cmd == "goose_get_stats") {
                uint16_t sid = (uint16_t)json_number(msg, "\"streamId\"");
                uint64_t txS=0, txF=0, rxS=0, rxP=0;
                sv_goose_get_stats(sid, &txS, &txF, &rxS, &rxP);
                int n = std::snprintf(resp, sizeof(resp),
                    R"({"type":"ok","cmd":"goose_get_stats","value":{"tx_sent":%llu,"tx_failed":%llu,"rx_seen":%llu,"rx_pushed":%llu}})",
                    (unsigned long long)txS, (unsigned long long)txF,
                    (unsigned long long)rxS, (unsigned long long)rxP);
                ws->send(std::string_view(resp, (size_t)n), uWS::OpCode::TEXT);
                return;
            }

            /* ── FAULT INJECTION ───────────────────────────────────────── */
            if (cmd == "fault_inject_configure") {
                /* config is also a stringified JSON payload — must unescape. */
                std::string j = json_string_unescaped(msg, "\"config\"");
                int rc = sv_fault_inject_configure(j.c_str());
                if (rc == 0) reply_ok(cmd.c_str());
                else         reply_error(cmd.c_str(), "configure failed");
                return;
            }
            if (cmd == "fault_inject_enable") {
                int en = json_bool(msg, "\"enable\"") ? 1 : 0;
                sv_fault_inject_enable(en);
                reply_ok(cmd.c_str());
                return;
            }
            if (cmd == "fault_inject_get_stats") {
                const char* j = sv_fault_inject_get_stats();
                int n = std::snprintf(resp, sizeof(resp),
                    R"({"type":"ok","cmd":"fault_inject_get_stats","value":%s})",
                    (j && *j) ? j : "{}");
                ws->send(std::string_view(resp, (size_t)n), uWS::OpCode::TEXT);
                return;
            }
            if (cmd == "fault_inject_reset_stats") {
                sv_fault_inject_reset_stats();
                reply_ok(cmd.c_str());
                return;
            }

            /* ── FRAME INSPECTION (used by FrameViewer) ──────────────────
             * All inspection commands target a specific publisher by id.
             * If "id" is missing or matches no live publisher, fall back to
             * the lowest live id — so the FrameViewer / Export CID still
             * work after removeAll+add (when ids don't restart at 0). */
            auto pickPublisher = [&]() -> SvPublisherInstance* {
                auto raw = json_string(msg, "\"id\"");
                if (!raw.empty()) {
                    uint32_t id = (uint32_t)json_number(msg, "\"id\"");
                    SvPublisherInstance* p = PublisherController::instance().getPublisher(id);
                    if (p) return p;
                }
                return PublisherController::instance().getFirstPublisher();
            };

            if (cmd == "get_sample_frame") {
                uint32_t smp_cnt = (uint32_t)json_number(msg, "\"smpCnt\"");
                SvPublisherInstance* pub = pickPublisher();
                if (!pub) { reply_error(cmd.c_str(), "no publisher"); return; }
                uint8_t buf[2048]; size_t frame_size = 0;
                int rc = pub->getSampleFrame(buf, sizeof(buf), &frame_size, smp_cnt);
                if (rc != 0 || frame_size == 0) {
                    reply_error(cmd.c_str(), "no frame");
                    return;
                }
                /* Encode the frame bytes as a JSON array; safe for <2KB frames. */
                std::string out =
                    R"({"type":"ok","cmd":"get_sample_frame","value":{"frameSize":)";
                out += std::to_string(frame_size);
                out += R"(,"frameBytes":[)";
                for (size_t i = 0; i < frame_size; ++i) {
                    if (i > 0) out += ",";
                    out += std::to_string((unsigned)buf[i]);
                }
                out += "]}}";
                ws->send(out, uWS::OpCode::TEXT);
                return;
            }
            if (cmd == "get_current_channel_values") {
                SvPublisherInstance* pub = pickPublisher();
                if (!pub) { reply_error(cmd.c_str(), "no publisher"); return; }
                int32_t values[20] = {0};
                int n_ch = pub->getCurrentChannelValues(values, 20);
                uint32_t smp = pub->getCurrentSmpCnt();
                std::string out =
                    R"({"type":"ok","cmd":"get_current_channel_values","value":{"values":[)";
                if (n_ch < 0) n_ch = 0;
                if (n_ch > 20) n_ch = 20;
                for (int i = 0; i < n_ch; ++i) {
                    if (i > 0) out += ",";
                    out += std::to_string(values[i]);
                }
                out += R"(],"smpCnt":)";
                out += std::to_string(smp);
                out += "}}";
                ws->send(out, uWS::OpCode::TEXT);
                return;
            }

            /* ── CID EXPORT ──────────────────────────────────────────────
             * Two variants:
             *   export_cid                 — uses a live publisher's config
             *                                (picks by "id", default first).
             *   export_cid_with_config     — caller supplies entire config in
             *                                the message (no publisher needed). */
            if (cmd == "export_cid") {
                auto path = json_string(msg, "\"outputPath\"");
                std::string p(path);
                SvPublisherInstance* pub = pickPublisher();
                if (!pub) { reply_error(cmd.c_str(), "no publisher"); return; }
                int rc = pub->exportCid(p.c_str());
                if (rc == 0) reply_ok(cmd.c_str());
                else         reply_error(cmd.c_str(), "export failed");
                return;
            }
            if (cmd == "export_cid_with_config") {
                auto path = json_string(msg, "\"outputPath\"");
                std::string p(path);
                auto svID = json_string(msg, "\"svId\"");
                std::string svid_s(svID);
                uint16_t appID    = (uint16_t)json_number(msg, "\"appId\"");
                uint32_t confRev  = (uint32_t)json_number(msg, "\"confRev\"");
                uint8_t  smpSynch = (uint8_t) json_number(msg, "\"smpSynch\"");
                uint8_t srcMAC[6]{}, dstMAC[6]{};
                json_mac(msg, "\"srcMac\"", srcMAC);
                json_mac(msg, "\"dstMac\"", dstMAC);
                int vlanPriority = (int)json_number(msg, "\"vlanPriority\"");
                int vlanID       = (int)json_number(msg, "\"vlanId\"");
                uint64_t sr      = (uint64_t)json_number(msg, "\"sampleRate\"");
                double freq      = json_number(msg, "\"frequency\"");
                uint8_t asduCount   = (uint8_t)json_number(msg, "\"asduCount\"");
                uint8_t channelCount= (uint8_t)json_number(msg, "\"channelCount\"");

                /* channel types array — read up to 20 entries */
                uint8_t types[20] = {0};
                auto k = msg.find("\"channelTypes\"");
                if (k != std::string_view::npos) {
                    auto open = msg.find('[', k);
                    size_t i = (open != std::string_view::npos) ? open + 1 : msg.size();
                    for (int b = 0; b < channelCount && b < 20 && i < msg.size(); ++b) {
                        while (i < msg.size() && (msg[i]==' '||msg[i]==',')) ++i;
                        if (i >= msg.size() || msg[i] == ']') break;
                        char* ep = nullptr;
                        long v = std::strtol(msg.data() + i, &ep, 10);
                        if (ep == msg.data() + i) break;
                        types[b] = (uint8_t)(v & 0xFF);
                        i = (size_t)(ep - msg.data());
                    }
                }
                /* Build a fresh PublisherConfig from the message and hand it
                 * directly to the CID generator — no legacy singleton state
                 * involved. */
                PublisherConfig cfg{};
                std::strncpy(cfg.svID, svid_s.c_str(), sizeof(cfg.svID) - 1);
                cfg.appID         = appID;
                cfg.confRev       = confRev;
                cfg.smpSynch      = smpSynch;
                std::memcpy(cfg.srcMAC, srcMAC, 6);
                std::memcpy(cfg.dstMAC, dstMAC, 6);
                cfg.vlanPriority  = vlanPriority;
                cfg.vlanID        = vlanID;
                cfg.sampleRate    = sr;
                cfg.frequency     = freq;
                cfg.asduCount     = asduCount;
                cfg.channelCount  = channelCount;
                std::memcpy(cfg.channelTypes, types, sizeof(cfg.channelTypes));
                int rc = sv_cid_export(&cfg, p.c_str());
                if (rc == 0) reply_ok(cmd.c_str());
                else         reply_error(cmd.c_str(), "export failed");
                return;
            }

            /* ── UNKNOWN ───────────────────────────────────────────────── */
            reply_error(cmd.c_str(), "unknown cmd");
        },

        .close = [&](auto* ws, int /*code*/, std::string_view /*r*/) {
            std::fprintf(stdout, "[pub-ws] client #%d disconnected\n",
                         ws->getUserData()->id);
        },
    });

    app.listen(port, [port](auto* sock) {
        if (sock) std::fprintf(stdout, "[pub-ws] listening on ws://0.0.0.0:%u/ws\n", port);
        else      std::fprintf(stderr, "[pub-ws] FAILED to bind port %u\n", port);
    });
    app.run();
}

}  /* namespace */

/* Bound port — set by sv_pub_ws_start after the scan picks a free slot.
 * Read by sv_pub_ws_get_port() so the Rust shell can tell the webview
 * which port to connect to. Module-scope so it survives the lambda. */
static std::atomic<uint16_t> g_bound_port{0};

/* Probe whether `port` is available on 127.0.0.1. Uses SO_REUSEADDR so
 * the close()-then-bind sequence used by uWS later doesn't race against
 * a TIME_WAIT residue from this test bind. Returns 0 if available, -1
 * if bind() rejects (port in use). */
static int probe_port_free(uint16_t port)
{
#ifdef _WIN32
    /* Winsock must be initialised before any socket call. WSAStartup is
     * reference-counted and uSockets calls it too, so a once-guarded extra
     * call here is harmless and keeps this probe self-contained. */
    static bool wsa_ready = [] {
        WSADATA wsa;
        return WSAStartup(MAKEWORD(2, 2), &wsa) == 0;
    }();
    if (!wsa_ready) return -1;

    SOCKET s = ::socket(AF_INET, SOCK_STREAM, 0);
    if (s == INVALID_SOCKET) return -1;
#else
    int s = ::socket(AF_INET, SOCK_STREAM, 0);
    if (s < 0) return -1;
#endif
    int one = 1;
    /* optval is `const char*` on Winsock and `const void*` on POSIX — a
     * char* satisfies both. */
    ::setsockopt(s, SOL_SOCKET, SO_REUSEADDR,
                 reinterpret_cast<const char*>(&one), sizeof(one));
    sockaddr_in addr{};
    addr.sin_family      = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    addr.sin_port        = htons(port);
    int rc = ::bind(s, reinterpret_cast<sockaddr*>(&addr), sizeof(addr));
#ifdef _WIN32
    ::closesocket(s);
#else
    ::close(s);
#endif
    return rc;   /* 0 = available */
}

extern "C" int sv_pub_ws_start(uint16_t port_hint)
{
    std::lock_guard<std::mutex> lk(mod().start_mutex);
    if (mod().started.load(std::memory_order_acquire)) return 0;

    /* Scan a 100-port window starting from port_hint (or 9100 if 0).
     * Each publisher process picks the first free slot — so a second
     * launch lands on 9101, a third on 9102, etc., giving each Tauri
     * window its own PublisherController instead of all collapsing
     * onto the first process. */
    const uint16_t start = port_hint ? port_hint : 9100;
    uint16_t chosen = 0;
    for (uint16_t p = start; p < start + 100; ++p) {
        if (probe_port_free(p) == 0) { chosen = p; break; }
    }
    if (!chosen) {
        std::fprintf(stderr,
            "[pub-ws] ERROR: no free port in [%u..%u] — refusing to start\n",
            start, static_cast<unsigned>(start + 99));
        return -1;
    }
    std::fprintf(stdout, "[pub-ws] bound to port %u\n", chosen);
    g_bound_port.store(chosen, std::memory_order_release);
    mod().started.store(true, std::memory_order_release);
    mod().worker = std::thread([chosen]() { run_loop(chosen); });
    mod().worker.detach();
    return 0;
}

extern "C" uint16_t sv_pub_ws_get_port(void)
{
    return g_bound_port.load(std::memory_order_acquire);
}
