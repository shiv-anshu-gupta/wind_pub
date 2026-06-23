/**
 * @file SvEncoder.cc
 * @brief IEC 61850-9-2LE Sampled Values Packet Encoder
 * 
 * This module encodes SV packets according to the IEC 61850-9-2LE standard.
 * 
 * Packet Structure:
 *   - Ethernet Header (14 bytes, +4 with VLAN)
 *   - SV Header: AppID(2) + Length(2) + Reserved(4) = 8 bytes
 *   - savPdu: ASN.1 BER encoded payload
 *     - noASDU: Number of ASDUs
 *     - seqASDU: Sequence of ASDU blocks
 *       - ASDU: svID, smpCnt, confRev, smpSynch, seqData
 * 
 * All ASN.1 BER length fields use long-form encoding (0x82 = 2-byte length)
 * to support up to 20 channels without overflow.
 *   APDU Length = savPduLen + 12 (tag(1) + 0x82(1) + len(2) + header(8))
 */

#include "../include/sv_encoder.h"
#include <cstdio>
#include <cstring>
#include <mutex>

/*============================================================================
 * Module State
 *============================================================================*/

static SvEncoderConfig g_config;  // channelCount defaults to 8 in sv_encoder_set_config if 0
static std::mutex g_mutex;
static bool g_debug_printed = false;

/*============================================================================
 * Configuration
 *============================================================================*/

extern "C" {

void sv_encoder_set_config(const SvEncoderConfig* config) {
    std::lock_guard<std::mutex> lock(g_mutex);
    
    memcpy(&g_config, config, sizeof(SvEncoderConfig));
    g_config.svID[sizeof(g_config.svID) - 1] = '\0';
    // Validate channel count (1-20)
    if (g_config.channelCount < 1 || g_config.channelCount > SV_MAX_CHANNELS) {
        g_config.channelCount = 8;  // Default to 8
    }
    g_debug_printed = false;
    
    printf("[encoder] Config: svID='%s', appID=0x%04X, ASDUs=%d, channels=%d\n",
           config->svID, config->appID, config->asduCount, g_config.channelCount);
}

void sv_encoder_get_config(SvEncoderConfig* config) {
    std::lock_guard<std::mutex> lock(g_mutex);
    memcpy(config, &g_config, sizeof(SvEncoderConfig));
}

/*============================================================================
 * Single ASDU Encoder
 * 
 * Encodes one ASDU per packet. Used for standard 4000/4800 Hz rates.
 *============================================================================*/

int sv_encoder_encode_packet(
    uint32_t smpCnt,
    const int32_t* samples,
    uint8_t* buffer,
    size_t* outSize
) {
    if (!buffer || !outSize || !samples) return -1;
    
    std::lock_guard<std::mutex> lock(g_mutex);
    size_t pos = 0;
    
    /* Ethernet Header */
    memcpy(buffer + pos, g_config.dstMAC, 6); pos += 6;
    memcpy(buffer + pos, g_config.srcMAC, 6); pos += 6;
    
    /* Optional VLAN Tag (802.1Q) */
    if (g_config.vlanID > 0) {
        buffer[pos++] = 0x81;
        buffer[pos++] = 0x00;
        uint16_t vlanTag = ((g_config.vlanPriority & 0x7) << 13) | (g_config.vlanID & 0xFFF);
        buffer[pos++] = (vlanTag >> 8) & 0xFF;
        buffer[pos++] = vlanTag & 0xFF;
    }
    
    /* EtherType: SV (0x88BA) */
    buffer[pos++] = 0x88;
    buffer[pos++] = 0xBA;
    
    /* APPID */
    buffer[pos++] = (g_config.appID >> 8) & 0xFF;
    buffer[pos++] = g_config.appID & 0xFF;
    
    /* Length placeholder */
    size_t lengthPos = pos;
    buffer[pos++] = 0;
    buffer[pos++] = 0;
    
    /* Reserved (4 bytes) */
    buffer[pos++] = 0; buffer[pos++] = 0;
    buffer[pos++] = 0; buffer[pos++] = 0;
    
    /* savPdu (ASN.1 tag 0x60 = APPLICATION 0) — use BER long-form 0x82 (2-byte length) */
    buffer[pos++] = 0x60;
    size_t savPduLenPos = pos;
    buffer[pos++] = 0x82;  /* Long-form: 2 length bytes follow */
    buffer[pos++] = 0;
    buffer[pos++] = 0;
    
    /* noASDU (tag 0x80 = context [0]) */
    buffer[pos++] = 0x80;
    buffer[pos++] = 0x01;
    buffer[pos++] = 0x01;  /* 1 ASDU */
    
    /* seqASDU (tag 0xA2 = context [2] constructed) — BER long-form 0x82 */
    buffer[pos++] = 0xA2;
    size_t seqASDULenPos = pos;
    buffer[pos++] = 0x82;  /* Long-form: 2 length bytes follow */
    buffer[pos++] = 0;
    buffer[pos++] = 0;
    
    /* ASDU (tag 0x30 = SEQUENCE) — BER long-form 0x82 */
    buffer[pos++] = 0x30;
    size_t asduLenPos = pos;
    buffer[pos++] = 0x82;  /* Long-form: 2 length bytes follow */
    buffer[pos++] = 0;
    buffer[pos++] = 0;
    
    /* svID (tag 0x80 = context [0]) */
    size_t svIDLen = strlen(g_config.svID);
    if (svIDLen == 0) {
        /* Fallback to default if empty */
        buffer[pos++] = 0x80;
        buffer[pos++] = 0x04;
        memcpy(buffer + pos, "MU01", 4); pos += 4;
        svIDLen = 4;
    } else {
        buffer[pos++] = 0x80;
        buffer[pos++] = (uint8_t)svIDLen;
        memcpy(buffer + pos, g_config.svID, svIDLen); pos += svIDLen;
    }
    
    /* smpCnt (tag 0x82 = context [2]) */
    buffer[pos++] = 0x82;
    buffer[pos++] = 0x02;
    buffer[pos++] = (smpCnt >> 8) & 0xFF;
    buffer[pos++] = smpCnt & 0xFF;
    
    /* confRev (tag 0x83 = context [3]) */
    buffer[pos++] = 0x83;
    buffer[pos++] = 0x04;
    buffer[pos++] = (g_config.confRev >> 24) & 0xFF;
    buffer[pos++] = (g_config.confRev >> 16) & 0xFF;
    buffer[pos++] = (g_config.confRev >> 8) & 0xFF;
    buffer[pos++] = g_config.confRev & 0xFF;
    
    /* smpSynch (tag 0x85 = context [5]) */
    buffer[pos++] = 0x85;
    buffer[pos++] = 0x01;
    buffer[pos++] = g_config.smpSynch;
    
    /* seqData (tag 0x87 = context [7])
     * Dynamic channels: channelCount × (4 bytes value + 4 bytes quality)
     * Use BER long-form (0x81) for lengths >= 128 (i.e. >= 16 channels) */
    uint8_t channelCount = g_config.channelCount;
    size_t seqDataLen = (size_t)channelCount * 8;  // 8 bytes per channel
    buffer[pos++] = 0x87;
    if (seqDataLen < 128) {
        buffer[pos++] = (uint8_t)seqDataLen;
    } else {
        buffer[pos++] = 0x81;  /* Long-form: 1 length byte follows */
        buffer[pos++] = (uint8_t)seqDataLen;
    }
    
    for (int i = 0; i < channelCount; i++) {
        int32_t val = samples[i];
        /* Value (big-endian) */
        buffer[pos++] = (val >> 24) & 0xFF;
        buffer[pos++] = (val >> 16) & 0xFF;
        buffer[pos++] = (val >> 8) & 0xFF;
        buffer[pos++] = val & 0xFF;
        /* Quality (0x0000 = Good) */
        buffer[pos++] = 0x00;
        buffer[pos++] = 0x00;
        buffer[pos++] = 0x00;
        buffer[pos++] = 0x00;
    }
    
    /* Fill in lengths (all use BER long-form 0x82: skip 3 bytes = 0x82 + 2 len bytes) */
    size_t asduLen = pos - asduLenPos - 3;
    buffer[asduLenPos + 1] = (asduLen >> 8) & 0xFF;
    buffer[asduLenPos + 2] = asduLen & 0xFF;
    
    size_t seqASDULen = pos - seqASDULenPos - 3;
    buffer[seqASDULenPos + 1] = (seqASDULen >> 8) & 0xFF;
    buffer[seqASDULenPos + 2] = seqASDULen & 0xFF;
    
    size_t savPduLen = pos - savPduLenPos - 3;
    buffer[savPduLenPos + 1] = (savPduLen >> 8) & 0xFF;
    buffer[savPduLenPos + 2] = savPduLen & 0xFF;
    
    /* APDU Length: APPID(2)+Length(2)+Reserved(4)+tag(1)+0x82(1)+lenBytes(2) = 12 */
    size_t apduLen = savPduLen + 12;
    buffer[lengthPos] = (apduLen >> 8) & 0xFF;
    buffer[lengthPos + 1] = apduLen & 0xFF;
    
    /* Debug output (first packet only) */
    if (!g_debug_printed) {
        printf("[encoder] First packet: svID=%zu bytes, channels=%d, seqData=%zu, ASDU=%zu, APDU=%zu\n",
               svIDLen, channelCount, seqDataLen, asduLen, apduLen);
        g_debug_printed = true;
    }
    
    /* Pad to minimum Ethernet frame (60 bytes) */
    while (pos < 60) buffer[pos++] = 0;
    
    *outSize = pos;
    return 0;
}

/*============================================================================
 * Multi-ASDU Encoder
 * 
 * Encodes multiple ASDUs per packet for high-throughput applications.
 *============================================================================*/

int sv_encoder_encode_multi_asdu(
    uint32_t baseSmpCnt,
    const int32_t** samplesArray,
    uint8_t* buffer,
    size_t* outSize
) {
    if (!buffer || !outSize || !samplesArray) return -1;
    
    std::lock_guard<std::mutex> lock(g_mutex);
    size_t pos = 0;
    uint8_t asduCount = g_config.asduCount;
    
    /* Ethernet Header */
    memcpy(buffer + pos, g_config.dstMAC, 6); pos += 6;
    memcpy(buffer + pos, g_config.srcMAC, 6); pos += 6;
    
    /* Optional VLAN Tag */
    if (g_config.vlanID > 0) {
        buffer[pos++] = 0x81;
        buffer[pos++] = 0x00;
        uint16_t vlanTag = ((g_config.vlanPriority & 0x7) << 13) | (g_config.vlanID & 0xFFF);
        buffer[pos++] = (vlanTag >> 8) & 0xFF;
        buffer[pos++] = vlanTag & 0xFF;
    }
    
    /* EtherType: SV */
    buffer[pos++] = 0x88;
    buffer[pos++] = 0xBA;
    
    /* APPID */
    buffer[pos++] = (g_config.appID >> 8) & 0xFF;
    buffer[pos++] = g_config.appID & 0xFF;
    
    /* Length placeholder */
    size_t lengthPos = pos;
    buffer[pos++] = 0;
    buffer[pos++] = 0;
    
    /* Reserved */
    buffer[pos++] = 0; buffer[pos++] = 0;
    buffer[pos++] = 0; buffer[pos++] = 0;
    
    /* savPdu with 2-byte length (for larger payloads) */
    buffer[pos++] = 0x60;
    size_t savPduLenPos = pos;
    buffer[pos++] = 0x82;  /* 2-byte length follows */
    buffer[pos++] = 0;
    buffer[pos++] = 0;
    
    /* noASDU */
    buffer[pos++] = 0x80;
    buffer[pos++] = 0x01;
    buffer[pos++] = asduCount;
    
    /* seqASDU with 2-byte length */
    buffer[pos++] = 0xA2;
    size_t seqASDULenPos = pos;
    buffer[pos++] = 0x82;
    buffer[pos++] = 0;
    buffer[pos++] = 0;
    
    /* Encode each ASDU */
    for (int i = 0; i < asduCount; i++) {
        buffer[pos++] = 0x30;  /* SEQUENCE — BER long-form 0x82 */
        size_t asduLenPos = pos;
        buffer[pos++] = 0x82;  /* Long-form: 2 length bytes follow */
        buffer[pos++] = 0;
        buffer[pos++] = 0;
        
        /* svID */
        size_t svIDLen = strlen(g_config.svID);
        if (svIDLen == 0) {
            buffer[pos++] = 0x80;
            buffer[pos++] = 0x04;
            memcpy(buffer + pos, "MU01", 4); pos += 4;
        } else {
            buffer[pos++] = 0x80;
            buffer[pos++] = (uint8_t)svIDLen;
            memcpy(buffer + pos, g_config.svID, svIDLen); pos += svIDLen;
        }
        
        /* smpCnt */
        uint16_t smpCnt = (uint16_t)(baseSmpCnt + i);
        buffer[pos++] = 0x82;
        buffer[pos++] = 0x02;
        buffer[pos++] = (smpCnt >> 8) & 0xFF;
        buffer[pos++] = smpCnt & 0xFF;
        
        /* confRev */
        buffer[pos++] = 0x83;
        buffer[pos++] = 0x04;
        buffer[pos++] = (g_config.confRev >> 24) & 0xFF;
        buffer[pos++] = (g_config.confRev >> 16) & 0xFF;
        buffer[pos++] = (g_config.confRev >> 8) & 0xFF;
        buffer[pos++] = g_config.confRev & 0xFF;
        
        /* smpSynch */
        buffer[pos++] = 0x85;
        buffer[pos++] = 0x01;
        buffer[pos++] = g_config.smpSynch;
        
        /* seqData (dynamic channels) — conditional BER length */
        uint8_t channelCount = g_config.channelCount;
        size_t seqDataLen = (size_t)channelCount * 8;
        buffer[pos++] = 0x87;
        if (seqDataLen < 128) {
            buffer[pos++] = (uint8_t)seqDataLen;
        } else {
            buffer[pos++] = 0x81;  /* Long-form: 1 length byte follows */
            buffer[pos++] = (uint8_t)seqDataLen;
        }
        
        const int32_t* samples = samplesArray[i];
        for (int ch = 0; ch < channelCount; ch++) {
            int32_t val = samples[ch];
            buffer[pos++] = (val >> 24) & 0xFF;
            buffer[pos++] = (val >> 16) & 0xFF;
            buffer[pos++] = (val >> 8) & 0xFF;
            buffer[pos++] = val & 0xFF;
            buffer[pos++] = 0x00;
            buffer[pos++] = 0x00;
            buffer[pos++] = 0x00;
            buffer[pos++] = 0x00;
        }
        
        /* ASDU length (BER long-form 0x82) */
        size_t asduLen = pos - asduLenPos - 3;
        buffer[asduLenPos + 1] = (asduLen >> 8) & 0xFF;
        buffer[asduLenPos + 2] = asduLen & 0xFF;
    }
    
    /* Fill seqASDU length (2-byte) */
    size_t seqASDULen = pos - seqASDULenPos - 3;
    buffer[seqASDULenPos + 1] = (seqASDULen >> 8) & 0xFF;
    buffer[seqASDULenPos + 2] = seqASDULen & 0xFF;
    
    /* Fill savPdu length (2-byte) */
    size_t savPduLen = pos - savPduLenPos - 3;
    buffer[savPduLenPos + 1] = (savPduLen >> 8) & 0xFF;
    buffer[savPduLenPos + 2] = savPduLen & 0xFF;
    
    /* APDU Length: savPduLen + 12 (matches Node.js formula for multi-ASDU) */
    size_t apduLen = savPduLen + 12;
    buffer[lengthPos] = (apduLen >> 8) & 0xFF;
    buffer[lengthPos + 1] = apduLen & 0xFF;
    
    /* Pad to minimum frame size */
    while (pos < 60) buffer[pos++] = 0;
    
    *outSize = pos;
    return 0;
}

/*============================================================================
 * Utility
 *============================================================================*/

size_t sv_encoder_get_frame_size(void) {
    std::lock_guard<std::mutex> lock(g_mutex);
    
    size_t headerSize = 14 + (g_config.vlanID > 0 ? 4 : 0);
    size_t svHeaderSize = 8;  /* APPID(2) + Length(2) + Reserved(4) */
    /* savPdu overhead with BER long-form lengths:
     * tag 0x60(1) + 0x82+len(3) + noASDU TLV(3) + seqASDU tag(1) + 0x82+len(3) = 11 */
    size_t savPduOverhead = 11;
    size_t svIDLen = strlen(g_config.svID);
    if (svIDLen == 0) svIDLen = 4;  /* default "MU01" */
    /* seqData: tag(1) + len(1 or 2) + data. Use worst case (2 bytes for len) */
    size_t seqDataSize = 3 + ((size_t)g_config.channelCount * 8);
    /* ASDU: SEQUENCE tag(1) + 0x82+len(3) + svID TLV(2+svIDLen) + smpCnt(4) + confRev(6) + smpSynch(3) + seqData */
    size_t asduSize = 4 + (2 + svIDLen) + 4 + 6 + 3 + seqDataSize;
    
    size_t total = headerSize + svHeaderSize + savPduOverhead + (asduSize * g_config.asduCount);
    return total < 60 ? 60 : total;
}

} /* extern "C" */
