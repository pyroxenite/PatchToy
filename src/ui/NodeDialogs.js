import { CodeEditor } from './CodeEditor.js';
import { FloatingCodeEditor } from './FloatingCodeEditor.js';
import { UIHelpers } from './UIHelpers.js';
import { NodeDefinitions } from '../core/NodeDefinitions.js';

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
                    UIHelpers.notify('Write a GLSL function first.', 'warning');
                    return false; // Keep editor open
                }

                // Extract function name to use as node name
                const funcMatch = glslCode.match(/(\w+)\s+(\w+)\s*\(/);
                if (!funcMatch) {
                    UIHelpers.notify('Could not find a GLSL function. Use a signature like: vec3 myFunc(vec2 uv)', 'error', { title: 'Could not parse function' });
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
            // The definition's GLSL now (undo / redo of a custom node update replaces it)
            source: () => {
                const def = NodeDefinitions[node.type];
                return def && def.customGLSL ? def.customGLSL : null;
            },
            onSave: (code) => {
                const glslCode = code.trim();
                if (!glslCode) {
                    UIHelpers.notify('Write a GLSL function first.', 'warning');
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
            UIHelpers.notify('No compiled shader yet — connect something to this preview first.', 'info');
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
        // (clamped: HDR / out-of-range values from a file would make an invalid hex)
        const hex = (v) => Math.floor(Math.max(0, Math.min(1, Number(v) || 0)) * 255).toString(16).padStart(2, '0');
        const r = hex(node.data.r);
        const g = hex(node.data.g);
        const b = hex(node.data.b);
        colorInput.value = `#${r}${g}${b}`;

        // Position the (invisible) input over the node so the native picker opens next to it.
        // Graph -> screen: screen = canvasRect + pan + graph * zoom
        const canvasRect = nodeCanvas.getBoundingClientRect();
        const graph = node.graph || {};
        const zoom = graph.zoom || 1;
        const panX = graph.panX || 0;
        const panY = graph.panY || 0;
        const swatchX = node.x + 10;
        const swatchY = node.y + (node.height ? Math.min(node.height - 8, 35) : 35);
        const left = canvasRect.left + panX + swatchX * zoom;
        const top = canvasRect.top + panY + swatchY * zoom;

        colorInput.style.left = Math.max(0, Math.min(left, window.innerWidth - 2)) + 'px';
        colorInput.style.top = Math.max(0, Math.min(top, window.innerHeight - 2)) + 'px';

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
