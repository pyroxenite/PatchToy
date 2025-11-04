import { CodeEditor } from './CodeEditor.js';

/**
 * Floating, draggable code editor window
 * Can have multiple instances open simultaneously
 */
export class FloatingCodeEditor {
    // Initialize static properties
    static instances = [];
    static nextZIndex = 10000;

    constructor(options = {}) {
        this.title = options.title || 'Code Editor';
        this.language = options.language || 'glsl';
        this.value = options.value || '';
        this.readOnly = options.readOnly || false;
        this.onSave = options.onSave || null;
        this.onClose = options.onClose || null;

        // Track node type for deduplication (e.g., "Edit MyCustomNode")
        this.nodeType = options.nodeType || null;

        // Track dirty state
        this.isDirty = false;
        this.originalValue = this.value;

        // Track position and size for persistence
        this.position = options.position || null; // { left, top }
        this.size = options.size || { width: 600, height: 500 };

        this.create();
        FloatingCodeEditor.instances.push(this);
    }

    create() {
        // Create floating window
        this.window = document.createElement('div');
        this.window.className = 'floating-code-editor';
        this.window.style.cssText = `
            position: fixed;
            width: ${this.size.width}px;
            height: ${this.size.height}px;
            background: #2d2d2d;
            border: 1px solid #444;
            border-radius: 8px;
            display: flex;
            flex-direction: column;
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
            z-index: ${FloatingCodeEditor.nextZIndex++};
        `;

        // Position the window
        if (this.position) {
            // Use stored position, but ensure it's within viewport
            const adjusted = this.adjustPositionToViewport(
                this.position.left,
                this.position.top,
                this.size.width,
                this.size.height
            );
            this.window.style.left = adjusted.left + 'px';
            this.window.style.top = adjusted.top + 'px';
        } else {
            // Center the window initially with slight offset for each new instance
            const offset = (FloatingCodeEditor.instances.length * 30) % 200;
            this.window.style.left = `calc(50% - ${this.size.width / 2}px + ${offset}px)`;
            this.window.style.top = `calc(50% - ${this.size.height / 2}px + ${offset}px)`;
        }

        // Title bar
        const titleBar = document.createElement('div');
        titleBar.className = 'floating-editor-titlebar';
        titleBar.style.cssText = `
            background: #1e1e1e;
            padding: 10px 15px;
            border-bottom: 1px solid #444;
            border-radius: 8px 8px 0 0;
            display: flex;
            justify-content: space-between;
            align-items: center;
            cursor: move;
            user-select: none;
        `;

        const titleText = document.createElement('div');
        titleText.textContent = this.title;
        titleText.style.cssText = 'color: #fff; font-size: 14px; font-weight: 600;';

        this.buttonGroup = document.createElement('div');
        this.buttonGroup.style.cssText = 'display: flex; gap: 8px;';

        // Create button references for editable editors
        if (this.onSave && !this.readOnly) {
            // Create Revert button
            this.revertBtn = document.createElement('button');
            this.revertBtn.textContent = 'Revert';
            this.revertBtn.style.cssText = `
                background: #444;
                border: none;
                color: #fff;
                font-size: 13px;
                cursor: pointer;
                padding: 6px 12px;
                border-radius: 4px;
                display: none;
            `;
            this.revertBtn.addEventListener('mouseenter', () => this.revertBtn.style.background = '#555');
            this.revertBtn.addEventListener('mouseleave', () => this.revertBtn.style.background = '#444');
            this.revertBtn.addEventListener('click', () => this.revert());

            // Create Save button
            this.saveBtn = document.createElement('button');
            this.saveBtn.textContent = 'Save';
            this.saveBtn.style.cssText = `
                background: #007acc;
                border: none;
                color: #fff;
                font-size: 13px;
                cursor: pointer;
                padding: 6px 12px;
                border-radius: 4px;
                display: none;
            `;
            this.saveBtn.addEventListener('mouseenter', () => this.saveBtn.style.background = '#005a9e');
            this.saveBtn.addEventListener('mouseleave', () => this.saveBtn.style.background = '#007acc');
            this.saveBtn.addEventListener('click', () => this.save());

            // Create Close button
            this.closeBtn = document.createElement('button');
            this.closeBtn.textContent = 'Close';
            this.closeBtn.style.cssText = `
                background: #444;
                border: none;
                color: #fff;
                font-size: 13px;
                cursor: pointer;
                padding: 6px 12px;
                border-radius: 4px;
            `;
            this.closeBtn.addEventListener('mouseenter', () => this.closeBtn.style.background = '#555');
            this.closeBtn.addEventListener('mouseleave', () => this.closeBtn.style.background = '#444');
            this.closeBtn.addEventListener('click', () => this.close());

            this.buttonGroup.appendChild(this.revertBtn);
            this.buttonGroup.appendChild(this.saveBtn);
            this.buttonGroup.appendChild(this.closeBtn);
        } else {
            // For read-only editors, just show close button
            const closeBtn = document.createElement('button');
            closeBtn.textContent = 'Close';
            closeBtn.style.cssText = `
                background: #444;
                border: none;
                color: #fff;
                font-size: 13px;
                cursor: pointer;
                padding: 6px 12px;
                border-radius: 4px;
            `;
            closeBtn.addEventListener('mouseenter', () => closeBtn.style.background = '#555');
            closeBtn.addEventListener('mouseleave', () => closeBtn.style.background = '#444');
            closeBtn.addEventListener('click', () => this.close());

            this.buttonGroup.appendChild(closeBtn);
        }

        titleBar.appendChild(titleText);
        titleBar.appendChild(this.buttonGroup);

        // Editor container
        const editorContainer = document.createElement('div');
        editorContainer.style.cssText = 'flex: 1; overflow: hidden;';

        // Assemble window (no bottom button bar)
        this.window.appendChild(titleBar);
        this.window.appendChild(editorContainer);

        // Initialize code editor
        this.editor = new CodeEditor({
            language: this.language,
            value: this.value,
            readOnly: this.readOnly,
            onChange: () => this.updateDirtyState()
        });
        this.editor.mount(editorContainer);

        // Make draggable
        this.makeDraggable(titleBar);

        // Make resizable
        this.makeResizable();

        // Focus on click
        this.window.addEventListener('mousedown', () => this.bringToFront());

        // Add to document
        document.body.appendChild(this.window);

        // Bring to front initially
        this.bringToFront();

        // Update button visibility
        this.updateButtonVisibility();
    }

    updateDirtyState() {
        const currentValue = this.editor.getValue();
        this.isDirty = currentValue !== this.originalValue;
        this.updateButtonVisibility();
    }

    updateButtonVisibility() {
        if (!this.onSave || this.readOnly) return;

        if (this.isDirty) {
            // Show [Revert] [Save], hide [Close]
            this.revertBtn.style.display = '';
            this.saveBtn.style.display = '';
            this.closeBtn.style.display = 'none';
        } else {
            // Hide [Revert] [Save], show [Close]
            this.revertBtn.style.display = 'none';
            this.saveBtn.style.display = 'none';
            this.closeBtn.style.display = '';
        }
    }

    revert() {
        this.editor.setValue(this.originalValue);
        this.isDirty = false;
        this.updateButtonVisibility();
    }

    save() {
        if (this.onSave) {
            const result = this.onSave(this.editor.getValue());

            // If onSave returns updated code (e.g., with magic comments), update the editor
            if (typeof result === 'string') {
                this.setValue(result);
            }
        }
    }

    makeDraggable(handle) {
        let isDragging = false;
        let currentX, currentY, initialX, initialY;

        handle.addEventListener('mousedown', (e) => {
            if (e.target === handle || e.target.parentElement === handle) {
                isDragging = true;
                initialX = e.clientX - this.window.offsetLeft;
                initialY = e.clientY - this.window.offsetTop;
            }
        });

        document.addEventListener('mousemove', (e) => {
            if (isDragging) {
                e.preventDefault();
                currentX = e.clientX - initialX;
                currentY = e.clientY - initialY;

                // Keep window within viewport
                const maxX = window.innerWidth - this.window.offsetWidth;
                const maxY = window.innerHeight - this.window.offsetHeight;
                currentX = Math.max(0, Math.min(currentX, maxX));
                currentY = Math.max(0, Math.min(currentY, maxY));

                this.window.style.left = currentX + 'px';
                this.window.style.top = currentY + 'px';
            }
        });

        document.addEventListener('mouseup', () => {
            isDragging = false;
        });
    }

    makeResizable() {
        const resizeHandle = document.createElement('div');
        resizeHandle.style.cssText = `
            position: absolute;
            bottom: 0;
            right: 0;
            width: 20px;
            height: 20px;
            cursor: nwse-resize;
            z-index: 1;
        `;

        let isResizing = false;
        let startX, startY, startWidth, startHeight;

        resizeHandle.addEventListener('mousedown', (e) => {
            isResizing = true;
            startX = e.clientX;
            startY = e.clientY;
            startWidth = parseInt(this.window.style.width, 10);
            startHeight = parseInt(this.window.style.height, 10);
            e.preventDefault();
        });

        document.addEventListener('mousemove', (e) => {
            if (isResizing) {
                const width = startWidth + (e.clientX - startX);
                const height = startHeight + (e.clientY - startY);

                // Min/max constraints
                this.window.style.width = Math.max(400, Math.min(width, window.innerWidth - 40)) + 'px';
                this.window.style.height = Math.max(300, Math.min(height, window.innerHeight - 40)) + 'px';

                // Trigger editor layout update
                if (this.editor && this.editor.layout) {
                    this.editor.layout();
                }
            }
        });

        document.addEventListener('mouseup', () => {
            isResizing = false;
        });

        this.window.appendChild(resizeHandle);
    }

    bringToFront() {
        this.window.style.zIndex = FloatingCodeEditor.nextZIndex++;
    }

    getValue() {
        return this.editor.getValue();
    }

    setValue(value) {
        this.editor.setValue(value);
        this.originalValue = value;
        this.isDirty = false;
        this.updateButtonVisibility();
    }

    /**
     * Adjust position to ensure window is within viewport
     * At least the title bar should be visible
     */
    adjustPositionToViewport(left, top, width, height) {
        const titleBarHeight = 40; // Approximate title bar height
        const minVisibleHeight = titleBarHeight;

        // Get viewport dimensions
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;

        // Ensure left edge is not completely off screen (allow partial left overflow)
        const minLeft = -(width - 100); // Allow up to width-100px to be off-screen left
        const maxLeft = viewportWidth - 100; // At least 100px visible on the right

        // Ensure top is visible (at least title bar)
        const minTop = 0;
        const maxTop = viewportHeight - minVisibleHeight;

        return {
            left: Math.max(minLeft, Math.min(left, maxLeft)),
            top: Math.max(minTop, Math.min(top, maxTop))
        };
    }

    /**
     * Get current state for serialization
     */
    getState() {
        const state = {
            nodeType: this.nodeType,
            position: {
                left: parseInt(this.window.style.left) || 0,
                top: parseInt(this.window.style.top) || 0
            },
            size: {
                width: parseInt(this.window.style.width) || 600,
                height: parseInt(this.window.style.height) || 500
            }
        };

        // Include dirty state for restoration (but not saved to node definition)
        if (this.isDirty) {
            state.isDirty = true;
            state.dirtyValue = this.editor.getValue();
        }

        return state;
    }

    close() {
        if (this.onClose) {
            this.onClose();
        }

        // Remove from instances
        const index = FloatingCodeEditor.instances.indexOf(this);
        if (index > -1) {
            FloatingCodeEditor.instances.splice(index, 1);
        }

        // Dispose editor and remove window
        this.editor.dispose();
        this.window.remove();
    }

    /**
     * Find an existing editor for a specific node type
     */
    static findByNodeType(nodeType) {
        if (!FloatingCodeEditor.instances) {
            return null;
        }
        return FloatingCodeEditor.instances.find(editor => editor.nodeType === nodeType);
    }

    /**
     * Get states of all open editors for serialization
     */
    static getAllStates() {
        if (!FloatingCodeEditor.instances) {
            return [];
        }
        return FloatingCodeEditor.instances
            .filter(editor => editor.nodeType) // Only serialize editors with node types
            .map(editor => editor.getState());
    }

    static closeAll() {
        if (!FloatingCodeEditor.instances || FloatingCodeEditor.instances.length === 0) {
            return;
        }
        const instances = [...FloatingCodeEditor.instances];
        instances.forEach(editor => editor.close());
    }
}
