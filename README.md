# PatchToy

A node-based visual editor for creating GLSL shaders in real-time.

**Try it**: [patchtoy.com](https://patchtoy.com)

## Development

```bash
npm install
npm run dev
```

Open `http://localhost:8080` in your browser.

## Architecture

PatchToy compiles node graphs directly to GLSL fragment shaders. Key architectural decisions:

**Single-Pass Compilation**: The shader compiler traverses the graph once, generating GLSL code in dependency order. Nodes are cached after first compilation to avoid duplicate code generation.

**Type System with Struct Support**: Beyond basic GLSL types (`float`, `vec2-4`, `int`, `bool`), PatchToy supports custom struct types (Camera, Ray) with member access via dot notation. The TypeRegistry handles struct definitions and generates blend functions automatically.

**Multi-Output Nodes**: Nodes like ForLoopEnd output multiple independent variables. The `outputVars` mapping system lets each output port reference a different GLSL variable name.

**Accessor System**: Connections support chained accessors (`.position.xy`) combining struct member access and swizzles. Type resolution happens at compile time through the accessor chain.

**Paired Nodes**: ForLoopStart and ForLoopEnd work as a pair, with ForLoopStart as the authoritative source. The pair shares configuration but compiles independently, with the end node reading the start node's remapped variable names via `outputVars`.

## Core Features

### ForLoop Nodes
Create iteration by connecting ForLoopStart → loop body → ForLoopEnd. Iteration variables are added dynamically - connect to a free input on ForLoopStart to add one. The corresponding output/input/output appears on both nodes. Only connected iteration variables generate shader code.

### Struct Accessors
Access struct members and swizzle in one connection:
- **Type while dragging**: Start dragging a connection, type `.position.xy`
- **Click cable midpoint**: Click the dot on an existing connection to add/edit accessor

### Blend Node
Interpolate between N inputs using a continuous index. `index=1.7` blends between inputs 1 and 2. Supports primitives (`float`-`vec4`) and struct types (auto-generates blend functions).

### Uniform Toggle
Constant nodes (Float, Vec3, etc.) can switch between literal values and uniforms. Uniform mode makes values animatable and editable in the UI.

## Controls

- **Tab**: Open node browser
- **Drag**: Move nodes or create selection box
- **Shift+Click**: Multi-select nodes
- **Delete/Backspace**: Delete selection
- **Click input port**: Disconnect
- **Double-click node**: Open inspector (for nodes with dialogs)
- **Click connection midpoint**: Add accessor

## Shader Inspection

Each Preview node has a "View Compiled Shader" button showing the generated GLSL. Compilation errors highlight the problematic node in red.

## Cloud Saves

Save/load projects to the cloud (requires account). Projects are private by default.

## Tips

- Use ForLoops for raymarching (distance field iteration)
- Blend nodes work great for color palettes, 3D camera interpolation or transitioning between scenes 
- Uniform mode constants + Map node = easy parameter ranges
- Check compiled shader output to debug generation issues
