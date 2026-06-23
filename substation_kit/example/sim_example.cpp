/**
 * @file sim_example.cpp
 * @brief Minimal Shivani-side substation simulator using SubstationKit.
 *
 * Equation-driven SV: she configures a publisher and gives it waveform
 * equations; the publisher backend generates the samples, schedules them
 * through the SharedBuffer, and the writer thread transmits them.
 *
 *   net::open -> publisher::add/configure/setEquations/start
 *             -> (writer thread -> SharedBuffer -> pcap -> wire)
 *             -> publisher::stop
 *
 * SV comes from formulas (no MPMC funnel, no SPSC for SV). GOOSE is separate:
 * goose::configureTx/setValue/startTx drives breaker booleans through the
 * publisher's GooseTxScheduler (the only user of the internal SPSC bridge).
 *
 * Build: see ../README.md.  Needs raw-socket caps:
 *     sudo setcap cap_net_raw,cap_net_admin+eip ./substation_kit_example
 */
#include <SubstationKit.h>

#include <chrono>
#include <cstdio>
#include <cstring>
#include <thread>

int main()
{
    const char* IFACE = "lo";   /* loopback for the demo; use your real NIC */

    uint8_t src[6]      = {0x00, 0xAA, 0xBB, 0x00, 0x00, 0x01};
    uint8_t svDst[6]    = {0x01, 0x0C, 0xCD, 0x04, 0x00, 0x01}; /* SV multicast    */
    uint8_t gooseDst[6] = {0x01, 0x0C, 0xCD, 0x01, 0x00, 0x01}; /* GOOSE multicast */

    /* ── 1. Open the raw TX socket ─────────────────────────────────────── */
    if (substation::net::open(IFACE) != 0) {
        std::fprintf(stderr, "net::open(%s) failed: %s (need cap_net_raw)\n",
                     IFACE, substation::net::lastError());
        return 1;
    }

    /* ── 2. Configure an SV stream ─────────────────────────────────────── */
    uint32_t id = substation::publisher::add();
    substation::publisher::Config pc{};
    std::snprintf(pc.svID, sizeof(pc.svID), "MU01");
    pc.appID        = 0x4000;
    pc.confRev      = 1;
    pc.smpSynch     = 2;
    std::memcpy(pc.srcMAC, src,   6);
    std::memcpy(pc.dstMAC, svDst, 6);
    pc.vlanPriority = 4;
    pc.vlanID       = 0;
    pc.sampleRate   = 4800;
    pc.frequency    = 50.0;
    pc.asduCount    = 1;
    pc.channelCount = 4;
    pc.channelTypes[0] = 0; pc.channelTypes[1] = 0;   /* currents */
    pc.channelTypes[2] = 0; pc.channelTypes[3] = 1;   /* ch3 voltage */
    substation::publisher::configure(id, pc);

    /* ── 3. Define the SV waveform by equation ─────────────────────────── */
    substation::publisher::setEquations(id,
        "Ia:100*sin(2*PI*50*t)"
        "|Ib:100*sin(2*PI*50*t-2*PI/3)"
        "|Ic:100*sin(2*PI*50*t+2*PI/3)"
        "|In:0");

    /* ── 4. Configure a GOOSE breaker stream ───────────────────────────── */
    const uint16_t gooseId = 100;
    substation::goose::EncoderConfig gcfg{};
    std::memcpy(gcfg.srcMAC, src,      6);
    std::memcpy(gcfg.dstMAC, gooseDst, 6);
    gcfg.vlanID       = -1;
    gcfg.vlanPriority = 4;
    gcfg.appID        = 0x0001;
    gcfg.confRev      = 1;
    gcfg.test         = 0;
    gcfg.ndsCom       = 0;
    std::snprintf(gcfg.gocbRef, sizeof(gcfg.gocbRef), "BAY1/LLN0$GO$gcb01");
    std::snprintf(gcfg.datSet,  sizeof(gcfg.datSet),  "BAY1/LLN0$Dataset1");
    std::snprintf(gcfg.goID,    sizeof(gcfg.goID),    "Bay1_Breaker_Pos");
    substation::goose::configureTx(gooseId, gcfg);
    substation::goose::setValue(gooseId, true);   /* initial state before startTx */

    /* ── 5. Start SV writer + GOOSE scheduler ──────────────────────────── */
    if (substation::publisher::start() != 0) {
        std::fprintf(stderr, "publisher::start failed: %s\n",
                     substation::publisher::lastError());
        substation::net::close();
        return 1;
    }
    substation::goose::startTx(gooseId, /*heartbeatMs*/ 200, /*firstRetxMs*/ 2);
    substation::goose::rxStart(IFACE);
    substation::goose::rxRegister(gcfg.gocbRef, gooseId);
    std::printf("started: equation SV id=%u + GOOSE stream %u\n", id, gooseId);

    /* ── 6. Toggle the breaker a few times ─────────────────────────────── */
    for (int i = 0; i < 4; ++i) {
        std::this_thread::sleep_for(std::chrono::milliseconds(200));
        bool closed = (i % 2 != 0);
        substation::goose::setValue(gooseId, closed);
        std::printf("  breaker -> %s\n", closed ? "CLOSED" : "OPEN");
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(200));

    uint64_t txSent = 0, txFailed = 0, rxSeen = 0, rxPushed = 0;
    substation::goose::getStats(gooseId, &txSent, &txFailed, &rxSeen, &rxPushed);
    std::printf("goose: txSent=%lu rxSeen=%lu rxPushed=%lu\n",
                (unsigned long)txSent, (unsigned long)rxSeen, (unsigned long)rxPushed);

    /* ── 7. Clean shutdown ─────────────────────────────────────────────── */
    substation::goose::rxStop();
    substation::goose::stopAllTx();
    substation::publisher::stop();
    substation::publisher::reset();
    substation::net::close();
    std::printf("shut down — bye\n");
    return 0;
}
