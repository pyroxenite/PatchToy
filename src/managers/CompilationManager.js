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

        // Just compile preview nodes - no main output anymore
        this.compilePreviewNodes();
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
    }

    updateUniformsForNode(changedNode) {
        // Optimized: Only update the specific uniform for the changed node
        if (!changedNode.data || !changedNode.data.useUniform || !changedNode.definition) {
            return;
        }

        // Get the uniform info for this specific node
        const glslResult = changedNode.definition.glsl(changedNode, {});
        if (!glslResult || !glslResult.uniforms || glslResult.uniforms.length === 0) {
            return;
        }

        const updatedUniforms = glslResult.uniforms;

        // Update in main preview
        if (this.shaderPreview && this.shaderPreview.customUniformValues) {
            for (const uniform of this.shaderPreview.customUniformValues) {
                const updated = updatedUniforms.find(u => u.name === uniform.name);
                if (updated) {
                    uniform.value = updated.value;
                }
            }
        }

        // Update in all preview nodes
        const previewNodes = this.nodeGraph.nodes.filter(n => n.isPreviewNode);
        for (const previewNode of previewNodes) {
            if (previewNode.previewInstance && previewNode.previewInstance.customUniformValues) {
                for (const uniform of previewNode.previewInstance.customUniformValues) {
                    const updated = updatedUniforms.find(u => u.name === uniform.name);
                    if (updated) {
                        uniform.value = updated.value;
                    }
                }
            }
        }

        // No need to trigger render - ShaderPreview has its own animation loop
        // that will pick up the updated uniform values automatically
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
