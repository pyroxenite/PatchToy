/**
 * Reusable code editor component with Monaco fallback
 * Supports GLSL and JavaScript with syntax highlighting
 */
export class CodeEditor {
    constructor(options = {}) {
        this.container = null;
        this.editor = null;
        this.monacoLoaded = false;
        this.language = options.language || 'glsl';
        this.value = options.value || '';
        this.readOnly = options.readOnly || false;
        this.theme = options.theme || 'vs-dark';
        this.onChange = options.onChange || (() => {});

        // Check if Monaco is available
        this.checkMonacoAvailability();
    }

    checkMonacoAvailability() {
        if (window.monaco) {
            this.monacoLoaded = true;
            return;
        }

        // Try to load Monaco if not already loaded
        if (window.require && window.require.config) {
            window.require.config({
                paths: {
                    'vs': 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.45.0/min/vs'
                }
            });

            window.require(['vs/editor/editor.main'], () => {
                this.monacoLoaded = true;
                // If editor was already created with fallback, upgrade it
                if (this.container && !this.editor) {
                    this.upgradeToMonaco();
                }
            }, (err) => {
                console.warn('Monaco editor failed to load, using textarea fallback:', err);
                this.monacoLoaded = false;
            });
        }
    }

    /**
     * Create and mount the editor to a container element
     * @param {HTMLElement} container - The container to mount the editor in
     * @returns {CodeEditor} - Returns this for chaining
     */
    mount(container) {
        this.container = container;
        container.innerHTML = ''; // Clear container

        if (this.monacoLoaded && window.monaco) {
            this.createMonacoEditor();
        } else {
            this.createFallbackEditor();
            // Try to upgrade when Monaco loads
            setTimeout(() => {
                if (window.monaco && !this.editor) {
                    this.upgradeToMonaco();
                }
            }, 1000);
        }

        return this;
    }

    createMonacoEditor() {
        // Register GLSL language if not already registered
        if (this.language === 'glsl' && !window.monaco.languages.getLanguages().find(l => l.id === 'glsl')) {
            window.monaco.languages.register({ id: 'glsl' });

            // Define GLSL syntax highlighting
            window.monaco.languages.setMonarchTokensProvider('glsl', {
                keywords: [
                    'attribute', 'const', 'uniform', 'varying', 'break', 'continue', 'do', 'for', 'while',
                    'if', 'else', 'in', 'out', 'inout', 'float', 'int', 'void', 'bool', 'true', 'false',
                    'discard', 'return', 'mat2', 'mat3', 'mat4', 'vec2', 'vec3', 'vec4', 'ivec2', 'ivec3',
                    'ivec4', 'bvec2', 'bvec3', 'bvec4', 'sampler2D', 'samplerCube', 'struct',
                    'precision', 'highp', 'mediump', 'lowp'
                ],

                builtinFunctions: [
                    'radians', 'degrees', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'pow', 'exp',
                    'log', 'exp2', 'log2', 'sqrt', 'inversesqrt', 'abs', 'sign', 'floor', 'ceil',
                    'fract', 'mod', 'min', 'max', 'clamp', 'mix', 'step', 'smoothstep', 'length',
                    'distance', 'dot', 'cross', 'normalize', 'faceforward', 'reflect', 'refract',
                    'matrixCompMult', 'lessThan', 'lessThanEqual', 'greaterThan', 'greaterThanEqual',
                    'equal', 'notEqual', 'any', 'all', 'not', 'texture2D', 'textureCube',
                    'texture2DProj', 'textureCubeProj', 'texture2DLod', 'textureCubeLod',
                    'texture2DProjLod', 'textureCubeProjLod', 'dFdx', 'dFdy', 'fwidth'
                ],

                tokenizer: {
                    root: [
                        [/[a-zA-Z_]\w*/, {
                            cases: {
                                '@keywords': 'keyword',
                                '@builtinFunctions': 'function',
                                '@default': 'identifier'
                            }
                        }],
                        [/[0-9]+\.?[0-9]*([eE][-+]?[0-9]+)?[fF]?/, 'number'],
                        [/"([^"\\]|\\.)*"/, 'string'],
                        [/\/\/.*$/, 'comment'],
                        [/\/\*/, 'comment', '@comment'],
                        [/[{}()\[\]]/, '@brackets'],
                        [/[;,.]/, 'delimiter'],
                        [/[<>!~?:&|+\-*\/\^%]+/, 'operator']
                    ],
                    comment: [
                        [/[^\/*]+/, 'comment'],
                        [/\*\//, 'comment', '@pop'],
                        [/[\/*]/, 'comment']
                    ]
                }
            });
        }

        this.editor = window.monaco.editor.create(this.container, {
            value: this.value,
            language: this.language,
            theme: this.theme,
            readOnly: this.readOnly,
            minimap: { enabled: false },
            fontSize: 13,
            lineNumbers: 'on',
            automaticLayout: true,
            scrollBeyondLastLine: false,
            wordWrap: 'on'
        });

        // Listen for changes
        this.editor.onDidChangeModelContent(() => {
            this.value = this.editor.getValue();
            this.onChange(this.value);
        });
    }

    createFallbackEditor() {
        // Create container for syntax highlighting
        const wrapper = document.createElement('div');
        wrapper.style.cssText = `
            width: 100%;
            height: 100%;
            position: relative;
            overflow: auto;
            background: #1e1e1e;
        `;

        // Highlighted code display (behind textarea)
        const highlightedCode = document.createElement('pre');
        highlightedCode.style.cssText = `
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            margin: 0;
            padding: 10px;
            font-family: 'Consolas', 'Courier New', monospace;
            font-size: 13px;
            line-height: 1.5;
            white-space: pre-wrap;
            word-wrap: break-word;
            pointer-events: none;
            color: transparent;
            overflow: hidden;
        `;

        const textarea = document.createElement('textarea');
        textarea.value = this.value;
        textarea.readOnly = this.readOnly;
        textarea.spellcheck = false;
        textarea.style.cssText = `
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: transparent;
            color: #d4d4d4;
            border: none;
            padding: 10px;
            font-family: 'Consolas', 'Courier New', monospace;
            font-size: 13px;
            line-height: 1.5;
            resize: none;
            outline: none;
            box-sizing: border-box;
            caret-color: #fff;
        `;

        // Update syntax highlighting
        const updateHighlight = () => {
            if (this.language === 'glsl') {
                highlightedCode.innerHTML = this.highlightGLSL(textarea.value);
            } else {
                highlightedCode.textContent = textarea.value;
            }
        };

        textarea.addEventListener('input', () => {
            this.value = textarea.value;
            updateHighlight();
            this.onChange(this.value);
        });

        textarea.addEventListener('scroll', () => {
            highlightedCode.scrollTop = textarea.scrollTop;
            highlightedCode.scrollLeft = textarea.scrollLeft;
        });

        wrapper.appendChild(highlightedCode);
        wrapper.appendChild(textarea);
        this.container.appendChild(wrapper);
        this.fallbackTextarea = textarea;
        this.highlightedCode = highlightedCode;

        // Initial highlight
        updateHighlight();
    }

    highlightGLSL(code) {
        // Simple GLSL syntax highlighting
        const keywords = /\b(attribute|const|uniform|varying|break|continue|do|for|while|if|else|in|out|inout|float|int|void|bool|true|false|discard|return|mat2|mat3|mat4|vec2|vec3|vec4|ivec2|ivec3|ivec4|bvec2|bvec3|bvec4|sampler2D|samplerCube|struct|precision|highp|mediump|lowp)\b/g;
        const functions = /\b(radians|degrees|sin|cos|tan|asin|acos|atan|pow|exp|log|exp2|log2|sqrt|inversesqrt|abs|sign|floor|ceil|fract|mod|min|max|clamp|mix|step|smoothstep|length|distance|dot|cross|normalize|faceforward|reflect|refract|matrixCompMult|lessThan|lessThanEqual|greaterThan|greaterThanEqual|equal|notEqual|any|all|not|texture2D|textureCube|texture2DProj|textureCubeProj|texture2DLod|textureCubeLod|texture2DProjLod|textureCubeProjLod|dFdx|dFdy|fwidth)\b/g;
        const numbers = /\b(\d+\.?\d*([eE][+-]?\d+)?[fF]?)\b/g;
        const comments = /(\/\/.*$|\/\*[\s\S]*?\*\/)/gm;
        const strings = /"(?:[^"\\]|\\.)*"/g;

        // Escape HTML
        let highlighted = code
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');

        // Apply syntax highlighting
        highlighted = highlighted
            .replace(comments, '<span style="color: #6A9955;">$1</span>')
            .replace(strings, '<span style="color: #CE9178;">$&</span>')
            .replace(keywords, '<span style="color: #569CD6;">$&</span>')
            .replace(functions, '<span style="color: #DCDCAA;">$&</span>')
            .replace(numbers, '<span style="color: #B5CEA8;">$&</span>');

        return highlighted;
    }

    upgradeToMonaco() {
        if (!this.monacoLoaded || !window.monaco || this.editor) return;

        // Save current value from fallback
        if (this.fallbackTextarea) {
            this.value = this.fallbackTextarea.value;
        }

        // Clear container and create Monaco editor
        this.container.innerHTML = '';
        this.fallbackTextarea = null;
        this.createMonacoEditor();
    }

    getValue() {
        if (this.editor && this.editor.getValue) {
            return this.editor.getValue();
        } else if (this.fallbackTextarea) {
            return this.fallbackTextarea.value;
        }
        return this.value;
    }

    setValue(value) {
        this.value = value;
        if (this.editor && this.editor.setValue) {
            this.editor.setValue(value);
        } else if (this.fallbackTextarea) {
            this.fallbackTextarea.value = value;
        }
    }

    setLanguage(language) {
        this.language = language;
        if (this.editor && window.monaco) {
            const model = this.editor.getModel();
            window.monaco.editor.setModelLanguage(model, language);
        }
    }

    setReadOnly(readOnly) {
        this.readOnly = readOnly;
        if (this.editor && this.editor.updateOptions) {
            this.editor.updateOptions({ readOnly });
        } else if (this.fallbackTextarea) {
            this.fallbackTextarea.readOnly = readOnly;
        }
    }

    focus() {
        if (this.editor && this.editor.focus) {
            this.editor.focus();
        } else if (this.fallbackTextarea) {
            this.fallbackTextarea.focus();
        }
    }

    layout() {
        if (this.editor && this.editor.layout) {
            this.editor.layout();
        }
    }

    dispose() {
        if (this.editor && this.editor.dispose) {
            this.editor.dispose();
            this.editor = null;
        }
        if (this.container) {
            this.container.innerHTML = '';
        }
        this.fallbackTextarea = null;
    }
}
