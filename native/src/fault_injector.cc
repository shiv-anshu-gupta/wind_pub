/**
 * @file fault_injector.cc
 * @brief Fault Injection Implementation for Subscriber Stress Testing
 *
 * Core logic:
 *   process()          — per-packet decision (drop / duplicate / corrupt / normal)
 *   applyCorruption()  — modify scratch-buffer copy (never the original frame)
 *   findBerTag()       — locate ASN.1 BER tags inside the APDU
 *   isInterrupted()    — stream-level interruption window
 *   getExtraDelayUs()  — timing faults (jitter + fixed delay)
 */

#include "../include/fault_injector.h"
#include <cstdio>
#include <cstring>
#include <algorithm>

/*============================================================================
 * Constructor
 *============================================================================*/

FaultInjector::FaultInjector()
{
    memset(&m_cfg, 0, sizeof(m_cfg));
}

/*============================================================================
 * Config access (thread-safe)
 *============================================================================*/

void FaultInjector::setConfig(const FaultInjectorConfig& cfg)
{
    std::lock_guard<std::mutex> lock(m_mutex);
    m_cfg = cfg;
    m_enabled.store(cfg.enabled, std::memory_order_release);

    if (cfg.enabled) {
        printf("[fault-inject] ENABLED: loss=%.1f%% dup=%.1f%% smpCnt=%.1f%% "
               "values=%.1f%% ber=%.1f%% jitter=%u us\n",
               cfg.packetLossRate * 100.0,
               cfg.duplicateRate * 100.0,
               cfg.corruptSmpCntRate * 100.0,
               cfg.corruptValuesRate * 100.0,
               cfg.corruptBerRate * 100.0,
               cfg.jitterMaxUs);
        if (cfg.burstLossCount > 0 && cfg.burstLossIntervalSec > 0) {
            printf("[fault-inject] burst: drop %u pkts every %u sec\n",
                   cfg.burstLossCount, cfg.burstLossIntervalSec);
        }
        if (cfg.streamInterruption) {
            printf("[fault-inject] interruption: %u sec every %u sec\n",
                   cfg.interruptDurationSec, cfg.interruptIntervalSec);
        }
        if (cfg.reorderRate > 0.0 && cfg.reorderSamplesAfter > 0) {
            printf("[fault-inject] reorder: %.1f%% chance, release after %u samples\n",
                   cfg.reorderRate * 100.0, cfg.reorderSamplesAfter);
        }
    } else {
        printf("[fault-inject] DISABLED\n");
    }
}

FaultInjectorConfig FaultInjector::getConfig() const
{
    std::lock_guard<std::mutex> lock(m_mutex);
    return m_cfg;
}

/*============================================================================
 * Stats
 *============================================================================*/

FaultInjectorStats FaultInjector::getStats() const
{
    FaultInjectorStats s;
    s.totalProcessed  = m_totalProcessed.load(std::memory_order_relaxed);
    s.dropCount       = m_dropCount.load(std::memory_order_relaxed);
    s.dupCount        = m_dupCount.load(std::memory_order_relaxed);
    s.corruptCount    = m_corruptCount.load(std::memory_order_relaxed);
    s.interruptedCount = m_interruptedCount.load(std::memory_order_relaxed);
    s.reorderCount    = m_reorderCount.load(std::memory_order_relaxed);
    return s;
}

void FaultInjector::resetStats()
{
    m_totalProcessed.store(0, std::memory_order_relaxed);
    m_dropCount.store(0, std::memory_order_relaxed);
    m_dupCount.store(0, std::memory_order_relaxed);
    m_corruptCount.store(0, std::memory_order_relaxed);
    m_interruptedCount.store(0, std::memory_order_relaxed);
    m_reorderCount.store(0, std::memory_order_relaxed);

    /* Reset burst/interruption/reorder state */
    std::lock_guard<std::mutex> lock(m_mutex);
    m_inBurst = false;
    m_burstStartPacket = 0;
    m_lastBurstTimeUs = 0;
    m_inInterruption = false;
    m_lastInterruptTimeUs = 0;
    m_heldFrameLen = 0;
    m_heldCountdown = 0;
}

/*============================================================================
 * Helpers
 *============================================================================*/

double FaultInjector::random01()
{
    return std::uniform_real_distribution<double>(0.0, 1.0)(m_rng);
}

uint64_t FaultInjector::steadyUs() const
{
    auto now = std::chrono::steady_clock::now();
    return (uint64_t)std::chrono::duration_cast<std::chrono::microseconds>(
        now.time_since_epoch()).count();
}

/*============================================================================
 * Stream Interruption Check
 *============================================================================*/

bool FaultInjector::isInterrupted()
{
    /* Fast path: if not enabled or no interruption configured, return false */
    if (!m_enabled.load(std::memory_order_relaxed)) return false;

    std::lock_guard<std::mutex> lock(m_mutex);
    if (!m_cfg.streamInterruption || m_cfg.interruptIntervalSec == 0)
        return false;

    uint64_t now = steadyUs();
    uint64_t intervalUs = (uint64_t)m_cfg.interruptIntervalSec * 1000000ULL;
    uint64_t durationUs = (uint64_t)m_cfg.interruptDurationSec * 1000000ULL;

    if (m_lastInterruptTimeUs == 0) {
        m_lastInterruptTimeUs = now;
    }

    uint64_t elapsed = now - m_lastInterruptTimeUs;

    if (m_inInterruption) {
        if (elapsed >= durationUs) {
            m_inInterruption = false;
            m_lastInterruptTimeUs = now;
            printf("[fault-inject] stream interruption ended: resuming\n");
            return false;
        }
        m_interruptedCount.fetch_add(1, std::memory_order_relaxed);
        return true;
    } else {
        if (elapsed >= intervalUs) {
            m_inInterruption = true;
            m_lastInterruptTimeUs = now;
            printf("[fault-inject] stream interruption started: %u seconds\n",
                   m_cfg.interruptDurationSec);
            m_interruptedCount.fetch_add(1, std::memory_order_relaxed);
            return true;
        }
        return false;
    }
}

/*============================================================================
 * Extra Delay (Jitter + Fixed Delay)
 *============================================================================*/

uint32_t FaultInjector::getExtraDelayUs()
{
    if (!m_enabled.load(std::memory_order_relaxed)) return 0;

    std::lock_guard<std::mutex> lock(m_mutex);
    uint32_t delay = m_cfg.fixedDelayUs;

    if (m_cfg.jitterMaxUs > 0) {
        /* Random jitter: 0 to 2*jitterMaxUs centered around jitterMaxUs */
        std::uniform_int_distribution<uint32_t> dist(0, m_cfg.jitterMaxUs * 2);
        int32_t jitter = (int32_t)dist(m_rng) - (int32_t)m_cfg.jitterMaxUs;
        if (jitter > 0)
            delay += (uint32_t)jitter;
    }

    return delay;
}

/*============================================================================
 * process() — Core per-packet decision
 *============================================================================*/

FaultInjector::Action FaultInjector::process(
    const uint8_t* framePtr, uint16_t frameLen,
    uint8_t* scratchBuf, uint16_t* scratchLen)
{
    /* Fast path when disabled — ZERO overhead */
    if (!m_enabled.load(std::memory_order_relaxed))
        return SEND_NORMAL;

    m_totalProcessed.fetch_add(1, std::memory_order_relaxed);
    uint64_t pktNum = m_totalProcessed.load(std::memory_order_relaxed);

    std::lock_guard<std::mutex> lock(m_mutex);

    /* 1. Random packet loss */
    if (m_cfg.packetLossRate > 0.0 && random01() < m_cfg.packetLossRate) {
        m_dropCount.fetch_add(1, std::memory_order_relaxed);
        return DROP;
    }

    /* 2. Burst loss */
    if (m_cfg.burstLossCount > 0 && m_cfg.burstLossIntervalSec > 0) {
        uint64_t now = steadyUs();
        uint64_t intervalUs = (uint64_t)m_cfg.burstLossIntervalSec * 1000000ULL;

        if (!m_inBurst && m_lastBurstTimeUs == 0) {
            m_lastBurstTimeUs = now;
        }

        if (!m_inBurst && (now - m_lastBurstTimeUs) >= intervalUs) {
            m_inBurst = true;
            m_burstStartPacket = pktNum;
            m_lastBurstTimeUs = now;
            printf("[fault-inject] burst loss started: dropping %u packets\n",
                   m_cfg.burstLossCount);
        }

        if (m_inBurst) {
            if (pktNum - m_burstStartPacket < m_cfg.burstLossCount) {
                m_dropCount.fetch_add(1, std::memory_order_relaxed);
                return DROP;
            }
            m_inBurst = false;
            printf("[fault-inject] burst loss ended: %u packets dropped\n",
                   m_cfg.burstLossCount);
        }
    }

    /* 3. Duplicate */
    if (m_cfg.duplicateRate > 0.0 && random01() < m_cfg.duplicateRate) {
        m_dupCount.fetch_add(1, std::memory_order_relaxed);
        return DUPLICATE;
    }

    /* 3b. Reorder / out-of-order:
     *  - If a held packet is waiting and its countdown has elapsed,
     *    release it BEFORE sending the current packet.
     *  - Otherwise, with probability reorderRate, hold the current packet
     *    (drop it for now) and schedule its release after N samples. */
    if (m_heldCountdown > 0 && m_heldFrameLen > 0) {
        m_heldCountdown--;
        if (m_heldCountdown == 0) {
            /* Release the held packet by copying it into scratch, then tell
             * the writer to send held+current. */
            memcpy(scratchBuf, m_heldFrame, m_heldFrameLen);
            *scratchLen = m_heldFrameLen;
            m_heldFrameLen = 0;
            printf("[fault-inject] reorder: releasing held packet (late)\n");
            return SEND_HELD_THEN_NORMAL;
        }
    } else if (m_cfg.reorderRate > 0.0 &&
               m_cfg.reorderSamplesAfter > 0 &&
               frameLen <= sizeof(m_heldFrame) &&
               random01() < m_cfg.reorderRate) {
        /* Hold the current packet — drop it from this slot and release later */
        memcpy(m_heldFrame, framePtr, frameLen);
        m_heldFrameLen = frameLen;
        m_heldCountdown = m_cfg.reorderSamplesAfter;
        m_reorderCount.fetch_add(1, std::memory_order_relaxed);
        printf("[fault-inject] reorder: holding packet, release after %u samples\n",
               m_cfg.reorderSamplesAfter);
        return DROP;
    }

    /* 4. Data corruption — copy to scratch, modify, return SEND_MODIFIED.
     * We check deterministically whether ANY corruption is configured;
     * the actual random per-type rolls happen inside applyCorruption(). */
    bool anyCorruptionConfigured =
        (m_cfg.corruptSmpCntRate > 0.0) ||
        (m_cfg.corruptValuesRate > 0.0) ||
        (m_cfg.wrongSmpSynchRate > 0.0) ||
        (m_cfg.corruptBerRate > 0.0) ||
        (m_cfg.corruptChannelCountRate > 0.0);

    if (anyCorruptionConfigured && frameLen <= 1600) {
        memcpy(scratchBuf, framePtr, frameLen);
        *scratchLen = frameLen;
        if (applyCorruption(scratchBuf, frameLen)) {
            m_corruptCount.fetch_add(1, std::memory_order_relaxed);
            return SEND_MODIFIED;
        }
        /* applyCorruption() rolled dice but nothing triggered — send normal */
    }

    return SEND_NORMAL;
}

/*============================================================================
 * findBerTag() — Locate an ASN.1 BER context-class tag in the APDU
 *
 * SV packet structure after Ethernet + VLAN + APPDU header:
 *   0x60 = savPdu
 *     0x80 = svID
 *     0x82 = smpCnt  (2 bytes)
 *     0x83 = confRev (4 bytes)
 *     0x85 = smpSynch (1 byte)
 *     0x87 = seqData  (N bytes, channel values)
 *
 * Returns pointer to the VALUE bytes (after tag+length), or nullptr.
 *============================================================================*/

uint8_t* FaultInjector::findBerTag(uint8_t* apdu, uint16_t apduLen,
                                    uint8_t tag, uint16_t* valueLen)
{
    uint16_t pos = 0;

    while (pos < apduLen) {
        if (pos >= apduLen) return nullptr;
        uint8_t currentTag = apdu[pos++];

        /* Parse BER length */
        if (pos >= apduLen) return nullptr;
        uint16_t len = 0;
        uint8_t lenByte = apdu[pos++];
        if (lenByte & 0x80) {
            uint8_t numLenBytes = lenByte & 0x7F;
            if (numLenBytes > 2 || pos + numLenBytes > apduLen) return nullptr;
            for (uint8_t i = 0; i < numLenBytes; i++) {
                len = (len << 8) | apdu[pos++];
            }
        } else {
            len = lenByte;
        }

        if (currentTag == tag) {
            if (valueLen) *valueLen = len;
            if (pos + len > apduLen) return nullptr;
            return &apdu[pos];
        }

        /* If this is a constructed tag (0x60 = savPdu, 0xA2 = seqOfASDU),
         * descend into it rather than skipping over it */
        if (currentTag == 0x60 || currentTag == 0xA2) {
            /* Don't skip — the children are at the current position */
            continue;
        }

        /* Skip this TLV's value */
        pos += len;
    }

    return nullptr;
}

/*============================================================================
 * applyCorruption() — Modify scratch buffer based on configured rates
 *
 * Packet layout (Ethernet + VLAN):
 *   [dst MAC 6][src MAC 6][0x8100 + VLAN 4][EtherType 2] = 18 bytes header
 *   OR without VLAN:
 *   [dst MAC 6][src MAC 6][EtherType 2] = 14 bytes header
 *
 * After Ethernet header:
 *   [appID 2][length 2][reserved 4] = 8 bytes APPDU header
 *
 * After APPDU header:
 *   APDU (ASN.1 BER encoded savPdu)
 *============================================================================*/

bool FaultInjector::applyCorruption(uint8_t* frame, uint16_t frameLen)
{
    bool modified = false;

    /* Determine Ethernet header size (check for VLAN tag 0x8100) */
    uint16_t ethHdrLen = 14;
    if (frameLen > 16 && frame[12] == 0x81 && frame[13] == 0x00) {
        ethHdrLen = 18;  /* VLAN tagged */
    }

    /* APPDU header is 8 bytes after Ethernet header */
    uint16_t appduOffset = ethHdrLen + 8;
    if (appduOffset >= frameLen) return false;

    uint8_t* apdu = frame + appduOffset;
    uint16_t apduLen = frameLen - appduOffset;

    /* --- Corrupt smpCnt (tag 0x82, 2 bytes) --- */
    if (m_cfg.corruptSmpCntRate > 0.0 && random01() < m_cfg.corruptSmpCntRate) {
        uint16_t valueLen = 0;
        uint8_t* val = findBerTag(apdu, apduLen, 0x82, &valueLen);
        if (val && valueLen == 2) {
            uint16_t garbage = (uint16_t)(random01() * 65535.0);
            val[0] = (uint8_t)(garbage >> 8);
            val[1] = (uint8_t)(garbage & 0xFF);
            modified = true;
        }
    }

    /* --- Corrupt smpSynch (tag 0x85, 1 byte) --- */
    if (m_cfg.wrongSmpSynchRate > 0.0 && random01() < m_cfg.wrongSmpSynchRate) {
        uint16_t valueLen = 0;
        uint8_t* val = findBerTag(apdu, apduLen, 0x85, &valueLen);
        if (val && valueLen >= 1) {
            val[0] ^= 0xFF;  /* flip all bits */
            modified = true;
        }
    }

    /* --- Corrupt channel values (tag 0x87 = seqData) --- */
    if (m_cfg.corruptValuesRate > 0.0 && random01() < m_cfg.corruptValuesRate) {
        uint16_t valueLen = 0;
        uint8_t* val = findBerTag(apdu, apduLen, 0x87, &valueLen);
        if (val && valueLen >= 4) {
            /* Pick a random 4-byte int32 channel value and corrupt it */
            uint16_t numChannels = valueLen / 4;
            uint16_t idx = (uint16_t)(random01() * (double)numChannels);
            if (idx >= numChannels) idx = numChannels - 1;
            uint32_t garbage = (uint32_t)(random01() * 4294967295.0);
            uint16_t off = idx * 4;
            val[off + 0] = (uint8_t)(garbage >> 24);
            val[off + 1] = (uint8_t)(garbage >> 16);
            val[off + 2] = (uint8_t)(garbage >> 8);
            val[off + 3] = (uint8_t)(garbage & 0xFF);
            modified = true;
        }
    }

    /* --- Corrupt channel count (modify seqData length) --- */
    if (m_cfg.corruptChannelCountRate > 0.0 && random01() < m_cfg.corruptChannelCountRate) {
        /* Find the seqData tag (0x87) and modify its BER length byte
         * to make the subscriber see a wrong number of channels.
         * We reduce the length by 4 or 8 bytes (remove 1-2 channels). */
        uint16_t pos = 0;
        while (pos < apduLen) {
            uint8_t currentTag = apdu[pos++];
            if (pos >= apduLen) break;
            uint8_t lenByte = apdu[pos];
            if (currentTag == 0x87) {
                /* Simple case: single-byte length */
                if (!(lenByte & 0x80) && lenByte >= 8) {
                    apdu[pos] = lenByte - 4;  /* remove one channel */
                    modified = true;
                }
                break;
            }
            /* Parse length and skip */
            uint16_t len = 0;
            if (lenByte & 0x80) {
                uint8_t n = lenByte & 0x7F;
                pos++;
                for (uint8_t i = 0; i < n && pos < apduLen; i++)
                    len = (len << 8) | apdu[pos++];
            } else {
                len = lenByte;
                pos++;
            }
            if (currentTag == 0x60 || currentTag == 0xA2) continue;
            pos += len;
        }
    }

    /* --- Corrupt random BER byte --- */
    if (m_cfg.corruptBerRate > 0.0 && random01() < m_cfg.corruptBerRate) {
        if (apduLen > 2) {
            uint16_t idx = (uint16_t)(random01() * (double)(apduLen - 1)) + 1;
            apdu[idx] ^= (uint8_t)(1 << (int)(random01() * 8.0));
            modified = true;
        }
    }

    return modified;
}
