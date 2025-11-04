import { CodeEditor } from './CodeEditor.js';
import { FloatingCodeEditor } from './FloatingCodeEditor.js';

export class NodeDialogs {
    static showCustomNodeDialog(onCreateNode) {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background: rgba(0,0,0,0.7); display: flex; align-items: center; justify-content: center; z-index: 10000;';

        const dialog = document.createElement('div');
        dialog.style.cssText = 'background: #2d2d2d; border: 1px solid #444; border-radius: 8px; padding: 20px; width: 600px; max-width: 90vw; max-height: 80vh; display: flex; flex-direction: column; gap: 15px;';

        // Title
        const title = document.createElement('h2');
        title.textContent = 'Create Custom GLSL Node';
        title.style.cssText = 'margin: 0; color: #fff; font-size: 18px;';

        // GLSL code editor container
        const codeLabel = document.createElement('label');
        codeLabel.textContent = 'GLSL Function:';
        codeLabel.style.cssText = 'color: #fff; font-size: 14px;';

        const editorContainer = document.createElement('div');
        editorContainer.style.cssText = 'height: 400px; border: 1px solid #444; border-radius: 4px; overflow: hidden;';

        // Help text
        const helpText = document.createElement('div');
        helpText.innerHTML = 'Use magic comments to customize your node. The function name will be used as the node name.<br>Example: <code>// @title My Custom Node</code>';
        helpText.style.cssText = 'color: #888; font-size: 12px; font-style: italic;';

        // Buttons
        const buttonContainer = document.createElement('div');
        buttonContainer.style.cssText = 'display: flex; gap: 10px; justify-content: flex-end;';

        const cancelBtn = document.createElement('button');
        cancelBtn.textContent = 'Cancel';
        cancelBtn.style.cssText = 'padding: 8px 16px; background: #444; border: 1px solid #666; border-radius: 4px; color: #fff; cursor: pointer;';
        cancelBtn.addEventListener('click', () => {
            editor.dispose();
            overlay.remove();
        });

        const createBtn = document.createElement('button');
        createBtn.textContent = 'Create';
        createBtn.style.cssText = 'padding: 8px 16px; background: #007acc; border: 1px solid #007acc; border-radius: 4px; color: #fff; cursor: pointer;';

        buttonContainer.appendChild(cancelBtn);
        buttonContainer.appendChild(createBtn);

        dialog.appendChild(title);
        dialog.appendChild(codeLabel);
        dialog.appendChild(editorContainer);
        dialog.appendChild(helpText);
        dialog.appendChild(buttonContainer);

        overlay.appendChild(dialog);
        document.body.appendChild(overlay);

        // Prevent keyboard events from propagating to the node graph
        const stopPropagation = (e) => e.stopPropagation();
        overlay.addEventListener('keydown', stopPropagation, true);
        overlay.addEventListener('keyup', stopPropagation, true);
        overlay.addEventListener('keypress', stopPropagation, true);

        // Template with magic comments
        const template = `// @title My Custom Node
/* @category custom
 * @input uv "UV"
 * @input time "Time"
 * @description
 * This is a custom node.
 */

vec3 myFunction(vec2 uv, float time) {
    return vec3(uv, sin(time));
}`;

        // Initialize Code Editor
        const editor = new CodeEditor({
            language: 'glsl',
            value: template
        });
        editor.mount(editorContainer);

        // Add click handler to create button
        createBtn.addEventListener('click', () => {
            const glslCode = editor.getValue().trim();

            if (!glslCode) {
                alert('Please provide GLSL code.');
                return;
            }

            // Extract function name to use as node name
            const funcMatch = glslCode.match(/(\w+)\s+(\w+)\s*\(/);
            if (!funcMatch) {
                alert('Could not parse function name. Please ensure your code has a valid GLSL function.');
                return;
            }

            const nodeName = funcMatch[2];

            const success = onCreateNode(nodeName, glslCode);
            if (success) {
                editor.dispose();
                overlay.remove();
            }
        });

        // Focus the editor
        setTimeout(() => editor.focus(), 0);

        // Close on escape
        const escapeHandler = (e) => {
            if (e.key === 'Escape') {
                editor.dispose();
                overlay.remove();
                overlay.removeEventListener('keydown', stopPropagation, true);
                overlay.removeEventListener('keyup', stopPropagation, true);
                overlay.removeEventListener('keypress', stopPropagation, true);
                document.removeEventListener('keydown', escapeHandler);
            }
        };
        document.addEventListener('keydown', escapeHandler);
    }

    static showEditNodeDialog(node, nodeDefinition, onSave, editorState = null) {
        if (!nodeDefinition || !nodeDefinition.customGLSL) return;

        // Check if an editor for this node type is already open
        const existingEditor = FloatingCodeEditor.findByNodeType(node.type);
        if (existingEditor) {
            // Bring existing editor to front instead of opening a new one
            existingEditor.bringToFront();
            return existingEditor;
        }

        // Determine initial value: use dirty value if available, otherwise node definition
        const initialValue = editorState?.isDirty && editorState?.dirtyValue
            ? editorState.dirtyValue
            : nodeDefinition.customGLSL;

        // Create floating code editor
        const editor = new FloatingCodeEditor({
            title: `Edit ${node.type}`,
            language: 'glsl',
            value: initialValue,
            nodeType: node.type, // Track the node type for deduplication
            position: editorState?.position,
            size: editorState?.size,
            onSave: (code) => {
                const glslCode = code.trim();
                if (!glslCode) {
                    alert('Please provide GLSL code.');
                    return null;
                }

                // Call onSave and return the result (potentially updated code)
                return onSave(node.type, glslCode);
            }
        });

        // If restoring dirty state, mark as dirty (but keep original value from definition)
        if (editorState?.isDirty) {
            editor.originalValue = nodeDefinition.customGLSL;
            editor.isDirty = true;
            editor.updateButtonVisibility();
        }

        return editor;
    }

    static showGeneratedCode(shaderSource) {
        if (!shaderSource) {
            alert('No shader code available');
            return;
        }

        new FloatingCodeEditor({
            title: 'Generated Fragment Shader',
            language: 'glsl',
            value: shaderSource,
            readOnly: true
        });
    }

    static showColorPicker(node, colorInput, nodeCanvas, onColorChange) {
        // Convert RGB (0-1) to hex
        const r = Math.floor(node.data.r * 255).toString(16).padStart(2, '0');
        const g = Math.floor(node.data.g * 255).toString(16).padStart(2, '0');
        const b = Math.floor(node.data.b * 255).toString(16).padStart(2, '0');
        colorInput.value = `#${r}${g}${b}`;

        // Position the input at the color swatch location
        const canvasRect = nodeCanvas.getBoundingClientRect();
        const colorSwatchX = node.x + 10;
        const colorSwatchY = node.y + 35;

        colorInput.style.left = (canvasRect.left + colorSwatchX) + 'px';
        colorInput.style.top = (canvasRect.top + colorSwatchY) + 'px';

        // Store current node for color change handler
        colorInput._currentNode = node;
        colorInput._onColorChange = onColorChange;

        // Wait for next frame, then focus and click to open native picker
        requestAnimationFrame(() => {
            colorInput.focus();
            colorInput.click();
        });
    }
}
