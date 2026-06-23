/**
 * @file asn1_ber_encoder.cc
 * @brief ASN.1 BER TLV Encoder for IEC 61850 Sampled Values
 *
 * @section ber_overview Overview
 * 
 * This module implements ASN.1 BER (Basic Encoding Rules) encoding,
 * specifically for IEC 61850-9-2 Sampled Values protocol. BER is a
 * Tag-Length-Value (TLV) encoding system used to serialize structured data.
 * 
 * @section ber_what What is ASN.1 BER?
 * 
 * ASN.1 (Abstract Syntax Notation One) is a standard for describing data
 * structures. BER is one encoding method for serializing ASN.1 data.
 * 
 * Every piece of data is encoded as:
 * ```
 * ┌─────────┬─────────┬──────────────────────┐
 * │   TAG   │ LENGTH  │        VALUE         │
 * │ (1 byte)│ (1-5 B) │    (variable)        │
 * └─────────┴─────────┴──────────────────────┘
 * ```
 * 
 * @section ber_example Example Encoding
 * 
 * Encoding the string "MU001" with tag 0x80 (svID):
 * ```
 * Tag: 0x80
 * Length: 0x05 (5 characters)
 * Value: 0x4D 0x55 0x30 0x30 0x31 ('M','U','0','0','1')
 * 
 * Result: 80 05 4D 55 30 30 31
 * ```
 * 
 * @section ber_sv_structure SV Message Structure
 * 
 * @dot
 * digraph SVStructure {
 *   rankdir=TB;
 *   node [shape=record, style=filled, fillcolor="#f0f0f0"];
 *   
 *   SAVPDU [label="{SAVPDU (0x60)|Contains entire SV message}", fillcolor="#ffcccc"];
 *   NOASDU [label="{noASDU (0x80)|Number of ASDUs: 1}", fillcolor="#ccffcc"];
 *   SEQASDU [label="{seqASDU (0xA2)|Sequence of ASDUs}", fillcolor="#ccccff"];
 *   ASDU [label="{ASDU (0x30)|One measurement sample}", fillcolor="#ffffcc"];
 *   SVID [label="{svID (0x80)|\"MUnn01\"}", fillcolor="#ffccff"];
 *   SMPCNT [label="{smpCnt (0x82)|Sample counter}", fillcolor="#ccffff"];
 *   CONFREV [label="{confRev (0x83)|Config revision}", fillcolor="#ffccff"];
 *   SMPSYNCH [label="{smpSynch (0x85)|Sync status}", fillcolor="#ccffff"];
 *   SEQDATA [label="{seqData (0x87)|8 channels × 8 bytes}", fillcolor="#ffffcc"];
 *   
 *   SAVPDU -> NOASDU;
 *   SAVPDU -> SEQASDU;
 *   SEQASDU -> ASDU;
 *   ASDU -> SVID;
 *   ASDU -> SMPCNT;
 *   ASDU -> CONFREV;
 *   ASDU -> SMPSYNCH;
 *   ASDU -> SEQDATA;
 * }
 * @enddot
 * 
 * @section ber_length_encoding Length Encoding
 * 
 * BER uses variable-length encoding for efficiency:
 * 
 * | Value Range | Bytes | Format |
 * |-------------|-------|--------|
 * | 0-127       | 1     | Direct value |
 * | 128-255     | 2     | 0x81 + 1 byte |
 * | 256-65535   | 3     | 0x82 + 2 bytes |
 * | 65536+      | 4-5   | 0x83/0x84 + bytes |
 */

#ifndef ASN1_BER_ENCODER_CC
#define ASN1_BER_ENCODER_CC

#include <stdint.h>
#include <stddef.h>
#include <string.h>

/**
 * @defgroup asn1_classes ASN.1 Tag Classes
 * @brief Tag class identifiers (bits 7-6 of tag byte)
 * @{
 */

typedef enum {
    ASN1_CLASS_UNIVERSAL   = 0x00,  /**< Standard ASN.1 types */
    ASN1_CLASS_APPLICATION = 0x40,  /**< Application-specific */
    ASN1_CLASS_CONTEXT     = 0x80,  /**< Context-specific (most common in SV) */
    ASN1_CLASS_PRIVATE     = 0xC0   /**< Private use */
} Asn1ClassEnc;

#define ASN1_CONSTRUCTED  0x20  /**< Bit 5: indicates constructed type */

/** @} */ // end of asn1_classes group

/**
 * @defgroup asn1_universal ASN.1 Universal Tags
 * @brief Standard ASN.1 type tags
 * @{
 */

#define ASN1_TAG_BOOLEAN         0x01  /**< Boolean (TRUE/FALSE) */
#define ASN1_TAG_INTEGER         0x02  /**< Integer (variable length) */
#define ASN1_TAG_BIT_STRING      0x03  /**< Bit string */
#define ASN1_TAG_OCTET_STRING    0x04  /**< Octet (byte) string */
#define ASN1_TAG_NULL            0x05  /**< NULL value */
#define ASN1_TAG_OBJECT_ID       0x06  /**< Object identifier */
#define ASN1_TAG_UTF8_STRING     0x0C  /**< UTF-8 string */
#define ASN1_TAG_SEQUENCE        0x10  /**< Sequence (ordered collection) */
#define ASN1_TAG_SET             0x11  /**< Set (unordered collection) */
#define ASN1_TAG_VISIBLE_STRING  0x1A  /**< Visible (printable) string */
#define ASN1_TAG_GENERALIZED_TIME 0x18 /**< Generalized time */
#define ASN1_TAG_UTC_TIME        0x17  /**< UTC time */

/** @} */ // end of asn1_universal group

/**
 * @defgroup sv_tags IEC 61850 SV Tags
 * @brief Tags specific to Sampled Values protocol
 * @{
 */

#define SV_TAG_SAVPDU           0x60  /**< SAVPDU container (APPLICATION 0, CONSTRUCTED) */
#define SV_TAG_NOASDU           0x80  /**< Number of ASDUs [0] IMPLICIT */
#define SV_TAG_SEQASDU          0xA2  /**< Sequence of ASDUs [2] IMPLICIT */
#define SV_TAG_ASDU             0x30  /**< Single ASDU (SEQUENCE) */
#define SV_TAG_SVID             0x80  /**< Stream ID [0] */
#define SV_TAG_DATSET           0x81  /**< Dataset reference [1] */
#define SV_TAG_SMPCNT           0x82  /**< Sample counter [2] */
#define SV_TAG_CONFREV          0x83  /**< Configuration revision [3] */
#define SV_TAG_REFRTM           0x84  /**< Refresh time [4] */
#define SV_TAG_SMPSYNCH         0x85  /**< Sample synchronization [5] */
#define SV_TAG_SMPRATE          0x86  /**< Sample rate [6] */
#define SV_TAG_SEQDATA          0x87  /**< Sequence of data (channel values) [7] */
#define SV_TAG_SMPMOD           0x88  /**< Sample mode [8] */

/** @} */ // end of sv_tags group

/**
 * @defgroup ber_functions BER Encoding Functions
 * @brief Functions for encoding ASN.1 BER data
 * @{
 */

/* Function declarations */
size_t ber_encode_tag(uint8_t *buf, size_t buflen, uint8_t tag);
size_t ber_encode_length(uint8_t *buf, size_t buflen, size_t length);
size_t ber_encode_tlv(uint8_t *buf, size_t buflen, uint8_t tag, const uint8_t *value, size_t value_len);
size_t ber_encode_unsigned(uint8_t *buf, size_t buflen, uint8_t tag, uint64_t value);
size_t ber_encode_signed(uint8_t *buf, size_t buflen, uint8_t tag, int64_t value);
size_t ber_encode_int32_fixed(uint8_t *buf, size_t buflen, int32_t value);
size_t ber_encode_uint32_fixed(uint8_t *buf, size_t buflen, uint32_t value);
size_t ber_encode_visible_string(uint8_t *buf, size_t buflen, uint8_t tag, const char *str);
size_t ber_encode_octet_string(uint8_t *buf, size_t buflen, uint8_t tag, const uint8_t *data, size_t data_len);
size_t ber_encode_boolean(uint8_t *buf, size_t buflen, uint8_t tag, int value);
size_t ber_length_of_length(size_t length);

/** @} */ // end of ber_functions group

/*============================================================================
 * Implementation
 *============================================================================*/

/**
 * @brief Calculate bytes needed to encode a BER length field
 * 
 * BER uses variable-length encoding for the length field:
 * - Length < 128: 1 byte (short form)
 * - Length < 256: 2 bytes (0x81 + 1 byte)
 * - Length < 65536: 3 bytes (0x82 + 2 bytes)
 * 
 * @param length The length value to encode
 * @return Number of bytes needed (1-5)
 * 
 * @code
 * size_t len_bytes = ber_length_of_length(200);  // Returns 2
 * @endcode
 */
size_t ber_length_of_length(size_t length)
{
    if (length < 128U) {
        return 1U;
    } else if (length <= 0xFFU) {
        return 2U;
    } else if (length <= 0xFFFFU) {
        return 3U;
    } else if (length <= 0xFFFFFFU) {
        return 4U;
    } else {
        return 5U;
    }
}

/**
 * @brief Encode a single-byte ASN.1 tag
 * 
 * @param[out] buf    Output buffer
 * @param[in]  buflen Size of output buffer
 * @param[in]  tag    Tag value to encode (e.g., SV_TAG_SVID)
 * @return Number of bytes written (1), or 0 if buffer too small
 */
size_t ber_encode_tag(uint8_t *buf, size_t buflen, uint8_t tag)
{
    if (buflen < 1U) {
        return 0U;
    }
    buf[0] = tag;
    return 1U;
}

/**
 * @brief Encode a BER length field
 * 
 * Encodes the length using BER definite-length encoding:
 * - Short form (1 byte) for length < 128
 * - Long form (2-5 bytes) for larger lengths
 * 
 * @param[out] buf    Output buffer
 * @param[in]  buflen Size of output buffer  
 * @param[in]  length Length value to encode
 * @return Number of bytes written, or 0 if buffer too small
 */
size_t ber_encode_length(uint8_t *buf, size_t buflen, size_t length)
{
    if (length < 128U) {
        if (buflen < 1U) return 0U;
        buf[0] = (uint8_t)length;
        return 1U;
    } else if (length <= 0xFFU) {
        if (buflen < 2U) return 0U;
        buf[0] = 0x81U;
        buf[1] = (uint8_t)length;
        return 2U;
    } else if (length <= 0xFFFFU) {
        if (buflen < 3U) return 0U;
        buf[0] = 0x82U;
        buf[1] = (uint8_t)(length >> 8);
        buf[2] = (uint8_t)(length & 0xFFU);
        return 3U;
    } else if (length <= 0xFFFFFFU) {
        if (buflen < 4U) return 0U;
        buf[0] = 0x83U;
        buf[1] = (uint8_t)(length >> 16);
        buf[2] = (uint8_t)((length >> 8) & 0xFFU);
        buf[3] = (uint8_t)(length & 0xFFU);
        return 4U;
    } else {
        if (buflen < 5U) return 0U;
        buf[0] = 0x84U;
        buf[1] = (uint8_t)(length >> 24);
        buf[2] = (uint8_t)((length >> 16) & 0xFFU);
        buf[3] = (uint8_t)((length >> 8) & 0xFFU);
        buf[4] = (uint8_t)(length & 0xFFU);
        return 5U;
    }
}

/**
 * @brief Encode a complete TLV (Tag-Length-Value) structure
 * 
 * This is the core encoding function that combines tag, length, and value.
 * 
 * @param[out] buf       Output buffer
 * @param[in]  buflen    Size of output buffer
 * @param[in]  tag       Tag byte
 * @param[in]  value     Value data (can be NULL if value_len is 0)
 * @param[in]  value_len Length of value data
 * @return Total bytes written, or 0 if buffer too small
 */
size_t ber_encode_tlv(uint8_t *buf, size_t buflen, uint8_t tag,
                      const uint8_t *value, size_t value_len)
{
    size_t tag_len = 1U;
    size_t len_len = ber_length_of_length(value_len);
    size_t total = tag_len + len_len + value_len;
    
    if (buflen < total) return 0U;
    
    size_t offset = 0U;
    offset += ber_encode_tag(buf + offset, buflen - offset, tag);
    offset += ber_encode_length(buf + offset, buflen - offset, value_len);
    
    if (value_len > 0U && value != NULL) {
        memcpy(buf + offset, value, value_len);
        offset += value_len;
    }
    
    return offset;
}

/**
 * @brief Encode an unsigned integer
 * 
 * Encodes using minimum bytes needed (BER DER rules).
 * 
 * @param[out] buf     Output buffer
 * @param[in]  buflen  Size of output buffer
 * @param[in]  tag     Tag byte
 * @param[in]  value   Unsigned value to encode
 * @return Bytes written, or 0 if buffer too small
 */
size_t ber_encode_unsigned(uint8_t *buf, size_t buflen, uint8_t tag, uint64_t value)
{
    uint8_t temp[9];
    size_t len = 0U;
    
    if (value == 0U) {
        temp[0] = 0x00U;
        len = 1U;
    } else {
        uint64_t v = value;
        size_t nbytes = 0U;
        while (v > 0U) {
            nbytes++;
            v >>= 8;
        }
        
        uint8_t msb = (uint8_t)(value >> ((nbytes - 1U) * 8U));
        if (msb & 0x80U) {
            temp[len++] = 0x00U;
        }
        
        for (size_t i = nbytes; i > 0U; i--) {
            temp[len++] = (uint8_t)(value >> ((i - 1U) * 8U));
        }
    }
    
    return ber_encode_tlv(buf, buflen, tag, temp, len);
}

/**
 * @brief Encode a signed integer
 * 
 * @param[out] buf     Output buffer
 * @param[in]  buflen  Size of output buffer
 * @param[in]  tag     Tag byte
 * @param[in]  value   Signed value to encode
 * @return Bytes written, or 0 if buffer too small
 */
size_t ber_encode_signed(uint8_t *buf, size_t buflen, uint8_t tag, int64_t value)
{
    uint8_t temp[8];
    size_t len = 0U;
    
    if (value >= 0) {
        return ber_encode_unsigned(buf, buflen, tag, (uint64_t)value);
    } else {
        int64_t v = value;
        size_t nbytes = 1U;
        
        while (nbytes < 8U) {
            int64_t min_val = -((int64_t)1 << (nbytes * 8U - 1U));
            if (v >= min_val) break;
            nbytes++;
        }
        
        for (size_t i = nbytes; i > 0U; i--) {
            temp[len++] = (uint8_t)(v >> ((i - 1U) * 8U));
        }
    }
    
    return ber_encode_tlv(buf, buflen, tag, temp, len);
}

/**
 * @brief Encode a 32-bit signed integer as fixed 4 bytes
 * 
 * Used for SV sample values which are always exactly 4 bytes
 * (no TLV wrapper, just raw big-endian bytes).
 * 
 * @param[out] buf     Output buffer (must be at least 4 bytes)
 * @param[in]  buflen  Size of output buffer
 * @param[in]  value   Value to encode
 * @return 4 on success, 0 if buffer too small
 */
size_t ber_encode_int32_fixed(uint8_t *buf, size_t buflen, int32_t value)
{
    if (buflen < 4U) return 0U;
    
    buf[0] = (uint8_t)((value >> 24) & 0xFFU);
    buf[1] = (uint8_t)((value >> 16) & 0xFFU);
    buf[2] = (uint8_t)((value >> 8) & 0xFFU);
    buf[3] = (uint8_t)(value & 0xFFU);
    
    return 4U;
}

/**
 * @brief Encode a 32-bit unsigned integer as fixed 4 bytes
 * 
 * Used for SV quality flags which are always exactly 4 bytes.
 * 
 * @param[out] buf     Output buffer (must be at least 4 bytes)
 * @param[in]  buflen  Size of output buffer
 * @param[in]  value   Value to encode
 * @return 4 on success, 0 if buffer too small
 */
size_t ber_encode_uint32_fixed(uint8_t *buf, size_t buflen, uint32_t value)
{
    if (buflen < 4U) return 0U;
    
    buf[0] = (uint8_t)((value >> 24) & 0xFFU);
    buf[1] = (uint8_t)((value >> 16) & 0xFFU);
    buf[2] = (uint8_t)((value >> 8) & 0xFFU);
    buf[3] = (uint8_t)(value & 0xFFU);
    
    return 4U;
}

/**
 * @brief Encode a visible (ASCII) string
 * 
 * Used for svID (stream identifier) encoding.
 * 
 * @param[out] buf     Output buffer
 * @param[in]  buflen  Size of output buffer
 * @param[in]  tag     Tag byte (typically SV_TAG_SVID)
 * @param[in]  str     NULL-terminated string
 * @return Bytes written, or 0 on error
 */
size_t ber_encode_visible_string(uint8_t *buf, size_t buflen, uint8_t tag, const char *str)
{
    if (str == NULL) return 0U;
    size_t str_len = strlen(str);
    return ber_encode_tlv(buf, buflen, tag, (const uint8_t *)str, str_len);
}

/**
 * @brief Encode an octet (byte) string
 * 
 * @param[out] buf      Output buffer
 * @param[in]  buflen   Size of output buffer
 * @param[in]  tag      Tag byte
 * @param[in]  data     Byte data
 * @param[in]  data_len Length of data
 * @return Bytes written, or 0 on error
 */
size_t ber_encode_octet_string(uint8_t *buf, size_t buflen, uint8_t tag,
                               const uint8_t *data, size_t data_len)
{
    return ber_encode_tlv(buf, buflen, tag, data, data_len);
}

/**
 * @brief Encode a boolean value
 * 
 * @param[out] buf     Output buffer
 * @param[in]  buflen  Size of output buffer
 * @param[in]  tag     Tag byte
 * @param[in]  value   0 for FALSE, non-zero for TRUE
 * @return Bytes written, or 0 on error
 */
size_t ber_encode_boolean(uint8_t *buf, size_t buflen, uint8_t tag, int value)
{
    uint8_t bool_val = (value != 0) ? 0xFFU : 0x00U;
    return ber_encode_tlv(buf, buflen, tag, &bool_val, 1U);
}

#endif /* ASN1_BER_ENCODER_CC */
