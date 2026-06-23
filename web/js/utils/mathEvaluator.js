/**
 * @file mathEvaluator.js
 * @fileoverview Math Expression Compilation and Evaluation Engine
 * @module mathEvaluator
 * @author SV-PUB Team
 * @description
 * Provides utilities for compiling and evaluating mathematical expressions
 * using math.js library. Used for generating SV channel waveforms.
 * 
 * **Features:**
 * - Expression caching for performance
 * - Pre-allocated scope templates
 * - Batch sample evaluation
 * - Expression validation
 * 
 * @example
 * import { getCompiledExpression, evaluateSamples } from './utils/mathEvaluator.js';
 * const compiled = getCompiledExpression('325 * sin(2 * PI * 50 * t)');
 * const samples = evaluateSamples(compiled, 4000, 50, 4000);
 */

/** @private */
const compiledExpressionCache = new Map();

/**
 * Get or compile a math.js expression with caching
 * @memberof module:mathEvaluator
 * @param {string} expression - Math.js compatible expression string
 * @param {Object} [mathLib=null] - math.js library object (defaults to window.math)
 * @returns {Object} Compiled expression
 * @throws {Error} If math.js is not available or expression is invalid
 */
export function getCompiledExpression(expression, mathLib = null) {
    const math = mathLib || window.math;
    
    if (!math) {
        throw new Error("Math.js not available. Please include mathjs CDN.");
    }

    const cacheKey = expression;

    if (compiledExpressionCache.has(cacheKey)) {
        return compiledExpressionCache.get(cacheKey);
    }

    try {
        const compiled = math.compile(expression);
        compiledExpressionCache.set(cacheKey, compiled);
        return compiled;
    } catch (e) {
        console.error("[MathEvaluator] Failed to compile:", expression, e.message);
        throw e;
    }
}

/**
 * Clear the expression cache
 * @memberof module:mathEvaluator
 */
export function clearExpressionCache() {
    compiledExpressionCache.clear();
}

/**
 * Pre-allocate scope object template to reduce GC pressure
 * @memberof module:mathEvaluator
 * @param {number} [channelCount=8] - Number of channels
 * @returns {Object} Pre-allocated scope object
 */
export function createScopeTemplate(channelCount = 8) {
    const scope = {
        // Time variable
        t: 0,
        // Math constants
        PI: Math.PI,
        E: Math.E,
        // Frequency (default 50Hz)
        f: 50,
        // Sample rate
        smpRate: 4000
    };

    // Pre-allocate channel variables (Va, Vb, Vc, Vn, Ia, Ib, Ic, In)
    const channels = ['Va', 'Vb', 'Vc', 'Vn', 'Ia', 'Ib', 'Ic', 'In'];
    channels.forEach(ch => {
        scope[ch] = 0;
    });

    // Also add indexed versions (a0, a1, ... for analog)
    for (let i = 0; i < channelCount; i++) {
        scope[`a${i}`] = 0;
    }

    return scope;
}

/**
 * Evaluate an expression for a single time point
 * @memberof module:mathEvaluator
 * @param {Object} compiled - Compiled math.js expression
 * @param {Object} scope - Scope with variable values
 * @returns {number} Evaluated result
 */
export function evaluateSingle(compiled, scope) {
    try {
        const value = compiled.evaluate(scope);
        return Number(value) || 0;
    } catch (e) {
        return NaN;
    }
}

/**
 * Evaluate expression for multiple samples (SV Publisher use case)
 * @memberof module:mathEvaluator
 * @param {Object} compiled - Compiled math.js expression
 * @param {number} sampleCount - Number of samples to generate
 * @param {number} [frequency=50] - System frequency (50 or 60 Hz)
 * @param {number} [smpRate=4000] - Sample rate
 * @param {Object} [baseScope={}] - Base scope with additional variables
 * @returns {Float64Array} Array of evaluated results
 */
export function evaluateSamples(compiled, sampleCount, frequency = 50, smpRate = 4000, baseScope = {}) {
    const results = new Float64Array(sampleCount);
    const dt = 1 / smpRate; // Time step

    // Create scope with base values
    const scope = {
        ...createScopeTemplate(),
        ...baseScope,
        f: frequency,
        smpRate: smpRate,
        PI: Math.PI,
        E: Math.E
    };

    for (let i = 0; i < sampleCount; i++) {
        scope.t = i * dt;
        scope.n = i; // Sample index

        try {
            results[i] = Number(compiled.evaluate(scope)) || 0;
        } catch (e) {
            results[i] = 0;
        }
    }

    return results;
}

/**
 * Calculate statistics from results array
 * @memberof module:mathEvaluator
 * @param {Float64Array|Array} results - Array of values
 * @returns {Object} Statistics object with count, min, max, avg, rms
 */
export function calculateStats(results) {
    const arr = Array.from(results);
    const validResults = arr.filter(v => !isNaN(v) && isFinite(v));

    if (validResults.length === 0) {
        return {
            count: arr.length,
            validCount: 0,
            min: 0,
            max: 0,
            avg: 0,
            rms: 0
        };
    }

    const min = Math.min(...validResults);
    const max = Math.max(...validResults);
    const sum = validResults.reduce((a, b) => a + b, 0);
    const avg = sum / validResults.length;
    const sumSquares = validResults.reduce((a, b) => a + b * b, 0);
    const rms = Math.sqrt(sumSquares / validResults.length);

    return {
        count: arr.length,
        validCount: validResults.length,
        min,
        max,
        avg,
        rms
    };
}

/**
 * Validate expression syntax without executing
 * @memberof module:mathEvaluator
 * @param {string} expression - Math.js expression to validate
 * @param {Object} [mathLib=null] - math.js library object
 * @returns {Object} Validation result {valid, error}
 */
export function validateExpression(expression, mathLib = null) {
    const math = mathLib || window.math;
    
    if (!math) {
        return { valid: false, error: "Math.js not available" };
    }

    if (!expression || !expression.trim()) {
        return { valid: false, error: "Expression is empty" };
    }

    try {
        math.compile(expression);
        return { valid: true };
    } catch (error) {
        return {
            valid: false,
            error: error.message
        };
    }
}

/**
 * Test evaluate an expression with sample values
 * @memberof module:mathEvaluator
 * @param {string} expression - Expression to test
 * @param {Object} [testScope={t:0, PI:Math.PI}] - Test scope values
 * @returns {Object} Test result {valid, result, error}
 */
export function testExpression(expression, testScope = { t: 0, PI: Math.PI }) {
    try {
        const compiled = getCompiledExpression(expression);
        const result = compiled.evaluate(testScope);
        return {
            valid: true,
            result: Number(result)
        };
    } catch (error) {
        return {
            valid: false,
            error: error.message
        };
    }
}
