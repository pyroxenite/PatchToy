import { UIHelpers, escapeHtml } from '../ui/UIHelpers.js';
import { icon } from '../ui/icons.js';
import { ProbeRenderer } from '../rendering/ProbeRenderer.js';
import { renderLoop } from '../rendering/RenderLoop.js';

export class CompilationManager {
    constructor(nodeGraph, shaderCompiler, shaderPreview, backgroundRenderer = null, feedbackRenderer = null) {
        this.nodeGraph = nodeGraph;
        this.shaderCompiler = shaderCompiler;
        this.shaderPreview = shaderPreview;
        this.backgroundRenderer = backgroundRenderer;
        this.feedbackRenderer = feedbackRenderer;
        this.autoCompile = true;
        this.compileTimeout = null;
        // Link edited shaders without waiting (see scheduleCompile); opt-in:
        // localStorage patchtoy_async_compile = '1'
        try { this.asyncLink = localStorage.getItem('patchtoy_async_compile') === '1'; } catch (e) { this.asyncLink = false; }

        // Last compile result (also broadcast as the 'patchtoy:compile' window event)
        this.lastErrors = [];
        this.lastCompileOk = true;
        this.lastCompileMs = null;

        // Error console UI state
        this.consoleDismissedKey = null; // error signature the user closed
        this.consoleCollapsed = false;
        this.errorPreviewNode = null;

        // Debug / probe nodes (Value Display, Plot, ...): compiled after the previews,
        // rendered + read back by renderProbes() once per frame (main loop)
        this.probes = null;
        try {
            this.probes = new ProbeRenderer({ graph: nodeGraph, compiler: shaderCompiler, feedbackRenderer, manager: this });
        } catch (e) {
            console.warn('[probes] disabled:', e);
        }
    }

    /** Per-frame probe readback (called by the main loop after the Feedback passes). */
    renderProbes() {
        if (!this.probes) return;
        try {
            this.probes.tick();
        } catch (e) {
            if (!this._probeTickWarned) {
                this._probeTickWarned = true;
                console.warn('[probes] tick failed:', e);
            }
        }
    }

    scheduleCompile() {
        if (!this.autoCompile) return;

        // Debounce compilation
        if (this.compileTimeout) {
            clearTimeout(this.compileTimeout);
        }

        this.compileTimeout = setTimeout(() => {
            this.compileTimeout = null;
            // async: skip the compile when the graph signature didn't change; with
            // asyncLink, new programs link in the background (KHR_parallel_shader_compile)
            // while the previous ones keep rendering. Off by default: on ANGLE / Metal it
            // measured worse (the link + pipeline creation still lands in one frame, later)
            this.compile({ async: true });
        }, 100); // 100ms debounce
    }

    /**
     * Compile every Preview (and the Feedback passes / probes). Programs come from the GL
     * program cache: a source linked before (unchanged shader, undo, another preview showing
     * the same thing) costs nothing. All new programs are handed to the driver first, so
     * they link in parallel.
     *   async = false: returns when everything is linked (automation, explicit compiles).
     *   async = true:  returns right away when something still links; the previews keep
     *                  their previous programs ("Compiling..." in the status bar) and switch
     *                  together once all links finished (finishPendingCompile, every frame).
     */
    compile({ async = false } = {}) {
        // Scheduled compiles (graph-change events) skip graphs whose compile-relevant state
        // is exactly what the last successful compile saw: moves, calibration saves,
        // history captures... (explicit compiles always run)
        let sig = null;
        try { sig = this.graphSignature(); } catch (e) { sig = null; }
        if (async && sig !== null && sig === this._lastSig && !this.pendingCompile) {
            this.skippedCompiles = (this.skippedCompiles || 0) + 1;
            return this.lastCompileOk;
        }
        this._compileSig = sig;
        // An explicit compile also supersedes a debounced one that hasn't started yet
        // (it would compile the same graph again, e.g. right after build_graph)
        if (!async && this.compileTimeout) {
            clearTimeout(this.compileTimeout);
            this.compileTimeout = null;
        }
        // A newer compile supersedes one still linking
        this._compileGen = (this._compileGen || 0) + 1;
        this.pendingCompile = null;

        // Clear all error states
        for (const node of this.nodeGraph.nodes) {
            node.hasError = false;
        }

        // Rebuild the (deterministic) node id mapping every time: a project load
        // replaces all nodes without a graph-change event, leaving a stale mapping.
        this.createGlobalNodeIdMapping();

        // Feedback shaders share the mapping; compile them too (no-op without Feedback nodes).
        // Scheduled compiles link changed passes in the background (previous programs keep
        // rendering): a graph edit never waits for a Feedback link
        if (this.feedbackRenderer) {
            this.feedbackRenderer.compileFeedbackShaders({ async });
        }
        // Render 3D nodes: their own vertex / fragment programs (src/render3d)
        if (this.render3d) {
            try { this.render3d.compileAll(); } catch (e) { console.warn('[render3d] compile failed', e); }
        }

        // Just compile preview nodes - no main output anymore
        const t0 = performance.now();
        const items = this.startPreviewCompile();
        const pending = items.filter(it => it.result === 'pending');
        const waitPreviews = !!(pending.length && this.asyncLink && !this._noAsync);
        const feedbackLinking = async && !!this.feedbackRenderer && this.feedbackRenderer.hasPendingLinks();
        if (async && (waitPreviews || feedbackLinking)) {
            this.pendingCompile = { gen: this._compileGen, items, t0, since: performance.now(), waitPreviews };
            this.ensurePendingPoll();
            try {
                window.dispatchEvent(new CustomEvent('patchtoy:compiling', { detail: { pending: pending.length } }));
            } catch (e) { /* ignore */ }
            return 'pending';
        }
        this.finishCompile(items, t0);
        return this.lastCompileOk;
    }

    /** Poll the pending compile once per frame (RenderLoop hook). */
    ensurePendingPoll() {
        if (this._pollHooked) return;
        this._pollHooked = true;
        renderLoop.onFrame(() => this.finishPendingCompile());
    }

    /**
     * Finish an async compile once every link is done (never blocks; force: block now).
     * Returns true when there is nothing pending any more.
     */
    finishPendingCompile(force = false) {
        const pc = this.pendingCompile;
        if (!pc) return true;
        if (pc.gen !== this._compileGen) { this.pendingCompile = null; return true; }
        // Safety net: a link the driver never reports complete
        if (!force && performance.now() - pc.since > 10000) force = true;
        if (!force) {
            if (this.feedbackRenderer && !this.feedbackRenderer.pendingLinksDone()) return false;
            // (without asyncLink the previews are switched, blocking if needed, in finishCompile)
            if (pc.waitPreviews) {
                for (const it of pc.items) {
                    const pi = it.previewNode.previewInstance;
                    if (it.result === 'pending' && pi && !pi.pendingComplete()) return false;
                }
            }
        }
        this.pendingCompile = null;
        this.finishCompile(pc.items, pc.t0);
        return true;
    }

    /**
     * Everything a compile depends on: node ids / types / data / ports, definitions (custom
     * GLSL nodes are redefined as new objects), cables. Conservative: any data change
     * (even one that only becomes a uniform) still recompiles.
     */
    graphSignature() {
        const defIds = this._defIds || (this._defIds = new WeakMap());
        let nextDef = this._nextDefId || 1;
        const parts = [];
        for (const n of this.nodeGraph.nodes) {
            const def = n.definition || null;
            let did = 0;
            if (def && typeof def === 'object') {
                did = defIds.get(def);
                if (!did) { did = nextDef++; defIds.set(def, did); }
            }
            let ports = '';
            for (const p of n.inputs || []) ports += `${p.name}:${p.type},`;
            ports += '|';
            for (const p of n.outputs || []) ports += `${p.name}:${p.type},`;
            // The node object itself counts (a reloaded project has new nodes with fresh renderers)
            let oid = defIds.get(n);
            if (!oid) { oid = nextDef++; defIds.set(n, oid); }
            // A constant being scrubbed compiles as a uniform: its value is not part of the source
            const data = n.liveUniform ? 'live' : JSON.stringify(n.data || null);
            parts.push(`${n.id}#${oid}/${n.type}/${did}/${ports}/${data}`);
        }
        this._nextDefId = nextDef;
        for (const c of this.nodeGraph.connections) {
            parts.push(`${c.fromNode && c.fromNode.id}.${c.fromOutput}>${c.toNode && c.toNode.id}.${c.toInput}${c.accessor || c.swizzle || ''}`);
        }
        return parts.join('\n');
    }

    finishCompile(items, t0) {
        // Feedback passes that linked in the background (async compile)
        if (this.feedbackRenderer) this.feedbackRenderer.applyPendingLinks();
        // Switch the previews whose program linked in parallel
        for (const it of items) {
            if (it.result !== 'pending') continue;
            const pi = it.previewNode.previewInstance;
            it.result = pi && pi.applyPending ? pi.applyPending() : false;
        }
        this.finishPreviewCompile(items);
        // Generic ('any') outputs typed by this compile: group boxes show their ports' types
        // from a cached view, rebuild it (and redraw: port colors / shapes changed)
        const typed = this.shaderCompiler.outputTypeChanges || 0;
        if (typed !== this._outputTypeChanges) {
            this._outputTypeChanges = typed;
            if (this.nodeGraph.groupCtl) this.nodeGraph.groupCtl.invalidate();
            if (this.nodeGraph.render) this.nodeGraph.render();
        }
        this._lastSig = this._compileSig;
        this.lastCompileMs = performance.now() - t0;
        // Probes never affect the previews: compiled last, failures stay on the probe nodes
        if (this.probes && (this.probes.entries.size || this.nodeGraph.nodes.some(n => n.isProbeNode))) {
            try {
                this.probes.compile();
            } catch (e) {
                console.warn('[probes] compile failed:', e);
            }
        }
        this.emitCompileStatus();
    }

    emitCompileStatus() {
        const previews = this.nodeGraph.nodes.filter(n =>
            n.isPreviewNode && this.nodeGraph.connections.some(c => c.toNode === n)
        ).length;
        try {
            window.dispatchEvent(new CustomEvent('patchtoy:compile', {
                detail: {
                    ok: this.lastCompileOk,
                    errors: this.lastErrors.slice(),
                    errorCount: this.countErrors(this.lastErrors),
                    ms: this.lastCompileMs,
                    previews,
                    compiling: false
                }
            }));
        } catch (e) { /* ignore */ }
    }

    createGlobalNodeIdMapping() {
        // Collect all unique node IDs and sort them
        const nodeIds = [...new Set(this.nodeGraph.nodes.map(n => n.id))].sort((a, b) => a - b);

        // Create mapping from old ID to new sequential ID
        this.globalNodeIdRemap = new Map();
        nodeIds.forEach((oldId, index) => {
            this.globalNodeIdRemap.set(oldId, index);
        });

        // Inject this mapping into the ShaderCompiler so it uses it instead of creating its own
        this.shaderCompiler.nodeIdRemap = this.globalNodeIdRemap;
    }

    /** Synchronous compile of every Preview (older callers). */
    compilePreviewNodes() {
        const items = this.startPreviewCompile();
        for (const it of items) {
            if (it.result === 'pending') it.result = it.previewNode.previewInstance.applyPending();
        }
        this.finishPreviewCompile(items);
    }

    /**
     * Generate every Preview's shader and hand new programs to the driver (no waiting).
     * Returns [{ previewNode, shader, result: true | false | 'pending' }].
     */
    startPreviewCompile() {
        const items = [];
        const previewNodes = this.nodeGraph.nodes.filter(n => n.isPreviewNode);
        for (const previewNode of previewNodes) {
            // Check if preview node has any input connections
            const hasConnection = this.nodeGraph.connections.some(
                conn => conn.toNode === previewNode
            );

            // If no connection, clear the shader to show TV static
            if (!hasConnection) {
                const pi = previewNode.previewInstance;
                if (pi) {
                    pi._cancelPending?.();
                    pi.program = null; // releases the shared program
                }
                continue;
            }

            // Temporarily treat this preview node as the output
            const shader = this.shaderCompiler.compileForPreviewNode(previewNode, this.nodeGraph);

            // Inject feedback textures if feedbackRenderer is available
            if (shader && this.feedbackRenderer && previewNode.previewInstance) {
                this.feedbackRenderer.injectFeedbackTextures(shader, previewNode.previewInstance.gl);
            }

            if (shader && previewNode.previewInstance) {
                // Store shader source for code inspection (even if compilation fails)
                previewNode.lastCompiledShader = shader;
                const result = previewNode.previewInstance.loadShader(shader, null, { async: true });
                // The compiler's line -> node map belongs to its last compile: keep this one's
                const sc = this.shaderCompiler;
                items.push({ previewNode, shader, result, lineMap: { start: sc.mainCodeStartLine, map: sc.codeToNodeMap } });
            }
        }
        return items;
    }

    /** Errors, background, uniform registry for a finished preview compile. */
    finishPreviewCompile(items) {
        let anyErrors = false;
        const collectedErrors = [];
        let firstErrorNode = null;

        const sc = this.shaderCompiler;
        const errorNodeIdFor = (errorString, lineMap) => {
            if (!lineMap) return sc.parseWebGLError(errorString);
            const keep = { start: sc.mainCodeStartLine, map: sc.codeToNodeMap };
            sc.mainCodeStartLine = lineMap.start;
            sc.codeToNodeMap = lineMap.map;
            try { return sc.parseWebGLError(errorString); } finally {
                sc.mainCodeStartLine = keep.start;
                sc.codeToNodeMap = keep.map;
            }
        };
        for (const { previewNode, shader, result, lineMap } of items) {
            {
                const success = result === true;

                // If this preview node is the background, update background renderer too
                if (success && this.backgroundRenderer && previewNode.isBackground) {
                    this.backgroundRenderer.updateShader(previewNode, shader);
                }

                // If shader compilation failed, try to find error node
                if (!success) {
                    anyErrors = true;

                    if (!firstErrorNode) firstErrorNode = previewNode;

                    // Check for WebGL errors
                    if (shader.webglErrors && shader.webglErrors.length > 0) {
                        const errorString = shader.webglErrors.join('\n');

                        // Collected and displayed once after all previews compiled
                        collectedErrors.push(errorString);

                        const errorNodeId = errorNodeIdFor(errorString, lineMap);
                        if (errorNodeId !== null) {
                            const errorNode = this.nodeGraph.nodes.find(n => n.id === errorNodeId);
                            if (errorNode) {
                                errorNode.hasError = true;
                            }
                        }
                    } else if (Array.isArray(shader.errors) && shader.errors.length > 0) {
                        // Graph-level errors reported by the ShaderCompiler (type mismatches etc.)
                        collectedErrors.push(...shader.errors.map(e => `ERROR: ${e}`));
                        if (shader.errorNodeId !== null && shader.errorNodeId !== undefined) {
                            const errorNode = this.nodeGraph.nodes.find(n => n.id === shader.errorNodeId);
                            if (errorNode) errorNode.hasError = true;
                        }
                    }
                    // Also mark the preview node itself
                    previewNode.hasError = true;
                    this.nodeGraph.render();
                }
            }
        }

        // Feedback passes are separate shaders (FeedbackRenderer.compileFeedbackShaders ran
        // in compile()); their errors would otherwise only reach the browser console.
        let feedbackFailed = false;
        for (const fb of this.nodeGraph.nodes) {
            if (!fb.isFeedbackNode || !Array.isArray(fb.feedbackErrors) || !fb.feedbackErrors.length) continue;
            feedbackFailed = true;
            anyErrors = true;
            if (!firstErrorNode) firstErrorNode = fb;
            fb.hasError = true;
            collectedErrors.push(...this.formatFeedbackErrors(fb));
        }
        if (feedbackFailed) this.nodeGraph.render();
        // Render 3D programs are separate shaders too (src/render3d)
        if (this.render3d) {
            const r3 = this.render3d.collectErrors();
            if (r3.length) {
                anyErrors = true;
                if (!firstErrorNode) firstErrorNode = this.nodeGraph.nodes.find(n => n.isRender3DNode && n.hasError) || null;
                collectedErrors.push(...r3);
                this.nodeGraph.render();
            }
        }

        // Show every error from this pass at once, or clear the console
        // (merged with JS node runtime errors, see setRuntimeError)
        if (anyErrors) {
            const unique = [...new Set(collectedErrors)];
            this.shaderErrors = unique.length ? unique : ['Shader failed to compile (no driver message).'];
            this.shaderErrorNode = firstErrorNode;
        } else {
            this.shaderErrors = [];
            this.shaderErrorNode = null;
        }
        this.refreshErrors();

        // Build a map of uniform name -> source node from compiled shaders
        // This uses the REMAPPED names from compilation, not the original node IDs
        if (this.nodeGraph.uniformRegistry) {
            this.nodeGraph.uniformRegistry.clear();

            // Extract uniforms from each compiled preview node's shader
            const previewNodes = this.nodeGraph.nodes.filter(n => n.isPreviewNode);
            for (const previewNode of previewNodes) {
                if (previewNode.previewInstance && previewNode.previewInstance.customUniformValues) {
                    for (const uniform of previewNode.previewInstance.customUniformValues) {
                        // Skip feedback/microphone/MIDI uniforms - they're managed by renderers
                        if (uniform.feedbackNodeId !== undefined || uniform.microphoneNodeId !== undefined || uniform.midiCCNodeId !== undefined) {
                            continue;
                        }

                        // Find the source node by matching the remapped name
                        const sourceNode = this.findNodeByRemappedName(uniform.name);
                        if (sourceNode) {
                            this.nodeGraph.uniformRegistry.registerUniform(
                                uniform.name,
                                uniform.type,
                                uniform.value,
                                sourceNode
                            );
                        }
                    }
                }
            }

            // Also register uniforms from background renderer if active (a disabled background
            // keeps its last shader, possibly from the previous project: its names would shadow
            // this project's uniforms of the same compact name)
            if (this.backgroundRenderer && this.backgroundRenderer.activePreviewNode &&
                this.nodeGraph.nodes.includes(this.backgroundRenderer.activePreviewNode) &&
                this.backgroundRenderer.shaderPreview &&
                this.backgroundRenderer.shaderPreview.customUniformValues) {
                for (const uniform of this.backgroundRenderer.shaderPreview.customUniformValues) {
                    // Skip feedback/microphone/MIDI uniforms - they're managed by renderers
                    if (uniform.feedbackNodeId !== undefined || uniform.microphoneNodeId !== undefined || uniform.midiCCNodeId !== undefined) {
                        continue;
                    }

                    if (!this.nodeGraph.uniformRegistry.hasUniform(uniform.name)) {
                        const sourceNode = this.findNodeByRemappedName(uniform.name);
                        if (sourceNode) {
                            this.nodeGraph.uniformRegistry.registerUniform(
                                uniform.name,
                                uniform.type,
                                uniform.value,
                                sourceNode
                            );
                        }
                    }
                }
            }

            // Also register uniforms from feedback nodes
            const feedbackNodes = this.nodeGraph.nodes.filter(n => n.isFeedbackNode);
            for (const feedbackNode of feedbackNodes) {
                if (feedbackNode.compiledShader && feedbackNode.compiledShader.uniformValues) {
                    for (const uniform of feedbackNode.compiledShader.uniformValues) {
                        // Skip feedback/microphone/MIDI uniforms - they're managed by renderers
                        if (uniform.feedbackNodeId !== undefined || uniform.microphoneNodeId !== undefined || uniform.midiCCNodeId !== undefined) {
                            continue;
                        }

                        if (!this.nodeGraph.uniformRegistry.hasUniform(uniform.name)) {
                            const sourceNode = this.findNodeByRemappedName(uniform.name);
                            if (sourceNode) {
                                this.nodeGraph.uniformRegistry.registerUniform(
                                    uniform.name,
                                    uniform.type,
                                    uniform.value,
                                    sourceNode
                                );
                            }
                        }
                    }
                }
            }
            // ...and the ones only Render 3D programs use (src/render3d)
            if (this.render3d) this.render3d.registerUniforms();
            // Constants being scrubbed (ConstantNode live edit): the value now, not the compiled one
            for (const n of this.nodeGraph.nodes) {
                if (n.liveUniform && n.updateUniformRegistry) n.updateUniformRegistry();
            }
        }
    }

    /**
     * Console lines for a failing Feedback pass. Line numbers refer to the feedback
     * shader (not a preview), so they are folded into the message; nodes named in
     * the message (node_N...) are marked red.
     */
    formatFeedbackErrors(feedbackNode) {
        const label = `Feedback #${feedbackNode.id}`;
        const shader = feedbackNode.compiledShader;
        const fragLines = shader && shader.fragment ? shader.fragment.split('\n') : [];
        const lines = [];
        for (const block of feedbackNode.feedbackErrors) {
            for (const raw of String(block).split('\n')) {
                const line = raw.trim();
                if (!line || line === '\u0000') continue;
                const m = line.match(/^(ERROR|WARNING):\s*\d+:(\d+):\s*(.*)$/i);
                const msg = m ? m[3] : line.replace(/^ERROR:\s*/i, '');
                lines.push(m ? `${m[1].toUpperCase()}: ${label} pass, line ${m[2]}: ${msg}` : `ERROR: ${label} pass: ${msg}`);
                // Mark the generating node: node_N in the message or the offending line,
                // else a custom node whose GLSL contains that line
                const code = m ? (fragLines[parseInt(m[2], 10) - 1] || '').trim() : '';
                const ref = msg.match(/\b(node_\d+)/) || code.match(/\b(node_\d+)/);
                let node = ref ? this.findNodeByRemappedName(ref[1]) : null;
                if (!node && code.length > 3) {
                    node = this.nodeGraph.nodes.find(n => n.definition && n.definition.isCustomNode &&
                        String(n.definition.customGLSL || '').split('\n').some(l => l.trim() === code)) || null;
                }
                if (node) node.hasError = true;
            }
        }
        return lines.length ? lines : [`ERROR: ${label} pass failed to compile`];
    }

    /**
     * Runtime error of a JS node (src/nodes/jsRuntime.js), or null to clear it. Shown in
     * the shader console next to the shader errors; the runtime only calls this when
     * a node's message changes, so the console is not flooded.
     */
    setRuntimeError(node, message) {
        if (!this.runtimeErrors) this.runtimeErrors = new Map();
        if (message) {
            if (this.runtimeErrors.get(node) === message) return;
            this.runtimeErrors.set(node, message);
        } else {
            if (!this.runtimeErrors.has(node)) return;
            this.runtimeErrors.delete(node);
        }
        this.refreshErrors();
    }

    /** Show shader + JS runtime errors together (or hide the console when there are none). */
    refreshErrors() {
        const live = [];
        for (const [node, msg] of this.runtimeErrors || []) {
            if (this.nodeGraph.nodes.includes(node) && node.jsError) live.push([node, msg]);
            else this.runtimeErrors.delete(node);
        }
        const all = [...(this.shaderErrors || []), ...live.map(([n, m]) => `ERROR: JS #${n.id}: ${m}`)];
        if (all.length) {
            this.errorPreviewNode = this.shaderErrorNode || (live[0] && live[0][0]) || null;
            this.showErrors(all);
        } else {
            this.hideError();
        }
    }

    // Find a node by its remapped variable name (e.g., "node_5")
    findNodeByRemappedName(varName) {
        const remap = this.shaderCompiler.nodeIdRemap;
        if (!remap) return null;

        // Extract the remapped ID from the variable name (e.g., "node_5" -> 5)
        const match = varName.match(/^node_(\d+)$/);
        if (!match) return null;

        const remappedId = parseInt(match[1]);

        // Inverse lookup (remapped id -> node), rebuilt when the mapping or the node list changes
        const nodes = this.nodeGraph.nodes;
        let inv = this._inverseRemap;
        if (!inv || inv.remap !== remap || inv.size !== remap.size || inv.nodes !== nodes || inv.len !== nodes.length) {
            const byId = new Map();
            for (const n of nodes) if (!byId.has(n.id)) byId.set(n.id, n);
            const map = new Map();
            for (const [originalId, mappedId] of remap.entries()) map.set(mappedId, byId.get(originalId) || null);
            inv = this._inverseRemap = { remap, size: remap.size, nodes, len: nodes.length, map };
        }
        return inv.map.get(remappedId) || null;
    }

    // Legacy method - no longer needed with UniformRegistry
    // Kept for compatibility but redirects to registry update
    updateUniformsForNode(changedNode) {
        // With UniformRegistry, uniforms are updated directly in ConstantNode
        // No need for manual synchronization anymore
        // This method is now a no-op
    }

    updateUniforms() {
        // Full update - used when necessary (less frequent)
        // Build a map of current uniform values from constant nodes in uniform mode
        const uniformValueMap = new Map();

        for (const node of this.nodeGraph.nodes) {
            if (node.data && node.data.useUniform && node.definition && node.definition.hasUniformToggle) {
                // Get the glsl result to extract uniforms
                const glslResult = node.definition.glsl(node, {});
                if (glslResult && glslResult.uniforms) {
                    for (const uniform of glslResult.uniforms) {
                        uniformValueMap.set(uniform.name, uniform);
                    }
                }
            }
        }

        // Update uniforms in main preview - only update existing uniforms, don't replace array
        if (this.shaderPreview && this.shaderPreview.customUniformValues) {
            for (const uniform of this.shaderPreview.customUniformValues) {
                const updated = uniformValueMap.get(uniform.name);
                if (updated) {
                    uniform.value = updated.value;
                }
            }
        }

        // Update uniforms in all preview nodes - only update existing uniforms
        const previewNodes = this.nodeGraph.nodes.filter(n => n.isPreviewNode);
        for (const previewNode of previewNodes) {
            if (previewNode.previewInstance && previewNode.previewInstance.customUniformValues) {
                for (const uniform of previewNode.previewInstance.customUniformValues) {
                    const updated = uniformValueMap.get(uniform.name);
                    if (updated) {
                        uniform.value = updated.value;
                    }
                }
            }
        }

        // No need to trigger render - ShaderPreview has its own animation loop
        // that will pick up the updated uniform values automatically
    }

    setAutoCompile(enabled) {
        this.autoCompile = enabled;
        if (!enabled && this.compileTimeout) {
            clearTimeout(this.compileTimeout);
            this.compileTimeout = null;
        }
    }

    /* ------------------------------------------------------------------
     * Error console (DOM)
     * ------------------------------------------------------------------ */

    countErrors(errors) {
        let n = 0;
        for (const e of errors || []) {
            const m = String(e).match(/^\s*ERROR:/gm);
            n += m ? m.length : 1;
        }
        return n;
    }

    hideError() {
        this.lastErrors = [];
        this.lastCompileOk = true;
        this.consoleDismissedKey = null;
        const errorDiv = document.getElementById('errorDisplay');
        if (errorDiv && errorDiv.dataset.mode !== 'ok') {
            errorDiv.remove();
        }
    }

    showError(errorString) {
        this.showErrors([errorString]);
    }

    showErrors(errors) {
        this.lastErrors = (errors || []).map(String);
        this.lastCompileOk = false;

        const key = this.lastErrors.join('\n');
        // Respect the user closing the console for this exact set of errors
        if (this.consoleDismissedKey === key && !document.getElementById('errorDisplay')) {
            this.emitCompileStatus();
            return;
        }

        const errorDiv = document.getElementById('errorDisplay') || this.createErrorDisplay();
        this.renderConsole(errorDiv, 'error');
        this.emitCompileStatus();
        // Errors don't auto-hide - user must dismiss or fix
    }

    /** Toggle the console (top-bar status pill / status bar). */
    toggleConsole() {
        const existing = document.getElementById('errorDisplay');
        if (existing) {
            if (!this.lastCompileOk) this.consoleDismissedKey = this.lastErrors.join('\n');
            existing.remove();
            return;
        }
        this.consoleDismissedKey = null;
        this.consoleCollapsed = false;
        const errorDiv = this.createErrorDisplay();
        this.renderConsole(errorDiv, this.lastCompileOk ? 'ok' : 'error');
    }

    showSuccess(message) {
        UIHelpers.toast(message, 'success');
    }

    parseErrorLines(errors) {
        const rows = [];
        for (const block of errors) {
            const lines = String(block).split('\n').map(l => l.trim()).filter(Boolean);
            for (const line of lines) {
                if (line === '\u0000') continue;
                const m = line.match(/^(ERROR|WARNING):\s*(\d+):(\d+):\s*(.*)$/i);
                if (m) {
                    rows.push({ sev: m[1].toUpperCase(), line: parseInt(m[3], 10), msg: m[4] });
                } else {
                    rows.push({ sev: /warn/i.test(line) ? 'WARNING' : 'ERROR', line: null, msg: line.replace(/^ERROR:\s*/i, '') });
                }
            }
        }
        return rows;
    }

    renderConsole(errorDiv, mode) {
        errorDiv.dataset.mode = mode;
        errorDiv.className = `pt-console ${mode === 'error' ? 'is-error' : 'is-ok'}${this.consoleCollapsed ? ' is-collapsed' : ''}`;
        errorDiv.innerHTML = '';

        const head = document.createElement('div');
        head.className = 'pc-head';
        const rows = mode === 'error' ? this.parseErrorLines(this.lastErrors) : [];
        const count = rows.filter(r => r.sev === 'ERROR').length || rows.length;

        const node = this.errorPreviewNode;
        const nodeLabel = node ? `${node.type} #${node.id}` : 'Preview';
        head.innerHTML = `
            ${icon(mode === 'error' ? 'alert' : 'check')}
            <span class="pc-title">Shader console</span>
            ${mode === 'error' ? `<span class="pc-count">${count}</span>` : ''}
            <span class="pc-sub">${mode === 'error'
                ? `${escapeHtml(nodeLabel)} ${node && node.isJSNode ? 'threw an error' : 'failed to compile'}`
                : (this.lastCompileMs != null ? `All previews compiled in ${this.lastCompileMs.toFixed(1)} ms` : 'No errors')}</span>
            <span class="pc-spacer"></span>`;

        const actions = document.createElement('div');
        actions.className = 'pc-actions';

        const hasSource = !!(node && (node.lastCompiledShader?.fragment || node.renderer?.currentShaderSource?.fragment));
        if (mode === 'error' && hasSource && this.nodeGraph.onPreviewCodeInspect) {
            const view = document.createElement('button');
            view.className = 'pt-btn pt-btn--sm pt-btn--ghost';
            view.innerHTML = `${icon('code')}<span>View shader</span>`;
            view.addEventListener('click', (e) => {
                e.stopPropagation();
                this.nodeGraph.onPreviewCodeInspect(node);
            });
            actions.appendChild(view);
        }

        if (mode === 'error') {
            const copy = document.createElement('button');
            copy.className = 'pt-icon-btn';
            copy.setAttribute('data-tip', 'Copy errors');
            copy.innerHTML = icon('copy');
            copy.addEventListener('click', (e) => {
                e.stopPropagation();
                navigator.clipboard?.writeText(this.lastErrors.join('\n')).then(
                    () => UIHelpers.toast('Errors copied to clipboard', 'success'),
                    () => UIHelpers.toast('Could not access the clipboard', 'error')
                );
            });
            actions.appendChild(copy);

            const collapse = document.createElement('button');
            collapse.className = 'pt-icon-btn pc-collapse';
            collapse.setAttribute('data-tip', 'Collapse');
            collapse.innerHTML = icon('chevronDown');
            collapse.addEventListener('click', (e) => {
                e.stopPropagation();
                this.consoleCollapsed = !this.consoleCollapsed;
                errorDiv.classList.toggle('is-collapsed', this.consoleCollapsed);
            });
            actions.appendChild(collapse);
        }

        const close = document.createElement('button');
        close.className = 'pt-icon-btn';
        close.setAttribute('data-tip', 'Close');
        close.setAttribute('aria-label', 'Close console');
        close.innerHTML = icon('close');
        close.addEventListener('click', (e) => {
            e.stopPropagation();
            if (mode === 'error') this.consoleDismissedKey = this.lastErrors.join('\n');
            errorDiv.remove();
        });
        actions.appendChild(close);
        head.appendChild(actions);

        head.addEventListener('dblclick', () => {
            if (mode !== 'error') return;
            this.consoleCollapsed = !this.consoleCollapsed;
            errorDiv.classList.toggle('is-collapsed', this.consoleCollapsed);
        });

        const body = document.createElement('div');
        body.className = 'pc-body';
        if (mode === 'error' && !rows.some(r => r.line != null)) body.classList.add('no-lines');
        if (mode === 'error') {
            for (const r of rows) {
                const row = document.createElement('div');
                row.className = 'pc-row';
                const msg = escapeHtml(r.msg).replace(/&#39;([^&]+?)&#39;/g, '<code>$1</code>');
                row.innerHTML = `
                    <span class="pc-sev${r.sev === 'WARNING' ? ' pc-sev--warn' : ''}">${r.sev === 'WARNING' ? 'WARN' : 'ERR'}</span>
                    <span class="pc-line">${r.line != null ? `L${r.line}` : ''}</span>
                    <span class="pc-msg">${msg}</span>`;
                body.appendChild(row);
            }
        } else {
            const ok = document.createElement('div');
            ok.className = 'pc-ok';
            ok.textContent = 'No shader errors. Errors from GLSL compilation will appear here.';
            body.appendChild(ok);
        }

        errorDiv.append(head, body);
    }

    createErrorDisplay() {
        const errorDiv = document.createElement('div');
        errorDiv.id = 'errorDisplay';
        errorDiv.className = 'pt-console';
        errorDiv.setAttribute('role', 'region');
        errorDiv.setAttribute('aria-label', 'Shader console');
        // Keep canvas interactions from leaking through the panel
        errorDiv.addEventListener('mousedown', (e) => e.stopPropagation());
        errorDiv.addEventListener('wheel', (e) => e.stopPropagation());
        (document.getElementById('container') || document.body).appendChild(errorDiv);
        return errorDiv;
    }
}
