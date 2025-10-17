import { NodeDefinitions, TypeSystem } from './NodeDefinitions.js';

export class ShaderCompiler {
    constructor() {
        this.reset();
    }

    reset() {
        this.errors = [];
        this.warnings = [];
        this.generatedCode = [];
        this.uniforms = new Set();
        this.customFunctions = new Map();
        this.compiledNodes = new Map();
        this.errorNodeId = null;
        this.codeToNodeMap = new Map(); // Maps line number to node ID
    }

    compile(nodeGraph) {
        this.reset();

        // Find the output node
        const outputNode = nodeGraph.nodes.find(node => node.definition?.isOutputNode);
        if (!outputNode) {
            this.addError('No output node found in graph');
            return null;
        }

        return this.compileFromOutputNode(outputNode, nodeGraph);
    }

    compileForPreviewNode(previewNode, nodeGraph) {
        this.reset();
        return this.compileFromOutputNode(previewNode, nodeGraph);
    }

    compileFromNodeAsOutput(node, outputIndex, nodeGraph) {
        // Compile starting from a specific node and output as if it were the final output
        this.reset();

        try {
            // Compile the node and its dependencies
            const result = this.compileNode(node, nodeGraph);

            if (!result) {
                return null;
            }

            // Convert the output to vec4 for rendering
            const sourceType = node.outputs[outputIndex].type;
            const finalColor = TypeSystem.convertCode(result.output, sourceType, 'vec4');

            // Build the final shader
            const fragmentShader = this.buildFragmentShader(finalColor);

            // Extract uniform values
            const uniformValues = Array.from(this.uniforms)
                .filter(u => typeof u === 'object' && (u.value !== undefined || u.feedbackNodeId !== undefined || u.microphoneNodeId !== undefined))
                .map(u => {
                    const uniform = { name: u.name, type: u.type };
                    if (u.value !== undefined) uniform.value = u.value;
                    if (u.feedbackNodeId !== undefined) uniform.feedbackNodeId = u.feedbackNodeId;
                    if (u.microphoneNodeId !== undefined) uniform.microphoneNodeId = u.microphoneNodeId;
                    return uniform;
                });

            return {
                vertex: this.getVertexShader(),
                fragment: fragmentShader,
                uniformValues: uniformValues,
                errors: this.errors,
                warnings: this.warnings,
                errorNodeId: this.errorNodeId
            };
        } catch (error) {
            console.error('Shader compilation error:', error);
            this.errors.push(error.message);
            return {
                vertex: this.getVertexShader(),
                fragment: null,
                uniformValues: [],
                errors: this.errors,
                warnings: this.warnings,
                errorNodeId: this.errorNodeId
            };
        }
    }

    compileFromOutputNode(outputNode, nodeGraph) {
        try {
            // Find what's connected to the output
            const outputConnection = nodeGraph.connections.find(
                conn => conn.toNode === outputNode
            );

            let finalColor = 'vec4(1.0, 0.0, 1.0, 1.0)'; // Default magenta

            if (outputConnection) {
                // Compile the graph starting from the output
                const result = this.compileNode(outputConnection.fromNode, nodeGraph);

                if (result) {
                    const sourceType = outputConnection.fromNode.outputs[outputConnection.fromOutput].type;
                    finalColor = TypeSystem.convertCode(result.output, sourceType, 'vec4');
                }
            }

            // Build the final shader
            const fragmentShader = this.buildFragmentShader(finalColor);

            // Extract uniform values from uniforms Set
            const uniformValues = Array.from(this.uniforms)
                .filter(u => typeof u === 'object' && (u.value !== undefined || u.feedbackNodeId !== undefined || u.microphoneNodeId !== undefined))
                .map(u => {
                    const uniform = { name: u.name, type: u.type };
                    if (u.value !== undefined) uniform.value = u.value;
                    if (u.feedbackNodeId !== undefined) uniform.feedbackNodeId = u.feedbackNodeId;
                    if (u.microphoneNodeId !== undefined) uniform.microphoneNodeId = u.microphoneNodeId;
                    return uniform;
                });

            return {
                vertex: this.getVertexShader(),
                fragment: fragmentShader,
                uniformValues: uniformValues,
                errors: this.errors,
                warnings: this.warnings,
                errorNodeId: this.errorNodeId
            };

        } catch (error) {
            this.addError(`Compilation failed: ${error.message}`);
            return {
                vertex: this.getVertexShader(),
                fragment: null,
                uniformValues: [],
                errors: this.errors,
                warnings: this.warnings,
                errorNodeId: this.errorNodeId
            };
        }
    }

    compileNode(node, nodeGraph) {
        // Return cached result if already compiled
        if (this.compiledNodes.has(node.id)) {
            return this.compiledNodes.get(node.id);
        }

        const definition = node.definition;
        if (!definition) {
            this.addError(`Node ${node.type} has no definition`, node.id);
            return null;
        }

        // Special case: output node
        if (definition.isOutputNode) {
            return null;
        }

        // Special case: feedback node - don't traverse inputs, just provide the texture uniform
        if (definition.isFeedbackNode) {
            // Generate GLSL for feedback node (provides sampler2D uniform)
            const result = definition.glsl(node, {});

            // Collect uniforms
            if (result.uniforms) {
                for (const uniform of result.uniforms) {
                    this.uniforms.add(uniform);
                }
            }

            // Cache and return
            this.compiledNodes.set(node.id, result);
            return result;
        }

        // Collect uniforms needed by this node
        if (definition.uniforms) {
            definition.uniforms.forEach(u => this.uniforms.add(u));
        }

        // Compile input connections
        const inputValues = {};
        for (let i = 0; i < node.inputs.length; i++) {
            const input = node.inputs[i];
            const connection = nodeGraph.connections.find(
                conn => conn.toNode === node && conn.toInput === i
            );

            if (connection) {
                // Recursively compile connected node
                const sourceResult = this.compileNode(connection.fromNode, nodeGraph);
                if (sourceResult) {
                    let sourceValue = sourceResult.output;
                    let sourceType = connection.fromNode.outputs[connection.fromOutput].type;

                    // Apply swizzle if present
                    if (connection.swizzle) {
                        sourceValue = sourceValue + connection.swizzle;
                        // Infer type from swizzle
                        sourceType = this.inferSwizzleType(sourceType, connection.swizzle);
                    }

                    const targetType = input.type;

                    // Check type compatibility
                    if (!TypeSystem.canConvert(sourceType, targetType)) {
                        this.addWarning(
                            `Type mismatch: connecting ${sourceType} to ${targetType} in ${node.type}`
                        );
                    }

                    // Auto-convert if needed
                    inputValues[input.name] = TypeSystem.convertCode(
                        sourceValue,
                        sourceType,
                        targetType
                    );
                }
            } else {
                // Use default value
                inputValues[input.name] = input.default;
            }
        }

        // Generate GLSL code for this node
        if (typeof definition.glsl === 'function') {
            const result = definition.glsl(node, inputValues);

            // Collect uniforms from the result
            if (result.uniforms) {
                for (const uniform of result.uniforms) {
                    this.uniforms.add(uniform);
                }
            }

            // Add generated code and track which node it came from
            if (result.code) {
                const { statements, functions } = this.extractFunctionsFromCode(result.code);

                // Hoist any function definitions outside of main()
                for (const func of functions) {
                    this.addCustomFunction(func.name, func.code, node.id);
                }

                for (const line of statements) {
                    const lineIndex = this.generatedCode.length;
                    this.generatedCode.push(line);
                    // Map this line to the node that generated it
                    // Add offset for shader preamble (uniforms, etc.)
                    this.codeToNodeMap.set(lineIndex, node.id);
                }
            }

            // Store custom functions if needed
            if (result.requiresFunction && definition.glslFunction) {
                this.addCustomFunction(result.requiresFunction, definition.glslFunction, node.id);
            }

            // Cache result
            this.compiledNodes.set(node.id, result);
            return result;
        } else {
            this.addError(`Node ${node.type} has invalid glsl generator`, node.id);
            return null;
        }
    }

    buildFragmentShader(finalColor) {
        const uniformDeclarations = Array.from(this.uniforms)
            .map(u => this.getUniformDeclaration(u))
            .join('\n');

        const customFunctionCode = Array.from(this.customFunctions.values())
            .join('\n\n');

        const mainCode = this.generatedCode
            .map(line => '    ' + line)
            .join('\n');

        const shader = `#version 300 es
precision highp float;

${uniformDeclarations}

out vec4 fragColor;

${customFunctionCode}

void main() {
${mainCode}
    fragColor = ${finalColor};
}`;

        // Calculate line offset (how many lines before main() starts)
        // This helps us map error line numbers to generatedCode indices
        const preambleLines = shader.split('void main() {')[0].split('\n').length;
        this.mainCodeStartLine = preambleLines;

        return shader;
    }

    parseWebGLError(errorString) {
        // Parse errors like: "ERROR: 0:13: ..."
        // Line numbers are 1-indexed in the error
        const lineMatch = errorString.match(/ERROR:\s*\d+:(\d+):/);
        if (lineMatch) {
            const errorLine = parseInt(lineMatch[1]) - 1; // Convert to 0-indexed
            const codeLineIndex = errorLine - this.mainCodeStartLine;

            if (this.codeToNodeMap.has(codeLineIndex)) {
                return this.codeToNodeMap.get(codeLineIndex);
            }
        }
        return null;
    }

    getUniformDeclaration(uniform) {
        // Handle old-style string uniforms (like 'u_time')
        if (typeof uniform === 'string') {
            const uniformTypes = {
                'u_time': 'uniform float u_time;',
                'u_resolution': 'uniform vec2 u_resolution;',
                'u_mouse': 'uniform vec2 u_mouse;',
                'u_camera': 'uniform sampler2D u_camera;'
            };
            return uniformTypes[uniform] || `uniform float ${uniform};`;
        }

        // Handle new-style object uniforms (from Float/Vec nodes)
        if (typeof uniform === 'object' && uniform.name && uniform.type) {
            return `uniform ${uniform.type} ${uniform.name};`;
        }

        return '';
    }

    getVertexShader() {
        return `#version 300 es


in vec2 a_position;

void main() {
    gl_Position = vec4(a_position, 0.0, 1.0);
}`;
    }

    addCustomFunction(name, code, nodeId = null) {
        if (!code) return;

        const normalizedCode = code.trim();
        if (!normalizedCode) return;

        const functionName = name || this.extractFunctionName(normalizedCode) || `anon_${this.customFunctions.size}`;
        const existing = this.customFunctions.get(functionName);

        if (existing && existing !== normalizedCode) {
            this.addWarning(`Conflicting GLSL function definitions detected for '${functionName}'. Using latest definition.`);
        }

        this.customFunctions.set(functionName, normalizedCode);
    }

    extractFunctionsFromCode(code) {
        if (!code) {
            return { statements: [], functions: [] };
        }

        const functionHeaderRegex = /^\s*(?:[A-Za-z_]\w*\s+)*[A-Za-z_]\w*\s+[A-Za-z_]\w*\s*\([^;=]*\)\s*(?:\{)?\s*$/;
        const lines = code.split('\n');
        const statements = [];
        const functions = [];

        let capturingFunction = false;
        let waitingForBody = false;
        let braceDepth = 0;
        let buffer = [];

        const countBraceDelta = (line) => {
            const opens = (line.match(/\{/g) || []).length;
            const closes = (line.match(/\}/g) || []).length;
            return opens - closes;
        };

        const flushFunctionBuffer = () => {
            if (buffer.length === 0) return;
            const funcCode = buffer.join('\n');
            const funcName = this.extractFunctionName(funcCode);
            functions.push({ name: funcName, code: funcCode });
            buffer = [];
        };

        for (const line of lines) {
            const trimmed = line.trim();

            if (!capturingFunction) {
                if (functionHeaderRegex.test(trimmed)) {
                    capturingFunction = true;
                    waitingForBody = !trimmed.includes('{');
                    braceDepth = countBraceDelta(line);
                    buffer = [line];

                    if (!waitingForBody && braceDepth <= 0) {
                        flushFunctionBuffer();
                        capturingFunction = false;
                    }

                    continue;
                }

                statements.push(line);
            } else {
                buffer.push(line);

                if (waitingForBody && line.includes('{')) {
                    waitingForBody = false;
                }

                braceDepth += countBraceDelta(line);

                if (!waitingForBody && braceDepth <= 0) {
                    flushFunctionBuffer();
                    capturingFunction = false;
                }
            }
        }

        if (capturingFunction && buffer.length) {
            // If function braces never closed, treat buffered lines as statements to avoid losing code
            for (const bufferedLine of buffer) {
                if (bufferedLine.trim()) {
                    statements.push(bufferedLine);
                }
            }
        }

        return {
            statements: statements.filter(line => line.trim()),
            functions
        };
    }

    extractFunctionName(functionCode) {
        if (!functionCode) return null;
        const signature = functionCode.split('{')[0];
        const parenIndex = signature.indexOf('(');
        if (parenIndex === -1) return null;
        const beforeParen = signature.slice(0, parenIndex).trim();
        if (!beforeParen) return null;
        const parts = beforeParen.split(/\s+/);
        if (parts.length === 0) return null;
        return parts[parts.length - 1];
    }

    addError(message, nodeId = null) {
        this.errors.push(message);
        if (nodeId !== null && this.errorNodeId === null) {
            this.errorNodeId = nodeId; // Track first error node
        }
        console.error('[Shader Compiler Error]', message);
    }

    addWarning(message) {
        this.warnings.push(message);
        console.warn('[Shader Compiler Warning]', message);
    }

    /**
     * Validate a node graph before compilation
     */
    validate(nodeGraph) {
        const errors = [];
        const warnings = [];

        // Check for output node - only warn if there are nodes but no output
        const outputNodes = nodeGraph.nodes.filter(n => n.definition?.isOutputNode);
        if (outputNodes.length === 0 && nodeGraph.nodes.length > 0) {
            warnings.push('No output node found - add an Output node to see the result');
        } else if (outputNodes.length > 1) {
            errors.push('Multiple output nodes found');
        }

        // Check for cycles
        if (this.hasCycles(nodeGraph)) {
            errors.push('Graph contains cycles');
        }

        // Check for disconnected nodes
        const disconnected = this.findDisconnectedNodes(nodeGraph);
        if (disconnected.length > 0) {
            warnings.push(`${disconnected.length} disconnected node(s)`);
        }

        return { errors, warnings, valid: errors.length === 0 };
    }

    hasCycles(nodeGraph) {
        const visited = new Set();
        const recursionStack = new Set();

        const dfs = (node) => {
            visited.add(node.id);
            recursionStack.add(node.id);

            // Get all nodes connected to this node's inputs
            for (const conn of nodeGraph.connections) {
                if (conn.toNode === node) {
                    if (!visited.has(conn.fromNode.id)) {
                        if (dfs(conn.fromNode)) return true;
                    } else if (recursionStack.has(conn.fromNode.id)) {
                        return true; // Cycle detected
                    }
                }
            }

            recursionStack.delete(node.id);
            return false;
        };

        for (const node of nodeGraph.nodes) {
            if (!visited.has(node.id)) {
                if (dfs(node)) return true;
            }
        }

        return false;
    }

    findDisconnectedNodes(nodeGraph) {
        const outputNode = nodeGraph.nodes.find(n => n.definition?.isOutputNode);
        if (!outputNode) return [];

        const connected = new Set();
        const traverse = (node) => {
            if (connected.has(node.id)) return;
            connected.add(node.id);

            // Traverse backwards through connections
            for (const conn of nodeGraph.connections) {
                if (conn.toNode === node) {
                    traverse(conn.fromNode);
                }
            }
        };

        traverse(outputNode);

        return nodeGraph.nodes.filter(n => !connected.has(n.id));
    }

    inferSwizzleType(sourceType, swizzle) {
        // Remove leading dot
        const components = swizzle.replace('.', '');
        const length = components.length;

        if (length === 1) {
            return 'float';
        } else if (length === 2) {
            return 'vec2';
        } else if (length === 3) {
            return 'vec3';
        } else if (length === 4) {
            return 'vec4';
        }

        return sourceType; // Fallback
    }
}
