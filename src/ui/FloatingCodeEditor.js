import { CodeEditor } from './CodeEditor.js';
import { iconEl } from './icons.js';
import { UIHelpers } from './UIHelpers.js';

/**
 * Floating, draggable code editor window
 * Can have multiple instances open simultaneously
 */
export class FloatingCodeEditor {
    // Initialize static properties
    static instances = [];
    static nextZIndex = 2000;

    constructor(options = {}) {
        this.title = options.title || 'Code Editor';
        this.language = options.language || 'glsl';
        this.value = options.value || '';
        this.readOnly = options.readOnly || false;
        this.onSave = options.onSave || null;
        this.onClose = options.onClose || null;
        // source(): the text the edited thing has right now (node code, custom node GLSL),
        // null when it no longer exists. Undo / redo can change it behind the editor:
        // see syncFromSource().
        this.source = typeof options.source === 'function' ? options.source : null;

        // Track node type for deduplication (e.g., "Edit MyCustomNode")
        this.nodeType = options.nodeType || null;

        // Button labels (allow customization for create vs edit mode)
        this.saveButtonLabel = options.saveButtonLabel || 'Save';
        this.closeButtonLabel = options.closeButtonLabel || 'Close';

        // Creation mode: always show save/cancel buttons (don't wait for changes)
        this.isCreationMode = options.saveButtonLabel === 'Create';

        // Track dirty state
        this.isDirty = this.isCreationMode; // Start as "dirty" in creation mode
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
        this.window.className = 'floating-code-editor pt-window';
        this.window.style.width = `${this.size.width}px`;
        this.window.style.height = `${this.size.height}px`;
        this.window.style.zIndex = FloatingCodeEditor.nextZIndex++;

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
            // Center the window with a slight cascade for each new instance
            const offset = (FloatingCodeEditor.instances.length * 28) % 196;
            const left = Math.max(12, Math.round((window.innerWidth - this.size.width) / 2) + offset);
            const top = Math.max(56, Math.round((window.innerHeight - this.size.height) / 2) + offset);
            this.window.style.left = left + 'px';
            this.window.style.top = top + 'px';
        }

        // Title bar
        const titleBar = document.createElement('div');
        titleBar.className = 'floating-editor-titlebar pt-window-titlebar';

        const titleIcon = iconEl(this.readOnly ? 'file' : 'code');
        const titleText = document.createElement('div');
        titleText.className = 'pt-window-title';
        titleText.textContent = this.title;
        const dirtyDot = document.createElement('span');
        dirtyDot.className = 'pt-window-dirty';
        dirtyDot.title = 'Unsaved changes';
        const langBadge = document.createElement('span');
        langBadge.className = 'pt-badge';
        langBadge.textContent = this.readOnly ? `${this.language} · read-only` : this.language;
        const spacer = document.createElement('span');
        spacer.className = 'pt-window-spacer';

        this.buttonGroup = document.createElement('div');
        this.buttonGroup.className = 'pt-window-actions';

        const mkBtn = (label, variant, onClick) => {
            const b = document.createElement('button');
            b.className = `pt-btn pt-btn--sm${variant ? ` pt-btn--${variant}` : ''}`;
            b.textContent = label;
            b.addEventListener('click', onClick);
            return b;
        };

        const mkClose = (label) => {
            const b = document.createElement('button');
            b.className = 'pt-icon-btn';
            b.setAttribute('data-tip', label);
            b.setAttribute('aria-label', label);
            b.appendChild(iconEl('close'));
            b.addEventListener('click', () => this.requestClose());
            return b;
        };

        if (this.onSave && !this.readOnly) {
            this.revertBtn = mkBtn('Revert', 'ghost', () => this.revert());
            this.saveBtn = mkBtn(this.saveButtonLabel, 'primary', () => this.save());
            this.saveBtn.setAttribute('data-tip', this.saveButtonLabel);
            this.saveBtn.setAttribute('data-kbd', '⌘S');
            this.closeBtn = mkClose(this.closeButtonLabel);

            this.buttonGroup.appendChild(this.revertBtn);
            this.buttonGroup.appendChild(this.saveBtn);
            this.buttonGroup.appendChild(this.closeBtn);
        } else {
            if (this.readOnly) {
                const copyBtn = document.createElement('button');
                copyBtn.className = 'pt-icon-btn';
                copyBtn.setAttribute('data-tip', 'Copy to clipboard');
                copyBtn.appendChild(iconEl('copy'));
                copyBtn.addEventListener('click', () => {
                    navigator.clipboard?.writeText(this.getValue()).then(
                        () => UIHelpers.toast('Shader source copied', 'success'),
                        () => UIHelpers.toast('Could not access the clipboard', 'error')
                    );
                });
                this.buttonGroup.appendChild(copyBtn);
            }
            this.buttonGroup.appendChild(mkClose('Close'));
        }

        titleBar.append(titleIcon, titleText, dirtyDot, langBadge, spacer, this.buttonGroup);

        // Editor container
        const editorContainer = document.createElement('div');
        editorContainer.className = 'pt-window-body';

        // "Changed outside the editor" bar (undo / redo while there are unsaved edits)
        this.noticeBar = document.createElement('div');
        this.noticeBar.className = 'pt-window-notice';
        this.noticeBar.hidden = true;
        this.noticeBar.style.cssText = 'display:flex;align-items:center;gap:8px;padding:6px 10px;font-size:12px;background:rgba(255,184,77,0.14);color:var(--pt-text,#ddd);border-bottom:1px solid rgba(255,184,77,0.35)';
        this.noticeBar.style.display = 'none';
        this.noticeText = document.createElement('span');
        this.noticeText.style.flex = '1';
        this.reloadBtn = UIHelpers.button('Reload', { size: 'sm', onClick: () => this.reloadFromSource() });
        this.noticeBar.append(this.noticeText, this.reloadBtn);

        this.window.appendChild(titleBar);
        this.window.appendChild(this.noticeBar);
        this.window.appendChild(editorContainer);

        // Initialize code editor
        this.editor = new CodeEditor({
            language: this.language,
            value: this.value,
            readOnly: this.readOnly,
            onChange: () => this.updateDirtyState()
        });
        this.editor.mount(editorContainer);

        // Cmd/Ctrl+S saves, Escape closes when clean
        this.window.addEventListener('keydown', (e) => {
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
                e.preventDefault();
                e.stopPropagation();
                if (this.onSave && !this.readOnly && this.isDirty) this.save();
            }
        }, true);

        // Make draggable
        this.makeDraggable(titleBar);

        // Make resizable
        this.makeResizable();

        // Focus on click
        this.window.addEventListener('mousedown', () => this.bringToFront());

        document.body.appendChild(this.window);

        this.bringToFront();
        this.updateButtonVisibility();
    }

    updateDirtyState() {
        const currentValue = this.editor.getValue();
        this.isDirty = currentValue !== this.originalValue;
        this.updateButtonVisibility();
    }

    updateButtonVisibility() {
        if (this.window) this.window.classList.toggle('is-dirty', !!this.isDirty && !this.isCreationMode);
        if (!this.onSave || this.readOnly) return;

        // [Revert] [Save] appear while there are unsaved edits; [x] is always available
        this.revertBtn.hidden = !this.isDirty || this.isCreationMode;
        this.saveBtn.hidden = !this.isDirty;
    }

    /** Close, asking first if there are unsaved edits. */
    async requestClose() {
        if (this.isDirty && !this.isCreationMode && this.onSave && !this.readOnly) {
            const discard = await UIHelpers.confirm({
                title: 'Discard unsaved changes?',
                message: `Your edits to “${this.nodeType || this.title}” haven’t been applied.`,
                confirmLabel: 'Discard',
                danger: true
            });
            if (!discard) return;
        }
        this.close();
    }

    revert() {
        this.editor.setValue(this.originalValue);
        this.isDirty = false;
        this.hideNotice();
        this.updateButtonVisibility();
    }

    /**
     * The edited text changed outside this editor (undo / redo). Clean editor: show the
     * new text. Unsaved edits: keep them, and say so ("Reload" takes the new text; Save
     * applies the edits on top of it on purpose). The edited thing is gone: say so too.
     */
    syncFromSource() {
        if (!this.source || this.readOnly) return;
        let text;
        try { text = this.source(); } catch (e) { text = null; }
        if (text === null || text === undefined) {
            this.showNotice('The edited node no longer exists (undo / redo).', false);
            this.sourceGone = true;
            return;
        }
        const wasGone = this.sourceGone;
        this.sourceGone = false;
        if (text === this.originalValue && !wasGone) {
            if (!this.isDirty) this.hideNotice();
            return;
        }
        if (!this.isDirty) {
            this.setValue(text);
            this.hideNotice();
            return;
        }
        // Keep the user's edits; the reference (Revert / dirty check) is the new text
        this.originalValue = text;
        this.updateDirtyState();
        if (this.isDirty) this.showNotice('Changed outside the editor (undo / redo). Saving applies your edits over it.', true);
        else this.hideNotice();
    }

    reloadFromSource() {
        let text = null;
        try { text = this.source ? this.source() : null; } catch (e) { text = null; }
        if (text === null || text === undefined) return;
        this.setValue(text);
        this.hideNotice();
    }

    showNotice(message, canReload) {
        if (!this.noticeBar) return;
        this.noticeText.textContent = message;
        this.reloadBtn.hidden = !canReload;
        this.noticeBar.hidden = false;
        this.noticeBar.style.display = 'flex';
    }

    hideNotice() {
        if (!this.noticeBar) return;
        this.noticeBar.hidden = true;
        this.noticeBar.style.display = 'none';
    }

    save() {
        if (this.sourceGone) {
            UIHelpers.notify('The edited node no longer exists - copy your code before closing this editor.', 'warning');
            return;
        }
        if (this.onSave) {
            const result = this.onSave(this.editor.getValue());

            // If onSave returns false, keep the editor open (validation failed)
            if (result === false) {
                return;
            }

            // If onSave returns updated code (e.g., with magic comments), update the editor
            if (typeof result === 'string') {
                this.setValue(result);
            }

            // If onSave returned true or a string, close the editor
            if (result === true || typeof result === 'string') {
                this.close();
            }
        }
    }

    /** Document-level move / up listeners only for the duration of one drag (no leak per window). */
    _trackPointer(onMove) {
        const move = (e) => onMove(e);
        const up = () => {
            document.removeEventListener('mousemove', move);
            document.removeEventListener('mouseup', up);
            this._untrack = null;
        };
        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', up);
        this._untrack = up;
    }

    makeDraggable(handle) {
        handle.addEventListener('mousedown', (e) => {
            if (e.target.closest('button')) return;
            const initialX = e.clientX - this.window.offsetLeft;
            const initialY = e.clientY - this.window.offsetTop;
            this._trackPointer((ev) => {
                ev.preventDefault();
                // Keep window within viewport
                const maxX = window.innerWidth - this.window.offsetWidth;
                const maxY = window.innerHeight - this.window.offsetHeight;
                const x = Math.max(0, Math.min(ev.clientX - initialX, maxX));
                const y = Math.max(0, Math.min(ev.clientY - initialY, Math.max(0, maxY)));
                this.window.style.left = x + 'px';
                this.window.style.top = y + 'px';
            });
        });
    }

    makeResizable() {
        const resizeHandle = document.createElement('div');
        resizeHandle.className = 'pt-window-resize';
        resizeHandle.appendChild(iconEl('grip'));

        resizeHandle.addEventListener('mousedown', (e) => {
            const startX = e.clientX;
            const startY = e.clientY;
            const startWidth = parseInt(this.window.style.width, 10);
            const startHeight = parseInt(this.window.style.height, 10);
            e.preventDefault();
            this._trackPointer((ev) => {
                const width = startWidth + (ev.clientX - startX);
                const height = startHeight + (ev.clientY - startY);
                // Min/max constraints
                this.window.style.width = Math.max(400, Math.min(width, window.innerWidth - 40)) + 'px';
                this.window.style.height = Math.max(300, Math.min(height, window.innerHeight - 40)) + 'px';
                // Trigger editor layout update
                if (this.editor && this.editor.layout) this.editor.layout();
            });
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

        // A drag in progress: drop its document listeners
        if (this._untrack) this._untrack();

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

    /** Bring every open editor in line with what it edits (after undo / redo). */
    static syncAll() {
        for (const editor of [...(FloatingCodeEditor.instances || [])]) {
            try { editor.syncFromSource(); } catch (e) { /* ignore */ }
        }
    }

    static closeAll() {
        if (!FloatingCodeEditor.instances || FloatingCodeEditor.instances.length === 0) {
            return;
        }
        const instances = [...FloatingCodeEditor.instances];
        instances.forEach(editor => editor.close());
    }
}

// Undo / redo (src/core/History.js) can change code an editor shows
if (typeof window !== 'undefined') {
    window.addEventListener('patchtoy:history', (e) => {
        const a = e.detail && e.detail.action;
        if (a === 'undo' || a === 'redo') FloatingCodeEditor.syncAll();
    });
}
