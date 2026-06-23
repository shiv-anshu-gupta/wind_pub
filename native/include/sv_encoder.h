/**
 * @file sv_encoder.h
 * @brief IEC 61850-9-2LE SV Packet Encoder
 * 
 * Encodes Sampled Values packets according to IEC 61850-9-2LE standard.
 */

#ifndef SV_ENCODER_H
#define SV_ENCODER_H

#include <cstdint>
#include <cstddef>

#ifdef __cplusplus
extern "C" {
#endif

// ============================================================================
// CONSTANTS
// ============================================================================

#define SV_ETHERTYPE        0x88BA
#define SV_MAX_CHANNELS     20   // IEC 61869-9 supports up to 20 channels
#define SV_MAX_ASDU         8
#define SV_MAX_SVID_LEN     64
#define SV_MIN_FRAME_SIZE   60
#define SV_MAX_FRAME_SIZE   1500

// ============================================================================
// CONFIGURATION STRUCTURE
// ============================================================================

typedef struct SvEncoderConfig {
    char svID[SV_MAX_SVID_LEN];
    uint16_t appID;
    uint32_t confRev;
    uint8_t smpSynch;
    uint8_t srcMAC[6];
    uint8_t dstMAC[6];
    int vlanPriority;
    int vlanID;
    uint8_t asduCount;     // 1, 4, or 8
    uint8_t channelCount;  // 1-20 (default 8 for 9-2LE)
} SvEncoderConfig;

// ============================================================================
// ENCODER API
// ============================================================================

/**
 * Set encoder configuration
 */
void sv_encoder_set_config(const SvEncoderConfig* config);

/**
 * Get current encoder configuration
 */
void sv_encoder_get_config(SvEncoderConfig* config);

/**
 * Encode a single SV packet
 * 
 * @param smpCnt Sample counter
 * @param samples Array of 8 channel values (int32_t)
 * @param outBuffer Output buffer (must be at least SV_MAX_FRAME_SIZE bytes)
 * @param outSize Output: actual encoded size
 * @return 0 on success, -1 on error
 */
int sv_encoder_encode_packet(
    uint32_t smpCnt,
    const int32_t* samples,
    uint8_t* outBuffer,
    size_t* outSize
);

/**
 * Encode packet with multiple ASDUs
 * 
 * @param baseSmpCnt Base sample counter for first ASDU
 * @param samplesArray Array of sample arrays (asduCount × 8 values)
 * @param outBuffer Output buffer
 * @param outSize Output: actual encoded size
 * @return 0 on success, -1 on error
 */
int sv_encoder_encode_multi_asdu(
    uint32_t baseSmpCnt,
    const int32_t** samplesArray,
    uint8_t* outBuffer,
    size_t* outSize
);

/**
 * Get expected frame size for current config
 */
size_t sv_encoder_get_frame_size(void);

#ifdef __cplusplus
}
#endif

#endif // SV_ENCODER_H
