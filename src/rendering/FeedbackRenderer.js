import { ShaderPreview } from './ShaderPreview.js';
import { applyClockUniforms } from '../core/Clock.js';
import { sceneGates, feedbackPassActive } from '../core/scenes.js';
import { audioTextures } from '../services/AudioTextures.js';
import { programCache, quadBuffer, cameraTexture } from './glResources.js';
import { quality } from './QualityGovernor.js';
import { loopTrace } from '../core/loopTrace.js';

/** Content of a node id mapping (old id -> compact id), as a number. */
function remapSignature(remap) {
    if (!remap) return 0;
    let h = remap.size;
    for (const [id, index] of remap) h = (h * 31 + id * 7 + index) | 0;
    return h;
}

/**
 * Renders Feedback nodes. Each Feedback node owns two framebuffers (ping-pong):
 * every frame the sub-graph connected to its `in` port is rendered into the
 * write buffer while shaders sample the read buffer (= previous frame) through
 * the node's sampler2D uniform, then the buffers swap.
 */
export class FeedbackRenderer {
    constructor(nodeGraph, shaderCompiler, sharedGL, uniformRegistry = null) {
        this.nodeGraph = nodeGraph;
        this.shaderCompiler = shaderCompiler;
        this.gl = sharedGL;
        this.uniformRegistry = uniformRegistry;
        this.positionBuffer = null;
        this.cameraTexture = null;
        // Feedback nodes of the graph (rebuilt when the node list changes, not every frame)
        this._fbNodes = [];
        this._fbNodesRef = null;
        this._fbNodesLen = -1;
        this.gateRefs = null;

        if (!this.gl) {
            console.error('FeedbackRenderer: No shared WebGL context provided');
            return;
        }
        // u_time and the audio / beat uniforms come from the global clock (core/Clock.js),
        // so feedback passes and the previews that sample them share one time base
    }

    /**
     * The compiler names uniforms after compact node ids (node_N). Make sure a
     * mapping covering every node exists (same deterministic scheme as
     * CompilationManager.createGlobalNodeIdMapping) so feedback shaders and
     * preview shaders agree on names even if we compile first (project load).
     */
    ensureNodeIdMapping() {
        const remap = this.shaderCompiler.nodeIdRemap;
        const nodes = this.nodeGraph.nodes;
        if (remap && remap.size === nodes.length && nodes.every(n => remap.has(n.id))) return;
        const ids = [...new Set(nodes.map(n => n.id))].sort((a, b) => a - b);
        const map = remap || new Map();
        map.clear();
        ids.forEach((id, index) => map.set(id, index));
        this.shaderCompiler.nodeIdRemap = map;
    }

    /** The graph's Feedback nodes (cached; the node list is replaced or grows on every change). */
    feedbackNodes() {
        const nodes = this.nodeGraph.nodes;
        if (nodes !== this._fbNodesRef || nodes.length !== this._fbNodesLen) {
            this._fbNodesRef = nodes;
            this._fbNodesLen = nodes.length;
            this._fbNodes = nodes.filter(n => n.isFeedbackNode);
        }
        return this._fbNodes;
    }

    /**
     * Compile the Feedback passes (graph changed / compile cycle).
     * async: a pass whose source changed links in the background (KHR_parallel_shader_compile)
     * while its previous program keeps rendering; CompilationManager waits for
     * pendingLinksDone() and switches them with applyPendingLinks(). Only while the node id
     * mapping is unchanged (else the old program's uniform names could mean other nodes).
     */
    compileFeedbackShaders({ async = false } = {}) {
        // Compile shaders for all feedback nodes (called when graph changes)
        const feedbackNodes = this.feedbackNodes();
        if (feedbackNodes.length === 0) return;
        this.ensureNodeIdMapping();
        const remapSig = remapSignature(this.shaderCompiler.nodeIdRemap);
        if (remapSig !== this._remapSig) {
            this._remapSig = remapSig;
            async = false;
        }
        // SceneSwitcher: which scenes need each pass (null when the graph has no switcher)
        this.sceneGates = this.nodeGraph.nodes.some(n => n.isSceneSwitcher) ? sceneGates(this.nodeGraph) : null;
        this.gateRefs = this.sceneGates ? this.buildGateRefs(this.sceneGates) : null;
        const started = [];
        const cache = this.gl ? programCache(this.gl) : null;

        for (const feedbackNode of feedbackNodes) {
            feedbackNode.feedbackCompileAttempted = true;

            // Find the input connection
            const inputConnection = this.nodeGraph.connections.find(
                conn => conn.toNode === feedbackNode && conn.toInput === 0
            );

            if (!inputConnection) {
                this.cancelPendingLink(feedbackNode);
                this.clearProgram(feedbackNode);
                feedbackNode.compiledShader = null;
                feedbackNode.feedbackErrors = [];
                continue;
            }

            // Compile the shader source (honouring a swizzle / accessor on the cable)
            const shader = this.shaderCompiler.compileFromNodeAsOutput(
                inputConnection.fromNode,
                inputConnection.fromOutput,
                this.nodeGraph,
                inputConnection.accessor || null
            );

            if (!shader || !shader.fragment) {
                this.cancelPendingLink(feedbackNode);
                this.clearProgram(feedbackNode);
                feedbackNode.compiledShader = null;
                feedbackNode.feedbackErrors = shader ? [...shader.errors] : ['Feedback input failed to compile'];
                continue;
            }

            // Inject feedback textures (for feedback loops where output connects to input)
            this.injectFeedbackTextures(shader, this.gl);

            const previous = feedbackNode.compiledShader;
            const pending = feedbackNode.pendingLink;
            // Background link: the current program stays on screen until the new one is linked
            if (async && cache && shader.vertex && feedbackNode.compiledProgram && previous && previous.fragment !== shader.fragment) {
                if (pending && pending.shader.fragment === shader.fragment) {
                    pending.shader = shader; // same source still linking: newer uniform values
                    continue;
                }
                this.cancelPendingLink(feedbackNode);
                const entry = cache.acquire(shader.vertex, shader.fragment, { async: true });
                feedbackNode.pendingLink = { shader, entry };
                // Linked before (undo, A/B toggles): switch now
                if (entry.status !== 'pending') this.applyPendingLink(feedbackNode);
                continue;
            }
            this.cancelPendingLink(feedbackNode);

            // Keep the linked GL program when the source did not change
            if (!previous || previous.fragment !== shader.fragment) {
                this.clearProgram(feedbackNode);
            }
            feedbackNode.compiledShader = shader;
            // Hand new programs to the driver first: they link in parallel
            if (!feedbackNode.compiledProgram && cache && shader.vertex) {
                try { started.push(cache.acquire(shader.vertex, shader.fragment, { async: true })); } catch (e) { /* linked below */ }
            }
            started.push(feedbackNode);
        }
        // Link now (not at the next frame) so WebGL errors are known with the compile
        // result: CompilationManager shows them in the console, compile reports them.
        for (const item of started) {
            if (item.isFeedbackNode) item.feedbackErrors = this.ensureFeedbackProgram(item);
        }
        // Drop the kick-off references (ensureFeedbackProgram took its own)
        for (const item of started) if (!item.isFeedbackNode && cache) cache.release(item);
    }

    /** Is a Feedback pass still linking in the background (async compile)? */
    hasPendingLinks() {
        return this.feedbackNodes().some(fb => fb.pendingLink);
    }

    /** Have all background links finished (never blocks)? */
    pendingLinksDone() {
        if (!this.gl) return true;
        const cache = programCache(this.gl);
        for (const fb of this.feedbackNodes()) {
            if (fb.pendingLink && !cache.isComplete(fb.pendingLink.entry)) return false;
        }
        return true;
    }

    /** Switch every pass whose background link finished (blocks for the ones still linking). */
    applyPendingLinks() {
        for (const fb of this.feedbackNodes()) if (fb.pendingLink) this.applyPendingLink(fb);
    }

    applyPendingLink(feedbackNode) {
        const pending = feedbackNode.pendingLink;
        if (!pending) return;
        feedbackNode.pendingLink = null;
        const cache = programCache(this.gl);
        cache.finish(pending.entry);
        const program = this.programFromEntry(pending.entry, pending.shader);
        this.clearProgram(feedbackNode);
        feedbackNode.compiledShader = pending.shader;
        if (program) {
            feedbackNode.compiledProgram = program;
            feedbackNode.programFailedFor = null;
            feedbackNode.programErrors = null;
            feedbackNode.feedbackErrors = [];
        } else {
            feedbackNode.programFailedFor = pending.shader.fragment;
            feedbackNode.programErrors = pending.shader.webglErrors && pending.shader.webglErrors.length
                ? [...pending.shader.webglErrors] : ['Feedback shader failed to compile'];
            feedbackNode.feedbackErrors = feedbackNode.programErrors;
        }
    }

    /** Drop a background link that a newer compile superseded. */
    cancelPendingLink(feedbackNode) {
        const pending = feedbackNode.pendingLink;
        if (!pending) return;
        feedbackNode.pendingLink = null;
        if (this.gl) programCache(this.gl).release(pending.entry);
    }

    /** Scene gates resolved to switcher nodes once per compile (feedbackPassActive without per-frame lookups). */
    buildGateRefs(gates) {
        const byId = new Map();
        for (const n of this.nodeGraph.nodes) if (n.isSceneSwitcher) byId.set(n.id, n);
        const refs = new Map();
        for (const [id, set] of gates) {
            if (!set || !set.size || set.has('*')) { refs.set(id, null); continue; }
            const list = [];
            for (const key of set) {
                const [swId, idx] = key.split(':').map(Number);
                list.push({ sw: byId.get(swId) || null, idx });
            }
            refs.set(id, list);
        }
        return refs;
    }

    /** Is a Feedback pass needed this frame (scene gates)? Same rules as scenes.feedbackPassActive. */
    passActive(fb) {
        if (!this.gateRefs || (fb.data && fb.data.keepRunning)) return true;
        if (!this.gateRefs.has(fb.id)) return true;
        const list = this.gateRefs.get(fb.id);
        if (!list) return true;
        for (let i = 0; i < list.length; i++) {
            const { sw, idx } = list[i];
            if (!sw || typeof sw.isSceneEvaluated !== 'function' || sw.isSceneEvaluated(idx)) return true;
        }
        return false;
    }

    /**
     * Link the node's GL program for its compiled shader if needed.
     * Returns the WebGL errors ([] when the program is usable). A failing source
     * is not retried until it changes; its errors stay on the node.
     */
    ensureFeedbackProgram(feedbackNode) {
        const shader = feedbackNode.compiledShader;
        if (!shader || !this.gl) return [];
        if (feedbackNode.compiledProgram) return [];
        if (feedbackNode.programFailedFor === shader.fragment) return feedbackNode.programErrors || ['Feedback shader failed to compile'];
        const program = this.compileFeedbackProgram(this.gl, shader);
        if (!program) {
            feedbackNode.programFailedFor = shader.fragment;
            feedbackNode.programErrors = shader.webglErrors && shader.webglErrors.length
                ? [...shader.webglErrors] : ['Feedback shader failed to compile'];
            return feedbackNode.programErrors;
        }
        feedbackNode.compiledProgram = program;
        feedbackNode.programFailedFor = null;
        feedbackNode.programErrors = null;
        return [];
    }

    clearProgram(feedbackNode) {
        const p = feedbackNode.compiledProgram;
        if (p && this.gl) {
            if (p.entry) programCache(this.gl).release(p.entry);
            else this.gl.deleteProgram(p.program);
        }
        feedbackNode.compiledProgram = null;
    }

    renderFeedbackNodes() {
        // Render feedback nodes every frame
        const feedbackNodes = this.feedbackNodes();
        if (feedbackNodes.length === 0 || !this.gl) return;

        const gl = this.gl;

        // Safety net: a project loaded without a graph-change event never compiled its feedback shaders
        for (let i = 0; i < feedbackNodes.length; i++) {
            if (!feedbackNodes[i].feedbackCompileAttempted) { this.compileFeedbackShaders(); break; }
        }

        // (Re)initialize buffers if missing, resized or reformatted (data.format / data.filter /
        // data.autoScale; no-op otherwise) - all of them before any pass binds another node's texture
        const now = performance.now();
        for (let i = 0; i < feedbackNodes.length; i++) {
            const fb = feedbackNodes[i];
            loopTrace.node = fb; // (error attribution, src/core/loopTrace.js)
            fb.initBuffers(gl, quality.feedbackScale(fb, now));
        }

        let skipped = 0;
        for (const feedbackNode of feedbackNodes) {
            loopTrace.node = feedbackNode;
            // Skip if no compiled shader
            if (!feedbackNode.compiledShader) {
                continue;
            }
            // Only needed by scenes that are hidden right now: freeze (resumes when shown)
            if (this.sceneGates && !(this.gateRefs ? this.passActive(feedbackNode) : feedbackPassActive(feedbackNode, this.sceneGates, this.nodeGraph))) {
                skipped++;
                continue;
            }

            // Compile GL program if not already compiled
            if (!feedbackNode.compiledProgram) {
                const errors = this.ensureFeedbackProgram(feedbackNode);
                if (!feedbackNode.compiledProgram) {
                    feedbackNode.feedbackErrors = errors;
                    continue;
                }
            }

            // Self-referencing (and cross-referencing) feedback textures read the previous frame
            const uvs = feedbackNode.compiledShader.uniformValues;
            if (uvs) {
                for (let i = 0; i < uvs.length; i++) {
                    const uniform = uvs[i];
                    if (uniform.type === 'sampler2D' && uniform.feedbackNode) {
                        uniform.texture = uniform.feedbackNode.getReadTexture();
                    }
                }
            }

            this.renderToFramebufferWithProgram(
                gl,
                feedbackNode.compiledProgram,
                feedbackNode.compiledShader,
                feedbackNode.getWriteFramebuffer(),
                feedbackNode.bufferWidth || feedbackNode.data.width,
                feedbackNode.bufferHeight || feedbackNode.data.height
            );

            // Swap buffers for next frame (read becomes write, write becomes read)
            feedbackNode.swap();
        }
        this.skippedPasses = skipped;
    }

    injectFeedbackTextures(shaderResult, targetGl) {
        // Find all feedback node uniforms and inject their textures
        if (!shaderResult || !shaderResult.uniformValues) return;

        for (const uniform of shaderResult.uniformValues) {
            // Inject feedback textures
            if (uniform.type === 'sampler2D' && uniform.feedbackNodeId !== undefined) {
                const feedbackNode = this.nodeGraph.nodes.find(n => n.id === uniform.feedbackNodeId);
                if (feedbackNode && feedbackNode.isFeedbackNode) {
                    if (!feedbackNode.buffersInitialized) {
                        feedbackNode.initBuffers(this.gl);
                    }
                    // Keep a reference for per-frame updates (previous frame texture)
                    uniform.feedbackNode = feedbackNode;
                    uniform.texture = feedbackNode.getReadTexture();
                } else {
                    console.error(`[FeedbackRenderer] Could not find feedback node ${uniform.feedbackNodeId}`);
                }
            }

            // Image Param textures (created in the shared GL context, uploaded when loaded)
            if (uniform.type === 'sampler2D' && uniform.imageParamNodeId !== undefined) {
                const paramNode = this.nodeGraph.nodes.find(n => n.id === uniform.imageParamNodeId);
                if (paramNode && typeof paramNode.getTexture === 'function') {
                    uniform.texture = paramNode.getTexture(this.gl);
                    uniform.textureOwner = paramNode; // re-resolved every frame (null once freed)
                }
            }

            // JS node texture outputs (canvas / data textures, uploaded by the JS runtime)
            if (uniform.type === 'sampler2D' && uniform.jsTextureNodeId !== undefined) {
                const jsNode = this.nodeGraph.nodes.find(n => n.id === uniform.jsTextureNodeId);
                if (jsNode && typeof jsNode.getTexture === 'function') {
                    uniform.texture = jsNode.getTexture(this.gl, uniform.jsTextureOutput);
                    uniform.textureOwner = jsNode; // re-resolved every frame (null once freed)
                    uniform.textureKey = uniform.jsTextureOutput;
                }
            }

            // Audio textures (Audio Texture node, u_spectrum / u_waveform / u_spectrogram):
            // updated lazily on the first bind of each frame (AudioTextures.liveTexture)
            if (uniform.type === 'sampler2D' && uniform.audioTexture) {
                uniform.texture = audioTextures.getTexture(this.gl, uniform.audioTexture);
                uniform.textureOwner = audioTextures;
                uniform.textureKey = uniform.audioTexture;
            }

            // Inject microphone RMS values
            if (uniform.type === 'float' && uniform.microphoneNodeId !== undefined) {
                const micNode = this.nodeGraph.nodes.find(n => n.id === uniform.microphoneNodeId);
                if (micNode && micNode.isMicrophoneNode) {
                    uniform.microphoneNode = micNode;
                    uniform.value = micNode.getRMS();
                }
            }

            // Inject MIDI CC values
            if (uniform.type === 'float' && uniform.midiCCNodeId !== undefined) {
                const midiNode = this.nodeGraph.nodes.find(n => n.id === uniform.midiCCNodeId);
                if (midiNode && midiNode.isMidiCCNode) {
                    uniform.midiCCNode = midiNode;
                    uniform.value = midiNode.getValue();
                }
            }
        }
    }

    compileFeedbackProgram(gl, shader) {
        // Shared program cache: an unchanged / repeated source is not linked again
        return this.programFromEntry(programCache(gl).acquire(shader.vertex, shader.fragment), shader);
    }

    /** Program data of a finished cache entry (taken over), or null (errors on the shader, entry released). */
    programFromEntry(entry, shader) {
        if (entry.status !== 'ready') {
            const err = entry.error || { stage: 'link', log: 'program failed to link' };
            if (err.stage === 'vertex') {
                console.error('Feedback vertex shader error:', err.log);
                shader.webglErrors = [err.log];
            } else if (err.stage === 'fragment') {
                console.error('Feedback fragment shader error:', err.log);
                shader.webglErrors = [err.log];
            } else {
                console.error('Feedback program link error:', err.log);
                shader.webglErrors = [`Link error: ${err.log}`];
            }
            programCache(this.gl).release(entry);
            return null;
        }
        return { program: entry.program, uniforms: entry.uniforms, positionLocation: entry.aPosition, entry };
    }

    /** The active camera / video / screen frame (shared texture, uploaded once per frame). */
    updateCameraTexture(gl) {
        this.cameraTexture = cameraTexture(gl, this.nodeGraph, null);
        gl.bindTexture(gl.TEXTURE_2D, this.cameraTexture);
    }

    renderToFramebufferWithProgram(gl, programData, shader, framebuffer, width, height) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
        gl.viewport(0, 0, width, height);
        gl.useProgram(programData.program);

        // Standard uniforms
        if (programData.uniforms.u_resolution) {
            gl.uniform2f(programData.uniforms.u_resolution, width, height);
        }
        applyClockUniforms(gl, programData.uniforms);
        if (programData.uniforms.u_mouse) {
            gl.uniform2f(programData.uniforms.u_mouse, ShaderPreview.mouseX, ShaderPreview.mouseY);
        }
        // Texture unit 0 is reserved for the camera / video source
        if (programData.uniforms.u_camera) {
            gl.activeTexture(gl.TEXTURE0);
            this.updateCameraTexture(gl);
            gl.uniform1i(programData.uniforms.u_camera, 0);
        }

        // Custom uniforms from shader compilation
        const uvs = shader.uniformValues;
        if (uvs) {
            let textureUnit = 1;
            for (let ui = 0; ui < uvs.length; ui++) {
                const uniform = uvs[ui];
                // Live values (constants in uniform mode, keyboard, XY pad, ...) come from the registry
                if (this.uniformRegistry && uniform.feedbackNodeId === undefined && uniform.microphoneNodeId === undefined && uniform.midiCCNodeId === undefined) {
                    const registryUniform = this.uniformRegistry.getUniform(uniform.name);
                    if (registryUniform) {
                        uniform.value = registryUniform.value;
                    }
                }

                const location = programData.uniforms[uniform.name];
                if (location === null || location === undefined) continue;

                const v = uniform.value;
                switch (uniform.type) {
                    case 'float':
                        if (uniform.microphoneNode && uniform.microphoneNode.isActive) {
                            uniform.value = uniform.microphoneNode.getRMS();
                        }
                        if (uniform.midiCCNode) {
                            uniform.value = uniform.midiCCNode.getValue();
                        }
                        gl.uniform1f(location, uniform.value);
                        break;
                    case 'int':
                        gl.uniform1i(location, v);
                        break;
                    case 'bool':
                        gl.uniform1i(location, v ? 1 : 0);
                        break;
                    case 'vec2':
                        if (v) gl.uniform2f(location, v[0], v[1]);
                        break;
                    case 'vec3':
                        if (v) gl.uniform3f(location, v[0], v[1], v[2]);
                        break;
                    case 'vec4':
                        if (v) gl.uniform4f(location, v[0], v[1], v[2], v[3]);
                        break;
                    case 'sampler2D':
                        if (uniform.textureOwner) uniform.texture = uniform.textureOwner.liveTexture(uniform.textureKey);
                        if (uniform.texture) {
                            gl.activeTexture(gl.TEXTURE0 + textureUnit);
                            gl.bindTexture(gl.TEXTURE_2D, uniform.texture);
                            gl.uniform1i(location, textureUnit);
                            textureUnit++;
                        } else {
                            // Programs are shared: don't inherit another pass's unit
                            gl.uniform1i(location, 0);
                        }
                        break;
                }
            }
        }

        // Fullscreen quad (shared per context)
        if (!this.positionBuffer) this.positionBuffer = quadBuffer(gl);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
        gl.enableVertexAttribArray(programData.positionLocation);
        gl.vertexAttribPointer(programData.positionLocation, 2, gl.FLOAT, false, 0, 0);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

        gl.activeTexture(gl.TEXTURE0);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }

    destroy() {
        if (!this.gl) return;
        if (this.positionBuffer) this.gl.deleteBuffer(this.positionBuffer);
        if (this.cameraTexture) this.gl.deleteTexture(this.cameraTexture);
        this.positionBuffer = null;
        this.cameraTexture = null;
    }
}
