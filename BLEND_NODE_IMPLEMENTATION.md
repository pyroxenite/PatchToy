# Blend Node Implementation - Complete Guide

## Overview
The Blend node is a powerful, dynamic node that supports blending between multiple inputs of various types using a continuous index value.

## Features

### 1. **"Any" Type System**
- New `any` type that defers type checking to the node itself
- Allows flexible input types that are validated at compile time
- Node can determine compatible types through custom validation

### 2. **Dynamic Input Management**
- Starts with 2 blend inputs (input0, input1) plus an index input
- Automatically adds new inputs when all existing ones are connected
- Properly restores input count when loading saved projects
- Supports unlimited number of inputs

### 3. **Primitive Type Support**
- Supports: `float`, `vec2`, `vec3`, `vec4`
- All blend inputs must be compatible types
- Uses GLSL built-in `mix()` function for primitives

### 4. **Vec3/Vec4 Color Mixing**
- Special case: allows mixing `vec3` and `vec4` inputs
- Automatically converts `vec3` to `vec4` by adding `1.0` alpha channel
- Perfect for blending RGB colors with RGBA colors
- Output type is `vec4` when mixing these types

### 5. **Struct Type Support**
- Fully supports blending custom struct types (Camera, Ray, etc.)
- All struct inputs must be the same type
- Uses generated `blend<StructName>()` functions
- Blend functions are recursively generated for nested structs

## Type Validation Rules

1. **Same Primitive Types**: `vec3 + vec3 + vec3` → `vec3`
2. **Mixed Vec3/Vec4**: `vec3 + vec4 + vec3` → `vec4` (with conversion)
3. **Same Struct Types**: `Camera + Camera` → `Camera`
4. **Invalid**: Mixing incompatible types like `float + vec3`

## Implementation Details

### Node Definition (`NodeDefinitions.js`)
```javascript
'Blend': {
    inputs: [
        { name: 'index', type: 'float', default: '0.0' },
        { name: 'input0', type: 'any', default: null },
        { name: 'input1', type: 'any', default: null }
    ],
    outputs: [{ name: 'result', type: 'any' }],
    isDynamicInput: true,
    minInputs: 2,
    validateTypes: (node, inputTypes, compiler) => { ... },
    glsl: (node, inputs, compiler) => { ... }
}
```

### Type Registry (`TypeRegistry.js`)
- `registerSpecialType('any')` - Registers the any type
- `isAny(typeName)` - Check if a type is 'any'
- `generateBlendFunction(structName)` - Generate blend functions for structs

### Node Class (`Node.js`)
- `addDynamicInput()` - Add a new blend input
- `removeDynamicInput(inputName)` - Remove an input
- `shouldAddNewInput()` - Check if auto-add should trigger
- Properties: `isDynamicInput`, `minInputs`, `resolvedOutputType`, `vec3ToVec4Conversions`

### Shader Compiler (`ShaderCompiler.js`)
- Collects input types during compilation
- Calls `validateTypes()` if defined on node
- Handles 'any' type inputs without auto-conversion
- Updates node's output type dynamically

### Node Graph (`NodeGraph.js`)
- Auto-adds inputs when connections are made
- Restores correct input count on deserialization
- Handles both project loading and copy/paste

## Generated GLSL Examples

### Primitive Blending (vec3)
```glsl
// Blend node: index-based interpolation between 3 inputs
float blend_idx_node_1 = clamp(blend_index, 0.0, 2.0);
vec3 node_1;
if (blend_idx_node_1 <= 1.0) {
    node_1 = mix(color_a, color_b, blend_idx_node_1 - 0.0);
}
else if (blend_idx_node_1 <= 2.0) {
    node_1 = mix(color_b, color_c, blend_idx_node_1 - 1.0);
}
else {
    node_1 = color_c;
}
```

### Vec3/Vec4 Mixed Blending
```glsl
// Blend node: index-based interpolation between 3 inputs
float blend_idx_node_2 = clamp(blend_index, 0.0, 2.0);
vec4 node_2;
if (blend_idx_node_2 <= 1.0) {
    node_2 = mix(vec4(rgb_color, 1.0), rgba_color, blend_idx_node_2 - 0.0);
}
else if (blend_idx_node_2 <= 2.0) {
    node_2 = mix(rgba_color, vec4(another_rgb, 1.0), blend_idx_node_2 - 1.0);
}
else {
    node_2 = vec4(another_rgb, 1.0);
}
```

### Struct Blending (Camera)
```glsl
// Auto-generated blend function
Camera blendCamera(Camera a, Camera b, float t) {
    Camera result;
    result.position = mix(a.position, b.position, t);
    result.target = mix(a.target, b.target, t);
    result.fov = mix(a.fov, b.fov, t);
    return result;
}

// Blend node usage
float blend_idx_node_3 = clamp(cam_blend, 0.0, 1.0);
Camera node_3;
if (blend_idx_node_3 <= 1.0) {
    node_3 = blendCamera(camera_a, camera_b, blend_idx_node_3 - 0.0);
}
else {
    node_3 = camera_b;
}
```

## Usage

1. **Create a Blend node**
2. **Connect the index input** (float value, e.g., 0.0 to 1.0 for 2 inputs)
3. **Connect input0 and input1** with compatible types
4. **A new input automatically appears** when all are connected
5. **Continue adding inputs** as needed
6. **Index value ranges from 0 to (n-1)** where n is the number of inputs

## Index Behavior

- Index 0.0 → 100% input0
- Index 0.5 → 50% input0, 50% input1
- Index 1.0 → 100% input1
- Index 1.5 → 50% input1, 50% input2
- Index 2.0 → 100% input2
- Values beyond max clamp to last input

## Future Enhancements

- Custom blend modes (multiply, add, screen, etc.)
- Weighted blending with individual factors
- Smooth vs. linear interpolation modes
- Support for more primitive types (mat2, mat3, mat4)
