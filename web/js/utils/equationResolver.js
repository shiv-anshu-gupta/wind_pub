/**
 * @file equationResolver.js
 * @fileoverview Equation Resolution for Computed/Derived Channels
 * @module equationResolver
 * @description
 * Resolves computed channel equations (e.g., "(Va + Vb + Vc) / 3") into
 * pre-computed wavetable format that the C++ equation processor can use.
 * 
 * The C++ equation processor only handles simple sinusoidal equations like
 * "325 * sin(2 * PI * 50 * t)". Computed channels that reference other
 * channel IDs need to be evaluated in JavaScript (using math.js) and the
 * resulting sample values are sent as a wavetable string: "WT:count:v1,v2,v3,..."
 * 
 * @example
 * import { resolveChannelEquations } from './utils/equationResolver.js';
 * const resolved = resolveChannelEquations(channels, frequency, sampleRate);
 * // resolved channels now have wavetable-format equations for computed channels
 */

/**
 * Known base channel IDs that can appear in computed equations
 * @const {string[]}
 */
const CHANNEL_ID_PATTERN = /\b(Va|Vb|Vc|Vn|Ia|Ib|Ic|In|V0|I0|V1|I1|Vab|Vbc|Vca|Pa|Pb|Pc|Ptotal|Idiff|Vrms|Irms|In_calc)\b/;

/**
 * Check if an equation references other channel IDs (i.e., is a computed/derived channel)
 * @param {string} equation - The equation string
 * @param {string[]} allChannelIds - All known channel IDs
 * @returns {boolean} True if the equation references other channels
 */
export function isComputedEquation(equation, allChannelIds) {
    if (!equation || equation === '0' || equation === '0.0') return false;
    
    // Wavetable strings are already in final form — never treat as computed
    if (equation.startsWith('WT:') || equation.startsWith('WTS:')) return false;
    
    // Step response equations are native C++ — never treat as computed
    if (equation.includes('u(t')) return false;
    
    // Check if it looks like a simple sinusoidal (has sin/cos and no channel refs)
    const hasTrigFunction = /\b(sin|cos)\s*\(/.test(equation);
    const hasTimeVariable = /\bt\b/.test(equation);
    
    // Check if equation contains any channel ID as a word boundary match
    for (const id of allChannelIds) {
        // Use word boundary to avoid matching partial names (e.g., "Va" in "Vab")
        const regex = new RegExp(`\\b${escapeRegex(id)}\\b`);
        if (regex.test(equation)) {
            return true; // References another channel
        }
    }
    
    // If it has sin/cos with t variable, it's a direct sinusoidal - not computed
    if (hasTrigFunction && hasTimeVariable) return false;
    
    // If it doesn't have sin/cos and doesn't reference other channels,
    // check if it's a simple constant (which the C++ parser can handle as "0")
    // or something the C++ parser can't handle
    const isSimpleNumber = /^-?\d+(\.\d+)?$/.test(equation.trim());
    if (isSimpleNumber) return false;
    
    // Has no trig and no channel refs but is complex - might still fail in C++
    // Conservative: mark as computed if it doesn't look sinusoidal
    if (!hasTrigFunction) return true;
    
    return false;
}

/**
 * Escape special regex characters in a string
 * @param {string} str 
 * @returns {string}
 */
function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Topologically sort channels - base/independent channels first, dependent channels later.
 * This ensures that when evaluating a computed channel, its dependencies are already available.
 * @param {Array} channels - Array of channel objects with {id, equation}
 * @param {string[]} allChannelIds - All known channel IDs
 * @returns {Array} Sorted channels (independent first)
 */
function topologicalSort(channels, allChannelIds) {
    const independent = [];
    const dependent = [];
    
    for (const ch of channels) {
        if (isComputedEquation(ch.equation, allChannelIds)) {
            dependent.push(ch);
        } else {
            independent.push(ch);
        }
    }
    
    // For now, simple two-level sort: base first, computed second
    // For deeper dependency chains, would need full topological sort
    return [...independent, ...dependent];
}

/**
 * Get channel dependencies (which other channels does this equation reference?)
 * @param {string} equation - The equation string
 * @param {string[]} allChannelIds - All known channel IDs
 * @returns {string[]} Array of referenced channel IDs
 */
export function getChannelDependencies(equation, allChannelIds) {
    const deps = [];
    for (const id of allChannelIds) {
        const regex = new RegExp(`\\b${escapeRegex(id)}\\b`);
        if (regex.test(equation)) {
            deps.push(id);
        }
    }
    return deps;
}

/**
 * Resolve computed channel equations into wavetable format.
 * 
 * For each computed channel (one that references other channel IDs),
 * evaluates the equation over one cycle using math.js and converts
 * the result into the wavetable string format: "WT:count:v1,v2,v3,..."
 * 
 * @param {Array} channels - Array of channel objects [{id, equation, type, isBase, label}]
 * @param {number} frequency - System frequency (50 or 60 Hz)
 * @param {number} sampleRate - Sample rate (e.g., 4000, 4800)
 * @returns {Array} New channel array with resolved equations
 */
export function resolveChannelEquations(channels, frequency, sampleRate) {
    const math = window.math;
    if (!math) {
        console.warn('[equationResolver] math.js not available, returning channels as-is');
        return channels;
    }
    
    const allChannelIds = channels.map(ch => ch.id);
    const samplesPerCycle = Math.round(sampleRate / frequency);
    const dt = 1.0 / sampleRate;
    const SCALE_FACTOR = 1000.0; // Must match C++ EqChannelData.scaleFactor
    
    console.log(`[equationResolver] Resolving ${channels.length} channels (freq=${frequency}, rate=${sampleRate}, samplesPerCycle=${samplesPerCycle})`);
    
    // Sort: independent channels first  
    const sorted = topologicalSort(channels, allChannelIds);
    
    // Pre-compute ALL channel values in topological order
    // (base channels first, then computed channels that may reference earlier ones)
    const channelValues = {};  // id -> Float64Array of one cycle
    const computedWavetables = {};  // id -> Int32Array (for computed channels)
    
    for (const ch of sorted) {
        const isComputed = isComputedEquation(ch.equation, allChannelIds);
        
        if (!isComputed) {
            // Base/sinusoidal channel - evaluate its equation directly
            const values = new Float64Array(samplesPerCycle);
            if (ch.equation && ch.equation !== '0' && ch.equation !== '0.0') {
                try {
                    const compiled = math.compile(ch.equation);
                    for (let i = 0; i < samplesPerCycle; i++) {
                        const t = i * dt;
                        try {
                            values[i] = compiled.evaluate({ t, PI: Math.PI, E: Math.E, pi: Math.PI, e: Math.E });
                        } catch (e) {
                            values[i] = 0;
                        }
                    }
                } catch (e) {
                    console.warn(`[equationResolver] Failed to compile ${ch.id}: ${e.message}`);
                }
            }
            channelValues[ch.id] = values;
        } else {
            // Computed channel - evaluate using all previously computed channel values
            console.log(`[equationResolver] Resolving computed channel: ${ch.id} = ${ch.equation}`);
            
            const values = new Float64Array(samplesPerCycle);
            const wavetable = new Int32Array(samplesPerCycle);
            
            try {
                const compiled = math.compile(ch.equation);
                
                for (let i = 0; i < samplesPerCycle; i++) {
                    // Build scope with time + all previously computed channel values
                    const scope = {
                        t: i * dt,
                        PI: Math.PI,
                        E: Math.E,
                        pi: Math.PI,
                        e: Math.E,
                        f: frequency,
                    };
                    
                    // Add all previously computed channel values to scope
                    for (const [id, vals] of Object.entries(channelValues)) {
                        scope[id] = vals[i];
                    }
                    
                    try {
                        const value = Number(compiled.evaluate(scope)) || 0;
                        values[i] = value;
                        wavetable[i] = Math.round(value * SCALE_FACTOR);
                    } catch (e) {
                        values[i] = 0;
                        wavetable[i] = 0;
                    }
                }
                
                console.log(`[equationResolver] ✅ ${ch.id}: ${samplesPerCycle} samples (first 5: ${Array.from(wavetable.slice(0, 5)).join(', ')})`);
            } catch (e) {
                console.error(`[equationResolver] ❌ Failed to resolve ${ch.id}: ${e.message}`);
            }
            
            channelValues[ch.id] = values;
            computedWavetables[ch.id] = wavetable;
        }
    }
    
    // Build result: replace computed channel equations with wavetable format
    const resolvedChannels = channels.map(ch => {
        if (computedWavetables[ch.id]) {
            const wavetable = computedWavetables[ch.id];
            const wtString = `WT:${samplesPerCycle}:${Array.from(wavetable).join(',')}`;
            return {
                ...ch,
                equation: wtString,
                _originalEquation: ch.equation,
            };
        }
        return { ...ch };  // Base channel - pass through unchanged
    });
    
    return resolvedChannels;
}

/**
 * Check if any channels in the array are computed/derived
 * @param {Array} channels - Channel array
 * @returns {boolean} True if any channels need resolution
 */
export function hasComputedChannels(channels) {
    const allIds = channels.map(ch => ch.id);
    return channels.some(ch => isComputedEquation(ch.equation, allIds));
}
