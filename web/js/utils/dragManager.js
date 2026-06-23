/**
 * @file dragManager.js
 * @fileoverview Global Drag Manager - Mouse-based drag-drop system
 * @module dragManager
 * @author SV-PUB Team
 * @description
 * HTML5 Drag API has issues with nested containers and cross-component drops.
 * This module uses mouse events for reliable drag-drop across any containers.
 * 
 * **How it works:**
 * 1. Source component calls startDrag() on mousedown
 * 2. This module tracks mouse movement and shows ghost element
 * 3. Target component registers as drop zone
 * 4. On mouseup, if over drop zone, callback is fired
 * 
 * @example
 * import { startDrag, registerDropZone } from './utils/dragManager.js';
 * registerDropZone('my-zone', { element: el, onDrop: handleDrop });
 * startDrag({ data: channelId, type: 'channel', label: 'Va' });
 */

// ============================================================================
// DRAG STATE
// ============================================================================

const state = {
    isDragging: false,
    dragData: null,        // Data being dragged (e.g., channel ID)
    dragType: null,        // Type of drag (e.g., 'channel')
    ghostElement: null,    // Visual clone that follows mouse
    startX: 0,
    startY: 0,
    dropZones: new Map()   // Registered drop zones
};

// ============================================================================
// GHOST ELEMENT
// ============================================================================

/**
 * Create ghost element that follows mouse during drag
 */
function createGhost(content, color = '#3b82f6') {
    const ghost = document.createElement('div');
    ghost.className = 'drag-ghost';
    ghost.innerHTML = `
        <span class="drag-ghost-icon">📦</span>
        <span class="drag-ghost-text">${content}</span>
    `;
    ghost.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        padding: 8px 12px;
        background: ${color};
        color: white;
        border-radius: 6px;
        font-size: 12px;
        font-weight: 600;
        box-shadow: 0 4px 12px rgba(0,0,0,0.2);
        pointer-events: none;
        z-index: 10000;
        display: flex;
        align-items: center;
        gap: 6px;
        transform: translate(-50%, -50%);
        opacity: 0.9;
    `;
    document.body.appendChild(ghost);
    return ghost;
}

/**
 * Remove ghost element
 */
function removeGhost() {
    if (state.ghostElement) {
        state.ghostElement.remove();
        state.ghostElement = null;
    }
}

// ============================================================================
// DROP ZONE MANAGEMENT
// ============================================================================

/**
 * Register a drop zone
 * @memberof module:dragManager
 * @param {string} id - Unique ID for this drop zone
 * @param {Object} config - Drop zone configuration
 * @param {HTMLElement} config.element - The DOM element that is the drop zone
 * @param {string[]} config.acceptTypes - Array of drag types this zone accepts
 * @param {Function} config.onDrop - Callback when item dropped: (dragData, dragType) => void
 * @param {Function} [config.onDragEnter] - Called when drag enters zone
 * @param {Function} [config.onDragLeave] - Called when drag leaves zone
 */
export function registerDropZone(id, config) {
    state.dropZones.set(id, {
        element: config.element,
        acceptTypes: config.acceptTypes || [],
        onDrop: config.onDrop,
        onDragEnter: config.onDragEnter || (() => {}),
        onDragLeave: config.onDragLeave || (() => {}),
        isOver: false
    });
    console.log(`[DragManager] Drop zone registered: ${id}`);
}

/**
 * Unregister a drop zone
 * @memberof module:dragManager
 * @param {string} id - Drop zone ID
 */
export function unregisterDropZone(id) {
    state.dropZones.delete(id);
}

// ============================================================================
// DRAG OPERATIONS
// ============================================================================

/**
 * Start a drag operation
 * @memberof module:dragManager
 * @param {Object} options - Drag options
 * @param {any} options.data - Data to pass to drop zone (e.g., channel ID)
 * @param {string} options.type - Type of drag (e.g., 'channel')
 * @param {string} options.label - Label to show in ghost element
 * @param {string} options.color - Ghost element color
 * @param {MouseEvent} options.event - The mousedown event
 */
export function startDrag(options) {
    const { data, type, label, color, event } = options;
    
    state.isDragging = true;
    state.dragData = data;
    state.dragType = type;
    state.startX = event.clientX;
    state.startY = event.clientY;
    
    // Create ghost element
    state.ghostElement = createGhost(label || String(data), color);
    state.ghostElement.style.left = `${event.clientX}px`;
    state.ghostElement.style.top = `${event.clientY}px`;
    
    // Add dragging class to body
    document.body.classList.add('is-dragging');
    
    console.log(`[DragManager] Drag started: ${type} = ${data}`);
}

/**
 * End the current drag operation
 * @memberof module:dragManager
 */
export function endDrag() {
    // Clear all drop zone hover states
    state.dropZones.forEach((zone, id) => {
        if (zone.isOver) {
            zone.onDragLeave();
            zone.isOver = false;
        }
    });
    
    state.isDragging = false;
    state.dragData = null;
    state.dragType = null;
    
    removeGhost();
    document.body.classList.remove('is-dragging');
    
    console.log('[DragManager] Drag ended');
}

/**
 * Check if currently dragging
 * @memberof module:dragManager
 * @returns {boolean}
 */
export function isDragging() {
    return state.isDragging;
}

/**
 * Get current drag data
 * @memberof module:dragManager
 * @returns {{data: any, type: string}}
 */
export function getDragData() {
    return { data: state.dragData, type: state.dragType };
}

// ============================================================================
// MOUSE EVENT HANDLERS (Document Level)
// ============================================================================

/**
 * Handle mouse move - update ghost position and check drop zones
 */
function handleMouseMove(e) {
    if (!state.isDragging) return;
    
    // Move ghost element
    if (state.ghostElement) {
        state.ghostElement.style.left = `${e.clientX}px`;
        state.ghostElement.style.top = `${e.clientY}px`;
    }
    
    // Check which drop zone mouse is over
    state.dropZones.forEach((zone, id) => {
        if (!zone.element) return;
        
        // Check if this zone accepts current drag type
        if (!zone.acceptTypes.includes(state.dragType)) return;
        
        const rect = zone.element.getBoundingClientRect();
        const isOver = (
            e.clientX >= rect.left &&
            e.clientX <= rect.right &&
            e.clientY >= rect.top &&
            e.clientY <= rect.bottom
        );
        
        // State changed?
        if (isOver && !zone.isOver) {
            zone.isOver = true;
            zone.onDragEnter();
        } else if (!isOver && zone.isOver) {
            zone.isOver = false;
            zone.onDragLeave();
        }
    });
}

/**
 * Handle mouse up - check for drop and end drag
 */
function handleMouseUp(e) {
    if (!state.isDragging) return;
    
    // Find drop zone under cursor
    let dropped = false;
    
    state.dropZones.forEach((zone, id) => {
        if (!zone.element || dropped) return;
        
        // Check if this zone accepts current drag type
        if (!zone.acceptTypes.includes(state.dragType)) return;
        
        const rect = zone.element.getBoundingClientRect();
        const isOver = (
            e.clientX >= rect.left &&
            e.clientX <= rect.right &&
            e.clientY >= rect.top &&
            e.clientY <= rect.bottom
        );
        
        if (isOver) {
            console.log(`[DragManager] Dropped on zone: ${id}`);
            zone.onDrop(state.dragData, state.dragType);
            dropped = true;
        }
    });
    
    endDrag();
}

// ============================================================================
// INITIALIZATION
// ============================================================================

/**
 * Initialize the drag manager - sets up document-level event listeners.
 * Call this once when app starts.
 * @memberof module:dragManager
 */
export function initDragManager() {
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    
    // Also handle if mouse leaves window during drag
    document.addEventListener('mouseleave', () => {
        if (state.isDragging) {
            endDrag();
        }
    });
    
    console.log('[DragManager] ✅ Initialized');
}

// ============================================================================
// EXPORTS
// ============================================================================

export default {
    initDragManager,
    registerDropZone,
    unregisterDropZone,
    startDrag,
    endDrag,
    isDragging,
    getDragData
};
