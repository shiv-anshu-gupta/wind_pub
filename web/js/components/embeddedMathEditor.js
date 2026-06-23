/**
 * @file embeddedMathEditor.js
 * @fileoverview Inline Equation Editor using MathLive
 * @module embeddedMathEditor
 * @description
 * Provides an inline math equation editor for SV channel waveforms.
 * Uses MathLive library for LaTeX input and converts to math.js format.
 */

import { showToast } from '../plugins/toast.js';
import { convertLatexToMathJs, convertMathJsToLatex } from '../utils/expressionConverter.js';
import { validateExpression, testExpression, evaluateSamples, calculateStats } from '../utils/mathEvaluator.js';
import { store, BASE_CHANNELS } from '../store/index.js';
import { generateStepEquation, getChannelFaultRole, getFaultedPhases } from '../utils/faultGenerator.js';
import { getMagnitudeFromEquation, setMagnitudeInEquation } from './channelColumnPicker.js';

/** @private */
let mathLiveLoaded = false;
/** @private */
let currentChannelId = null;
/** @private */
let isCreatingNewChannel = false;
/** @private */
let newChannelCounter = 1;

/**
 * Get current SV channels from store
 * @private
 * @returns {Array} Channel list
 */
function getSVChannels() {
    return store.getChannels();
}

/** @private */
const SV_CHANNELS = BASE_CHANNELS;

/** @private */
const OPERATORS = [
    { label: '+', latex: '+', title: 'Addition' },
    { label: '-', latex: '-', title: 'Subtraction' },
    { label: '×', latex: '\\cdot', title: 'Multiplication' },
    { label: '÷', latex: '\\frac{#0}{#?}', title: 'Division (Fraction)' },
    { label: '^', latex: '^{#0}', title: 'Power' },
    { label: '(', latex: '(', title: 'Left Parenthesis' },
    { label: ')', latex: ')', title: 'Right Parenthesis' },
    { label: 'π', latex: '\\pi', title: 'Pi Constant' },
    { label: '|x|', latex: '\\left|#0\\right|', title: 'Absolute Value' }
];

/** @private */
const FUNCTIONS = [
    { label: '√', latex: '\\sqrt{#0}', title: 'Square Root' },
    { label: 'sin', latex: '\\sin(#0)', title: 'Sine' },
    { label: 'cos', latex: '\\cos(#0)', title: 'Cosine' },
    { label: 'tan', latex: '\\tan(#0)', title: 'Tangent' },
    { label: 'x²', latex: '^{2}', title: 'Square' },
    { label: 'exp', latex: '\\exp(#0)', title: 'Exponential' },
    { label: 'ln', latex: '\\ln(#0)', title: 'Natural Log' },
    { label: 'RMS', latex: '\\operatorname{RMS}\\left(#0\\right)', title: 'RMS Value' },
    { label: 'AVG', latex: '\\operatorname{AVG}\\left(#0\\right)', title: 'Average Value' }
];

/**
 * Load MathLive from CDN on demand
 * @returns {Promise} Resolves when MathLive is ready
 */
async function loadMathLive() {
    if (mathLiveLoaded && window.MathLive) {
        return window.MathLive;
    }

    return new Promise((resolve, reject) => {
        if (window.MathLive) {
            mathLiveLoaded = true;
            resolve(window.MathLive);
            return;
        }

        console.log("[EmbeddedMathEditor] Loading MathLive from CDN...");



        // Load both CSS files (static and fonts) from local vendor
        console.log("[EmbeddedMathEditor] Loading MathLive from local vendor (static.css, fonts.css, min.js)...");
        const linkStatic = document.createElement("link");
        linkStatic.rel = "stylesheet";
        linkStatic.href = "vendor/mathlive-static.css";
        document.head.appendChild(linkStatic);

        const linkFonts = document.createElement("link");
        linkFonts.rel = "stylesheet";
        linkFonts.href = "vendor/mathlive-fonts.css";
        document.head.appendChild(linkFonts);

        // Load JS (local vendor path)
        const script = document.createElement("script");
        script.src = "vendor/mathlive.min.js";
        script.async = true;

        script.onload = () => {
            console.log("[EmbeddedMathEditor] MathLive loaded successfully");
            mathLiveLoaded = true;
            resolve(window.MathLive);
        };

        script.onerror = () => {
            reject(new Error("Failed to load MathLive"));
        };

        document.head.appendChild(script);
    });
}

/**
 * Create channel button HTML
 * @param {Object} channel - Channel config
 * @returns {string} HTML string
 */
function createChannelButton(channel) {
    return `
        <button class="em-channel-btn" 
                data-latex="${channel.latex}" 
                data-channel="${channel.id}"
                title="${channel.id}"
                style="border-left: 3px solid ${channel.color}">
            ${channel.label}
        </button>
    `;
}

/**
 * Create operator/function button HTML
 * @param {Object} item - Button config
 * @returns {string} HTML string
 */
function createInsertButton(item) {
    return `
        <button class="em-insert-btn" 
                data-latex="${item.latex}" 
                title="${item.title}">
            ${item.label}
        </button>
    `;
}

/**
 * Initialize the embedded MathLive editor
 * @memberof module:embeddedMathEditor
 * @async
 */
export async function initEmbeddedMathEditor() {
    const container = document.getElementById('embeddedEditorContainer');
    if (!container) {
        console.warn('[EmbeddedMathEditor] Container #embeddedEditorContainer not found');
        return;
    }

    // Load MathLive first
    try {
        await loadMathLive();
    } catch (error) {
        console.error('[EmbeddedMathEditor] Failed to load MathLive:', error);
        showToast('Failed to load equation editor', 'error');
        return;
    }

    // Subscribe to store changes FIRST, so a failure in any init below still
    // leaves the standard-switch → re-render path working.
    store.onChange(() => {
        console.log('[EmbeddedMathEditor] Store changed, refreshing...');
        onGlobalStandardChanged();
    });

    // Render the embedded editor HTML (inside the container, preserving the hidden inputs)
    container.innerHTML = createEmbeddedEditorHTML();

    // Initialize all components — each wrapped so one failing init doesn't
    // stop later ones from running.
    const steps = [
        ['initNewChannelButton', initNewChannelButton],
        ['initChannelSelector', initChannelSelector],
        ['initInsertButtons', initInsertButtons],
        ['initMathField', initMathField],
        ['initActionButtons', initActionButtons],
        ['initMagnitudeInput', initMagnitudeInput],
        ['initQuickTemplates', initQuickTemplates],
        ['initFaultButtons', initFaultButtons],
    ];
    for (const [name, fn] of steps) {
        try { fn(); }
        catch (err) { console.error(`[EmbeddedMathEditor] ${name} failed:`, err); }
    }

    console.log('[EmbeddedMathEditor] Initialized successfully');
}

/**
 * Handle global standard change from Step 1 radio cards
 * This is the SINGLE SOURCE OF TRUTH for standard selection
 */
function onGlobalStandardChanged() {
    console.log('[EmbeddedMathEditor] Standard/channels changed');
    
    // Re-render the editor with new standard settings
    const container = document.getElementById('embeddedEditorContainer');
    if (container) {
        container.innerHTML = createEmbeddedEditorHTML();
        const steps = [
            ['initNewChannelButton', initNewChannelButton],
            ['initChannelSelector', initChannelSelector],
            ['initInsertButtons', initInsertButtons],
            ['initMathField', initMathField],
            ['initActionButtons', initActionButtons],
            ['initQuickTemplates', initQuickTemplates],
            ['initFaultButtons', initFaultButtons],
        ];
        for (const [name, fn] of steps) {
            try { fn(); }
            catch (err) { console.error(`[EmbeddedMathEditor] ${name} failed:`, err); }
        }
    }
    
    // Reset creation mode
    isCreatingNewChannel = false;
}

/**
 * Initialize the "+ New Channel" button in the channel grid
 */
function initNewChannelButton() {
    const newChannelBtn = document.getElementById('emNewChannelBtn');
    const cancelBtn = document.getElementById('emCancelNewChannel');
    
    if (newChannelBtn) {
        newChannelBtn.addEventListener('click', () => {
            enterNewChannelMode();
        });
    }
    
    if (cancelBtn) {
        cancelBtn.addEventListener('click', () => {
            exitNewChannelMode();
        });
    }
}

/**
 * Enter "create new channel" mode
 */
function enterNewChannelMode() {
    isCreatingNewChannel = true;
    currentChannelId = null;
    
    // Deselect all channel buttons
    const channelBtns = document.querySelectorAll('.em-channel-btn');
    channelBtns.forEach(b => b.classList.remove('active'));
    
    // Highlight the new channel button
    const newChannelBtn = document.getElementById('emNewChannelBtn');
    if (newChannelBtn) {
        newChannelBtn.classList.add('active');
    }
    
    // Show cancel button
    const cancelBtn = document.getElementById('emCancelNewChannel');
    if (cancelBtn) {
        cancelBtn.style.display = 'inline-block';
    }
    
    // Show hint for new channel format
    const hint = document.getElementById('emNewChannelHint');
    if (hint) {
        hint.style.display = 'block';
    }
    
    // Update labels
    const activeLabel = document.getElementById('emActiveChannel');
    if (activeLabel) {
        activeLabel.textContent = 'Creating New Channel';
        activeLabel.style.color = '#4CAF50';
    }
    updateApplyButtonText();
    
    // Clear and enable math field with helpful placeholder
    const mathField = document.getElementById('emMathField');
    if (mathField) {
        mathField.value = '';
        mathField.placeholder = 'V0 = 325 * sin(2 * PI * 50 * t)  or just equation...';
        mathField.focus();
    }
    updatePreview('');
    
    // Enable action buttons
    document.getElementById('emTestBtn')?.removeAttribute('disabled');
    document.getElementById('emApplyBtn')?.removeAttribute('disabled');
}

/**
 * Exit "create new channel" mode and return to normal editing
 */
function exitNewChannelMode() {
    isCreatingNewChannel = false;
    currentChannelId = null;
    
    // Remove highlight from new channel button
    const newChannelBtn = document.getElementById('emNewChannelBtn');
    if (newChannelBtn) {
        newChannelBtn.classList.remove('active');
    }
    
    // Hide cancel button
    const cancelBtn = document.getElementById('emCancelNewChannel');
    if (cancelBtn) {
        cancelBtn.style.display = 'none';
    }
    
    // Hide hint
    const hint = document.getElementById('emNewChannelHint');
    if (hint) {
        hint.style.display = 'none';
    }
    
    // Update labels
    const activeLabel = document.getElementById('emActiveChannel');
    if (activeLabel) {
        activeLabel.textContent = 'Select a channel';
        activeLabel.style.color = '';
    }
    updateApplyButtonText();
    
    // Reset math field
    const mathField = document.getElementById('emMathField');
    if (mathField) {
        mathField.value = '';
        mathField.placeholder = 'Click a channel above, then enter equation...';
    }
    updatePreview('');
    
    // Disable action buttons
    document.getElementById('emTestBtn')?.setAttribute('disabled', 'disabled');
    document.getElementById('emApplyBtn')?.setAttribute('disabled', 'disabled');
}

/**
 * Update the active channel label based on current mode
 */
function updateActiveChannelLabel() {
    const activeLabel = document.getElementById('emActiveChannel');
    if (!activeLabel) return;
    
    if (isCreatingNewChannel) {
        activeLabel.textContent = 'Creating New Channel';
        activeLabel.style.color = '#4CAF50';
    } else if (currentChannelId) {
        const channel = getSVChannels().find(c => c.id === currentChannelId);
        activeLabel.textContent = `Editing: ${currentChannelId}`;
        activeLabel.style.color = channel?.color || '';
    } else {
        activeLabel.textContent = 'Select a channel';
        activeLabel.style.color = '';
    }
}

/**
 * Parse channel definition from MathLive input
 * Supports formats: "ChannelName = Expression" or just "Expression"
 * @param {string} input - Raw input from MathLive (math.js format)
 * @returns {Object} { channelName, equation }
 */
function parseChannelDefinition(input) {
    if (!input || !input.trim()) {
        return { channelName: null, equation: null };
    }
    
    const trimmed = input.trim();
    
    // Try to match "Name = Expression" pattern
    // Channel name: starts with letter, can contain letters, numbers, underscore
    const match = trimmed.match(/^([A-Za-z][A-Za-z0-9_]*)\s*=\s*(.+)$/);
    
    if (match) {
        return {
            channelName: match[1],
            equation: match[2].trim()
        };
    }
    
    // No "Name =" pattern found, generate default name
    return {
        channelName: generateDefaultChannelName(),
        equation: trimmed
    };
}

/**
 * Generate a default channel name like Ch1, Ch2, etc.
 * @returns {string} Unique channel name
 */
function generateDefaultChannelName() {
    const existingChannels = getSVChannels();
    let name;
    
    // Find a unique name
    do {
        name = `Ch${newChannelCounter++}`;
    } while (existingChannels.some(c => c.id === name));
    
    return name;
}

/**
 * Update the Apply button text based on current mode
 */
function updateApplyButtonText() {
    const applyBtnText = document.getElementById('emApplyBtnText');
    if (applyBtnText) {
        applyBtnText.textContent = isCreatingNewChannel ? 'Create Channel' : 'Apply to Channel';
    }
}

/**
 * Handle standard change event (legacy function, kept for compatibility)
 */
function onStandardChanged() {
    console.log('[EmbeddedMathEditor] Standard changed');
    refreshChannelGrid();
}

/**
 * Refresh the channel grid when channels change
 */
function refreshChannelGrid() {
    const grid = document.getElementById('emChannelGrid');
    if (grid) {
        grid.innerHTML = createChannelGridHTML();
        initChannelSelector(); // Rebind events
        initNewChannelButton(); // Rebind new channel button
    }
}

/**
 * Create channel grid HTML (separated for dynamic updates)
 */
function createChannelGridHTML() {
    const channels = getSVChannels();
    const voltageChannels = channels.filter(c => c.type === 'voltage');
    const currentChannels = channels.filter(c => c.type === 'current');
    const computedChannels = channels.filter(c => c.type === 'computed' || c.type === 'custom');
    
    let html = `
        <div class="em-channel-group">
            <span class="em-group-label">Voltage</span>
            <div class="em-channel-row">
                ${voltageChannels.map(createChannelButton).join('')}
            </div>
        </div>
        <div class="em-channel-group">
            <span class="em-group-label">Current</span>
            <div class="em-channel-row">
                ${currentChannels.map(createChannelButton).join('')}
            </div>
        </div>
    `;
    
    // Add computed/custom channels if any
    if (computedChannels.length > 0) {
        html += `
            <div class="em-channel-group">
                <span class="em-group-label">Computed/Custom</span>
                <div class="em-channel-row">
                    ${computedChannels.map(createChannelButton).join('')}
                </div>
            </div>
        `;
    }
    
    // Add "+ New Channel" button if custom channels are allowed
    const allowCustom = store.allowsCustomChannels();
    if (allowCustom) {
        html += `
            <div class="em-channel-group em-new-channel-group">
                <button class="em-new-channel-btn" id="emNewChannelBtn" title="Create new custom channel">
                    <span class="plus-icon">+</span> New Channel
                </button>
            </div>
        `;
    }
    
    return html;
}

/**
 * Create the embedded editor HTML structure
 * Uses store to check if custom channels are allowed
 * @returns {string} HTML string
 */
function createEmbeddedEditorHTML() {
    const allowCustom = store.allowsCustomChannels();
    const config = store.config.standardConfig;
    const standardName = config?.name || 'IEC 61850-9-2 LE';
    const maxChannels = config?.maxChannels || 8;
    
    return `
        <div class="embedded-math-editor">
            <!-- Current Standard Info Banner (Read-only - controlled from Step 1) -->
            <div class="em-standard-info-banner">
                <div class="em-current-standard">
                    <span class="em-standard-icon">⚡</span>
                    <span class="em-standard-name">${standardName}</span>
                    <span class="em-standard-badge ${allowCustom ? 'em-badge-success' : 'em-badge-locked'}">
                        ${allowCustom ? `✓ Up to ${maxChannels} channels` : '🔒 Fixed 8 channels'}
                    </span>
                </div>
                <div class="em-standard-hint">
                    Change standard in <strong>Step 1</strong> above
                </div>
            </div>
            

            
            <!-- Channel Selector -->
            <div class="em-section">
                <div class="em-section-header">
                    <h4>📡 Select Channel to Edit</h4>
                    <span class="em-channel-count" id="emChannelCount">${getSVChannels().length} channels</span>
                </div>
                <div class="em-channel-grid" id="emChannelGrid">
                    ${createChannelGridHTML()}
                </div>
            </div>
            
            <!-- Insert Buttons -->
            <div class="em-section">
                <div class="em-insert-groups">
                    <div class="em-insert-group">
                        <span class="em-group-label">Operators</span>
                        <div class="em-insert-buttons">
                            ${OPERATORS.map(createInsertButton).join('')}
                        </div>
                    </div>
                    <div class="em-insert-group">
                        <span class="em-group-label">Functions</span>
                        <div class="em-insert-buttons">
                            ${FUNCTIONS.map(createInsertButton).join('')}
                        </div>
                    </div>
                </div>
            </div>
            
            <!-- MathLive Field -->
            <div class="em-section">
                <div class="em-section-header">
                    <h4>✏️ Equation (LaTeX)</h4>
                    <span class="em-active-channel" id="emActiveChannel">Select a channel</span>
                    <button class="btn btn-small btn-outline em-cancel-btn" id="emCancelNewChannel" style="display: none;">Cancel</button>
                </div>

                <!-- Magnitude quick-edit (replaces the leading coefficient of "<MAG> * sin(...)") -->
                <div class="em-magnitude-row" id="emMagnitudeRow">
                    <label for="emMagnitudeInput" class="em-magnitude-label">Magnitude</label>
                    <input type="number" step="any" id="emMagnitudeInput"
                           class="em-magnitude-input"
                           placeholder="—"
                           disabled
                           aria-label="Magnitude (leading coefficient)">
                    <span class="em-magnitude-hint" id="emMagnitudeHint">Select a channel to edit</span>
                </div>

                <math-field id="emMathField"
                           class="em-math-field"
                           virtual-keyboard-mode="manual"
                           placeholder="Click a channel above, then enter equation...">
                </math-field>

                <!-- Hint for new channel format -->
                <div class="em-new-channel-hint" id="emNewChannelHint" style="display: none;">
                    💡 Format: <code>ChannelName = equation</code> (e.g., V0 = 325 * sin(2 * PI * 50 * t)) or just equation for auto-named channel
                </div>
            </div>
            
            <!-- Preview & Validation -->
            <div class="em-section em-preview-section">
                <div class="em-preview-row">
                    <div class="em-preview-box">
                        <label>math.js Expression:</label>
                        <code id="emMathJsPreview">--</code>
                    </div>
                    <div class="em-status-box" id="emStatusBox">
                        <span class="em-status-icon">⏳</span>
                        <span class="em-status-text">Select a channel to edit</span>
                    </div>
                </div>
            </div>
            
            <!-- Actions -->
            <div class="em-actions">
                <button class="btn btn-small btn-outline" id="emTestBtn" disabled>
                    <span class="icon">🧪</span> Test
                </button>
                <button class="btn btn-small btn-outline" id="emClearBtn">
                    <span class="icon">🗑️</span> Clear
                </button>
                <button class="btn btn-small btn-primary" id="emApplyBtn" disabled>
                    <span class="icon">✓</span> <span id="emApplyBtnText">Apply to Channel</span>
                </button>
            </div>
            
            <!-- Fault Transient Simulation -->
            <div class="eq-fault-section">
                <h4>⚡ Fault Transient Simulation</h4>
                <div class="eq-fault-timing">
                    <div class="eq-fault-row">
                        <label>Pre-fault:
                            <input type="number" id="faultPreSec" value="0.5" min="0.1" max="0.9" step="0.05"> sec
                        </label>
                        <label>Fault:
                            <input type="number" id="faultDurSec" value="0.2" min="0.05" max="0.5" step="0.05"> sec
                        </label>
                        <label>Post-fault:
                            <span id="faultPostSec" class="eq-fault-computed">0.3</span> sec
                        </label>
                    </div>
                    <div class="eq-fault-row">
                        <label>I multiplier:
                            <input type="number" id="faultIMult" value="20" min="5" max="50" step="1">×
                        </label>
                        <label>V sag:
                            <input type="number" id="faultVSag" value="15" min="5" max="50" step="1">%
                        </label>
                    </div>
                </div>
                <div class="eq-fault-buttons">
                    <button class="eq-fault-btn" data-fault="ag">A-G Fault</button>
                    <button class="eq-fault-btn" data-fault="bg">B-G Fault</button>
                    <button class="eq-fault-btn" data-fault="cg">C-G Fault</button>
                    <button class="eq-fault-btn" data-fault="ab">A-B Fault</button>
                    <button class="eq-fault-btn" data-fault="bc">B-C Fault</button>
                    <button class="eq-fault-btn" data-fault="ca">C-A Fault</button>
                    <button class="eq-fault-btn eq-fault-btn-3ph" data-fault="3ph">3φ Fault</button>
                </div>
            </div>
           
        </div>
    `;
}

/**
 * Initialize channel selector buttons
 */
function initChannelSelector() {
    const channelBtns = document.querySelectorAll('.em-channel-btn');
    
    channelBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            // Exit new channel mode if active
            if (isCreatingNewChannel) {
                isCreatingNewChannel = false;
                
                // Remove highlight from new channel button
                const newChannelBtn = document.getElementById('emNewChannelBtn');
                if (newChannelBtn) {
                    newChannelBtn.classList.remove('active');
                }
                
                // Hide cancel button and hint
                const cancelBtn = document.getElementById('emCancelNewChannel');
                if (cancelBtn) cancelBtn.style.display = 'none';
                
                const hint = document.getElementById('emNewChannelHint');
                if (hint) hint.style.display = 'none';
                
                updateApplyButtonText();
            }
            
            // Remove active from all channel buttons
            channelBtns.forEach(b => b.classList.remove('active'));
            
            // Set active
            btn.classList.add('active');
            
            // Update current channel
            currentChannelId = btn.dataset.channel;
            
            // Update UI
            updateActiveChannelLabel();
            
            // Load existing equation for this channel
            loadChannelEquation(currentChannelId);
            
            // Enable action buttons
            document.getElementById('emTestBtn')?.removeAttribute('disabled');
            document.getElementById('emApplyBtn')?.removeAttribute('disabled');
            
            // Focus math field
            const mathField = document.getElementById('emMathField');
            if (mathField) {
                mathField.placeholder = 'Click a channel above, then enter equation...';
                mathField.focus();
            }
        });
    });
}

/**
 * Load existing equation from original input field
 * @param {string} channelId - Channel ID (Va, Vb, etc.)
 */
function loadChannelEquation(channelId) {
    const originalInput = document.getElementById(`eq${channelId}`);
    const mathField = document.getElementById('emMathField');

    if (originalInput && mathField) {
        const mathJsExpr = originalInput.value;
        // Convert math.js to LaTeX for display in MathLive
        const latexExpr = convertMathJsToLatex(mathJsExpr);
        mathField.value = latexExpr;

        // Update preview
        updatePreview(mathJsExpr);

        // Sync the magnitude quick-input with this channel's equation
        syncMagnitudeInputFromEquation(mathJsExpr);
    }
}

/**
 * Populate the Magnitude quick-edit input from a math.js equation.
 * Disables the input when the equation has no parseable leading coefficient
 * (e.g., a custom expression like "Va * Ia" — those need full LaTeX edit).
 * @param {string} mathJsExpr
 */
function syncMagnitudeInputFromEquation(mathJsExpr) {
    const input = document.getElementById('emMagnitudeInput');
    const hint = document.getElementById('emMagnitudeHint');
    if (!input) return;

    const trimmed = String(mathJsExpr ?? '').trim();
    if (!trimmed) {
        input.value = '';
        input.disabled = true;
        if (hint) {
            hint.textContent = isCreatingNewChannel
                ? 'Available after the channel is created'
                : 'Select a channel to edit';
        }
        return;
    }

    const mag = getMagnitudeFromEquation(trimmed);
    if (mag == null) {
        input.value = '';
        input.disabled = true;
        if (hint) hint.textContent = 'Custom equation — edit LaTeX below';
        return;
    }

    input.value = mag;
    input.disabled = false;
    if (hint) hint.textContent = 'Replaces the leading coefficient of the sin term';
}

/**
 * Initialize insert buttons (operators and functions)
 */
function initInsertButtons() {
    const insertBtns = document.querySelectorAll('.em-insert-btn');
    
    insertBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            const mathField = document.getElementById('emMathField');
            if (!mathField) return;
            
            const latex = btn.dataset.latex;
            mathField.executeCommand(['insert', latex]);
            mathField.focus();
        });
    });
}

/**
 * Initialize MathLive field event listeners
 */
function initMathField() {
    const mathField = document.getElementById('emMathField');
    if (!mathField) return;
    
    // Disable sound effects to avoid play/pause errors. MathLive's API here
    // has shifted across versions — try direct properties, then fall back to
    // setOptions(), and don't let either throw stop the rest of init.
    try { mathField.soundsDirectory = null; } catch {}
    try { mathField.plonkSound = null; } catch {}
    if (typeof mathField.setOptions === 'function') {
        try {
            mathField.setOptions({ soundsDirectory: null, plonkSound: null });
        } catch (err) {
            console.warn('[EmbeddedMathEditor] setOptions failed (non-fatal):', err);
        }
    }
    
    // Listen for input changes
    mathField.addEventListener('input', (e) => {
        const latexValue = e.target.value;
        const mathJsExpr = convertLatexToMathJs(latexValue);
        updatePreview(mathJsExpr);
        syncMagnitudeInputFromEquation(mathJsExpr);
    });
}

/**
 * Update the math.js preview and validation status
 * @param {string} mathJsExpr - math.js expression
 */
function updatePreview(mathJsExpr) {
    const previewEl = document.getElementById('emMathJsPreview');
    const statusBox = document.getElementById('emStatusBox');
    
    if (previewEl) {
        previewEl.textContent = mathJsExpr || '--';
    }
    
    if (statusBox && mathJsExpr) {
        const validation = validateExpression(mathJsExpr);
        
        if (validation.valid) {
            statusBox.innerHTML = `
                <span class="em-status-icon success">✓</span>
                <span class="em-status-text success">Valid expression</span>
            `;
        } else {
            statusBox.innerHTML = `
                <span class="em-status-icon error">✗</span>
                <span class="em-status-text error">${validation.error}</span>
            `;
        }
    }
}

/**
 * Initialize the Magnitude quick-edit input.
 *
 * Flow on `change` (blur / Enter):
 *   1. Read MathLive's current LaTeX → math.js expression
 *   2. Replace the leading coefficient via setMagnitudeInEquation()
 *   3. Push the new equation through the canonical pipeline:
 *        a. MathLive field      ← display stays in sync with the edit
 *        b. Hidden input #eq<id> ← legacy parallel state used elsewhere
 *        c. store.updateEquation() ← single source of truth (notifies
 *           ChannelsDisplay, DataSource, FrameViewer subscribers, and is
 *           what getDataForServer() reads on START)
 */
function initMagnitudeInput() {
    const input = document.getElementById('emMagnitudeInput');
    if (!input) return;

    input.addEventListener('change', () => {
        if (input.disabled) return;
        if (!currentChannelId || isCreatingNewChannel) return;

        // Source of truth = store. Reading from MathLive's `value` would round
        // through a lossy LaTeX → math.js conversion (e.g. the converter turns
        // a trailing `)` into `\right|` for abs() detection, then strips `\pi`
        // on the way back) — so we'd lose phase shifts and PI. Pull the
        // canonical equation from the store instead.
        const channel = store.getChannel(currentChannelId);
        if (!channel) return;
        const currentExpr = channel.equation;

        const newMag = parseFloat(input.value);
        if (!Number.isFinite(newMag)) {
            syncMagnitudeInputFromEquation(currentExpr);
            return;
        }

        const frequency = store.get('config.frequency') || 50;
        const newExpr = setMagnitudeInEquation(currentExpr, newMag, frequency);

        if (newExpr == null) {
            showToast('Cannot edit magnitude for this equation shape', 'warning');
            syncMagnitudeInputFromEquation(currentExpr);
            return;
        }
        if (newExpr === currentExpr) return;

        // 1. Store — single source of truth. Fans out to ChannelsDisplay,
        //    DataSource (which also rewrites the hidden input), and the
        //    embedded editor's own onChange re-render.
        store.updateEquation(currentChannelId, newExpr);

        // 2. Hidden input — belt-and-suspenders. DataSource will sync this
        //    via its data.channels subscription too, but updating directly
        //    avoids any ordering issue if the editor re-renders first.
        const originalInput = document.getElementById(`eq${currentChannelId}`);
        if (originalInput) originalInput.value = newExpr;

        // 3. MathLive display + preview — refresh from the freshly-set store
        //    value so the user sees the change immediately. Note: the editor
        //    re-renders via store.onChange anyway, but this keeps the field
        //    intact during this turn in case re-render is debounced.
        const mathField = document.getElementById('emMathField');
        if (mathField) mathField.value = convertMathJsToLatex(newExpr);
        updatePreview(newExpr);
    });
}

/**
 * Initialize action buttons
 */
function initActionButtons() {
    // Test button
    const testBtn = document.getElementById('emTestBtn');
    if (testBtn) {
        testBtn.addEventListener('click', handleTestEquation);
    }
    
    // Clear button
    const clearBtn = document.getElementById('emClearBtn');
    if (clearBtn) {
        clearBtn.addEventListener('click', handleClearEquation);
    }
    
    // Apply button
    const applyBtn = document.getElementById('emApplyBtn');
    if (applyBtn) {
        applyBtn.addEventListener('click', handleApplyEquation);
    }
}

/**
 * Handle test button click
 */
function handleTestEquation() {
    const mathField = document.getElementById('emMathField');
    if (!mathField) return;
    
    const mathJsExpr = convertLatexToMathJs(mathField.value);
    
    const validation = validateExpression(mathJsExpr);
    if (!validation.valid) {
        showToast(`Invalid: ${validation.error}`, 'error');
        return;
    }
    
    // Get frequency and sample rate
    const frequency = parseInt(document.getElementById('frequency')?.value) || 50;
    const smpRate = parseInt(document.getElementById('smpRate')?.value) || 4000;
    
    try {
        const compiled = window.math.compile(mathJsExpr);
        const samples = evaluateSamples(compiled, smpRate, frequency, smpRate);
        const stats = calculateStats(samples);
        
        showToast(`✓ Valid! Min: ${stats.min.toFixed(2)}, Max: ${stats.max.toFixed(2)}, RMS: ${stats.rms.toFixed(2)}`);
    } catch (error) {
        showToast(`Test error: ${error.message}`, 'error');
    }
}

/**
 * Handle clear button click
 */
function handleClearEquation() {
    const mathField = document.getElementById('emMathField');
    if (mathField) {
        mathField.value = '';
        updatePreview('');
    }
}

/**
 * Handle apply button click
 * Handles both creating new channels and updating existing ones
 */
function handleApplyEquation() {
    const mathField = document.getElementById('emMathField');
    if (!mathField) return;
    
    const mathJsExpr = convertLatexToMathJs(mathField.value);
    
    if (!mathJsExpr || !mathJsExpr.trim()) {
        showToast('Please enter an equation', 'warning');
        return;
    }
    
    // Handle new channel creation
    if (isCreatingNewChannel) {
        // Parse the expression to extract channel name and equation
        const { channelName, equation } = parseChannelDefinition(mathJsExpr);
        
        if (!equation || !equation.trim()) {
            showToast('Please enter a valid equation', 'warning');
            return;
        }
        
        // Validate the equation part
        const validation = validateExpression(equation);
        if (!validation.valid) {
            showToast(`Invalid equation: ${validation.error}`, 'error');
            return;
        }
        
        // Check if channel name already exists
        const existingChannels = getSVChannels();
        if (existingChannels.some(c => c.id === channelName)) {
            showToast(`Channel '${channelName}' already exists`, 'error');
            return;
        }
        
        // Create the channel object
        const channelObj = {
            id: channelName,
            label: channelName,
            equation: equation,
            type: 'custom',
            description: `Custom channel: ${channelName}`
        };
        
        // Add channel using store
        const success = store.addChannel(channelObj);
        if (success) {
            ensureHiddenInput(channelObj);
            showToast(`Channel '${channelName}' created: ${equation}`, 'success');
            
            // Exit creation mode and refresh
            exitNewChannelMode();
            refreshChannelGrid();
        } else {
            showToast('Failed to create channel (max channels reached?)', 'error');
        }
        return;
    }
    
    // Handle existing channel update
    if (!currentChannelId) {
        showToast('Please select a channel first', 'warning');
        return;
    }
    
    // Validate before applying
    const validation = validateExpression(mathJsExpr);
    if (!validation.valid) {
        showToast(`Cannot apply invalid equation: ${validation.error}`, 'error');
        return;
    }
    
    // Terminal-visible breadcrumb so the user can see the Apply button
    // reaching this point even with devtools locked down.
    _termLogEditor(`Apply clicked for ${currentChannelId}: ${mathJsExpr}`);

    // Update the original hidden input field (legacy parallel state)
    const originalInput = document.getElementById(`eq${currentChannelId}`);
    if (originalInput) originalInput.value = mathJsExpr;

    // Push to the store — single source of truth. Without this the
    // ChannelsDisplay (and anything else subscribed to data.channels) keeps
    // showing the old equation. See DATA_FLOW_AUDIT.md "BREAKPOINT #4".
    store.updateEquation(currentChannelId, mathJsExpr);

    showToast(`Equation applied to ${currentChannelId}`, 'success');
}

/** Debug log — backend no longer routes debug_log; goes to console. */
function _termLogEditor(message) {
    try { console.log('[editor]', message); } catch {}
}

/**
 * Initialize quick templates
 */
function initQuickTemplates() {
    const templateBtns = document.querySelectorAll('[data-template]');
    
    templateBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            const templateName = btn.dataset.template;
            applyQuickTemplate(templateName);
        });
    });
}

/**
 * Apply a quick template to all channels
 * @param {string} templateName - Template name (or fault_ag, fault_bg, etc.)
 * @param {Object} [faultOpts] - Fault options for fault templates
 */
function applyQuickTemplate(templateName, faultOpts = {}) {
    // Check if this is a fault transient template
    if (templateName.startsWith('fault_')) {
        applyFaultTemplate(templateName.replace('fault_', ''), faultOpts);
        showToast('Applied fault transient template', 'success');
        return;
    }

    const freq = parseInt(document.getElementById('frequency')?.value) || 50;
    
    const templates = {
        'balanced': {
            Va: `325 * sin(2 * PI * ${freq} * t)`,
            Vb: `325 * sin(2 * PI * ${freq} * t - 2*PI/3)`,
            Vc: `325 * sin(2 * PI * ${freq} * t + 2*PI/3)`,
            Vn: '0',
            Ia: `100 * sin(2 * PI * ${freq} * t)`,
            Ib: `100 * sin(2 * PI * ${freq} * t - 2*PI/3)`,
            Ic: `100 * sin(2 * PI * ${freq} * t + 2*PI/3)`,
            In: '0'
        },
        'fault': {
            Va: `50 * sin(2 * PI * ${freq} * t)`,
            Vb: `325 * sin(2 * PI * ${freq} * t - 2*PI/3)`,
            Vc: `325 * sin(2 * PI * ${freq} * t + 2*PI/3)`,
            Vn: `100 * sin(2 * PI * ${freq} * t)`,
            Ia: `500 * sin(2 * PI * ${freq} * t)`,
            Ib: `100 * sin(2 * PI * ${freq} * t - 2*PI/3)`,
            Ic: `100 * sin(2 * PI * ${freq} * t + 2*PI/3)`,
            In: `400 * sin(2 * PI * ${freq} * t)`
        },
        'harmonics': {
            Va: `325 * sin(2 * PI * ${freq} * t) + 30 * sin(6 * PI * ${freq} * t) + 15 * sin(10 * PI * ${freq} * t)`,
            Vb: `325 * sin(2 * PI * ${freq} * t - 2*PI/3) + 30 * sin(6 * PI * ${freq} * t - 2*PI/3)`,
            Vc: `325 * sin(2 * PI * ${freq} * t + 2*PI/3) + 30 * sin(6 * PI * ${freq} * t + 2*PI/3)`,
            Vn: '0',
            Ia: `100 * sin(2 * PI * ${freq} * t) + 10 * sin(6 * PI * ${freq} * t)`,
            Ib: `100 * sin(2 * PI * ${freq} * t - 2*PI/3) + 10 * sin(6 * PI * ${freq} * t - 2*PI/3)`,
            Ic: `100 * sin(2 * PI * ${freq} * t + 2*PI/3) + 10 * sin(6 * PI * ${freq} * t + 2*PI/3)`,
            In: '0'
        },
        'zero': {
            Va: '0', Vb: '0', Vc: '0', Vn: '0',
            Ia: '0', Ib: '0', Ic: '0', In: '0'
        }
    };
    
    const template = templates[templateName];
    if (!template) return;
    
    // Get current channels from store and update equations
    const channels = store.getChannels();
    let applied = 0;
    
    // Apply to all channels (update both DOM hidden inputs and store)
    Object.entries(template).forEach(([channel, equation]) => {
        // Update hidden input (for form submission)
        const input = document.getElementById(`eq${channel}`);
        if (input) {
            input.value = equation;
        }
        
        // UPDATE STORE: Find and update channel in store
        const storeChannel = channels.find(ch => ch.id === channel);
        if (storeChannel) {
            storeChannel.equation = equation;
            applied++;
        }
    });
    
    // Notify subscribers of channel changes (will update ChannelsDisplay)
    // IMPORTANT: Pass new array reference to trigger change detection in store
    if (applied > 0) {
        store.setData({ channels: [...channels] });  // NEW array reference triggers notification
    }
    
    // Update current channel in math field if one is selected
    if (currentChannelId && template[currentChannelId]) {
        const mathField = document.getElementById('emMathField');
        if (mathField) {
            mathField.value = convertMathJsToLatex(template[currentChannelId]);
            updatePreview(template[currentChannelId]);
        }
    }
    
    showToast(`Applied "${templateName}" template`);
}

/**
 * Apply a fault transient template using step response equations.
 * @param {string} faultType - Fault type (ag, bg, cg, ab, bc, ca, 3ph)
 * @param {Object} [opts] - Fault options
 */
function applyFaultTemplate(faultType, opts = {}) {
    const channels = store.getChannels();
    const frequency = store.get('config.frequency') || 60;
    const faultedPhases = getFaultedPhases(faultType);

    const t1 = opts.preFaultSec ?? 0.5;
    const faultDuration = opts.faultSec ?? 0.2;
    const t2 = parseFloat((t1 + faultDuration).toFixed(4));

    // UI sends voltageSag as remaining fraction (0.15 = 15% remains).
    // Step equation needs sag as drop fraction: sag = 1 - remaining.
    let sag, faultMultiplier;
    const isLineToLine = ['ab', 'bc', 'ca'].includes(faultType);
    const is3Phase = faultType === '3ph';

    if (opts.voltageSag != null) {
        sag = parseFloat((1 - opts.voltageSag).toFixed(4));
    } else if (is3Phase) {
        sag = 0.9;
    } else if (isLineToLine) {
        sag = 0.5;
    } else {
        sag = 0.85;
    }

    if (is3Phase) {
        faultMultiplier = opts.faultMultiplier ?? 15;
    } else if (isLineToLine) {
        faultMultiplier = opts.faultMultiplier ?? 10;
    } else {
        faultMultiplier = opts.faultMultiplier ?? 20;
    }

    const STANDARD_DEFAULTS = {
        Va: { amplitude: 325 },
        Vb: { amplitude: 325 },
        Vc: { amplitude: 325 },
        Vn: { amplitude: 0 },
        Ia: { amplitude: 100 },
        Ib: { amplitude: 100 },
        Ic: { amplitude: 100 },
        In: { amplitude: 0 },
    };

    let modified = 0;

    channels.forEach(ch => {
        const role = getChannelFaultRole(ch.id);

        // Only modify standard voltage/current channels
        if (role.type === 'other' || role.phase === '') {
            return;
        }

        const defaults = STANDARD_DEFAULTS[ch.id] || { amplitude: 100 };
        const nominalAmplitude = defaults.amplitude;

        const eq = generateStepEquation({
            channelType: role.type,
            channelPhase: role.phase,
            faultedPhases,
            frequency,
            t1,
            t2,
            nominalAmplitude,
            voltageSag: sag,
            faultMultiplier,
        });

        // Update hidden input (for form submission)
        const input = document.getElementById(`eq${ch.id}`);
        if (input) {
            input.value = eq;
        }

        // Update the channel equation in the store
        ch.equation = eq;
        modified++;
    });

    // Notify subscribers of channel changes
    if (modified > 0) {
        store.setData({ channels: [...channels] });
        showToast(`Applied ${faultType.toUpperCase()} fault (step response) to ${modified} channels`, 'success');
    }
}

/**
 * Ensure a hidden input exists for a channel
 * Creates one if it doesn't exist (for dynamic channels)
 * @param {Object} channel - Channel object
 */
function ensureHiddenInput(channel) {
    const inputId = `eq${channel.id}`;
    let input = document.getElementById(inputId);
    
    if (!input) {
        // Create hidden input for this channel
        input = document.createElement('input');
        input.type = 'hidden';
        input.id = inputId;
        input.value = channel.equation || '0';
        input.dataset.dynamicChannel = 'true';
        
        // Add to form or container
        const container = document.getElementById('embeddedEditorContainer');
        if (container) {
            container.appendChild(input);
            console.log(`[EmbeddedMathEditor] Created hidden input for ${channel.id}`);
        }
    }
}

/**
 * Initialize fault simulation buttons
 */
function initFaultButtons() {
    const container = document.getElementById('embeddedEditorContainer');
    if (!container) return;

    // Fault timing: auto-compute post-fault duration
    const preFaultInput = container.querySelector('#faultPreSec');
    const faultDurInput = container.querySelector('#faultDurSec');
    const postFaultSpan = container.querySelector('#faultPostSec');

    function updatePostFault() {
        const pre = parseFloat(preFaultInput?.value) || 0.5;
        const dur = parseFloat(faultDurInput?.value) || 0.2;
        const post = Math.max(0, 1.0 - pre - dur);
        if (postFaultSpan) postFaultSpan.textContent = post.toFixed(2);
    }

    if (preFaultInput) preFaultInput.addEventListener('input', updatePostFault);
    if (faultDurInput) faultDurInput.addEventListener('input', updatePostFault);
    updatePostFault();

    // Fault template buttons
    container.querySelectorAll('.eq-fault-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const faultType = btn.dataset.fault;
            const preFaultSec = parseFloat(preFaultInput?.value) || 0.5;
            const faultSec = parseFloat(faultDurInput?.value) || 0.2;
            const faultMultiplier = parseFloat(container.querySelector('#faultIMult')?.value) || 20;
            const voltageSag = (parseFloat(container.querySelector('#faultVSag')?.value) || 15) / 100;

            applyQuickTemplate('fault_' + faultType, {
                preFaultSec,
                faultSec,
                faultMultiplier,
                voltageSag,
            });
        });
    });
}

/**
 * Check if MathLive is loaded
 * @memberof module:embeddedMathEditor
 * @returns {boolean}
 */
export function isMathLiveReady() {
    return mathLiveLoaded;
}

/**
 * Get all channel equations
 * @memberof module:embeddedMathEditor
 * @returns {Object} Channel IDs as keys and equations as values
 */
export function getAllEquations() {
    const equations = {};
    const channels = getSVChannels();
    
    channels.forEach(channel => {
        const input = document.getElementById(`eq${channel.id}`);
        if (input) {
            equations[channel.id] = input.value;
        } else {
            // Use channel's default equation if no input exists
            equations[channel.id] = channel.equation || '0';
        }
    });
    return equations;
}

/**
 * Export store and getSVChannels for external access
 */
export { store, getSVChannels };
