# PatchToy - GLSL Node Editor

A node-based editor for creating GLSL shaders visually.

## Getting Started

```bash
npm install
npm run dev
```

## How It Works

### Node Connections

**Single Connection Per Input**: Each input port can only have ONE connection at a time. When you connect a new cable to an input that already has a connection, the old connection is automatically removed. This prevents ambiguity in the shader compilation process.

To disconnect an input, simply click on the input port (the circle on the left side of a node).

### Data Type System

Every port has a specific data type:

- `float` - Single floating-point value
- `vec2` - 2D vector (x, y)
- `vec3` - 3D vector (x, y, z) - commonly used for RGB colors
- `vec4` - 4D vector (x, y, z, w) - commonly used for RGBA colors

**Type Conversion**: When connecting to the Output node, the shader compiler automatically converts types to `vec4`:
- `vec3` → `vec4`: Adds alpha = 1.0
- `float` → `vec4`: Expands to grayscale with alpha = 1.0
- `vec2` → `vec4`: Adds z = 0.0, w = 1.0

See [ShaderCompiler.js:106-117](src/ShaderCompiler.js#L106-L117) for the conversion logic.

**Type Compatibility**: Currently, connections don't enforce type matching (you can connect any type to any input). The shader compiler will use the actual output type from the source node. Future versions may add type validation.

## Available Nodes

### Value Nodes (Editable)
- **Vec2**: 2D vector with editable x, y values
- **Vec3**: 3D vector with editable x, y, z values (great for colors!)
- **Vec4**: 4D vector with editable x, y, z, w values

These nodes have text input fields that you can edit to change their values in real-time.

### Input Nodes
- **Time**: Provides elapsed time in seconds (useful for animations)

### Math Nodes
- **Add**: Adds two vec3 values
- **Multiply**: Multiplies two vec3 values

### Output Nodes
- **Output**: Final shader output (must have exactly one)

## Editing Vector Values

Vector nodes (Vec2, Vec3, Vec4) have editable text input fields:
1. Each component (x, y, z, w) has its own input field
2. Click on an input field to type a new value
3. Press Enter or click away to apply the change
4. Changes update in real-time when you compile the shader

## Shader Compilation

Click the **Compile Shader** button to:
1. Generate GLSL code from your node graph
2. Compile the shader
3. Display the result in the preview window (bottom-right)

The generated GLSL code is logged to the browser console so you can see what was created.

## Tips

- Drag nodes by clicking and dragging on the node body
- Connect nodes by dragging from an output port (right side) to an input port (left side)
- Try connecting a Vec3 to the Output to create a solid color
- Use Time with Multiply to create animated effects
- Check the browser console for compilation errors or generated shader code
