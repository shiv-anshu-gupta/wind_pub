/**
 * @file copyFilter.js
 * @fileoverview Wireshark Filter Copy Plugin
 * @module copyFilter
 * @description Copies Wireshark capture filter to clipboard.
 */

import { showToast } from './toast.js';

/**
 * Initialize copy filter button
 * @memberof module:copyFilter
 */
export function initCopyFilter() {
    const copyBtn = document.getElementById('copyFilterBtn');

    if (!copyBtn) return;

    copyBtn.addEventListener('click', function() {
        const filterText = document.getElementById('wiresharkFilter').textContent;

        // Copy to clipboard
        navigator.clipboard.writeText(filterText).then(function() {
            // Success - update button text
            copyBtn.textContent = '✓ Copied!';
            copyBtn.classList.add('copied');

            showToast('Filter copied to clipboard');

            // Reset button after 2 seconds
            setTimeout(function() {
                copyBtn.textContent = '📋 Copy';
                copyBtn.classList.remove('copied');
            }, 2000);
        }).catch(function() {
            // Fallback for older browsers
            fallbackCopy(filterText, copyBtn);
        });
    });
}

/**
 * Fallback copy method for older browsers
 * @private
 * @param {string} text - Text to copy
 * @param {HTMLElement} btn - Button element to update
 */
function fallbackCopy(text, btn) {
    const textArea = document.createElement('textarea');
    textArea.value = text;
    textArea.style.position = 'fixed';
    textArea.style.left = '-9999px';
    document.body.appendChild(textArea);
    textArea.select();

    try {
        document.execCommand('copy');
        btn.textContent = '✓ Copied!';
        btn.classList.add('copied');
        showToast('Filter copied to clipboard');

        setTimeout(function() {
            btn.textContent = '📋 Copy';
            btn.classList.remove('copied');
        }, 2000);
    } catch (err) {
        showToast('Failed to copy', 'error');
    }

    document.body.removeChild(textArea);
}
