import { NodeDefinitions, TypeSystem } from './NodeDefinitions.js';
import { TypeRegistry } from './TypeRegistry.js';

export class ShaderCompiler {
    constructor() {
        this.reset();
    }

    reset() {
        this.errors = [];
        this.warnings = [];
        this.generatedCode = [];
        this.uniforms = new Set();
        this.customFunctions = new Map(); // name -> code
        this.functionHashes = new Map(); // hash -> name (for deduplication)
        this.functionRenames = new Map(); // originalName_nodeId -> newName
        this.compiledNodes = new Map();
        this.errorNodeId = null;
        this.codeToNodeMap = new Map(); // Maps line number to node ID
        this.usedStructs = new Set(); // Track which struct types are used
        this.functionCounter = 0; // Counter for renamed functions
        // NOTE: Do NOT reset nodeIdRemap here - it's injected by CompilationManager
        // and must persist across all compilation passes in a single cycle
        if (!this.nodeIdRemap) {
            this.nodeIdRemap = new Map(); // Only initialize if not already set
        }
    }

    // Renumber all nodes to have compact sequential IDs starting from 0
    renumberNodes(nodeGraph) {
        // Collect all unique node IDs and sort them
        const nodeIds = [...new Set(nodeGraph.nodes.map(n => n.id))].sort((a, b) => a - b);

        // Create mapping from old ID to new sequential ID
        this.nodeIdRemap.clear();
        nodeIds.forEach((oldId, index) => {
            this.nodeIdRemap.set(oldId, index);
        });
    }

    // Get the remapped node ID (compact sequential ID)
    getRemappedNodeId(nodeId) {
        return this.nodeIdRemap.has(nodeId) ? this.nodeIdRemap.get(nodeId) : nodeId;
    }

    compile(nodeGraph) {
        this.reset();
        // Note: nodeIdRemap is now injected by CompilationManager BEFORE any compilation
        // DO NOT call renumberNodes() here - it would overwrite the global mapping

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
        // Note: nodeIdRemap is now injected by CompilationManager BEFORE any compilation
        // DO NOT call renumberNodes() here - it would overwrite the global mapping
        return this.compileFromOutputNode(previewNode, nodeGraph);
    }

    compileFromNodeAsOutput(node, outputIndex, nodeGraph) {
        // Compile starting from a specific node and output as if it were the final output
        this.reset();
        // Note: nodeIdRemap is now injected by CompilationManager BEFORE any compilation
        // DO NOT call renumberNodes() here - it would overwrite the global mapping

        try {
            // Compile the node and its dependencies
            const result = this.compileNode(node, nodeGraph);

            if (!result) {
                return null;
            }

            // Convert the output to vec4 for rendering
            // Check if node has multiple independent outputs (like ForLoopEnd)
            let outputValue;
            if (node.outputVars) {
                const outputPortName = node.outputs[outputIndex].name;
                outputValue = node.outputVars[outputPortName];
                if (!outputValue) {
                    console.error(`Preview: Output '${outputPortName}' not found in outputVars for node ${node.id}`);
                    outputValue = result.output; // Fallback
                }
            } else {
                outputValue = result.output;
            }

            const sourceType = node.outputs[outputIndex].type;
            const finalColor = TypeSystem.convertCode(outputValue, sourceType, 'vec4');

            // Build the final shader
            const fragmentShader = this.buildFragmentShader(finalColor);

            // Extract uniform values - create completely new objects to avoid shared references
            const uniformValues = Array.from(this.uniforms)
                .filter(u => typeof u === 'object' && (u.value !== undefined || u.feedbackNodeId !== undefined || u.microphoneNodeId !== undefined || u.midiCCNodeId !== undefined))
                .map(u => {
                    const uniform = { name: u.name, type: u.type };
                    if (u.value !== undefined) {
                        // Deep copy array values to avoid shared references
                        uniform.value = Array.isArray(u.value) ? [...u.value] : u.value;
                    }
                    if (u.feedbackNodeId !== undefined) {
                        uniform.feedbackNodeId = u.feedbackNodeId;
                    }
                    if (u.microphoneNodeId !== undefined) {
                        uniform.microphoneNodeId = u.microphoneNodeId;
                    }
                    if (u.midiCCNodeId !== undefined) {
                        uniform.midiCCNodeId = u.midiCCNodeId;
                    }
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
        // Find what's connected to the output node
        const outputConnection = nodeGraph.connections.find(
            conn => conn.toNode === outputNode
        );

        if (!outputConnection) {
            // No connection - return default magenta shader
            try {
                const finalColor = 'vec4(1.0, 0.0, 1.0, 1.0)';
                const fragmentShader = this.buildFragmentShader(finalColor);
                return {
                    vertex: this.getVertexShader(),
                    fragment: fragmentShader,
                    uniformValues: [],
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

        // Delegate to compileFromNodeAsOutput - this unifies all compilation logic
        return this.compileFromNodeAsOutput(
            outputConnection.fromNode,
            outputConnection.fromOutput,
            nodeGraph
        );
    }

    compileNode(node, nodeGraph) {
        // Return cached result if already compiled (but not for dynamic nodes that need revalidation)
        if (this.compiledNodes.has(node.id) && !node.isDynamicInput) {
            return this.compiledNodes.get(node.id);
        }

        // Temporarily override varName with remapped ID for compact numbering
        const originalVarName = node.varName;
        const remappedId = this.getRemappedNodeId(node.id);
        node.varName = `node_${remappedId}`;

        const definition = node.definition;
        if (!definition) {
            this.addError(`Node ${node.type} has no definition`, node.id);
            node.varName = originalVarName; // Restore
            return null;
        }

        // Track struct types used by this node's outputs
        if (node.outputs) {
            for (const output of node.outputs) {
                if (TypeRegistry.isStruct(output.type)) {
                    this.usedStructs.add(output.type);
                }
            }
        }

        // Special case: output node
        if (definition.isOutputNode) {
            node.varName = originalVarName; // Restore
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
            node.varName = originalVarName; // Restore
            return result;
        }

        // Collect uniforms needed by this node
        if (definition.uniforms) {
            definition.uniforms.forEach(u => this.uniforms.add(u));
        }

        // Compile input connections and collect types for validation
        const inputValues = {};
        const inputTypes = {};

        for (let i = 0; i < node.inputs.length; i++) {
            const input = node.inputs[i];
            const connection = nodeGraph.connections.find(
                conn => conn.toNode === node && conn.toInput === i
            );

            if (connection) {
                // Recursively compile connected node
                const sourceResult = this.compileNode(connection.fromNode, nodeGraph);
                if (sourceResult) {
                    // Check if source node has multiple independent outputs (like ForLoop)
                    let sourceValue;
                    if (connection.fromNode.outputVars) {
                        const outputPortName = connection.fromNode.outputs[connection.fromOutput].name;
                        sourceValue = connection.fromNode.outputVars[outputPortName];
                        if (!sourceValue) {
                            console.error(`Output '${outputPortName}' not found in outputVars for node ${connection.fromNode.id}. Available:`, Object.keys(connection.fromNode.outputVars));
                            sourceValue = sourceResult.output; // Fallback
                        }
                    } else {
                        sourceValue = sourceResult.output;
                    }
                    let sourceType = connection.fromNode.outputs[connection.fromOutput].type;

                    // Apply accessor if present (struct member access and/or swizzle)
                    if (connection.accessor) {
                        sourceValue = sourceValue + connection.accessor;
                        // Resolve type after accessor
                        try {
                            sourceType = TypeRegistry.resolveAccessorType(sourceType, connection.accessor);
                        } catch (e) {
                            this.addError(`Invalid accessor ${connection.accessor} on type ${sourceType}: ${e.message}`, node.id);
                            sourceType = 'float'; // Fallback
                        }
                    }

                    inputTypes[input.name] = sourceType;
                    const targetType = input.type;

                    // Handle 'any' type inputs - defer type checking to the node
                    if (TypeRegistry.isAny(targetType)) {
                        // Store the actual type for validation
                        inputValues[input.name] = sourceValue;
                    } else {
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
                }
            } else {
                // Use default value
                inputValues[input.name] = input.default;
                inputTypes[input.name] = null; // Not connected
            }
        }

        // If node has custom type validation, run it
        if (definition.validateTypes) {
            const validation = definition.validateTypes(node, inputTypes, this);
            if (!validation.valid) {
                this.addError(validation.error, node.id);
                node.varName = originalVarName; // Restore
                return null;
            }
            // Store resolved output type on the node
            if (validation.outputType) {
                node.resolvedOutputType = validation.outputType;
                // Update the output type dynamically (always update for dynamic nodes)
                if (node.outputs.length > 0 && (TypeRegistry.isAny(node.outputs[0].type) || node.isDynamicInput)) {
                    node.outputs[0].type = validation.outputType;
                }
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

            // Add preamble (function definitions for custom nodes)
            // Preamble contains complete function definitions - add it directly as a block
            let preambleRenames = {};
            if (result.preamble) {
                // Add preamble and get any function renames
                const preambleResult = this.addCustomFunction(`preamble_node_${node.id}`, result.preamble, node.id);
                preambleRenames = preambleResult.renames || {};
            }

            // Add generated code and track which node it came from
            if (result.code) {
                // Apply any function renames from preamble to the calling code
                let codeWithRenames = this.applyFunctionRenames(result.code, preambleRenames);

                const { statements, functions } = this.extractFunctionsFromCode(codeWithRenames);

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
            node.varName = originalVarName; // Restore
            return result;
        } else {
            this.addError(`Node ${node.type} has invalid glsl generator`, node.id);
            node.varName = originalVarName; // Restore
            return null;
        }
    }

    buildFragmentShader(finalColor) {
        const uniformDeclarations = Array.from(this.uniforms)
            .map(u => this.getUniformDeclaration(u))
            .join('\n');

        // Generate struct definitions for all used struct types (with dependencies)
        const structDefinitions = this.generateStructDefinitions();

        const customFunctionCode = Array.from(this.customFunctions.values())
            .join('\n\n');

        const mainCode = this.generatedCode
            .map(line => '    ' + line)
            .join('\n');

        const shader = `#version 300 es
precision highp float;

${uniformDeclarations}

out vec4 fragColor;

${structDefinitions}

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

    generateStructDefinitions() {
        if (this.usedStructs.size === 0) {
            return '';
        }

        const allStructs = new Set();

        // Collect all structs including dependencies
        for (const structType of this.usedStructs) {
            const deps = TypeRegistry.getDependentStructs(structType);
            deps.forEach(dep => allStructs.add(dep));
        }

        // Generate definitions in dependency order (reverse of collection order ensures dependencies first)
        const structArray = Array.from(allStructs).reverse();
        let code = structArray
            .map(structType => TypeRegistry.generateStructDefinition(structType))
            .join('\n');

        // Generate blend functions for all used struct types
        // (in case Blend nodes or custom blend operations are used)
        code += '\n';
        for (const structType of allStructs) {
            code += TypeRegistry.generateBlendFunction(structType);
        }

        return code;
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
        if (!code) return { originalNames: [], renamedNames: [] };

        const normalizedCode = code.trim();
        if (!normalizedCode) return { originalNames: [], renamedNames: [] };

        // Extract all function definitions from the code block
        const functions = this.extractAllFunctions(normalizedCode);
        const renames = {}; // originalName -> newName
        const functionsToAdd = []; // Store functions to add after processing all

        // First pass: determine all renames
        for (const func of functions) {
            const { name: funcName, code: funcCode } = func;

            // Compute a hash of the function code for deduplication
            const codeHash = this.hashCode(funcCode);

            // Check if we've already seen this exact function code
            const existingName = this.functionHashes.get(codeHash);
            if (existingName) {
                // Identical function already exists - skip it but record the name
                renames[funcName] = existingName;
                continue;
            }

            // Check if function name conflicts with existing function
            const existingFunc = this.customFunctions.get(funcName);

            if (existingFunc && this.hashCode(existingFunc) !== codeHash) {
                // Different function with same name - need to rename
                this.functionCounter++;
                const newName = `${funcName}_${this.functionCounter}`;

                // Record rename
                renames[funcName] = newName;
                functionsToAdd.push({ originalName: funcName, newName, code: funcCode });

                console.log(`Renamed conflicting function '${funcName}' to '${newName}'`);
            } else if (!existingFunc) {
                // New function - add it
                renames[funcName] = funcName; // No rename needed
                functionsToAdd.push({ originalName: funcName, newName: funcName, code: funcCode });
            } else {
                // Identical function already exists
                renames[funcName] = funcName;
            }
        }

        // Second pass: add functions with renames applied to both definition and body
        for (const { originalName, newName, code: funcCode } of functionsToAdd) {
            // Apply all renames to this function's code (for calls to other functions)
            let updatedCode = this.applyFunctionRenames(funcCode, renames);

            // Rename the function itself in its declaration
            if (originalName !== newName) {
                updatedCode = this.renameFunctionInCode(updatedCode, originalName, newName);
            }

            // Store the function
            this.customFunctions.set(newName, updatedCode);
            this.functionHashes.set(this.hashCode(funcCode), newName);
        }

        return {
            renames,
            originalNames: functions.map(f => f.name),
            renamedNames: functions.map(f => renames[f.name])
        };
    }

    /**
     * Compute a simple hash of a string for deduplication
     */
    hashCode(str) {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash; // Convert to 32bit integer
        }
        return hash.toString();
    }

    /**
     * Extract all function definitions from a code block
     */
    extractAllFunctions(code) {
        const functions = [];
        // GLSL keywords that cannot be return types
        const glslKeywords = new Set([
            'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default',
            'break', 'continue', 'return', 'discard',
            'struct', 'const', 'uniform', 'varying', 'attribute', 'in', 'out', 'inout',
            'layout', 'precision', 'highp', 'mediump', 'lowp',
            'flat', 'smooth', 'centroid', 'invariant'
        ]);
        const functionRegex = /(\w+)\s+(\w+)\s*\(([^)]*)\)\s*\{/g;

        // Build a map of positions that are inside comments or strings
        // This is a single-pass analysis that's much faster than checking each position
        const insideCommentOrString = new Array(code.length).fill(false);

        let inMultiLineComment = false;
        let inSingleLineComment = false;
        let inString = false;
        let stringChar = '';

        for (let i = 0; i < code.length; i++) {
            const char = code[i];
            const nextChar = i + 1 < code.length ? code[i + 1] : '';
            const prevChar = i > 0 ? code[i - 1] : '';

            // Check for single-line comment start
            if (!inString && !inMultiLineComment && !inSingleLineComment && char === '/' && nextChar === '/') {
                inSingleLineComment = true;
                insideCommentOrString[i] = true;
                continue;
            }

            // Check for single-line comment end
            if (inSingleLineComment && char === '\n') {
                inSingleLineComment = false;
                continue;
            }

            // Check for multi-line comment start
            if (!inString && !inSingleLineComment && !inMultiLineComment && char === '/' && nextChar === '*') {
                inMultiLineComment = true;
                insideCommentOrString[i] = true;
                continue;
            }

            // Check for multi-line comment end
            if (inMultiLineComment && char === '*' && nextChar === '/') {
                insideCommentOrString[i] = true;
                insideCommentOrString[i + 1] = true;
                i++; // Skip the '/'
                inMultiLineComment = false;
                continue;
            }

            // Check for string start/end
            if (!inMultiLineComment && !inSingleLineComment) {
                if (!inString && (char === '"' || char === "'")) {
                    inString = true;
                    stringChar = char;
                    insideCommentOrString[i] = true;
                    continue;
                } else if (inString && char === stringChar && prevChar !== '\\') {
                    insideCommentOrString[i] = true;
                    inString = false;
                    continue;
                }
            }

            // Mark this position if we're inside a comment or string
            if (inMultiLineComment || inSingleLineComment || inString) {
                insideCommentOrString[i] = true;
            }
        }

        // Now find functions
        let match;
        while ((match = functionRegex.exec(code)) !== null) {
            const [fullMatch, returnType, funcName, params] = match;
            const startIndex = match.index;

            // Skip if this match is inside a comment or string
            if (insideCommentOrString[startIndex]) {
                continue;
            }

            // Skip if return type or function name is a GLSL keyword
            if (glslKeywords.has(returnType) || glslKeywords.has(funcName)) {
                continue;
            }

            // Find the matching closing brace
            let braceCount = 1;
            let endIndex = startIndex + fullMatch.length;

            while (braceCount > 0 && endIndex < code.length) {
                if (!insideCommentOrString[endIndex]) {
                    if (code[endIndex] === '{') braceCount++;
                    if (code[endIndex] === '}') braceCount--;
                }
                endIndex++;
            }

            const funcCode = code.substring(startIndex, endIndex);
            functions.push({
                name: funcName,
                returnType,
                params,
                signature: `${returnType} ${funcName}(${params})`,
                code: funcCode
            });
        }

        return functions;
    }

    /**
     * Rename a function in its own definition code
     */
    renameFunctionInCode(code, oldName, newName) {
        // Replace the function name in its declaration
        const funcDeclRegex = new RegExp(`(\\w+\\s+)(${oldName})(\\s*\\([^)]*\\)\\s*\\{)`, 'g');
        return code.replace(funcDeclRegex, `$1${newName}$3`);
    }

    /**
     * Apply function renames to calling code, skipping comments
     */
    applyFunctionRenames(code, renames) {
        if (!renames || Object.keys(renames).length === 0) {
            return code;
        }

        // Parse code to identify comment regions
        const commentRanges = this.findCommentRanges(code);

        let result = code;
        for (const [oldName, newName] of Object.entries(renames)) {
            if (oldName === newName) continue;

            // Only replace function calls, not variable names
            // Pattern: functionName followed by optional whitespace and (
            const callRegex = new RegExp(`\\b${this.escapeRegex(oldName)}\\s*\\(`, 'g');

            // Collect all matches
            const matches = [];
            let match;
            while ((match = callRegex.exec(code)) !== null) {
                matches.push({
                    index: match.index,
                    length: match[0].length,
                    text: match[0]
                });
            }

            // Apply replacements in reverse order to preserve indices
            for (let i = matches.length - 1; i >= 0; i--) {
                const m = matches[i];

                // Check if this match is inside a comment
                if (this.isInCommentRange(m.index, commentRanges)) {
                    continue; // Skip replacements in comments
                }

                // Replace the function name but preserve whitespace and (
                const replacement = m.text.replace(new RegExp(`\\b${this.escapeRegex(oldName)}`), newName);
                result = result.substring(0, m.index) + replacement + result.substring(m.index + m.length);
            }
        }

        return result;
    }

    /**
     * Find all comment ranges in the code
     */
    findCommentRanges(code) {
        const ranges = [];

        // Find single-line comments
        const singleLineRegex = /\/\/.*/g;
        let match;
        while ((match = singleLineRegex.exec(code)) !== null) {
            ranges.push({
                start: match.index,
                end: match.index + match[0].length
            });
        }

        // Find multi-line comments
        const multiLineRegex = /\/\*[\s\S]*?\*\//g;
        while ((match = multiLineRegex.exec(code)) !== null) {
            ranges.push({
                start: match.index,
                end: match.index + match[0].length
            });
        }

        return ranges;
    }

    /**
     * Check if an index is within any comment range
     */
    isInCommentRange(index, ranges) {
        for (const range of ranges) {
            if (index >= range.start && index < range.end) {
                return true;
            }
        }
        return false;
    }

    /**
     * Escape special regex characters
     */
    escapeRegex(str) {
        return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

        // Remove comments and strings from a line to count braces accurately
        const stripCommentsAndStrings = (line) => {
            let result = '';
            let inString = false;
            let stringChar = '';
            let i = 0;

            while (i < line.length) {
                // Check for string start/end
                if (!inString && (line[i] === '"' || line[i] === "'")) {
                    inString = true;
                    stringChar = line[i];
                    i++;
                    continue;
                } else if (inString && line[i] === stringChar && line[i - 1] !== '\\') {
                    inString = false;
                    i++;
                    continue;
                }

                // If we're in a string, skip this character
                if (inString) {
                    i++;
                    continue;
                }

                // Check for single-line comment
                if (line[i] === '/' && i + 1 < line.length && line[i + 1] === '/') {
                    // Rest of line is comment, we're done
                    break;
                }

                // Check for multi-line comment start
                if (line[i] === '/' && i + 1 < line.length && line[i + 1] === '*') {
                    // Find end of comment on this line
                    i += 2;
                    while (i < line.length - 1) {
                        if (line[i] === '*' && line[i + 1] === '/') {
                            i += 2;
                            break;
                        }
                        i++;
                    }
                    continue;
                }

                result += line[i];
                i++;
            }

            return result;
        };

        const countBraceDelta = (line) => {
            // Strip comments and strings before counting braces
            const cleaned = stripCommentsAndStrings(line);
            const opens = (cleaned.match(/\{/g) || []).length;
            const closes = (cleaned.match(/\}/g) || []).length;
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
                // Don't match lines that are comments
                if (trimmed.startsWith('//') || trimmed.startsWith('/*')) {
                    statements.push(line);
                    continue;
                }

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
                    // Skip connections TO feedback nodes - they break cycles by design
                    if (conn.toNode.isFeedbackNode) {
                        continue;
                    }

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
