import { CodeEditor } from './CodeEditor.js';
import { FloatingCodeEditor } from './FloatingCodeEditor.js';

export class NodeDialogs {
    static showCustomNodeDialog(onCreateNode) {
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

        // Use FloatingCodeEditor with creation mode labels
        const editor = new FloatingCodeEditor({
            title: 'Create Custom GLSL Node',
            language: 'glsl',
            value: template,
            saveButtonLabel: 'Create',
            closeButtonLabel: 'Cancel',
            onSave: (code) => {
                const glslCode = code.trim();

                if (!glslCode) {
                    alert('Please provide GLSL code.');
                    return false; // Keep editor open
                }

                // Extract function name to use as node name
                const funcMatch = glslCode.match(/(\w+)\s+(\w+)\s*\(/);
                if (!funcMatch) {
                    alert('Could not parse function name. Please ensure your code has a valid GLSL function.');
                    return false; // Keep editor open
                }

                const nodeName = funcMatch[2];
                const result = onCreateNode(nodeName, glslCode);

                // Return result to determine if editor should close
                return result && result.success !== false;
            },
            onClose: () => {
                // Editor will auto-close and clean up
            }
        });
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
