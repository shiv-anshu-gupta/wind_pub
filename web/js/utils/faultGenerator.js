/**
 * @file faultGenerator.js
 * @brief Step response equation generator for IEC 61850-9-2 SV fault transients.
 *
 * Generates readable step response equation strings using u(t-T) Heaviside
 * step functions. The C++ backend parses and evaluates these natively.
 *
 * Example output:
 *   "325 * sin(2*PI*60*t) * (1 - 0.85*u(t-0.5) + 0.85*u(t-0.7))"
 */

/**
 * Determine a standard channel's fault role from its ID.
 * @param {string} channelId - e.g. "Va", "Ia", "Ch9"
 * @returns {{ type: string, phase: string }}
 */
export function getChannelFaultRole(channelId) {
  const id = channelId.toLowerCase();
  if (id === 'va' || id === 'vb' || id === 'vc')
    return { type: 'voltage', phase: id[1].toUpperCase() };
  if (id === 'ia' || id === 'ib' || id === 'ic')
    return { type: 'current', phase: id[1].toUpperCase() };
  if (id === 'vn') return { type: 'voltage', phase: 'N' };
  if (id === 'in') return { type: 'current', phase: 'N' };
  return { type: 'other', phase: '' };
}

/**
 * Format a phase offset as a string suffix for the sin() argument.
 * @param {string} phase - "A", "B", "C", or "N"
 * @returns {string} e.g. "" for A, " - 2*PI/3" for B, " + 2*PI/3" for C
 */
function phaseOffsetStr(phase) {
  if (phase === 'B') return ' - 2*PI/3';
  if (phase === 'C') return ' + 2*PI/3';
  return '';
}

/**
 * Generate a step response equation string for a single channel.
 *
 * @param {Object} opts
 * @param {string}   opts.channelType      - "voltage" or "current"
 * @param {string}   opts.channelPhase     - "A", "B", "C", "N"
 * @param {string[]} opts.faultedPhases    - Phases involved, e.g. ["A"] or ["A","B"]
 * @param {number}   opts.frequency        - System frequency (50 or 60)
 * @param {number}   opts.t1               - Pre-fault end / fault start time (seconds)
 * @param {number}   opts.t2               - Fault end time (seconds)
 * @param {number}   opts.nominalAmplitude - Normal amplitude of this channel
 * @param {number}   opts.voltageSag       - Voltage sag fraction (e.g. 0.85 = 85% drop)
 * @param {number}   opts.faultMultiplier  - Current fault multiplier (e.g. 20)
 * @returns {string} Step response equation string
 */
export function generateStepEquation({
  channelType,
  channelPhase,
  faultedPhases,
  frequency,
  t1,
  t2,
  nominalAmplitude,
  voltageSag = 0.85,
  faultMultiplier = 20,
}) {
  const isNeutral = channelPhase === 'N';
  const isFaulted = faultedPhases.includes(channelPhase);

  // Neutral channels → "0"
  if (isNeutral) return '0';

  const amp = nominalAmplitude;
  const phOff = phaseOffsetStr(channelPhase);
  const sinPart = `${amp} * sin(2*PI*${frequency}*t${phOff})`;

  // Unfaulted channels → plain sinusoidal
  if (!isFaulted) return sinPart;

  // Faulted voltage: amp * sin(...) * (1 - sag*u(t-t1) + sag*u(t-t2))
  if (channelType === 'voltage') {
    const sag = voltageSag;
    return `${sinPart} * (1 - ${sag}*u(t-${t1}) + ${sag}*u(t-${t2}))`;
  }

  // Faulted current: amp * sin(...) * (1 + (mult-1)*u(t-t1) - mult*u(t-t2))
  const mult = faultMultiplier;
  const coeff1 = mult - 1;
  return `${sinPart} * (1 + ${coeff1}*u(t-${t1}) - ${mult}*u(t-${t2}))`;
}

/**
 * Map fault type string to the set of faulted phases.
 * @param {string} faultType - "ag","bg","cg","ab","bc","ca","3ph"
 * @returns {string[]} Array of phase letters
 */
export function getFaultedPhases(faultType) {
  switch (faultType) {
    case 'ag': return ['A'];
    case 'bg': return ['B'];
    case 'cg': return ['C'];
    case 'ab': return ['A', 'B'];
    case 'bc': return ['B', 'C'];
    case 'ca': return ['C', 'A'];
    case '3ph': return ['A', 'B', 'C'];
    default: return [];
  }
}
