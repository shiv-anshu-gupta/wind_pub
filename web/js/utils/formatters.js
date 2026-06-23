/**
 * @file formatters.js
 * @fileoverview Formatting Utility Functions
 * @module formatters
 * @author SV-PUB Team
 * @description
 * Provides formatting utilities for time, dates, MAC addresses, and numbers.
 * All functions are pure and have no side effects.
 * 
 * @example
 * import { formatTime, formatNumber } from './utils/formatters.js';
 * formatTime(3661); // "01:01:01"
 * formatNumber(1234567); // "1,234,567"
 */

/**
 * Format seconds into HH:MM:SS format
 * @memberof module:formatters
 * @param {number} totalSeconds - Total seconds to format
 * @returns {string} Formatted time string
 * @example
 * formatTime(3661) // "01:01:01"
 */
export function formatTime(totalSeconds) {
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = Math.floor(totalSeconds % 60);

    return [
        hours.toString().padStart(2, '0'),
        minutes.toString().padStart(2, '0'),
        seconds.toString().padStart(2, '0')
    ].join(':');
}

/**
 * Format current date for filename (YYYYMMDD-HHMM)
 * @memberof module:formatters
 * @returns {string} Formatted date string
 * @example
 * formatDateForFilename() // "20250205-1430"
 */
export function formatDateForFilename() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');

    return `${year}${month}${day}-${hours}${minutes}`;
}

/**
 * Generate a random MAC address
 * @memberof module:formatters
 * @returns {string} Random MAC address in XX:XX:XX:XX:XX:XX format
 * @example
 * generateRandomMac() // "A1:B2:C3:D4:E5:F6"
 */
export function generateRandomMac() {
    const hexDigits = '0123456789ABCDEF';
    let mac = '';

    for (let i = 0; i < 6; i++) {
        if (i > 0) mac += ':';
        mac += hexDigits[Math.floor(Math.random() * 16)];
        mac += hexDigits[Math.floor(Math.random() * 16)];
    }

    return mac;
}

/**
 * Format number with locale-specific thousand separators
 * @memberof module:formatters
 * @param {number} num - Number to format
 * @returns {string} Formatted number string
 * @example
 * formatNumber(1234567) // "1,234,567"
 */
export function formatNumber(num) {
    return num.toLocaleString();
}
