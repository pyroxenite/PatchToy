export class CompilationManager {
    constructor(nodeGraph, shaderCompiler, shaderPreview, backgroundRenderer = null, feedbackRenderer = null) {
        this.nodeGraph = nodeGraph;
        this.shaderCompiler = shaderCompiler;
        this.shaderPreview = shaderPreview;
        this.backgroundRenderer = backgroundRenderer;
        this.feedbackRenderer = feedbackRenderer;
        this.autoCompile = true;
        this.compileTimeout = null;
    }

    scheduleCompile() {
        if (!this.autoCompile) return;

        // Debounce compilation
        if (this.compileTimeout) {
            clearTimeout(this.compileTimeout);
        }

        this.compileTimeout = setTimeout(() => {
            this.compile();
        }, 100); // 100ms debounce
    }

    compile() {
        // Clear all error states
        for (const node of this.nodeGraph.nodes) {
            node.hasError = false;
        }

        // Note: Global node ID mapping should already be created by onGraphChanged handler
        // If not (e.g., initial load), create it now
        if (!this.globalNodeIdRemap || this.globalNodeIdRemap.size === 0) {
            this.createGlobalNodeIdMapping();
        }

        // Just compile preview nodes - no main output anymore
        this.compilePreviewNodes();
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

    compilePreviewNodes() {
        // Find all preview nodes
        const previewNodes = this.nodeGraph.nodes.filter(n => n.isPreviewNode);
        let anyErrors = false;

        for (const previewNode of previewNodes) {
            // Check if preview node has any input connections
            const hasConnection = this.nodeGraph.connections.some(
                conn => conn.toNode === previewNode
            );

            // If no connection, clear the shader to show TV static
            if (!hasConnection) {
                if (previewNode.previewInstance) {
                    previewNode.previewInstance.program = null;
                }
                continue;
            }

            // Temporarily treat this preview node as the output
            const shader = this.shaderCompiler.compileForPreviewNode(previewNode, this.nodeGraph);

            // Log compiled shader for debugging
            if (shader && shader.fragment) {
                // Uncomment to debug shaders:
                // console.log('='.repeat(60));
                // console.log(`Compiled shader for Preview Node ${previewNode.id}:`);
                // console.log('='.repeat(60));
                // console.log(shader.fragment);
                // console.log('='.repeat(60));
            }

            // Inject feedback textures if feedbackRenderer is available
            if (shader && this.feedbackRenderer && previewNode.previewInstance) {
                this.feedbackRenderer.injectFeedbackTextures(shader, previewNode.previewInstance.gl);
            }

            if (shader && previewNode.previewInstance) {
                // Store shader source for code inspection (even if compilation fails)
                previewNode.lastCompiledShader = shader;

                const success = previewNode.previewInstance.loadShader(shader);

                // If this preview node is the background, update background renderer too
                if (success && this.backgroundRenderer && previewNode.isBackground) {
                    this.backgroundRenderer.updateShader(previewNode, shader);
                }

                // If shader compilation failed, try to find error node
                if (!success) {
                    anyErrors = true;

                    // Check for WebGL errors
                    if (shader.webglErrors && shader.webglErrors.length > 0) {
                        const errorString = shader.webglErrors.join('\n');

                        // Display error message
                        this.showError(errorString);

                        const errorNodeId = this.shaderCompiler.parseWebGLError(errorString);
                        if (errorNodeId !== null) {
                            const errorNode = this.nodeGraph.nodes.find(n => n.id === errorNodeId);
                            if (errorNode) {
                                errorNode.hasError = true;
                            }
                        }
                    }
                    // Also mark the preview node itself
                    previewNode.hasError = true;
                    this.nodeGraph.render();
                }
            }
        }

        // If all shaders compiled successfully, hide the error display
        if (!anyErrors) {
            this.hideError();
        }

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

            // Also register uniforms from background renderer if active
            if (this.backgroundRenderer && this.backgroundRenderer.shaderPreview &&
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
        }
    }

    // Find a node by its remapped variable name (e.g., "node_5")
    findNodeByRemappedName(varName) {
        if (!this.shaderCompiler.nodeIdRemap) return null;

        // Extract the remapped ID from the variable name (e.g., "node_5" -> 5)
        const match = varName.match(/^node_(\d+)$/);
        if (!match) return null;

        const remappedId = parseInt(match[1]);

        // Find the original node ID that maps to this remapped ID
        for (const [originalId, mappedId] of this.shaderCompiler.nodeIdRemap.entries()) {
            if (mappedId === remappedId) {
                return this.nodeGraph.nodes.find(n => n.id === originalId);
            }
        }

        return null;
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

    hideError() {
        const errorDiv = document.getElementById('errorDisplay');
        if (errorDiv) {
            errorDiv.style.display = 'none';
        }
    }

    showError(errorString) {
        this.showErrors([errorString]);
    }

    showErrors(errors) {
        console.log('[CompilationManager] showErrors called, errors:', errors);
        const errorDiv = document.getElementById('errorDisplay') || this.createErrorDisplay();
        console.log('[CompilationManager] errorDiv element:', errorDiv, 'display:', errorDiv.style.display);

        errorDiv.innerHTML = '';
        errorDiv.style.display = 'block';

        errors.forEach(error => {
            const errorItem = document.createElement('div');
            errorItem.textContent = '⚠ ' + error;
            errorItem.style.padding = '4px 0';
            errorDiv.appendChild(errorItem);
        });

        // Add close button
        const closeBtn = document.createElement('button');
        closeBtn.textContent = '×';
        closeBtn.style.position = 'absolute';
        closeBtn.style.top = '4px';
        closeBtn.style.right = '4px';
        closeBtn.style.padding = '0 6px';
        closeBtn.style.background = 'transparent';
        closeBtn.style.border = 'none';
        closeBtn.style.color = '#fff';
        closeBtn.style.cursor = 'pointer';
        closeBtn.style.fontSize = '20px';
        closeBtn.onclick = () => errorDiv.style.display = 'none';
        errorDiv.appendChild(closeBtn);

        // Errors don't auto-hide - user must dismiss or fix
    }

    showSuccess(message) {
        const errorDiv = document.getElementById('errorDisplay') || this.createErrorDisplay();
        errorDiv.innerHTML = '';
        errorDiv.style.display = 'block';
        errorDiv.style.background = '#2d5016';
        errorDiv.style.borderColor = '#4caf50';

        const successItem = document.createElement('div');
        successItem.textContent = '✓ ' + message;
        errorDiv.appendChild(successItem);

        setTimeout(() => {
            errorDiv.style.display = 'none';
            errorDiv.style.background = '#5d1f1f';
            errorDiv.style.borderColor = '#f44336';
        }, 2000);
    }

    createErrorDisplay() {
        const errorDiv = document.createElement('div');
        errorDiv.id = 'errorDisplay';
        errorDiv.style.position = 'absolute';
        errorDiv.style.bottom = '20px';
        errorDiv.style.left = '20px';
        errorDiv.style.background = '#5d1f1f';
        errorDiv.style.color = '#fff';
        errorDiv.style.padding = '12px';
        errorDiv.style.borderRadius = '4px';
        errorDiv.style.border = '1px solid #f44336';
        errorDiv.style.zIndex = '1000';
        errorDiv.style.maxWidth = '400px';
        errorDiv.style.display = 'none';
        errorDiv.style.fontSize = '13px';
        document.getElementById('container').appendChild(errorDiv);
        return errorDiv;
    }
}
