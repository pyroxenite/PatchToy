/**
 * Node Definition System
 *
 * Defines nodes declaratively using GLSL-like syntax.
 * Each node definition includes:
 * - inputs: Array of {name, type, default?}
 * - outputs: Array of {name, type}
 * - glsl: Function that generates GLSL code or literal GLSL string
 * - category: For UI organization
 * - uniforms: Optional uniform declarations needed by this node
 */

export const NodeDefinitions = {
    // ===== OUTPUT NODES =====
    'Preview': {
        category: 'output',
        inputs: [{ name: 'color', type: 'vec4', default: 'vec4(1.0, 0.0, 1.0, 1.0)' }],
        outputs: [],
        isPreviewNode: true,
        glsl: null // Special handling - renders to canvas within the node
    },

    // ===== CONSTANT/VALUE NODES =====
    'Float': {
        category: 'constant',
        inputs: [],
        outputs: [{ name: 'value', type: 'float' }],
        uniforms: [],
        data: { value: 1.0, useUniform: true },
        hasInputFields: true,
        hasUniformToggle: true,
        isConstantNode: true,
        fieldType: 'float',
        glsl: (node, inputs) => {
            const value = node.data.value !== undefined ? node.data.value : 1.0;
            if (node.data.useUniform) {
                return {
                    code: "",
                    output: `${node.varName}`,
                    uniforms: [{ name: node.varName, type: 'float', value: value }]
                };
            } else {
                return {
                    code: "",
                    output: `${value.toFixed(4)}`
                };
            }
        }
    },

    'Int': {
        category: 'constant',
        inputs: [],
        outputs: [{ name: 'value', type: 'int' }],
        uniforms: [],
        data: { value: 0 },
        hasInputFields: true,
        fieldType: 'int',
        glsl: (node, inputs) => {
            // return {
            //     code: `int ${node.varName} = ${Math.floor(node.data.value)};`,
            //     output: node.varName
            // };
            return {
                code: ``,
                output: `${Math.floor(node.data.value)}`
            };
        }
    },

    'Vec2': {
        category: 'constant',
        inputs: [
            { name: 'x', type: 'float', optional: true },
            { name: 'y', type: 'float', optional: true }
        ],
        outputs: [{ name: 'out', type: 'vec2' }],
        data: { x: 0.0, y: 0.0, useUniform: true },
        hasInputFields: true,
        hasUniformToggle: true,
        isConstantNode: true,
        glsl: (node, inputs) => {
            const x = inputs.x || (node.data.x !== undefined ? node.data.x.toFixed(4) : '0.0');
            const y = inputs.y || (node.data.y !== undefined ? node.data.y.toFixed(4) : '0.0');

            if (node.data.useUniform && !inputs.x && !inputs.y) {
                // Only use uniform if no inputs are connected
                const xVal = node.data.x !== undefined ? node.data.x : 0.0;
                const yVal = node.data.y !== undefined ? node.data.y : 0.0;
                return {
                    code: ``,
                    output: `${node.varName}`,
                    uniforms: [{ name: node.varName, type: 'vec2', value: [xVal, yVal] }]
                };
            } else {
                return {
                    code: ``,
                    output: `vec2(${x}, ${y})`
                };
            }
        }
    },

    'Vec3': {
        category: 'constant',
        inputs: [
            { name: 'x', type: 'float', optional: true },
            { name: 'y', type: 'float', optional: true },
            { name: 'z', type: 'float', optional: true }
        ],
        outputs: [{ name: 'out', type: 'vec3' }],
        data: { x: 1.0, y: 0.5, z: 0.0, useUniform: true },
        hasInputFields: true,
        hasUniformToggle: true,
        isConstantNode: true,
        glsl: (node, inputs) => {
            const x = inputs.x || (node.data.x !== undefined ? node.data.x.toFixed(4) : '1.0');
            const y = inputs.y || (node.data.y !== undefined ? node.data.y.toFixed(4) : '0.5');
            const z = inputs.z || (node.data.z !== undefined ? node.data.z.toFixed(4) : '0.0');

            if (node.data.useUniform && !inputs.x && !inputs.y && !inputs.z) {
                const xVal = node.data.x !== undefined ? node.data.x : 1.0;
                const yVal = node.data.y !== undefined ? node.data.y : 0.5;
                const zVal = node.data.z !== undefined ? node.data.z : 0.0;
                return {
                    code: ``,
                    output: `${node.varName}`,
                    uniforms: [{ name: node.varName, type: 'vec3', value: [xVal, yVal, zVal] }]
                };
            } else {
                return {
                    code: `vec3 ${node.varName} = vec3(${x}, ${y}, ${z});`,
                    output: node.varName
                };
            }
        }
    },

    'Vec4': {
        category: 'constant',
        inputs: [
            { name: 'x', type: 'float', optional: true },
            { name: 'y', type: 'float', optional: true },
            { name: 'z', type: 'float', optional: true },
            { name: 'w', type: 'float', optional: true }
        ],
        outputs: [{ name: 'out', type: 'vec4' }],
        data: { x: 1.0, y: 0.0, z: 0.0, w: 1.0, useUniform: true },
        hasInputFields: true,
        hasUniformToggle: true,
        isConstantNode: true,
        glsl: (node, inputs) => {
            const x = inputs.x || (node.data.x !== undefined ? node.data.x.toFixed(4) : '1.0');
            const y = inputs.y || (node.data.y !== undefined ? node.data.y.toFixed(4) : '0.0');
            const z = inputs.z || (node.data.z !== undefined ? node.data.z.toFixed(4) : '0.0');
            const w = inputs.w || (node.data.w !== undefined ? node.data.w.toFixed(4) : '1.0');

            if (node.data.useUniform && !inputs.x && !inputs.y && !inputs.z && !inputs.w) {
                const xVal = node.data.x !== undefined ? node.data.x : 1.0;
                const yVal = node.data.y !== undefined ? node.data.y : 0.0;
                const zVal = node.data.z !== undefined ? node.data.z : 0.0;
                const wVal = node.data.w !== undefined ? node.data.w : 1.0;
                return {
                    code: ``,
                    output: `${node.varName}`,
                    uniforms: [{ name: node.varName, type: 'vec4', value: [xVal, yVal, zVal, wVal] }]
                };
            } else {
                return {
                    code: `vec4 ${node.varName} = vec4(${x}, ${y}, ${z}, ${w});`,
                    output: node.varName
                };
            }
        }
    },

    'Color': {
        category: 'constant',
        inputs: [],
        outputs: [{ name: 'rgb', type: 'vec3' }],
        data: { r: 1.0, g: 0.5, b: 0.0 },
        hasColorPicker: true,
        glsl: (node, inputs) => {
            const r = node.data.r !== undefined ? node.data.r : 1.0;
            const g = node.data.g !== undefined ? node.data.g : 0.5;
            const b = node.data.b !== undefined ? node.data.b : 0.0;
            return {
                code: `vec3 ${node.varName} = vec3(${r.toFixed(4)}, ${g.toFixed(4)}, ${b.toFixed(4)});`,
                output: node.varName
            };
        }
    },

    // ===== UNIFORM/INPUT NODES (JS -> Shader) =====
    'Time': {
        category: 'input',
        inputs: [],
        outputs: [{ name: 'time', type: 'float' }],
        uniforms: ['u_time'],
        glsl: (node, inputs) => {
            // return {
            //     code: `float ${node.varName} = u_time;`,
            //     output: node.varName
            // };
            return {
                code: ``,
                output: "u_time"
            };
        }
    },

    'UV': {
        category: 'input',
        inputs: [],
        outputs: [{ name: 'uv', type: 'vec2' }],
        uniforms: ['u_resolution'],
        data: { mode: 'stretch' },
        glsl: (node, inputs) => {
            const mode = node.data.mode || 'stretch';

            if (mode === 'stretch') {
                // Original behavior - stretch to fill, (0,0) bottom-left, (1,1) top-right
                return {
                    code: `vec2 ${node.varName} = gl_FragCoord.xy / u_resolution;`,
                    output: node.varName
                };
            } else if (mode === 'contain') {
                // Contain - fit inside maintaining aspect ratio, (0.5, 0.5) at center
                return {
                    code: `vec2 ${node.varName}_raw = gl_FragCoord.xy / u_resolution;
    float ${node.varName}_aspect = u_resolution.x / u_resolution.y;
    vec2 ${node.varName};
    if (${node.varName}_aspect > 1.0) {
        ${node.varName} = vec2((${node.varName}_raw.x - 0.5) * ${node.varName}_aspect + 0.5, ${node.varName}_raw.y);
    } else {
        ${node.varName} = vec2(${node.varName}_raw.x, (${node.varName}_raw.y - 0.5) / ${node.varName}_aspect + 0.5);
    }`,
                    output: node.varName
                };
            } else if (mode === 'cover') {
                // Cover - fill maintaining aspect ratio, (0.5, 0.5) at center, all UVs in [0,1]
                return {
                    code: `vec2 ${node.varName}_raw = gl_FragCoord.xy / u_resolution;
    float ${node.varName}_aspect = u_resolution.x / u_resolution.y;
    vec2 ${node.varName};
    if (${node.varName}_aspect > 1.0) {
        ${node.varName} = vec2(${node.varName}_raw.x, (${node.varName}_raw.y - 0.5) / ${node.varName}_aspect + 0.5);
    } else {
        ${node.varName} = vec2((${node.varName}_raw.x - 0.5) * ${node.varName}_aspect + 0.5, ${node.varName}_raw.y);
    }`,
                    output: node.varName
                };
            }
        }
    },

    'Resolution': {
        category: 'input',
        inputs: [],
        outputs: [{ name: 'resolution', type: 'vec2' }],
        uniforms: ['u_resolution'],
        glsl: (node, inputs) => {
            // return {
            //     code: `vec2 ${node.varName} = u_resolution;`,
            //     output: node.varName
            // };
            return {
                code: ``,
                output: "u_resolution"
            };
        }
    },

    'Mouse': {
        category: 'input',
        inputs: [],
        outputs: [{ name: 'mouse', type: 'vec2' }],
        uniforms: ['u_mouse'],
        glsl: (node, inputs) => {
            // return {
            //     code: `vec2 ${node.varName} = u_mouse;`,
            //     output: node.varName
            // };
            return {
                code: ``,
                output: "u_mouse"
            };
        }
    },

    'Camera': {
        category: 'input',
        inputs: [{ name: 'uv', type: 'vec2', default: 'gl_FragCoord.xy / u_resolution' }],
        outputs: [{ name: 'color', type: 'vec4' }],
        uniforms: ['u_camera', 'u_resolution'],
        glsl: (node, inputs) => {
            return {
                code: `vec4 ${node.varName} = texture(u_camera, ${inputs.uv});`,
                output: node.varName
            };
        }
    },

    'Microphone': {
        category: 'input',
        inputs: [],
        outputs: [{ name: 'rms', type: 'float' }],
        isMicrophoneNode: true,
        glsl: (node) => {
            return {
                code: `float ${node.varName} = ${node.varName}_rms;`,
                output: node.varName,
                uniforms: [{
                    name: `${node.varName}_rms`,
                    type: 'float',
                    value: 0.0,
                    microphoneNodeId: node.id
                }]
            };
        }
    },

    'JS': {
        category: 'input',
        inputs: [],
        outputs: [], // Dynamic - determined by return value
        data: { setupCode: '', code: 'return float(Math.sin(u_time));' },
        isJSNode: true,
        glsl: (node, inputs) => {
            // JS nodes output uniforms
            // The actual execution happens in JSNode.execute()
            // Here we just return the cached uniform values
            if (!node._cachedUniforms || node._cachedUniforms.length === 0) {
                return {
                    code: '',
                    output: node.varName,
                    uniforms: []
                };
            }

            // Return uniforms from cached execution
            return {
                code: '',
                output: node.varName,
                uniforms: node._cachedUniforms
            };
        }
    },

    'Feedback': {
        category: 'utility',
        inputs: [{ name: 'in', type: 'vec4' }],
        outputs: [{ name: 'out', type: 'sampler2D' }],
        data: { width: 512, height: 512 },
        isFeedbackNode: true,
        glsl: (node) => {
            // Feedback node provides a sampler2D uniform with previous frame
            return {
                code: '',
                output: `${node.varName}_tex`,
                uniforms: [{
                    name: `${node.varName}_tex`,
                    type: 'sampler2D',
                    feedbackNodeId: node.id  // Special marker for feedback texture
                }]
            };
        }
    },

    'TextureSample': {
        category: 'utility',
        inputs: [
            { name: 'texture', type: 'sampler2D' },
            { name: 'uv', type: 'vec2', default: 'v_uv' }
        ],
        outputs: [{ name: 'color', type: 'vec4' }],
        glsl: (node, inputs) => {
            return {
                code: `vec4 ${node.varName} = texture(${inputs.texture}, ${inputs.uv});`,
                output: node.varName
            };
        }
    },

    // ===== MATH OPERATORS =====
    'Add': {
        category: 'math',
        inputs: [
            { name: 'a', type: 'vec3', default: 'vec3(0.0)' },
            { name: 'b', type: 'vec3', default: 'vec3(0.0)' }
        ],
        outputs: [{ name: 'result', type: 'vec3' }],
        glsl: (node, inputs) => {
            return {
                code: `vec3 ${node.varName} = ${inputs.a} + ${inputs.b};`,
                output: node.varName
            };
        }
    },

    'Subtract': {
        category: 'math',
        inputs: [
            { name: 'a', type: 'vec3', default: 'vec3(0.0)' },
            { name: 'b', type: 'vec3', default: 'vec3(0.0)' }
        ],
        outputs: [{ name: 'result', type: 'vec3' }],
        glsl: (node, inputs) => {
            return {
                code: `vec3 ${node.varName} = ${inputs.a} - ${inputs.b};`,
                output: node.varName
            };
        }
    },

    'Multiply': {
        category: 'math',
        inputs: [
            { name: 'a', type: 'vec3', default: 'vec3(1.0)' },
            { name: 'b', type: 'vec3', default: 'vec3(1.0)' }
        ],
        outputs: [{ name: 'result', type: 'vec3' }],
        glsl: (node, inputs) => {
            return {
                code: `vec3 ${node.varName} = ${inputs.a} * ${inputs.b};`,
                output: node.varName
            };
        }
    },

    'Divide': {
        category: 'math',
        inputs: [
            { name: 'a', type: 'vec3', default: 'vec3(1.0)' },
            { name: 'b', type: 'vec3', default: 'vec3(1.0)' }
        ],
        outputs: [{ name: 'result', type: 'vec3' }],
        glsl: (node, inputs) => {
            return {
                code: `vec3 ${node.varName} = ${inputs.a} / ${inputs.b};`,
                output: node.varName
            };
        }
    },

    // ===== GLSL FUNCTION NODES =====
    'Sin': {
        category: 'math',
        inputs: [{ name: 'x', type: 'float', default: '0.0' }],
        outputs: [{ name: 'result', type: 'float' }],
        glsl: (node, inputs) => {
            return {
                code: `float ${node.varName} = sin(${inputs.x});`,
                output: node.varName
            };
        }
    },

    'Cos': {
        category: 'math',
        inputs: [{ name: 'x', type: 'float', default: '0.0' }],
        outputs: [{ name: 'result', type: 'float' }],
        glsl: (node, inputs) => {
            return {
                code: `float ${node.varName} = cos(${inputs.x});`,
                output: node.varName
            };
        }
    },

    'Mix': {
        category: 'color',
        inputs: [
            { name: 'a', type: 'vec3', default: 'vec3(0.0)' },
            { name: 'b', type: 'vec3', default: 'vec3(1.0)' },
            { name: 't', type: 'float', default: '0.5' }
        ],
        outputs: [{ name: 'result', type: 'vec3' }],
        glsl: (node, inputs) => {
            return {
                code: `vec3 ${node.varName} = mix(${inputs.a}, ${inputs.b}, ${inputs.t});`,
                output: node.varName
            };
        }
    },

    'Length': {
        category: 'math',
        inputs: [{ name: 'v', type: 'vec2', default: 'vec2(0.0)' }],
        outputs: [{ name: 'length', type: 'float' }],
        glsl: (node, inputs) => {
            return {
                code: `float ${node.varName} = length(${inputs.v});`,
                output: node.varName
            };
        }
    },

    // ===== TYPE CONVERSION =====
    'FloatToVec3': {
        category: 'convert',
        inputs: [{ name: 'f', type: 'float', default: '0.0' }],
        outputs: [{ name: 'vec', type: 'vec3' }],
        glsl: (node, inputs) => {
            return {
                code: `vec3 ${node.varName} = vec3(${inputs.f});`,
                output: node.varName
            };
        }
    },

    'Vec3ToVec4': {
        category: 'convert',
        inputs: [
            { name: 'rgb', type: 'vec3', default: 'vec3(0.0)' },
            { name: 'a', type: 'float', default: '1.0' }
        ],
        outputs: [{ name: 'rgba', type: 'vec4' }],
        glsl: (node, inputs) => {
            return {
                code: `vec4 ${node.varName} = vec4(${inputs.rgb}, ${inputs.a});`,
                output: node.varName
            };
        }
    },

    // ===== EXAMPLE: CUSTOM GLSL FUNCTION NODE =====
    'Circle': {
        category: 'shape',
        inputs: [
            { name: 'uv', type: 'vec2', default: 'vec2(0.5)' },
            { name: 'radius', type: 'float', default: '0.3' }
        ],
        outputs: [{ name: 'sdf', type: 'float' }],
        glsl: (node, inputs) => {
            // This generates inline code
            return {
                code: `float ${node.varName} = length(${inputs.uv} - vec2(0.5)) - ${inputs.radius};`,
                output: node.varName
            };
        }
    },

    'Smoothstep': {
        category: 'math',
        inputs: [
            { name: 'edge0', type: 'float', default: '0.0' },
            { name: 'edge1', type: 'float', default: '1.0' },
            { name: 'x', type: 'float', default: '0.5' }
        ],
        outputs: [{ name: 'result', type: 'float' }],
        glsl: (node, inputs) => {
            return {
                code: `float ${node.varName} = smoothstep(${inputs.edge0}, ${inputs.edge1}, ${inputs.x});`,
                output: node.varName
            };
        }
    }
};

/**
 * Type system for GLSL types
 */
export const TypeSystem = {
    // Primitive types
    primitives: ['float', 'int', 'bool', 'uint'],

    // Vector types
    vectors: ['vec2', 'vec3', 'vec4', 'ivec2', 'ivec3', 'ivec4', 'bvec2', 'bvec3', 'bvec4'],

    // Matrix types
    matrices: ['mat2', 'mat3', 'mat4'],

    // Sampler types
    samplers: ['sampler2D', 'samplerCube'],

    // Custom struct definitions (can be extended)
    structs: {},

    /**
     * Register a custom struct type
     */
    registerStruct(name, definition) {
        this.structs[name] = definition;
    },

    /**
     * Check if a type is valid
     */
    isValidType(type) {
        return this.primitives.includes(type) ||
               this.vectors.includes(type) ||
               this.matrices.includes(type) ||
               this.samplers.includes(type) ||
               this.structs.hasOwnProperty(type);
    },

    /**
     * Auto-convert between compatible types
     */
    canConvert(fromType, toType) {
        if (fromType === toType) return true;

        // Float to vec conversions
        if (fromType === 'float' && this.vectors.includes(toType)) return true;

        // Vec3 to Vec4
        if (fromType === 'vec3' && toType === 'vec4') return true;

        // Vec2 to Vec3/Vec4
        if (fromType === 'vec2' && (toType === 'vec3' || toType === 'vec4')) return true;

        return false;
    },

    /**
     * Generate conversion code
     */
    convertCode(value, fromType, toType) {
        if (fromType === toType) return value;

        if (fromType === 'float' && toType === 'vec2') return `vec2(${value})`;
        if (fromType === 'float' && toType === 'vec3') return `vec3(${value})`;
        if (fromType === 'float' && toType === 'vec4') return `vec4(vec3(${value}), 1.0)`;
        if (fromType === 'vec3' && toType === 'vec4') return `vec4(${value}, 1.0)`;
        if (fromType === 'vec2' && toType === 'vec3') return `vec3(${value}, 0.0)`;
        if (fromType === 'vec2' && toType === 'vec4') return `vec4(${value}, 0.0, 1.0)`;

        return value; // Fallback
    }
};

/**
 * Helper to create node definitions from GLSL function strings
 */
export function createNodeFromGLSL(name, glslCode) {
    // Parse GLSL function signature
    // Example: "vec3 myFunction(vec2 uv, float time)"
    const funcMatch = glslCode.match(/(\w+)\s+(\w+)\s*\((.*?)\)/);
    if (!funcMatch) {
        throw new Error('Invalid GLSL function format');
    }

    const [, returnType, funcName, params] = funcMatch;

    // Parse parameters
    const inputs = [];
    if (params.trim()) {
        const paramList = params.split(',').map(p => p.trim());
        for (const param of paramList) {
            const [type, name] = param.split(/\s+/);
            inputs.push({ name, type, default: getDefaultValue(type) });
        }
    }

    return {
        category: 'custom',
        inputs,
        outputs: [{ name: 'result', type: returnType }],
        glslFunction: glslCode,
        glsl: (node, inputs) => {
            const args = Object.values(inputs).join(', ');
            return {
                code: `${returnType} ${node.varName} = ${funcName}(${args});`,
                output: node.varName,
                requiresFunction: funcName
            };
        }
    };
}

function getDefaultValue(type) {
    if (type === 'float') return '0.0';
    if (type === 'int') return '0';
    if (type === 'bool') return 'false';
    if (type.startsWith('vec')) return `${type}(0.0)`;
    if (type.startsWith('mat')) return `${type}(1.0)`;
    return `${type}()`;
}
