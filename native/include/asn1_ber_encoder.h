/**
 * @file asn1_ber_encoder.h
 * @brief Public declarations for the BER (Basic Encoding Rules) helpers.
 *
 * The implementation lives in native/src/asn1_ber_encoder.cc (already in the
 * codebase, previously unused). These helpers build the IEC 61850 ASN.1
 * encodings used by GOOSE frames. Each function returns the number of bytes
 * written, or 0 if buflen is too small.
 *
 * Tag byte conventions used by IEC 61850-8-1 PDUs:
 *   Bit 7-6: Class (00=Universal, 01=Application, 10=Context, 11=Private)
 *   Bit 5  : Form  (0=Primitive, 1=Constructed)
 *   Bit 4-0: Number
 *
 * Example tags used by GOOSE:
 *   0x61 — Application 1, constructed   (the GOOSE APDU itself, "IECGoosePdu")
 *   0x80 — Context 0, primitive         (gocbRef)
 *   0x81 — Context 1                    (timeAllowedToLive)
 *   ...
 *   0xAB — Context 11, constructed      (allData)
 *   0x83 — within allData: a BOOLEAN value (MMS BasicValueType choice 3)
 */
#pragma once

#include <cstdint>
#include <cstddef>

/* Declarations match the C++ definitions in asn1_ber_encoder.cc.
 * (No extern "C" — the .cc compiles these as regular C++.) */

size_t ber_encode_tag(uint8_t *buf, size_t buflen, uint8_t tag);
size_t ber_encode_length(uint8_t *buf, size_t buflen, size_t length);
size_t ber_encode_tlv(uint8_t *buf, size_t buflen, uint8_t tag,
                      const uint8_t *value, size_t value_len);
size_t ber_encode_unsigned(uint8_t *buf, size_t buflen, uint8_t tag,
                           uint64_t value);
size_t ber_encode_signed(uint8_t *buf, size_t buflen, uint8_t tag,
                         int64_t value);
size_t ber_encode_int32_fixed(uint8_t *buf, size_t buflen, int32_t value);
size_t ber_encode_uint32_fixed(uint8_t *buf, size_t buflen, uint32_t value);
size_t ber_encode_visible_string(uint8_t *buf, size_t buflen, uint8_t tag,
                                 const char *str);
size_t ber_encode_octet_string(uint8_t *buf, size_t buflen, uint8_t tag,
                               const uint8_t *data, size_t data_len);
size_t ber_encode_boolean(uint8_t *buf, size_t buflen, uint8_t tag, int value);
size_t ber_length_of_length(size_t length);
