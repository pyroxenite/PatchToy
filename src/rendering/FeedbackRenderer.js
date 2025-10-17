export class FeedbackRenderer {
    constructor(nodeGraph, shaderCompiler, shaderPreview) {
        this.nodeGraph = nodeGraph;
        this.shaderCompiler = shaderCompiler;
        this.shaderPreview = shaderPreview;

        // Create our own WebGL context for feedback rendering
        this.canvas = document.createElement('canvas');
        this.canvas.width = 512;
        this.canvas.height = 512;
        this.gl = this.canvas.getContext('webgl2') || this.canvas.getContext('webgl');

        if (!this.gl) {
            console.error('FeedbackRenderer: Failed to create WebGL context');
            return;
        }

        // Create position buffer for fullscreen quad
        this.positionBuffer = this.gl.createBuffer();
        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.positionBuffer);
        this.gl.bufferData(this.gl.ARRAY_BUFFER, new Float32Array([
            -1, -1,
             1, -1,
            -1,  1,
             1,  1
        ]), this.gl.STATIC_DRAW);

        // Track start time for u_time uniform
        this.startTime = Date.now();
    }

    compileFeedbackShaders() {
        // Compile shaders for all feedback nodes (called when graph changes)
        const feedbackNodes = this.nodeGraph.nodes.filter(n => n.isFeedbackNode);

        for (const feedbackNode of feedbackNodes) {
            // Find the input connection
            const inputConnection = this.nodeGraph.connections.find(
                conn => conn.toNode === feedbackNode && conn.toInput === 0
            );

            if (!inputConnection) {
                feedbackNode.compiledShader = null;
                feedbackNode.compiledProgram = null;
                continue;
            }

            // Compile the shader source
            const shader = this.shaderCompiler.compileFromNodeAsOutput(
                inputConnection.fromNode,
                inputConnection.fromOutput,
                this.nodeGraph
            );

            if (!shader || !shader.fragment) {
                feedbackNode.compiledShader = null;
                feedbackNode.compiledProgram = null;
                continue;
            }

            // Inject feedback textures (for feedback loops where output connects to input)
            this.injectFeedbackTextures(shader, this.gl);

            // Store the compiled shader (will compile GL program on first render)
            feedbackNode.compiledShader = shader;
            feedbackNode.compiledProgram = null; // Will be created on first render
        }
    }

    renderFeedbackNodes() {
        // Render feedback nodes every frame
        const feedbackNodes = this.nodeGraph.nodes.filter(n => n.isFeedbackNode);

        if (feedbackNodes.length === 0) return;

        // Debug: Log feedback node count
        if (Math.random() < 0.01) {
            console.log(`[FeedbackRenderer] Rendering ${feedbackNodes.length} feedback node(s)`);
        }

        for (const feedbackNode of feedbackNodes) {
            // Skip if buffers not initialized yet (will be done when first preview node uses it)
            if (!feedbackNode.buffersInitialized) {
                continue;
            }

            // Use the GL context that the buffers were created in
            const gl = feedbackNode.gl;
            if (!gl) {
                console.warn(`[FeedbackRenderer] Node ${feedbackNode.id} has no GL context`);
                continue;
            }

            // Skip if no compiled shader
            if (!feedbackNode.compiledShader) {
                if (Math.random() < 0.01) {
                    console.warn(`[FeedbackRenderer] Node ${feedbackNode.id} has no compiled shader`);
                }
                continue;
            }

            if (Math.random() < 0.01) {
                console.log(`[FeedbackRenderer] Rendering feedback node ${feedbackNode.id}`);
            }

            // Compile GL program if not already compiled
            if (!feedbackNode.compiledProgram) {
                feedbackNode.compiledProgram = this.compileFeedbackProgram(gl, feedbackNode.compiledShader);
                if (!feedbackNode.compiledProgram) {
                    continue;
                }
            }

            // Before rendering: Update feedback texture reference for self-loops
            if (feedbackNode.compiledShader.uniformValues) {
                for (const uniform of feedbackNode.compiledShader.uniformValues) {
                    if (uniform.type === 'sampler2D' && uniform.feedbackNodeId === feedbackNode.id) {
                        // Update texture to current read buffer (previous frame)
                        uniform.texture = feedbackNode.getReadTexture();
                    }
                }
            }

            // Render to the feedback node's write buffer
            this.renderToFramebufferWithProgram(
                gl,
                feedbackNode.compiledProgram,
                feedbackNode.compiledShader,
                feedbackNode.getWriteFramebuffer(),
                feedbackNode.data.width,
                feedbackNode.data.height
            );

            // Swap buffers for next frame (read becomes write, write becomes read)
            feedbackNode.swap();
        }
    }

    injectFeedbackTextures(shaderResult, targetGl) {
        // Find all feedback node uniforms and inject their textures
        if (!shaderResult.uniformValues) {
            return;
        }

        for (const uniform of shaderResult.uniformValues) {
            // Inject feedback textures
            if (uniform.type === 'sampler2D' && uniform.feedbackNodeId !== undefined) {
                // Find the feedback node
                const feedbackNode = this.nodeGraph.nodes.find(n => n.id === uniform.feedbackNodeId);
                if (feedbackNode && feedbackNode.isFeedbackNode) {
                    // IMPORTANT: Initialize buffers in the TARGET context (preview node's GL)
                    // not in FeedbackRenderer's GL, so textures can be shared
                    if (!feedbackNode.buffersInitialized && targetGl) {
                        feedbackNode.initBuffers(targetGl);
                        console.log(`[FeedbackRenderer] Initialized feedback buffers in preview context for node ${feedbackNode.id}`);
                    }

                    // Store reference to feedback node for per-frame updates
                    uniform.feedbackNode = feedbackNode;
                    uniform.feedbackNodeInitializedInContext = targetGl;

                    // Get the read texture (previous frame)
                    const sourceTexture = feedbackNode.getReadTexture();
                    uniform.texture = sourceTexture;
                }
            }

            // Inject microphone RMS values
            if (uniform.type === 'float' && uniform.microphoneNodeId !== undefined) {
                const micNode = this.nodeGraph.nodes.find(n => n.id === uniform.microphoneNodeId);
                if (micNode && micNode.isMicrophoneNode) {
                    // Store reference to microphone node so it can be updated each frame
                    uniform.microphoneNode = micNode;
                    // Initialize with current RMS value
                    uniform.value = micNode.getRMS();
                }
            }
        }
    }

    copyTextureToContext(sourceGl, sourceTexture, targetGl, width, height) {
        // Read pixels from source texture
        const framebuffer = sourceGl.createFramebuffer();
        sourceGl.bindFramebuffer(sourceGl.FRAMEBUFFER, framebuffer);
        sourceGl.framebufferTexture2D(sourceGl.FRAMEBUFFER, sourceGl.COLOR_ATTACHMENT0, sourceGl.TEXTURE_2D, sourceTexture, 0);

        const pixels = new Uint8Array(width * height * 4);
        sourceGl.readPixels(0, 0, width, height, sourceGl.RGBA, sourceGl.UNSIGNED_BYTE, pixels);

        sourceGl.bindFramebuffer(sourceGl.FRAMEBUFFER, null);
        sourceGl.deleteFramebuffer(framebuffer);

        // Create texture in target context
        const targetTexture = targetGl.createTexture();
        targetGl.bindTexture(targetGl.TEXTURE_2D, targetTexture);
        targetGl.texImage2D(targetGl.TEXTURE_2D, 0, targetGl.RGBA, width, height, 0, targetGl.RGBA, targetGl.UNSIGNED_BYTE, pixels);
        targetGl.texParameteri(targetGl.TEXTURE_2D, targetGl.TEXTURE_MIN_FILTER, targetGl.LINEAR);
        targetGl.texParameteri(targetGl.TEXTURE_2D, targetGl.TEXTURE_MAG_FILTER, targetGl.LINEAR);
        targetGl.texParameteri(targetGl.TEXTURE_2D, targetGl.TEXTURE_WRAP_S, targetGl.CLAMP_TO_EDGE);
        targetGl.texParameteri(targetGl.TEXTURE_2D, targetGl.TEXTURE_WRAP_T, targetGl.CLAMP_TO_EDGE);
        targetGl.bindTexture(targetGl.TEXTURE_2D, null);

        return targetTexture;
    }

    compileFeedbackProgram(gl, shader) {
        // Compile vertex shader
        const vertexShader = gl.createShader(gl.VERTEX_SHADER);
        gl.shaderSource(vertexShader, shader.vertex);
        gl.compileShader(vertexShader);
        if (!gl.getShaderParameter(vertexShader, gl.COMPILE_STATUS)) {
            console.error('Feedback vertex shader error:', gl.getShaderInfoLog(vertexShader));
            return null;
        }

        // Compile fragment shader
        const fragmentShader = gl.createShader(gl.FRAGMENT_SHADER);
        gl.shaderSource(fragmentShader, shader.fragment);
        gl.compileShader(fragmentShader);
        if (!gl.getShaderParameter(fragmentShader, gl.COMPILE_STATUS)) {
            console.error('Feedback fragment shader error:', gl.getShaderInfoLog(fragmentShader));
            return null;
        }

        // Link program
        const program = gl.createProgram();
        gl.attachShader(program, vertexShader);
        gl.attachShader(program, fragmentShader);
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
            console.error('Feedback program link error:', gl.getProgramInfoLog(program));
            return null;
        }

        // Get uniform locations
        const uniforms = {};
        const uniformCount = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
        for (let i = 0; i < uniformCount; i++) {
            const info = gl.getActiveUniform(program, i);
            const location = gl.getUniformLocation(program, info.name);
            uniforms[info.name] = location;
        }

        // Get attribute location
        const positionLocation = gl.getAttribLocation(program, 'a_position');

        return { program, uniforms, positionLocation };
    }

    renderToFramebufferWithProgram(gl, programData, shader, framebuffer, width, height) {
        // Bind the framebuffer
        gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
        gl.viewport(0, 0, width, height);

        // Use the shader program
        gl.useProgram(programData.program);

        // Set standard uniforms
        if (programData.uniforms.u_resolution) {
            gl.uniform2f(programData.uniforms.u_resolution, width, height);
        }
        if (programData.uniforms.u_time) {
            gl.uniform1f(programData.uniforms.u_time, (Date.now() - this.startTime) / 1000.0);
        }

        // Set custom uniforms from shader compilation
        if (shader.uniformValues) {
            let textureUnit = 0;
            for (const uniform of shader.uniformValues) {
                const location = programData.uniforms[uniform.name];
                if (location !== null && location !== undefined) {
                    if (uniform.type === 'float') {
                        // Update microphone RMS if applicable
                        if (uniform.microphoneNode && uniform.microphoneNode.isActive) {
                            uniform.value = uniform.microphoneNode.getRMS();
                        }
                        gl.uniform1f(location, uniform.value);
                    } else if (uniform.type === 'sampler2D' && uniform.texture) {
                        // Bind feedback texture
                        gl.activeTexture(gl.TEXTURE0 + textureUnit);
                        gl.bindTexture(gl.TEXTURE_2D, uniform.texture);
                        gl.uniform1i(location, textureUnit);
                        textureUnit++;
                    }
                }
            }
        }

        // Draw fullscreen quad - create position buffer if needed in this context
        if (!gl.__feedbackPositionBuffer) {
            gl.__feedbackPositionBuffer = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, gl.__feedbackPositionBuffer);
            gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
                -1, -1,
                 1, -1,
                -1,  1,
                 1,  1
            ]), gl.STATIC_DRAW);
        }
        gl.bindBuffer(gl.ARRAY_BUFFER, gl.__feedbackPositionBuffer);
        gl.enableVertexAttribArray(programData.positionLocation);
        gl.vertexAttribPointer(programData.positionLocation, 2, gl.FLOAT, false, 0, 0);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

        // Unbind framebuffer
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
}
