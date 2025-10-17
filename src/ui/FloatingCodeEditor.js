import { CodeEditor } from './CodeEditor.js';

/**
 * Floating, draggable code editor window
 * Can have multiple instances open simultaneously
 */
export class FloatingCodeEditor {
    constructor(options = {}) {
        this.title = options.title || 'Code Editor';
        this.language = options.language || 'glsl';
        this.value = options.value || '';
        this.readOnly = options.readOnly || false;
        this.onSave = options.onSave || null;
        this.onClose = options.onClose || null;

        // Track all open editors
        if (!FloatingCodeEditor.instances) {
            FloatingCodeEditor.instances = [];
            FloatingCodeEditor.nextZIndex = 10000;
        }

        this.create();
        FloatingCodeEditor.instances.push(this);
    }

    create() {
        // Create floating window
        this.window = document.createElement('div');
        this.window.className = 'floating-code-editor';
        this.window.style.cssText = `
            position: fixed;
            width: 600px;
            height: 500px;
            background: #2d2d2d;
            border: 1px solid #444;
            border-radius: 8px;
            display: flex;
            flex-direction: column;
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
            z-index: ${FloatingCodeEditor.nextZIndex++};
        `;

        // Center the window initially with slight offset for each new instance
        const offset = (FloatingCodeEditor.instances.length * 30) % 200;
        this.window.style.left = `calc(50% - 300px + ${offset}px)`;
        this.window.style.top = `calc(50% - 250px + ${offset}px)`;

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

        const buttonGroup = document.createElement('div');
        buttonGroup.style.cssText = 'display: flex; gap: 8px;';

        // Add Save and Close buttons for editable editors
        if (this.onSave && !this.readOnly) {
            const saveBtn = document.createElement('button');
            saveBtn.textContent = 'Save';
            saveBtn.style.cssText = `
                background: #007acc;
                border: none;
                color: #fff;
                font-size: 13px;
                cursor: pointer;
                padding: 6px 12px;
                border-radius: 4px;
            `;
            saveBtn.addEventListener('mouseenter', () => saveBtn.style.background = '#005a9e');
            saveBtn.addEventListener('mouseleave', () => saveBtn.style.background = '#007acc');
            saveBtn.addEventListener('click', () => {
                if (this.onSave) {
                    this.onSave(this.editor.getValue());
                }
            });

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

            buttonGroup.appendChild(saveBtn);
            buttonGroup.appendChild(closeBtn);
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

            buttonGroup.appendChild(closeBtn);
        }

        titleBar.appendChild(titleText);
        titleBar.appendChild(buttonGroup);

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
            readOnly: this.readOnly
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

    static closeAll() {
        const instances = [...FloatingCodeEditor.instances];
        instances.forEach(editor => editor.close());
    }
}
