/**
 * @file GooseEncoder.cc
 * @brief Implementation of the boolean-payload GOOSE encoder.
 *
 * Strategy: encode the IECGoosePdu body into a tmp buffer (inside the output
 * frame, past the Ethernet + GSE header bytes), measure its length, then
 * back-fill the outer length fields. This avoids a separate scratch buffer
 * and keeps the whole encode in one pass.
 *
 * Frame layout produced
 * ---------------------
 *   [0..5]   dst MAC
 *   [6..11]  src MAC
 *   [12..15] 802.1Q tag (optional, only if cfg->vlanID >= 0)
 *   [12/16]  EtherType 0x88B8
 *   [+0..1]  APPID
 *   [+2..3]  Length (= 8 + sizeof(IECGoosePdu including its tag/length))
 *   [+4..5]  Reserved1 = 0
 *   [+6..7]  Reserved2 = 0
 *   [+8..]   IECGoosePdu (BER)
 */
#include "../include/GooseEncoder.h"
#include "../include/asn1_ber_encoder.h"

#include <cstring>
#include <ctime>

/*============================================================================
 * Helpers
 *============================================================================*/

/** Convert UTC ns to the 8-octet IEC 61850 UtcTime layout:
 *   secs-since-epoch (32 bits, big-endian)  |  fraction-of-second (24 bits, big-endian)  |  quality (8 bits)
 *
 * Quality byte: bit7=LeapSecondsKnown, bit6=ClockFailure, bit5=ClockNotSynchronized,
 *               bits 4..0 = time accuracy (we set 0x18 = 24-bit accuracy ≈ 60 ns). */
static void utctime_pack(uint64_t t_ns, uint8_t out[8])
{
    const uint32_t secs = static_cast<uint32_t>(t_ns / 1000000000ULL);
    const uint64_t rem  = t_ns % 1000000000ULL;

    /* Fraction-of-second is a 24-bit fixed-point value: rem * (2^24) / 1e9 */
    const uint32_t frac24 =
        static_cast<uint32_t>((rem * (1ULL << 24)) / 1000000000ULL);

    out[0] = (uint8_t)(secs >> 24);
    out[1] = (uint8_t)(secs >> 16);
    out[2] = (uint8_t)(secs >>  8);
    out[3] = (uint8_t)(secs >>  0);
    out[4] = (uint8_t)(frac24 >> 16);
    out[5] = (uint8_t)(frac24 >>  8);
    out[6] = (uint8_t)(frac24 >>  0);
    out[7] = 0x18;   /* time accuracy = 24 bits, no flags set */
}

/*============================================================================
 * Encoder
 *============================================================================*/

int goose_encode_frame(const GooseEncoderConfig* cfg,
                       const GooseFrameState*    state,
                       uint8_t*                  out,
                       size_t*                   outLen)
{
    if (!cfg || !state || !out || !outLen) return -1;
    if (*outLen < GOOSE_MAX_FRAME_SIZE)    return -1;

    size_t off = 0;

    /*--- Ethernet header ---*/
    memcpy(out + off, cfg->dstMAC, 6); off += 6;
    memcpy(out + off, cfg->srcMAC, 6); off += 6;

    if (cfg->vlanID >= 0 && cfg->vlanID <= 0xFFF) {
        /* 802.1Q TPID */
        out[off++] = 0x81;
        out[off++] = 0x00;
        /* PCP (3 bits) | DEI (1 bit, 0) | VID (12 bits) */
        const uint16_t tci =
            ((uint16_t)(cfg->vlanPriority & 0x07) << 13) |
            (uint16_t)(cfg->vlanID & 0x0FFF);
        out[off++] = (uint8_t)(tci >> 8);
        out[off++] = (uint8_t)(tci & 0xFF);
    }

    /* EtherType 0x88B8 (GOOSE) */
    out[off++] = 0x88;
    out[off++] = 0xB8;

    /*--- GSE (GOOSE Sub-Ethernet) header — 8 bytes; length back-filled later ---*/
    out[off++] = (uint8_t)(cfg->appID >> 8);
    out[off++] = (uint8_t)(cfg->appID & 0xFF);
    const size_t lenFieldOffset = off;   /* remember where Length lives */
    out[off++] = 0; out[off++] = 0;       /* Length placeholder        */
    out[off++] = 0; out[off++] = 0;       /* Reserved1                 */
    out[off++] = 0; out[off++] = 0;       /* Reserved2                 */

    /*--- IECGoosePdu body — encode into the output buffer past the GSE header.
     *    We don't yet know the body length, so we encode the body fields
     *    first into [bodyStart .. ?], then prepend the outer tag/length. ---*/
    const size_t pduTagOffset = off;
    /* We'll write the outer tag (0x61) and length later. Reserve up to 3 bytes
     * for tag+length: 1 byte for tag, 1 or 2 bytes for length depending on size.
     * To keep it simple we reserve 3 bytes (tag + 2-byte length form). */
    const size_t pduBodyOffset = off + 3;

    size_t body = pduBodyOffset;
    const size_t bodyMax = *outLen;

    auto cap = [&](size_t need) { return (body + need) <= bodyMax; };
    auto fail = [&]() -> int { *outLen = 0; return -1; };

    /* [0] gocbRef */
    {
        size_t n = ber_encode_visible_string(out + body, bodyMax - body, 0x80, cfg->gocbRef);
        if (n == 0) return fail();
        body += n;
    }
    /* [1] timeAllowedToLive */
    {
        size_t n = ber_encode_unsigned(out + body, bodyMax - body, 0x81, state->timeAllowedToLive_ms);
        if (n == 0) return fail();
        body += n;
    }
    /* [2] datSet */
    {
        size_t n = ber_encode_visible_string(out + body, bodyMax - body, 0x82, cfg->datSet);
        if (n == 0) return fail();
        body += n;
    }
    /* [3] goID */
    {
        size_t n = ber_encode_visible_string(out + body, bodyMax - body, 0x83, cfg->goID);
        if (n == 0) return fail();
        body += n;
    }
    /* [4] t — UtcTime, 8 octets */
    {
        uint8_t utc[8]; utctime_pack(state->t_ns, utc);
        size_t n = ber_encode_octet_string(out + body, bodyMax - body, 0x84, utc, 8);
        if (n == 0) return fail();
        body += n;
    }
    /* [5] stNum */
    {
        size_t n = ber_encode_unsigned(out + body, bodyMax - body, 0x85, state->stNum);
        if (n == 0) return fail();
        body += n;
    }
    /* [6] sqNum */
    {
        size_t n = ber_encode_unsigned(out + body, bodyMax - body, 0x86, state->sqNum);
        if (n == 0) return fail();
        body += n;
    }
    /* [7] test */
    {
        size_t n = ber_encode_boolean(out + body, bodyMax - body, 0x87, cfg->test);
        if (n == 0) return fail();
        body += n;
    }
    /* [8] confRev */
    {
        size_t n = ber_encode_unsigned(out + body, bodyMax - body, 0x88, cfg->confRev);
        if (n == 0) return fail();
        body += n;
    }
    /* [9] ndsCom */
    {
        size_t n = ber_encode_boolean(out + body, bodyMax - body, 0x89, cfg->ndsCom);
        if (n == 0) return fail();
        body += n;
    }
    /* [10] numDatSetEntries = 1 (we send one boolean) */
    {
        size_t n = ber_encode_unsigned(out + body, bodyMax - body, 0x8A, 1);
        if (n == 0) return fail();
        body += n;
    }
    /* [11] allData — constructed SEQUENCE-OF containing ONE BOOLEAN [3]. */
    {
        if (!cap(2 + 3)) return fail();
        /* Inner BOOLEAN: tag 0x83, len 1, value 0/1 */
        uint8_t innerBool[3] = { 0x83, 0x01, (uint8_t)(state->booleanValue ? 1 : 0) };
        /* Wrap in allData = [11] IMPLICIT SEQUENCE: tag 0xAB, length = 3 */
        out[body++] = 0xAB;
        out[body++] = 0x03;
        memcpy(out + body, innerBool, 3); body += 3;
    }

    /*--- Back-fill the IECGoosePdu outer tag (0x61) and length ---*/
    const size_t pduBodyLen = body - pduBodyOffset;

    /* Choose short or long length form. */
    size_t lenBytes;
    if (pduBodyLen < 0x80) {
        lenBytes = 1;
    } else if (pduBodyLen < 0x100) {
        lenBytes = 2;
    } else {
        lenBytes = 3;
    }
    const size_t pduHeaderLen = 1 + lenBytes;

    /* We reserved 3 bytes; if the actual header is shorter, shift the body
     * left so the header sits flush. */
    if (pduHeaderLen < 3) {
        const size_t shift = 3 - pduHeaderLen;
        memmove(out + pduTagOffset + pduHeaderLen,
                out + pduBodyOffset, pduBodyLen);
        body -= shift;
    }

    /* Write tag + length. */
    out[pduTagOffset] = 0x61;
    if (lenBytes == 1) {
        out[pduTagOffset + 1] = (uint8_t)pduBodyLen;
    } else if (lenBytes == 2) {
        out[pduTagOffset + 1] = 0x81;
        out[pduTagOffset + 2] = (uint8_t)pduBodyLen;
    } else {
        out[pduTagOffset + 1] = 0x82;
        out[pduTagOffset + 2] = (uint8_t)(pduBodyLen >> 8);
        out[pduTagOffset + 3] = (uint8_t)(pduBodyLen & 0xFF);
    }

    /*--- Back-fill the GSE Length field: bytes from APPID through end of PDU,
     *    which is (length-field-position - 2) ... body — actually:
     *    Length covers APPID + Length + Reserved1 + Reserved2 + PDU = 8 + PDU. */
    const size_t pduTotalLen = pduHeaderLen + pduBodyLen;
    const uint16_t gseLen = (uint16_t)(8 + pduTotalLen);
    out[lenFieldOffset    ] = (uint8_t)(gseLen >> 8);
    out[lenFieldOffset + 1] = (uint8_t)(gseLen & 0xFF);

    /*--- Pad to the 60-byte Ethernet minimum. NICs would auto-pad anyway,
     *    but explicit padding keeps the frame deterministic for testing. ---*/
    if (body < GOOSE_MIN_FRAME_SIZE) {
        memset(out + body, 0, GOOSE_MIN_FRAME_SIZE - body);
        body = GOOSE_MIN_FRAME_SIZE;
    }

    *outLen = body;
    return 0;
}
