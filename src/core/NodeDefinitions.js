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

import { TypeRegistry } from './TypeRegistry.js';

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
        data: { value: 0, useUniform: true },
        hasInputFields: true,
        hasUniformToggle: true,
        isConstantNode: true,
        fieldType: 'int',
        glsl: (node, inputs) => {
            const value = node.data.value !== undefined ? Math.floor(node.data.value) : 0;
            if (node.data.useUniform) {
                return {
                    code: "",
                    output: `${node.varName}`,
                    uniforms: [{ name: node.varName, type: 'int', value: value }]
                };
            } else {
                return {
                    code: "",
                    output: `${value}`
                };
            }
        }
    },

    'Bool': {
        category: 'constant',
        inputs: [],
        outputs: [{ name: 'value', type: 'bool' }],
        uniforms: [],
        data: { value: false, useUniform: true },
        hasInputFields: true,
        hasUniformToggle: true,
        isConstantNode: true,
        fieldType: 'bool',
        glsl: (node, inputs) => {
            const value = node.data.value !== undefined ? node.data.value : false;
            if (node.data.useUniform) {
                return {
                    code: "",
                    output: `${node.varName}`,
                    uniforms: [{ name: node.varName, type: 'bool', value: value }]
                };
            } else {
                return {
                    code: "",
                    output: value ? 'true' : 'false'
                };
            }
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
        isCameraNode: true,
        glsl: (node, inputs) => {
            return {
                code: `vec4 ${node.varName} = texture(u_camera, ${inputs.uv});`,
                output: node.varName
            };
        }
    },

    'ScreenCapture': {
        category: 'input',
        inputs: [{ name: 'uv', type: 'vec2', default: 'gl_FragCoord.xy / u_resolution' }],
        outputs: [{ name: 'color', type: 'vec4' }],
        uniforms: ['u_camera', 'u_resolution'],
        isScreenCaptureNode: true,
        glsl: (node, inputs) => {
            return {
                code: `vec4 ${node.varName} = texture(u_camera, ${inputs.uv});`,
                output: node.varName
            };
        }
    },

    'VideoURL': {
        category: 'input',
        inputs: [{ name: 'uv', type: 'vec2', default: 'gl_FragCoord.xy / u_resolution' }],
        outputs: [{ name: 'color', type: 'vec4' }],
        uniforms: ['u_camera', 'u_resolution'],
        data: { url: '', loop: true, autoplay: true },
        hasInputFields: true,
        isVideoURLNode: true,
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

    'MIDI CC': {
        category: 'input',
        inputs: [],
        outputs: [{ name: 'value', type: 'float' }],
        data: { channel: 1, ccNumber: 1, smoothing: 0.0 },
        hasInputFields: true,
        fieldType: 'float',
        isMidiCCNode: true,
        glsl: (node) => {
            // Use the node's current smoothed value (will be restored from save file)
            const currentValue = node.smoothedValue || 0.0;
            return {
                code: `float ${node.varName} = ${node.varName}_value;`,
                output: node.varName,
                uniforms: [{
                    name: `${node.varName}_value`,
                    type: 'float',
                    value: currentValue,
                    midiCCNodeId: node.id
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

    // ===== STRUCT NODES =====
    'CameraObject': {
        category: 'struct',
        description: 'Create a Camera Object with position, target, and field of view',
        inputs: [
            { name: 'position', type: 'vec3', default: 'vec3(0.0, 0.0, 5.0)' },
            { name: 'target', type: 'vec3', default: 'vec3(0.0, 0.0, 0.0)' },
            { name: 'fov', type: 'float', default: '45.0' }
        ],
        outputs: [{ name: 'camera', type: 'Camera' }],
        glsl: (node, inputs) => {
            return {
                code: `Camera ${node.varName} = Camera(${inputs.position}, ${inputs.target}, ${inputs.fov});`,
                output: node.varName
            };
        }
    },

    'OrbitalCamera': {
        category: 'struct',
        description: 'Create a camera using spherical coordinates (latitude, longitude, radius)',
        inputs: [
            { name: 'latitude', type: 'float', default: '0.0' },
            { name: 'longitude', type: 'float', default: '0.0' },
            { name: 'radius', type: 'float', default: '5.0' },
            { name: 'target', type: 'vec3', default: 'vec3(0.0)' },
            { name: 'fov', type: 'float', default: '45.0' }
        ],
        outputs: [{ name: 'camera', type: 'Camera' }],
        glsl: (node, inputs) => {
            // Convert spherical coordinates to Cartesian
            // latitude: angle from equator (up/down rotation)
            // longitude: angle around axis (left/right rotation)
            return {
                code: `float lat_${node.varName} = ${inputs.latitude};
    float lon_${node.varName} = ${inputs.longitude};
    float rad_${node.varName} = ${inputs.radius};
    vec3 pos_${node.varName} = vec3(
        rad_${node.varName} * cos(lat_${node.varName}) * cos(lon_${node.varName}),
        rad_${node.varName} * sin(lat_${node.varName}),
        rad_${node.varName} * cos(lat_${node.varName}) * sin(lon_${node.varName})
    );
    Camera ${node.varName} = Camera(pos_${node.varName} + ${inputs.target}, ${inputs.target}, ${inputs.fov});`,
                output: node.varName
            };
        }
    },

    'Ray': {
        category: 'struct',
        description: 'Create a ray with origin and direction',
        inputs: [
            { name: 'origin', type: 'vec3', default: 'vec3(0.0)' },
            { name: 'direction', type: 'vec3', default: 'vec3(0.0, 0.0, -1.0)' }
        ],
        outputs: [{ name: 'ray', type: 'Ray' }],
        glsl: (node, inputs) => {
            return {
                code: `Ray ${node.varName} = Ray(${inputs.origin}, normalize(${inputs.direction}));`,
                output: node.varName
            };
        }
    },

    'Blend': {
        category: 'blend',
        description: 'Blend between multiple inputs using a continuous index (e.g., 1.7 blends input 1 and 2)',
        inputs: [
            { name: 'index', type: 'float', default: '0.0' },
            { name: '0', type: 'any', default: null },
            { name: '1', type: 'any', default: null }
        ],
        outputs: [{ name: 'result', type: 'any' }],
        isDynamicInput: true, // Allows dynamic addition of inputs
        minInputs: 2, // Minimum number of blend inputs (excluding index)

        // Custom type validation for 'any' type inputs
        validateTypes: (node, inputTypes, compiler) => {
            // Collect only the connected blend input types and their keys
            // Blend inputs are numbered: '0', '1', '2', etc. (excluding 'index')
            const connectedInputTypes = [];
            const connectedInputKeys = [];
            for (const key in inputTypes) {
                if (key !== 'index' && inputTypes[key] !== null && /^\d+$/.test(key)) {
                    connectedInputTypes.push(inputTypes[key]);
                    connectedInputKeys.push(key);
                }
            }

            // If no inputs are connected, validation passes but we return a default type
            if (connectedInputTypes.length === 0) {
                return { valid: true, outputType: 'vec3' }; // Default to vec3
            }

            // Check if any of the types are structs
            const firstType = connectedInputTypes[0];
            const isStruct = TypeRegistry && TypeRegistry.isStruct && TypeRegistry.isStruct(firstType);

            if (isStruct) {
                // If first type is a struct, all must be the same struct type
                for (let j = 1; j < connectedInputTypes.length; j++) {
                    if (connectedInputTypes[j] !== firstType) {
                        return {
                            valid: false,
                            error: `All struct inputs must be the same type. Found ${connectedInputTypes[j]}, expected ${firstType}`
                        };
                    }
                }
                return { valid: true, outputType: firstType, isStruct: true };
            }

            // Check if all types are blendable primitives
            const validTypes = ['float', 'vec2', 'vec3', 'vec4'];
            for (const type of connectedInputTypes) {
                if (!validTypes.includes(type)) {
                    return { valid: false, error: `Type ${type} is not blendable. Supported types: ${validTypes.join(', ')}, and structs` };
                }
            }

            // Special case: Allow mixing vec3 and vec4 (color compatibility)
            const hasVec3 = connectedInputTypes.includes('vec3');
            const hasVec4 = connectedInputTypes.includes('vec4');

            if (hasVec3 && hasVec4) {
                // Mixed vec3/vec4 - will convert vec3 to vec4
                const hasOtherTypes = connectedInputTypes.some(t => t !== 'vec3' && t !== 'vec4');
                if (hasOtherTypes) {
                    return {
                        valid: false,
                        error: 'Cannot mix vec3/vec4 with other types. Only vec3 and vec4 can be mixed together.'
                    };
                }
                // Store which inputs need conversion
                node.vec3ToVec4Conversions = {};
                for (let i = 0; i < connectedInputKeys.length; i++) {
                    if (connectedInputTypes[i] === 'vec3') {
                        node.vec3ToVec4Conversions[connectedInputKeys[i]] = true;
                    }
                }
                return { valid: true, outputType: 'vec4' }; // Output vec4 when mixing
            }

            // Check if all types are the same (for non-vec3/vec4 primitives)
            for (let i = 1; i < connectedInputTypes.length; i++) {
                if (connectedInputTypes[i] !== firstType) {
                    return {
                        valid: false,
                        error: `All blend inputs must have compatible types. Found ${connectedInputTypes[i]}, expected ${firstType}`
                    };
                }
            }

            // Clear any conversion flags if not mixing
            node.vec3ToVec4Conversions = null;

            // Return the resolved output type
            return { valid: true, outputType: firstType };
        },
        glsl: (node, inputs, compiler) => {
            // Get the resolved output type from the node
            const outputType = node.resolvedOutputType || 'vec3'; // Default to vec3 if not resolved
            const indexValue = inputs.index || '0.0';
            const isStruct = node.resolvedOutputType && TypeRegistry && TypeRegistry.isStruct && TypeRegistry.isStruct(node.resolvedOutputType);

            // Track struct usage in compiler if blending structs
            if (isStruct && compiler && compiler.usedStructs) {
                compiler.usedStructs.add(outputType);
            }

            // Collect all connected blend inputs
            // Only collect inputs that are actually connected (not null)
            // Blend inputs are numbered: '0', '1', '2', etc.
            const blendInputs = [];
            for (const key in inputs) {
                if (key !== 'index' && /^\d+$/.test(key) && inputs[key] !== null && inputs[key] !== undefined) {
                    let inputValue = inputs[key];

                    // Convert vec3 to vec4 if needed
                    if (node.vec3ToVec4Conversions && node.vec3ToVec4Conversions[key]) {
                        inputValue = `vec4(${inputValue}, 1.0)`;
                    }

                    blendInputs.push(inputValue);
                }
            }

            // If no inputs connected, return default value
            if (blendInputs.length === 0) {
                const defaultValue = outputType === 'float' ? '0.0' :
                                   outputType === 'vec2' ? 'vec2(0.0)' :
                                   outputType === 'vec3' ? 'vec3(0.0)' : 'vec4(0.0)';
                return {
                    code: `${outputType} ${node.varName} = ${defaultValue};`,
                    output: node.varName
                };
            }

            // Single input - just pass through
            if (blendInputs.length === 1) {
                return {
                    code: `${outputType} ${node.varName} = ${blendInputs[0]};`,
                    output: node.varName
                };
            }

            // Multiple inputs - generate blend code
            const maxIndex = blendInputs.length - 1;
            let code = `// Blend node: index-based interpolation between ${blendInputs.length} inputs
    float blend_idx_${node.varName} = clamp(${indexValue}, 0.0, ${maxIndex}.0);
    ${outputType} ${node.varName};
`;

            // Generate cascading if-else for blending
            for (let i = 0; i < maxIndex; i++) {
                const condition = i === 0 ? 'if' : 'else if';
                code += `    ${condition} (blend_idx_${node.varName} <= ${i + 1}.0) {\n`;

                // Use appropriate blend function based on type
                if (isStruct) {
                    // For structs, use the generated blend function
                    code += `        ${node.varName} = blend${outputType}(${blendInputs[i]}, ${blendInputs[i + 1]}, blend_idx_${node.varName} - ${i}.0);\n`;
                } else {
                    // For primitives, use built-in mix
                    code += `        ${node.varName} = mix(${blendInputs[i]}, ${blendInputs[i + 1]}, blend_idx_${node.varName} - ${i}.0);\n`;
                }

                code += `    }\n`;
            }

            // Final else for values beyond max index
            code += `    else {\n`;
            code += `        ${node.varName} = ${blendInputs[maxIndex]};\n`;
            code += `    }`;

            return {
                code: code,
                output: node.varName
            };
        }
    },

    'ForLoopStart': {
        category: 'control',
        description: 'Start of a for loop. Connect outputs through loop body to paired ForLoopEnd node.',
        inputs: [],  // Dynamically managed by ForLoopStartNode
        outputs: [], // Dynamically managed by ForLoopStartNode
        isForLoopStartNode: true,
        minInputs: 1,
        glsl: (node, inputs) => {
            const varTypes = node.data.varTypes || ['float'];

            // Use node's varName directly (gets compact numbering from compiler)
            const loopId = node.varName;

            // Get iterations input
            const iterations = inputs.iterations || '10';

            let code = '';

            // Only process connected iteration variables (ignore the free input)
            const connectedVars = [];
            for (let i = 0; i < varTypes.length; i++) {
                const startValue = inputs[`start${i}`];
                if (startValue) {
                    connectedVars.push({ index: i, type: varTypes[i], startValue });
                }
            }

            // Declare loop variables before the loop (simplified naming: node_X_0, node_X_1, etc.)
            for (const varInfo of connectedVars) {
                code += `${varInfo.type} ${loopId}_${varInfo.index} = ${varInfo.startValue};\n`;
            }

            // Begin for loop (will get base indent from buildFragmentShader)
            code += `for (int ${loopId}_i = 0; ${loopId}_i < int(${iterations}); ${loopId}_i++) {\n`;
            // Note: Loop body code from other nodes will be inserted here by the compiler
            // They need to be indented, but they're generated without knowledge of being inside a loop

            // Store output variable names for connection resolution
            node.outputVars = {};
            for (const varInfo of connectedVars) {
                node.outputVars[`inter${varInfo.index}`] = `${loopId}_${varInfo.index}`;
            }

            // Store the remapped loopId so ForLoopEnd can use it
            node.outputVars._loopId = loopId;

            return {
                code: code,
                output: node.varName  // Dummy output for compatibility
            };
        }
    },

    'ForLoopEnd': {
        category: 'control',
        description: 'End of a for loop. Receives modified values from loop body and outputs final results.',
        inputs: [],  // Dynamically managed by ForLoopEndNode
        outputs: [], // Dynamically managed by ForLoopEndNode
        isForLoopEndNode: true,
        minInputs: 1,
        glsl: (node, inputs) => {
            // Get varTypes from paired ForLoopStart (authoritative source)
            let varTypes = ['float'];
            let pairedStartNode = null;

            if (node.data.pairNodeId && node.graph) {
                pairedStartNode = node.graph.nodes.find(n => n.id === node.data.pairNodeId);
                if (pairedStartNode && pairedStartNode.isForLoopStartNode) {
                    varTypes = pairedStartNode.data.varTypes || ['float'];
                }
            } else if (node.data.varTypes) {
                varTypes = node.data.varTypes;
            }

            // Get loopId from paired ForLoopStart's outputVars
            // The start node stores its remapped loopId there during compilation
            let loopId;
            if (pairedStartNode && pairedStartNode.outputVars && pairedStartNode.outputVars._loopId) {
                loopId = pairedStartNode.outputVars._loopId;
            } else {
                loopId = node.varName; // Fallback
            }

            let code = '';

            // Only process connected iteration variables (update loop variables from inputs)
            const connectedIndices = [];
            for (let i = 0; i < varTypes.length; i++) {
                const interInput = inputs[`inter${i}`];
                if (interInput !== undefined) {
                    // Add extra indent since we're inside the loop
                    code += `        ${loopId}_${i} = ${interInput};\n`;
                    connectedIndices.push(i);
                }
            }

            // Break condition (only if connected or non-default value)
            if (inputs.break && inputs.break !== 'false') {
                code += `        if (${inputs.break}) break;\n`;
            }

            // Close the for loop
            code += `    }\n`;

            // Store output variable names for connection resolution (only for connected variables)
            node.outputVars = {};
            for (const i of connectedIndices) {
                node.outputVars[`end${i}`] = `${loopId}_${i}`;
            }

            return {
                code: code,
                output: node.varName  // Dummy output for compatibility
            };
        }
    },

    'Map': {
        category: 'math',
        description: 'Remap a value from one range to another with optional clipping',
        inputs: [
            { name: 'value', type: 'float', default: '0.0' }
        ],
        outputs: [{ name: 'result', type: 'float' }],
        hasInputFields: true,
        isMapNode: true,
        data: {
            inMin: 0.0,
            inMax: 1.0,
            outMin: 0.0,
            outMax: 1.0,
            clip: false
        },
        glsl: (node, inputs) => {
            const value = inputs.value || '0.0';
            const inMin = node.data.inMin !== undefined ? node.data.inMin : 0.0;
            const inMax = node.data.inMax !== undefined ? node.data.inMax : 1.0;
            const outMin = node.data.outMin !== undefined ? node.data.outMin : 0.0;
            const outMax = node.data.outMax !== undefined ? node.data.outMax : 1.0;
            const clip = node.data.clip || false;

            let code = '';

            // Calculate mapped value: (value - inMin) / (inMax - inMin) * (outMax - outMin) + outMin
            const inRange = inMax - inMin;
            const outRange = outMax - outMin;

            // Generate expression
            let expression;
            if (Math.abs(inRange) < 0.0001) {
                // Avoid division by zero
                expression = `${outMin.toFixed(4)}`;
            } else {
                expression = `((${value} - ${inMin.toFixed(4)}) / ${inRange.toFixed(4)} * ${outRange.toFixed(4)} + ${outMin.toFixed(4)})`;
            }

            // Apply clipping if enabled
            if (clip) {
                const clampMin = Math.min(outMin, outMax);
                const clampMax = Math.max(outMin, outMax);
                code = `float ${node.varName} = clamp(${expression}, ${clampMin.toFixed(4)}, ${clampMax.toFixed(4)});`;
            } else {
                code = `float ${node.varName} = ${expression};`;
            }

            return {
                code: code,
                output: node.varName
            };
        }
    },

    // ===== MATH OPERATORS =====
    'Add': {
        category: 'math',
        inputs: [
            { name: 'a', type: 'any', default: '0.0' },
            { name: 'b', type: 'any', default: '0.0' }
        ],
        outputs: [{ name: 'result', type: 'any' }],
        validateTypes: (node, inputTypes) => {
            const typeA = inputTypes.a;
            const typeB = inputTypes.b;

            // If both disconnected, default to float
            if (!typeA && !typeB) {
                return { valid: true, outputType: 'float' };
            }

            // If one is disconnected, use the other's type
            if (!typeA) return { valid: true, outputType: typeB };
            if (!typeB) return { valid: true, outputType: typeA };

            // Both connected - must be same type
            const validTypes = ['float', 'vec2', 'vec3', 'vec4'];
            if (!validTypes.includes(typeA) || !validTypes.includes(typeB)) {
                return { valid: false, error: `Add only supports float, vec2, vec3, vec4. Got ${typeA} and ${typeB}` };
            }

            if (typeA !== typeB) {
                return { valid: false, error: `Both inputs must be the same type. Got ${typeA} and ${typeB}` };
            }

            return { valid: true, outputType: typeA };
        },
        glsl: (node, inputs) => {
            const outputType = node.resolvedOutputType || 'float';
            return {
                code: `${outputType} ${node.varName} = ${inputs.a || '0.0'} + ${inputs.b || '0.0'};`,
                output: node.varName
            };
        }
    },

    'Subtract': {
        category: 'math',
        inputs: [
            { name: 'a', type: 'any', default: '0.0' },
            { name: 'b', type: 'any', default: '0.0' }
        ],
        outputs: [{ name: 'result', type: 'any' }],
        validateTypes: (node, inputTypes) => {
            const typeA = inputTypes.a;
            const typeB = inputTypes.b;

            if (!typeA && !typeB) return { valid: true, outputType: 'float' };
            if (!typeA) return { valid: true, outputType: typeB };
            if (!typeB) return { valid: true, outputType: typeA };

            const validTypes = ['float', 'vec2', 'vec3', 'vec4'];
            if (!validTypes.includes(typeA) || !validTypes.includes(typeB)) {
                return { valid: false, error: `Subtract only supports float, vec2, vec3, vec4. Got ${typeA} and ${typeB}` };
            }

            if (typeA !== typeB) {
                return { valid: false, error: `Both inputs must be the same type. Got ${typeA} and ${typeB}` };
            }

            return { valid: true, outputType: typeA };
        },
        glsl: (node, inputs) => {
            const outputType = node.resolvedOutputType || 'float';
            return {
                code: `${outputType} ${node.varName} = ${inputs.a || '0.0'} - ${inputs.b || '0.0'};`,
                output: node.varName
            };
        }
    },

    'Multiply': {
        category: 'math',
        inputs: [
            { name: 'a', type: 'any', default: '1.0' },
            { name: 'b', type: 'any', default: '1.0' }
        ],
        outputs: [{ name: 'result', type: 'any' }],
        validateTypes: (node, inputTypes) => {
            const typeA = inputTypes.a;
            const typeB = inputTypes.b;

            if (!typeA && !typeB) return { valid: true, outputType: 'float' };
            if (!typeA) return { valid: true, outputType: typeB };
            if (!typeB) return { valid: true, outputType: typeA };

            const validTypes = ['float', 'vec2', 'vec3', 'vec4'];
            if (!validTypes.includes(typeA) || !validTypes.includes(typeB)) {
                return { valid: false, error: `Multiply only supports float, vec2, vec3, vec4. Got ${typeA} and ${typeB}` };
            }

            if (typeA !== typeB) {
                return { valid: false, error: `Both inputs must be the same type. Got ${typeA} and ${typeB}` };
            }

            return { valid: true, outputType: typeA };
        },
        glsl: (node, inputs) => {
            const outputType = node.resolvedOutputType || 'float';
            return {
                code: `${outputType} ${node.varName} = ${inputs.a || '1.0'} * ${inputs.b || '1.0'};`,
                output: node.varName
            };
        }
    },

    'Divide': {
        category: 'math',
        inputs: [
            { name: 'a', type: 'any', default: '1.0' },
            { name: 'b', type: 'any', default: '1.0' }
        ],
        outputs: [{ name: 'result', type: 'any' }],
        validateTypes: (node, inputTypes) => {
            const typeA = inputTypes.a;
            const typeB = inputTypes.b;

            if (!typeA && !typeB) return { valid: true, outputType: 'float' };
            if (!typeA) return { valid: true, outputType: typeB };
            if (!typeB) return { valid: true, outputType: typeA };

            const validTypes = ['float', 'vec2', 'vec3', 'vec4'];
            if (!validTypes.includes(typeA) || !validTypes.includes(typeB)) {
                return { valid: false, error: `Divide only supports float, vec2, vec3, vec4. Got ${typeA} and ${typeB}` };
            }

            if (typeA !== typeB) {
                return { valid: false, error: `Both inputs must be the same type. Got ${typeA} and ${typeB}` };
            }

            return { valid: true, outputType: typeA };
        },
        glsl: (node, inputs) => {
            const outputType = node.resolvedOutputType || 'float';
            return {
                code: `${outputType} ${node.varName} = ${inputs.a || '1.0'} / ${inputs.b || '1.0'};`,
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

        // Int to float conversion
        if (fromType === 'int' && toType === 'float') return true;

        // Float to vec conversions
        if (fromType === 'float' && this.vectors.includes(toType)) return true;

        // Int to vec conversions (via float)
        if (fromType === 'int' && this.vectors.includes(toType)) return true;

        // Vector conversions (expanding)
        if (fromType === 'vec3' && toType === 'vec4') return true;
        if (fromType === 'vec2' && (toType === 'vec3' || toType === 'vec4')) return true;

        // Vector conversions (truncating)
        if (fromType === 'vec4' && (toType === 'vec3' || toType === 'vec2')) return true;
        if (fromType === 'vec3' && toType === 'vec2') return true;

        return false;
    },

    /**
     * Generate conversion code
     */
    convertCode(value, fromType, toType) {
        if (fromType === toType) return value;

        // Int to float
        if (fromType === 'int' && toType === 'float') return `float(${value})`;

        // Float to vec
        if (fromType === 'float' && toType === 'vec2') return `vec2(${value})`;
        if (fromType === 'float' && toType === 'vec3') return `vec3(${value})`;
        if (fromType === 'float' && toType === 'vec4') return `vec4(vec3(${value}), 1.0)`;

        // Int to vec (via float conversion)
        if (fromType === 'int' && toType === 'vec2') return `vec2(float(${value}))`;
        if (fromType === 'int' && toType === 'vec3') return `vec3(float(${value}))`;
        if (fromType === 'int' && toType === 'vec4') return `vec4(vec3(float(${value})), 1.0)`;

        // Vec conversions
        if (fromType === 'vec3' && toType === 'vec4') return `vec4(${value}, 1.0)`;
        if (fromType === 'vec2' && toType === 'vec3') return `vec3(${value}, 0.0)`;
        if (fromType === 'vec2' && toType === 'vec4') return `vec4(${value}, 0.0, 1.0)`;

        // Vec4 to smaller vectors (truncation)
        if (fromType === 'vec4' && toType === 'vec3') return `${value}.xyz`;
        if (fromType === 'vec4' && toType === 'vec2') return `${value}.xy`;
        if (fromType === 'vec3' && toType === 'vec2') return `${value}.xy`;

        return value; // Fallback
    }
};

/**
 * Helper to create node definitions from GLSL function strings
 */
export function createNodeFromGLSL(name, glslCode, metadata = null) {
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
            const inputDef = { name, type, default: getDefaultValue(type) };

            // Check if metadata has additional info for this input (like defaultNode)
            if (metadata && metadata.inputs && metadata.inputs[name]) {
                const inputMetadata = metadata.inputs[name];
                if (inputMetadata.defaultNode) {
                    inputDef.defaultNode = inputMetadata.defaultNode;
                }
                // Override default if specified in metadata
                if (inputMetadata.default) {
                    inputDef.default = inputMetadata.default;
                }
            }

            inputs.push(inputDef);
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
