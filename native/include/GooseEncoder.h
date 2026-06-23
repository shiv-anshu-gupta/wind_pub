/**
 * @file GooseEncoder.h
 * @brief IEC 61850-8-1 GOOSE frame encoder (boolean-payload subset).
 *
 * Builds a complete Ethernet frame carrying ONE IECGoosePdu whose `allData`
 * sequence contains ONE BOOLEAN — the typical "breaker open/close" case.
 * Anything richer (multi-value datasets, struct/array types) is out of scope
 * for the Phase-3 hand-off; the encoder is structured so adding more value
 * types later is mechanical (extend the value type + add encoder per type).
 *
 * Wire format (top-level)
 * -----------------------
 *   [ 6 B dst MAC ] [ 6 B src MAC ] [optional 4 B VLAN] [ 2 B EtherType=0x88B8 ]
 *   [ 2 B APPID ] [ 2 B Length=L ] [ 2 B Reserved1=0 ] [ 2 B Reserved2=0 ]
 *   [ IECGoosePdu (BER) ]
 *
 *   L = 8 + sizeof(IECGoosePdu)  (length covers from APPID through PDU end)
 *
 * IECGoosePdu (tag 0x61, constructed)
 * -----------------------------------
 *   [0] gocbRef            VISIBLESTRING
 *   [1] timeAllowedToLive  UNSIGNED        (milliseconds — usually 2 * T1)
 *   [2] datSet             VISIBLESTRING
 *   [3] goID               VISIBLESTRING   (we always include; some IEDs require)
 *   [4] t                  UTCTIME         (8 octets: secs + fraction)
 *   [5] stNum              UNSIGNED        (state number)
 *   [6] sqNum              UNSIGNED        (sequence within state)
 *   [7] test               BOOLEAN
 *   [8] confRev            UNSIGNED
 *   [9] ndsCom             BOOLEAN
 *  [10] numDatSetEntries   UNSIGNED
 *  [11] allData            SEQUENCE OF Data — contains ONE boolean (tag 0x83)
 *
 * The publisher's GooseTxScheduler owns stNum/sqNum/timing. This encoder is
 * stateless — call with the values you want and get a frame back.
 */
#pragma once

#include <cstdint>
#include <cstddef>

/* Hard ceilings — IEC 61850-8-1 GOOSE PDUs are short. 256 B is plenty. */
#define GOOSE_MIN_FRAME_SIZE  60
#define GOOSE_MAX_FRAME_SIZE  256
#define GOOSE_MAX_REF_LEN     128   /* gocbRef / datSet / goID max */

/** Static configuration for one GOOSE stream — set once at start. */
struct GooseEncoderConfig {
    uint8_t  srcMAC[6];
    uint8_t  dstMAC[6];           /* must be 01:0C:CD:01:xx:xx range */
    int      vlanID;              /* -1 = no VLAN */
    int      vlanPriority;        /* 0..7 */
    uint16_t appID;
    uint32_t confRev;
    int      test;                /* 0 = production, 1 = test mode */
    int      ndsCom;              /* 0 unless commissioning */
    char     gocbRef[GOOSE_MAX_REF_LEN];   /* e.g. "BAY1/LLN0$GO$gcb01" */
    char     datSet [GOOSE_MAX_REF_LEN];   /* e.g. "BAY1/LLN0$Dataset1" */
    char     goID   [GOOSE_MAX_REF_LEN];   /* e.g. "Bay1_Breaker_Pos"  */
};

/** Per-frame state — supplied by the TX scheduler at encode time. */
struct GooseFrameState {
    uint32_t stNum;                 /* state number — incs on data change */
    uint32_t sqNum;                 /* sequence number — incs each retransmit */
    uint32_t timeAllowedToLive_ms;  /* TAL — usually ~2 × current retransmit interval */
    uint64_t t_ns;                  /* UTC ns at the moment of state change */
    int      booleanValue;          /* the payload bit */
};

#ifdef __cplusplus
extern "C" {
#endif

/** Build one GOOSE Ethernet frame.
 *  @param cfg     stream-static config
 *  @param state   per-frame counters + payload
 *  @param out     output buffer (must be >= GOOSE_MAX_FRAME_SIZE bytes)
 *  @param outLen  in: buffer size; out: bytes written
 *  @return 0 on success, -1 on error (buffer too small, bad config). */
int goose_encode_frame(const GooseEncoderConfig* cfg,
                       const GooseFrameState*    state,
                       uint8_t*                  out,
                       size_t*                   outLen);

#ifdef __cplusplus
}
#endif
