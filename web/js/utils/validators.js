/**
 * @file validators.js
 * @fileoverview Input Validation Utilities for SV Publisher
 * @module validators
 * @author SV-PUB Team
 * @copyright 2025 SV Publisher
 * @license Proprietary
 * @version 1.0.0
 * 
 * @description
 * This module provides validation functions for all user inputs in the SV Publisher application.
 * All validators follow a consistent pattern: they take an input value and return a boolean
 * indicating validity.
 * 
 * **Validation Flow:**
 * 1. User enters input in form field
 * 2. Input passed to validator function
 * 3. Validator returns true/false
 * 4. If valid: process input, update store
 * 5. If invalid: show error toast, highlight field
 * 
 * **Security:**
 * - All inputs are validated before being used
 * - Regex patterns designed to prevent injection
 * - Numeric ranges strictly enforced
 * - No dynamic code execution (no eval)
 * 
 * **Validation Reference:**
 * 
 * | Type | Function | Format/Range |
 * |------|----------|--------------|
 * | MAC Address | validateMacAddress | XX:XX:XX:XX:XX:XX |
 * | App ID | validateAppId | 0x0000 - 0x3FFF (0-16383) |
 * | SV ID | validateSvId | 1-65 characters |
 * | PCAP File | validatePcapFile | .pcap, .pcapng |
 * 
 * @example <caption>Basic Usage</caption>
 * import { validateMacAddress, validateAppId } from './utils/validators.js';
 * 
 * if (validateMacAddress('01:0C:CD:04:00:00')) {
 *     console.log('Valid MAC');
 * }
 * 
 * @example <caption>Form Validation</caption>
 * function validateForm() {
 *     const errors = [];
 *     if (!validateMacAddress(srcMacInput.value)) {
 *         errors.push('Invalid source MAC address');
 *     }
 *     return errors.length === 0;
 * }
 */

'use strict';

// ============================================================================
// MAC ADDRESS VALIDATION
// ============================================================================

/**
 * Validate a MAC address string
 * 
 * @memberof module:validators
 * @function validateMacAddress
 * @description
 * Validates that a string is a properly formatted MAC address in the format
 * `XX:XX:XX:XX:XX:XX` where X is a hexadecimal digit (0-9, A-F, a-f).
 * 
 * **Valid Format:** `XX:XX:XX:XX:XX:XX` (colon-separated hex octets)
 * 
 * **IEC 61850 MAC Address Ranges:**
 * 
 * | Usage | MAC Pattern | Example |
 * |-------|-------------|---------|
 * | SV Multicast | 01:0C:CD:04:xx:xx | 01:0C:CD:04:00:00 |
 * | GOOSE Multicast | 01:0C:CD:01:xx:xx | 01:0C:CD:01:00:01 |
 * | Unicast | xx:xx:xx:xx:xx:xx | 00:00:00:00:00:01 |
 * 
 * @param {string} mac - MAC address string to validate
 * @returns {boolean} True if the MAC address is valid, false otherwise
 * 
 * @example
 * validateMacAddress('01:0C:CD:04:00:00')  // true - SV multicast
 * validateMacAddress('00:00:00:00:00:01')  // true - Unicast
 * validateMacAddress('01:0c:cd:04:00:00')  // true - lowercase ok
 * validateMacAddress('01-0C-CD-04-00-00')  // false - wrong separator
 * validateMacAddress('01:0C:CD:04:00')     // false - too short
 * validateMacAddress('GG:00:00:00:00:00')  // false - invalid hex
 */
export function validateMacAddress(mac) {
    const macRegex = /^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/;
    return macRegex.test(mac);
}

// ============================================================================
// APPLICATION ID VALIDATION
// ============================================================================

/**
 * Validate an IEC 61850 Application ID
 * 
 * @memberof module:validators
 * @function validateAppId
 * @description
 * Validates that an Application ID (AppID) is within the valid range
 * for IEC 61850 Sampled Values.
 * 
 * ## AppID Range
 * 
 * | Protocol | Range | Hex Range |
 * |----------|-------|-----------|
 * | SV | 0-16383 | 0x0000-0x3FFF |
 * | GOOSE | 0-16383 | 0x0000-0x3FFF |
 * 
 * The AppID is a 16-bit unsigned integer, but IEC 61850 reserves
 * the upper 2 bits, limiting the usable range to 0-16383.
 * 
 * @param {string|number} appId - Application ID (hex string or number)
 * @returns {boolean} True if the AppID is valid, false otherwise
 * 
 * @example
 * validateAppId('4000')   // true - typical SV AppID
 * validateAppId('0')      // true - minimum
 * validateAppId('3FFF')   // true - maximum
 * validateAppId('4000')   // true - 0x4000 = 16384 - INVALID!
 * validateAppId('FFFF')   // false - too large
 * validateAppId(-1)       // false - negative
 * validateAppId('ZZZZ')   // false - not hex
 * 
 * @see {@link https://iec61850.ucaiug.org/|IEC 61850 UCA}
 */
export function validateAppId(appId) {
    const num = parseInt(appId, 16);
    return !isNaN(num) && num >= 0 && num <= 0x3FFF;
}

// ============================================================================
// SV ID VALIDATION
// ============================================================================

/**
 * Validate an SV Identifier string
 * 
 * @memberof module:validators
 * @function validateSvId
 * @description
 * Validates that an SV ID (Sampled Values Identifier) meets the IEC 61850
 * requirements for length.
 * 
 * **SV ID Requirements:**
 * - Minimum length: 1 character
 * - Maximum length: 65 characters
 * - Recommended format: Descriptive identifier (e.g., "MU01", "Bay1_CT")
 * 
 * **Validation Logic:**
 * - Empty string → Invalid
 * - 1-65 characters → Valid
 * - >65 characters → Invalid (too long)
 * 
 * @param {string} svId - SV identifier string to validate
 * @returns {boolean} True if the SV ID is valid, false otherwise
 * 
 * @example
 * validateSvId('MU01')                    // true
 * validateSvId('Bay1_Current_Transformer') // true
 * validateSvId('')                         // false - empty
 * validateSvId('A'.repeat(66))            // false - too long
 * 
 * @see {@link https://webstore.iec.ch/publication/6020|IEC 61850-9-2}
 */
export function validateSvId(svId) {
    return svId.length > 0 && svId.length <= 65;
}

// ============================================================================
// PCAP FILE VALIDATION
// ============================================================================

/**
 * Validate a PCAP file name/extension
 * 
 * @memberof module:validators
 * @function validatePcapFile
 * @description
 * Validates that a file name has a valid PCAP extension for packet capture files.
 * 
 * **Supported Extensions:**
 * 
 * | Extension | Description |
 * |-----------|-------------|
 * | .pcap | Standard PCAP format (libpcap) |
 * | .pcapng | PCAP Next Generation format |
 * 
 * **Validation:** Case-insensitive extension check
 * 
 * @param {string} fileName - File name to validate
 * @returns {boolean} True if the file has a valid PCAP extension
 * 
 * @example
 * validatePcapFile('capture.pcap')     // true
 * validatePcapFile('capture.pcapng')   // true
 * validatePcapFile('capture.PCAP')     // true - case insensitive
 * validatePcapFile('capture.txt')      // false
 * validatePcapFile('capture')          // false - no extension
 * 
 * @see {@link https://wiki.wireshark.org/Development/LibpcapFileFormat|PCAP Format}
 */
export function validatePcapFile(fileName) {
    const validExtensions = ['.pcap', '.pcapng'];
    const lowerName = fileName.toLowerCase();
    return validExtensions.some(ext => lowerName.endsWith(ext));
}

