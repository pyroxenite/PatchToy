import { NodeDefinitions, TypeSystem } from './NodeDefinitions.js';
import { TypeRegistry } from './TypeRegistry.js';
import { builtinUniformsIn, builtinDeclaration, builtinUniformEntry } from './builtinUniforms.js';
import { installSceneCompiler } from './scenes.js';
import { installControlCompiler } from './control/compiler.js';

/** Format a JS number as a GLSL float literal (always has a decimal point). */
function glslFloat(x) {
    if (!Number.isFinite(x)) return '0.0';
    let s = String(x);
    if (!/[.eE]/.test(s)) s += '.0';
    return s;
}

/** Parenthesize an expression unless it is a plain identifier / member chain. */
function wrapExpr(value) {
    return /^[A-Za-z_][\w.]*$/.test(value) ? value : `(${value})`;
}

export class ShaderCompiler {
    constructor() {
        this.reset();
    }

    reset() {
        this._resetCount = (this._resetCount || 0) + 1; // a new compile pass (control plan memo)
        this.errors = [];
        this.warnings = [];
        this.generatedCode = [];
        this.uniforms = new Set();
        this.uniformNames = new Set(); // dedupe uniforms by name (a node may compile in several scopes)
        this.customFunctions = new Map(); // name -> code
        this.functionHashes = new Map(); // hash -> name (for deduplication)
        this.functionRenames = new Map(); // originalName_nodeId -> newName
        this.compiledNodes = new Map();
        this.inProgress = new Set(); // cycle guard
        this.lambdaStack = []; // active function-input scopes (e.g. Raymarch scene SDF)
        this.errorNodeId = null;
        this.codeToNodeMap = new Map(); // Maps line number to node ID
        this.usedStructs = new Set(); // Track which struct types are used
        this.functionCounter = 0; // Counter for renamed functions
        this._resetScenes(); // SceneSwitcher state (src/core/scenes.js)
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

    /** Add a uniform (string name for built-ins, or {name, type, value, ...}) once. */
    addUniform(uniform) {
        // u_spectrum / u_waveform / u_spectrogram become texture uniforms (bound like JS textures)
        if (typeof uniform === 'string') uniform = builtinUniformEntry(uniform);
        const name = typeof uniform === 'string' ? uniform : uniform && uniform.name;
        if (!name || this.uniformNames.has(name)) return;
        this.uniformNames.add(name);
        this.uniforms.add(uniform);
    }

    /**
     * Name of a function-scope parameter (e.g. 'p' inside a Raymarch scene),
     * or null when compiling in main().
     */
    getLambdaParam(name) {
        for (let i = this.lambdaStack.length - 1; i >= 0; i--) {
            const param = this.lambdaStack[i].params.find(p => p.name === name);
            if (param) return param.name;
        }
        return null;
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

    /**
     * Compile starting from a specific node output as if it were the final color.
     * `accessor` is the swizzle / struct member chain of the cable feeding the
     * Preview / Feedback node (e.g. ".x" or ".position").
     */
    compileFromNodeAsOutput(node, outputIndex, nodeGraph, accessor = null) {
        this.reset();
        // Note: nodeIdRemap is now injected by CompilationManager BEFORE any compilation
        // DO NOT call renumberNodes() here - it would overwrite the global mapping

        const failure = () => ({
            vertex: this.getVertexShader(),
            fragment: null,
            uniformValues: [],
            errors: this.errors,
            warnings: this.warnings,
            errorNodeId: this.errorNodeId
        });

        this.compileRoot = node; // scenes: nodes main() computes anyway (src/core/scenes.js)
        try {
            const src = this.resolveConnection(
                { fromNode: node, fromOutput: outputIndex, accessor },
                nodeGraph,
                node
            );
            if (!src || this.errors.length > 0) {
                if (this.errors.length === 0) this.addError(`Could not compile ${node.type}`, node.id);
                return failure();
            }

            let finalColor;
            if (src.type === 'sampler2D') {
                // Show a texture directly (e.g. Feedback -> Preview)
                this.addUniform('u_resolution');
                finalColor = `texture(${src.value}, gl_FragCoord.xy / u_resolution)`;
            } else if (TypeRegistry.isStruct(src.type)) {
                const members = TypeRegistry.getType(src.type).members.map(m => '.' + m.name).join(', ');
                this.addError(`Cannot preview a ${src.type} struct directly. Add an accessor to the cable (${members}).`, node.id);
                return failure();
            } else {
                finalColor = TypeSystem.convertCode(src.value, src.type, 'vec4');
            }

            // Build the final shader
            const fragmentShader = this.buildFragmentShader(finalColor);

            // Extract uniform values - create new objects to avoid shared references
            const uniformValues = Array.from(this.uniforms)
                .filter(u => typeof u === 'object' && (u.value !== undefined || u.feedbackNodeId !== undefined || u.microphoneNodeId !== undefined || u.midiCCNodeId !== undefined))
                .map(u => {
                    const uniform = { ...u };
                    if (Array.isArray(u.value)) uniform.value = [...u.value];
                    return uniform;
                });

            return {
                vertex: this.getVertexShader(),
                fragment: fragmentShader,
                uniformValues: uniformValues,
                sourceType: src.type, // type before the vec4 conversion (debug probes read raw components)
                errors: this.errors,
                warnings: this.warnings,
                errorNodeId: this.errorNodeId
            };
        } catch (error) {
            console.error('Shader compilation error:', error);
            this.errors.push(error.message);
            return failure();
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

        // Delegate to compileFromNodeAsOutput - this unifies all compilation logic.
        // Pass the cable's accessor so swizzles / struct members on the cable
        // into the Preview are honoured.
        return this.compileFromNodeAsOutput(
            outputConnection.fromNode,
            outputConnection.fromOutput,
            nodeGraph,
            outputConnection.accessor || null
        );
    }

    /**
     * Compile the source of a connection and return { value, type } after
     * applying the cable accessor (struct member and/or swizzle).
     */
    resolveConnection(connection, nodeGraph, targetNode) {
        // Inside a scene function: values main() computes anyway come from main (scenes.js)
        if (this.sceneSwitchers.size) {
            const hoisted = this._sceneHoist(connection, nodeGraph, targetNode);
            if (hoisted !== undefined) return hoisted;
        }
        const fromNode = connection.fromNode;
        const sourceResult = this.compileNode(fromNode, nodeGraph);
        if (!sourceResult) return null;

        const port = fromNode.outputs[connection.fromOutput];
        if (!port) {
            this.addError(`${fromNode.type} has no output #${connection.fromOutput}`, targetNode ? targetNode.id : fromNode.id);
            return null;
        }

        // Nodes with several independent outputs (ForLoop, multi-output library nodes)
        let value;
        if (fromNode.outputVars) {
            value = fromNode.outputVars[port.name];
            if (!value) value = sourceResult.output; // Fallback
        } else {
            value = sourceResult.output;
        }
        let type = port.type;

        if (connection.accessor) {
            let resolved;
            try {
                resolved = TypeRegistry.resolveAccessorType(type, connection.accessor);
            } catch (e) {
                this.addError(`Invalid accessor ${connection.accessor} on ${type}: ${e.message}`, targetNode ? targetNode.id : fromNode.id);
                return null;
            }
            const { structPath, swizzle } = TypeRegistry.parseAccessor(connection.accessor);
            if ((type === 'float' || type === 'int' || type === 'bool') && structPath.length === 0 && swizzle) {
                // GLSL ES 3.00 cannot swizzle scalars: ".xxx" on a float -> vec3(x)
                const scalar = type === 'float' ? value : `float(${value})`;
                value = swizzle.length === 1 ? scalar : `vec${swizzle.length}(${scalar})`;
            } else {
                value = `${wrapExpr(value)}${connection.accessor}`;
            }
            type = resolved;
        }

        return { value, type };
    }

    /** Convert a connected value to a typed (non-'any') input. */
    convertForInput(value, fromType, toType, node) {
        if (!fromType || fromType === toType || TypeRegistry.isAny(fromType)) return value;
        const isOpaque = t => TypeRegistry.isStruct(t) || t === 'sampler2D' || t === 'samplerCube';
        if (isOpaque(fromType) || isOpaque(toType)) {
            this.addError(`Cannot connect ${fromType} to ${toType} input of ${node.type}`, node.id);
            return value;
        }
        if (!TypeSystem.canConvert(fromType, toType)) {
            this.addWarning(`Type mismatch: connecting ${fromType} to ${toType} in ${node.type}`);
        } else if (TypeSystem.isLossy && TypeSystem.isLossy(fromType, toType)) {
            this.addWarning(`${node.type}: ${fromType} connected to a ${toType} input, using its first component`);
        }
        return TypeSystem.convertCode(value, fromType, toType);
    }

    /**
     * Value used for an unconnected input. Library nodes (definition.inlineInputs)
     * read node.data[inputName]: a number (inline field), an array of 2-4 numbers
     * (vecN), a GLSL literal string such as "vec3(1.0, 0.5, 0.0)", or true/false
     * for bool inputs.
     */
    defaultForInput(node, input) {
        const data = node.data;
        const value = data && node.definition && node.definition.inlineInputs ? data[input.name] : undefined;
        if (value !== undefined && value !== null && !input.functionOf) {
            const t = input.type;
            if (typeof value === 'boolean') {
                if (t === 'bool') return value ? 'true' : 'false';
            } else if (typeof value === 'number' && Number.isFinite(value)) {
                if (t === 'int') return String(Math.round(value));
                if (t === 'float' || TypeRegistry.isAny(t)) return glslFloat(value);
                if (t === 'vec2' || t === 'vec3' || t === 'vec4') return `${t}(${glslFloat(value)})`;
            } else if (Array.isArray(value) && value.length >= 2 && value.length <= 4 && value.every(Number.isFinite)) {
                const vt = `vec${value.length}`;
                if (vt === t || TypeRegistry.isAny(t)) return `${vt}(${value.map(glslFloat).join(', ')})`;
            } else if (typeof value === 'string' &&
                /^(vec[234]|float|int)\(\s*-?[\d.]+(e[-+]?\d+)?(\s*,\s*-?[\d.]+(e[-+]?\d+)?)*\s*\)$/i.test(value.trim())) {
                return value.trim();
            }
        }
        return input.default;
    }

    /**
     * Compile an input declared with `functionOf: { params: [{name, type}], returns }`
     * as a standalone GLSL function. The upstream sub-graph is compiled in its own
     * scope where nodes can read the parameters via compiler.getLambdaParam(name).
     * Returns the generated function name (or null on failure).
     */
    compileFunctionInput(node, input, connection, nodeGraph) {
        const sig = input.functionOf;
        const fnName = `${node.varName}_${input.name}`;
        const saved = { code: this.generatedCode, cache: this.compiledNodes, map: this.codeToNodeMap };
        this.generatedCode = [];
        this.compiledNodes = new Map();
        this.codeToNodeMap = new Map();
        this.lambdaStack.push({ params: sig.params, fnName });

        let ret = null;
        let body = [];
        try {
            if (connection) {
                const src = this.resolveConnection(connection, nodeGraph, node);
                if (src) ret = this.convertForInput(src.value, src.type, sig.returns, node);
            } else {
                ret = input.default;
            }
            body = this.generatedCode;
        } finally {
            this.generatedCode = saved.code;
            this.compiledNodes = saved.cache;
            this.codeToNodeMap = saved.map;
            this.lambdaStack.pop();
        }

        if (ret === null || ret === undefined) return null;
        const params = sig.params.map(p => `${p.type} ${p.name}`).join(', ');
        const bodyCode = body.map(line => '    ' + line).join('\n');
        const code = `${sig.returns} ${fnName}(${params}) {\n${bodyCode}${bodyCode ? '\n' : ''}    return ${ret};\n}`;
        this.addCustomFunction(fnName, code, node.id);
        return fnName;
    }

    compileNode(node, nodeGraph) {
        // Each node compiles once per scope (main or function input)
        if (this.compiledNodes.has(node.id)) {
            return this.compiledNodes.get(node.id);
        }
        if (this.inProgress.has(node.id)) {
            this.addError(`Cycle detected at ${node.type}: route loops through a Feedback node`, node.id);
            return null;
        }

        // Temporarily override varName with remapped ID for compact numbering
        const originalVarName = node.varName;
        node.varName = `node_${this.getRemappedNodeId(node.id)}`;
        this.inProgress.add(node.id);
        try {
            return this.compileNodeBody(node, nodeGraph);
        } catch (error) {
            this.addError(`${node.type}: ${error.message}`, node.id);
            console.error(error);
            return null;
        } finally {
            this.inProgress.delete(node.id);
            node.varName = originalVarName; // Restore
        }
    }

    compileNodeBody(node, nodeGraph) {
        const definition = node.definition;
        if (!definition) {
            this.addError(`Node ${node.type} has no definition`, node.id);
            return null;
        }

        // Control-rate nodes: a uniform updated every frame by the ControlRuntime (control/compiler.js)
        if (this._compileControlNode) {
            const ctl = this._compileControlNode(node, nodeGraph);
            if (ctl !== undefined) return ctl;
        }

        // Track struct types used by this node's outputs
        if (node.outputs) {
            for (const output of node.outputs) {
                if (TypeRegistry.isStruct(output.type)) {
                    this.usedStructs.add(output.type);
                }
            }
        }

        // Special case: output / preview nodes produce no value
        if (definition.isOutputNode || definition.isPreviewNode) {
            this.addError(`${node.type} has no outputs`, node.id);
            return null;
        }

        // Special case: feedback node - don't traverse inputs, just provide the texture uniform
        // (Render 3D nodes too: their inputs compile into their own programs, src/render3d)
        if (definition.isFeedbackNode || definition.isTextureSourceNode) {
            const result = definition.glsl(node, {}, this);
            if (result.uniforms) {
                for (const uniform of result.uniforms) this.addUniform(uniform);
            }
            this.compiledNodes.set(node.id, result);
            return result;
        }

        // Optional per-node setup that may reshape ports (e.g. ForLoopStart adopting connected types)
        if (typeof definition.prepare === 'function') {
            definition.prepare(node, nodeGraph, this);
        }

        // Collect uniforms needed by this node
        if (definition.uniforms) {
            definition.uniforms.forEach(u => this.addUniform(u));
        }

        // Compile input connections and collect types for validation
        const inputValues = {};
        const inputTypes = {};
        let failed = false;

        for (let i = 0; i < node.inputs.length; i++) {
            const input = node.inputs[i];
            const connection = nodeGraph.connections.find(
                conn => conn.toNode === node && conn.toInput === i
            );

            if (input.sceneInput || input.cpuInput) {
                // SceneSwitcher: scene inputs become functions, CPU inputs are read by the runtime
                const value = this.compileSceneSlot(node, input, i, connection, nodeGraph);
                if (value === false) { failed = true; continue; }
                inputValues[input.name] = value;
                inputTypes[input.name] = connection ? (input.cpuInput ? 'cpu' : 'scene') : null;
                continue;
            }

            if (input.functionOf) {
                const fnName = this.compileFunctionInput(node, input, connection, nodeGraph);
                if (fnName === null) { failed = true; continue; }
                inputValues[input.name] = fnName;
                inputTypes[input.name] = connection ? 'function' : null;
                continue;
            }

            if (connection) {
                const src = this.resolveConnection(connection, nodeGraph, node);
                if (!src) { failed = true; continue; }
                inputTypes[input.name] = src.type;
                if (TypeRegistry.isAny(input.type)) {
                    // 'any' inputs get the raw value; the node validates / casts
                    inputValues[input.name] = src.value;
                } else {
                    const targetType = (typeof definition.resolveInputType === 'function' && definition.resolveInputType(node, input)) || input.type;
                    inputValues[input.name] = this.convertForInput(src.value, src.type, targetType, node);
                }
            } else {
                inputValues[input.name] = this.defaultForInput(node, input);
                inputTypes[input.name] = null; // Not connected
            }
        }

        if (failed) return null;

        // A ForLoopEnd whose body doesn't read the loop variables must still open the loop
        if (definition.isForLoopEndNode && node.data && node.data.pairNodeId !== undefined && node.data.pairNodeId !== null) {
            const startNode = nodeGraph.nodes.find(n => n.id === node.data.pairNodeId);
            if (startNode && !this.compiledNodes.has(startNode.id)) {
                if (!this.compileNode(startNode, nodeGraph)) return null;
            }
        }

        // If node has custom type validation, run it
        if (definition.validateTypes) {
            const validation = definition.validateTypes(node, inputTypes, this);
            if (!validation.valid) {
                this.addError(`${node.type}: ${validation.error}`, node.id);
                return null;
            }
            node.resolvedOutputType = validation.outputType || null;
            // Resolve 'any' outputs on this node instance (never on the shared definition)
            for (let k = 0; k < node.outputs.length; k++) {
                const declared = definition.outputs && definition.outputs[k] ? definition.outputs[k].type : undefined;
                const resolved = (validation.outputTypes && validation.outputTypes[k]) || (k === 0 ? validation.outputType : undefined);
                if (resolved && (declared === undefined || TypeRegistry.isAny(declared) || node.isDynamicInput)) {
                    if (definition.outputs && node.outputs[k] === definition.outputs[k]) {
                        node.outputs[k] = { ...node.outputs[k] };
                    }
                    if (node.outputs[k].type !== resolved) this.outputTypeChanges = (this.outputTypeChanges || 0) + 1;
                    node.outputs[k].type = resolved;
                }
            }
        }

        // Generate GLSL code for this node
        if (typeof definition.glsl !== 'function') {
            this.addError(`Node ${node.type} has invalid glsl generator`, node.id);
            return null;
        }

        const result = definition.glsl(node, inputValues, this);
        if (!result) {
            this.addError(`Node ${node.type} produced no code`, node.id);
            return null;
        }

        // Collect uniforms from the result
        if (result.uniforms) {
            for (const uniform of result.uniforms) {
                this.addUniform(uniform);
            }
        }

        // Add preamble (function definitions) - added directly as a block
        let preambleRenames = {};
        if (result.preamble) {
            const preambleResult = this.addCustomFunction(`preamble_node_${node.id}`, result.preamble, node.id);
            preambleRenames = preambleResult.renames || {};
        }

        // Add generated code and track which node it came from
        if (result.code) {
            // Apply any function renames from preamble to the calling code
            const codeWithRenames = this.applyFunctionRenames(result.code, preambleRenames);

            const { statements, functions } = this.extractFunctionsFromCode(codeWithRenames);

            // Hoist any function definitions outside of main()
            for (const func of functions) {
                this.addCustomFunction(func.name, func.code, node.id);
            }

            for (const line of statements) {
                const lineIndex = this.generatedCode.length;
                this.generatedCode.push(line);
                this.codeToNodeMap.set(lineIndex, node.id);
            }
        }

        // Store custom functions if needed
        if (result.requiresFunction && definition.glslFunction) {
            this.addCustomFunction(result.requiresFunction, definition.glslFunction, node.id);
        }

        this._trackPositional(node, definition, result, nodeGraph);
        this.compiledNodes.set(node.id, result);
        return result;
    }

    buildFragmentShader(finalColor) {
        // Built-in uniforms (u_time, u_beat, u_bass, ...) referenced anywhere in the code are
        // declared automatically, so custom GLSL and expressions can use them without a node
        const used = builtinUniformsIn([finalColor, ...this.generatedCode, ...this.customFunctions.values()].join('\n'));
        for (const name of used) this.addUniform(name);

        const uniformDeclarations = Array.from(this.uniforms)
            .map(u => this.getUniformDeclaration(u))
            .join('\n');

        // Generate struct definitions for all used struct types (with dependencies)
        const structDefinitions = this.generateStructDefinitions();

        let customFunctionCode = Array.from(this.customFunctions.values())
            .join('\n\n');
        // SceneSwitcher: functions read the (possibly warped) pixel from sc_FragCoord
        const sceneParts = this._sceneShaderParts(customFunctionCode);
        if (sceneParts) customFunctionCode = sceneParts.functions;

        const mainCode = this.generatedCode
            .map(line => '    ' + line)
            .join('\n');

        const shader = `#version 300 es
precision highp float;

${uniformDeclarations}

out vec4 fragColor;

${structDefinitions}

${customFunctionCode}

${sceneParts ? sceneParts.mainOpen : 'void main() {'}
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
            return uniformTypes[uniform] || builtinDeclaration(uniform) || `uniform float ${uniform};`;
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

                if (functionHeaderRegex.test(trimmed) && !/^(if|else|for|while|switch|return)\b/.test(trimmed)) {
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
        // quiet: compiles whose errors are reported elsewhere (debug probes show them on the node)
        if (!this.quiet) console.error('[Shader Compiler Error]', message);
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

// SceneSwitcher compilation (scene functions, shared values, sc_FragCoord)
installSceneCompiler(ShaderCompiler);
installControlCompiler(ShaderCompiler); // control-rate nodes compile to live uniforms (src/core/control/compiler.js)
