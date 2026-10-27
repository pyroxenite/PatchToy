import { clock, applyClockUniforms } from '../core/Clock.js';
import { programCache, quadBuffer, noiseProgram, cameraTexture } from './glResources.js';
import { renderLoop } from './RenderLoop.js';

/**
 * Renders one compiled shader (a Preview node's thumbnail, the background / fullscreen
 * preview, output / recording sources, probes) in the shared GL context.
 *
 * Programs come from the context's ProgramCache (glResources.js): every renderer showing
 * the same source shares one linked program, and loading a source that was linked
 * before costs nothing. `program` is the current program (setting it to null releases it).
 *
 * Frames are driven by the page's RenderLoop (no requestAnimationFrame per preview):
 * animate() registers the preview, stopRendering() unregisters it, frameTick() renders
 * one frame. `animationId` is truthy while registered (kept for older callers).
 */
export class ShaderPreview {
    // Shared mouse position (normalized 0-1, Y flipped for WebGL)
    static mouseX = 0;
    static mouseY = 0;
    static programLinks = 0; // programs linked by any ShaderPreview (diagnostics)

    constructor(canvas, videoElement, options = {}) {
        this.videoElement = videoElement;
        this.isOffscreen = options.offscreen || false;
        this.nodeId = options.nodeId || null;
        this.canManageCamera = !this.isOffscreen; // Only main preview manages camera
        this.uniformRegistry = options.uniformRegistry || null; // Centralized uniform management
        this.ownerNode = null;      // Preview node showing this renderer (visibility checks)
        this.governor = null;       // quality governor name ('background') for shared-canvas outputs
        this.frameCount = 0;        // frames rendered (the node canvas redraws only for new frames)
        this._entry = null;         // ProgramCache entry of `program`
        this._rawProgram = null;    // a program assigned from outside (not cached)
        this._pending = null;       // async load in flight: { entry, source, onError }

        // Use shared GL context if provided, otherwise create own (for backwards compatibility)
        if (options.sharedGL) {
            this.gl = options.sharedGL;
            this.canvas = null; // No canvas needed, rendering to framebuffer
            this.usingSharedContext = true;
        } else {
            // Legacy path: create own context
            if (this.isOffscreen) {
                this.canvas = document.createElement('canvas');
                this.canvas.width = options.width || 128;
                this.canvas.height = options.height || 128;
                this.parentCanvas = canvas;
            } else {
                this.canvas = canvas;
            }

            this.gl = this.canvas.getContext('webgl2');
            this.usingSharedContext = false;

            if (!this.gl) {
                console.error('WebGL 2 not supported' + (this.isOffscreen ? ' for preview node' : ''));
                return;
            }
        }

        // Create framebuffer for offscreen rendering (when using shared context)
        if (this.usingSharedContext && this.isOffscreen) {
            this.width = options.width || 128;
            this.height = options.height || 128;
            this.framebuffer = this.createFramebuffer(this.gl, this.width, this.height);
        }

        this.program = null;
        // u_time and the audio / beat uniforms come from the global clock (core/Clock.js)
        this.animationId = null;
        this.cameraTexture = null;
        this.cameraEnabled = false;
        this.cameraStream = null;
        this.customUniformValues = [];
        this.uniforms = {};

        this.setupGeometry();
        this.setupCameraTexture();
        this.setupNoiseShader();

        // Render every frame (RenderLoop) - also needed for the noise shader
        this.animate();
    }

    /** The current GL program (null: none; the TV-noise program is drawn instead). */
    get program() {
        return this._entry ? this._entry.program : this._rawProgram;
    }

    set program(p) {
        if (this._entry && p === this._entry.program) return;
        this._releaseEntry();
        this._rawProgram = p || null;
    }

    _releaseEntry() {
        if (this._entry) {
            const e = this._entry;
            this._entry = null;
            programCache(this.gl).release(e);
        }
    }

    _cancelPending() {
        if (this._pending) {
            const p = this._pending;
            this._pending = null;
            programCache(this.gl).release(p.entry);
        }
    }

    createFramebuffer(gl, width, height) {
        const framebuffer = gl.createFramebuffer();
        const texture = gl.createTexture();

        // Set up texture
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

        // Attach texture to framebuffer
        gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);

        // Check framebuffer status
        const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
        if (status !== gl.FRAMEBUFFER_COMPLETE) {
            console.error('Framebuffer incomplete:', status);
        }

        // Unbind
        gl.bindTexture(gl.TEXTURE_2D, null);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);

        return { framebuffer, texture };
    }

    setupNoiseShader() {
        // TV static shown while no program is loaded (one program per context, shared)
        const n = noiseProgram(this.gl);
        this.noiseProgram = n ? n.program : null;
        this.noiseUniforms = n ? n.uniforms : {};
        this._noiseAttrib = n ? n.aPosition : -1;
    }

    setupGeometry() {
        // Full-screen quad (one buffer per context, shared)
        this.positionBuffer = quadBuffer(this.gl);
    }

    setupCameraTexture() {
        // The camera / video frame texture is shared by every renderer of the context and
        // uploaded once per frame (glResources.cameraTexture); bound only by shaders using u_camera
        this.cameraTexture = null;
    }

    async enableCamera() {
        try {
            this.cameraStream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: 'user' },
                audio: false
            });

            this.videoElement.srcObject = this.cameraStream;
            await this.videoElement.play();

            this.cameraEnabled = true;
            console.log('Camera enabled');
            return true;
        } catch (error) {
            console.error('Failed to enable camera:', error);
            return false;
        }
    }

    disableCamera() {
        if (this.cameraStream) {
            this.cameraStream.getTracks().forEach(track => track.stop());
            this.cameraStream = null;
        }

        if (this.videoElement) {
            this.videoElement.srcObject = null;
        }

        this.cameraEnabled = false;
        console.log('Camera disabled');
    }

    async toggleCamera() {
        if (this.cameraEnabled) {
            this.disableCamera();
            return false;
        } else {
            return await this.enableCamera();
        }
    }

    /** Bind the shared camera texture (current video frame) for u_camera. */
    updateCameraTexture() {
        this.cameraTexture = cameraTexture(this.gl, this.graph || null, this.videoElement || null);
        return this.cameraTexture;
    }

    /**
     * Load a compiled shader ({ vertex, fragment, uniformValues }).
     * Returns true when the program is ready (now in use), false when it failed to
     * compile (the previous program stays), or 'pending' with { async: true } while the
     * driver links it in parallel (the previous program keeps rendering; the new one
     * takes over in applyPending(), see CompilationManager).
     */
    loadShader(shaderSource, onError, { async = false } = {}) {
        const gl = this.gl;

        // Check if we got a valid shader (for offscreen mode)
        if (!shaderSource || !shaderSource.fragment) {
            if (this.isOffscreen) {
                console.error('Preview node: Invalid shader source');
            }
            return false;
        }

        // Initialize webglErrors array if it doesn't exist
        if (!shaderSource.webglErrors) {
            shaderSource.webglErrors = [];
        }

        // Store shader source for code inspection (even if compilation fails)
        this.currentShaderSource = shaderSource;

        this._cancelPending();
        const cache = programCache(gl);
        const entry = cache.acquire(shaderSource.vertex, shaderSource.fragment, { async });
        if (entry.status === 'pending') {
            this._pending = { entry, source: shaderSource, onError };
            return 'pending';
        }
        return this._applyEntry(entry, shaderSource, onError);
    }

    /** Is an async load still linking? */
    isPending() {
        return !!this._pending && this._pending.entry.status === 'pending';
    }

    /** Has the async load's link finished (never blocks)? */
    pendingComplete() {
        if (!this._pending) return true;
        return programCache(this.gl).isComplete(this._pending.entry);
    }

    /** Switch to the async-loaded program (blocks if it is still linking). Returns like loadShader. */
    applyPending() {
        const p = this._pending;
        if (!p) return true;
        this._pending = null;
        programCache(this.gl).finish(p.entry);
        return this._applyEntry(p.entry, p.source, p.onError);
    }

    _applyEntry(entry, shaderSource, onError) {
        const cache = programCache(this.gl);
        if (entry.status !== 'ready') {
            const err = entry.error || { stage: 'link', log: 'program failed to link' };
            const off = this.isOffscreen;
            if (err.stage === 'vertex') {
                console.error((off ? 'Preview node v' : 'V') + 'ertex shader' + (off ? '' : ' compile') + ' error:', err.log);
                if (onError) onError('Vertex shader compile error:\n' + err.log);
            } else if (err.stage === 'fragment') {
                console.error((off ? 'Preview node f' : 'F') + 'ragment shader' + (off ? '' : ' compile') + ' error:', err.log);
                if (onError) onError('Fragment shader compile error:\n' + err.log);
            } else {
                console.error((off ? 'Preview node p' : 'P') + 'rogram link error:', err.log);
                if (onError) onError('Program link error:\n' + err.log);
            }
            shaderSource.webglErrors.push(err.log);
            cache.release(entry);
            return false;
        }

        // Swap in (the previous program is released; the cache frees it when unused)
        if (this._entry !== entry) {
            const old = this._entry;
            this._entry = entry;
            this._rawProgram = null;
            if (old) cache.release(old);
        } else {
            cache.release(entry); // already held: drop the extra reference
        }
        if (entry.fresh) {
            ShaderPreview.programLinks++; // diagnostics: get_audio_status reports it (no relinks per frame)
            entry.fresh = false;
        }
        this.customUniformValues = shaderSource.uniformValues || []; // Store custom uniform values
        this.uniforms = entry.uniforms;
        this._attrib = entry.aPosition;

        // Start animation
        if (!this.animationId) {
            this.animate();
        }

        return true;
    }

    /** Render every frame (registers with the page's RenderLoop). */
    animate() {
        renderLoop.add(this);
        this.animationId = this.animationId || 1;
    }

    /** One frame: pre-render hook, per-frame texture uniforms, draw. */
    frameTick() {
        // Call pre-render callback if set (for feedback nodes and texture updates)
        if (this.onBeforeRender) {
            this.onBeforeRender();
        }

        // Update feedback texture references before rendering
        this.refreshTextureUniforms();

        this.render();
    }

    /** Re-resolve per-frame texture uniforms (Feedback read buffers, node-owned textures). */
    refreshTextureUniforms() {
        const list = this.customUniformValues;
        if (list && list.length > 0) {
            for (let i = 0; i < list.length; i++) {
                const uniform = list[i];
                // Update feedback texture each frame (all in same context now!)
                if (uniform.type === 'sampler2D' && uniform.feedbackNodeId !== undefined && uniform.feedbackNode) {
                    uniform.texture = uniform.feedbackNode.getReadTexture();
                }
                // Textures owned by a node (image Param, JS texture outputs): null once freed
                if (uniform.textureOwner) {
                    uniform.texture = uniform.textureOwner.liveTexture(uniform.textureKey);
                }
            }
        }
    }

    stopRendering() {
        if (this.animationId) {
            renderLoop.remove(this);
            this.animationId = null;
        }
    }

    render() {
        const gl = this.gl;
        this.frameCount++; // every draw (also direct render() calls: thumbnails, captures)

        // Bind framebuffer if using shared context
        if (this.usingSharedContext && this.framebuffer) {
            gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer.framebuffer);
        }

        // Get dimensions (from canvas or framebuffer)
        const width = this.usingSharedContext ? this.width : this.canvas.width;
        const height = this.usingSharedContext ? this.height : this.canvas.height;

        const program = this.program;
        if (!program) {
            // Render TV static noise when no program is loaded
            if (this.noiseProgram) {
                gl.viewport(0, 0, width, height);
                gl.useProgram(this.noiseProgram);

                // Set uniforms for noise shader
                if (this.noiseUniforms.u_resolution) {
                    gl.uniform2f(this.noiseUniforms.u_resolution, width, height);
                }
                if (this.noiseUniforms.u_time) {
                    gl.uniform1f(this.noiseUniforms.u_time, clock.u.time);
                }

                // Setup vertex attributes
                const positionLocation = this._noiseAttrib;
                gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
                gl.enableVertexAttribArray(positionLocation);
                gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);

                // Draw
                gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
            } else {
                // Fallback to solid color if noise shader failed to compile
                gl.clearColor(0.1, 0.1, 0.1, 1.0);
                gl.clear(gl.COLOR_BUFFER_BIT);
            }

            // Unbind framebuffer
            if (this.usingSharedContext && this.framebuffer) {
                gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            }
            return;
        }

        // viewportRect: [x, y, w, h] sub-rectangle of the target (debug probes render
        // into cells of a shared atlas while u_resolution stays width x height)
        const vp = this.viewportRect;
        if (vp) gl.viewport(vp[0], vp[1], vp[2], vp[3]);
        else gl.viewport(0, 0, width, height);
        gl.useProgram(program);

        const locs = this.uniforms;
        // Set standard uniforms
        if (locs.u_resolution) {
            gl.uniform2f(locs.u_resolution, width, height);
        }
        // u_time + audio / beat uniforms (global clock, same values for every renderer this frame)
        applyClockUniforms(gl, locs);
        if (locs.u_mouse) {
            gl.uniform2f(locs.u_mouse,
                ShaderPreview.mouseX,
                ShaderPreview.mouseY);
        }

        // Set camera texture (current video frame, shared, uploaded once per frame)
        if (locs.u_camera) {
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, this.updateCameraTexture());
            gl.uniform1i(locs.u_camera, 0);
        }

        const uniformsToSet = this.customUniformValues || [];
        const n = uniformsToSet.length;

        // Set custom uniforms - update values from UniformRegistry if available
        if (n > 0) {
            // If we have a uniform registry, update values from it
            const registry = this.uniformRegistry;
            if (registry) {
                for (let i = 0; i < n; i++) {
                    const uniform = uniformsToSet[i];
                    const registryUniform = registry.getUniform(uniform.name);
                    if (registryUniform) {
                        uniform.value = registryUniform.value;
                    }
                }
            } else if (!this._warnedRegistry) {
                this._warnedRegistry = true;
                console.warn('[ShaderPreview] No uniformRegistry! Cannot fetch realtime uniform values');
            }

            let textureUnit = 1; // Start at 1 since camera uses 0

            for (let i = 0; i < n; i++) {
                const uniform = uniformsToSet[i];
                const location = locs[uniform.name];

                if (location !== null && location !== undefined) {
                    const v = uniform.value;
                    switch (uniform.type) {
                        case 'float':
                            // Update microphone RMS value each frame if this is a microphone node
                            if (uniform.microphoneNode && uniform.microphoneNode.isActive) {
                                uniform.value = uniform.microphoneNode.getRMS();
                            }
                            // Update MIDI CC value each frame if this is a MIDI CC node
                            if (uniform.midiCCNode) {
                                uniform.value = uniform.midiCCNode.getValue();
                            }
                            gl.uniform1f(location, uniform.value);
                            break;
                        case 'int':
                            gl.uniform1i(location, v);
                            break;
                        case 'bool':
                            // GLSL bools are set as integers (0 or 1)
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
                            // Node-owned textures (image Param, JS outputs, audio textures) are
                            // re-resolved per draw: audio textures update on their first bind of a
                            // frame, also inside pinned renders (render_preview)
                            if (uniform.textureOwner) uniform.texture = uniform.textureOwner.liveTexture(uniform.textureKey);
                            if (uniform.texture) {
                                gl.activeTexture(gl.TEXTURE0 + textureUnit);
                                gl.bindTexture(gl.TEXTURE_2D, uniform.texture);
                                gl.uniform1i(location, textureUnit);
                                textureUnit++;
                            } else {
                                // Programs are shared: don't inherit another renderer's unit
                                gl.uniform1i(location, 0);
                            }
                            break;
                    }
                }
                // (uniforms this shader doesn't use are skipped: different shaders use different subsets)
            }
        }

        // Extra per-draw uniforms (debug probes: sample-point mapping)
        if (this.onSetUniforms) this.onSetUniforms(gl, locs);

        // Setup vertex attributes
        let positionLocation = this._attrib;
        if (positionLocation === undefined || this._entry === null) positionLocation = gl.getAttribLocation(program, 'a_position');
        gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
        gl.enableVertexAttribArray(positionLocation);
        gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);

        // Draw
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

        // Unbind framebuffer
        if (this.usingSharedContext && this.framebuffer) {
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        }
    }

    /** Free this renderer's GPU objects (the shared program / quad / camera texture are refcounted or shared). */
    destroy() {
        this.stopRendering();
        this._cancelPending();
        const gl = this.gl;
        if (gl) {
            this._releaseEntry();
            if (this._rawProgram) {
                try { gl.deleteProgram(this._rawProgram); } catch (e) { /* ignore */ }
                this._rawProgram = null;
            }
            if (this.framebuffer && this.framebuffer.texture) {
                try {
                    gl.deleteTexture(this.framebuffer.texture);
                    gl.deleteFramebuffer(this.framebuffer.framebuffer);
                } catch (e) { /* context lost */ }
                this.framebuffer = null;
            }
        }
        // Only stop a camera this renderer started itself (the video element is shared)
        if (this.cameraStream) this.disableCamera();
    }
}
