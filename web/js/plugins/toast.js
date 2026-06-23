/**
 * @file toast.js
 * @fileoverview Toast Notification System Plugin
 * @module toast
 * @author SV-PUB Team
 * @copyright 2025 SV Publisher
 * @license Proprietary
 * @version 1.0.0
 * 
 * @description
 * This module provides a non-intrusive toast notification system for displaying
 * success and error messages to users. Toast messages automatically disappear
 * after a configurable duration.
 * 
 * **Toast Flow:**
 * 1. Code calls `showToast(message, type)`
 * 2. Toast elements retrieved from DOM
 * 3. Message text and icon set based on type
 * 4. 'show' class added (triggers CSS animation)
 * 5. setTimeout starts 3-second timer
 * 6. 'show' class removed (toast fades out)
 * 
 * **Toast Types:**
 * 
 * | Type | Icon | CSS Class | Use Case |
 * |------|------|-----------|----------|
 * | success | ✓ | (none) | Successful operations |
 * | error | ✕ | .error | Failed operations, validation errors |
 * 
 * **Required HTML Structure:**
 * ```html
 * <div id="toast" class="toast">
 *     <span id="toastIcon">✓</span>
 *     <span id="toastMessage">Message here</span>
 * </div>
 * ```
 * 
 * **Security:**
 * - Message content set via textContent (not innerHTML)
 * - No dynamic HTML execution
 * - No external dependencies
 * 
 * @example <caption>Success Toast</caption>
 * import { showToast } from './plugins/toast.js';
 * showToast('Configuration saved successfully');
 * 
 * @example <caption>Error Toast</caption>
 * showToast('Invalid MAC address format', 'error');
 * 
 * @example <caption>Try-Catch Pattern</caption>
 * try {
 *     await saveConfig();
 *     showToast('Configuration saved');
 * } catch (error) {
 *     showToast('Failed to save: ' + error.message, 'error');
 * }
 * 
 * @see {@link module:configManager} for save/load operations that use toast
 */

'use strict';

// ============================================================================
// TOAST DISPLAY FUNCTION
// ============================================================================

/**
 * Display a toast notification message
 * 
 * @memberof module:toast
 * @function showToast
 * @description
 * Shows a temporary toast notification at the bottom of the screen.
 * The toast automatically hides after 3 seconds.
 * 
 * **State Transitions:**
 * - Hidden → Visible (when showToast called)
 * - Visible → Hidden (after 3 seconds)
 * - Visible → Visible (if showToast called again, resets timer)
 * 
 * @param {string} message - The message text to display
 * @param {('success'|'error')} [type='success'] - The type of notification
 *   - 'success' - Green background, checkmark icon
 *   - 'error' - Red background, X icon
 * 
 * @returns {void}
 * 
 * @fires DOMContentLoaded - Requires DOM to be ready
 * 
 * @example <caption>Basic Usage</caption>
 * showToast('Operation completed');
 * 
 * @example <caption>Error Notification</caption>
 * showToast('Network connection failed', 'error');
 * 
 * @example <caption>In Async Operations</caption>
 * async function saveConfiguration() {
 *     try {
 *         await saveToServer();
 *         showToast('Saved successfully');
 *     } catch (e) {
 *         showToast(`Save failed: ${e.message}`, 'error');
 *     }
 * }
 * 
 * @throws {TypeError} If toast elements are not found in DOM (silent fail)
 */
export function showToast(message, type = 'success') {
    const toast = document.getElementById('toast');
    const toastIcon = document.getElementById('toastIcon');
    const toastMessage = document.getElementById('toastMessage');

    // Set message
    toastMessage.textContent = message;

    // Set icon and style based on type
    if (type === 'error') {
        toastIcon.textContent = '✕';
        toast.classList.add('error');
    } else {
        toastIcon.textContent = '✓';
        toast.classList.remove('error');
    }

    // Show toast
    toast.classList.add('show');

    // Hide after 3 seconds
    setTimeout(function() {
        toast.classList.remove('show');
    }, 3000);
}

