/**
 * @file expressionConverter.js
 * @fileoverview LaTeX to Math.js Expression Converter
 * @module expressionConverter
 * @author SV-PUB Team
 * @description
 * Provides bidirectional conversion between LaTeX (from MathLive editor)
 * and math.js expression format for computation.
 * 
 * @example
 * import { convertLatexToMathJs, convertMathJsToLatex } from './utils/expressionConverter.js';
 * convertLatexToMathJs('\\sqrt{I_{A}^2}'); // "sqrt(IA^2)"
 * convertMathJsToLatex('325 * sin(2*PI*50*t)'); // "325 \\cdot \\sin{2\\pi 50t}"
 */

/**
 * Convert LaTeX expression to math.js compatible format
 * @memberof module:expressionConverter
 * @param {string} latex - LaTeX expression from MathLive editor
 * @returns {string} math.js compatible expression
 * @example
 * convertLatexToMathJs('\\sqrt{I_{A}^2+I_{B}^2}'); // "sqrt(IA^2+IB^2)"
 */
export function convertLatexToMathJs(latex) {
    if (!latex) return "";

    let expr = latex.trim();

    // Convert subscripts: I_{A} → IA, I_{B} → IB, etc.
    expr = expr.replace(/([A-Za-z])_\{([A-Za-z0-9]+)\}/g, "$1$2");

    // Convert sqrt: \sqrt{x} → sqrt(x)
    expr = expr.replace(/\\sqrt\{([^}]+)\}/g, "sqrt($1)");

    // Convert fractions: \frac{a}{b} → (a)/(b)
    expr = expr.replace(/\\frac\{([^}]+)\}\{([^}]+)\}/g, "($1)/($2)");

    // Convert functions: \operatorname{func} → func
    expr = expr.replace(
        /\\operatorname\{RMS\}\s*\\left\(\s*([^)]+)\s*\\right\)/gi,
        "sqrt(mean(($1)^2))"
    );
    expr = expr.replace(
        /\\operatorname\{AVG\}\s*\\left\(\s*([^)]+)\s*\\right\)/gi,
        "mean($1)"
    );
    expr = expr.replace(/\\operatorname\{([^}]+)\}/g, "$1");

    // Convert operators
    expr = expr.replace(/\\cdot/g, "*");
    expr = expr.replace(/\\times/g, "*");

    // Convert absolute value: \left|a\right| or \left\lvert a \right\rvert → abs(a)
    expr = expr.replace(/\\left\\lvert\s*([^\\]*)\s*\\right\\rvert/g, "abs($1)");
    expr = expr.replace(/\\left\|\s*([\s\S]*?)\s*\\right\|/g, "abs($1)");

    // Convert parentheses
    expr = expr.replace(/\\left\(/g, "(");
    expr = expr.replace(/\\right\)/g, ")");

    // Convert power: ^{n} → ^(n) for math.js compatibility
    expr = expr.replace(/\^\{([^}]+)\}/g, "^($1)");

    // ⚠ IMPORTANT: map known LaTeX tokens BEFORE the catch-all strip below,
    // otherwise \pi and \sin get silently deleted and equations like
    // "325 * sin(2 * PI * 60 * t)" come back as broken garbage.
    expr = expr.replace(/\\pi\b/g, "PI");
    expr = expr.replace(/\\(sin|cos|tan|asin|acos|atan|sinh|cosh|tanh|exp|log|ln)\b/g, "$1");
    // Math.js uses `log` (natural). Map LaTeX \ln → log accordingly.
    expr = expr.replace(/\bln\(/g, "log(");

    // Remove any LaTeX commands we don't recognize (must come AFTER the
    // explicit token mappings above).
    expr = expr.replace(/\\[a-zA-Z]+/g, "");
    expr = expr.replace(/[\{\}]/g, ""); // Remove braces

    return expr.trim();
}

/**
 * Convert math.js expression to LaTeX for display
 * @memberof module:expressionConverter
 * @param {string} equation - Math.js format equation
 * @returns {string} LaTeX formatted equation
 * @example
 * convertMathJsToLatex('sqrt(Va^2+Vb^2)'); // "\\sqrt{V_a^{2}+V_b^{2}}"
 */
export function convertMathJsToLatex(equation) {
    if (!equation) return "";

    let latex = equation;

    // Handle sqrt(expr) -> \sqrt{expr}
    while (latex.includes("sqrt(")) {
        let startIdx = latex.indexOf("sqrt(");
        let openCount = 1;
        let endIdx = startIdx + 5;

        while (endIdx < latex.length && openCount > 0) {
            if (latex[endIdx] === "(") openCount++;
            else if (latex[endIdx] === ")") openCount--;
            endIdx++;
        }

        const inner = latex.substring(startIdx + 5, endIdx - 1);
        latex = latex.substring(0, startIdx) + "\\sqrt{" + inner + "}" + latex.substring(endIdx);
    }

    // Convert abs(...) → \left|...\right| with balanced parens.
    // The previous regex pair turned EVERY trailing ")" into "\right|",
    // which corrupted any equation ending in a paren (e.g. sin(...)) — and
    // then the reverse converter dropped \pi while stripping artifacts,
    // mangling the equation. This walker only rewrites actual abs() calls.
    {
        let i = latex.indexOf('abs(');
        while (i !== -1) {
            let depth = 1;
            let j = i + 4;
            while (j < latex.length && depth > 0) {
                if (latex[j] === '(') depth++;
                else if (latex[j] === ')') depth--;
                if (depth === 0) break;
                j++;
            }
            if (depth !== 0) break; // unbalanced — bail rather than corrupt
            latex = latex.substring(0, i)
                  + '\\left|' + latex.substring(i + 4, j) + '\\right|'
                  + latex.substring(j + 1);
            i = latex.indexOf('abs(', i + 1);
        }
    }

    // Convert power notation
    latex = latex.replace(/\^(\d+)/g, "^{$1}");
    latex = latex.replace(/\^\(([^)]+)\)/g, "^{$1}");

    // Convert multiplication
    latex = latex.replace(/\*/g, " \\cdot ");

    // Convert PI
    latex = latex.replace(/\bPI\b/gi, "\\pi");

    // Map function names so MathLive renders them as proper operators.
    // Without this, unprefixed `sin` may render as italic identifiers, and
    // the round-trip back through convertLatexToMathJs gets ambiguous.
    latex = latex.replace(/\b(sin|cos|tan|asin|acos|atan|sinh|cosh|tanh|exp)\b/g, "\\$1");
    latex = latex.replace(/\blog\b/g, "\\ln");

    // Convert channel names with subscripts: Va → V_a, IA → I_A
    latex = latex.replace(/\b([VI])([abc])\b/gi, "$1_{$2}");

    return latex;
}
