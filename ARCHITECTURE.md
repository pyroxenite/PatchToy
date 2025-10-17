# PatchToy Architecture

## Overview

PatchToy uses a declarative node definition system where nodes are defined from GLSL-like specifications rather than hard-coded logic. This makes it easy to add new nodes without modifying core systems.

## Core Concepts

### 1. Node Definitions ([src/NodeDefinitions.js](src/NodeDefinitions.js))

All nodes are defined in a single centralized location. Each node definition includes:

```javascript
'NodeName': {
    category: 'math',  // For UI organization
    inputs: [
        { name: 'a', type: 'vec3', default: 'vec3(0.0)' }
    ],
    outputs: [
        { name: 'result', type: 'vec3' }
    ],
    uniforms: ['u_time'],  // Optional: uniforms needed
    data: { value: 1.0 },  // Optional: editable data
    hasInputFields: true,  // Optional: show UI inputs
    glsl: (node, inputs) => {
        return {
            code: `vec3 ${node.varName} = ${inputs.a} * 2.0;`,
            output: node.varName,
            requiresFunction: 'customFunc'  // Optional
        };
    }
}
```

### 2. Type System

The `TypeSystem` object handles GLSL type validation and automatic conversion:

**Supported Types:**
- Primitives: `float`, `int`, `bool`, `uint`
- Vectors: `vec2`, `vec3`, `vec4`, `ivec2/3/4`, `bvec2/3/4`
- Matrices: `mat2`, `mat3`, `mat4`
- Samplers: `sampler2D`, `samplerCube`
- Custom Structs: Registered via `TypeSystem.registerStruct()`

**Auto-conversion:**
```javascript
float → vec3    // Expands to vec3(value)
vec3 → vec4     // Adds alpha = 1.0
vec2 → vec3/4   // Fills missing components
```

### 3. Compilation Process

The `ShaderCompiler` traverses the node graph starting from the Output node:

1. **Validation Phase** ([ShaderCompiler.js:202-226](src/ShaderCompiler.js#L202-L226))
   - Checks for output node
   - Detects cycles
   - Warns about disconnected nodes

2. **Compilation Phase** ([ShaderCompiler.js:61-139](src/ShaderCompiler.js#L61-L139))
   - Recursive traversal from output to inputs
   - Collects required uniforms
   - Generates GLSL code per node
   - Handles type conversions
   - Caches results to avoid recompilation

3. **Shader Generation** ([ShaderCompiler.js:141-166](src/ShaderCompiler.js#L141-L166))
   - Assembles uniform declarations
   - Includes custom function definitions
   - Builds main() function with generated code

## Answering Your Questions

### How do we handle custom types (structs)?

**Register custom struct:**
```javascript
TypeSystem.registerStruct('MyStruct', `
struct MyStruct {
    vec3 color;
    float intensity;
};
`);
```

**Use in node definition:**
```javascript
'StructNode': {
    category: 'custom',
    outputs: [{ name: 'data', type: 'MyStruct' }],
    glsl: (node, inputs) => ({
        code: `MyStruct ${node.varName} = MyStruct(vec3(1.0), 0.5);`,
        output: node.varName
    })
}
```

The compiler will automatically include struct definitions in the shader preamble.

### How do we handle JS → Shader uniforms?

**Two-step process:**

1. **Declare in node definition:**
```javascript
'CustomInput': {
    category: 'input',
    outputs: [{ name: 'value', type: 'float' }],
    uniforms: ['u_myCustomValue'],  // Declares uniform dependency
    glsl: (node, inputs) => ({
        code: `float ${node.varName} = u_myCustomValue;`,
        output: node.varName
    })
}
```

2. **Update ShaderCompiler to recognize it:**
```javascript
// In ShaderCompiler.getUniformDeclaration()
const uniformTypes = {
    'u_time': 'uniform float u_time;',
    'u_myCustomValue': 'uniform float u_myCustomValue;',
    // ...
};
```

3. **Set value in ShaderPreview:**
```javascript
// In ShaderPreview.render()
if (this.uniforms.u_myCustomValue) {
    gl.uniform1f(this.uniforms.u_myCustomValue, myValue);
}
```

The compiler automatically collects all uniforms from used nodes and includes them in the shader.

### How do we handle type checking?

**Automatic type compatibility checking** ([ShaderCompiler.js:98-110](src/ShaderCompiler.js#L98-L110)):

```javascript
// When connecting nodes, the compiler checks:
if (!TypeSystem.canConvert(sourceType, targetType)) {
    this.addWarning(`Type mismatch: connecting ${sourceType} to ${targetType}`);
}

// Auto-converts if possible:
inputValues[input.name] = TypeSystem.convertCode(
    sourceResult.output,
    sourceType,
    targetType
);
```

You can extend `TypeSystem.canConvert()` and `TypeSystem.convertCode()` to add more type conversions.

### How do we handle compilation errors?

**Three levels of error reporting:**

1. **Graph Validation Errors** (before compilation)
   - Missing output node
   - Cycles in graph
   - Multiple output nodes

2. **Compilation Errors** (during node processing)
   - Missing node definitions
   - Invalid GLSL generators
   - Collected in `compiler.errors[]`

3. **Shader Compilation Errors** (WebGL errors)
   - GLSL syntax errors
   - Linker errors
   - Shown in UI via error callback

**UI Display:** Errors appear as red notifications in top-left corner for 5 seconds.

## Adding Custom GLSL Function Nodes

### Method 1: Simple Inline Function

```javascript
'Noise': {
    category: 'procedural',
    inputs: [{ name: 'p', type: 'vec2', default: 'vec2(0.0)' }],
    outputs: [{ name: 'n', type: 'float' }],
    glsl: (node, inputs) => ({
        code: `float ${node.varName} = fract(sin(dot(${inputs.p}, vec2(12.9898, 78.233))) * 43758.5453);`,
        output: node.varName
    })
}
```

### Method 2: With Custom GLSL Function

```javascript
'FBM': {
    category: 'procedural',
    inputs: [{ name: 'p', type: 'vec2', default: 'vec2(0.0)' }],
    outputs: [{ name: 'fbm', type: 'float' }],
    glslFunction: `
float fbm(vec2 p) {
    float value = 0.0;
    float amplitude = 0.5;
    for(int i = 0; i < 5; i++) {
        value += amplitude * fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
        p *= 2.0;
        amplitude *= 0.5;
    }
    return value;
}`,
    glsl: (node, inputs) => ({
        code: `float ${node.varName} = fbm(${inputs.p});`,
        output: node.varName,
        requiresFunction: 'fbm'  // Tells compiler to include the function
    })
}
```

### Method 3: From GLSL String (Helper Function)

```javascript
import { createNodeFromGLSL } from './src/NodeDefinitions.js';

const myNode = createNodeFromGLSL('MyFunc', `
vec3 myCustomFunction(vec2 uv, float time) {
    return vec3(sin(uv.x + time), cos(uv.y + time), 0.5);
}
`);

// Add to NodeDefinitions
NodeDefinitions['MyCustom'] = myNode;
```

## Connection Behavior

- **One connection per input**: When you connect to an input that already has a connection, the old connection is automatically removed ([NodeGraph.js:200-203](src/NodeGraph.js#L200-L203))
- **Multiple outputs allowed**: One output can connect to multiple inputs
- **No cycles**: The compiler detects and rejects cyclic graphs

## Node Categories

Nodes are organized by category in the Add Node menu:

- `output` - Output nodes (only one allowed)
- `constant` - Constant value nodes (Vec2, Vec3, Vec4, Float)
- `input` - Uniform/input nodes (Time, UV, Mouse, Resolution)
- `math` - Math operations (Add, Multiply, Sin, Cos, etc.)
- `color` - Color operations (Mix, etc.)
- `convert` - Type conversions
- `shape` - Shape/SDF nodes
- `custom` - User-defined nodes

## Performance Considerations

- **Node caching**: Each node is compiled only once per compilation pass
- **Lazy uniform collection**: Only uniforms from connected nodes are included
- **Dead code elimination**: WebGL compiler removes unused code
- **Input validation**: Happens once before compilation starts

## Extending the System

### Adding a New Node Type

1. Add definition to [src/NodeDefinitions.js](src/NodeDefinitions.js)
2. If it uses new uniforms, add them to `ShaderCompiler.getUniformDeclaration()`
3. If it uses new uniforms, add them to `ShaderPreview.render()`
4. Done! The UI will automatically show it in the Add Node menu

### Adding a New Type

1. Add to `TypeSystem.primitives/vectors/matrices/samplers` or register a struct
2. Add conversion rules to `TypeSystem.canConvert()`
3. Add conversion code to `TypeSystem.convertCode()`

### Customizing Compilation

Override methods in `ShaderCompiler`:
- `compileNode()` - Change how individual nodes compile
- `buildFragmentShader()` - Change shader structure
- `validate()` - Add custom validation rules

## Example: Complete Custom Node

```javascript
'Gradient': {
    category: 'color',
    inputs: [
        { name: 'uv', type: 'vec2', default: 'vec2(0.5)' },
        { name: 'colorA', type: 'vec3', default: 'vec3(1.0, 0.0, 0.0)' },
        { name: 'colorB', type: 'vec3', default: 'vec3(0.0, 0.0, 1.0)' },
        { name: 'angle', type: 'float', default: '0.0' }
    ],
    outputs: [{ name: 'color', type: 'vec3' }],
    glsl: (node, inputs) => {
        return {
            code: `
    vec2 dir_${node.id} = vec2(cos(${inputs.angle}), sin(${inputs.angle}));
    float t_${node.id} = dot(${inputs.uv} - vec2(0.5), dir_${node.id}) + 0.5;
    vec3 ${node.varName} = mix(${inputs.colorA}, ${inputs.colorB}, t_${node.id});`,
            output: node.varName
        };
    }
}
```

This architecture makes it trivial to add new nodes while maintaining type safety and automatic shader generation!
