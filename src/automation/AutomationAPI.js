/**
 * AutomationAPI - high-level, model-friendly commands that drive a running
 * PatchToy instance (window.toy). Used by the MCP bridge (BridgeClient.js),
 * but deliberately transport-agnostic: every public method takes a plain
 * params object and returns plain JSON-serializable data.
 *
 * Design rules:
 *  - The running app is the source of truth: we reuse NodeGraph / Node /
 *    CompilationManager / ShaderCompiler / createCustomNode code paths instead
 *    of re-implementing graph logic.
 *  - Never block on native dialogs: alert/confirm/prompt are intercepted for
 *    the duration of a command and reported back as messages.
 *  - Every mutating command emits a `patchtoy:activity` window event so the
 *    UI can show what the agent is doing.
 *
 * Modules are imported as namespaces so that a renamed/removed export in a
 * module owned by someone else degrades a single feature instead of breaking
 * the whole bridge at link time.
 */
import * as DefinitionsModule from '../core/NodeDefinitions.js';
import * as TypeRegistryModule from '../core/TypeRegistry.js';
import * as NodeGraphModule from '../core/NodeGraph.js';
import * as NodeFactoryModule from '../graph/NodeFactory.js';
import * as ShaderPreviewModule from '../rendering/ShaderPreview.js';
import * as FloatingCodeEditorModule from '../ui/FloatingCodeEditor.js';
import * as ShaderCompilerModule from '../core/ShaderCompiler.js';
import * as LiveUniformModule from '../nodes/liveUniform.js';
import * as CustomNodesModule from '../core/customNodes.js';

const NodeDefinitions = DefinitionsModule.NodeDefinitions;
const TypeSystem = DefinitionsModule.TypeSystem;
const TypeRegistry = TypeRegistryModule.TypeRegistry;
const FloatingCodeEditor = FloatingCodeEditorModule.FloatingCodeEditor;

const MAX_RENDER_SIZE = 2048;
const INTERNAL_DATA_KEYS = new Set(['pairNodeId', 'setupComplete']);
const INLINE_TYPES = new Set(['float', 'int', 'bool', 'vec2', 'vec3', 'vec4']);
const TYPE_SIZE = { float: 1, int: 1, vec2: 2, vec3: 3, vec4: 4 };
const INLINE_HINT = 'Inline values: a number, an array of 2-4 numbers, or a GLSL literal such as "vec3(1.0, 0.5, 0.0)" (true/false for bool inputs); null restores the default. Uniforms and expressions need a connected node.';
const ACTIVE_PROJECT_KEY = 'patchtoy_bridge_active_project';
const DEVICE_FLAGS = ['isCameraNode', 'isMicrophoneNode', 'isMidiCCNode', 'isScreenCaptureNode', 'isVideoURLNode'];

/** Error carrying structured details back to the caller. */
export class AutomationError extends Error {
    constructor(message, data = undefined) {
        super(message);
        this.name = 'AutomationError';
        if (data !== undefined) this.data = data;
    }
}

const norm = (s) => String(s).toLowerCase().replace(/[\s_\-]/g, '');

// Undo history (src/core/History.js): commands that don't edit the graph aren't batched;
// labels for the ones whose derived label ("Add 12 nodes") says less than the command
const HISTORY_UNBATCHED = new Set(['ping', 'getInfo', 'getGraph', 'listNodeTypes', 'exportProject', 'setProjectMeta', 'detachProject',
    'compile', 'renderPreview', 'captureEditor', 'fitView', 'undo', 'redo', 'getHistory']);
const HISTORY_LABELS = { buildGraph: 'Build graph', clearGraph: 'Clear graph', autoLayout: 'Auto layout' };

export class AutomationAPI {
    constructor(toy, { headless = false, agentName = 'Claude' } = {}) {
        this.toy = toy;
        this.headless = headless;
        this.agentName = agentName;

        /** Project currently loaded by the agent: { slug, name, description, customNodes:Set, timestamp } */
        this.activeProject = null;
        this.loadedEditorStates = [];

        this._inCommand = 0;
        this._loading = false;
        this._renderer = null;
        this._changeTimer = null;

        /** Callbacks wired by the transport */
        this.onProjectChanged = null; // ({slug, project}) => void
        this.onProjectDetached = null; // ({slug, reason}) => void

        this._restoreActiveProject();
        this._installChangeTracking();
    }

    get graph() { return this.toy.nodeGraph; }
    get gl() { return this.toy.sharedGL; }

    // The page may be reloaded (e.g. Vite HMR); the app restores its graph from
    // localStorage, so remember which agent project that graph belongs to.
    _persistActiveProject() {
        try {
            if (!this.activeProject) { sessionStorage.removeItem(ACTIVE_PROJECT_KEY); return; }
            const { slug, name, description, timestamp } = this.activeProject;
            sessionStorage.setItem(ACTIVE_PROJECT_KEY, JSON.stringify({
                slug, name, description, timestamp, customNodes: [...this.activeProject.customNodes],
                fingerprint: this._graphFingerprint(),
            }));
        } catch (e) { /* ignore */ }
    }

    _graphFingerprint() {
        const g = this.graph;
        if (!g) return '';
        const str = g.nodes.map(n => `${n.id}:${n.type}`).sort().join(',') + '|' +
            g.connections.filter(c => c.fromNode && c.toNode)
                .map(c => `${c.fromNode.id}.${c.fromOutput}>${c.toNode.id}.${c.toInput}${c.accessor || ''}`).sort().join(',');
        let h = 0;
        for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
        return `${g.nodes.length}-${h}`;
    }

    _restoreActiveProject() {
        try {
            const saved = JSON.parse(sessionStorage.getItem(ACTIVE_PROJECT_KEY) || 'null');
            if (!saved || !saved.slug) return;
            // Only trust it if the graph the app restored is the one we left
            // (localStorage is shared between tabs).
            if (saved.fingerprint !== this._graphFingerprint()) {
                sessionStorage.removeItem(ACTIVE_PROJECT_KEY);
                return;
            }
            const { fingerprint, ...rest } = saved;
            this.activeProject = { ...rest, customNodes: new Set(saved.customNodes || []) };
        } catch (e) { /* ignore */ }
    }

    // ------------------------------------------------------------------
    // Dispatch
    // ------------------------------------------------------------------

    static METHODS = [
        'ping', 'getInfo',
        'loadProject', 'exportProject', 'setProjectMeta', 'detachProject',
        'getGraph', 'listNodeTypes',
        'addNode', 'removeNode', 'setNodeData', 'moveNode',
        'connect', 'disconnect',
        'createCustomNode',
        'buildGraph', 'clearGraph',
        'compile', 'renderPreview', 'captureEditor',
        'autoLayout', 'fitView', 'setBackgroundPreview',
    ];

    async handle(method, params = {}) {
        if (!AutomationAPI.METHODS.includes(method) || typeof this[method] !== 'function') {
            throw new AutomationError(`Unknown method "${method}"`, { methods: AutomationAPI.METHODS });
        }

        // Intercept native dialogs so headless automation never blocks.
        const messages = [];
        const saved = { alert: window.alert, confirm: window.confirm, prompt: window.prompt };
        window.alert = (m) => { messages.push(String(m)); };
        window.confirm = (m) => { messages.push(`[confirm -> cancel] ${m}`); return false; };
        window.prompt = (m) => { messages.push(`[prompt -> cancel] ${m}`); return null; };

        this._inCommand++;
        // Each command is one undo step for the user ("Claude: Build graph"); see src/core/History.js
        const hist = HISTORY_UNBATCHED.has(method) ? null : this.toy.history;
        if (hist) hist.beginBatch({ prefix: this.agentName, label: HISTORY_LABELS[method] || null, load: method === 'loadProject' });
        try {
            const result = await this[method](params || {});
            if (messages.length && result && typeof result === 'object' && !Array.isArray(result)) {
                result.app_messages = messages;
            }
            return result;
        } catch (err) {
            if (messages.length) {
                const data = (err && err.data && typeof err.data === 'object') ? err.data : {};
                const wrapped = new AutomationError(err.message, { ...data, app_messages: messages });
                throw wrapped;
            }
            throw err;
        } finally {
            if (hist) { try { hist.endBatch(); } catch (e) { console.warn('[automation] history', e); } }
            this._inCommand--;
            window.alert = saved.alert;
            window.confirm = saved.confirm;
            window.prompt = saved.prompt;
        }
    }

    activity(message) {
        try {
            window.dispatchEvent(new CustomEvent('patchtoy:activity', {
                detail: { message: `${this.agentName} ${message}`, agent: this.agentName, time: Date.now() }
            }));
        } catch (e) { /* ignore */ }
    }

    // ------------------------------------------------------------------
    // Change tracking (live mode: push user edits back to disk)
    // ------------------------------------------------------------------

    _installChangeTracking() {
        const graph = this.graph;
        if (!graph) return;

        const wrap = (obj, key, after) => {
            const orig = obj[key];
            if (typeof orig !== 'function') return;
            obj[key] = function (...args) {
                const r = orig.apply(this, args);
                try { after(...args); } catch (e) { /* ignore */ }
                return r;
            };
        };

        wrap(graph, 'onGraphChanged', () => this._noteUserChange());
        wrap(graph, 'onUniformValueChanged', () => this._noteUserChange());

        // Node drags don't fire onGraphChanged; catch them on mouseup.
        if (graph.canvas) {
            graph.canvas.addEventListener('mouseup', () => this._noteUserChange());
        }
        // The user's undo / redo (moves don't recompile, so onGraphChanged may not fire)
        window.addEventListener('patchtoy:history', (e) => {
            const a = e.detail && e.detail.action;
            if (a === 'undo' || a === 'redo') this._noteUserChange();
        });

        // If the user loads another project through the app UI, stop syncing.
        const api = this;
        const origDeserialize = graph.deserialize;
        if (typeof origDeserialize === 'function') {
            graph.deserialize = function (...args) {
                if (!api._loading && api.activeProject) api._detach('another project was loaded in the app');
                return origDeserialize.apply(this, args);
            };
        }
        const origNew = this.toy.createNewProject;
        if (typeof origNew === 'function') {
            this.toy.createNewProject = function (...args) {
                if (!api._loading && api.activeProject) api._detach('a new project was created in the app');
                return origNew.apply(this, args);
            };
        }
    }

    _noteUserChange() {
        if (this._inCommand > 0 || this._loading || !this.activeProject || this.headless) return;
        if (!this.onProjectChanged) return;
        clearTimeout(this._changeTimer);
        this._changeTimer = setTimeout(() => {
            if (!this.activeProject) return;
            try {
                const project = this.exportProject();
                this.onProjectChanged({ slug: this.activeProject.slug, project });
            } catch (e) {
                console.warn('[automation] failed to export project after user change', e);
            }
        }, 800);
    }

    _detach(reason) {
        const slug = this.activeProject?.slug;
        this.activeProject = null;
        this._persistActiveProject();
        clearTimeout(this._changeTimer);
        if (slug && this.onProjectDetached) this.onProjectDetached({ slug, reason });
    }

    // ------------------------------------------------------------------
    // Info
    // ------------------------------------------------------------------

    ping() {
        return { ok: true, nodes: this.graph.nodes.length, project: this.activeProject?.slug || null };
    }

    getInfo() {
        let renderer = null;
        try {
            const gl = this.gl;
            const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
            renderer = gl ? (ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)) : null;
        } catch (e) { /* ignore */ }
        return {
            title: this.toy.projectManager?.projectTitle,
            project: this.activeProject ? { slug: this.activeProject.slug, name: this.activeProject.name, timestamp: this.activeProject.timestamp } : null,
            nodes: this.graph.nodes.length,
            headless: this.headless,
            url: location.href,
            webgl: renderer,
            webgl2: typeof WebGL2RenderingContext !== 'undefined' && this.gl instanceof WebGL2RenderingContext,
        };
    }

    // ------------------------------------------------------------------
    // Projects
    // ------------------------------------------------------------------

    _setTitle(name) {
        const pm = this.toy.projectManager;
        if (!pm || !name) return;
        try {
            pm.setProjectTitle(name);
        } catch (e) {
            // DOM element may have been renamed - set the fields directly
            pm.projectTitle = name;
            if (pm.projectState) pm.projectState.title = name;
        }
    }

    _stopOldPreviewRenderers() {
        // NodeGraph.deserialize doesn't dispose previous preview renderers; their
        // requestAnimationFrame loops would accumulate across many loads.
        for (const node of this.graph.nodes) {
            if (node.isPreviewNode && node.renderer) {
                try {
                    node.renderer.stopRendering?.();
                    if (node.renderer.program) {
                        node.renderer.gl.deleteProgram(node.renderer.program);
                        node.renderer.program = null;
                    }
                } catch (e) { /* ignore */ }
                this.graph.previewNodes?.delete?.(node.id);
            }
        }
    }

    _sanitizeGraph(graphData) {
        const warnings = [];
        const g = JSON.parse(JSON.stringify(graphData || {}));
        g.nodes = Array.isArray(g.nodes) ? g.nodes : [];
        g.connections = Array.isArray(g.connections) ? g.connections : [];

        const dropped = g.nodes.filter(n => !NodeDefinitions[n.type]);
        if (dropped.length) {
            warnings.push(`Dropped ${dropped.length} node(s) with unknown types: ${[...new Set(dropped.map(n => n.type))].join(', ')}`);
            const droppedIds = new Set(dropped.map(n => n.id));
            g.nodes = g.nodes.filter(n => !droppedIds.has(n.id));
            g.connections = g.connections.filter(c => !droppedIds.has(c.fromId) && !droppedIds.has(c.toId));
        }

        const maxId = g.nodes.reduce((m, n) => Math.max(m, Number(n.id) || 0), -1);
        if (!(g.nextNodeId > maxId)) g.nextNodeId = maxId + 1;
        return { graph: g, warnings };
    }

    async loadProject({ project, slug, name, description }) {
        if (!project || typeof project !== 'object') throw new AutomationError('loadProject: missing project data');
        const toy = this.toy;
        const pm = toy.projectManager;

        // Back up the user's current (non-agent) work before replacing it.
        let backup = null;
        if (!this.activeProject && this.graph.nodes.length > 0 && !this.headless) {
            try { backup = this.exportProject({ allCustomNodes: true }); } catch (e) { /* ignore */ }
        }

        FloatingCodeEditor?.closeAll?.();

        // Non-interactive custom node path: register the project's versions up
        // front so ProjectManager never shows its conflict dialog.
        // They are scoped to this project (never written to the user's custom node library).
        const customNodes = project.customNodes && typeof project.customNodes === 'object' ? project.customNodes : {};
        const customErrors = [];
        toy.releaseProjectCustomNodes?.();
        for (const nodeName of Object.keys(customNodes)) {
            const nodeData = customNodes[nodeName];
            if (!nodeData || !nodeData.customGLSL) continue;
            const why = CustomNodesModule.customNodeNameError?.(nodeName);
            if (why) {
                customErrors.push(`Custom node "${String(nodeName).slice(0, 60)}" was skipped: ${why}`);
                continue;
            }
            const res = toy.createCustomNode(nodeName, nodeData.customGLSL, true, { scope: 'project', silent: true });
            if (!res || !res.success) customErrors.push(`Custom node "${nodeName}" failed to register`);
        }

        const { graph, warnings } = this._sanitizeGraph(project.graph);
        // Custom nodes are already registered above; passing none to the app's
        // loader guarantees its interactive conflict dialog can never appear.
        const fileData = { ...project, graph, customNodes: {} };

        this._stopOldPreviewRenderers();
        this._loading = true;
        let result;
        try {
            const file = new File([JSON.stringify(fileData)], `${slug || 'project'}.patchtoy.json`, { type: 'application/json' });
            result = await pm.loadProjectFromFile(
                file,
                (n, glsl) => toy.createCustomNode(n, glsl, true, { scope: 'project' }),
                () => toy.saveCustomNodes(),
                { releaseCustomNodes: false }
            );
        } finally {
            this._loading = false;
        }
        if (!result || !result.success) {
            throw new AutomationError('The app failed to load the project (see app_messages)');
        }

        this.activeProject = {
            slug: slug || null,
            name: name || slug || 'Untitled',
            description: description || '',
            customNodes: new Set(Object.keys(customNodes)),
            timestamp: project.timestamp || null,
        };
        this.loadedEditorStates = Array.isArray(project.editorStates) ? project.editorStates : [];
        this._setTitle(this.activeProject.name);
        this._persistActiveProject();

        // Live mode: reopen saved code editors just like a file load does.
        // (markClean below: the graph matches the file on disk)
        if (!this.headless && this.loadedEditorStates.length && typeof toy.restoreEditorStates === 'function') {
            try { toy.restoreEditorStates(this.loadedEditorStates); } catch (e) { /* ignore */ }
        }

        this._compileApp();
        this.graph.render();
        try { pm.markClean?.(); } catch (e) { /* ignore */ }
        this.activity(`opened project "${this.activeProject.name}"`);

        const out = {
            loaded: true,
            slug: this.activeProject.slug,
            nodes: this.graph.nodes.length,
            connections: this.graph.connections.length,
        };
        const allWarnings = [...warnings, ...customErrors];
        if (allWarnings.length) out.warnings = allWarnings;
        if (backup && backup.graph?.nodes?.length) out.backup = backup;
        return out;
    }

    exportProject({ allCustomNodes = false } = {}) {
        const graph = this.graph.serialize();

        const wanted = new Set(this.activeProject?.customNodes || []);
        for (const n of this.graph.nodes) {
            if (NodeDefinitions[n.type]?.isCustomNode) wanted.add(n.type);
        }
        const customNodes = {};
        for (const [name, def] of Object.entries(NodeDefinitions)) {
            if (!def.isCustomNode) continue;
            if (!allCustomNodes && !wanted.has(name)) continue;
            customNodes[name] = {
                category: def.category,
                inputs: def.inputs,
                outputs: def.outputs,
                customGLSL: def.customGLSL,
            };
        }

        let editorStates = this.loadedEditorStates || [];
        if (!this.headless) {
            try { editorStates = FloatingCodeEditor.getAllStates(); } catch (e) { /* keep loaded */ }
        }

        const data = {
            version: '1.0',
            graph,
            customNodes,
            editorStates,
            timestamp: new Date().toISOString(),
        };
        if (this.activeProject) {
            this.activeProject.timestamp = data.timestamp;
            this._persistActiveProject();
            // Keep the app's own autosave in step (node moves don't trigger it), and
            // clear the "unsaved" indicator: the project file on disk is up to date.
            try { this.toy.projectManager?.saveGraph?.(); } catch (e) { /* ignore */ }
            try { this.toy.projectManager?.markClean?.(); } catch (e) { /* ignore */ }
        }
        return data;
    }

    setProjectMeta({ slug, name, description }) {
        if (!this.activeProject) return { ok: false };
        if (slug) this.activeProject.slug = slug;
        if (name) { this.activeProject.name = name; this._setTitle(name); }
        if (description !== undefined) this.activeProject.description = description;
        this._persistActiveProject();
        return { ok: true };
    }

    detachProject() {
        this.activeProject = null;
        this._persistActiveProject();
        return { ok: true };
    }

    // ------------------------------------------------------------------
    // Descriptions
    // ------------------------------------------------------------------

    _outputLabel(node, index) {
        const o = node.outputs[index];
        if (!o) return String(index);
        return o.name === '' ? 'out' : o.name;
    }

    _inputLabel(node, index) {
        const i = node.inputs[index];
        return i ? i.name : String(index);
    }

    _outputType(node, index) {
        const o = node.outputs[index];
        if (!o) return null;
        if (TypeRegistry?.isAny?.(o.type) && node.resolvedOutputType) return node.resolvedOutputType;
        return o.type;
    }

    _connString(c) {
        return `${c.fromNode.id}.${this._outputLabel(c.fromNode, c.fromOutput)}${c.accessor || ''} -> ${c.toNode.id}.${this._inputLabel(c.toNode, c.toInput)}`;
    }

    _publicData(node) {
        const out = {};
        for (const [k, v] of Object.entries(node.data || {})) {
            if (INTERNAL_DATA_KEYS.has(k)) continue;
            out[k] = v;
        }
        return out;
    }

    describeNode(node) {
        const d = { id: node.id, type: node.type };
        const title = node.definition?.displayTitle;
        if (title && title !== node.type) d.title = title;
        d.x = Math.round(node.x);
        d.y = Math.round(node.y);
        d.w = Math.round(node.width);
        d.h = Math.round(node.height);
        const data = this._publicData(node);
        if (Object.keys(data).length) d.data = data;
        d.inputs = node.inputs.map((inp, i) => {
            const c = this.graph.connections.find(conn => conn.toNode === node && conn.toInput === i);
            let s = `${inp.name}:${inp.type}`;
            if (c) s += ` <- ${c.fromNode.id}.${this._outputLabel(c.fromNode, c.fromOutput)}${c.accessor || ''}`;
            return s;
        });
        d.outputs = node.outputs.map((o, i) => `${this._outputLabel(node, i)}:${this._outputType(node, i)}`);
        if (node.data && node.data.pairNodeId !== undefined && node.data.pairNodeId !== null) d.pair_id = node.data.pairNodeId;
        if (node.isPreviewNode && node.isBackground) d.background = true;
        if (node.hasError) d.error = true;
        return d;
    }

    getGraph() {
        const g = this.graph;
        return {
            project: this.activeProject ? { slug: this.activeProject.slug, name: this.activeProject.name } : null,
            node_count: g.nodes.length,
            nodes: [...g.nodes].sort((a, b) => a.id - b.id).map(n => this.describeNode(n)),
            connections: g.connections.filter(c => c.fromNode && c.toNode).map(c => this._connString(c)),
            previews: g.nodes.filter(n => n.isPreviewNode).map(n => n.id).sort((a, b) => a - b),
            custom_nodes: Object.keys(NodeDefinitions).filter(k => NodeDefinitions[k].isCustomNode),
            view: { panX: Math.round(g.panX), panY: Math.round(g.panY), zoom: +Number(g.zoom).toFixed(3) },
        };
    }

    _typeNotes(name, def) {
        const notes = [];
        if (def.isPreviewNode) notes.push("Output node: renders its 'color' input (vec4; float/vec2/vec3 auto-convert). Check with compile/render_preview.");
        if (def.isConstantNode) notes.push('Constant value node: edit values with set_node_data.' + ((def.inputs || []).length ? ' Inputs are optional; unconnected components use data values.' : ''));
        if (def.hasUniformToggle) notes.push('data.useUniform: true = uniform (value can change without recompiling), false = inlined literal.');
        if (def.hasColorPicker) notes.push('data r,g,b in 0..1 (set_node_data also accepts {"hex":"#rrggbb"}).');
        if (def.isDynamicInput && !def.isForLoopStartNode) notes.push("Dynamic inputs: numbered inputs '0','1',... grow automatically as you connect (connect to the next number, e.g. to_input '2'). Output type is resolved from the connected inputs.");
        else if ((def.inputs || []).some(i => i.type === 'any' && i.generic)) notes.push("Generic: 'any' inputs accept float/vec2/vec3/vec4; the output takes the widest connected type and scalars broadcast (vec3 * float works).");
        else if (def.validateTypes && (def.inputs || []).some(i => i.type === 'any')) notes.push("Polymorphic: 'any' inputs accept float/vec2/vec3/vec4; connected inputs must share one type, which becomes the output type.");
        if (def.inlineInputs) {
            const fixed = (def.inputs || []).filter(i => this._inlineUnsupported(i)).map(i => i.name);
            notes.push('Unconnected inputs read node.data[inputName] (number, [x,y(,z,w)] array, or a GLSL literal string such as "vec3(1.0, 0.5, 0.0)"; true/false for bool) - set them with set_node_data or build_graph data, null restores the default.' +
                (fixed.length ? ` Not settable inline (connect a node): ${fixed.join(', ')}.` : ''));
        } else if ((def.inputs || []).length && !def.isConstantNode && !def.isPreviewNode) {
            notes.push('Inputs take no inline values: connect a node (e.g. Float, Vec3, Color) to change them.');
        }
        if ((def.inputs || []).some(i => i.functionOf)) notes.push("Function input(s): " + def.inputs.filter(i => i.functionOf).map(i => i.name).join(', ') + " compile the whole upstream sub-graph into a GLSL function (e.g. any float distance graph built from ScenePoint/3D primitives).");
        if (def.isForLoopStartNode) notes.push('Adding it auto-creates a paired ForLoopEnd (returned as pair_id). Wire start values into start0.. (connecting to the last free startN adds another loop variable, typed by what you connect), use inter0.. outputs in the loop body, feed results into ForLoopEnd inter0.., read final values from ForLoopEnd end0.. .');
        if (def.isForLoopEndNode) notes.push('Created automatically together with ForLoopStart - do not add it directly.');
        if (def.isCommentNode) notes.push(`Documentation note on the canvas (never compiled). data: text (supports '# heading', '## subheading', '- bullet'), width, height, color (${['yellow', 'orange', 'pink', 'violet', 'blue', 'green', 'gray'].join('|')}). Use notes to explain each section of a patch.`);
        if (def.isFeedbackNode) notes.push("Outputs the previous frame of its input as a sampler2D (allows cycles); read it with TextureSample. data: width/height (texels), format 'rgba8' (default, clamped 0..1) | 'rgba16f' | 'rgba32f' (unclamped float state: positions, HDR; needs EXT_color_buffer_float, falls back to rgba8), filter 'linear' | 'nearest' (use nearest + texelFetch for per-texel state).");
        if (def.isJSNode) notes.push('Runs JavaScript (data.code) every frame to produce uniform values.');
        if (DEVICE_FLAGS.some(f => def[f])) notes.push('Needs a device / user permission; renders black or 0 in headless mode.');
        if (def.isCustomNode) notes.push('Custom GLSL node (edit with update_custom_node).');
        for (const inp of def.inputs || []) {
            if (inp.defaultNode) notes.push(`Input '${inp.name}' is usually fed by a ${inp.defaultNode} node.`);
        }
        if (def.amountInput && def.amountNote) notes.push(def.amountNote); // shared effect-amount convention (library/amount.js)
        return notes;
    }

    _portsForType(name, def) {
        let inputs = def.inputs || [];
        let outputs = def.outputs || [];
        if ((def.isForLoopStartNode || def.isForLoopEndNode) && NodeFactoryModule.NodeFactory) {
            try {
                const tmp = NodeFactoryModule.NodeFactory.createNode(name, -1, 0, 0, null, null, null);
                if (tmp) { inputs = tmp.inputs; outputs = tmp.outputs; }
            } catch (e) { /* ignore */ }
        }
        return { inputs, outputs };
    }

    describeNodeType(name) {
        const def = NodeDefinitions[name];
        if (!def) return null;
        const { inputs, outputs } = this._portsForType(name, def);
        const d = { name, category: def.category || 'other' };
        if (def.displayTitle && def.displayTitle !== name) d.title = def.displayTitle;
        if (def.description) d.description = String(def.description).trim();
        d.inputs = inputs.map(i => {
            let s = `${i.name}:${i.type}`;
            if (i.default !== undefined && i.default !== null && i.default !== '') s += `=${i.default}`;
            return s;
        });
        d.outputs = outputs.map(o => `${o.name === '' ? 'out' : o.name}:${o.type}`);
        if (def.data && Object.keys(def.data).length) {
            const data = {};
            for (const [k, v] of Object.entries(def.data)) if (!INTERNAL_DATA_KEYS.has(k)) data[k] = v;
            if (Object.keys(data).length) d.data = data;
        }
        const notes = this._typeNotes(name, def);
        if (notes.length) d.notes = notes;
        if (def.isCustomNode) d.custom = true;
        return d;
    }

    listNodeTypes({ category, search, include_glsl = false } = {}) {
        const all = Object.keys(NodeDefinitions);
        const categories = {};
        for (const name of all) {
            const c = NodeDefinitions[name].category || 'other';
            categories[c] = (categories[c] || 0) + 1;
        }
        let names = all;
        if (category) names = names.filter(n => norm(NodeDefinitions[n].category || 'other') === norm(category));
        if (search) {
            const q = String(search).toLowerCase();
            names = names.filter(n => {
                const def = NodeDefinitions[n];
                return n.toLowerCase().includes(q) ||
                    String(def.displayTitle || '').toLowerCase().includes(q) ||
                    String(def.description || '').toLowerCase().includes(q) ||
                    String(def.category || '').toLowerCase().includes(q);
            });
        }
        const types = names.map(n => {
            const d = this.describeNodeType(n);
            if (include_glsl && NodeDefinitions[n].isCustomNode) d.glsl = NodeDefinitions[n].customGLSL;
            return d;
        });
        return { count: types.length, categories, types };
    }

    // ------------------------------------------------------------------
    // Lookups
    // ------------------------------------------------------------------

    _getNode(id, label = 'node') {
        const nid = typeof id === 'string' && /^\d+$/.test(id) ? parseInt(id, 10) : id;
        const node = this.graph.nodes.find(n => n.id === nid);
        if (!node) {
            throw new AutomationError(`No ${label} with id ${JSON.stringify(id)}`, {
                nodes: this.graph.nodes.map(n => `${n.id}:${n.type}`)
            });
        }
        return node;
    }

    _resolveType(type) {
        if (NodeDefinitions[type]) return type;
        const key = norm(type);
        const matches = Object.keys(NodeDefinitions).filter(n => norm(n) === key || norm(NodeDefinitions[n].displayTitle || '') === key);
        if (matches.length === 1) return matches[0];
        const suggestions = Object.keys(NodeDefinitions)
            .filter(n => norm(n).includes(key) || key.includes(norm(n)))
            .slice(0, 8);
        throw new AutomationError(`Unknown node type "${type}"`, {
            suggestions: suggestions.length ? suggestions : undefined,
            hint: 'Use list_node_types to see available types.'
        });
    }

    _portList(node, kind) {
        return kind === 'input'
            ? node.inputs.map((p, i) => `${i}:${p.name}:${p.type}`)
            : node.outputs.map((p, i) => `${i}:${this._outputLabel(node, i)}:${this._outputType(node, i)}`);
    }

    _resolvePort(node, ref, kind) {
        const ports = kind === 'input' ? node.inputs : node.outputs;
        const label = `${node.type} #${node.id}`;

        if (ref === undefined || ref === null || ref === '') {
            if (kind === 'output' && ports.length >= 1) return 0;
            if (kind === 'input' && ports.length === 1) return 0;
            throw new AutomationError(
                ports.length === 0 ? `${label} has no ${kind}s` : `${label} has ${ports.length} ${kind}s - specify which one`,
                { [`${kind}s`]: this._portList(node, kind) }
            );
        }

        if (typeof ref === 'number') {
            if (Number.isInteger(ref) && ref >= 0 && ref < ports.length) return ref;
            throw new AutomationError(`${label} has no ${kind} index ${ref}`, { [`${kind}s`]: this._portList(node, kind) });
        }

        const s = String(ref);
        // Blend: numbered inputs appear as you connect. (ForLoopStart is dynamic too,
        // but grows through its own startN ports, so it must not enter this loop.)
        if (kind === 'input' && node.type === 'Blend' && node.isDynamicInput && /^\d+$/.test(s) && !ports.some(p => p.name === s)) {
            let guard = 0;
            while (!node.inputs.some(p => p.name === s) && guard++ < 64) {
                if (!node.addDynamicInput()) break;
            }
        }
        const list = kind === 'input' ? node.inputs : node.outputs;

        let idx = list.findIndex(p => p.name === s);
        if (idx < 0) idx = list.findIndex(p => norm(p.name) === norm(s));
        if (idx < 0) idx = list.findIndex(p => p.paramName && norm(p.paramName) === norm(s));
        if (idx < 0 && kind === 'output' && ['out', 'output', 'result'].includes(norm(s))) {
            idx = list.findIndex(p => p.name === '');
            if (idx < 0 && list.length === 1) idx = 0;
        }
        if (idx < 0 && /^\d+$/.test(s)) {
            const n = parseInt(s, 10);
            if (n < list.length) idx = n;
        }
        if (idx < 0) {
            throw new AutomationError(`${label} has no ${kind} "${s}"`, { [`${kind}s`]: this._portList(node, kind) });
        }
        return idx;
    }

    _wouldCreateCycle(fromNode, toNode) {
        if (fromNode === toNode) return true;
        if (toNode.isFeedbackNode) return false; // feedback breaks cycles by design
        // Is toNode upstream of fromNode?
        const seen = new Set();
        const stack = [fromNode];
        while (stack.length) {
            const cur = stack.pop();
            if (cur === toNode) return true;
            if (seen.has(cur)) continue;
            seen.add(cur);
            for (const c of this.graph.connections) {
                if (c.toNode === cur && !c.toNode.isFeedbackNode) stack.push(c.fromNode);
            }
        }
        return false;
    }

    _ConnectionClass() {
        if (NodeGraphModule.Connection) return NodeGraphModule.Connection;
        const existing = this.graph.connections[0];
        if (existing) return existing.constructor;
        throw new AutomationError('Connection class not available from NodeGraph.js');
    }

    // ------------------------------------------------------------------
    // Node mutation
    // ------------------------------------------------------------------

    _autoPosition() {
        const g = this.graph;
        if (!g.nodes.length) {
            const zoom = g.zoom || 1;
            return { x: Math.round(-g.panX / zoom + 120), y: Math.round(-g.panY / zoom + 140) };
        }
        let right = null;
        for (const n of g.nodes) {
            if (!right || n.x + n.width > right.x + right.width) right = n;
        }
        return { x: Math.round(right.x + right.width + 80), y: Math.round(right.y) };
    }

    /** A data value equal to the input's default expression (what Node.applyDefinition stores). */
    _isInputDefault(input, value) {
        return typeof value === 'string' && input.default !== undefined && input.default !== null &&
            value.trim() === String(input.default).trim();
    }

    /** Why an input can't take an inline value (null when it can). */
    _inlineUnsupported(input) {
        if (input.functionOf) return 'it is a function input (it compiles the connected sub-graph)';
        if (TypeRegistry.isAny(input.type) || INLINE_TYPES.has(input.type)) return null;
        return `it is a ${input.type} input`;
    }

    /**
     * Validate / normalize an inline value for an unconnected input, in the forms
     * ShaderCompiler.defaultForInput consumes: number, [x, y(, z, w)], a GLSL
     * literal string ("vec3(1.0, 0.5, 0.0)") or a boolean for bool inputs.
     * Returns null for null (= restore the default).
     */
    _inlineInputValue(node, input, raw) {
        const t = input.type;
        const shown = TypeRegistry.isAny(t) ? (input.cast ? `float or vector, cast to ${input.cast}` : 'float or vec2/3/4') : t;
        const fail = (msg) => {
            throw new AutomationError(`${node.type} #${node.id} input '${input.name}' (${shown}): ${msg}`, { hint: INLINE_HINT });
        };
        if (raw === null) return null;
        // The input's own default expression ("pt_uv()", "u_time", "@p"...): Node.applyDefinition
        // copies these into data, so get_project data must round-trip. It means "default".
        if (this._isInputDefault(input, raw)) return raw;
        const why = this._inlineUnsupported(input);
        if (why) fail(`takes no inline value because ${why}; connect a node instead`);
        const size = TYPE_SIZE[t]; // undefined for generic ('any') and bool

        let v = raw;
        if (typeof v === 'string') {
            const s = v.trim();
            if (/^-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(s)) v = Number(s);
            else if (s === 'true' || s === 'false') v = s === 'true';
            else v = s;
        }
        if (t === 'bool') {
            if (typeof v === 'boolean') return v;
            if (typeof v === 'number' && Number.isFinite(v)) return v !== 0;
            fail(`expects true or false (got ${JSON.stringify(raw)})`);
        }
        if (typeof v === 'boolean') fail(`expects a number${size === 1 ? '' : ' or a vector'} (got ${v})`);
        if (typeof v === 'number') {
            if (!Number.isFinite(v)) fail('must be a finite number');
            return t === 'int' ? Math.round(v) : v;
        }
        if (Array.isArray(v)) {
            if (!v.length || !v.every(x => typeof x === 'number' && Number.isFinite(x))) {
                fail(`arrays must hold finite numbers only (got ${JSON.stringify(raw)})`);
            }
            if (v.length === 1) return t === 'int' ? Math.round(v[0]) : v[0];
            if (size === 1) fail(`is a scalar: give one number (got ${v.length} values)`);
            if (size && v.length !== size) fail(`is a ${t}: give ${size} numbers, or one number to broadcast (got ${v.length})`);
            if (v.length > 4) fail(`give 2 to 4 numbers (got ${v.length})`);
            return [...v];
        }
        if (typeof v === 'string') {
            const s = v.replace(/^(vec[234]|float|int)\s+\(/, '$1(');
            const m = /^(vec[234]|float|int)\((.*)\)$/.exec(s);
            const args = m ? m[2].split(',') : [];
            const NUM = /^\s*-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?\s*$/;
            if (!m || !args.every(a => NUM.test(a))) {
                fail(`"${raw}" is not a GLSL literal with numeric arguments`);
            }
            const ctor = m[1];
            const ctorSize = TYPE_SIZE[ctor];
            if (args.length !== 1 && args.length !== ctorSize) fail(`"${raw}": ${ctor} takes 1 or ${ctorSize} values`);
            if ((ctor === 'int') !== (t === 'int')) fail(`"${raw}" is ${ctor === 'int' ? 'an int' : 'a float'} literal; the input is ${shown}`);
            if (size && ctorSize !== size) fail(`"${raw}" is a ${ctor}; the input is a ${t}`);
            return s;
        }
        fail(`unsupported value ${JSON.stringify(raw)}`);
        return undefined;
    }

    _applyData(node, data) {
        const result = { changed: [], disconnected: [], ignoredWhileConnected: [] };
        if (!data || typeof data !== 'object') return result;

        const def = node.definition || {};
        const before = { ...node.data };
        const inputIndex = new Map(node.inputs.map((inp, i) => [inp.name, i]));
        // Library nodes (inlineInputs) read node.data[inputName] for every unconnected input
        const inlineInputs = def.inlineInputs ? node.inputs.filter(i => !this._inlineUnsupported(i)).map(i => i.name) : [];
        const defData = def.data || {};
        const known = new Set([...Object.keys(node.data || {}), ...Object.keys(defData)].filter(k =>
            !INTERNAL_DATA_KEYS.has(k) &&
            // Node.applyDefinition copies input defaults into data; for nodes that don't
            // read inline values those entries do nothing, so they aren't settable fields.
            (def.inlineInputs || !inputIndex.has(k) || k in defData)
        ));

        const unknown = [];
        try {
            for (let [k, v] of Object.entries(data)) {
                if (k === 'hex' && node.hasColorPicker) {
                    const m = /^#?([0-9a-f]{6})$/i.exec(String(v).trim());
                    if (!m) throw new AutomationError(`Invalid hex color "${v}" (use "#rrggbb")`);
                    const hex = m[1];
                    node.data.r = parseInt(hex.slice(0, 2), 16) / 255;
                    node.data.g = parseInt(hex.slice(2, 4), 16) / 255;
                    node.data.b = parseInt(hex.slice(4, 6), 16) / 255;
                    result.changed.push('r', 'g', 'b');
                    continue;
                }
                if (def.inlineInputs && inputIndex.has(k)) {
                    const value = this._inlineInputValue(node, node.inputs[inputIndex.get(k)], v);
                    if (value === null) {
                        if (typeof defData[k] === 'number') node.data[k] = defData[k]; // inline field default
                        else delete node.data[k];
                    } else {
                        node.data[k] = value;
                    }
                    result.changed.push(k);
                    if (this.graph.connections.some(c => c.toNode === node && c.toInput === inputIndex.get(k))) {
                        result.ignoredWhileConnected.push(k);
                    }
                    continue;
                }
                if (!known.has(k)) {
                    // Round trip of get_project data: an input default copied into data is a no-op
                    if (inputIndex.has(k) && this._isInputDefault(node.inputs[inputIndex.get(k)], v)) {
                        node.data[k] = v;
                        continue;
                    }
                    unknown.push(k);
                    continue;
                }
                const prev = before[k];
                if (typeof prev === 'number' && typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v))) v = Number(v);
                if (typeof prev === 'boolean' && typeof v === 'string') v = v === 'true' || v === '1';
                if (typeof prev === 'boolean' && typeof v === 'number') v = v !== 0;
                if (typeof prev === 'number' && typeof v !== 'number') {
                    throw new AutomationError(`data.${k} must be a number (got ${JSON.stringify(v)})`);
                }
                if (node.fieldType === 'int' && typeof v === 'number' && k !== 'useUniform') v = Math.round(v);
                node.data[k] = v;
                result.changed.push(k);
            }
        } catch (e) {
            node.data = before; // atomic: no partial changes
            throw e;
        }
        if (unknown.length) {
            // Roll back partial changes so the call is atomic
            node.data = before;
            const fields = [...new Set([...known, ...inlineInputs])];
            const plainInputs = unknown.filter(k => inputIndex.has(k));
            let hint;
            if (plainInputs.length && !def.inlineInputs) {
                hint = `${node.type} reads only connected inputs, so ${plainInputs.join(', ')} can't be set inline: connect a node (Float, Vec2/3/4, Color...) instead.`;
            } else if (plainInputs.length) {
                hint = `${plainInputs.join(', ')}: ${plainInputs.map(k => this._inlineUnsupported(node.inputs[inputIndex.get(k)])).join('; ')}. Connect a node instead.`;
            } else if (!fields.length) {
                hint = `${node.type} has no editable data`;
            }
            throw new AutomationError(
                `${node.type} #${node.id} has no data field(s): ${unknown.join(', ')}`,
                { data_fields: fields, hint }
            );
        }

        // Uniform toggle semantics (same as clicking the [U] button)
        if (node.hasUniformToggle && before.useUniform !== node.data.useUniform) {
            if (node.data.useUniform) {
                const removed = this.graph.connections.filter(c => c.toNode === node);
                if (removed.length) {
                    this.graph.connections = this.graph.connections.filter(c => c.toNode !== node);
                    result.disconnected = removed.map(c => this._connString(c));
                }
                node.updateUniformRegistry?.();
            } else {
                node.unregisterUniforms?.();
            }
            result.uniformToggled = true;
        }

        // ForLoop iteration variable types
        if ((node.isForLoopStartNode || node.isForLoopEndNode) && result.changed.includes('varTypes')) {
            node.updatePorts?.();
            node.syncWithPair?.();
            this.graph.connections = this.graph.connections.filter(c =>
                c.fromOutput < c.fromNode.outputs.length && c.toInput < c.toNode.inputs.length);
        }

        try { node.rebuildTextInputs?.(); } catch (e) { /* ignore */ }
        try { node.updateDimensions?.(); } catch (e) { /* ignore */ }
        return result;
    }

    addNode({ type, x, y, data }) {
        const resolved = this._resolveType(type);
        const pos = (typeof x === 'number' && typeof y === 'number') ? { x, y } : this._autoPosition();
        const node = this.graph.addNode(resolved, pos.x, pos.y);
        if (!node) throw new AutomationError(`The app failed to create a ${resolved} node`);
        let applied = null;
        try {
            if (data) applied = this._applyData(node, data);
        } catch (e) {
            // Keep the graph clean if the data was invalid
            this._deleteNodes([node]);
            throw e;
        }
        this._graphChanged();
        this._ensureVisible(node);
        const title = node.definition?.displayTitle || resolved;
        this.activity(`added ${title} node`);
        const out = { node: this.describeNode(node) };
        if (node.data?.pairNodeId !== undefined && node.data?.pairNodeId !== null) {
            const pair = this.graph.nodes.find(n => n.id === node.data.pairNodeId);
            if (pair) out.pair = this.describeNode(pair);
        }
        if (applied?.disconnected?.length) out.disconnected = applied.disconnected;
        return out;
    }

    _deleteNodes(nodes) {
        const g = this.graph;
        const sel = g.selectionManager?.selectedNodes;
        for (const node of nodes) {
            if (node.isPreviewNode && node.isBackground && g.onPreviewBackground) g.onPreviewBackground(null);
        }
        const before = new Set(g.nodes);
        if (sel && typeof g.deleteSelectedNodes === 'function') {
            const prev = new Set(sel);
            sel.clear();
            nodes.forEach(n => sel.add(n));
            g.deleteSelectedNodes();
            for (const n of prev) if (g.nodes.includes(n)) sel.add(n);
        } else {
            g.connections = g.connections.filter(c => !nodes.includes(c.fromNode) && !nodes.includes(c.toNode));
            g.nodes = g.nodes.filter(n => !nodes.includes(n));
            g.onGraphChanged?.();
            g.render();
        }
        return [...before].filter(n => !g.nodes.includes(n));
    }

    removeNode({ id }) {
        const node = this._getNode(id);
        const removedConnections = this.graph.connections.filter(c => c.toNode === node || c.fromNode === node).map(c => this._connString(c));
        const removed = this._deleteNodes([node]);
        this.activity(`removed ${node.definition?.displayTitle || node.type} node`);
        return {
            removed: removed.map(n => `${n.id}:${n.type}`),
            removed_connections: removedConnections,
        };
    }

    setNodeData({ id, data }) {
        const node = this._getNode(id);
        if (!data || typeof data !== 'object' || !Object.keys(data).length) {
            throw new AutomationError('set_node_data requires a non-empty data object', { data: this._publicData(node) });
        }
        const liveBefore = this._liveSourceSignature(node);
        const res = this._applyData(node, data);
        // Same paths as the UI. Uniform-mode constants without connected inputs (editing a
        // field) and live sources such as XYPad / Keyboard / MidiNote (dragging the pad) only
        // push a new uniform value; everything else - including library nodes' inline
        // fields, which are compiled in as literals - recompiles.
        let valueOnly = null;
        if (node.data.useUniform && node.hasUniformToggle && !res.uniformToggled &&
            typeof node.updateUniformRegistry === 'function' &&
            !this.graph.connections.some(c => c.toNode === node)) {
            valueOnly = 'constant';
        } else if (liveBefore !== null && liveBefore === this._liveSourceSignature(node) &&
            typeof LiveUniformModule.pushLiveUniform === 'function') {
            valueOnly = 'live';
        }
        if (valueOnly === 'constant') {
            node.updateUniformRegistry();
            this.graph.onUniformValueChanged?.(node);
        } else if (valueOnly === 'live') {
            LiveUniformModule.pushLiveUniform(node);
            this.graph.onUniformValueChanged?.(node);
        } else {
            this._graphChanged();
        }
        this.graph.render();
        this.activity(`updated ${node.definition?.displayTitle || node.type} #${node.id}`);
        const out = { node: this.describeNode(node), changed: res.changed, recompiled: !valueOnly };
        if (valueOnly) out.uniform_update = true;
        if (res.disconnected.length) out.disconnected = res.disconnected;
        if (res.ignoredWhileConnected.length) {
            out.note = `Inline value(s) for ${res.ignoredWhileConnected.join(', ')} are stored but unused while the input is connected (disconnect it to use them).`;
        }
        return out;
    }

    /**
     * For live-uniform source nodes (getUniformValue: XYPad, Keyboard, MidiNote...):
     * a signature of the GLSL they generate, minus uniform values. If a data edit leaves
     * it unchanged, a uniform push is enough. null for every other node.
     */
    _liveSourceSignature(node) {
        const def = node.definition;
        if (typeof node.getUniformValue !== 'function' || node.hasUniformToggle || node.inputs.length ||
            !def || typeof def.glsl !== 'function') return null;
        try {
            const r = def.glsl(node, {}, null) || {};
            return JSON.stringify([r.code || '', r.output || '', r.preamble || '',
                (r.uniforms || []).map(u => (typeof u === 'string' ? u : [u.name, u.type]))]);
        } catch (e) {
            return null;
        }
    }

    moveNode({ id, x, y }) {
        const node = this._getNode(id);
        if (typeof x !== 'number' || typeof y !== 'number') throw new AutomationError('move_node requires numeric x and y');
        node.x = x;
        node.y = y;
        this.graph.render();
        this.activity(`moved ${node.definition?.displayTitle || node.type} #${node.id}`);
        return { id: node.id, x: Math.round(node.x), y: Math.round(node.y) };
    }

    // ------------------------------------------------------------------
    // Connections
    // ------------------------------------------------------------------

    _normalizeAccessor(accessor) {
        if (accessor === undefined || accessor === null) return null;
        const s = String(accessor).trim();
        if (!s) return null;
        return s.startsWith('.') ? s : '.' + s;
    }

    /**
     * Mirrors NodeGraph.onMouseUp (output -> input drop) so behaviour matches the UI.
     * Returns { conn, replaced, warnings }. Does NOT call onGraphChanged.
     */
    _connect(fromNode, fromOutputRef, toNode, toInputRef, accessorRef) {
        const g = this.graph;
        const outIdx = this._resolvePort(fromNode, fromOutputRef, 'output');
        const inIdx = this._resolvePort(toNode, toInputRef, 'input');
        const accessor = this._normalizeAccessor(accessorRef);

        if (fromNode === toNode) throw new AutomationError('Cannot connect a node to itself');
        if (this._wouldCreateCycle(fromNode, toNode)) {
            throw new AutomationError(`Connecting ${fromNode.type} #${fromNode.id} -> ${toNode.type} #${toNode.id} would create a cycle (use a Feedback node for loops over time)`);
        }

        const Connection = this._ConnectionClass();
        const existing = g.connections.filter(c => c.toNode === toNode && c.toInput === inIdx);
        g.connections = g.connections.filter(c => !(c.toNode === toNode && c.toInput === inIdx));

        const conn = new Connection(fromNode, outIdx, toNode, inIdx, accessor);
        if (fromNode.isDynamicInput && typeof g.resolveDynamicNodeOutputType === 'function') {
            g.resolveDynamicNodeOutputType(fromNode);
        }

        // What the cable carries. Generic outputs (Mix, Add, Blend, ForLoop, Swizzle...) only
        // get a concrete type from their connected inputs, so resolve it the way the
        // compiler will instead of validating the accessor against 'any'.
        const probe = this._typeProbe();
        const src = this._sourcePortType(fromNode, outIdx, probe);
        const outLabel = `${fromNode.type} #${fromNode.id}.${this._outputLabel(fromNode, outIdx)}`;
        const inType = toNode.inputs[inIdx].type;
        const warnings = [];
        let outType = src.type;
        let reason = null;
        if (accessor) {
            if (outType) {
                try {
                    outType = TypeRegistry.resolveAccessorType(outType, accessor);
                } catch (e) {
                    reason = `invalid accessor ${accessor}: ${e.message}`;
                    if (src.dynamic) reason += ` (${outLabel} is currently ${src.type}; its type follows its connected inputs, so connect those first)`;
                }
            } else {
                const syntax = this._accessorSyntaxError(accessor);
                if (syntax) reason = `invalid accessor ${accessor}: ${syntax}`;
                else warnings.push(`the type of ${outLabel} can't be resolved yet (${src.error}); accessor ${accessor} will be checked when compiling`);
            }
        }
        if (!reason && !(src.dynamic ? this._typesCompatible(outType, inType) : conn.isValid())) {
            reason = `type mismatch (${outType} -> ${inType}; struct types must match exactly)`;
        }
        if (reason) {
            g.connections.push(...existing); // restore
            const err = new AutomationError(
                `Cannot connect ${outLabel} -> ${toNode.type} #${toNode.id}.${toNode.inputs[inIdx].name}: ${reason}`,
                { outputs: this._portList(fromNode, 'output'), inputs: this._portList(toNode, 'input') }
            );
            // The source type may still change as more cables are added (build_graph retries these)
            err.retryable = src.dynamic;
            throw err;
        }

        g.connections.push(conn);

        // Same as the UI: grow dynamic nodes (Blend, ForLoop) when all inputs are used
        const before = toNode.inputs.length;
        if (toNode.shouldAddNewInput && toNode.shouldAddNewInput()) toNode.addDynamicInput();

        // (prepare() nodes such as ForLoopStart adopt the connected type at compile time)
        const isAny = TypeRegistry?.isAny?.(inType) || typeof toNode.definition?.prepare === 'function';
        // (a texture into a Preview is shown directly: no conversion needed)
        const shownTexture = outType === 'sampler2D' && toNode.isPreviewNode;
        if (outType && !isAny && !shownTexture && !TypeRegistry?.isAny?.(outType) && !TypeRegistry?.isStruct?.(outType) && TypeSystem?.canConvert && !TypeSystem.canConvert(outType, inType)) {
            warnings.push(`${outType} -> ${inType} has no automatic conversion; the shader may not compile`);
        }
        if (toNode.definition?.validateTypes && typeof toNode.definition.validateTypes === 'function') {
            try {
                const v = toNode.definition.validateTypes(toNode, this._inputTypesFor(toNode, probe), null);
                if (v && v.valid === false && v.error) warnings.push(`${toNode.type} #${toNode.id}: ${v.error}`);
            } catch (e) { /* ignore */ }
        }

        const out = { conn, replaced: existing.map(c => this._connString(c)), warnings };
        if (toNode.inputs.length !== before) out.inputs = toNode.inputs.map(i => `${i.name}:${i.type}`);
        return out;
    }

    /** Mirrors Connection.isValid for a resolved (or unknown = null) source type. */
    _typesCompatible(outType, inType) {
        if (!outType || TypeRegistry.isAny(inType)) return true; // unknown yet / node validates: checked at compile
        if (TypeRegistry.isStruct(outType) || TypeRegistry.isStruct(inType)) return outType === inType;
        return true; // primitives auto-convert
    }

    /** Syntax check for an accessor whose base type isn't known yet (null when OK). */
    _accessorSyntaxError(accessor) {
        const parts = String(accessor).replace(/^\./, '').split('.');
        if (!parts.every(p => /^[A-Za-z_]\w*$/.test(p))) return 'expected .member or .swizzle names';
        const firstSwizzle = parts.findIndex(p => TypeRegistry.isSwizzleComponent(p));
        if (firstSwizzle >= 0 && firstSwizzle !== parts.length - 1) return 'a swizzle must be the last part';
        return null;
    }

    /**
     * Scratch ShaderCompiler for type probes: same code path as compile, its output
     * is discarded and it doesn't log. One probe can serve several lookups while the
     * graph upstream of the probed nodes doesn't change (it caches compiled nodes).
     */
    _typeProbe() {
        const Ctor = ShaderCompilerModule.ShaderCompiler || this.toy.shaderCompiler?.constructor;
        if (typeof Ctor !== 'function') return null;
        try {
            const probe = new Ctor();
            probe.addError = function (message, nodeId = null) {
                this.errors.push(message);
                if (nodeId !== null && this.errorNodeId === null) this.errorNodeId = nodeId;
            };
            probe.addWarning = function (message) { this.warnings.push(message); };
            return probe;
        } catch (e) {
            return null;
        }
    }

    /** True when the compiler decides this output's type from the node's inputs. */
    _isDynamicOutput(node, outIdx) {
        const def = node.definition || {};
        const declared = def.outputs && def.outputs[outIdx] ? def.outputs[outIdx].type : undefined;
        return !declared || TypeRegistry.isAny(declared) || TypeRegistry.isAny(node.outputs[outIdx]?.type) ||
            !!node.isDynamicInput || !!def.isForLoopEndNode || typeof def.prepare === 'function';
    }

    /**
     * Type of an output port as the compiler resolves it right now. Dynamic outputs
     * (generic library nodes, Blend, ForLoop, Swizzle) are resolved by compiling the
     * node's upstream sub-graph with a scratch compiler, which sets the per-instance
     * port types exactly like a real compile does.
     * Returns { type (null = unknown), dynamic, error }.
     */
    _sourcePortType(node, outIdx, probe = null) {
        const port = node.outputs[outIdx];
        if (!port) return { type: null, dynamic: false, error: null };
        if (!this._isDynamicOutput(node, outIdx)) return { type: port.type, dynamic: false, error: null };
        probe = probe || this._typeProbe();
        let ok = false;
        const errorsBefore = probe ? probe.errors.length : 0;
        if (probe) {
            try { ok = !!probe.compileNode(node, this.graph); } catch (e) { ok = false; }
        }
        const t = node.outputs[outIdx] ? node.outputs[outIdx].type : null;
        const type = ok && t && !TypeRegistry.isAny(t) ? t : null;
        const error = ok ? null : ((probe && (probe.errors[errorsBefore] || probe.errors[0])) || 'the source node does not compile');
        return { type, dynamic: true, error };
    }

    /** Resolved input types of a node's connected inputs (null = unconnected / unknown). */
    _inputTypesFor(node, probe = null) {
        const inputTypes = {};
        node.inputs.forEach((inp, i) => {
            const c = this.graph.connections.find(cc => cc.toNode === node && cc.toInput === i);
            if (!c) { inputTypes[inp.name] = null; return; }
            probe = probe || this._typeProbe();
            const src = this._sourcePortType(c.fromNode, c.fromOutput, probe);
            let t = src.type;
            if (t && c.accessor) {
                try { t = TypeRegistry.resolveAccessorType(t, c.accessor); } catch { t = null; }
            }
            inputTypes[inp.name] = t || null;
        });
        return inputTypes;
    }

    connect({ from_node, from_output, to_node, to_input, accessor }) {
        const fromNode = this._getNode(from_node, 'source node');
        const toNode = this._getNode(to_node, 'target node');
        const r = this._connect(fromNode, from_output, toNode, to_input, accessor);
        this._graphChanged();
        this.activity(`connected ${fromNode.definition?.displayTitle || fromNode.type} -> ${toNode.definition?.displayTitle || toNode.type}`);
        const out = { connection: this._connString(r.conn) };
        if (r.replaced.length) out.replaced = r.replaced;
        if (r.warnings.length) out.warnings = r.warnings;
        if (r.inputs) out.target_inputs = r.inputs;
        return out;
    }

    disconnect({ to_node, to_input, from_node, from_output }) {
        const g = this.graph;
        let matches;
        if (to_node !== undefined && to_node !== null) {
            const toNode = this._getNode(to_node, 'target node');
            const inIdx = (to_input === undefined || to_input === null) ? null : this._resolvePort(toNode, to_input, 'input');
            matches = g.connections.filter(c => c.toNode === toNode && (inIdx === null || c.toInput === inIdx));
        } else if (from_node !== undefined && from_node !== null) {
            const fromNode = this._getNode(from_node, 'source node');
            const outIdx = (from_output === undefined || from_output === null) ? null : this._resolvePort(fromNode, from_output, 'output');
            matches = g.connections.filter(c => c.fromNode === fromNode && (outIdx === null || c.fromOutput === outIdx));
        } else {
            throw new AutomationError('disconnect requires to_node (optionally to_input) or from_node (optionally from_output)');
        }
        if (!matches.length) throw new AutomationError('No matching connection', { connections: g.connections.map(c => this._connString(c)) });
        g.connections = g.connections.filter(c => !matches.includes(c));
        this._graphChanged();
        this.activity(`removed ${matches.length} connection${matches.length > 1 ? 's' : ''}`);
        return { removed: matches.map(c => this._connString(c)) };
    }

    // ------------------------------------------------------------------
    // Custom GLSL nodes
    // ------------------------------------------------------------------

    _structDefinitionsFor(code) {
        if (!TypeRegistry?.types) return '';
        const used = new Set();
        for (const t of Object.keys(TypeRegistry.types)) {
            if (TypeRegistry.isStruct(t) && new RegExp(`\\b${t}\\b`).test(code)) {
                for (const dep of TypeRegistry.getDependentStructs(t)) used.add(dep);
            }
        }
        return [...used].reverse().map(t => TypeRegistry.generateStructDefinition(t)).join('\n');
    }

    _parseGLSLLog(log, sourceLines, lineOffset = 0) {
        const out = [];
        for (const raw of String(log || '').split('\n')) {
            const line = raw.trim();
            if (!line) continue;
            const m = /(?:ERROR|WARNING):\s*\d+:(\d+):\s*(.*)$/.exec(line);
            if (m) {
                const ln = parseInt(m[1], 10);
                const entry = { line: ln - lineOffset, message: m[2].trim() };
                const src = sourceLines[ln - 1];
                if (src !== undefined) entry.code = src.trim();
                out.push(entry);
            } else if (!/^\s*$/.test(line) && !/compilation errors/i.test(line)) {
                out.push({ message: line });
            }
        }
        return out;
    }

    _compileGLSL(vertexSrc, fragmentSrc) {
        const gl = this.gl;
        const result = { ok: true, stage: null, log: '' };
        const shaders = [];
        try {
            for (const [type, src, stage] of [[gl.VERTEX_SHADER, vertexSrc, 'vertex'], [gl.FRAGMENT_SHADER, fragmentSrc, 'fragment']]) {
                const sh = gl.createShader(type);
                shaders.push(sh);
                gl.shaderSource(sh, src);
                gl.compileShader(sh);
                if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
                    return { ok: false, stage, log: gl.getShaderInfoLog(sh) || 'unknown compile error' };
                }
            }
            const prog = gl.createProgram();
            shaders.forEach(s => gl.attachShader(prog, s));
            gl.linkProgram(prog);
            if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
                result.ok = false; result.stage = 'link'; result.log = gl.getProgramInfoLog(prog) || 'link error';
            }
            gl.deleteProgram(prog);
            return result;
        } finally {
            shaders.forEach(s => gl.deleteShader(s));
        }
    }

    _checkCustomGLSL(code) {
        const header = [
            '#version 300 es',
            'precision highp float;',
            'uniform float u_time;',
            'uniform vec2 u_resolution;',
            'uniform vec2 u_mouse;',
            'uniform sampler2D u_camera;',
            ptAudioUniformDeclarations(), // audio / beat built-ins (see the audio block at the end of this file)
            'out vec4 fragColor;',
            this._structDefinitionsFor(code),
            '',
        ].join('\n');
        const headerLines = header.split('\n').length - 1;
        const fragment = header + code + '\nvoid main() { fragColor = vec4(0.0); }\n';
        const vertex = '#version 300 es\nin vec2 a_position;\nvoid main() { gl_Position = vec4(a_position, 0.0, 1.0); }';
        const r = this._compileGLSL(vertex, fragment);
        if (r.ok) return { ok: true };
        return { ok: false, errors: this._parseGLSLLog(r.log, fragment.split('\n'), headerLines) };
    }

    createCustomNode({ name, glsl, mode = 'create', force = false }) {
        const nameRe = CustomNodesModule.CUSTOM_NODE_NAME_RE || /^[A-Za-z][A-Za-z0-9_]{0,48}$/;
        if (!name || typeof name !== 'string' || !nameRe.test(name)) {
            throw new AutomationError('Custom node name must start with a letter and contain only letters, digits and _ (at most 49 characters)');
        }
        if (!glsl || typeof glsl !== 'string') throw new AutomationError('glsl is required');
        const existing = NodeDefinitions[name];
        if (existing && !existing.isCustomNode) {
            throw new AutomationError(`"${name}" is a built-in node type; choose another name`);
        }
        if (mode === 'update' && !existing) {
            throw new AutomationError(`No custom node named "${name}"`, {
                custom_nodes: Object.keys(NodeDefinitions).filter(k => NodeDefinitions[k].isCustomNode)
            });
        }

        if (!force) {
            const check = this._checkCustomGLSL(glsl);
            if (!check.ok) {
                throw new AutomationError(`GLSL does not compile (line numbers are relative to your code)`, { glsl_errors: check.errors });
            }
        }

        const instances = this.graph.nodes.filter(n => n.type === name).length;
        const before = this.graph.connections.length;
        const res = this.toy.createCustomNode(name, glsl);
        if (!res || !res.success) {
            throw new AutomationError('The app rejected the custom node (see app_messages). Make sure the code contains a single function like "vec3 myFunc(vec2 uv) { ... }" or uses @node to pick the main function.');
        }
        if (this.activeProject) { this.activeProject.customNodes.add(name); this._persistActiveProject(); }
        this._graphChanged();
        this.activity(`${existing ? 'updated' : 'created'} custom node ${name}`);
        const out = { type: this.describeNodeType(name), updated: !!existing };
        if (existing) {
            out.instances_refreshed = instances;
            const dropped = before - this.graph.connections.length;
            if (dropped > 0) out.dropped_connections = dropped;
        }
        if (res.finalCode && res.finalCode !== glsl) out.note = 'Default magic comments (@node/@title/@input) were added to the code.';
        return out;
    }

    // ------------------------------------------------------------------
    // Batch build
    // ------------------------------------------------------------------

    _clearGraph() {
        this._stopOldPreviewRenderers();
        FloatingCodeEditor?.closeAll?.();
        this._loading = true;
        try {
            this.graph.deserialize({ nodes: [], connections: [], nextNodeId: 0, panX: 0, panY: 0, zoom: 1 });
        } finally {
            this._loading = false;
        }
    }

    clearGraph() {
        const n = this.graph.nodes.length;
        this._clearGraph();
        this.activity('cleared the graph');
        return { removed_nodes: n };
    }

    _parseRef(ref, keyMap) {
        if (ref === undefined || ref === null) throw new AutomationError('Connection endpoint missing');
        if (typeof ref === 'object') {
            const node = ref.node ?? ref.key ?? ref.id;
            return this._parseRef(String(node) + (ref.port !== undefined ? '.' + ref.port : '') + (ref.accessor ? (String(ref.accessor).startsWith('.') ? ref.accessor : '.' + ref.accessor) : ''), keyMap);
        }
        const s = String(ref).trim();
        const parts = s.split('.');
        const key = parts[0];
        let node = keyMap.get(key);
        if (!node && /^\d+$/.test(key)) node = this.graph.nodes.find(n => n.id === parseInt(key, 10));
        if (!node) {
            throw new AutomationError(`Unknown node key "${key}" in "${s}"`, { keys: [...keyMap.keys()] });
        }
        const port = parts.length > 1 ? parts[1] : undefined;
        const accessor = parts.length > 2 ? '.' + parts.slice(2).join('.') : null;
        return { node, port, accessor };
    }

    buildGraph({ nodes = [], connections = [], clear = false, layout }) {
        if (!Array.isArray(nodes) || !Array.isArray(connections)) throw new AutomationError('nodes and connections must be arrays');

        // Validate everything we can before touching the graph
        const problems = [];
        const keys = new Set();
        const resolvedTypes = nodes.map((n, i) => {
            const key = n && n.key !== undefined ? String(n.key) : null;
            if (!key) problems.push(`nodes[${i}]: missing key`);
            else if (key.includes('.')) problems.push(`nodes[${i}]: key "${key}" must not contain "."`);
            else if (keys.has(key)) problems.push(`nodes[${i}]: duplicate key "${key}"`);
            else keys.add(key);
            try { return this._resolveType(n.type); } catch (e) {
                problems.push(`nodes[${i}] (${key}): ${e.message}${e.data?.suggestions ? ` - did you mean ${e.data.suggestions.join(', ')}?` : ''}`);
                return null;
            }
        });
        if (problems.length) {
            throw new AutomationError('build_graph validation failed; nothing was created', { problems, hint: 'Use list_node_types to see valid types.' });
        }

        if (clear) this._clearGraph();

        const keyMap = new Map();
        const created = [];
        const errors = [];
        const warnings = [];
        let dataErrors = 0;
        const anyCoords = nodes.some(n => typeof n.x === 'number' && typeof n.y === 'number');

        nodes.forEach((n, i) => {
            const pos = (typeof n.x === 'number' && typeof n.y === 'number') ? { x: n.x, y: n.y } : { x: 100 + i * 40, y: 100 + i * 30 };
            const node = this.graph.addNode(resolvedTypes[i], pos.x, pos.y);
            if (!node) { errors.push(`${n.key}: app failed to create ${resolvedTypes[i]}`); return; }
            keyMap.set(String(n.key), node);
            created.push(node);
            if (node.data?.pairNodeId !== undefined && node.data?.pairNodeId !== null) {
                const pair = this.graph.nodes.find(p => p.id === node.data.pairNodeId);
                if (pair) {
                    if (!keys.has(`${n.key}_end`)) keyMap.set(`${n.key}_end`, pair);
                    created.push(pair);
                }
            }
            if (n.data) {
                try {
                    const r = this._applyData(node, n.data);
                    if (r.disconnected.length) warnings.push(`${n.key}: ${r.disconnected.length} connection(s) removed by useUniform`);
                } catch (e) {
                    dataErrors++;
                    errors.push(`${n.key}: ${e.message}${e.data?.data_fields ? ` (fields: ${e.data.data_fields.join(', ') || 'none'})` : ''}${e.data?.hint ? ` - ${e.data.hint}` : ''}`);
                }
            }
        });

        let made = 0;
        let connectionErrors = 0;
        const connError = (label, e) => {
            connectionErrors++;
            const detail = e.data?.inputs || e.data?.outputs || e.data?.keys;
            errors.push(`${label}: ${e.message}${detail ? ` [${(e.data.inputs ? 'inputs ' + e.data.inputs.join(', ') : '') || (e.data.outputs ? 'outputs ' + e.data.outputs.join(', ') : '') || ('keys ' + e.data.keys.join(', '))}]` : ''}`);
        };
        const madeInto = new Map(); // "nodeId:inputIndex" -> index of the last connection made into it
        const pending = [];
        const tryConnect = (item) => {
            const r = this._connect(item.from.node, item.from.port, item.to.node, item.to.port, item.accessor);
            made++;
            madeInto.set(`${r.conn.toNode.id}:${r.conn.toInput}`, item.i);
            r.warnings.forEach(w => warnings.push(`${item.label}: ${w}`));
        };
        connections.forEach((c, i) => {
            const label = `connections[${i}] ${typeof c.from === 'string' ? c.from : JSON.stringify(c.from)} -> ${typeof c.to === 'string' ? c.to : JSON.stringify(c.to)}`;
            let item = null;
            try {
                const from = this._parseRef(c.from, keyMap);
                const to = this._parseRef(c.to, keyMap);
                item = { i, label, from, to, accessor: c.accessor ?? from.accessor };
                tryConnect(item);
            } catch (e) {
                // A generic source (Mix, Add, Blend...) takes its type from its inputs, which may be
                // wired by a later connection: retry it once the rest of the graph is connected.
                if (item && e.retryable) { item.err = e; pending.push(item); return; }
                connError(label, e);
            }
        });
        for (let progress = true; pending.length && progress;) {
            progress = false;
            for (const item of [...pending]) {
                let inIdx = null;
                try { inIdx = this._resolvePort(item.to.node, item.to.port, 'input'); } catch (e) { /* reported by tryConnect */ }
                const last = inIdx === null ? undefined : madeInto.get(`${item.to.node.id}:${inIdx}`);
                if (last !== undefined && last > item.i) {
                    // A later connection already feeds this input (it would have replaced this one)
                    pending.splice(pending.indexOf(item), 1);
                    continue;
                }
                try {
                    tryConnect(item);
                    pending.splice(pending.indexOf(item), 1);
                    progress = true;
                } catch (e) {
                    item.err = e;
                }
            }
        }
        pending.forEach(item => connError(item.label, item.err));

        this._graphChanged();
        const doLayout = layout === undefined ? !anyCoords : !!layout;
        if (doLayout) this._autoLayout();
        if (doLayout || clear) this._fitView();

        const compile = this._compileReport({ include_source: false });
        this.activity(`built a graph (${created.length} nodes, ${made} connections)`);

        const ids = {};
        for (const [k, node] of keyMap) ids[k] = node.id;
        // ok = everything requested was applied AND it compiles. Node data / connection
        // failures don't abort the build (the rest is created and saved), so flag them here.
        const compileFailed = (compile.previews || []).some(p => p.connected !== false && !p.ok) ||
            (compile.feedback || []).some(f => !f.ok);
        const out = { ok: !errors.length && !compileFailed, ids, nodes_created: created.length, connections_made: made };
        if (errors.length) {
            const parts = [];
            if (connectionErrors) parts.push(`${connectionErrors} of ${connections.length} connection(s)`);
            if (dataErrors) parts.push(`node data for ${dataErrors} node(s) (those keep their defaults)`);
            out.error = `build_graph partially failed: ${parts.join(' and ') || `${errors.length} item(s)`} could not be applied; the rest was built. See errors.`;
            out.errors = errors;
        } else if (compileFailed) {
            out.error = 'The graph was built but does not compile; see compile.';
        }
        if (warnings.length) out.warnings = warnings;
        out.compile = compile;
        return out;
    }

    // ------------------------------------------------------------------
    // Compilation
    // ------------------------------------------------------------------

    _graphChanged() {
        if (typeof this.graph.onGraphChanged === 'function') this.graph.onGraphChanged();
        this.graph.render();
    }

    _compileApp() {
        const cm = this.toy.compilationManager;
        try { cm.createGlobalNodeIdMapping?.(); } catch (e) { /* ignore */ }
        try { this.toy.feedbackRenderer?.compileFeedbackShaders?.(); } catch (e) { console.warn('[automation] feedback compile failed', e); }
        cm.compile();
    }

    _errorNodeFor(lineNumber, fragmentLines, { useCompilerMap = true } = {}) {
        const sc = this.toy.shaderCompiler;
        let id = null;
        // The compiler's line map belongs to its last compile (a preview); feedback passes skip it
        if (useCompilerMap) {
            try { id = sc.parseWebGLError(`ERROR: 0:${lineNumber}:`); } catch (e) { /* ignore */ }
        }
        if (id === null || id === undefined) {
            const text = fragmentLines[lineNumber - 1] || '';
            const m = /\b(node_\d+)\b/.exec(text);
            if (m) {
                const n = this.toy.compilationManager.findNodeByRemappedName?.(m[1]);
                if (n) id = n.id;
            }
        }
        if (id === null || id === undefined) {
            // Errors inside custom-node functions (shader preamble): match the source line
            const text = (fragmentLines[lineNumber - 1] || '').trim();
            if (text.length > 3) {
                const owner = this.graph.nodes.find(n => n.definition?.isCustomNode &&
                    String(n.definition.customGLSL || '').split('\n').some(l => l.trim() === text));
                if (owner) return { id: owner.id, type: owner.type, in: 'custom node GLSL' };
            }
            return null;
        }
        const node = this.graph.nodes.find(n => n.id === id);
        return node ? { id: node.id, type: node.type } : { id };
    }

    _compileShaderFor(target, outputIndex = 0) {
        const sc = this.toy.shaderCompiler;
        try { this.toy.compilationManager.createGlobalNodeIdMapping?.(); } catch (e) { /* ignore */ }
        let shader;
        try {
            shader = target.isPreviewNode
                ? sc.compileForPreviewNode(target, this.graph)
                : sc.compileFromNodeAsOutput(target, outputIndex, this.graph);
        } catch (e) {
            return { shader: null, errors: [e.message] };
        }
        return { shader, errors: shader?.errors ? [...shader.errors] : [...(sc.errors || [])] };
    }

    _reportForShader(shader, compilerErrors, { include_source }) {
        const rep = { ok: true };
        const errors = [...new Set(compilerErrors || [])];
        const warnings = [...new Set(shader?.warnings || [])];
        if (!shader || !shader.fragment) {
            rep.ok = false;
            rep.errors = errors.length ? errors : ['Shader generation failed'];
            const sc = this.toy.shaderCompiler;
            const nid = shader?.errorNodeId ?? sc.errorNodeId;
            if (nid !== null && nid !== undefined) rep.error_node = this._nodeRef(nid);
            return rep;
        }
        const fragLines = shader.fragment.split('\n');
        const gl = this._compileGLSL(shader.vertex, shader.fragment);
        if (!gl.ok) {
            rep.ok = false;
            rep.glsl_errors = this._parseGLSLLog(gl.log, fragLines).map(e => {
                if (e.line) {
                    const n = this._errorNodeFor(e.line, fragLines);
                    if (n) e.node = n;
                }
                return e;
            });
        }
        if (errors.length) { rep.ok = false; rep.errors = errors; }
        if (warnings.length) rep.warnings = warnings;
        if (shader.errorNodeId !== null && shader.errorNodeId !== undefined) rep.error_node = this._nodeRef(shader.errorNodeId);
        const uniforms = (shader.uniformValues || []).map(u => u.name);
        if (uniforms.length) rep.uniforms = uniforms;
        if (include_source) rep.fragment = shader.fragment;
        return rep;
    }

    _nodeRef(id) {
        const n = this.graph.nodes.find(x => x.id === id);
        return n ? { id: n.id, type: n.type } : { id };
    }

    _compileReport({ include_source = false } = {}) {
        this._compileApp(); // UI path: updates previews, error highlights, uniforms
        const previews = this.graph.nodes.filter(n => n.isPreviewNode).sort((a, b) => a.id - b.id);
        const reports = [];
        for (const p of previews) {
            const connected = this.graph.connections.some(c => c.toNode === p);
            if (!connected) {
                reports.push({ id: p.id, ok: false, connected: false, note: 'Nothing connected to color input (shows TV static)' });
                continue;
            }
            const { shader, errors } = this._compileShaderFor(p);
            reports.push({ id: p.id, ...this._reportForShader(shader, errors, { include_source }) });
        }
        // Feedback passes are separate shaders (FeedbackRenderer): a failing pass renders
        // nothing although every Preview compiles, so it makes the whole compile fail.
        const feedback = this._feedbackReports({ include_source });
        const errorNodes = this.graph.nodes.filter(n => n.hasError && !n.isPreviewNode).map(n => `${n.id}:${n.type}`);
        const ok = reports.length > 0 && reports.every(r => r.ok) && feedback.every(f => f.ok);
        const out = { ok, previews: reports };
        if (feedback.length) out.feedback = feedback;
        if (!previews.length) out.note = 'No Preview node in the graph - add one (type "Preview") to see output.';
        if (errorNodes.length) out.error_nodes = errorNodes;
        return out;
    }

    /** Per Feedback node: did its pass (the sub-graph feeding its input) compile? */
    _feedbackReports({ include_source = false } = {}) {
        const out = [];
        const nodes = this.graph.nodes.filter(n => n.isFeedbackNode).sort((a, b) => a.id - b.id);
        for (const fb of nodes) {
            if (!this.graph.connections.some(c => c.toNode === fb)) {
                out.push({ id: fb.id, ok: true, connected: false, note: 'Nothing connected to its input (its texture stays black)' });
                continue;
            }
            const shader = fb.compiledShader;
            const raw = (fb.feedbackErrors || []).map(String);
            const rep = { id: fb.id, ok: !raw.length && !!(shader && shader.fragment) };
            if (!rep.ok) {
                const fragLines = shader && shader.fragment ? shader.fragment.split('\n') : [];
                const messages = [];
                const glsl = [];
                for (const e of raw) {
                    if (/(?:ERROR|WARNING):\s*\d+:\d+/.test(e)) {
                        for (const p of this._parseGLSLLog(e, fragLines)) {
                            if (p.line) {
                                const n = this._errorNodeFor(p.line, fragLines, { useCompilerMap: false });
                                if (n) p.node = n;
                            }
                            glsl.push(p);
                        }
                    } else {
                        messages.push(e);
                    }
                }
                rep.errors = [...messages, ...glsl.map(p => (p.line ? `line ${p.line}: ${p.message}` : p.message))];
                if (!rep.errors.length) rep.errors = ['Feedback pass failed to compile'];
                if (glsl.length) rep.glsl_errors = glsl;
            }
            if (shader && shader.warnings && shader.warnings.length) rep.warnings = [...new Set(shader.warnings)];
            if (include_source && shader && shader.fragment) rep.fragment = shader.fragment;
            out.push(rep);
        }
        return out;
    }

    compile({ include_source = false } = {}) {
        return this._compileReport({ include_source });
    }

    // ------------------------------------------------------------------
    // Rendering
    // ------------------------------------------------------------------

    _ensureRenderer(width, height) {
        const SP = ShaderPreviewModule.ShaderPreview;
        const gl = this.gl;
        if (!SP || !gl) throw new AutomationError('WebGL renderer not available');
        if (!this._renderer) {
            this._renderer = new SP(null, null, {
                offscreen: true,
                sharedGL: gl,
                width,
                height,
                uniformRegistry: this.graph.uniformRegistry,
            });
            this._renderer.stopRendering?.();
        }
        const r = this._renderer;
        r.graph = this.graph;
        r.uniformRegistry = this.graph.uniformRegistry;
        if (r.width !== width || r.height !== height || !r.framebuffer) {
            if (r.framebuffer) {
                gl.deleteFramebuffer(r.framebuffer.framebuffer);
                gl.deleteTexture(r.framebuffer.texture);
            }
            r.framebuffer = r.createFramebuffer(gl, width, height);
            r.width = width;
            r.height = height;
        }
        return r;
    }

    _renderShader(shader, width, height, time, mouse) {
        const gl = this.gl;
        const SP = ShaderPreviewModule.ShaderPreview;
        const r = this._ensureRenderer(width, height);
        const src = { ...shader, webglErrors: [] };
        const ok = r.loadShader(src);
        r.stopRendering?.();
        if (!ok) return { ok: false, errors: src.webglErrors };

        for (const u of r.customUniformValues || []) {
            if (u.type === 'sampler2D' && u.feedbackNode && typeof u.feedbackNode.getReadTexture === 'function') {
                u.texture = u.feedbackNode.getReadTexture();
            }
        }

        const savedMouse = [SP.mouseX, SP.mouseY];
        if (Array.isArray(mouse) && mouse.length === 2) { SP.mouseX = mouse[0]; SP.mouseY = mouse[1]; }
        r.startTime = Date.now() - time * 1000;
        try {
            r.render();
        } finally {
            SP.mouseX = savedMouse[0];
            SP.mouseY = savedMouse[1];
        }

        const pixels = new Uint8Array(width * height * 4);
        gl.bindFramebuffer(gl.FRAMEBUFFER, r.framebuffer.framebuffer);
        gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        return { ok: true, pixels };
    }

    _encodePNG(pixels, width, height, { flipY = true, opaque = true } = {}) {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        const img = ctx.createImageData(width, height);
        const row = width * 4;

        let sumR = 0, sumG = 0, sumB = 0, sumL = 0, sumL2 = 0, minL = 255, maxL = 0;
        const sampleColors = new Set();
        const step = Math.max(1, Math.floor(Math.sqrt((width * height) / 4096)));

        for (let y = 0; y < height; y++) {
            const srcRow = flipY ? (height - 1 - y) : y;
            for (let x = 0; x < width; x++) {
                const si = srcRow * row + x * 4;
                const di = y * row + x * 4;
                let r = pixels[si], g = pixels[si + 1], b = pixels[si + 2], a = pixels[si + 3];
                if (opaque) {
                    r = Math.round(r * a / 255); g = Math.round(g * a / 255); b = Math.round(b * a / 255); a = 255;
                }
                img.data[di] = r; img.data[di + 1] = g; img.data[di + 2] = b; img.data[di + 3] = a;
                const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
                sumR += r; sumG += g; sumB += b; sumL += l; sumL2 += l * l;
                if (l < minL) minL = l;
                if (l > maxL) maxL = l;
                if (x % step === 0 && y % step === 0 && sampleColors.size < 5000) sampleColors.add((r << 16) | (g << 8) | b);
            }
        }
        ctx.putImageData(img, 0, 0);
        const url = canvas.toDataURL('image/png');
        const n = width * height;
        const meanL = sumL / n;
        const std = Math.sqrt(Math.max(0, sumL2 / n - meanL * meanL));
        return {
            png: url.slice(url.indexOf(',') + 1),
            stats: {
                mean_rgb: [Math.round(sumR / n), Math.round(sumG / n), Math.round(sumB / n)],
                luma_min: Math.round(minL),
                luma_max: Math.round(maxL),
                luma_std: +std.toFixed(2),
                distinct_colors_sampled: sampleColors.size,
                blank: sampleColors.size <= 1,
            },
        };
    }

    renderPreview({ preview_id, node_id, output, width, height, time = 1.0, mouse } = {}) {
        let target;
        let outIdx = 0;
        if (node_id !== undefined && node_id !== null) {
            target = this._getNode(node_id);
            if (!target.isPreviewNode) outIdx = this._resolvePort(target, output, 'output');
        } else {
            const previews = this.graph.nodes.filter(n => n.isPreviewNode).sort((a, b) => a.id - b.id);
            if (preview_id !== undefined && preview_id !== null) {
                target = this._getNode(preview_id, 'preview node');
                if (!target.isPreviewNode) throw new AutomationError(`Node ${preview_id} is a ${target.type}, not a Preview. Use node_id to render any node's output.`);
            } else {
                target = previews[0];
                if (!target) throw new AutomationError('The graph has no Preview node. Add one, or pass node_id to render any node output.');
            }
        }
        if (target.isPreviewNode && !this.graph.connections.some(c => c.toNode === target)) {
            throw new AutomationError(`Preview #${target.id} has nothing connected to its color input`);
        }

        // Default size follows the preview's on-screen aspect ratio
        let w = Math.round(Number(width) || 0);
        let h = Math.round(Number(height) || 0);
        if (!w && !h) {
            w = 512;
            if (target.isPreviewNode) {
                const bar = target.bottomBarHeight || 32;
                const aspect = target.width / Math.max(1, target.height - bar);
                h = Math.round(w / (aspect || 1));
            } else {
                h = 512;
            }
        } else if (!h) {
            h = w;
        } else if (!w) {
            w = h;
        }
        const maxSize = Math.min(MAX_RENDER_SIZE, this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE) || MAX_RENDER_SIZE);
        w = Math.max(8, Math.min(maxSize, w));
        h = Math.max(8, Math.min(maxSize, h));

        this._compileApp();
        const { shader, errors } = this._compileShaderFor(target, outIdx);
        if (!shader || !shader.fragment) {
            throw new AutomationError('Shader generation failed', { errors });
        }
        try { this.toy.feedbackRenderer?.injectFeedbackTextures?.(shader, this.gl); } catch (e) { /* ignore */ }

        const res = this._renderShader(shader, w, h, Number(time) || 0, mouse);
        if (!res.ok) {
            const rep = this._reportForShader(shader, errors, { include_source: false });
            throw new AutomationError('Shader failed to compile', rep);
        }
        const enc = this._encodePNG(res.pixels, w, h);
        const out = {
            target: target.isPreviewNode ? `Preview #${target.id}` : `${target.type} #${target.id}.${this._outputLabel(target, outIdx)}`,
            width: w,
            height: h,
            time: Number(time) || 0,
            stats: enc.stats,
            png: enc.png,
        };
        if (errors && errors.length) out.compiler_errors = errors;
        return out;
    }

    captureEditor({ fit_view = false } = {}) {
        const g = this.graph;
        if (fit_view) this._fitView();
        try { (g.performRender || g.render).call(g); } catch (e) { /* ignore */ }
        const canvas = this.toy.nodeCanvas || g.canvas;
        const out = document.createElement('canvas');
        out.width = canvas.width;
        out.height = canvas.height;
        const ctx = out.getContext('2d');
        let bg = '#1e1e1e';
        try {
            for (const el of [canvas, canvas.parentElement, document.body]) {
                const c = el && getComputedStyle(el).backgroundColor;
                if (c && c !== 'transparent' && !/rgba\(0, 0, 0, 0\)/.test(c)) { bg = c; break; }
            }
        } catch (e) { /* ignore */ }
        ctx.fillStyle = bg;
        ctx.fillRect(0, 0, out.width, out.height);
        const bgCanvas = this.toy.backgroundRenderer?.canvas;
        if (bgCanvas && bgCanvas.style.display !== 'none') {
            try { this.toy.backgroundRenderer.shaderPreview?.render?.(); ctx.drawImage(bgCanvas, 0, 0, out.width, out.height); } catch (e) { /* ignore */ }
        }
        ctx.drawImage(canvas, 0, 0);
        const url = out.toDataURL('image/png');
        return {
            width: out.width,
            height: out.height,
            note: 'Captured from the node canvas (DOM toolbars/dialogs not included).',
            png: url.slice(url.indexOf(',') + 1),
        };
    }

    // ------------------------------------------------------------------
    // Layout
    // ------------------------------------------------------------------

    _autoLayout() {
        const g = this.graph;
        const nodes = g.nodes;
        if (!nodes.length) return 0;

        const outgoing = new Map(nodes.map(n => [n, []]));
        const incoming = new Map(nodes.map(n => [n, []]));
        for (const c of g.connections) {
            if (!outgoing.has(c.fromNode) || !incoming.has(c.toNode)) continue;
            if (c.toNode.isFeedbackNode) continue; // don't let feedback edges create cycles
            outgoing.get(c.fromNode).push(c.toNode);
            incoming.get(c.toNode).push(c.fromNode);
        }

        // Layer = longest distance to a sink (sinks/previews end up rightmost)
        const layer = new Map();
        const visiting = new Set();
        const depth = (n) => {
            if (layer.has(n)) return layer.get(n);
            if (visiting.has(n)) return 0;
            visiting.add(n);
            let d = 0;
            for (const t of outgoing.get(n)) d = Math.max(d, depth(t) + 1);
            visiting.delete(n);
            layer.set(n, d);
            return d;
        };
        nodes.forEach(depth);
        const maxLayer = Math.max(...layer.values());

        const columns = [];
        for (const n of nodes) {
            const col = maxLayer - layer.get(n);
            (columns[col] = columns[col] || []).push(n);
        }

        // Order within columns: barycenter of downstream positions (right to left), then upstream (left to right)
        const order = new Map();
        const setOrder = (col) => (columns[col] || []).forEach((n, i) => order.set(n, i));
        const sortBy = (col, neighbours) => {
            const list = columns[col];
            if (!list) return;
            const key = (n) => {
                const ns = neighbours(n).filter(m => order.has(m));
                if (!ns.length) return order.get(n) ?? 0;
                return ns.reduce((s, m) => s + order.get(m), 0) / ns.length;
            };
            list.sort((a, b) => key(a) - key(b) || a.id - b.id);
            setOrder(col);
        };
        columns.forEach((list, col) => { if (list) { list.sort((a, b) => a.y - b.y || a.id - b.id); setOrder(col); } });
        for (let pass = 0; pass < 3; pass++) {
            for (let col = columns.length - 2; col >= 0; col--) sortBy(col, n => outgoing.get(n));
            for (let col = 1; col < columns.length; col++) sortBy(col, n => incoming.get(n));
        }

        // Assign coordinates
        const gapX = 90, gapY = 36;
        const heights = columns.map(list => (list || []).reduce((s, n) => s + n.height, 0) + Math.max(0, (list || []).length - 1) * gapY);
        const tallest = Math.max(...heights, 0);
        let x = 80;
        columns.forEach((list, col) => {
            if (!list) return;
            const colWidth = Math.max(...list.map(n => n.width));
            let y = 80 + (tallest - heights[col]) / 2;
            for (const n of list) {
                n.x = Math.round(x);
                n.y = Math.round(y);
                y += n.height + gapY;
            }
            x += colWidth + gapX;
        });
        g.render();
        return nodes.length;
    }

    _fitView() {
        const g = this.graph;
        if (!g.nodes.length) return;
        const rect = g.canvas.getBoundingClientRect();
        const vw = rect.width || g.canvas.width;
        const vh = rect.height || g.canvas.height;
        const minX = Math.min(...g.nodes.map(n => n.x));
        const minY = Math.min(...g.nodes.map(n => n.y));
        const maxX = Math.max(...g.nodes.map(n => n.x + n.width));
        const maxY = Math.max(...g.nodes.map(n => n.y + n.height));
        const margin = 50, top = 70; // leave room for the floating toolbar
        const bw = Math.max(1, maxX - minX), bh = Math.max(1, maxY - minY);
        let zoom = Math.min(1, (vw - 2 * margin) / bw, (vh - top - margin) / bh);
        zoom = Math.max(g.minZoom || 0.1, zoom);
        g.zoom = zoom;
        g.panX = (vw - bw * zoom) / 2 - minX * zoom;
        g.panY = top + (vh - top - margin - bh * zoom) / 2 - minY * zoom;
        g.render();
    }

    /** Refit the view if the node is (partly) outside the visible canvas area. */
    _ensureVisible(node) {
        const g = this.graph;
        try {
            const rect = g.canvas.getBoundingClientRect();
            const z = g.zoom || 1;
            const left = (-g.panX) / z, top = (-g.panY + 60) / z;
            const right = (rect.width - g.panX) / z, bottom = (rect.height - g.panY) / z;
            const inside = node.x >= left && node.y >= top && node.x + node.width <= right && node.y + node.height <= bottom;
            if (!inside) this._fitView();
        } catch (e) { /* ignore */ }
    }

    autoLayout({ fit_view = true } = {}) {
        const count = this._autoLayout();
        if (fit_view) this._fitView();
        this.activity('tidied the layout');
        return { arranged: count, nodes: this.graph.nodes.map(n => `${n.id}:${n.type}@${Math.round(n.x)},${Math.round(n.y)}`) };
    }

    fitView() {
        this._fitView();
        const g = this.graph;
        return { panX: Math.round(g.panX), panY: Math.round(g.panY), zoom: +Number(g.zoom).toFixed(3) };
    }

    setBackgroundPreview({ preview_id }) {
        const g = this.graph;
        if (typeof g.onPreviewBackground !== 'function') throw new AutomationError('Background preview is not supported by this app version');
        if (preview_id === null || preview_id === undefined) {
            g.onPreviewBackground(null);
            this.activity('cleared the background preview');
            return { background: null };
        }
        const node = this._getNode(preview_id, 'preview node');
        if (!node.isPreviewNode) throw new AutomationError(`Node ${preview_id} is not a Preview node`);
        const br = this.toy.backgroundRenderer;
        const isActive = typeof br?.isActive === 'function' ? br.isActive(node) : !!node.isBackground;
        if (!isActive) g.onPreviewBackground(node); // toggles on
        node.isBackground = true; // saved with the project (PreviewNode.serialize) and restored on load
        // Make sure the background has the latest shader
        this._compileApp();
        this.activity(`set Preview #${node.id} as background`);
        return { background: node.id };
    }
}

// ======================================================================
// Audio / beat sync automation  (set_audio, get_audio_status, and the
// beat / beat_phase / bpm arguments of render_preview).
//
// Kept as a self-contained block that extends AutomationAPI.prototype, so it
// stays out of the way of the rest of the class. Imports are hoisted, so they
// can live here.
// ======================================================================
import * as ClockModule from '../core/Clock.js';
import * as AudioEngineModule from '../services/AudioEngine.js';
import * as BuiltinUniformsModule from '../core/builtinUniforms.js';
import * as AudioTexturesModule from '../services/AudioTextures.js';
import { SPECTROGRAM_NOTE as SPECTROGRAM_NOTE_PT } from '../core/audioTextureConfig.js';

/** Declarations of the audio / beat built-in uniforms (for standalone GLSL checks). */
function ptAudioUniformDeclarations() {
    const B = BuiltinUniformsModule;
    if (!B || !B.BUILTIN_UNIFORM_TYPES) return '';
    const basic = new Set(['u_time', 'u_resolution', 'u_mouse', 'u_camera']);
    return Object.keys(B.BUILTIN_UNIFORM_TYPES).filter(n => !basic.has(n)).map(B.builtinDeclaration).join('\n');
}

function ptBase64ToBytes(b64) {
    const bin = atob(String(b64).replace(/^data:[^,]*,/, ''));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
}

const PT_AUDIO_MIME = { mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', flac: 'audio/flac', m4a: 'audio/mp4', aac: 'audio/aac', opus: 'audio/ogg', webm: 'audio/webm', weba: 'audio/webm' };

AutomationAPI.METHODS.push('setAudio', 'getAudioStatus');

Object.assign(AutomationAPI.prototype, {
    _audio() {
        const engine = AudioEngineModule.audioEngine;
        const clock = ClockModule.clock;
        if (!engine || !clock) throw new AutomationError('Audio engine not available in this app version');
        return { engine, clock };
    },

    /**
     * set_audio: { mode: 'metronome'|'file'|'off', bpm?, url?, data_base64?, name?, mime?,
     *              play?, loop?, offset_ms?, locked? }
     * file mode takes a URL, or base64 file data (the MCP server reads local paths).
     */
    async setAudio({ mode, bpm, url, data_base64, name, mime, play = true, loop, offset_ms, locked } = {}) {
        const { engine } = this._audio();
        const m = String(mode || '').toLowerCase();
        if (!['metronome', 'file', 'off'].includes(m)) {
            throw new AutomationError(`mode must be 'metronome', 'file' or 'off' (got ${JSON.stringify(mode)})`);
        }
        const tempo = bpm !== undefined && bpm !== null ? Number(bpm) : undefined;
        if (tempo !== undefined && !(tempo >= 20 && tempo <= 400)) throw new AutomationError('bpm must be between 20 and 400');

        if (m === 'metronome') {
            await engine.setSource('metronome', { bpm: tempo });
        } else if (m === 'off') {
            await engine.setSource('off');
            if (tempo) engine.setBpm(tempo);
        } else {
            let src = null;
            if (data_base64) {
                const ext = String(name || '').split('.').pop().toLowerCase();
                src = new Blob([ptBase64ToBytes(data_base64)], { type: mime || PT_AUDIO_MIME[ext] || 'audio/mpeg' });
            } else if (url) {
                src = String(url);
            } else if (!engine.hasFile()) {
                throw new AutomationError('file mode needs url_or_path (an http(s) URL, or a local file path that the MCP server reads)');
            }
            try {
                if (src) await engine.loadFile(src, { play: false, name: name || null, loop: loop === undefined ? null : !!loop });
                else await engine.setSource('file');
                if (loop !== undefined) engine.setLoop(!!loop);
                // Wait for metadata so the status has a duration
                const el = engine.file.el;
                const t0 = performance.now();
                while (el && el.readyState < 1 && !engine.file.error && performance.now() - t0 < 4000) {
                    await new Promise(r => setTimeout(r, 50));
                }
                if (engine.file.error) throw new Error(engine.file.error);
                if (play) {
                    const ok = await engine.play();
                    if (!ok) throw new Error(engine.file.error || 'Playback was blocked (autoplay policy)');
                }
            } catch (e) {
                throw new AutomationError(`Could not load audio: ${e.message || e}`);
            }
            if (tempo) engine.setBpm(tempo);
        }
        if (offset_ms !== undefined && offset_ms !== null) engine.setOffset(offset_ms);
        if (locked !== undefined && locked !== null) engine.setLocked(!!locked);
        this.activity(`set audio to ${engine.sourceLabel()}${m === 'metronome' ? ` (${Math.round(engine.settings.metronomeBpm)} BPM)` : ''}`);
        return this.getAudioStatus();
    },

    getAudioStatus() {
        const { engine, clock } = this._audio();
        const status = engine.status();
        status.clock = clock.status();
        status.uniforms = Object.keys(BuiltinUniformsModule.BUILTIN_UNIFORM_TYPES || {}).filter(n => !['u_resolution', 'u_mouse', 'u_camera'].includes(n));
        status.notes = [
            'u_beat = exp(-6 * u_beatPhase) (1 on each beat); u_beatTime = u_beatCount + eased u_beatPhase; u_barPhase spans 4 beats.',
            'u_beatConfidence (Beat.confidence, the status confidence) is 0..1: 0 = no beat / coasting, ~0.5 = tentative, ~1 = locked and phase-confirmed; 1 with the metronome, a tapped tempo or a locked file tempo, 0 with audio off; 1 in render_preview beat renders. Multiply beat-driven effects by it so they fade with the lock.',
            'render_preview {beat | beat_phase, bpm?} renders a frame at that beat position with deterministic metronome-groove audio values (kick/bass on beats, snare on 2 & 4, hats on 8ths).',
            'Stable beat clock: u_beat, u_beatPhase, u_barPhase, u_beatCount, u_beatTime, u_bpm (and Beat / BeatEnvelope / BeatDivider, JS audio, scene auto-advance) come from a published clock, not the tracker directly: while the estimate is untrusted it coasts at the last trusted tempo (clock.beat_state coast), then glides to a new tempo over a bar (glide) and locks; the phase never jumps. u_beatTrust (clock.beat_trust, Beat.gate = smoothstep(threshold +- 0.25, u_beatTrust)) is 0 while coasting, about u_beatConfidence when locked, 1 without live audio; u_beat fades with it. u_beatRaw = (phase, bar phase, count, bpm) of the raw tracker estimate (clock.raw_bpm). Beat node data: clock stable | raw, gate fade | hold | off, threshold.',
            'Audio textures (u_spectrum, u_waveform, u_spectrogram, Audio Texture nodes): textures lists the ones shaders bind (mode live | synth (metronome: a deterministic synthetic mix, also in render_preview) | zero (audio off), max / mean of the CPU copy, upload count); upload_bytes_last_frame = GPU upload volume of the last frame; program_links = shader programs linked so far (constant while nothing recompiles).'
        ];
        try {
            const tex = AudioTexturesModule.audioTextures.status();
            tex.program_links = ShaderPreviewModule.ShaderPreview.programLinks;
            status.textures = tex;
        } catch (e) { /* older app build */ }
        return status;
    },
});

// render_preview: beat / beat_phase / bpm pin the beat clock (deterministic, metronome-driven values).
{
    const baseRenderPreview = AutomationAPI.prototype.renderPreview;
    const baseRenderShader = AutomationAPI.prototype._renderShader;

    AutomationAPI.prototype.renderPreview = function (params = {}) {
        const { clock } = this._audio();
        const has = v => v !== undefined && v !== null && v !== '';
        let beat;
        if (has(params.beat_phase)) {
            const ph = Number(params.beat_phase);
            if (!Number.isFinite(ph)) throw new AutomationError('beat_phase must be a number (0..1)');
            beat = Math.floor(has(params.beat) ? Number(params.beat) : 0) + (ph - Math.floor(ph));
        } else if (has(params.beat)) {
            beat = Number(params.beat);
            if (!Number.isFinite(beat)) throw new AutomationError('beat must be a number (beats, e.g. 4.25)');
        }
        let bpm = has(params.bpm) ? Number(params.bpm) : undefined;
        if (bpm !== undefined && !(bpm > 0)) throw new AutomationError('bpm must be > 0');
        if (bpm === undefined) bpm = clock.mode === 'metronome' ? clock.metroBpm : (clock.u.bpm || 120);
        const next = { ...params };
        if (beat !== undefined && !has(params.time)) next.time = beat * 60 / bpm; // keep u_time consistent with the beat
        const finish = (out) => {
            if (out && typeof out === 'object') {
                const B = beat !== undefined ? beat : (Number(next.time ?? 1) || 0) * bpm / 60;
                out.beat = +B.toFixed(4);
                out.beat_phase = +(B - Math.floor(B)).toFixed(4);
                out.bpm = +bpm.toFixed(3);
            }
            return out;
        };
        this._ptRenderBeat = { beat, bpm };
        let res;
        try {
            res = baseRenderPreview.call(this, next);
        } catch (e) {
            this._ptRenderBeat = null;
            throw e;
        }
        if (res && typeof res.then === 'function') {
            return res.then(finish).finally(() => { this._ptRenderBeat = null; });
        }
        this._ptRenderBeat = null;
        return finish(res);
    };

    AutomationAPI.prototype._renderShader = function (shader, width, height, time, mouse) {
        const { clock } = this._audio();
        const pin = this._ptRenderBeat || {};
        return clock.withOverride({ time: Number(time) || 0, beat: pin.beat, bpm: pin.bpm }, () => {
            // A pinned beat must also reach Feedback render targets (graded frame, bright pass...),
            // which otherwise hold whatever the live loop last drew: run their passes at the pinned
            // values first (twice, so a Feedback reading another Feedback is pinned too).
            const fr = this.toy.feedbackRenderer;
            if (pin.beat !== undefined && fr && this.graph.nodes.some(n => n.isFeedbackNode)) {
                try {
                    fr.renderFeedbackNodes();
                    fr.renderFeedbackNodes();
                    fr.injectFeedbackTextures(shader, this.gl);
                } catch (e) { /* render with the current buffers */ }
            }
            return baseRenderShader.call(this, shader, width, height, time, mouse);
        });
    };

    // list_node_types notes for the audio nodes
    const baseTypeNotes = AutomationAPI.prototype._typeNotes;
    AutomationAPI.prototype._typeNotes = function (name, def) {
        const notes = baseTypeNotes.call(this, name, def);
        if (def && (def.isAudioNode || def.isBeatNode || name === 'BeatEnvelope')) {
            notes.push('Driven by the global audio engine (set_audio: metronome / file / off). render_preview {beat | beat_phase, bpm} renders at a beat position with deterministic metronome values. The same values are available in any GLSL as u_level, u_bass, u_mid, u_high, u_kick, u_beat, u_beatPhase, u_barPhase, u_beatCount, u_bpm, u_beatTime, u_beatConfidence. Beat.confidence (= u_beatConfidence) is how sure the beat is (0 none / coasting .. 1 locked; 1 with the metronome): multiply beat-driven couplings by it so they fade in as the beat locks and out when it is lost.');
        }
        if (def && (def.isBeatNode || name === 'BeatEnvelope' || name === 'BeatDivider')) {
            notes.push('Stable beat clock: these nodes follow the published beat clock, which coasts while the tracker is unsure (a track change) and glides to a new tempo without jumps (u_beatTrust = how far it can be relied on; 1 without live audio, so metronome / silent renders are unaffected). Beat data: clock stable (default) | raw (the tracker\'s live estimate, diagnostics), gate fade (default: pulse x gate) | hold (outputs freeze while u_beatTrust < threshold, then catch up) | off, threshold (0.5); output gate = smoothstep(threshold - 0.25, threshold + 0.25, u_beatTrust): multiply beat-phase couplings (phase / bar into your own shapes) by gate x confidence. BeatEnvelope data.gate fade | off (on the built-in beat phase). BeatDivider data.unsure hold (default: no events while u_beatTrust < 0.5) | fire.');
        }
        if (def && (def.isAudioTextureNode || name === 'SpectrumBars' || name === 'WaveformLine' || name === 'CircularSpectrum')) {
            notes.push('Audio textures follow set_audio: live analysis of a mic / file / tab source (the beat tracker\'s own FFT, no extra analysis), metronome = a deterministic synthetic mix evaluated at the beat clock (render_preview {beat} is reproducible, the spectrogram history included), off = zeros. GPU: uploaded at most once per frame on first use (spectrum W x 1 RG16F, waveform W x 1 R16F, spectrogram W x 256 R16F ring: one row per frame); textures no shader binds cost nothing.');
            notes.push('Globals without wiring (declared and bound only when GLSL references them): u_spectrum (512 x 1, log 30 Hz..16 kHz, r = level 0..1, g = peak hold), u_waveform (1024 x 1, signed -1..1), u_spectrogram (256 bins x 256 rows, 4 s). ' + SPECTROGRAM_NOTE_PT + ' Custom GLSL example: float lvl = texture(u_spectrum, vec2(uv.x, 0.5)).r; float w = texture(u_waveform, vec2(uv.x, 0.5)).r; float s = texture(u_spectrogram, vec2(uv.y, (u_time - (1.0 - uv.x) * 3.9) / 4.0 - 0.5 / 256.0)).r;');
            if (def.isAudioTextureNode) notes.push("Options are node data: set_node_data {kind: 'spectrum'|'waveform'|'spectrogram', bins, scale: 'log'|'linear', smoothing, history} (recompiles: each option set is its own shared texture). Wire tex into Spectrum Bars / Waveform Line / Circular Spectrum, a custom GLSL sampler2D parameter or TextureSample; value is the texture at uv (spectrogram: uv.x = time, uv.y = frequency).");
        }
        return notes;
    };
}
// ====================== end of audio / beat sync block ======================

// ======================================================================
// Node groups (subgraphs): group_nodes / ungroup / rename_group / list_groups,
// build_graph {groups}, get_project groups, per-scope auto_layout.
// Groups are view/organization metadata (graph.groups, see
// src/graph/NodeGroups.js); the compiled graph stays flat.
// Self-contained block extending AutomationAPI.prototype.
// ======================================================================

AutomationAPI.METHODS.push('groupNodes', 'ungroup', 'renameGroup', 'listGroups');

Object.assign(AutomationAPI.prototype, {
    _groupCtl() {
        const ctl = this.graph.groupCtl;
        if (!ctl) throw new AutomationError('This app version has no node groups');
        return ctl;
    },

    /** Group by id ("g3") or by (unique, case-insensitive) name. */
    _resolveGroup(ref, label = 'group') {
        const ctl = this._groupCtl();
        if (ref === undefined || ref === null || ref === '') throw new AutomationError(`Missing ${label}`);
        const s = String(ref);
        const byId = ctl.getGroup(s);
        if (byId) return byId;
        const matches = ctl.groups.filter(gr => norm(gr.name) === norm(s));
        if (matches.length === 1) return matches[0];
        throw new AutomationError(matches.length ? `Several groups are named "${s}" - use the id` : `No group "${s}"`, {
            groups: ctl.groups.map(gr => `${gr.id}:${gr.name}`),
        });
    },

    _describeGroup(grp) {
        const ctl = this._groupCtl();
        const proxy = ctl.proxyFor(grp.id);
        // Build the parent scope's view so the box ports reflect the current graph
        try { ctl.buildView(ctl.parentOf(grp.id)); } catch (e) { /* ignore */ }
        const d = {
            id: grp.id,
            name: grp.name,
            parent: ctl.parentOf(grp.id),
            nodes: ctl.directNodes(grp.id).map(n => n.id).sort((a, b) => a - b),
            children: ctl.childrenOf(grp.id).map(c => c.id),
            node_count: ctl.subtreeNodes(grp.id).filter(n => !n.isCommentNode).length,
            x: Math.round(grp.x),
            y: Math.round(grp.y),
        };
        if (grp.color) d.color = grp.color;
        if (proxy) {
            d.inputs = proxy.inPorts.map(p => `${p.label}:${p.type || '?'}` + (p.source ? ` <- ${p.source.node.id}.${this._outputLabel(p.source.node, p.source.index)}` + (p.virtual && !p.conns.length ? ' (unused inside)' : '') : ' (exposed)'));
            d.outputs = proxy.outPorts.map(p => `${p.label}:${p.type || '?'} = ${p.source.node.id}.${this._outputLabel(p.source.node, p.source.index)}` + (p.conns.length ? '' : ' (exposed)'));
        }
        return d;
    },

    listGroups() {
        const ctl = this._groupCtl();
        return {
            scope: ctl.scope,
            groups: ctl.groups.map(grp => this._describeGroup(grp)),
            root_nodes: ctl.directNodes(null).map(n => n.id).sort((a, b) => a - b),
        };
    },

    /** Split mixed refs into real nodes and group records. */
    _groupMembers(refs, keyMap = null, groupKeys = null) {
        const ctl = this._groupCtl();
        const nodes = [], groups = [];
        for (const ref of refs || []) {
            const s = String(ref);
            if (keyMap && keyMap.has(s)) { nodes.push(keyMap.get(s)); continue; }
            if (groupKeys && groupKeys.has(s)) { groups.push(groupKeys.get(s)); continue; }
            if (/^\d+$/.test(s)) { nodes.push(this._getNode(parseInt(s, 10))); continue; }
            const grp = ctl.getGroup(s) || ctl.groups.find(x => norm(x.name) === norm(s));
            if (grp) { groups.push(grp); continue; }
            throw new AutomationError(`Unknown node or group "${s}"`, {
                keys: keyMap ? [...keyMap.keys()] : undefined,
                groups: ctl.groups.map(gr => `${gr.id}:${gr.name}`),
            });
        }
        // ForLoop pairs stay together
        for (const n of [...nodes]) {
            const pid = n.data && n.data.pairNodeId;
            if ((n.isForLoopStartNode || n.isForLoopEndNode) && pid !== undefined && pid !== null) {
                const pair = this.graph.nodes.find(m => m.id === pid);
                if (pair && !nodes.includes(pair)) nodes.push(pair);
            }
        }
        return { nodes: [...new Set(nodes)], groups: [...new Set(groups)] };
    },

    /** Common scope of a set of items (their shared parent), else the root. */
    _commonScope(nodes, groups) {
        const ctl = this._groupCtl();
        const scopes = new Set([...nodes.map(n => ctl.groupOf(n.id)), ...groups.map(gr => ctl.parentOf(gr.id))]);
        return scopes.size === 1 ? [...scopes][0] : null;
    },

    _placeNewGroup(grp, nodes, groups) {
        const ctl = this._groupCtl();
        const boxes = [...nodes, ...groups.map(gr => ({ x: gr.x, y: gr.y, width: 220, height: 130 }))];
        if (!boxes.length) return;
        const x0 = Math.min(...boxes.map(b => b.x)), y0 = Math.min(...boxes.map(b => b.y));
        const x1 = Math.max(...boxes.map(b => b.x + b.width)), y1 = Math.max(...boxes.map(b => b.y + b.height));
        try { ctl.buildView(grp.parentId); } catch (e) { /* ignore */ }
        const p = ctl.proxyFor(grp.id);
        grp.x = Math.round((x0 + x1) / 2 - (p ? p.width : 220) / 2);
        grp.y = Math.round((y0 + y1) / 2 - (p ? p.height : 130) / 2);
    },

    groupNodes({ name, node_ids, parent_group, color } = {}) {
        const ctl = this._groupCtl();
        if (!Array.isArray(node_ids) || !node_ids.length) throw new AutomationError('group_nodes needs node_ids (node ids and/or group ids)');
        const { nodes, groups } = this._groupMembers(node_ids);
        const parentGrp = parent_group !== undefined && parent_group !== null && parent_group !== '' ? this._resolveGroup(parent_group, 'parent_group') : null;
        const parentId = parentGrp ? parentGrp.id : this._commonScope(nodes, groups);
        let grp;
        try {
            grp = ctl.createGroup({ name, parentId, nodes, groups, color });
        } catch (e) {
            throw new AutomationError(e.message);
        }
        this._placeNewGroup(grp, nodes, groups);
        ctl.touch();
        this._groupsChanged();
        this.activity(`grouped ${nodes.length + groups.length} item(s) into "${grp.name}"`);
        return { group: this._describeGroup(grp) };
    },

    ungroup({ group_id } = {}) {
        const ctl = this._groupCtl();
        const grp = this._resolveGroup(group_id, 'group_id');
        const r = ctl.ungroup(grp.id);
        this._groupsChanged();
        this.activity(`ungrouped "${grp.name}"`);
        return { ungrouped: grp.id, moved_to: r.parent, nodes: r.nodes.map(n => n.id), groups: r.groups.map(g => g.id) };
    },

    renameGroup({ group_id, name } = {}) {
        const ctl = this._groupCtl();
        const grp = this._resolveGroup(group_id, 'group_id');
        if (!name || !String(name).trim()) throw new AutomationError('rename_group needs a non-empty name');
        const old = grp.name;
        ctl.renameGroup(grp.id, name);
        this._groupsChanged();
        this.activity(`renamed group "${old}" to "${grp.name}"`);
        return { id: grp.id, name: grp.name, previous: old };
    },

    _groupsChanged() {
        const ctl = this.graph.groupCtl;
        if (ctl) { ctl.touch(); ctl.ui.update(); }
        // Persist like any edit (live-mode sync + the app's autosave); groups don't affect compilation
        try { this.toy.projectManager?.markDirty?.(); } catch (e) { /* ignore */ }
        this.graph.render();
    },

    /**
     * build_graph groups: [{key, name, nodes:[node keys | node ids | group keys | group ids], parent?, color?}]
     * Returns { group_ids: {key: id}, errors: [] }.
     */
    _buildGroups(specs, keyMap) {
        const ctl = this._groupCtl();
        const groupKeys = new Map();
        const errors = [];
        const made = [];
        // Create all groups first (members later) so nodes lists may reference later keys
        for (const [i, spec] of specs.entries()) {
            const key = spec && spec.key !== undefined ? String(spec.key) : null;
            if (!key) { errors.push(`groups[${i}]: missing key`); continue; }
            if (groupKeys.has(key) || keyMap.has(key)) { errors.push(`groups[${i}]: key "${key}" is already used`); continue; }
            const grp = ctl.createGroup({ name: spec.name || key, parentId: null, color: spec.color });
            groupKeys.set(key, grp);
            made.push([spec, grp]);
        }
        for (const [spec, grp] of made) {
            try {
                const { nodes, groups } = this._groupMembers(spec.nodes || [], keyMap, groupKeys);
                for (const n of nodes) { ctl._removeFromGroups(n.id); grp.nodeIds.push(n.id); }
                for (const ch of groups) {
                    if (ch === grp) throw new AutomationError('a group cannot contain itself');
                    ch.parentId = grp.id;
                }
            } catch (e) {
                errors.push(`groups "${spec.key}": ${e.message}`);
            }
        }
        for (const [spec, grp] of made) {
            if (spec.parent === undefined || spec.parent === null || spec.parent === '') continue;
            const p = groupKeys.get(String(spec.parent)) || ctl.getGroup(String(spec.parent));
            if (!p) { errors.push(`groups "${spec.key}": unknown parent "${spec.parent}"`); continue; }
            if (p === grp || ctl.chainOf(p.id).includes(grp.id)) { errors.push(`groups "${spec.key}": parent "${spec.parent}" would create a cycle`); continue; }
            grp.parentId = p.id;
        }
        ctl.touch();
        // Default box placement (auto layout usually replaces it)
        for (const [, grp] of made) {
            const nodes = ctl.directNodes(grp.id);
            this._placeNewGroup(grp, nodes, ctl.childrenOf(grp.id));
        }
        ctl.touch();
        const group_ids = {};
        for (const [k, grp] of groupKeys) group_ids[k] = grp.id;
        return { group_ids, errors };
    },
});

// Integrations with existing methods (wrapped, so the class body stays untouched)
{
    const P = AutomationAPI.prototype;

    const baseDescribeNode = P.describeNode;
    P.describeNode = function (node) {
        const d = baseDescribeNode.call(this, node);
        const gid = this.graph.groupCtl?.groupOf(node.id);
        if (gid) d.group = gid;
        return d;
    };

    const baseGetGraph = P.getGraph;
    P.getGraph = function (...args) {
        const out = baseGetGraph.apply(this, args);
        const ctl = this.graph.groupCtl;
        if (ctl && ctl.hasGroups()) {
            out.groups = ctl.groups.map(grp => this._describeGroup(grp));
            out.root_nodes = ctl.directNodes(null).map(n => n.id).sort((a, b) => a - b);
        }
        return out;
    };

    // auto_layout: every scope on its own (group boxes are nodes in their parent scope);
    // Comment notes go in a row above their scope's content.
    const baseAutoLayout = P._autoLayout;
    P._autoLayout = function () {
        const ctl = this.graph.groupCtl;
        if (ctl && (ctl.hasGroups() || this.graph.nodes.some(n => n.isCommentNode))) return ctl.layoutAllScopes();
        return baseAutoLayout.call(this);
    };

    const baseFitView = P._fitView;
    P._fitView = function () {
        const ctl = this.graph.groupCtl;
        if (ctl && (ctl.hasGroups() || ctl.scope !== null)) { ctl.fitScope({ top: 70 }); return; }
        return baseFitView.call(this);
    };

    const baseAutoLayoutCmd = P.autoLayout;
    P.autoLayout = function (params = {}) {
        const out = baseAutoLayoutCmd.call(this, params);
        const ctl = this.graph.groupCtl;
        if (out && ctl && ctl.hasGroups()) {
            out.groups = ctl.groups.map(grp => `${grp.id}:${grp.name}@${Math.round(grp.x)},${Math.round(grp.y)}`);
            out.note = 'Each scope (root and every group) was laid out independently; group boxes are placed in their parent scope.';
        }
        return out;
    };

    // build_graph {groups}: created after the nodes/connections, before the layout
    const baseBuildGraph = P.buildGraph;
    P.buildGraph = function (params = {}) {
        const groups = params.groups;
        if (!Array.isArray(groups) || !groups.length) return baseBuildGraph.call(this, params);
        const nodes = Array.isArray(params.nodes) ? params.nodes : [];
        const anyCoords = nodes.some(n => n && typeof n.x === 'number' && typeof n.y === 'number');
        const doLayout = params.layout === undefined ? !anyCoords : !!params.layout;
        const out = baseBuildGraph.call(this, { ...params, groups: undefined, layout: false });
        const keyMap = new Map();
        for (const [k, id] of Object.entries(out.ids || {})) {
            const n = this.graph.nodes.find(m => m.id === id);
            if (n) keyMap.set(k, n);
        }
        const res = this._buildGroups(groups, keyMap);
        out.group_ids = res.group_ids;
        if (res.errors.length) {
            out.ok = false;
            out.errors = [...(out.errors || []), ...res.errors];
            out.error = out.error || 'build_graph partially failed: some groups could not be applied; see errors.';
        }
        if (doLayout) this._autoLayout();
        if (doLayout || params.clear) this._fitView();
        this._groupsChanged();
        return out;
    };
}
// ====================== end of node groups block ======================

// ======================================================================
// Param nodes / Parameters panel (list_params, set_param, Param-aware
// set_node_data + build_graph data) and JS nodes (trust, live status).
// Self-contained block extending AutomationAPI.prototype.
// ======================================================================
import * as ParamKindsModule from '../core/paramKinds.js';
import * as JSRuntimeModule from '../nodes/jsRuntime.js';

const PARAM_FIELDS = ['label', 'kind', 'value', 'default', 'min', 'max', 'step', 'scale', 'options', 'alpha', 'section', 'order', 'description', 'wrap', 'filter', 'imageName'];

AutomationAPI.METHODS.push('listParams', 'setParam');

Object.assign(AutomationAPI.prototype, {
    _describeParam(node) {
        const K = ParamKindsModule;
        const d = node.data;
        const out = {
            id: node.id,
            label: K.paramLabel(node),
            kind: d.kind,
            value: d.value,
            section: d.section || '',
            order: d.order,
        };
        if (d.default !== undefined) out.default = d.default;
        if (K.KIND_INFO[d.kind] && K.KIND_INFO[d.kind].range) Object.assign(out, { min: d.min, max: d.max, step: d.step });
        if (d.kind === 'float' || d.kind === 'int') out.scale = d.scale;
        if (d.kind === 'enum') { out.options = d.options; out.selected = d.options[d.value]; }
        if (d.kind === 'color') { out.alpha = !!d.alpha; out.hex = K.rgbToHex(d.value); }
        if (d.kind === 'image') { out.value = d.value ? (String(d.value).startsWith('data:') ? `<data URL, ${String(d.value).length} chars>` : d.value) : ''; out.loaded = !!node._imageReady; }
        if (d.description) out.description = d.description;
        out.outputs = node.outputs.map(o => `${o.name}:${o.type}`);
        const gid = this.graph.groupCtl?.groupOf(node.id);
        if (gid) out.group = gid;
        return out;
    },

    /** list_params: every Param node, grouped by section and sorted like the Parameters panel. */
    listParams() {
        const sections = ParamKindsModule.sortedParams(this.graph.nodes).map(s => ({
            name: s.name || 'General',
            params: s.params.map(n => this._describeParam(n)),
        }));
        const count = sections.reduce((a, s) => a + s.params.length, 0);
        const out = { count, sections };
        if (!count) out.hint = "No Param nodes. Add one with add_node {type:'Param', data:{label:'Speed', kind:'float', min:0, max:2, value:1, section:'Motion'}}.";
        return out;
    },

    _resolveParam(node_id, label) {
        const params = this.graph.nodes.filter(n => n.isParamNode);
        if (node_id !== undefined && node_id !== null && node_id !== '') {
            const node = this._getNode(node_id);
            if (!node.isParamNode) throw new AutomationError(`Node #${node.id} is a ${node.type}, not a Param`);
            return node;
        }
        if (label === undefined || label === null || label === '') throw new AutomationError('set_param needs node_id or label');
        const want = String(label).trim().toLowerCase();
        const hits = params.filter(n => ParamKindsModule.paramLabel(n).toLowerCase() === want);
        if (hits.length === 1) return hits[0];
        const labels = params.map(n => `${n.id}:${ParamKindsModule.paramLabel(n)}`);
        if (hits.length > 1) throw new AutomationError(`Several params are labelled "${label}"; pass node_id`, { params: labels });
        throw new AutomationError(`No param labelled "${label}"`, { params: labels });
    },

    /** set_param: change a Param's value (live uniform, never recompiles). */
    setParam({ node_id, label, value } = {}) {
        const node = this._resolveParam(node_id, label);
        if (value === undefined) throw new AutomationError('set_param needs a value', { param: this._describeParam(node) });
        try {
            if (node.data.kind === 'trigger' && (value === true || value === 'press' || value === 'fire')) node.press();
            else node.setValue(value);
        } catch (e) {
            throw new AutomationError(e.message, { param: this._describeParam(node) });
        }
        this.graph.render();
        this.activity(`set ${ParamKindsModule.paramLabel(node)}`);
        return { param: this._describeParam(node), recompiled: false, uniform_update: true };
    },

    /** set_node_data / build_graph data for Param nodes (atomic, kind-aware). */
    _applyParamData(node, data) {
        const K = ParamKindsModule;
        const result = { changed: [], disconnected: [], ignoredWhileConnected: [] };
        if (!data || typeof data !== 'object') return result;
        const unknown = Object.keys(data).filter(k => !PARAM_FIELDS.includes(k) && k !== 'hex');
        if (unknown.length) {
            throw new AutomationError(`Param #${node.id} has no data field(s): ${unknown.join(', ')}`, {
                data_fields: PARAM_FIELDS,
                hint: `kind is one of ${K.PARAM_KINDS.join(', ')}; value follows the kind (number, true/false, [x,y,z], "#rrggbb" for color, option index or name for enum).`
            });
        }
        const before = JSON.parse(JSON.stringify(node.data));
        const oldOutputs = node.outputs.map(o => `${o.name}:${o.type}`).join(',');
        try {
            const d = node.data;
            if (data.kind !== undefined) {
                const k = K.normalizeKind(data.kind);
                if (!k) throw new AutomationError(`Unknown param kind "${data.kind}" (use ${K.PARAM_KINDS.join(', ')})`);
                if (k !== d.kind) {
                    const old = d.kind;
                    d.kind = k;
                    K.adoptKindRange(d, old, k);
                    if (data.value === undefined) {
                        let v;
                        try { v = (k === 'image' || k === 'trigger' || old === 'image' || old === 'trigger') ? K.kindDefault(k, { ...d, ...data }) : K.coerceParamValue({ ...d, ...data }, before.value); } catch (e) { v = K.kindDefault(k, { ...d, ...data }); }
                        d.value = v;
                    }
                    if (data.default === undefined) delete d.default;
                }
                result.changed.push('kind');
            }
            for (const key of ['label', 'section', 'description', 'scale', 'wrap', 'filter', 'imageName']) {
                if (data[key] !== undefined) { d[key] = data[key] === null ? '' : String(data[key]); result.changed.push(key); }
            }
            for (const key of ['min', 'max', 'step', 'order']) {
                if (data[key] === undefined) continue;
                const v = Number(data[key]);
                if (!Number.isFinite(v)) throw new AutomationError(`data.${key} must be a number (got ${JSON.stringify(data[key])})`);
                d[key] = v;
                result.changed.push(key);
            }
            if (data.alpha !== undefined) {
                d.alpha = !!data.alpha;
                if (Array.isArray(d.value)) d.value = d.alpha ? [d.value[0], d.value[1], d.value[2], d.value[3] ?? 1] : d.value.slice(0, 3);
                if (Array.isArray(d.default)) d.default = d.alpha ? [d.default[0], d.default[1], d.default[2], d.default[3] ?? 1] : d.default.slice(0, 3);
                result.changed.push('alpha');
            }
            if (data.options !== undefined) {
                const opts = Array.isArray(data.options) ? data.options : String(data.options).split(',');
                d.options = opts.map(o => String(o).trim()).filter(Boolean);
                if (!d.options.length) throw new AutomationError('data.options needs at least one option');
                result.changed.push('options');
            }
            const raw = data.value !== undefined ? data.value : data.hex;
            if (raw !== undefined) {
                try { d.value = K.coerceParamValue(d, raw); } catch (e) { throw new AutomationError(e.message); }
                result.changed.push('value');
            }
            if (data.default !== undefined) {
                try { d.default = K.coerceParamValue(d, data.default); } catch (e) { throw new AutomationError(`default: ${e.message}`); }
                result.changed.push('default');
            } else if (raw !== undefined && (before.kind !== d.kind || node._paramFresh)) {
                // A value given at creation (add_node / build_graph) or with a new kind is the default
                d.default = Array.isArray(d.value) ? [...d.value] : d.value;
            }
            K.normalizeParamData(d);
        } catch (e) {
            node.data = before;
            node.syncFromData({ silent: true });
            throw e;
        }
        node._paramFresh = false;
        node.syncFromData();
        result.outputsChanged = oldOutputs !== node.outputs.map(o => `${o.name}:${o.type}`).join(',');
        return result;
    },
});

{
    const P = AutomationAPI.prototype;

    // Param nodes take kind-aware data; JS code set by the agent counts as authored here
    const baseApplyData = P._applyData;
    P._applyData = function (node, data) {
        if (node && node.isParamNode) return this._applyParamData(node, data);
        const res = baseApplyData.call(this, node, data);
        if (node && node.isJSNode && JSRuntimeModule.jsRuntime) {
            if (res.changed.includes('outputs')) node.syncOutputsFromData?.();
            // Only code the agent itself wrote counts as authored here (a label change on a
            // paused node must not run it). Headless pages trust it for the session only.
            const wroteCode = data && typeof data === 'object' && (data.code !== undefined || data.setupCode !== undefined);
            if (wroteCode) JSRuntimeModule.jsRuntime.trustNode(node, { persist: !this.headless });
        }
        return res;
    };

    // Projects opened by the agent are treated like local work (no permission prompt)
    const baseLoadProject = P.loadProject;
    P.loadProject = async function (params) {
        const rt = JSRuntimeModule.jsRuntime;
        if (rt) rt.suspend++;
        try {
            const out = await baseLoadProject.call(this, params);
            // Trusted for this page session only: the file's code wasn't written here, so it
            // must not run unprompted when the same project is opened later from a link
            for (const n of this.graph.nodes) if (n.isJSNode) rt?.trustNode(n, { persist: false });
            return out;
        } finally {
            if (rt) rt.suspend--;
        }
    };

    // Live JS node status in get_project / add_node results
    const baseDescribe = P.describeNode;
    P.describeNode = function (node) {
        const d = baseDescribe.call(this, node);
        if (node.isJSNode) {
            const values = {};
            for (const [k, v] of node.values || []) {
                values[k] = v.type === 'sampler2D' ? (v.tex || 'texture')
                    : Array.isArray(v.value) ? v.value.map(x => +x.toFixed(5)) : (typeof v.value === 'number' ? +v.value.toFixed(5) : v.value);
            }
            d.js = {
                status: node.jsError ? 'error' : node.trust === 'trusted' ? (node.setupState === 'ready' ? 'running' : node.setupState) : 'paused',
                values,
                recompiles: node.recompiles || 0,
            };
            if (node.textures && node.textures.size) {
                d.js.textures = {};
                for (const [k, t] of node.textures) d.js.textures[k] = { kind: t.kind, size: [t.w, t.h], format: t.format, uploads: t.uploads };
            }
            if (node.jsError) d.js.error = node.jsError;
        }
        return d;
    };

    const baseTypeNotes = P._typeNotes;
    P._typeNotes = function (name, def) {
        const notes = baseTypeNotes.call(this, name, def);
        if (def && def.isParamNode) {
            notes.push(`UI parameter listed in the Parameters panel (any group, any zoom). data: label (pretty name), kind (${ParamKindsModule.PARAM_KINDS.join(' | ')}), value, default, min/max/step + scale 'linear'|'log' (float/int/vecN), options (enum, value = index, outputs int), alpha (color: true = vec4 rgba), section (panel heading), order, description (tooltip); image: value = image URL or data URL (sampler2D 'tex'), wrap clamp|repeat|mirror, filter linear|nearest.`);
            notes.push("Outputs follow the kind: float/int/vecN -> 'value', bool -> 'value' (float 0/1) + 'on' (bool), color -> 'color' (vec3, vec4 with alpha), enum -> 'index' (int), trigger -> 'pulse' (1 for one frame per press), 'count', 'since' (seconds since the last press), image -> 'tex'.");
            notes.push('Values are live uniforms: set_param / set_node_data {value} never recompile; changing kind (or color alpha) recompiles. list_params shows them as the panel does.');
        }
        if (def && def.isJSNode) {
            notes.push("data.code runs every frame with time, dt, frame, resolution [w,h], mouse [0..1, 0..1], audio {level,bass,mid,high,kick,beat,beatPhase,bpm,...}, params {label: value} and a persistent state object; helpers float int bool vec2 vec3 vec4 clamp mix damp(current, target, rate). data.setupCode runs once (async, await loadScript(url)).");
            notes.push("Its return value defines the outputs: a number -> 'out' float, [x,y,z] -> vec3, true -> bool, or { speed: float(v), hue: vec3(r,g,b) } for named outputs. Values are pushed as live uniforms every frame; the graph recompiles only when the output names/types change (get_project shows js.values, js.status, js.recompiles, js.error).");
            notes.push("Texture outputs (sampler2D): return a canvas, texture(source, {filter, wrap}) or dataTexture(array, width, height = 1, channels = 4). canvas(w, h) (create it in setup, keep it in state) is re-uploaded only on frames where it was drawn (or c.dirty = true); dataTexture uploads a Float32Array / number array as RGBA32F (RGBA16F / RGBA8 fallback), NEAREST: element i is texel (i % width, i / width), read with texelFetch(tex, ivec2(i, 0), 0) for a width x 1 texture (e.g. 21 hand landmarks x vec4 -> dataTexture(lm, 21, 1, 4)). Size / kind changes recompile, content changes don't. Ports come from the first returned value: set data.outputs (e.g. [{name:'tex', type:'sampler2D'}]) to wire them in the same build_graph.");
            notes.push("Demo 'beat lyrics': setup state.c = canvas(512, 256); frame: on a new Math.floor(audio.beatCount) draw the next word with state.c.getContext('2d').fillText(...), return { words: texture(state.c), pulse: float(audio.beat) } into a custom GLSL node vec3 lyricWarp(vec2 uv, sampler2D words, float pulse) that warps texture(words, uv). Demo 'random walk dots': 32 points in a Float32Array(32 * 4) -> dataTexture(d, 32, 1, 4) -> custom GLSL looping for (int i = 0; i < 32; i++) over texelFetch(points, ivec2(i, 0), 0) drawing glows. Full code in mcp/README.md (JS nodes).");
            notes.push('Code set through MCP counts as authored locally and runs; code arriving in project files opened in the browser asks the user first.');
        }
        return notes;
    };
}
// ====================== end of params / JS node block ======================

// ======================================================================
// Scenes: SceneSwitcher / ScenePresence. list_scenes, set_scene,
// render_preview {scene, scene_from, progress, transition, scene_node},
// switcher-aware ports / data, list_node_types notes.
// Self-contained block extending AutomationAPI.prototype.
// ======================================================================
import * as ScenesModule from '../core/scenes.js';

AutomationAPI.METHODS.push('listScenes', 'setScene');

const SWITCHER_RUNTIME_KEYS = new Set(['current', 'transition', 'duration', 'durationUnit', 'easing', 'angle', 'softness', 'strength', 'auto', 'autoBars', 'autoSeconds', 'playlist']);

Object.assign(AutomationAPI.prototype, {
    _switchers() {
        return this.graph.nodes.filter(n => n.isSceneSwitcher).sort((a, b) => a.id - b.id);
    },

    _resolveSwitcher(node_id) {
        if (node_id !== undefined && node_id !== null && node_id !== '') {
            const node = this._getNode(node_id);
            if (!node.isSceneSwitcher) throw new AutomationError(`Node #${node.id} is a ${node.type}, not a SceneSwitcher`);
            return node;
        }
        const all = this._switchers();
        if (!all.length) throw new AutomationError("The graph has no SceneSwitcher. Add one with add_node {type:'SceneSwitcher', data:{scenes:['A','B']}} and connect scenes to its inputs '0', '1', ...");
        return all[0];
    },

    _sceneRef(sw, ref, label = 'scene') {
        const i = sw.resolveScene(ref);
        if (i < 0) throw new AutomationError(`SceneSwitcher #${sw.id} has no ${label} ${JSON.stringify(ref)}`, { scenes: sw.data.scenes.map((s, k) => `${k}:${s.name}`) });
        return i;
    },

    _transitionRef(v) {
        if (v === undefined || v === null || v === '') return undefined;
        const k = ScenesModule.transitionKey(v);
        if (!k) throw new AutomationError(`Unknown transition ${JSON.stringify(v)}`, { transitions: ScenesModule.TRANSITION_KEYS });
        return k;
    },

    /** list_scenes: every SceneSwitcher with its scenes, state and the transition list. */
    listScenes() {
        const gates = ScenesModule.sceneGates(this.graph);
        const switchers = this._switchers().map(sw => {
            const d = sw.describe();
            d.presence_nodes = this.graph.nodes.filter(n => n.isScenePresence).map(n => {
                const o = ScenesModule.sceneOwner(this.graph, gates, n.id);
                return o && o.switcher === sw ? { id: n.id, scene: o.index, scene_name: sw.sceneName(o.index) } : null;
            }).filter(Boolean);
            d.feedback = this.graph.nodes.filter(n => n.isFeedbackNode).map(n => {
                const s = gates.get(n.id);
                if (!s || s.has('*')) return null;
                const scenes = [...s].map(k => k.split(':').map(Number)).filter(([id]) => id === sw.id).map(([, i]) => i);
                return scenes.length ? { id: n.id, scenes, running: ScenesModule.feedbackPassActive(n, gates, this.graph), keep_running: !!n.data.keepRunning } : null;
            }).filter(Boolean);
            return d;
        });
        const out = {
            count: switchers.length,
            switchers,
            transitions: ScenesModule.TRANSITIONS.map(t => ({ key: t.key, label: t.label, description: t.description })),
            easings: ScenesModule.EASING_KEYS,
            auto_modes: ScenesModule.AUTO_MODES,
        };
        if (!switchers.length) out.hint = "No SceneSwitcher. build_graph {nodes:[{key:'sw', type:'SceneSwitcher', data:{scenes:['Tunnel','Orbit']}}], connections:[{from:'a', to:'sw.0'}, {from:'b', to:'sw.1'}, {from:'sw.color', to:'preview'}]}";
        return out;
    },

    /** set_scene: transition a switcher to a scene (index or name; 'next' / 'prev'). */
    setScene({ node_id, scene, transition, duration, instant } = {}) {
        const sw = this._resolveSwitcher(node_id);
        if (scene === undefined || scene === null || scene === '') throw new AutomationError('set_scene needs a scene (index, name, "next" or "prev")', { scenes: sw.data.scenes.map((s, k) => `${k}:${s.name}`) });
        const opts = { source: 'mcp', transition: this._transitionRef(transition), instant: !!instant };
        if (duration !== undefined && duration !== null) {
            const dv = Number(duration);
            if (!(dv >= 0)) throw new AutomationError('duration must be a number >= 0 (seconds, or beats with data.durationUnit "beats")');
            opts.duration = dv;
        }
        const s = String(scene).toLowerCase();
        if (s === 'next' || s === 'prev' || s === 'previous') sw.nextScene(s === 'next' ? 1 : -1, opts);
        else sw.requestScene(this._sceneRef(sw, scene), opts);
        this.activity(`switched to scene "${sw.sceneName(sw.data.current)}"`);
        return { switcher: sw.describe() };
    },
});

{
    const P = AutomationAPI.prototype;

    // Switcher ports: scene names and numbers beyond the current count ('5' adds scenes)
    const baseResolvePort = P._resolvePort;
    P._resolvePort = function (node, ref, kind) {
        if (node && node.isSceneSwitcher && kind === 'input' && typeof ref === 'string' && ref !== '') {
            const s = ref.trim();
            if (/^\d+$/.test(s)) {
                let guard = 0;
                while (!node.inputs.some(p => p.name === s) && guard++ < 64) node.addDynamicInput();
            } else if (!node.inputs.some(p => p.name === s)) {
                const i = node.resolveScene(s);
                if (i >= 0) return node.inputIndexOfScene(i);
            }
        }
        return baseResolvePort.call(this, node, ref, kind);
    };

    // Switcher data: scene names, current / playlist by name, validated styles; current transitions
    const baseApplyData = P._applyData;
    P._applyData = function (node, data) {
        if (!node || !node.isSceneSwitcher || !data || typeof data !== 'object') return baseApplyData.call(this, node, data);
        const d = { ...data };
        if (d.scenes !== undefined) {
            if (!Array.isArray(d.scenes) || !d.scenes.length) throw new AutomationError('data.scenes must be a non-empty array of names or {name, transition?, duration?}');
            d.scenes = d.scenes.map((s, i) => {
                const o = typeof s === 'string' ? { name: s } : (s && typeof s === 'object' ? { ...s } : { name: `Scene ${i + 1}` });
                if (o.transition !== undefined) o.transition = this._transitionRef(o.transition);
                if (o.transition === undefined) delete o.transition;
                return o;
            });
        }
        if (d.transition !== undefined) d.transition = this._transitionRef(d.transition) || 'crossfade';
        if (d.easing !== undefined && !ScenesModule.EASING_KEYS.includes(d.easing)) throw new AutomationError(`Unknown easing ${JSON.stringify(d.easing)}`, { easings: ScenesModule.EASING_KEYS });
        if (d.auto !== undefined) {
            if (d.auto === false || d.auto === null) d.auto = 'off';
            if (!ScenesModule.AUTO_MODES.includes(d.auto)) throw new AutomationError(`data.auto must be one of ${ScenesModule.AUTO_MODES.join(', ')}`);
        }
        if (d.durationUnit !== undefined && !['seconds', 'beats'].includes(d.durationUnit)) throw new AutomationError("data.durationUnit must be 'seconds' or 'beats'");
        let current;
        if (d.current !== undefined) {
            current = d.current;
            delete d.current;
        }
        const fresh = this.graph.nodes.includes(node) && !node._sceneDataApplied;
        node._sceneDataApplied = true;
        const res = baseApplyData.call(this, node, d);
        if (d.playlist !== undefined) {
            const list = Array.isArray(d.playlist) ? d.playlist : [d.playlist];
            node.data.playlist = list.map(x => this._sceneRef(node, x, 'playlist entry'));
            node.rebuildTextInputs();
        }
        if (current !== undefined) {
            const i = this._sceneRef(node, current);
            // At creation (add_node / build_graph) the scene is shown directly
            if (fresh && !node.state.active) {
                node.data.current = node.state.a = node.state.b = i;
                node.pushUniforms(true);
            } else {
                node.requestScene(i, { source: 'mcp' });
            }
            res.changed.push('current');
        }
        return res;
    };

    // Runtime-only switcher fields (current, transition, auto...) do not recompile
    const baseSetNodeData = P.setNodeData;
    P.setNodeData = function (params = {}) {
        const node = params && params.id !== undefined ? this.graph.nodes.find(n => String(n.id) === String(params.id)) : null;
        if (!node || !node.isSceneSwitcher || !params.data || typeof params.data !== 'object') return baseSetNodeData.call(this, params);
        const keys = Object.keys(params.data);
        const sameCount = !params.data.scenes || (Array.isArray(params.data.scenes) && params.data.scenes.length === node.sceneCount);
        if (!keys.length || !keys.every(k => SWITCHER_RUNTIME_KEYS.has(k) || k === 'scenes') || !sameCount) return baseSetNodeData.call(this, params);
        const res = this._applyData(node, params.data);
        node.pushUniforms(true);
        this.graph.render();
        this.graph.onUniformValueChanged?.(node);
        this.activity(`updated Scene Switcher #${node.id}`);
        return { node: this.describeNode(node), changed: res.changed, recompiled: false, uniform_update: true };
    };

    // get_project: switcher state, presence ownership
    const baseDescribe = P.describeNode;
    P.describeNode = function (node) {
        const d = baseDescribe.call(this, node);
        if (node.isSceneSwitcher) {
            const s = node.describe();
            d.scenes_state = { current: s.current, current_name: s.current_name, evaluated: s.evaluated };
            if (s.transitioning) d.scenes_state.transitioning = s.transitioning;
        }
        if (node.isScenePresence) {
            const o = ScenesModule.sceneOwner(this.graph, ScenesModule.sceneGates(this.graph), node.id);
            d.scene = o ? `${o.switcher.id}:${o.index} ${o.switcher.sceneName(o.index)}` : null;
        }
        return d;
    };

    // render_preview: pin a scene / a transition for deterministic renders
    const baseRenderPreview = P.renderPreview;
    const baseRenderShader = P._renderShader;
    P.renderPreview = function (params = {}) {
        const has = v => v !== undefined && v !== null && v !== '';
        const { scene, scene_from, progress, transition, scene_node, ...rest } = params || {};
        if (!has(scene) && !has(scene_from) && !has(progress) && !has(transition)) return baseRenderPreview.call(this, rest);
        const sw = this._resolveSwitcher(scene_node);
        const styleArg = this._transitionRef(transition);
        let p = has(progress) ? Number(progress) : undefined;
        if (p !== undefined && !(p >= 0 && p <= 1)) throw new AutomationError('progress must be in 0..1 (eased transition progress)');
        let to = has(scene) ? this._sceneRef(sw, scene) : undefined;
        let from = has(scene_from) ? this._sceneRef(sw, scene_from, 'scene_from') : undefined;
        if (p === undefined && from !== undefined) p = 0.5;
        if (p !== undefined) {
            if (from === undefined) from = sw.data.current;
            if (to === undefined) {
                const order = sw.data.scenes.map((_, i) => i);
                to = order[(order.indexOf(from) + 1) % order.length];
            }
        } else {
            from = to = (to !== undefined ? to : sw.data.current);
            p = 0;
        }
        // Default style: the entered scene's own transition, else the switcher default
        const style = styleArg || (sw.data.scenes[to] && sw.data.scenes[to].transition) || sw.data.transition;
        const pin = { a: from, b: to, p, style };
        this._ptScenePin = { sw, pin };
        const finish = (out) => {
            if (out && typeof out === 'object') out.scene_pin = { switcher: sw.id, from, to, progress: p, transition: style, scene_name: sw.sceneName(p >= 0.5 ? to : from) };
            return out;
        };
        try {
            const res = baseRenderPreview.call(this, rest);
            if (res && typeof res.then === 'function') return res.then(finish).finally(() => { this._ptScenePin = null; });
            this._ptScenePin = null;
            return finish(res);
        } catch (e) {
            this._ptScenePin = null;
            throw e;
        }
    };
    P._renderShader = function (shader, width, height, time, mouse) {
        const pinned = this._ptScenePin;
        if (!pinned) return baseRenderShader.call(this, shader, width, height, time, mouse);
        const { sw, pin } = pinned;
        sw.pin = pin;
        sw.pushUniforms(true);
        try {
            // Feedback passes of the pinned scenes (others stay frozen / skipped)
            const fr = this.toy.feedbackRenderer;
            if (fr && this.graph.nodes.some(n => n.isFeedbackNode)) {
                try {
                    fr.renderFeedbackNodes();
                    fr.renderFeedbackNodes();
                    fr.injectFeedbackTextures(shader, this.gl);
                } catch (e) { /* render with the current buffers */ }
            }
            return baseRenderShader.call(this, shader, width, height, time, mouse);
        } finally {
            sw.pin = null;
            sw.pushUniforms(true);
        }
    };

    // list_node_types notes
    const baseTypeNotes = P._typeNotes;
    P._typeNotes = function (name, def) {
        const notes = baseTypeNotes.call(this, name, def);
        if (def && def.isSceneSwitcher) {
            notes.push("Scenes: connect each scene's color to the numbered inputs '0', '1', ... (to_input as a string; connecting the last free input adds a scene; a scene name also works as to_input). data.scenes = names or [{name, transition?, duration?}] (per-scene entrance style / duration), data.current = shown scene (index or name).");
            notes.push("Compute: each scene's exclusive upstream sub-graph becomes its own GLSL function and only the shown scene(s) run (1 normally, 2 during a transition, whatever the scene count); values the rest of the graph computes anyway are shared; Feedback passes used only by hidden scenes are skipped (Feedback data.keepRunning = true keeps a simulation running).");
            notes.push(`Transitions (data.transition, per scene, or set_scene {transition}): ${ScenesModule.TRANSITIONS.map(t => `${t.key} (${t.description})`).join('; ')}. Params: data.angle (deg), softness (0..1), strength. data.duration (+ durationUnit 'seconds' | 'beats'), data.easing ${ScenesModule.EASING_KEYS.join(' | ')}.`);
            notes.push("Selection is CPU-side: set_scene / list_scenes, data.current, the Parameters panel (Scenes section), keys 1-9, clicking a scene's number tag on the node, the 'scene' input (Param / JS / Float / MIDI CC value, rounded; a wired Param follows UI changes) and the 'next' input (advances on a rising value, e.g. a Param trigger). data.auto 'bars' (every autoBars bars of the beat clock) | 'seconds' (every autoSeconds) | 'off'; data.playlist = ordered scene indices or names.");
            notes.push("Outputs: color, index (current scene), progress (eased, 0 when idle). render_preview {scene} pins a scene, {scene_from, scene, progress, transition} a transition frame.");
        }
        if (def && def.isScenePresence) {
            notes.push("Use inside a scene (upstream of a SceneSwitcher scene input); the scene is found by graph reachability (shared by two scenes: each scene's copy reads its own presence). presence 0 = hidden .. 1 = shown, eased over the transition; phase -1 -> 0 entering, 0 -> 1 leaving; leaving = 1 while leaving. Wire presence into an effect's amount (0 = identity) so a scene collapses / settles as it leaves and builds up as it enters. Transition 'self' / 'self-add' / 'sequential' leave the choreography to the scenes.");
        }
        if (name === 'TransitionInput') {
            notes.push("Only meaningful inside a SceneSwitcher 'transition' input sub-graph (style 'custom'): a (leaving scene color), b (entering scene color), progress, uv. Both scenes are evaluated at the pixel; return the mixed vec4.");
        }
        return notes;
    };
}
// ====================== end of scenes block ======================

// ======================================================================
// Debug probes (ValueDisplay, ColorDisplay, Plot, XYScope, FrameStats,
// Histogram, LED): read_probes, probe values in get_project, list_node_types notes.
// Self-contained block extending AutomationAPI.prototype.
// ======================================================================
AutomationAPI.METHODS.push('readProbes');

Object.assign(AutomationAPI.prototype, {
    _probeRenderer() {
        const cm = this.toy && this.toy.compilationManager;
        return (cm && cm.probes) || null;
    },

    /** Keep probes rendering for an MCP reader and refresh values that are missing / stale. */
    _refreshProbes(nodes) {
        const pr = this._probeRenderer();
        if (!pr || !nodes.length) return;
        pr.markReader(nodes);
        const now = performance.now();
        const stale = nodes.filter(n => n.probe && n.probe.status === 'ok' && (!n.probe.meta || now - n.probe.updatedAt > 250));
        if (stale.length) {
            try { pr.sampleNow(stale); } catch (e) { /* report what we have */ }
        }
    },

    async readProbes({ ids, history = true, max_points = 120, wait_ms = 0 } = {}) {
        const g = this.graph;
        let probes = g.nodes.filter(n => n.isProbeNode).sort((a, b) => a.id - b.id);
        if (ids !== undefined && ids !== null && !(Array.isArray(ids) && !ids.length)) {
            const list = Array.isArray(ids) ? ids : [ids];
            probes = list.map(id => {
                const n = this._getNode(id, 'probe');
                if (!n.isProbeNode) {
                    throw new AutomationError(`Node #${n.id} is a ${n.type}, not a debug probe`, {
                        probes: g.nodes.filter(x => x.isProbeNode).map(x => `${x.id}:${x.type}`)
                    });
                }
                return n;
            });
        }
        const pr = this._probeRenderer();
        if (pr) pr.markReader(probes);
        const wait = Math.max(0, Math.min(10000, Number(wait_ms) || 0));
        if (wait) await new Promise(r => setTimeout(r, wait));
        this._refreshProbes(probes);
        const maxPoints = Math.max(2, Math.min(2000, Number(max_points) || 120));
        const out = {
            count: probes.length,
            probes: probes.map(n => n.describeProbe({ history: history !== false, maxPoints })),
        };
        if (pr) {
            const st = pr.stats;
            out.renderer = {
                supported: pr.supported,
                format: st.format,
                resolution: pr.resolution(),
                readback: st.mode,
                batches: st.batches,
                last_batch: { probes: st.probes_last, texels: st.texels_last },
                cpu_ms: { issue: +st.issue_ms.toFixed(3), collect: +st.collect_ms.toFixed(3), sync_read: +st.sync_read_ms.toFixed(3) },
                latency_ms: +st.latency_ms.toFixed(1),
            };
        }
        if (!probes.length) out.hint = "No probes in this project: add ValueDisplay / ColorDisplay / Plot / XYScope / FrameStats / Histogram / LED nodes (category 'debug') and connect a value to their input.";
        return out;
    },
});

{
    const P = AutomationAPI.prototype;

    // get_project: every probe node carries its latest reading (no plot history)
    const baseGetGraph = P.getGraph;
    P.getGraph = function (...args) {
        try { this._refreshProbes(this.graph.nodes.filter(n => n.isProbeNode)); } catch (e) { /* ignore */ }
        return baseGetGraph.apply(this, args);
    };
    const baseDescribe = P.describeNode;
    P.describeNode = function (node) {
        const d = baseDescribe.call(this, node);
        if (node && node.isProbeNode && typeof node.describeProbe === 'function') {
            try {
                const { id, type, ...probe } = node.describeProbe({ history: false });
                d.probe = probe;
            } catch (e) { /* ignore */ }
        }
        return d;
    };

    const baseTypeNotes = P._typeNotes;
    P._typeNotes = function (name, def) {
        const notes = baseTypeNotes.call(this, name, def);
        if (def && def.isProbeNode) {
            notes.push("Debug probe (output-style sink, never compiled into other shaders): connect any value (float/int/bool/vecN, a texture shows its colour) to the single input. The input sub-graph is compiled like a Preview and evaluated on the GPU, then read back to the CPU (RGBA32F when EXT_color_buffer_float is available, else 8-bit = clamped 0..1 without NaN/Inf detection). read_probes returns the values; get_project shows each probe's latest reading in node.probe.");
            if (def.probeKind === 'grid') {
                notes.push('Evaluated over the whole frame on a coarse grid (64 samples wide, aspect of the reference preview), refreshed ~10x per second.');
            } else {
                notes.push("Sample point: data.sample 'origin' = uv (0,0), the bottom-left corner (default) | 'center' = (0.5, 0.5) | 'mouse' (u_mouse) | 'custom' = (data.u, data.v). The value is the exact one at that uv (u_resolution = the canvas background, else the largest Preview).");
            }
            notes.push('Probes render only while visible on the canvas (open group, on screen) or for ~15 s after an MCP read (read_probes / get_project), so call read_probes {wait_ms} to collect Plot / XY Scope history of an off-screen probe.');
        }
        return notes;
    };
}
// ====================== end of debug probes block ======================

// ======================================================================
// Output toolkit (src/output): start_recording / stop_recording /
// output_window. Files come back base64-encoded; the MCP server writes them
// (exports/). Self-contained block extending AutomationAPI.prototype.
// ======================================================================

AutomationAPI.METHODS.push('startRecording', 'stopRecording', 'outputWindow');

Object.assign(AutomationAPI.prototype, {
    _output() {
        const m = this.toy.output;
        if (!m) throw new AutomationError('The output toolkit is not available in this build (app.output missing)');
        return m;
    },

    async _outputFile(result) {
        const out = { ...result };
        delete out.blob;
        if (result.blob) {
            const buf = new Uint8Array(await result.blob.arrayBuffer());
            let s = '';
            for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
            out.data_base64 = btoa(s);
            out.bytes = buf.length;
        }
        if (typeof out.durationMs === 'number') { out.duration_s = +(out.durationMs / 1000).toFixed(3); delete out.durationMs; }
        return out;
    },

    _outputPreview(preview_id) {
        if (preview_id === undefined || preview_id === null || preview_id === '' || preview_id === 'main') return 'main';
        const node = this._getNode(preview_id, 'preview');
        if (!node.isPreviewNode) throw new AutomationError(`Node ${preview_id} is a ${node.type}, not a Preview`, { previews: this._output().previewNodes().map(n => n.id) });
        return node.id;
    },

    async startRecording({ preview_id, width, height, resolution, fps = 30, mode = 'realtime', duration, format, bitrate, audio = false, from_start = true } = {}) {
        const m = this._output();
        const source = this._outputPreview(preview_id);
        const opts = { preview_id: source, width, height, resolution: resolution || (width && height ? undefined : '720p'), fps, bitrate, download: false };
        if (mode === 'offline') {
            const fmt = format || 'mp4';
            if (!['mp4', 'webm', 'png'].includes(fmt)) throw new AutomationError(`format must be mp4, webm or png for offline exports (got ${fmt})`);
            const dur = Number(duration) > 0 ? Number(duration) : 5;
            this.activity(`is exporting ${dur} s of video frame by frame`);
            let res;
            try {
                res = await m.exportOffline({ ...opts, format: fmt, duration: dur, fromStart: from_start !== false });
            } catch (e) {
                throw new AutomationError(e.message || String(e));
            }
            this.activity(`exported ${res.frames} frames (${res.render_fps} frames/s)`);
            return this._outputFile(res);
        }
        if (mode !== 'realtime') throw new AutomationError("mode must be 'realtime' or 'offline'");
        const fmt = format || 'webm';
        if (!['webm', 'mp4'].includes(fmt)) throw new AutomationError(`format must be webm or mp4 for real-time recordings (got ${fmt})`);
        let status;
        try {
            status = m.startRecording({ ...opts, format: fmt, audio: !!audio, duration: Number(duration) > 0 ? Number(duration) : undefined });
        } catch (e) {
            throw new AutomationError(e.message || String(e));
        }
        this.activity('started recording');
        if (Number(duration) > 0) {
            const res = await m.nextRecording();
            this.activity(`recorded ${(res.durationMs / 1000).toFixed(1)} s`);
            return this._outputFile(res);
        }
        return { recording: true, status, note: 'Real-time recording runs until stop_recording.' };
    },

    async stopRecording() {
        const m = this._output();
        if (m.exporter) {
            m.cancelExport();
            return { cancelled_export: true };
        }
        if (!m.recorder) throw new AutomationError('Not recording', { status: m.status() });
        const res = await m.stopRecording({ download: false });
        this.activity(`stopped recording (${(res.durationMs / 1000).toFixed(1)} s)`);
        return this._outputFile(res);
    },

    async outputWindow({ action = 'status', preview_id, display, fullscreen, performance_mode, test_pattern, calibrating, calibration } = {}) {
        const m = this._output();
        if (performance_mode !== undefined) m.setSettings({ performanceMode: !!performance_mode });
        if (action === 'open') {
            const source = this._outputPreview(preview_id);
            m.setSettings({ source });
            try {
                await m.openWindow({ preview_id: source, display, fullscreen: !!fullscreen });
            } catch (e) {
                throw new AutomationError(e.message || String(e));
            }
            this.activity('opened the output window');
        } else if (action === 'close') {
            m.closeWindow();
            this.activity('closed the output window');
        } else if (action !== 'status') {
            throw new AutomationError("action must be 'open', 'close' or 'status'");
        } else if (preview_id !== undefined && m.window && !m.window.closed) {
            m.setSettings({ source: this._outputPreview(preview_id) });
            m.setWindowSource(m.settings.source);
        }
        const w = m.window && !m.window.closed ? m.window : null;
        if (w) {
            if (test_pattern !== undefined) w.setPattern(test_pattern === true ? 'grid' : test_pattern === false ? 'off' : String(test_pattern));
            if (calibrating !== undefined) w.setCalibrating(!!calibrating);
            if (calibration && typeof calibration === 'object') w.applyCalibration(calibration);
        } else if (test_pattern !== undefined || calibrating !== undefined || calibration) {
            if (action !== 'close') throw new AutomationError('The output window is not open (action: open first)');
        }
        // Give the window a couple of frames so the status reports its size / fps
        if (w && action === 'open') await new Promise(r => setTimeout(r, 300));
        const out = m.status();
        out.previews = m.previewNodes().map(n => n.id);
        try {
            const OW = await import('../output/OutputWindow.js');
            const scr = await OW.getScreens({ request: false });
            out.displays = { supported: scr.supported, permission: scr.state, screens: scr.screens.map(({ index, label, width, height, primary }) => ({ index, label, width, height, primary })) };
        } catch (e) { /* ignore */ }
        return out;
    },
});

// get_project / getInfo: mention the output state when something is live
{
    const P = AutomationAPI.prototype;
    const baseGetInfo = P.getInfo;
    P.getInfo = function (...args) {
        const out = baseGetInfo.apply(this, args);
        try {
            const st = this.toy.output && this.toy.output.status();
            if (out && st && (st.recording || st.export || st.window)) out.output = st;
        } catch (e) { /* ignore */ }
        return out;
    };
}
// ====================== end of output toolkit block ======================

// ======================================================================
// Control rate (src/core/control): port rates + live control values in
// get_project, rate-aware connect (pixel -> control rejected, Delay loops
// allowed), control evaluation pinned to render_preview's time / beat,
// list_node_types notes. Self-contained block extending AutomationAPI.prototype.
// ======================================================================
import * as ControlRatesModule from '../core/control/rates.js';
import * as ControlRuntimeModule from '../core/control/ControlRuntime.js';
import * as ControlMathModule from '../core/control/vmath.js';

// Compile counter (get_project control_rate.compile_count): control values never recompile
let ptControlCompileCount = 0;
try { window.addEventListener('patchtoy:compile', () => { ptControlCompileCount++; }); } catch (e) { /* no window */ }

{
    const P = AutomationAPI.prototype;
    const R = ControlRatesModule;
    const plan = (api) => {
        try { return R.getControlPlan(api.graph); } catch (e) { return null; }
    };

    // get_project / add_node: rate of the node and of each port, live control values
    const baseDescribe = P.describeNode;
    P.describeNode = function (node) {
        const d = baseDescribe.call(this, node);
        const pl = plan(this);
        if (!pl) return d;
        const rate = pl.rateOf(node);
        const kind = pl.kindOf(node);
        d.rate = rate;
        const ins = node.inputs.map((_, i) => pl.inRate(node, i));
        const outs = node.outputs.map((_, k) => pl.outRate(node, k));
        if (ins.some(r => r !== R.PIXEL) || outs.some(r => r !== R.PIXEL)) {
            d.port_rates = {
                inputs: node.inputs.map((inp, i) => `${inp.name}:${ins[i]}`),
                outputs: node.outputs.map((o, k) => `${o.name === '' ? 'out' : o.name}:${outs[k]}`),
            };
        }
        if (pl.isEvaluated(node) && !node.isJSNode && node._ctlOut) {
            const info = pl.info.get(node);
            const values = {};
            node.outputs.forEach((o, k) => {
                const t = info && info.outTypes ? info.outTypes[k] : o.type;
                const v = node._ctlOut[k];
                if (t === 'sampler2D') values[o.name] = node.liveTexture && node.liveTexture(o.name) ? 'texture' : null;
                else values[o.name] = ControlMathModule.roundValue(v);
            });
            d.control = { values, compiled_as_uniforms: pl.uniformNodes.has(node) };
            const h = node._ctlHist;
            if (h && h.count) d.control.events_fired = h.count;
            if (node._ctlError) d.control.error = node._ctlError;
        } else if (kind === 'control' && node._ctlError) {
            d.control = { error: node._ctlError };
        }
        const bad = pl.violations.filter(v => v.conn.toNode === node).map(v => v.message);
        if (bad.length) d.rate_errors = bad;
        if (pl.errors.has(node)) (d.rate_errors || (d.rate_errors = [])).push(pl.errors.get(node));
        return d;
    };

    // get_project: totals
    const baseGetGraph = P.getGraph;
    P.getGraph = function (...args) {
        const out = baseGetGraph.apply(this, args);
        const pl = plan(this);
        if (out && pl) {
            const counts = { pixel: 0, control: 0, free: 0 };
            for (const n of this.graph.nodes) counts[pl.rateOf(n)]++;
            const rt = ControlRuntimeModule.controlRuntime;
            out.control_rate = {
                nodes: counts,
                evaluated_per_frame: pl.order.length,
                live_uniforms: rt ? rt.pushed : undefined,
                eval_ms: rt ? +rt.evalMs.toFixed(3) : undefined,
                compile_count: ptControlCompileCount,
                // a compile is scheduled (debounced edit) or still linking: counts may still change
                compile_pending: !!(this.toy.compilationManager && (this.toy.compilationManager.compileTimeout || this.toy.compilationManager.pendingCompile)),
            };
            if (pl.violations.length) out.control_rate.violations = pl.violations.map(v => v.message);
        }
        return out;
    };

    // connect / build_graph: rate rules with an explanation
    const baseConnect = P._connect;
    P._connect = function (fromNode, fromOutputRef, toNode, toInputRef, accessorRef) {
        let outIdx, inIdx;
        try {
            outIdx = this._resolvePort(fromNode, fromOutputRef, 'output');
            inIdx = this._resolvePort(toNode, toInputRef, 'input');
        } catch (e) {
            return baseConnect.call(this, fromNode, fromOutputRef, toNode, toInputRef, accessorRef);
        }
        const outType = this._outputType(fromNode, outIdx);
        const inType = toNode.inputs[inIdx] && toNode.inputs[inIdx].type;
        const CONTROL_ONLY = ControlMathModule.CONTROL_ONLY_TYPES;
        const label = `Cannot connect ${fromNode.type} #${fromNode.id}.${this._outputLabel(fromNode, outIdx)} -> ${toNode.type} #${toNode.id}.${this._inputLabel(toNode, inIdx)}`;
        if ((CONTROL_ONLY.has(outType) || CONTROL_ONLY.has(inType)) && inType !== 'any' && outType !== inType) {
            const okEvent = (outType === 'event' && ['float', 'int', 'bool', 'vec2', 'vec3', 'vec4'].includes(inType)) ||
                (inType === 'event' && ['float', 'int', 'bool'].includes(outType));
            if (!okEvent) {
                throw new AutomationError(`${label}: a ${outType} output cannot drive a ${inType} input (event / string / list values are control-only: use Text Texture / List Texture to reach GLSL, Counter / Toggle / Envelope Follower to turn events into values)`, {
                    outputs: this._portList(fromNode, 'output'), inputs: this._portList(toNode, 'input')
                });
            }
        }
        const accessor = this._normalizeAccessor(accessorRef);
        const err = R.connectionRateError(this.graph, fromNode, outIdx, toNode, inIdx, accessor);
        if (err) {
            const e = new AutomationError(`Cannot connect ${err.message}`, { outputs: this._portList(fromNode, 'output'), inputs: this._portList(toNode, 'input') });
            e.retryable = false;
            throw e;
        }
        return baseConnect.call(this, fromNode, fromOutputRef, toNode, toInputRef, accessorRef);
    };

    // A Delay node's input may close a control loop (its output is from an earlier frame)
    P._wouldCreateCycle = function (fromNode, toNode) {
        if (fromNode === toNode) return true;
        if (toNode.isFeedbackNode || (toNode.definition && toNode.definition.delayed)) return false;
        const seen = new Set();
        const stack = [fromNode];
        while (stack.length) {
            const cur = stack.pop();
            if (cur === toNode) return true;
            if (seen.has(cur)) continue;
            seen.add(cur);
            if (cur.isFeedbackNode) continue; // feedback breaks cycles by design
            const d = cur.definition;
            for (const c of this.graph.connections) {
                if (c.toNode !== cur) continue;
                if (d && d.delayed && cur.inputs[c.toInput] && cur.inputs[c.toInput].name === d.delayed) continue;
                stack.push(c.fromNode);
            }
        }
        return false;
    };

    // render_preview: evaluate the control graph at the pinned time / beat
    const baseRenderShader = P._renderShader;
    P._renderShader = function (shader, width, height, time, mouse) {
        const rt = ControlRuntimeModule.controlRuntime;
        const pl = plan(this);
        if (!rt || !pl || !pl.uniformNodes.size) return baseRenderShader.call(this, shader, width, height, time, mouse);
        const { clock } = this._audio();
        const pin = this._ptRenderBeat || {};
        return clock.withOverride({ time: Number(time) || 0, beat: pin.beat, bpm: pin.bpm }, () => {
            try { rt.evaluateScratch(this.toy); } catch (e) { /* render with the live values */ }
            try {
                return baseRenderShader.call(this, shader, width, height, time, mouse);
            } finally {
                try { rt.restoreLive(this.toy); } catch (e) { /* ignore */ }
            }
        });
    };

    // list_node_types: rates
    const baseDescribeType = P.describeNodeType;
    P.describeNodeType = function (name) {
        const d = baseDescribeType.call(this, name);
        const def = DefinitionsModule.NodeDefinitions[name];
        if (d && def) {
            if (def.rate === 'control') d.rate = 'control';
            else if (typeof def.evaluate === 'function') d.rate = 'inferred';
            else if (def.isParamNode || def.isJSNode || def.isKeyboardNode || def.isXYPadNode || def.isMidiNoteNode || def.isMidiCCNode || def.isMicrophoneNode) d.rate = 'control source';
            if (def.options) d.options = Object.fromEntries(def.options.map(o => [o.key, o.values]));
        }
        return d;
    };

    const baseTypeNotes = P._typeNotes;
    P._typeNotes = function (name, def) {
        const notes = baseTypeNotes.call(this, name, def);
        if (!def) return notes;
        if (def.rate === 'control') {
            notes.push('Control rate: runs once per frame in JavaScript before rendering (can keep state), outputs reach shaders as live uniforms (no recompile). Its inputs are control-only: pixel (GPU) values are rejected (use a Sample node to read one back). event outputs are one-frame pulses (draw as diamonds with a bolt); string / list outputs never reach GLSL directly (Text Texture / List Texture).');
            if (def.options) notes.push(`Options (data fields, cycled by clicking the pill on the node): ${def.options.map(o => `${o.key} = ${o.values.join(' | ')}`).join('; ')}.`);
            if (def.delayed) notes.push(`'${def.delayed}' is read one frame late, so a Delay may close a control loop (other control loops are rejected).`);
        } else if (typeof def.evaluate === 'function') {
            notes.push(`Rate inferred: if every connected input is a control-rate value (Param, LFO, Beat, Audio, JS...) or a constant, this node runs at control rate in JS (outputs become uniforms, diamonds on the node; get_project shows rate / control.values)${def.cpuSource ? ' - it reads the CPU clock / audio engine, so it is control rate even with nothing connected' : ''}; any pixel input (UV, noise...) makes it compile to GLSL as usual.`);
        } else if (def.isParamNode || def.isJSNode || def.isKeyboardNode || def.isXYPadNode || def.isMidiNoteNode || def.isMidiCCNode || def.isMicrophoneNode) {
            notes.push('Control-rate source: its outputs (except textures) are CPU values, valid for control inputs (LFO, Counter, SceneSwitcher scene / next...) and live uniforms in shaders.');
        }
        if (def.isJSNode) {
            notes.push('Control inputs: declare them in data.code with lines "// @input speed float = 1" (types float int bool vec2 vec3 vec4 event string list); each becomes a control-rate input port, readable as inputs.speed or the plain variable speed. Upstream control nodes run first in the same frame. Outputs may also be strings, list(array) (or 5+ numbers) and event(fired), which stay control-only.');
        }
        return notes;
    };
}
// ====================== end of control rate block ======================

// ======================================================================
// Deterministic warm-up for render_preview (visual regression tests,
// tests/visual): render_preview {warmup: N, warmup_fps?, seed?} resets the
// simulation state (Feedback buffers cleared, control-rate node state, JS node
// state + setup re-run, Math.random seeded) and steps N frames at a fixed
// timestep (clock manual mode + app.tickFrame, like the offline exporter),
// ending at the render time, so recursive Feedback simulations and JS nodes
// render reproducibly. Without warmup nothing changes.
// Self-contained block extending AutomationAPI.prototype.
// ======================================================================
import * as WarmupJSRuntimeModule from '../nodes/jsRuntime.js';

{
    const P = AutomationAPI.prototype;
    const baseRenderPreview = P.renderPreview;
    const WARMUP_KEYS = ['warmup', 'warmup_fps', 'seed', 'date'];
    const SWITCHER_FIELDS = ['_pending', '_lastSceneInput', '_lastNextInput', '_lastBar', '_sinceSwitch', '_lastTime'];
    const has = v => v !== undefined && v !== null && v !== '';
    const seeded = (seed) => {
        let a = (Number(seed) >>> 0) || 1;
        return () => {
            a = (a + 0x6D2B79F5) | 0;
            let t = Math.imul(a ^ (a >>> 15), 1 | a);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    };

    P._ptClearFeedback = function () {
        const gl = this.gl;
        if (!gl) return;
        for (const n of this.graph.nodes) {
            if (!n.isFeedbackNode) continue;
            for (const b of [n.readBuffer, n.writeBuffer]) {
                if (!b || !b.framebuffer) continue;
                gl.bindFramebuffer(gl.FRAMEBUFFER, b.framebuffer);
                gl.viewport(0, 0, n.bufferWidth || 1, n.bufferHeight || 1);
                gl.clearColor(0, 0, 0, 0);
                gl.clear(gl.COLOR_BUFFER_BIT);
            }
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    };

    P._ptResetSimulation = function ({ js = true } = {}) {
        this._ptClearFeedback();
        const ctl = ControlRuntimeModule.controlRuntime;
        try { ctl?.resetState?.(this.graph); } catch (e) { /* ignore */ }
        if (ctl) ctl.lastTime = null;
        const jr = WarmupJSRuntimeModule.jsRuntime;
        if (jr) jr.lastTime = null;
        if (js) {
            for (const n of this.graph.nodes) {
                if (!n.isJSNode) continue;
                n._setupFor = undefined; // next frame: state = {} and setup runs again
                n._setupToken = null;
            }
        }
        // Audio textures: auto-gain, peak caps, spectrogram history (same as the offline exporter)
        try { AudioTexturesModule.audioTextures?.reset?.(); } catch (e) { /* ignore */ }
    };

    P.renderPreview = function (params = {}) {
        const frames = Math.floor(Number(params && params.warmup) || 0);
        if (!(frames > 0)) {
            const rest = { ...(params || {}) };
            for (const k of WARMUP_KEYS) delete rest[k];
            return baseRenderPreview.call(this, rest);
        }
        return this._ptWarmupRender(params);
    };

    P._ptWarmupRender = async function ({ warmup, warmup_fps, seed = 1, date, ...rest }) {
        if (typeof this.toy.tickFrame !== 'function') throw new AutomationError('warmup needs app.tickFrame (main.js)');
        const { clock } = this._audio();
        const SP = ShaderPreviewModule.ShaderPreview;
        const fps = Math.max(1, Math.min(240, Number(warmup_fps) || 60));
        const dt = 1 / fps;
        let bpm = has(rest.bpm) ? Number(rest.bpm) : (clock.mode === 'metronome' ? clock.metroBpm : (clock.u.bpm || 120));
        if (!(bpm > 0)) throw new AutomationError('bpm must be > 0');
        // Render time: same rules as render_preview (time, else the pinned beat, else 1.0)
        let T;
        if (has(rest.time)) T = Number(rest.time);
        else if (has(rest.beat_phase)) T = (Math.floor(has(rest.beat) ? Number(rest.beat) : 0) + Number(rest.beat_phase) % 1) * 60 / bpm;
        else if (has(rest.beat)) T = Number(rest.beat) * 60 / bpm;
        else T = 1.0;
        if (!Number.isFinite(T)) throw new AutomationError('time / beat must be numbers');
        let frames = Math.min(1200, Math.floor(warmup));
        const start = Math.max(0, T - frames * dt);
        frames = Math.round((T - start) / dt);

        // SceneSwitcher: a pinned scene (without a transition) also drives the warm-up frames
        let pinSw = null, pin = null;
        if (has(rest.scene) && !has(rest.scene_from) && !has(rest.progress) && typeof this._resolveSwitcher === 'function') {
            pinSw = this._resolveSwitcher(rest.scene_node);
            const idx = this._sceneRef(pinSw, rest.scene);
            pin = { a: idx, b: idx, p: 0, style: 'cut' };
        }

        const saved = { time: clock.time, beatPos: clock.beatPos, frame: clock.frame, periodMs: clock.periodMs, random: Math.random, mouse: [SP.mouseX, SP.mouseY], Date: globalThis.Date };
        // SceneSwitchers: start settled on data.current (auto mode / transitions replay identically),
        // and get their live runtime state back afterwards
        const switchers = this.graph.nodes.filter(n => n.isSceneSwitcher).map(sw => {
            const snap = { sw, current: sw.data.current, state: { ...sw.state } };
            for (const k of SWITCHER_FIELDS) snap[k] = sw[k];
            return snap;
        });
        // date: JS code reading Date / Date.now() sees this wall-clock time (+ the simulated time)
        let dateBase = null;
        if (has(date)) {
            dateBase = typeof date === 'number' ? date : saved.Date.parse(String(date));
            if (!Number.isFinite(dateBase)) throw new AutomationError('date must be an ISO date string or epoch milliseconds');
        }
        const restart = () => {
            clock.setTime(start);
            clock.beatPos = start * bpm / 60;
            clock.periodMs = 60000 / bpm;
            clock.frame = 0;
            Math.random = seeded(seed);
        };
        const js = this.graph.nodes.filter(n => n.isJSNode);
        const info = { frames, fps, start_time: +start.toFixed(4), seed: Number(seed) };
        clock.setManual(true, { owner: 'render-warmup' });
        try {
            this._compileApp();
            if (Array.isArray(rest.mouse) && rest.mouse.length === 2) { SP.mouseX = rest.mouse[0]; SP.mouseY = rest.mouse[1]; }
            if (pinSw) { pinSw.pin = pin; pinSw.pushUniforms?.(true); }
            for (const { sw, current } of switchers) {
                sw.state = { ...sw.state, a: current, b: current, p: 0, active: false };
                sw._pending = null; sw._lastSceneInput = undefined; sw._lastNextInput = undefined;
                sw._lastBar = undefined; sw._sinceSwitch = 0; sw._lastTime = null;
            }
            if (dateBase !== null) {
                const RealDate = saved.Date;
                const nowMs = () => dateBase + Math.round((clock.time - start) * 1000);
                const FakeDate = class Date extends RealDate {
                    constructor(...a) { if (a.length) super(...a); else super(nowMs()); }
                    static now() { return nowMs(); }
                };
                globalThis.Date = FakeDate;
                info.date = new RealDate(dateBase).toISOString();
            }
            this._ptResetSimulation();
            restart();
            // JS setup is async: tick at the start time until every trusted JS node has settled
            if (js.length) {
                const t0 = performance.now();
                for (let i = 0; i < 1000; i++) {
                    clock.step(0);
                    this.toy.tickFrame();
                    if (!js.some(n => n.trust === 'trusted' && !['ready', 'error'].includes(n.setupState))) break;
                    if (performance.now() - t0 > 15000) break;
                    await new Promise(r => setTimeout(r, 2));
                }
                info.js_setup_ms = Math.round(performance.now() - t0);
                info.js_pending = js.filter(n => n.trust === 'trusted' && !['ready', 'error'].includes(n.setupState)).map(n => n.id);
                info.js_untrusted = js.filter(n => n.trust !== 'trusted').map(n => n.id);
                // Fresh start after the priming frames (JS state from setup is kept)
                this._ptResetSimulation({ js: false });
                restart();
            }
            for (let i = 0; i < frames; i++) {
                clock.step(dt);
                this.toy.tickFrame();
            }
            if (pinSw) { pinSw.pin = null; pinSw.pushUniforms?.(true); }
            const next = { ...rest, time: T, bpm };
            delete next.beat;
            delete next.beat_phase;
            const out = await baseRenderPreview.call(this, next);
            if (out && typeof out === 'object') out.warmup = info;
            return out;
        } finally {
            if (pinSw && pinSw.pin === pin) { pinSw.pin = null; try { pinSw.pushUniforms?.(true); } catch (e) { /* ignore */ } }
            Math.random = saved.random;
            globalThis.Date = saved.Date;
            for (const snap of switchers) {
                const { sw } = snap;
                sw.data.current = snap.current;
                sw.state = snap.state;
                for (const k of SWITCHER_FIELDS) sw[k] = snap[k];
                try { sw.pushUniforms?.(true); } catch (e) { /* ignore */ }
            }
            SP.mouseX = saved.mouse[0];
            SP.mouseY = saved.mouse[1];
            clock.setTime(saved.time);
            clock.beatPos = saved.beatPos;
            clock.periodMs = saved.periodMs;
            clock.frame = saved.frame + frames;
            clock.lastNow = -1;
            clock.setManual(false, { owner: 'render-warmup' });
        }
    };
}
// ====================== end of render warm-up block ======================

// ======================================================================
// MIDI mappings: midi_map, midi_unmap, simulate_midi, mappings in
// list_params / list_scenes, Param data.midi (src/automation/midiAutomation.js)
// ======================================================================
import { installMidiAutomation } from './midiAutomation.js';
installMidiAutomation(AutomationAPI, AutomationError);
// ====================== end of MIDI mappings block ======================

// ======================================================================
// I/O bridge (src/io, mcp/lib/io-bridge.mjs): the io_bridge tool (status,
// pairing / opt-in / allowlist of auto-launched headless pages, serial port
// list), I/O node status in get_project, list_node_types notes.
// Self-contained block extending AutomationAPI.prototype.
// Security: the user's own tab is never configured remotely (pairing, opt-in,
// allowlist and serial ports are the user's decisions in Output > I/O); only
// headless pages launched by the MCP server (no user) accept them.
// ======================================================================
import * as IOClientModule from '../io/IOClient.js';
import * as MIDIOutputModule from '../io/MIDIOutput.js';

AutomationAPI.METHODS.push('ioBridge');
{
    const P = AutomationAPI.prototype;
    const ioNodes = (api) => api.graph.nodes.filter(n => n.definition && n.definition.isIONode);
    const nodeIO = (n) => {
        const st = n._io || { state: 'off', text: 'not evaluated yet' };
        const out = { state: st.state, status: st.text };
        const S = n._ctlState || {};
        if (S.count !== undefined) out.messages = S.count;
        if (S.lastAt) out.last_message_age_s = +((Date.now() - S.lastAt) / 1000).toFixed(2);
        return out;
    };

    P.ioBridge = async function ({ action = 'status', token, port, opt_in, allow, serial, lan, wait_ms = 4000 } = {}) {
        const io = IOClientModule.ioClient;
        if (!io) throw new AutomationError('I/O client unavailable');
        const configuring = action === 'configure' || action === 'unpair';
        if (configuring && !this.headless) {
            throw new AutomationError("Refusing to change I/O pairing / permission / allowlist in the user's own tab: ask the user to open Output > I/O (paste the token printed by `npm run io-bridge`, enable I/O for the session, allow the destinations). Use a headless client (select_client mode 'headless') for automated I/O tests.", { status: io.describe() });
        }
        if (action === 'unpair') io.unpair();
        else if (action === 'configure') {
            io.configure({ token, port, opt_in, allow, serial, lan });
            const t0 = Date.now();
            while (io.token && !['connected', 'auth-failed'].includes(io.status) && Date.now() - t0 < Math.max(0, Math.min(15000, wait_ms))) {
                await new Promise(r => setTimeout(r, 100));
            }
            // Let the config round-trip so the bridge has the allowlist before the next frame sends
            if (io.connected) await new Promise(r => setTimeout(r, 150));
        } else if (action === 'list_serial') {
            await io.listSerialPorts();
        } else if (action !== 'status') {
            throw new AutomationError(`Unknown io_bridge action "${action}" (status | configure | unpair | list_serial)`);
        }
        const out = io.describe();
        out.link = io.linkState();
        if (action === 'list_serial') out.serial_ports = io.serialList;
        const midi = MIDIOutputModule.midiOutput;
        if (midi) out.midi = midi.describe();
        out.nodes = ioNodes(this).map(n => ({ id: n.id, type: n.type, ...nodeIO(n) }));
        return out;
    };

    // get_project: per-node I/O status + a summary
    const baseDescribe = P.describeNode;
    P.describeNode = function (node) {
        const d = baseDescribe.call(this, node);
        if (node && node.definition && node.definition.isIONode) d.io = nodeIO(node);
        return d;
    };
    const baseGetGraph = P.getGraph;
    P.getGraph = function (...args) {
        const out = baseGetGraph.apply(this, args);
        const nodes = ioNodes(this);
        if (out && nodes.length) {
            const io = IOClientModule.ioClient;
            out.io = { bridge: io ? io.linkState() : null, opt_in: io ? io.optIn : false, nodes: nodes.length, active: nodes.filter(n => n._io && n._io.state === 'ok').length };
        }
        return out;
    };

    // list_node_types: notes
    const baseTypeNotes = P._typeNotes;
    P._typeNotes = function (name, def) {
        const notes = baseTypeNotes.call(this, name, def);
        if (def && def.isIONode) {
            notes.push(name === 'MIDIOutCC' || name === 'MIDIOutNote'
                ? 'I/O node: Web MIDI output in the browser (no bridge). Needs the per-session I/O opt-in (Output > I/O) and a MIDI output (IAC Driver / loopMIDI / hardware); headless browsers have none.'
                : 'I/O node: talks to other apps / hardware through the local I/O bridge (npm run io-bridge, 127.0.0.1 only, token-paired). Nothing is sent or opened until the user enables I/O for the session in Output > I/O; destinations (host:port) and serial ports must be on the user\'s allowlist there (never stored in the project). get_project shows io {state ok | wait | error | off, status} per node; io_bridge reports the bridge state.');
            notes.push('Text fields (address, host, port, baud, device) are strings in node.data; outputs hold their last values and nothing is sent during render_preview.');
        }
        return notes;
    };
}
// ====================== end of I/O bridge block ======================

// ====================== Undo / redo (src/core/History.js) ======================
// The user's undo history, also for the agent: undo / redo steps (MCP edits are steps too,
// one per command) and the list of step labels.
AutomationAPI.METHODS.push('undo', 'redo', 'getHistory');
{
    const P = AutomationAPI.prototype;
    P._history = function () {
        const h = this.toy.history;
        if (!h) throw new AutomationError('Undo history is not available in this app build');
        return h;
    };
    const run = function (dir, { steps = 1 } = {}) {
        const h = this._history();
        const n = Math.max(1, Math.min(100, Math.round(Number(steps) || 1)));
        const done = [];
        for (let i = 0; i < n; i++) {
            const label = dir === 'undo' ? h.undo({ toast: i === n - 1 }) : h.redo({ toast: i === n - 1 });
            if (!label) break;
            done.push(label);
        }
        if (done.length) this.activity(`${dir === 'undo' ? 'undid' : 'redid'} ${done.length === 1 ? `"${done[0]}"` : `${done.length} steps`}`);
        const list = h.list();
        return {
            [dir === 'undo' ? 'undone' : 'redone']: done,
            nothing_to_do: done.length === 0,
            next_undo: list.undo[0] || null,
            next_redo: list.redo[0] || null,
            nodes: this.graph.nodes.length,
            connections: this.graph.connections.length,
        };
    };
    P.undo = function (params) { return run.call(this, 'undo', params); };
    P.redo = function (params) { return run.call(this, 'redo', params); };
    P.getHistory = function ({ limit = 30 } = {}) {
        const list = this._history().list();
        const n = Math.max(1, Math.min(100, Number(limit) || 30));
        return { ...list, undo: list.undo.slice(0, n), redo: list.redo.slice(0, n), undo_count: list.undo.length, redo_count: list.redo.length };
    };
}
// ====================== end of undo block ======================

// ======================================================================
// render_preview at full quality: Feedback nodes with data.autoScale keep their full
// data.width x height buffers for the warm-up and the render, like recordings and offline
// exports (QualityGovernor.holdFullQuality), so a render never depends on what the live
// editor happens to show (a small thumbnail, a governed background) and the visual
// goldens of auto-scaled projects stay reproducible.
// Self-contained block extending AutomationAPI.prototype.
// ======================================================================
import { quality as RenderPreviewQuality } from '../rendering/QualityGovernor.js';

{
    const P = AutomationAPI.prototype;
    const baseRenderPreview = P.renderPreview;
    P.renderPreview = function (params = {}) {
        const fbs = this.graph.nodes.filter(n => n.isFeedbackNode && n.data && n.data.autoScale);
        if (!fbs.length) return baseRenderPreview.call(this, params);
        const owner = Symbol('render-preview');
        RenderPreviewQuality.holdFullQuality(owner, true);
        const release = () => RenderPreviewQuality.holdFullQuality(owner, false);
        let res;
        try {
            // No warm-up steps the passes: bring scaled buffers to full size now (twice: a
            // Feedback reading another one sees it at full size too)
            const warm = Math.floor(Number(params && params.warmup) || 0) > 0;
            const fr = this.toy.feedbackRenderer;
            if (!warm && fr && fbs.some(n => (n._autoScale || 1) < 1)) {
                try { fr.renderFeedbackNodes(); fr.renderFeedbackNodes(); } catch (e) { /* render with the current buffers */ }
            }
            res = baseRenderPreview.call(this, params);
        } catch (e) {
            release();
            throw e;
        }
        if (res && typeof res.then === 'function') return res.finally(release);
        release();
        return res;
    };
}
// ====================== end of render_preview full-quality block ======================

// ======================================================================
// Render 3D (src/render3d/automation.js): list_node_types notes, get_project
// render stats, render_preview size, compile reports, item ports, load_model.
// ======================================================================
import { installRender3DAutomation } from '../render3d/automation.js';
installRender3DAutomation(AutomationAPI, AutomationError);
// ====================== end of Render 3D block ======================

// ======================================================================
// Group box port names (NodeGroups portLabels): rename_group_port, and port keys /
// custom labels in list_groups / get_project / group_nodes group info.
// Self-contained block extending AutomationAPI.prototype.
// ======================================================================
AutomationAPI.METHODS.push('renameGroupPort');
HISTORY_LABELS.renameGroupPort = 'Rename group port';

{
    const P = AutomationAPI.prototype;
    const baseDescribeGroup = P._describeGroup;
    P._describeGroup = function (grp) {
        const d = baseDescribeGroup.call(this, grp);
        const proxy = this.graph.groupCtl?.proxyFor(grp.id);
        if (proxy) {
            // Parallel to inputs / outputs: the stable key of each box port (rename_group_port)
            d.port_keys = { inputs: proxy.inPorts.map(p => p.key), outputs: proxy.outPorts.map(p => p.key) };
        }
        if (grp.portLabels && Object.keys(grp.portLabels).length) d.port_labels = { ...grp.portLabels };
        return d;
    };

    /**
     * Name group box ports. port: key ('s:12:0' / 'x:7:1' / 'o:15:0'), 'in:N' / 'out:N' (box
     * index), or the current / automatic label; label '' resets to the automatic name.
     * ports: {port: label, ...} for several at once.
     */
    P.renameGroupPort = function ({ group_id, port, label, ports } = {}) {
        const ctl = this._groupCtl();
        const grp = this._resolveGroup(group_id, 'group_id');
        const entries = [];
        if (ports && typeof ports === 'object' && !Array.isArray(ports)) for (const [k, v] of Object.entries(ports)) entries.push([k, v]);
        if (port !== undefined && port !== null && port !== '') entries.push([String(port), label]);
        if (!entries.length) throw new AutomationError('rename_group_port needs port + label, or ports: {port: label}');
        const list = ctl.groupPorts(grp.id);
        const describe = () => list.map(p => `${p.kind}:${p.index} ${p.key} "${p.label}"${p.custom ? ` (auto "${p.auto}")` : ''}`);
        const resolve = (ref) => {
            const byKey = list.find(p => p.key === ref);
            if (byKey) return byKey;
            const m = /^(in|out)[:.\s#]?(\d+)$/i.exec(ref.trim());
            if (m) {
                const kind = m[1].toLowerCase();
                const hit = list.find(p => p.kind === kind && p.index === parseInt(m[2], 10));
                if (hit) return hit;
            }
            const matches = list.filter(p => norm(p.label) === norm(ref) || norm(p.auto) === norm(ref));
            if (matches.length === 1) return matches[0];
            throw new AutomationError(matches.length ? `Several ports of "${grp.name}" match "${ref}" - use the key` : `Group "${grp.name}" has no port "${ref}"`, { ports: describe() });
        };
        const plan = entries.map(([ref, v]) => {
            if (v !== null && v !== undefined && typeof v !== 'string') throw new AutomationError(`Label for port "${ref}" must be a string ('' resets it)`);
            return { port: resolve(String(ref)), label: v == null ? '' : v };
        });
        const renamed = [];
        for (const { port: p, label: l } of plan) {
            const text = String(l).trim();
            const changed = ctl.setPortLabel(grp.id, p.key, text === p.auto ? '' : text);
            renamed.push({ key: p.key, kind: p.kind, previous: p.label, label: text && text !== p.auto ? text.replace(/\s+/g, ' ').slice(0, 60) : p.auto, custom: !!text && text !== p.auto, changed });
        }
        this._groupsChanged();
        const n = renamed.filter(r => r.changed).length;
        if (n) this.activity(`renamed ${n} port${n === 1 ? '' : 's'} of "${grp.name}"`);
        return { group: this._describeGroup(grp), renamed };
    };
}
// ====================== end of group port names block ======================
