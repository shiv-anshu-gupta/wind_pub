/**
 * @file keyboardShortcuts.js
 * @fileoverview Keyboard Event Handler Plugin
 * @module keyboardShortcuts
 * @author SV-PUB Team
 * @description
 * Provides keyboard shortcuts for common operations.
 * 
 * **Keyboard Shortcuts:**
 * 
 * | Shortcut | Action |
 * |----------|--------|
 * | Ctrl/Cmd + S | Save config |
 * | Ctrl/Cmd + O | Load config |
 * | Ctrl/Cmd + Enter | Start publishing |
 * | Escape | Stop publishing |
 * 
 * @example
 * import { initKeyboardShortcuts, initUnloadWarning } from './plugins/keyboardShortcuts.js';
 * initKeyboardShortcuts();
 * initUnloadWarning();
 */

import { saveConfig, loadConfig } from './configManager.js';
import * as MultiPublisher from '../components/MultiPublisher.js';

const isPublishing    = () => MultiPublisher.isRunning_public();
const startPublishing = () => MultiPublisher.startAll_public();
const stopPublishing  = () => MultiPublisher.stopAll_public();

/**
 * Initialize keyboard shortcuts
 * @memberof module:keyboardShortcuts
 */
export function initKeyboardShortcuts() {
    document.addEventListener('keydown', function(e) {
        // Ctrl/Cmd + S = Save Config
        if ((e.ctrlKey || e.metaKey) && e.key === 's') {
            e.preventDefault();
            saveConfig();
        }

        // Ctrl/Cmd + O = Load Config
        if ((e.ctrlKey || e.metaKey) && e.key === 'o') {
            e.preventDefault();
            loadConfig();
        }

        // Ctrl/Cmd + Enter = Start Publishing
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            e.preventDefault();
            if (!isPublishing()) {
                startPublishing();
            }
        }

        // Escape = Stop Publishing
        if (e.key === 'Escape') {
            if (isPublishing()) {
                stopPublishing();
            }
        }
    });

    // Log available shortcuts
    console.log('Keyboard shortcuts:');
    console.log('  Ctrl/Cmd + S: Save Config');
    console.log('  Ctrl/Cmd + O: Load Config');
    console.log('  Ctrl/Cmd + Enter: Start Publishing');
    console.log('  Escape: Stop Publishing');
}

/**
 * Initialize window unload warning
 * @memberof module:keyboardShortcuts
 */
export function initUnloadWarning() {
    window.addEventListener('beforeunload', function(e) {
        if (isPublishing()) {
            e.preventDefault();
            e.returnValue = 'Publishing is in progress. Are you sure you want to leave?';
            return e.returnValue;
        }
    });
}
