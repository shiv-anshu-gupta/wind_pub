/**
 * @file sv_publisher_instance.cc
 * @brief Implementation of SvPublisherInstance
 *
 * Each instance represents one Merging Unit. It owns its config,
 * equations, and pre-built frame cache (internal buffer).
 *
 * The prebuildFrames() method is the key operation:
 *   1. Configure the encoder with this publisher's settings
 *   2. For each sample in one AC cycle:
 *      - Generate waveform values from equations
 *      - Encode a complete SV Ethernet frame
 *      - Store in internal buffer
 *   3. Mark state as READY
 *
 * After prebuild, the PublisherController merges all publishers' frames
 * into a SharedBuffer for transmission.
 */

#include "../include/sv_publisher_instance.h"
#include "../include/sv_encoder.h"
#include "../include/cid_generator.h"

#include <cstdio>
#include <cstring>
#include <cmath>
#include <new>

/*============================================================================
 * Constructor / Destructor
 *============================================================================*/

SvPublisherInstance::SvPublisherInstance(uint32_t id)
    : m_id(id)
    , m_state(IDLE)
    , m_config{}
    , m_eqProcessor(50.0, 4800)
    , m_frameData(nullptr)
    , m_frames(nullptr)
    , m_frameLens(nullptr)
    , m_frameCount(0)
    , m_frameCapacity(0)
{
    m_errorBuf[0] = '\0';

    /* Sensible defaults */
    strncpy(m_config.svID, "MU01", sizeof(m_config.svID) - 1);
    m_config.appID         = 0x4000;
    m_config.confRev       = 1;
    m_config.smpSynch      = 0;
    m_config.vlanPriority  = 4;
    m_config.vlanID        = 0;
    m_config.sampleRate    = 4000;
    m_config.frequency     = 50.0;
    m_config.voltageAmplitude = 325.0;
    m_config.currentAmplitude = 100.0;
    m_config.asduCount     = 1;
    m_config.channelCount  = 8;

    /* Default destination MAC: IEC 61850 SV multicast
     * Per IEC 61850-8-1 §C.2: 01:0C:CD:04:xx:xx derived from APPID */
    m_config.dstMAC[0] = 0x01; m_config.dstMAC[1] = 0x0C;
    m_config.dstMAC[2] = 0xCD; m_config.dstMAC[3] = 0x04;
    m_config.dstMAC[4] = (uint8_t)((m_config.appID >> 8) & 0xFF);
    m_config.dstMAC[5] = (uint8_t)(m_config.appID & 0xFF);
}

SvPublisherInstance::~SvPublisherInstance()
{
    freeFrameCache();
}

/*============================================================================
 * Accessors
 *============================================================================*/

uint8_t* SvPublisherInstance::getFrame(int idx) const
{
    if (idx >= 0 && idx < m_frameCount && m_frames)
        return m_frames[idx];
    return nullptr;
}

size_t SvPublisherInstance::getFrameLen(int idx) const
{
    if (idx >= 0 && idx < m_frameCount && m_frameLens)
        return m_frameLens[idx];
    return 0;
}

uint64_t SvPublisherInstance::getPacketsPerSec() const
{
    if (m_config.asduCount == 0) return m_config.sampleRate;
    return m_config.sampleRate / m_config.asduCount;
}

int SvPublisherInstance::getSamplesPerCycle() const
{
    if (m_config.frequency <= 0.0) return 1;
    return (int)(m_config.sampleRate / m_config.frequency);
}

/*============================================================================
 * Configuration
 *============================================================================*/

int SvPublisherInstance::configure(const PublisherConfig& config)
{
    m_config = config;

    /* Validate & clamp */
    if (m_config.channelCount < 1)  m_config.channelCount = 1;
    if (m_config.channelCount > SV_MAX_CHANNELS) m_config.channelCount = SV_MAX_CHANNELS;
    if (m_config.asduCount != 1 && m_config.asduCount != 4 && m_config.asduCount != 8)
        m_config.asduCount = 1;
    if (m_config.sampleRate == 0)   m_config.sampleRate = 4000;
    if (m_config.frequency <= 0.0)  m_config.frequency = 50.0;

    /* Auto-derive multicast destination MAC from APPID per IEC 61850-8-1 §C.2.
     * Only when MAC uses the standard SV multicast prefix 01:0C:CD:04:xx:xx.
     * If user set a completely custom MAC, leave it untouched. */
    if (m_config.dstMAC[0] == 0x01 && m_config.dstMAC[1] == 0x0C &&
        m_config.dstMAC[2] == 0xCD && m_config.dstMAC[3] == 0x04) {
        m_config.dstMAC[4] = (uint8_t)((m_config.appID >> 8) & 0xFF);
        m_config.dstMAC[5] = (uint8_t)(m_config.appID & 0xFF);
    }

    /* Update equation processor */
    m_eqProcessor.setDefaultFrequency(m_config.frequency);
    m_eqProcessor.setSampleRate((uint32_t)m_config.sampleRate);

    m_state = CONFIGURED;
    return 0;
}

int SvPublisherInstance::setEquations(const char* equations)
{
    if (!equations) {
        snprintf(m_errorBuf, sizeof(m_errorBuf),
                 "Publisher %u: null equations string", m_id);
        return -1;
    }

    m_eqProcessor.setDefaultFrequency(m_config.frequency);
    m_eqProcessor.setSampleRate((uint32_t)m_config.sampleRate);

    int result = m_eqProcessor.loadEquations(equations);
    if (result < 0) {
        snprintf(m_errorBuf, sizeof(m_errorBuf),
                 "Publisher %u: failed to parse equations", m_id);
        return -1;
    }

    /* result == count of equations successfully parsed. Zero means the input
     * was non-empty but the parser couldn't load a single channel — i.e. the
     * caller fed us garbage (wrong format, all-invalid expressions). Without
     * this guard the publisher would happily start and emit all-zero samples
     * on the wire while the UI reports success (the bug that caused
     * subscriber to display 0,0,0,0 when the equations field was JSON instead
     * of the expected pipe-delimited string). */
    if (result == 0 && equations[0] != '\0') {
        snprintf(m_errorBuf, sizeof(m_errorBuf),
                 "Publisher %u: 0 equations parsed from non-empty input — "
                 "check format (expected \"id1:eq1|id2:eq2|...\")", m_id);
        return -1;
    }

    return 0;
}

/*============================================================================
 * Frame Pre-building (fills internal buffer)
 *
 * IMPORTANT: This function uses the global sv_encoder which is mutex-
 * protected. The PublisherController calls prebuildFrames() sequentially for
 * each publisher (not in parallel), so there is no contention.
 *============================================================================*/

int SvPublisherInstance::prebuildFrames()
{
    if (m_state < CONFIGURED) {
        snprintf(m_errorBuf, sizeof(m_errorBuf),
                 "Publisher %u: not configured", m_id);
        m_state = FAILED;
        return -1;
    }

    /* IEC 61850-9-2 §7.2.3: smpCnt must count 0 to (sampleRate-1) per second.
     * We pre-build one full second of frames so smpCnt covers the complete
     * range. The waveform naturally repeats every AC cycle, but each frame
     * carries a unique smpCnt value. */
    int packetsPerSecond = (int)getPacketsPerSec();
    if (packetsPerSecond > SV_PUB_MAX_PREBUILT_FRAMES)
        packetsPerSecond = SV_PUB_MAX_PREBUILT_FRAMES;
    if (packetsPerSecond < 1) packetsPerSecond = 1;

    /* Allocate internal buffer */
    if (!allocFrameCache(packetsPerSecond)) {
        snprintf(m_errorBuf, sizeof(m_errorBuf),
                 "Publisher %u: failed to allocate %d frames (%.1f MB)",
                 m_id, packetsPerSecond,
                 (double)packetsPerSecond * SV_MAX_FRAME_SIZE / (1024.0 * 1024.0));
        m_state = FAILED;
        return -1;
    }

    /* Configure encoder for THIS publisher's settings */
    SvEncoderConfig enc = {};
    snprintf(enc.svID, sizeof(enc.svID), "%s", m_config.svID);
    enc.appID        = m_config.appID;
    enc.confRev      = m_config.confRev;
    enc.smpSynch     = m_config.smpSynch;
    memcpy(enc.srcMAC, m_config.srcMAC, 6);
    memcpy(enc.dstMAC, m_config.dstMAC, 6);
    enc.vlanPriority = m_config.vlanPriority;
    enc.vlanID       = m_config.vlanID;
    enc.asduCount    = m_config.asduCount;
    enc.channelCount = m_config.channelCount;
    sv_encoder_set_config(&enc);

    /* Build frames for the full second.
     *
     * Two paths:
     *  • asduCount == 1: one sample → one frame via encode_packet
     *  • asduCount  > 1: asduCount samples packed into one frame via
     *    encode_multi_asdu. Without this branch, noASDU=8 configs would
     *    silently emit noASDU=1 on the wire and the receiver would see
     *    only 1/8 of the expected samples. */
    m_frameCount = packetsPerSecond;
    if (m_config.asduCount == 1) {
        for (int i = 0; i < packetsPerSecond; i++) {
            const double t = (double)i / (double)m_config.sampleRate;
            int32_t samples[SV_MAX_CHANNELS] = {0};

            m_eqProcessor.generate9_2LESamples(t, samples, m_config.channelCount);

            size_t size = SV_MAX_FRAME_SIZE;
            int ret = sv_encoder_encode_packet(
                (uint32_t)i, samples, m_frames[i], &size);
            if (ret != 0) {
                snprintf(m_errorBuf, sizeof(m_errorBuf),
                         "Publisher %u: encode failed at sample %d", m_id, i);
                m_state = FAILED;
                return -1;
            }
            m_frameLens[i] = size;
        }
    } else {
        const uint8_t N = m_config.asduCount;
        for (int i = 0; i < packetsPerSecond; i++) {
            int32_t        scratch[8][SV_MAX_CHANNELS] = {{0}};
            const int32_t* samples_idx[8] = {nullptr};

            for (uint8_t a = 0; a < N; a++) {
                const uint32_t smp = (uint32_t)i * N + a;
                const double t = (double)smp / (double)m_config.sampleRate;
                m_eqProcessor.generate9_2LESamples(
                    t, scratch[a], m_config.channelCount);
                samples_idx[a] = scratch[a];
            }

            size_t size = SV_MAX_FRAME_SIZE;
            int ret = sv_encoder_encode_multi_asdu(
                (uint32_t)i * N, samples_idx, m_frames[i], &size);
            if (ret != 0) {
                snprintf(m_errorBuf, sizeof(m_errorBuf),
                         "Publisher %u: multi-ASDU encode failed at packet %d",
                         m_id, i);
                m_state = FAILED;
                return -1;
            }
            m_frameLens[i] = size;
        }
    }

    m_state = READY;
    return 0;
}

/*============================================================================
 * Live re-encode — Phase 2 of the SPSC integration
 *
 * Called by the writer thread for streams whose source == External, ONCE per
 * scheduled frame, right before that frame is handed to the NIC. Pulls live
 * values from SpscBridge::sampleAt() (boxcar M:N decimation in there) and
 * rewrites m_frames[frameIdx] in place.
 *
 * Per-frame cost
 * --------------
 * One full encode (~few µs on modern x86). Equation streams skip this entirely
 * — their pre-built bytes are sent untouched. So the regression risk for the
 * existing fast path is zero.
 *
 * Multi-channel mapping
 * ---------------------
 * Phase 2 simplification: ONE SPSC value per stream, replicated across all
 * configured channels. If teammate needs distinct values per channel, they
 * configure one stream per channel. A future enhancement can wire per-channel
 * pushes through SpscMessage.channelIndex without changing the writer thread.
 *
 * Scaling
 * -------
 * Per IEC 61850-9-2 LE profile:
 *   currents (TCTR, channelTypes[i]==0): magnitude * 1000  (1 mA per count)
 *   voltages (TVTR, channelTypes[i]==1): magnitude *  100  (10 mV per count)
 *============================================================================*/

void SvPublisherInstance::setLiveValue(uint8_t channel, float magnitude,
                                       uint16_t quality)
{
    if (channel >= m_config.channelCount || channel >= SV_MAX_CHANNELS) return;

    /* TVTR (voltage) scales ×100, everything else (TCTR current) ×1000. */
    const double scale  = (m_config.channelTypes[channel] == 1) ? 100.0 : 1000.0;
    const double scaled = (double)magnitude * scale;

    int32_t v;
    if      (scaled >=  2147483647.0) v =  2147483647;
    else if (scaled <= -2147483648.0) v = -2147483647 - 1;
    else                              v = (int32_t)llround(scaled);

    m_liveValue[channel].store(v, std::memory_order_relaxed);
    m_liveQuality[channel].store(quality, std::memory_order_relaxed);
}

int SvPublisherInstance::reencodeFrame(int frameIdx, uint64_t now_ns)
{
    if (m_state != READY) return -1;
    if (frameIdx < 0 || frameIdx >= m_frameCount) return -1;
    if (m_source != SourceMode::External) return -1;

    /* Pull the latest wire-ready value for each channel from the live store,
     * fed by setLiveValue() from the SubstationKit ingest worker. No SPSC
     * bridge here — that is reserved for GOOSE. Equation-mode streams never
     * reach this function (guarded above), so this path is fully isolated. */
    auto fetchScaled = [&](uint64_t /*t_ns*/, int32_t* outChannels) {
        for (uint8_t c = 0; c < m_config.channelCount; ++c)
            outChannels[c] = m_liveValue[c].load(std::memory_order_relaxed);
    };

    /* Reconfigure the encoder for this publisher (sv_encoder_set_config is a
     * thread-singleton — we set it every call because another publisher's
     * writer might have set it in between). */
    SvEncoderConfig enc = {};
    snprintf(enc.svID, sizeof(enc.svID), "%s", m_config.svID);
    enc.appID        = m_config.appID;
    enc.confRev      = m_config.confRev;
    enc.smpSynch     = m_config.smpSynch;
    memcpy(enc.srcMAC, m_config.srcMAC, 6);
    memcpy(enc.dstMAC, m_config.dstMAC, 6);
    enc.vlanPriority = m_config.vlanPriority;
    enc.vlanID       = m_config.vlanID;
    enc.asduCount    = m_config.asduCount;
    enc.channelCount = m_config.channelCount;
    sv_encoder_set_config(&enc);

    if (m_config.asduCount == 1) {
        int32_t samples[SV_MAX_CHANNELS] = {0};
        fetchScaled(now_ns, samples);

        size_t size = SV_MAX_FRAME_SIZE;
        int ret = sv_encoder_encode_packet(
            static_cast<uint32_t>(frameIdx), samples, m_frames[frameIdx], &size);
        if (ret != 0) return -1;
        m_frameLens[frameIdx] = size;
        return 0;
    }

    /* Multi-ASDU: N samples in one frame, each at its own staggered time. */
    const uint8_t  N = m_config.asduCount;
    int32_t        scratch[8][SV_MAX_CHANNELS]   = {{0}};
    const int32_t* samples_idx[8]                = {nullptr};

    for (uint8_t a = 0; a < N; ++a) {
        fetchScaled(now_ns, scratch[a]);
        samples_idx[a] = scratch[a];
    }

    size_t size = SV_MAX_FRAME_SIZE;
    int ret = sv_encoder_encode_multi_asdu(
        static_cast<uint32_t>(frameIdx) * N,
        samples_idx, m_frames[frameIdx], &size);
    if (ret != 0) return -1;
    m_frameLens[frameIdx] = size;
    return 0;
}

/*============================================================================
 * Internal Buffer Management
 *============================================================================*/

bool SvPublisherInstance::allocFrameCache(int count)
{
    freeFrameCache();

    // Single contiguous allocation for all frames — eliminates heap
    // fragmentation and TLB misses from 4000+ scattered allocs
    m_frameData = new (std::nothrow) uint8_t[(size_t)count * SV_MAX_FRAME_SIZE];
    if (!m_frameData) return false;

    m_frames = new (std::nothrow) uint8_t*[count];
    if (!m_frames) {
        delete[] m_frameData; m_frameData = nullptr;
        return false;
    }

    m_frameLens = new (std::nothrow) size_t[count];
    if (!m_frameLens) {
        delete[] m_frameData; m_frameData = nullptr;
        delete[] m_frames;    m_frames = nullptr;
        return false;
    }

    for (int i = 0; i < count; i++)
        m_frames[i] = m_frameData + (size_t)i * SV_MAX_FRAME_SIZE;

    m_frameCapacity = count;
    return true;
}

void SvPublisherInstance::freeFrameCache()
{
    delete[] m_frameData;
    m_frameData = nullptr;
    delete[] m_frames;
    m_frames = nullptr;
    delete[] m_frameLens;
    m_frameLens = nullptr;
    m_frameCount    = 0;
    m_frameCapacity = 0;
}

/*============================================================================
 * Frame inspection — used by the FrameViewer UI over WebSocket.
 *
 * getSampleFrame() encodes a fresh frame at the requested smpCnt using this
 * instance's config + equations. It does NOT require the publisher to be
 * running — it's a stateless "what would this publisher emit at smpCnt N?"
 * peek. The computed sample values are cached in m_channelValues so an
 * immediately-following getCurrentChannelValues() can return them.
 *
 * Both methods run on the uWS event-loop thread (single-threaded) so the
 * value cache needs no lock.
 *============================================================================*/

int SvPublisherInstance::getSampleFrame(uint8_t* outBuffer, size_t bufferSize,
                                       size_t* outFrameSize, uint32_t smpCnt)
{
    if (!outBuffer || !outFrameSize || bufferSize < 64) return -1;

    SvEncoderConfig enc = {};
    snprintf(enc.svID, sizeof(enc.svID), "%s", m_config.svID);
    enc.appID        = m_config.appID;
    enc.confRev      = m_config.confRev;
    enc.smpSynch     = m_config.smpSynch;
    memcpy(enc.srcMAC, m_config.srcMAC, 6);
    memcpy(enc.dstMAC, m_config.dstMAC, 6);
    enc.vlanPriority = m_config.vlanPriority;
    enc.vlanID       = m_config.vlanID;
    enc.asduCount    = 1;
    enc.channelCount = m_config.channelCount;
    sv_encoder_set_config(&enc);

    int32_t samples[SV_MAX_CHANNELS] = {0};
    const double t = static_cast<double>(smpCnt) /
                     static_cast<double>(m_config.sampleRate);
    m_eqProcessor.generate9_2LESamples(t, samples, m_config.channelCount);

    *outFrameSize = bufferSize;
    int rc = sv_encoder_encode_packet(smpCnt, samples, outBuffer, outFrameSize);

    /* Cache the samples for the paired getCurrentChannelValues() call. */
    m_channelValueCount = m_config.channelCount;
    memcpy(m_channelValues, samples, m_channelValueCount * sizeof(int32_t));
    /* If the publisher isn't running, expose this peeked smpCnt so the UI
     * "currentSmpCnt" stays in sync with the previewed frame. */
    if (m_state != READY || m_currentSmpCnt.load(std::memory_order_relaxed) == 0)
        m_currentSmpCnt.store(smpCnt, std::memory_order_relaxed);

    return rc;
}

int SvPublisherInstance::getCurrentChannelValues(int32_t* outValues, int maxValues) const
{
    if (!outValues || maxValues <= 0) return -1;
    int n = m_channelValueCount;
    if (n > maxValues) n = maxValues;
    memcpy(outValues, m_channelValues, n * sizeof(int32_t));
    return n;
}

int SvPublisherInstance::exportCid(const char* output_path) const
{
    if (!output_path) return -1;
    /* sv_cid_export takes a non-const pointer in its C signature but does not
     * mutate the config — cast away const safely. */
    return sv_cid_export(const_cast<PublisherConfig*>(&m_config), output_path);
}
