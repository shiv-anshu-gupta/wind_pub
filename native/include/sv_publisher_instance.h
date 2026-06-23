/**
 * @file sv_publisher_instance.h
 * @brief Single SV Publisher Instance (one Merging Unit)
 *
 * Each SvPublisherInstance represents one simulated Merging Unit with:
 *   - Its own configuration (svID, appID, MAC, channels, sample rate)
 *   - Its own EquationProcessor (generates waveform samples)
 *   - Its own internal buffer (pre-built frames for one AC cycle)
 *
 * Architecture:
 *   PublisherController creates multiple SvPublisherInstance objects.
 *   Each instance pre-builds its frames. The controller then merges
 *   all frames into a SharedBuffer for transmission.
 *
 *   ┌─────────────────────┐
 *   │  SvPublisherInstance │
 *   │  ┌───────────────┐  │
 *   │  │EquationProc.  │──┼──→ Internal Buffer (pre-built frames)
 *   │  │(own instance) │  │         │
 *   │  └───────────────┘  │         ▼
 *   │  Config: svID, etc. │    SharedBuffer (merged schedule)
 *   └─────────────────────┘         │
 *                                   ▼
 *                              npcap writer
 */

#ifndef SV_PUBLISHER_INSTANCE_H
#define SV_PUBLISHER_INSTANCE_H

#include "sv_encoder.h"
#include "equation_processor.h"

#include <atomic>
#include <cstdint>
#include <cstddef>
#include <cstdio>
#include <cstring>
#include <new>

#define SV_PUB_MAX_PREBUILT_FRAMES 65536

/*============================================================================
 * Publisher Configuration — all settings for one Merging Unit
 *============================================================================*/

struct PublisherConfig {
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
    uint8_t  channelCount;   /* 1-20 */
    uint8_t  channelTypes[20]; /* per-channel type: 0=current(TCTR), 1=voltage(TVTR) */
};

/*============================================================================
 * SvPublisherInstance Class
 *============================================================================*/

class SvPublisherInstance {
public:
    enum State { IDLE, CONFIGURED, READY, FAILED };

    /** Where this stream's sample values come from.
     *   Equation — existing path: evaluate the user's formula at each smpCnt
     *              during prebuildFrames(). Bytes baked once, replayed forever.
     *   External — new path: bytes are still baked at prebuild but get
     *              REWRITTEN at TX time using values pulled from the SPSC
     *              bridge. Slower per frame but supports live data. */
    enum class SourceMode { Equation, External };

    /** Wire protocol for this stream.
     *   SV    — IEC 61850-9-2 Sampled Values (existing).
     *   GOOSE — IEC 61850-8-1 boolean state (added in Phase 3). */
    enum class Protocol   { SV, GOOSE };

    explicit SvPublisherInstance(uint32_t id);
    ~SvPublisherInstance();

    /* Non-copyable */
    SvPublisherInstance(const SvPublisherInstance&) = delete;
    SvPublisherInstance& operator=(const SvPublisherInstance&) = delete;

    /*--- Configuration ---*/
    int configure(const PublisherConfig& config);
    int setEquations(const char* equations);

    /** Set source mode for this stream. Default is Equation. Calling with
     *  External does NOT alter pre-built frames; it only flips a flag that
     *  the writer thread checks each cycle. */
    void setSourceMode(SourceMode mode) { m_source   = mode; }
    void setProtocol  (Protocol   p)    { m_protocol = p;    }

    SourceMode sourceMode() const { return m_source;   }
    Protocol   protocol()   const { return m_protocol; }

    /*--- Frame building (fills internal buffer) ---*/
    int prebuildFrames();

    /** Re-encode frame `frameIdx` in place using live values pulled from the
     *  SPSC bridge. Called by the writer thread before TX for External-source
     *  streams only. Returns 0 on success, -1 on error.
     *
     *  - For asduCount==1: one sample per call, smpCnt = frameIdx
     *  - For asduCount>1 : N samples packed in one frame, base smpCnt = frameIdx * N
     *
     *  The result is written into m_frames[frameIdx]; m_frameLens[frameIdx]
     *  is updated. Same buffer as before — no allocation. */
    int reencodeFrame(int frameIdx, uint64_t now_ns);

    /*--- Live-value injection (External source, SharedBuffer path) ---
     * Feeds one channel's current value for an External-mode publisher. The
     * value is in physical units (A for currents, V for voltages); IEC
     * 61850-9-2 LE scaling (×1000 current / ×100 voltage, per channelTypes)
     * is applied here so reencodeFrame() can read the wire-ready int32.
     *
     * Thread-safety: the store is a per-channel atomic, written by the
     * SubstationKit ingest worker and read by the writer thread in
     * reencodeFrame() — no lock needed. `quality` is stored for forward-
     * compatibility; the SV encoder currently emits fixed Good quality. */
    void setLiveValue(uint8_t channel, float magnitude, uint16_t quality = 0);

    /*--- Accessors ---*/
    uint32_t             getId()        const { return m_id; }
    State                getState()     const { return m_state; }
    const PublisherConfig& getConfig()  const { return m_config; }
    const char*          getLastError() const { return m_errorBuf; }

    int      getFrameCount()          const { return m_frameCount; }
    uint8_t* getFrame(int idx)        const;
    size_t   getFrameLen(int idx)     const;
    uint64_t getPacketsPerSec()       const;
    int      getSamplesPerCycle()     const;

    /*--- Frame inspection (used by FrameViewer over WebSocket) ---
     * Both methods are called from the single uWS event-loop thread, so the
     * channel-values buffer needs no lock. m_currentSmpCnt is the only piece
     * of state crossing threads (writer thread sets it as frames go out). */
    int      getSampleFrame(uint8_t* outBuffer, size_t bufferSize,
                            size_t* outFrameSize, uint32_t smpCnt);
    int      getCurrentChannelValues(int32_t* outValues, int maxValues) const;
    uint32_t getCurrentSmpCnt() const { return m_currentSmpCnt.load(std::memory_order_relaxed); }
    void     setCurrentSmpCnt(uint32_t v) { m_currentSmpCnt.store(v, std::memory_order_relaxed); }

    /*--- CID export — uses this instance's PublisherConfig. */
    int      exportCid(const char* output_path) const;

private:
    uint32_t           m_id;
    State              m_state;
    PublisherConfig    m_config;
    EquationProcessor  m_eqProcessor;

    /* New: source + protocol selectors. Defaults preserve existing behavior. */
    SourceMode         m_source   = SourceMode::Equation;
    Protocol           m_protocol = Protocol::SV;

    /* Internal buffer — pre-built frames for one AC cycle */
    uint8_t*  m_frameData;    // flat contiguous buffer: capacity * SV_MAX_FRAME_SIZE
    uint8_t** m_frames;       // array of pointers into m_frameData
    size_t*   m_frameLens;
    int       m_frameCount;
    int       m_frameCapacity;

    /* Frame-inspection state.
     *  - m_channelValues: last samples computed by getSampleFrame(). Touched
     *    only from the WS thread → no lock.
     *  - m_currentSmpCnt: live smpCnt of the most recent frame transmitted.
     *    Writer thread sets it; WS thread reads it → atomic. */
    int32_t  m_channelValues[20] = {0};
    uint8_t  m_channelValueCount = 0;
    std::atomic<uint32_t> m_currentSmpCnt{0};

    /* Live-value store for External (live-fed) streams. Written by the
     * SubstationKit ingest worker via setLiveValue(), read by the writer
     * thread in reencodeFrame(). Per-channel atomics — no lock. Values are
     * pre-scaled to wire units; quality is reserved (encoder emits Good). */
    std::atomic<int32_t>  m_liveValue[SV_MAX_CHANNELS]   = {};
    std::atomic<uint16_t> m_liveQuality[SV_MAX_CHANNELS] = {};

    char m_errorBuf[256];

    bool allocFrameCache(int count);
    void freeFrameCache();
};

#endif /* SV_PUBLISHER_INSTANCE_H */
