export class FeedbackRenderer {
    constructor(nodeGraph, shaderCompiler, sharedGL, uniformRegistry = null) {
        this.nodeGraph = nodeGraph;
        this.shaderCompiler = shaderCompiler;
        this.gl = sharedGL;
        this.uniformRegistry = uniformRegistry;

        if (!this.gl) {
            console.error('FeedbackRenderer: No shared WebGL context provided');
            return;
        }

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

        const gl = this.gl;


        for (const feedbackNode of feedbackNodes) {
            // Initialize buffers if needed (all in shared context now)
            if (!feedbackNode.buffersInitialized) {
                feedbackNode.initBuffers(gl);
            }

            // Skip if no compiled shader
            if (!feedbackNode.compiledShader) {
                continue;
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
                        const oldTexture = uniform.texture;
                        uniform.texture = feedbackNode.getReadTexture();
                        if (Math.random() < 0.01) {
                            console.log(`[FeedbackRenderer] Updated self-referencing texture for node ${feedbackNode.id}: ${oldTexture} -> ${uniform.texture}`);
                        }
                    }
                }
            }

            // Render to the feedback node's write buffer
            if (Math.random() < 0.01) {
                console.log(`[FeedbackRenderer] Rendering node ${feedbackNode.id} to framebuffer`);
            }

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

            if (Math.random() < 0.01) {
                console.log(`[FeedbackRenderer] Swapped buffers for node ${feedbackNode.id}`);
            }
        }
    }

    injectFeedbackTextures(shaderResult, targetGl) {
        // Find all feedback node uniforms and inject their textures
        if (!shaderResult.uniformValues) {
            console.log('[FeedbackRenderer] injectFeedbackTextures: No uniformValues');
            return;
        }

        console.log(`[FeedbackRenderer] injectFeedbackTextures: Processing ${shaderResult.uniformValues.length} uniforms`);

        for (const uniform of shaderResult.uniformValues) {
            console.log(`[FeedbackRenderer] Checking uniform:`, uniform);

            // Inject feedback textures
            if (uniform.type === 'sampler2D' && uniform.feedbackNodeId !== undefined) {
                // Find the feedback node
                const feedbackNode = this.nodeGraph.nodes.find(n => n.id === uniform.feedbackNodeId);
                if (feedbackNode && feedbackNode.isFeedbackNode) {
                    // Initialize buffers in shared context if needed
                    if (!feedbackNode.buffersInitialized) {
                        feedbackNode.initBuffers(this.gl);
                    }

                    // Store reference to feedback node for per-frame updates
                    uniform.feedbackNode = feedbackNode;

                    // Get the read texture (previous frame) - all in same context now!
                    const sourceTexture = feedbackNode.getReadTexture();
                    uniform.texture = sourceTexture;
                } else {
                    console.error(`[FeedbackRenderer] Could not find feedback node ${uniform.feedbackNodeId}`);
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

            // Inject MIDI CC values
            if (uniform.type === 'float' && uniform.midiCCNodeId !== undefined) {
                const midiNode = this.nodeGraph.nodes.find(n => n.id === uniform.midiCCNodeId);
                if (midiNode && midiNode.isMidiCCNode) {
                    // Store reference to MIDI CC node so it can be updated each frame
                    uniform.midiCCNode = midiNode;
                    // Initialize with current value
                    uniform.value = midiNode.getValue();
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
                // Update values from UniformRegistry if available (for constant nodes)
                if (this.uniformRegistry && uniform.feedbackNodeId === undefined && uniform.microphoneNodeId === undefined && uniform.midiCCNodeId === undefined) {
                    const registryUniform = this.uniformRegistry.getUniform(uniform.name);
                    if (registryUniform) {
                        uniform.value = registryUniform.value;
                    }
                }

                const location = programData.uniforms[uniform.name];
                if (location !== null && location !== undefined) {
                    if (uniform.type === 'float') {
                        // Update microphone RMS if applicable
                        if (uniform.microphoneNode && uniform.microphoneNode.isActive) {
                            uniform.value = uniform.microphoneNode.getRMS();
                        }
                        // Update MIDI CC value if applicable
                        if (uniform.midiCCNode) {
                            uniform.value = uniform.midiCCNode.getValue();
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
