import { loadMonaco } from './monacoLoader.js';

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
        this.theme = options.theme || 'patchtoy-dark';
        this.onChange = options.onChange || (() => {});

        // Check if Monaco is available
        this.checkMonacoAvailability();
    }

    checkMonacoAvailability() {
        if (window.monaco) {
            this.monacoLoaded = true;
            return;
        }

        // Loaded on demand from the CDN (with SRI), the first time an editor opens.
        // The window may be closed (dispose) before it arrives: then nothing is created.
        loadMonaco().then(() => {
            this.monacoLoaded = true;
            this.onMonacoReady();
        }, (err) => {
            console.warn('Monaco editor failed to load, using textarea fallback:', err);
            this.monacoLoaded = false;
        });
    }

    /**
     * Create and mount the editor to a container element
     * @param {HTMLElement} container - The container to mount the editor in
     * @returns {CodeEditor} - Returns this for chaining
     */
    mount(container) {
        this.disposed = false;
        this.container = container;
        container.innerHTML = ''; // Clear container

        if (this.monacoLoaded && window.monaco) {
            this.createMonacoEditor();
        } else {
            this.createFallbackEditor();
            // Try to upgrade when Monaco loads
            clearTimeout(this._upgradeTimer);
            this._upgradeTimer = setTimeout(() => {
                this._upgradeTimer = null;
                if (window.monaco) this.onMonacoReady();
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

                typeKeywords: [
                    'float', 'int', 'uint', 'void', 'bool', 'mat2', 'mat3', 'mat4', 'vec2', 'vec3', 'vec4',
                    'ivec2', 'ivec3', 'ivec4', 'bvec2', 'bvec3', 'bvec4', 'sampler2D', 'samplerCube'
                ],

                tokenizer: {
                    root: [
                        [/@\w+/, 'annotation'],
                        [/[a-zA-Z_]\w*/, {
                            cases: {
                                '@typeKeywords': 'type',
                                '@keywords': 'keyword',
                                '@builtinFunctions': 'function',
                                '@default': 'identifier'
                            }
                        }],
                        [/[0-9]+\.?[0-9]*([eE][-+]?[0-9]+)?[fF]?/, 'number'],
                        [/"([^"\\]|\\.)*"/, 'string'],
                        [/(\/\/\s*)(@\w+)(.*$)/, ['comment', 'annotation', 'comment']],
                        [/\/\/.*$/, 'comment'],
                        [/\/\*/, 'comment', '@comment'],
                        [/[{}()\[\]]/, '@brackets'],
                        [/[;,.]/, 'delimiter'],
                        [/[<>!~?:&|+\-*\/\^%]+/, 'operator']
                    ],
                    comment: [
                        [/@\w+/, 'annotation'],
                        [/[^\/*@]+/, 'comment'],
                        [/\*\//, 'comment', '@pop'],
                        [/[\/*]/, 'comment']
                    ]
                }
            });
        }

        CodeEditor.defineTheme();

        this.editor = window.monaco.editor.create(this.container, {
            value: this.value,
            language: this.language,
            theme: this.theme,
            readOnly: this.readOnly,
            minimap: { enabled: false },
            fontSize: 13,
            lineHeight: 20,
            fontFamily: 'ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace',
            fontLigatures: false,
            lineNumbers: 'on',
            lineNumbersMinChars: 3,
            glyphMargin: false,
            folding: true,
            renderLineHighlight: 'line',
            roundedSelection: false,
            cursorBlinking: 'phase',
            cursorSmoothCaretAnimation: 'on',
            smoothScrolling: true,
            padding: { top: 12, bottom: 12 },
            scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false },
            overviewRulerBorder: false,
            hideCursorInOverviewRuler: true,
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
        const wrapper = document.createElement('div');
        wrapper.className = 'pt-code-fallback';

        // Highlighted code display (behind textarea)
        const highlightedCode = document.createElement('pre');
        highlightedCode.setAttribute('aria-hidden', 'true');

        const textarea = document.createElement('textarea');
        textarea.value = this.value;
        textarea.readOnly = this.readOnly;
        textarea.spellcheck = false;

        const updateHighlight = () => {
            if (this.language === 'glsl') {
                highlightedCode.innerHTML = this.highlightGLSL(textarea.value) + '\n';
            } else {
                highlightedCode.textContent = textarea.value + '\n';
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

        updateHighlight();
    }

    highlightGLSL(code) {
        // Single-pass tokenizer so spans never nest inside each other
        const escape = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const keywords = new Set(['attribute', 'const', 'uniform', 'varying', 'break', 'continue', 'do', 'for', 'while', 'if', 'else', 'in', 'out', 'inout', 'float', 'int', 'void', 'bool', 'true', 'false', 'discard', 'return', 'mat2', 'mat3', 'mat4', 'vec2', 'vec3', 'vec4', 'ivec2', 'ivec3', 'ivec4', 'bvec2', 'bvec3', 'bvec4', 'sampler2D', 'samplerCube', 'struct', 'precision', 'highp', 'mediump', 'lowp']);
        const functions = new Set(['radians', 'degrees', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'pow', 'exp', 'log', 'exp2', 'log2', 'sqrt', 'inversesqrt', 'abs', 'sign', 'floor', 'ceil', 'fract', 'mod', 'min', 'max', 'clamp', 'mix', 'step', 'smoothstep', 'length', 'distance', 'dot', 'cross', 'normalize', 'faceforward', 'reflect', 'refract', 'matrixCompMult', 'lessThan', 'lessThanEqual', 'greaterThan', 'greaterThanEqual', 'equal', 'notEqual', 'any', 'all', 'not', 'texture2D', 'textureCube', 'texture', 'dFdx', 'dFdy', 'fwidth']);
        const re = /(\/\/.*$|\/\*[\s\S]*?\*\/)|("(?:[^"\\]|\\.)*")|\b(\d+\.?\d*(?:[eE][+-]?\d+)?[fF]?)\b|\b([A-Za-z_]\w*)\b/gm;
        let out = '';
        let last = 0;
        let m;
        while ((m = re.exec(code)) !== null) {
            out += escape(code.slice(last, m.index));
            const tok = escape(m[0]);
            if (m[1]) out += `<span class="hl-comment">${tok}</span>`;
            else if (m[2]) out += `<span class="hl-string">${tok}</span>`;
            else if (m[3]) out += `<span class="hl-num">${tok}</span>`;
            else if (m[4] && keywords.has(m[4])) out += `<span class="hl-keyword">${tok}</span>`;
            else if (m[4] && functions.has(m[4])) out += `<span class="hl-fn">${tok}</span>`;
            else out += tok;
            last = re.lastIndex;
        }
        out += escape(code.slice(last));
        return out;
    }

    /** Monaco arrived (loader promise or the mount timer): upgrade the fallback if still open. */
    onMonacoReady() {
        if (this.disposed || !this.container || this.editor) return;
        this.monacoLoaded = true;
        this.upgradeToMonaco();
    }

    upgradeToMonaco() {
        if (this.disposed || !this.container || !this.monacoLoaded || !window.monaco || this.editor) return;

        // Save current value from fallback
        if (this.fallbackTextarea) {
            this.value = this.fallbackTextarea.value;
        }

        // Clear container and create Monaco editor
        this.container.innerHTML = '';
        this.fallbackTextarea = null;
        this.createMonacoEditor();
    }

    static defineTheme() {
        if (CodeEditor._themeDefined || !window.monaco) return;
        CodeEditor._themeDefined = true;
        window.monaco.editor.defineTheme('patchtoy-dark', {
            base: 'vs-dark',
            inherit: true,
            rules: [
                { token: '', foreground: 'c9cfdb' },
                { token: 'comment', foreground: '626a7c', fontStyle: 'italic' },
                { token: 'annotation', foreground: 'f5c84b' },
                { token: 'keyword', foreground: 'ff8a65' },
                { token: 'type', foreground: 'fcd34d' },
                { token: 'function', foreground: '8ecbff' },
                { token: 'number', foreground: 'fb923c' },
                { token: 'string', foreground: '6ee7b7' },
                { token: 'operator', foreground: 'a0a6b6' },
                { token: 'delimiter', foreground: '7d8496' },
                { token: 'identifier', foreground: 'dfe3ec' },
            ],
            colors: {
                'editor.background': '#0f1116',
                'editor.foreground': '#c9cfdb',
                'editorLineNumber.foreground': '#3a4050',
                'editorLineNumber.activeForeground': '#a0a6b6',
                'editor.lineHighlightBackground': '#161922',
                'editor.lineHighlightBorder': '#00000000',
                'editorCursor.foreground': '#ff5c2b',
                'editor.selectionBackground': '#ff5c2b40',
                'editor.inactiveSelectionBackground': '#ff5c2b22',
                'editor.selectionHighlightBackground': '#f5c84b1f',
                'editor.wordHighlightBackground': '#f5c84b18',
                'editorBracketMatch.background': '#f5c84b22',
                'editorBracketMatch.border': '#f5c84b66',
                'editorIndentGuide.background': '#1d2029',
                'editorIndentGuide.activeBackground': '#2a2e3a',
                'editorWhitespace.foreground': '#2a2e3a',
                'editorGutter.background': '#0f1116',
                'editorWidget.background': '#191b22',
                'editorWidget.border': '#3a4050',
                'editorSuggestWidget.background': '#191b22',
                'editorSuggestWidget.border': '#3a4050',
                'editorSuggestWidget.selectedBackground': '#252935',
                'editorHoverWidget.background': '#191b22',
                'editorHoverWidget.border': '#3a4050',
                'input.background': '#0f1116',
                'input.border': '#2a2e3a',
                'focusBorder': '#ff5c2b',
                'scrollbarSlider.background': '#2a2e3a99',
                'scrollbarSlider.hoverBackground': '#3a4050cc',
                'scrollbarSlider.activeBackground': '#4a5164',
                'editorOverviewRuler.border': '#00000000',
            }
        });
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
        // Closed before Monaco loaded: the pending loader callback / mount timer must not
        // create an editor (and model) in the detached container (review E-m7)
        this.disposed = true;
        clearTimeout(this._upgradeTimer);
        this._upgradeTimer = null;
        if (this.editor && this.editor.dispose) {
            const model = this.editor.getModel && this.editor.getModel();
            this.editor.dispose();
            try { if (model && !model.isDisposed()) model.dispose(); } catch (e) { /* ignore */ }
            this.editor = null;
        }
        if (this.container) {
            this.container.innerHTML = '';
        }
        this.container = null;
        this.fallbackTextarea = null;
    }
}
