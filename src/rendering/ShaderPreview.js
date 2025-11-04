export class ShaderPreview {
    constructor(canvas, videoElement, options = {}) {
        this.videoElement = videoElement;
        this.isOffscreen = options.offscreen || false;
        this.nodeId = options.nodeId || null;
        this.canManageCamera = !this.isOffscreen; // Only main preview manages camera

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
        this.startTime = Date.now();
        this.animationId = null;
        this.cameraTexture = null;
        this.cameraEnabled = false;
        this.cameraStream = null;
        this.customUniformValues = [];
        this.uniforms = {};

        this.setupGeometry();
        this.setupCameraTexture();
        this.setupNoiseShader();

        // Start animation loop for all instances (needed for noise shader)
        this.animate();
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
        // Create a simple noise shader for when no program is loaded
        const gl = this.gl;

        const vertexShaderSource = `#version 300 es
        in vec2 a_position;
        void main() {
            gl_Position = vec4(a_position, 0.0, 1.0);
        }`;

        const fragmentShaderSource = `#version 300 es
        precision highp float;
        uniform float u_time;
        uniform vec2 u_resolution;
        out vec4 fragColor;

        // Better hash function for noise (less repetition)
        float hash(vec2 p) {
            vec3 p3 = fract(vec3(p.xyx) * 0.1031);
            p3 += dot(p3, p3.yzx + 33.33);
            return fract((p3.x + p3.y) * p3.z);
        }

        void main() {
            // Lower spatial resolution - make bigger pixels (4x4 blocks)
            vec2 pixelSize = vec2(4.0);
            vec2 uv = floor(gl_FragCoord.xy / pixelSize);

            // Animate the noise over time with better randomness
            float t = u_time * 10.0;
            float noise = hash(uv + vec2(t * 1.3, t * 0.7));

            // Add some subtle scanlines (less frequent)
            float scanline = sin(gl_FragCoord.y * 3.14159 * 0.5) * 0.03;
            noise += scanline;

            fragColor = vec4(vec3(noise * 0.7), 1.0);
        }`;

        const vertexShader = gl.createShader(gl.VERTEX_SHADER);
        gl.shaderSource(vertexShader, vertexShaderSource);
        gl.compileShader(vertexShader);

        const fragmentShader = gl.createShader(gl.FRAGMENT_SHADER);
        gl.shaderSource(fragmentShader, fragmentShaderSource);
        gl.compileShader(fragmentShader);

        this.noiseProgram = gl.createProgram();
        gl.attachShader(this.noiseProgram, vertexShader);
        gl.attachShader(this.noiseProgram, fragmentShader);
        gl.linkProgram(this.noiseProgram);

        // Get uniform locations for noise shader
        this.noiseUniforms = {
            u_time: gl.getUniformLocation(this.noiseProgram, 'u_time'),
            u_resolution: gl.getUniformLocation(this.noiseProgram, 'u_resolution')
        };
    }

    setupGeometry() {
        const gl = this.gl;

        // Create a full-screen quad
        const positions = new Float32Array([
            -1, -1,
            1, -1,
            -1, 1,
            1, 1,
        ]);

        this.positionBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);
    }

    setupCameraTexture() {
        const gl = this.gl;
        this.cameraTexture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, this.cameraTexture);

        // Set texture parameters
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

        // Initialize with a 1x1 black pixel
        const pixel = new Uint8Array([0, 0, 0, 255]);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
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

    updateCameraTexture() {
        // Check if video element has valid data (works for both main and offscreen instances)
        if (!this.videoElement || !this.videoElement.readyState || this.videoElement.readyState < 2) {
            return;
        }

        // Check if video is actually playing (camera is enabled somewhere)
        if (this.videoElement.paused || this.videoElement.srcObject === null) {
            return;
        }

        const gl = this.gl;
        gl.bindTexture(gl.TEXTURE_2D, this.cameraTexture);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.videoElement);
    }

    loadShader(shaderSource, onError) {
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

        // Compile vertex shader
        const vertexShader = gl.createShader(gl.VERTEX_SHADER);
        gl.shaderSource(vertexShader, shaderSource.vertex);
        gl.compileShader(vertexShader);

        if (!gl.getShaderParameter(vertexShader, gl.COMPILE_STATUS)) {
            const error = gl.getShaderInfoLog(vertexShader);
            console.error((this.isOffscreen ? 'Preview node v' : 'V') + 'ertex shader' + (this.isOffscreen ? '' : ' compile') + ' error:', error);
            if (onError) onError('Vertex shader compile error:\n' + error);
            shaderSource.webglErrors.push(error);
            return false;
        }

        // Compile fragment shader
        const fragmentShader = gl.createShader(gl.FRAGMENT_SHADER);
        gl.shaderSource(fragmentShader, shaderSource.fragment);
        gl.compileShader(fragmentShader);

        if (!gl.getShaderParameter(fragmentShader, gl.COMPILE_STATUS)) {
            const error = gl.getShaderInfoLog(fragmentShader);
            console.error((this.isOffscreen ? 'Preview node f' : 'F') + 'ragment shader' + (this.isOffscreen ? '' : ' compile') + ' error:', error);
            if (onError) onError('Fragment shader compile error:\n' + error);
            shaderSource.webglErrors.push(error);
            return false;
        }

        // Link program
        const program = gl.createProgram();
        gl.attachShader(program, vertexShader);
        gl.attachShader(program, fragmentShader);
        gl.linkProgram(program);

        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
            const error = gl.getProgramInfoLog(program);
            console.error((this.isOffscreen ? 'Preview node p' : 'P') + 'rogram link error:', error);
            if (onError) onError('Program link error:\n' + error);
            shaderSource.webglErrors.push(error);
            return false;
        }

        // Clean up old program
        if (this.program) {
            gl.deleteProgram(this.program);
        }

        this.program = program;
        this.customUniformValues = shaderSource.uniformValues || []; // Store custom uniform values

        // Get all uniform locations dynamically
        this.uniforms = {};
        const numUniforms = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
        for (let i = 0; i < numUniforms; i++) {
            const info = gl.getActiveUniform(program, i);
            this.uniforms[info.name] = gl.getUniformLocation(program, info.name);
        }

        if (!this.isOffscreen) {
        }

        // Start animation
        if (!this.animationId) {
            this.animate();
        }

        return true;
    }

    animate() {
        // Call pre-render callback if set (for feedback nodes and texture updates)
        if (this.onBeforeRender) {
            this.onBeforeRender();
        }

        // Update feedback texture references before rendering
        if (this.customUniformValues && this.customUniformValues.length > 0) {
            for (const uniform of this.customUniformValues) {
                // Update feedback texture each frame (all in same context now!)
                if (uniform.type === 'sampler2D' && uniform.feedbackNodeId !== undefined && uniform.feedbackNode) {
                    uniform.texture = uniform.feedbackNode.getReadTexture();
                }
            }
        }

        this.render();
        this.animationId = requestAnimationFrame(() => this.animate());
    }

    stopRendering() {
        if (this.animationId) {
            cancelAnimationFrame(this.animationId);
            this.animationId = null;
            console.log('Rendering stopped');
        }
    }

    render() {
        const gl = this.gl;

        // Bind framebuffer if using shared context
        if (this.usingSharedContext && this.framebuffer) {
            gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer.framebuffer);
        }

        // Get dimensions (from canvas or framebuffer)
        const width = this.usingSharedContext ? this.width : this.canvas.width;
        const height = this.usingSharedContext ? this.height : this.canvas.height;

        if (!this.program) {
            // Render TV static noise when no program is loaded
            if (this.noiseProgram) {
                gl.viewport(0, 0, width, height);
                gl.useProgram(this.noiseProgram);

                // Set uniforms for noise shader
                if (this.noiseUniforms.u_resolution) {
                    gl.uniform2f(this.noiseUniforms.u_resolution, width, height);
                }
                if (this.noiseUniforms.u_time) {
                    gl.uniform1f(this.noiseUniforms.u_time, (Date.now() - this.startTime) / 1000.0);
                }

                // Setup vertex attributes
                const positionLocation = gl.getAttribLocation(this.noiseProgram, 'a_position');
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

        // Always try to update camera texture (will check internally if video is playing)
        this.updateCameraTexture();

        gl.viewport(0, 0, width, height);
        gl.useProgram(this.program);

        // Set standard uniforms
        if (this.uniforms.u_resolution) {
            gl.uniform2f(this.uniforms.u_resolution, width, height);
        }
        if (this.uniforms.u_time) {
            gl.uniform1f(this.uniforms.u_time, (Date.now() - this.startTime) / 1000.0);
        }
        if (this.uniforms.u_mouse) {
            // TODO: Track mouse position
            gl.uniform2f(this.uniforms.u_mouse, 0.0, 0.0);
        }

        // Set camera texture
        if (this.uniforms.u_camera) {
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, this.cameraTexture);
            gl.uniform1i(this.uniforms.u_camera, 0);
        }

        // Set custom uniforms from Float/Vec nodes
        if (this.customUniformValues && this.customUniformValues.length > 0) {
            let textureUnit = 1; // Start at 1 since camera uses 0

            for (const uniform of this.customUniformValues) {
                const location = this.uniforms[uniform.name];
                if (location !== null && location !== undefined) {
                    if (uniform.type === 'float') {
                        // Update microphone RMS value each frame if this is a microphone node
                        if (uniform.microphoneNode && uniform.microphoneNode.isActive) {
                            const rms = uniform.microphoneNode.getRMS();
                            uniform.value = rms;
                            if (Math.random() < 0.01) { // Log 1% of the time to avoid spam
                            }
                        }
                        gl.uniform1f(location, uniform.value);
                    } else if (uniform.type === 'int') {
                        gl.uniform1i(location, uniform.value);
                    } else if (uniform.type === 'bool') {
                        // GLSL bools are set as integers (0 or 1)
                        gl.uniform1i(location, uniform.value ? 1 : 0);
                    } else if (uniform.type === 'vec2') {
                        gl.uniform2f(location, uniform.value[0], uniform.value[1]);
                    } else if (uniform.type === 'vec3') {
                        gl.uniform3f(location, uniform.value[0], uniform.value[1], uniform.value[2]);
                    } else if (uniform.type === 'vec4') {
                        gl.uniform4f(location, uniform.value[0], uniform.value[1], uniform.value[2], uniform.value[3]);
                    } else if (uniform.type === 'sampler2D' && uniform.texture) {
                        // Bind feedback texture
                        gl.activeTexture(gl.TEXTURE0 + textureUnit);
                        gl.bindTexture(gl.TEXTURE_2D, uniform.texture);
                        gl.uniform1i(location, textureUnit);
                        textureUnit++;
                    }
                } else {
                    console.warn('Uniform location not found for:', uniform.name, '| Available uniforms:', Object.keys(this.uniforms));
                }
            }
        }

        // Setup vertex attributes
        const positionLocation = gl.getAttribLocation(this.program, 'a_position');
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

    destroy() {
        if (this.animationId) {
            cancelAnimationFrame(this.animationId);
        }
        if (this.program) {
            this.gl.deleteProgram(this.program);
        }
        this.disableCamera();
    }
}
