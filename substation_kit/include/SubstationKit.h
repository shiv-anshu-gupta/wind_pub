/**
 * @file SubstationKit.h
 * @brief Embeddable IEC 61850 publisher library — for Shivani's substation app.
 *
 * Why this exists
 * ---------------
 * Shivani's substation simulator runs on the SAME device as the publisher.
 * Instead of two processes, we package the publisher's core capabilities
 * (multi-publisher SV path, GOOSE TX/RX, SPSC bridge, ASN.1 BER, SV/GOOSE
 * encoders, libpcap TX) as a C++ library she #includes and links against.
 * WebSocket transport stays in her app — it is NOT part of this library.
 *
 * The whole library lives under namespace `substation::`. Every public
 * symbol that's worth exposing has a `substation::xxx::...` form so it
 * doesn't collide with anything in her existing codebase.
 *
 * Usage sketch from her main():
 *
 *     #include "SubstationKit.h"
 *
 *     int main() {
 *         substation::net::open("eth0");
 *         uint32_t sv = substation::publisher::add();
 *         substation::publisher::Config pc{}; // svID, rate, channels...
 *         substation::publisher::configure(sv, pc);
 *         // Define the waveform by equation; the backend generates the
 *         // samples and the writer thread transmits them — no live feed.
 *         substation::publisher::setEquations(sv,
 *             "Ia:230*sin(2*PI*50*t)|Ib:230*sin(2*PI*50*t-2*PI/3)");
 *         substation::publisher::start();
 *         // ... runs until ...
 *         substation::publisher::stop();
 *         substation::publisher::reset();
 *         substation::net::close();
 *     }
 *
 * Lifecycle contract
 * ------------------
 *   - The library does NOT auto-init anything.
 *   - Her main thread is never blocked by any library call.
 *   - SV is generated from equations by the publisher backend and scheduled
 *     through the SharedBuffer to the writer thread.
 */
#pragma once

#include <atomic>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <string>
#include <thread>

namespace substation {

/*============================================================================
 * substation::ber  — ASN.1 BER encoder primitives
 * Wraps the publisher's existing asn1_ber_encoder helpers.
 *============================================================================*/

namespace ber {

size_t encode_tag    (uint8_t* buf, size_t buflen, uint8_t tag);
size_t encode_length (uint8_t* buf, size_t buflen, size_t length);
size_t encode_tlv    (uint8_t* buf, size_t buflen, uint8_t tag,
                      const uint8_t* value, size_t value_len);
size_t encode_unsigned(uint8_t* buf, size_t buflen, uint8_t tag, uint64_t value);
size_t encode_signed (uint8_t* buf, size_t buflen, uint8_t tag, int64_t value);
size_t encode_int32_fixed (uint8_t* buf, size_t buflen, int32_t  value);
size_t encode_uint32_fixed(uint8_t* buf, size_t buflen, uint32_t value);
size_t encode_visible_string(uint8_t* buf, size_t buflen, uint8_t tag,
                             const char* str);
size_t encode_octet_string(uint8_t* buf, size_t buflen, uint8_t tag,
                           const uint8_t* data, size_t data_len);
size_t encode_boolean(uint8_t* buf, size_t buflen, uint8_t tag, int value);

}  // namespace ber

/*============================================================================
 * substation::sv  — IEC 61850-9-2 LE Sampled Values encoder
 *
 * Mirrors the publisher's sv_encoder API, exposed under a tidy namespace.
 *============================================================================*/

namespace sv {

constexpr size_t   MAX_CHANNELS = 20;
constexpr size_t   MAX_ASDU     = 8;
constexpr size_t   MAX_SVID_LEN = 64;
constexpr size_t   MIN_FRAME    = 60;
constexpr size_t   MAX_FRAME    = 1500;
constexpr uint16_t ETHERTYPE    = 0x88BA;

struct EncoderConfig {
    char     svID[MAX_SVID_LEN];
    uint16_t appID;
    uint32_t confRev;
    uint8_t  smpSynch;
    uint8_t  srcMAC[6];
    uint8_t  dstMAC[6];
    int      vlanPriority;
    int      vlanID;
    uint8_t  asduCount;     /* 1, 4, or 8 */
    uint8_t  channelCount;  /* 1-20 */
};

/** Configure the encoder (thread-singleton — set once per TX context). */
void setConfig(const EncoderConfig& cfg);

/** Read the current config. */
void getConfig(EncoderConfig* out);

/** Encode a single-ASDU SV frame. Returns 0 on success, -1 on error. */
int encodePacket(uint32_t smpCnt, const int32_t* samples,
                 uint8_t* outBuffer, size_t* outSize);

/** Encode a multi-ASDU SV frame. samplesArray has asduCount entries. */
int encodeMultiAsdu(uint32_t baseSmpCnt, const int32_t** samplesArray,
                    uint8_t* outBuffer, size_t* outSize);

/** Expected frame size for the current config. */
size_t expectedFrameSize();

}  // namespace sv

/*============================================================================
 * substation::goose  — IEC 61850-8-1 GOOSE encoder (boolean payload subset)
 *============================================================================*/

namespace goose {

constexpr size_t   MAX_FRAME   = 256;
constexpr size_t   MIN_FRAME   = 60;
constexpr size_t   MAX_REF_LEN = 128;
constexpr uint16_t ETHERTYPE   = 0x88B8;

struct EncoderConfig {
    uint8_t  srcMAC[6];
    uint8_t  dstMAC[6];          /* must be 01:0C:CD:01:xx:xx */
    int      vlanID;             /* -1 = no VLAN */
    int      vlanPriority;
    uint16_t appID;
    uint32_t confRev;
    int      test;
    int      ndsCom;
    char     gocbRef[MAX_REF_LEN];
    char     datSet [MAX_REF_LEN];
    char     goID   [MAX_REF_LEN];
};

struct FrameState {
    uint32_t stNum;
    uint32_t sqNum;
    uint32_t timeAllowedToLive_ms;
    uint64_t t_ns;
    int      booleanValue;
};

int encodeFrame(const EncoderConfig& cfg, const FrameState& state,
                uint8_t* out, size_t* outLen);

/*----------------------------------------------------------------------------
 * GOOSE TX/RX lifecycle — full IEC 61850 publish/subscribe with the proper
 * retransmit ramp, built on the publisher's GooseTxScheduler / GooseReceiver.
 * These manage stNum/sqNum/timing internally. You drive a stream by pushing
 * its boolean state via goose::setValue(); the scheduler latches it and
 * follows the retransmit ramp. (This is the ONLY consumer of the internal
 * SPSC bridge — SV is equation-driven and never touches it.)
 *
 * Typical TX usage:
 *     substation::net::open("eth0");
 *     substation::goose::configureTx(1, gcfg);   // who/where/what (auto-reg)
 *     substation::goose::setValue(1, true);       // initial breaker state
 *     substation::goose::startTx(1);              // spawn scheduler
 *     ...
 *     substation::goose::setValue(1, false);      // breaker opened
 *
 * Typical RX usage:
 *     substation::goose::rxStart("eth0");
 *     substation::goose::rxRegister("BAY1/LLN0$GO$gcb01", 1);
 *     bool v; if (substation::goose::popDecoded(1, &v)) { ... }
 *--------------------------------------------------------------------------*/

/** Configure (or replace) the TX side of `streamId`. Auto-registers the
 *  internal GOOSE stream. Call before startTx(). 0 on success. */
int configureTx(uint16_t streamId, const EncoderConfig& cfg);

/** Set the current boolean state for a GOOSE `streamId` (e.g. breaker
 *  closed=true / open=false). The scheduler latches it; a change restarts
 *  the fast retransmit ramp. Returns false if the stream isn't configured.
 *  Push the initial value BEFORE startTx so the first frame fires at once. */
bool setValue(uint16_t streamId, bool value, uint64_t timestampNs = 0);

/** Start the per-stream retransmit scheduler. Requires configureTx() first
 *  and an open TX iface (net::open). `heartbeatMs` = T1 idle period;
 *  `firstRetxMs` = T0' first retransmit. 0 on success. */
int startTx(uint16_t streamId, uint32_t heartbeatMs = 1000, uint32_t firstRetxMs = 2);

/** Stop one TX stream. Safe if not running. */
int stopTx(uint16_t streamId);

/** Stop every TX stream. */
int stopAllTx();

/** Start the single GOOSE receiver on `iface` (ether proto 0x88B8).
 *  0 on success, -1 if already running or pcap failed. */
int rxStart(const char* iface);

/** Stop the receiver. Safe if none running. */
int rxStop();

/** Map an incoming gocbRef to a streamId. Empty gocbRef = catch-all. */
int rxRegister(const char* gocbRef, uint16_t streamId);

/** Forget all receiver mappings. */
int rxClear();

/** Read counters. NULL pointers skip a field. rxSeen/rxPushed are global. */
void getStats(uint16_t streamId, uint64_t* txSent, uint64_t* txFailed,
              uint64_t* rxSeen, uint64_t* rxPushed);

/** Pop one boolean the receiver decoded for `streamId` (e.g. a trip
 *  command). Returns false if none pending. `outTimestampNs` may be NULL. */
bool popDecoded(uint16_t streamId, bool* outValue, uint64_t* outTimestampNs = nullptr);

}  // namespace goose

/*============================================================================
 * substation::publisher  — the FULL multi-publisher SV path (equation-driven)
 *
 * This is the SAME path the standalone publisher app runs: it pre-builds a
 * second of frames from the configured equations, merges them into a
 * time-sorted SharedBuffer, and a paced writer thread transmits them. The
 * SharedBuffer is the working buffer between each SvPublisherInstance and the
 * writer thread.
 *
 * Lifecycle:
 *     substation::net::open("eth0");
 *     uint32_t id = substation::publisher::add();
 *     substation::publisher::Config c{};  // fill svID, rate, channels, types
 *     substation::publisher::configure(id, c);
 *     substation::publisher::setEquations(id, "Ia:230*sin(2*PI*50*t)|...");
 *     substation::publisher::start();
 *     ...
 *     substation::publisher::stop();
 *
 * NOTE: a global single encoder is shared, so prebuild is sequential; this
 *       mirrors the publisher exactly.
 * NOTE: this path generates samples from formulas. Live per-sample value
 *       injection is intentionally not part of this library.
 *============================================================================*/

namespace publisher {

/* Byte-for-byte mirror of the publisher's internal PublisherConfig so we can
 * forward without leaking the internal header. Verified by static_assert in
 * the .cc. channelTypes: 0 = current (TCTR, ×1000), 1 = voltage (TVTR, ×100). */
struct Config {
    char     svID[64];
    uint16_t appID;
    uint32_t confRev;
    uint8_t  smpSynch;
    uint8_t  srcMAC[6];
    uint8_t  dstMAC[6];
    int      vlanPriority;
    int      vlanID;
    uint64_t sampleRate;
    double   frequency;
    double   voltageAmplitude;
    double   currentAmplitude;
    uint8_t  asduCount;
    uint8_t  channelCount;     /* 1-20 */
    uint8_t  channelTypes[20]; /* per-channel: 0=current, 1=voltage */
};

/** Create a publisher instance. Returns its id. */
uint32_t add();

/** Configure a publisher. Returns 0 on success, -1 if id not found. */
int configure(uint32_t id, const Config& cfg);

/** Equation (baked waveform) mode: "Ia:100*sin(2*PI*50*t)|Ib:...". */
int setEquations(uint32_t id, const char* equations);

/** Prebuild all configured publishers + start the writer thread. Requires
 *  an open TX iface (net::open). 0 on success. */
int start();

/** Stop the writer thread and clear publishers. 0 on success. */
int stop();

/** Full reset — stop + clear all state + reset stats. 0 on success. */
int reset();

bool     isRunning();
uint32_t count();
int      removeAll();
const char* lastError();

/*----------------------------------------------------------------------------
 * Live-value ingest — for the teammate's substation simulator (e.g. Modelica)
 *
 * This is the ONLY live-data entry point and is fully separate from the
 * equation path: an Equation-mode publisher ignores submitted values, while an
 * External-mode publisher (see setExternalMode) transmits them. init() spawns
 * ONE consumer thread plus an internal multi-producer queue; the simulator's
 * many threads call submitMagnitude/submitBoolean concurrently. The consumer
 * routes magnitudes into the publisher's SharedBuffer path (re-encode) and
 * booleans into the GOOSE scheduler. SV never touches the SPSC bridge.
 *
 * Typical use:
 *     substation::publisher::init();                 // spawn the worker
 *     substation::publisher::setExternalMode(id, true);
 *     substation::publisher::start();
 *     // ... her sim threads, whenever they produce a value:
 *     substation::publisher::submitMagnitude(id, 0, 230.5f);
 *     ...
 *     substation::publisher::shutdown();             // (also done by reset())
 *--------------------------------------------------------------------------*/

/** Start the live-ingest worker (one consumer thread + internal MPMC queue).
 *  Call once, any time after configure(). queueCapacity is the queue depth.
 *  Returns 0 on success, -1 if already running. No effect on equation-only
 *  use — if you never submit values, this need not be called. */
int  init(size_t queueCapacity = 8192);

/** Stop the live-ingest worker and join its thread. Idempotent; also invoked
 *  by reset(). Safe to call even if init() was never called. */
void shutdown();

/** Select a publisher's value source. false = Equation (prebuilt waveform,
 *  the default); true = External (transmits submitted live values). Returns
 *  0 on success, -1 if id not found. */
int  setExternalMode(uint32_t id, bool external);

/** Push a live magnitude (physical units: amps or volts) for one channel of
 *  an External-mode publisher. Safe to call from ANY number of threads;
 *  non-blocking. Returns false if init() was not called or the queue is full.
 *  `quality`/`timestampNs` are accepted for forward-compatibility (the SV
 *  encoder currently emits fixed Good quality). */
bool submitMagnitude(uint32_t id, uint8_t channel, float value,
                     uint16_t quality = 0, uint64_t timestampNs = 0);

/** Push a live boolean for a GOOSE `streamId`. Routed through the same worker
 *  to the GOOSE scheduler (which uses the SPSC bridge internally). Equivalent
 *  to goose::setValue but funnelled through the ingest queue. Non-blocking;
 *  returns false if init() was not called or the queue is full. */
bool submitBoolean(uint16_t streamId, bool value,
                   uint16_t quality = 0, uint64_t timestampNs = 0);

}  // namespace publisher

/*============================================================================
 * substation::net  — libpcap-based raw Ethernet TX (Linux AF_PACKET path)
 *============================================================================*/

namespace net {

/** Enumerate interfaces. Returns count, or -1 on error. */
struct Interface {
    char name[256];
    char description[256];
    uint8_t mac[6];
    int has_mac;
};
int listInterfaces(Interface* out, int max_count);

/** Open an interface for raw TX. Returns 0 on success. */
int open(const char* device);

/** Close the current handle. */
void close();

bool isOpen();

/** Send one Ethernet frame. */
int sendPacket(const uint8_t* data, size_t len);

/** sendmmsg batch — collapse N syscalls into 1. */
int sendBatch(const uint8_t* const* data, const size_t* lens, size_t count);

/** Last error string. Never NULL. */
const char* lastError();

}  // namespace net

}  // namespace substation
