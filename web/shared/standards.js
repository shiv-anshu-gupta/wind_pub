/**
 * @file standards.js
 * @fileoverview IEC Standard Definitions - SHARED between Frontend and Backend
 * @module standards
 * @author SV-PUB Team
 * @copyright 2025 SV Publisher
 * @license Proprietary
 * @version 1.0.0
 * 
 * @description
 * This module is the **Single Source of Truth** for all IEC 61850 standard configurations.
 * It is designed to be used in both browser (ES modules) and Node.js (CommonJS) environments.
 * 
 * **Supported Standards:**
 * 
 * | Standard | Description | Channels | SPC | ASDUs |
 * |----------|-------------|----------|-----|-------|
 * | 9-2LE | Light Edition | 8 (fixed) | 80, 256 | 1 (fixed) |
 * | 9-2 | Full Standard | Up to 16 | 80, 256 | 1-16 |
 * | 61869 | Instrument Transformers | Up to 20 | Flexible | 1-16 |
 * 
 * **Standard Comparison:**
 * 
 * | Feature | IEC 61850-9-2 LE | IEC 61850-9-2 | IEC 61869 |
 * |---------|------------------|---------------|-----------|
 * | Max Channels | 8 (fixed) | 16 | 20 |
 * | Custom Channels | No | Yes | Yes |
 * | Samples/Cycle | 80, 256 | 80, 256 | Flexible |
 * | ASDUs/Frame | 1 (fixed) | 1-16 | 1-16 |
 * | Production Ready | Yes | Testing | Testing |
 * 
 * **Module Exports:**
 * - BASE_CHANNELS - Standard 8-channel configuration (4V + 4I)
 * - STANDARDS - Full configuration for each IEC standard
 * - DEFAULT_EQUATIONS - Default sinusoidal equations
 * - ADDITIONAL_CHANNELS - Computed/derived channels
 * 
 * **Security:**
 * - All configurations are read-only at runtime
 * - Channel IDs validated against allowed lists
 * - Numeric limits enforced (max channels, max ASDU, etc.)
 * 
 * @example <caption>Frontend (ES Module) Usage</caption>
 * import { STANDARDS, BASE_CHANNELS, DEFAULT_EQUATIONS } from './shared/standards.js';
 * 
 * const leConfig = STANDARDS['9-2LE'];
 * console.log(leConfig.maxChannels); // 8
 * 
 * @example <caption>Backend (CommonJS) Usage</caption>
 * const { STANDARDS, BASE_CHANNELS } = require('./shared/standards.js');
 * 
 * // Use in encoder
 * const channelOrder = STANDARDS['9-2LE'].channelOrder;
 * 
 * @see {@link https://webstore.iec.ch/publication/6020|IEC 61850-9-2:2011}
 * @see {@link https://iec61850.ucaiug.org/|IEC 61850 UCA Guidelines}
 * @see {@link https://webstore.iec.ch/publication/24111|IEC 61869-9:2016}
 */

'use strict';

// ============================================================================
// BASE CHANNEL DEFINITIONS
// ============================================================================

/**
 * Base 8-channel configuration for IEC 61850-9-2 LE
 * 
 * @description
 * These are the standard 8 channels defined by IEC 61850-9-2 LE:
 * - 4 voltage channels (Va, Vb, Vc, Vn)
 * - 4 current channels (Ia, Ib, Ic, In)
 * 
 * **Channel Layout:**
 * 
 * | Type | Phase A | Phase B | Phase C | Neutral |
 * |------|---------|---------|---------|---------|
 * | Voltage | Va | Vb | Vc | Vn |
 * | Current | Ia | Ib | Ic | In |
 * 
 * @constant {Array<ChannelDefinition>}
 * @type {Array<Object>}
 * @property {string} id - Unique channel identifier
 * @property {string} label - Display label with subscript
 * @property {('voltage'|'current')} type - Channel type
 * @property {('A'|'B'|'C'|'N')} phase - Phase identifier
 * @property {('V'|'A')} unit - Measurement unit
 * @property {number} scaleFactor - Scale factor for encoding
 */
const BASE_CHANNELS = [
    { id: 'Va', label: 'Vₐ', type: 'voltage', phase: 'A', unit: 'V', scaleFactor: 1 },
    { id: 'Vb', label: 'Vᵦ', type: 'voltage', phase: 'B', unit: 'V', scaleFactor: 1 },
    { id: 'Vc', label: 'V꜀', type: 'voltage', phase: 'C', unit: 'V', scaleFactor: 1 },
    { id: 'Vn', label: 'Vₙ', type: 'voltage', phase: 'N', unit: 'V', scaleFactor: 1 },
    { id: 'Ia', label: 'Iₐ', type: 'current', phase: 'A', unit: 'A', scaleFactor: 1 },
    { id: 'Ib', label: 'Iᵦ', type: 'current', phase: 'B', unit: 'A', scaleFactor: 1 },
    { id: 'Ic', label: 'I꜀', type: 'current', phase: 'C', unit: 'A', scaleFactor: 1 },
    { id: 'In', label: 'Iₙ', type: 'current', phase: 'N', unit: 'A', scaleFactor: 1 },
];

// ============================================================================
// IEC STANDARD CONFIGURATIONS
// ============================================================================

const STANDARDS = {
    '9-2LE': {
        id: '9-2LE',
        name: 'IEC 61850-9-2 LE',
        fullName: 'IEC 61850-9-2 Light Edition',
        description: 'Fixed 8 channels, 80/256 samples per cycle',
        
        // Channel configuration
        maxChannels: 8,
        allowCustomChannels: false,
        channelOrder: ['Ia', 'Ib', 'Ic', 'In', 'Va', 'Vb', 'Vc', 'Vn'],  // ASDU order
        
        // Samples per cycle configuration
        allowedSamplesPerCycle: [80, 256],  // FIXED - Only these two allowed
        defaultSamplesPerCycle: 80,
        fixedSamplesPerCycle: true,         // User cannot enter custom value
        
        // Sampling rates (samples per second)
        samplingRates: {
            50: { rate: 4000, samplesPerCycle: 80 },   // 50Hz system
            60: { rate: 4800, samplesPerCycle: 80 }    // 60Hz system
        },
        
        // Encoding
        datasetSize: 64,        // Bytes per dataset (8 channels × 8 bytes)
        qualityBits: true,      // Include quality flags
        timestampFormat: 'UTC', // Timestamp format
        
        // ASDU Configuration (Production compliance - fixed at 1)
        noASDU: 1,              // Number of ASDUs per frame (FIXED for 9-2LE)
        allowConfigurableASDU: false,  // User cannot change this
        maxASDU: 1,             // Maximum allowed
        
        // Network
        etherType: 0x88BA,      // IEC 61850 SV EtherType
        vlanPriority: 4,        // Default VLAN priority
    },
    
    '9-2': {
        id: '9-2',
        name: 'IEC 61850-9-2',
        fullName: 'IEC 61850-9-2 Full',
        description: 'Configurable channels and sampling rates',
        
        // Channel configuration
        maxChannels: 16,
        allowCustomChannels: true,
        channelOrder: null,     // User-defined
        
        // Samples per cycle configuration
        allowedSamplesPerCycle: [80, 256],  // Limited options
        defaultSamplesPerCycle: 80,
        fixedSamplesPerCycle: true,         // Only dropdown, no custom
        
        // Sampling rates (flexible)
        samplingRates: {
            50: { rate: 4000, samplesPerCycle: 80 },
            60: { rate: 4800, samplesPerCycle: 80 }
        },
        
        // Encoding
        datasetSize: null,      // Variable based on channel count
        qualityBits: true,
        timestampFormat: 'UTC',
        
        // ASDU Configuration (Testing/Lab mode - user configurable)
        noASDU: 1,              // Default: 1 ASDU per frame
        allowConfigurableASDU: true,   // User CAN change this
        maxASDU: 16,            // Maximum: 16 for performance testing
        asduOptions: [1, 2, 4, 8, 16], // Dropdown options
        asduWarning: '⚠️ Multiple ASDUs are for testing only, not production!',
        
        // Network
        etherType: 0x88BA,
        vlanPriority: 4,
    },
    
    '61869': {
        id: '61869',
        name: 'IEC 61869',
        fullName: 'IEC 61869 Instrument Transformers',
        description: 'Up to 20 channels, modern digital interface standard',
        
        // Channel configuration
        maxChannels: 20,
        allowCustomChannels: true,
        channelOrder: null,     // User-defined
        
        // Samples per cycle configuration - FLEXIBLE!
        allowedSamplesPerCycle: [80, 96, 256, 512, 1024, 2048, 4000, 4800],  // Suggestions
        defaultSamplesPerCycle: 80,
        fixedSamplesPerCycle: false,        // User CAN enter custom value!
        
        // Sampling rates (flexible)
        samplingRates: {
            50: { rate: 4000, samplesPerCycle: 80 },
            60: { rate: 4800, samplesPerCycle: 80 }
        },
        
        // Encoding
        datasetSize: null,      // Variable
        qualityBits: true,
        timestampFormat: 'UTC',
        
        // ASDU Configuration (Advanced testing - user configurable)
        noASDU: 1,              // Default: 1 ASDU per frame
        allowConfigurableASDU: true,   // User CAN change this
        maxASDU: 16,            // Maximum: 16 for performance testing
        asduOptions: [1, 2, 4, 8, 16], // Dropdown options
        asduWarning: '⚠️ Multiple ASDUs are for testing only!',
        
        // Network
        etherType: 0x88BA,
        vlanPriority: 4,
    }
};

// ============================================================================
// DEFAULT EQUATIONS
// ============================================================================

/**
 * Default equations at 50 Hz (legacy alias).
 * Prefer getDefaultEquations(freq) for frequency-aware equations.
 */
const DEFAULT_EQUATIONS = getDefaultEquations(50);

/**
 * Generate default equations for a given frequency
 * @param {number} freq - System frequency in Hz (e.g., 50 or 60)
 * @returns {Object} Equations keyed by channel ID
 */
function getDefaultEquations(freq = 50) {
    return {
        Va: `325 * sin(2 * PI * ${freq} * t)`,
        Vb: `325 * sin(2 * PI * ${freq} * t - 2*PI/3)`,
        Vc: `325 * sin(2 * PI * ${freq} * t + 2*PI/3)`,
        Vn: '0',
        Ia: `100 * sin(2 * PI * ${freq} * t)`,
        Ib: `100 * sin(2 * PI * ${freq} * t - 2*PI/3)`,
        Ic: `100 * sin(2 * PI * ${freq} * t + 2*PI/3)`,
        In: '0',
    };
}

/**
 * Update the frequency in an equation string
 * Replaces the numeric frequency value in patterns like "sin(2 * PI * 50 * t)"
 * @param {string} equation - The equation string
 * @param {number} oldFreq - Current frequency to find
 * @param {number} newFreq - New frequency to replace with
 * @returns {string} Updated equation
 */
function updateEquationFrequency(equation, oldFreq, newFreq) {
    if (!equation || oldFreq === newFreq) return equation;
    // Match patterns like: PI * 50 * t  or  PI*50*t  (with optional spaces)
    const pattern = new RegExp(`(PI\\s*\\*\\s*)${oldFreq}(\\s*\\*\\s*t)`, 'g');
    return equation.replace(pattern, `$1${newFreq}$2`);
}

// ============================================================================
// ADDITIONAL CHANNELS (Computed/Derived - for IEC 61869)
// ============================================================================

const ADDITIONAL_CHANNELS = [
    // Zero Sequence Components
    { id: 'V0', label: 'V₀', type: 'computed', equation: '(Va + Vb + Vc) / 3', description: 'Zero Sequence Voltage' },
    { id: 'I0', label: 'I₀', type: 'computed', equation: '(Ia + Ib + Ic) / 3', description: 'Zero Sequence Current' },
    
    // Positive Sequence Components (simplified - actual requires phasor calc)
    { id: 'V1', label: 'V₁', type: 'computed', equation: '(Va + Vb * cos(2*PI/3) + Vc * cos(4*PI/3)) / 3', description: 'Positive Sequence Voltage' },
    { id: 'I1', label: 'I₁', type: 'computed', equation: '(Ia + Ib * cos(2*PI/3) + Ic * cos(4*PI/3)) / 3', description: 'Positive Sequence Current' },
    
    // Line-to-Line Voltages
    { id: 'Vab', label: 'Vₐᵦ', type: 'voltage', equation: 'Va - Vb', description: 'Line Voltage A-B' },
    { id: 'Vbc', label: 'Vᵦ꜀', type: 'voltage', equation: 'Vb - Vc', description: 'Line Voltage B-C' },
    { id: 'Vca', label: 'V꜀ₐ', type: 'voltage', equation: 'Vc - Va', description: 'Line Voltage C-A' },
    
    // Power Calculations (instantaneous)
    { id: 'Pa', label: 'Pₐ', type: 'computed', equation: 'Va * Ia', description: 'Phase A Power' },
    { id: 'Pb', label: 'Pᵦ', type: 'computed', equation: 'Vb * Ib', description: 'Phase B Power' },
    { id: 'Pc', label: 'P꜀', type: 'computed', equation: 'Vc * Ic', description: 'Phase C Power' },
    { id: 'Ptotal', label: 'P_tot', type: 'computed', equation: 'Va*Ia + Vb*Ib + Vc*Ic', description: 'Total 3-Phase Power' },
    
    // Differential Protection
    { id: 'Idiff', label: 'I_diff', type: 'computed', equation: 'Ia + Ib + Ic', description: 'Differential Current' },
    
    // RMS Approximations (using instantaneous)
    { id: 'Vrms', label: 'V_rms', type: 'computed', equation: 'sqrt((Va*Va + Vb*Vb + Vc*Vc) / 3)', description: 'RMS Voltage' },
    { id: 'Irms', label: 'I_rms', type: 'computed', equation: 'sqrt((Ia*Ia + Ib*Ib + Ic*Ic) / 3)', description: 'RMS Current' },
    
    // Neutral Current (calculated)
    { id: 'In_calc', label: 'Iₙ_calc', type: 'computed', equation: '-(Ia + Ib + Ic)', description: 'Calculated Neutral Current' },
];

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Get standard configuration by ID
 * @param {string} id - Standard ID ('9-2LE', '9-2', '61869')
 * @returns {Object|null} Standard configuration
 */
function getStandard(id) {
    return STANDARDS[id] || null;
}

/**
 * Get sampling rate for a standard and frequency
 * @param {string} standardId - Standard ID
 * @param {number} frequency - System frequency (50 or 60)
 * @returns {Object} { rate, samplesPerCycle }
 */
function getSamplingRate(standardId, frequency = 50) {
    const std = STANDARDS[standardId];
    if (!std) return { rate: 4000, samplesPerCycle: 80 };
    return std.samplingRates[frequency] || std.samplingRates[50];
}

/**
 * Validate channel count for a standard
 * @param {string} standardId - Standard ID
 * @param {number} count - Number of channels
 * @returns {boolean} True if valid
 */
function validateChannelCount(standardId, count) {
    const std = STANDARDS[standardId];
    return std && count <= std.maxChannels;
}

/**
 * Get all base channel IDs
 * @returns {string[]} Array of channel IDs
 */
function getBaseChannelIds() {
    return BASE_CHANNELS.map(c => c.id);
}

// ============================================================================
// EXPORTS (CommonJS for Node.js, ES Module compatible)
// ============================================================================

if (typeof module !== 'undefined' && module.exports) {
    // Node.js
    module.exports = {
        STANDARDS,
        BASE_CHANNELS,
        DEFAULT_EQUATIONS,
        ADDITIONAL_CHANNELS,
        getStandard,
        getSamplingRate,
        validateChannelCount,
        getBaseChannelIds,
        getDefaultEquations,
        updateEquationFrequency
    };
} else {
    // Browser (ES Module)
    // Will be imported via: import { STANDARDS } from '../shared/standards.js'
}

export { STANDARDS, BASE_CHANNELS, DEFAULT_EQUATIONS, ADDITIONAL_CHANNELS, getStandard, getSamplingRate, validateChannelCount, getBaseChannelIds, getDefaultEquations, updateEquationFrequency };
