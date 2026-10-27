# TODO
 - ~~Feedback node may be broken~~ fixed: TextureSample defaulted to an undeclared `v_uv`, feedback shaders were never compiled after a project load, and the cable accessor into Feedback was ignored
 - ~~Swizzles sometimes don't have an effect on the produced GLSL code~~ fixed: the accessor on the cable into a Preview / Feedback node was dropped
 - Fullscreen works but it matches the size of the window and not the size of the screen
 - Save button disappears
 - More uniforms:
   - Midi
     - Control CC done
     - Midi notes
       - Event detector with attack release
       - Midi pitch (highest/lowest/last, ) (MidiNote node: gate / velocity / last note / pitch)
   - BPM tracking?
   - Frequency bands
   - ~~XY controller~~ (XYPad node)
   - ~~Keyboard~~ (Keyboard node)
 - More modules:
   - ~~Basic transforms~~ (UV & Transform, 3D domain nodes)
   - Video sources:
     - Multiple camera support (device picker on Camera node)
     - System audio capture node
     - File upload node (images/videos with persistence)
 - Website Icon
 - Initial preview node resolution bug
 - GLSL code editor size, position, visibility states should be saved to project
 - GLSL code editor should close when switching projects
 - Key command to toggle fps view
 - Dirty editors aren't preserved
 - Better errors for auth
 - Add text field in swizzle selector

# Big features
  - User settings, project settings, display settings
  - JS computation nodes for more complex scenarios
    - Manipulate more complex objects on the CPU side
    - Run simulations etc...
    - Must output to uniforms
    - Either a new type of uniform node or a new type of connection with a JS value to uniform adaptor, or automatic value passing via uniforms when connecting a JS output to a GLSL input
  - Better project management (almost done but local auto saving is broken)
  - User profile view, project thumbnails
  - Custom UI (current UI is boring, buggy, not always practical)
    - Pixel art would be fire but requires some sort of mini custom canvas UI lib
    - Titles currently are inconsistent
    - Special node style for uniforms
  - ~~Node groups (should support groups of groups too)~~ simple groups done (src/graph/NodeGroups.js: nested groups, box ports from boundary cables, breadcrumbs); reusable group definitions still to do
    - Two types of groups:
      - Simple groups, just visual simplifications
      - Custom node groups: they define a new type of node and sync changes across all nodes that share the node group definition
  - Multi input mixing
    - Optionnal lazy evaluation for inputs that require high computation

---

# Code Quality & Architecture Improvements

Comprehensive list of technical debt, performance issues, reliability problems, and architectural improvements identified across the codebase. Organized by priority and category.

---

## Critical Performance

### [x] Consolidate all requestAnimationFrame loops into a single render loop
Done: `src/rendering/RenderLoop.js`, driven by the main loop after the Feedback passes; off-screen / closed-group previews are skipped.

Each `ShaderPreview` instance runs its own independent RAF loop (`ShaderPreview.js:358`), and the main animation loop in `main.js:64-71` runs separately. With 3 preview nodes + 1 background + 1 main loop, that's 5 independent RAF callbacks per frame, all doing full render passes with uniform updates.

**Fix:** Create a single `RenderLoop` class that manages one RAF callback. All renderers register with this loop and get called in sequence each frame. Remove the individual `animate()` RAF scheduling from `ShaderPreview`.

**Files:** `ShaderPreview.js`, `main.js`, `FeedbackRenderer.js`, `BackgroundRenderer.js`

### [x] Eliminate per-frame readPixels() calls in PreviewNode
Done: GPU copy (`glResources.presentTexture` + `drawImage`), only for new frames.

`PreviewNode.js:62-101` -- `getDisplayCanvas()` calls `gl.readPixels()` (GPU-to-CPU transfer) every frame for every preview node. This stalls the GPU pipeline and is one of the most expensive WebGL operations. With 3 previews, this blocks the pipeline 3 times per frame.

**Fix options:**
- Use WebGL2 `blitFramebuffer()` to copy between framebuffers without CPU roundtrip
- Add a dirty flag so `readPixels` is only called when the shader output actually changes
- For preview display, consider using the WebGL canvas directly with `drawImage()` from the shared GL canvas after rendering to the default framebuffer
- If unavoidable, use async readback with `gl.fenceSync()` / `gl.clientWaitSync()` or PBO-based async reads (WebGL2)

**Files:** `PreviewNode.js` (lines 62-101), `ShaderPreview.js`

### [x] Fix O(p*u*n) uniform registration with inverse lookup map
Done: `findNodeByRemappedName` uses a cached inverse map.

`CompilationManager.js:136-210` has a triple nested loop: preview nodes * uniforms * `findNodeByRemappedName()`. The inner function (lines 224-226) iterates the entire `nodeIdRemap` map, then does another `Array.find()` on all nodes. With 3 previews * 10 uniforms * 50 nodes = 1,500 operations per compile.

**Fix:** After `ShaderCompiler` creates its `nodeIdRemap`, immediately build an inverse map (`mappedId -> originalId`) and a node lookup map (`id -> node`). Then `findNodeByRemappedName` becomes O(1).

**Files:** `CompilationManager.js`

### [x] Cache active video node reference instead of per-frame Array.find()
Done: one shared camera texture per context, uploaded once per frame and only for shaders using `u_camera` (`glResources.cameraTexture`).

`ShaderPreview.js:224-253` -- `updateCameraTexture()` calls `Array.find()` across all nodes every single frame to locate the active video node. This is O(n) in a hot path that runs 60 times per second.

**Fix:** Cache the active video node reference when it changes (when a camera/video/screen capture node is enabled or disabled). The per-frame method should just read the cached reference.

**Files:** `ShaderPreview.js` (lines 224-253), `CameraNode.js`, `VideoURLNode.js`, `ScreenCaptureNode.js`

### [ ] Stop recreating button hit-test objects and connection data every frame
Two hot-path allocation issues:

1. `PreviewNode.js:323-327` -- Button position objects `({ x, y, width, height })` are recreated every frame during `draw()`. Should be cached and only recomputed on node move/resize.

2. `GraphRenderer.js:45-65` -- Connection positions, labels, and midpoints are recomputed for every connection every frame, even when the graph hasn't changed. Should use a dirty flag and cache computed values.

**Files:** `PreviewNode.js`, `GraphRenderer.js`, `NodeGraph.js` (Connection class)

---

## Memory Leaks & Resource Safety

### [x] Fix texture and framebuffer memory leaks in ShaderPreview.destroy()
Done: `destroy()` frees the render target and releases the shared program; quad / noise / camera texture are shared per context; `NodeGraph.disposeNodes` runs on project switch.

`ShaderPreview.js:519-527` -- `destroy()` deletes the WebGL program but never deletes textures (`cameraTexture`, framebuffer textures). When preview nodes are deleted or shaders recompile, these GPU resources leak.

**Fix:** In `destroy()`, add cleanup for:
- `gl.deleteTexture(this.cameraTexture)`
- `gl.deleteTexture(this.framebuffer.texture)` for offscreen nodes
- `gl.deleteFramebuffer(this.framebuffer.framebuffer)`
- `gl.deleteBuffer(this.positionBuffer)`

**Files:** `ShaderPreview.js` (lines 519-527), `BackgroundRenderer.js` (lines 117-128)

### [ ] Store main animation loop RAF ID and provide stop mechanism
`main.js:64-71` -- The main animation loop calls `requestAnimationFrame` but never stores the returned ID. The loop can never be cancelled. If the app is re-initialized (e.g., Vite HMR), multiple loops run simultaneously.

**Fix:** Store the RAF ID. Add `stopAnimationLoop()` that calls `cancelAnimationFrame()`. Call it before starting a new loop and in any cleanup/destroy path.

**Files:** `main.js` (lines 64-71)

### [ ] Add event listener cleanup and prevent accumulation
106 `addEventListener` calls vs only 10 `removeEventListener` calls. Window-level listeners (`main.js:195-205` paste handler, etc.) have no removal mechanism. Duplicate listeners accumulate on re-init.

**Fix:** Use `AbortController` pattern to group listeners:
```javascript
this.abortController = new AbortController();
window.addEventListener('paste', handler, { signal: this.abortController.signal });
// Cleanup: this.abortController.abort() removes all listeners at once
```

Add a `destroy()` method to `PatchToy` that aborts the controller, destroys all renderers, and stops the animation loop.

**Files:** `main.js`, `NodeGraph.js`, `UIHelpers.js`, `FloatingCodeEditor.js`

### [ ] Add WebGL context loss and restoration handling
No `webglcontextlost` or `webglcontextrestored` event listeners anywhere. When the browser reclaims GPU resources under memory pressure (common on mobile, or with many WebGL tabs), the app crashes with no recovery.

**Fix:** Add context loss handling on `sharedGLCanvas`:
- On `webglcontextlost`: call `e.preventDefault()`, stop animation loop, notify renderers, show user message
- On `webglcontextrestored`: reinitialize all GPU resources, recompile shaders, restart loop

Each renderer needs a `reinitialize()` method that recreates its GPU resources from scratch.

**Files:** `main.js`, `ShaderPreview.js`, `FeedbackRenderer.js`, `BackgroundRenderer.js`, `FeedbackNode.js`

### [ ] Remove gl.__feedbackPositionBuffer context pollution
`FeedbackRenderer.js:316-326` attaches a buffer directly to the GL context object as `gl.__feedbackPositionBuffer`. This pollutes the context, can conflict with other code, and the buffer is never cleaned up.

**Fix:** Store the position buffer as an instance property of `FeedbackRenderer`. Add cleanup in a `destroy()` method.

**Files:** `FeedbackRenderer.js` (lines 316-326)

### [ ] Clean up window.toy global and add proper app lifecycle
`main.js:874` -- `window.toy = new PatchToy()` sets a global. If the app is re-initialized (Vite HMR), the old instance isn't cleaned up -- animation loops keep running, listeners accumulate, WebGL resources leak.

**Fix:** Add a `destroy()` method to `PatchToy`. Check for and destroy the old instance before creating a new one. Add Vite HMR disposal:
```javascript
if (import.meta.hot) {
    import.meta.hot.dispose(() => { window.toy?.destroy(); });
}
```

**Files:** `main.js`

---

## Reliability & Race Conditions

### [ ] Add compilation mutex to prevent race conditions
`main.js:359-368` -- `onGraphChanged` calls `compileFeedbackShaders()` synchronously and `scheduleCompile()` with debounce. Rapid graph changes can trigger compilation while a previous compile is still in progress, leading to inconsistent state.

**Fix:** Add an `isCompiling` flag to `CompilationManager`. If a compile is requested while one is running, set a `pendingCompile` flag and re-trigger after the current one finishes.

**Files:** `CompilationManager.js`, `FeedbackRenderer.js`, `main.js`

### [ ] Add error handling to all async button handlers
Multiple async operations triggered by UI buttons have no error handling:

- `main.js:227-229` -- Camera button: no try/catch. Permission denial causes uncaught rejection.
- `main.js:231-233` -- Microphone button: same issue.
- `main.js:237-239` -- MIDI button: same issue.
- `MicrophoneNode.js:31-40` -- `this.enable().then()` with no `.catch()`.
- `main.js:432` -- `saveToCloud().then()` with no `.catch()`.

**Fix:** Wrap all async button handlers in try/catch with user-facing error messages. Add `.catch()` to all `.then()` chains.

**Files:** `main.js`, `MicrophoneNode.js`

### [ ] Fix editorStates.length >= 0 logic bug
`main.js:854-863`:
```javascript
if (editorStates && editorStates.length >= 0) {
    this.restoreEditorStates(editorStates);
}
```
`length >= 0` is always true for any array. `restoreEditorStates` gets called with empty arrays unnecessarily.

**Fix:** Change to `editorStates.length > 0`.

**Files:** `main.js` (line ~854)

### [ ] Add input validation for hex color parsing, URLs, and MIDI values
Several locations accept user input without validation:

1. `main.js:83-85` -- `parseInt(hex.slice(1, 3), 16)` with no validation the hex string is valid. Results in NaN color values.
2. `VideoURLNode.js:27-31` -- No URL format validation before loading video.
3. `MIDIService.js:98` -- MIDI CC values assumed 0-127, never clamped.
4. `FloatingCodeEditor.js:315-316` -- `parseInt` on style values without NaN fallback.

**Fix:** Add regex validation for hex colors, URL constructor validation, `Math.max(0, Math.min(127, value))` clamping for MIDI, and `|| defaultValue` fallbacks for parseInt.

**Files:** `main.js`, `VideoURLNode.js`, `MIDIService.js`, `FloatingCodeEditor.js`

### [ ] Add async project loading guard to prevent race conditions
`ProjectManager.js:164` -- `loadProjectFromFile()` is async with no guard against concurrent calls. Two rapid file loads can interleave, corrupting the graph (nodes from file A mixed with connections from file B).

Similarly, `VideoURLNode.js:182-184` -- `loadVideo()` can be called twice with different URLs before the first completes.

**Fix:** Add `isLoading` flag to `ProjectManager`. Add `AbortController` to `VideoURLNode.loadVideo()` that cancels the previous load when a new URL is set.

**Files:** `ProjectManager.js`, `VideoURLNode.js`

### [ ] Add null safety guards for unchecked array/property access
Several locations access properties or indices without null checks:

1. `ShaderCompiler.js:96` -- `node.outputs[outputIndex].type` without bounds check.
2. `FeedbackRenderer.js:88` -- `feedbackNode.compiledShader.uniformValues` iterated without null check.
3. `FloatingCodeEditor.js:315-316` -- `parseInt` on possibly empty style values.
4. Various connection methods assume `fromNode`/`toNode` exist.

**Fix:** Add optional chaining and fallback values at all identified locations.

**Files:** `ShaderCompiler.js`, `FeedbackRenderer.js`, `FloatingCodeEditor.js`, `NodeGraph.js`

---

## Browser Compatibility

### [ ] Add canvas roundRect() polyfill for older browsers
`Node.js:53,78` uses `ctx.roundRect()` which is a relatively new Canvas API (baseline 2024). Older browsers crash when rendering any node.

**Fix:** Add a `CanvasRenderingContext2D.prototype.roundRect` polyfill at app startup using `quadraticCurveTo`.

**Files:** `main.js` or new `src/utils/polyfills.js`

### [ ] Add WebGL2 graceful fallback
`ShaderPreview.js:29` -- WebGL2 is required with no fallback. The constructor just returns silently if WebGL2 isn't available, causing cryptic failures later.

**Fix:** Show a clear user-facing error message. Consider WebGL1 fallback for basic features.

**Files:** `ShaderPreview.js`

### [ ] Add AudioWorklet feature detection
`MicrophoneNode.js:72` -- `AudioWorklet` usage without feature detection. Fails in browsers without support.

**Fix:** Wrap in try/catch, fall back to `ScriptProcessorNode` (deprecated but widely supported).

**Files:** `MicrophoneNode.js`

---

## Quick Wins

### [ ] Remove random-probability debug logging from production code
`ShaderPreview.js:453`:
```javascript
if (Math.random() < 0.01) {
    console.warn('[ShaderPreview] No uniformRegistry!');
}
```
Random-probability debug log in a per-frame hot path. Unpredictable, wastes CPU on `Math.random()` every frame.

**Fix:** Replace with a one-time warning using a flag, or remove entirely.

**Files:** `ShaderPreview.js` (line ~453)

### [ ] Cache DOM element references instead of repeated getElementById calls
`CompilationManager.js` queries `document.getElementById('errorDisplay')` in three separate methods (lines 294, 306, 338).

**Fix:** Cache the element reference in the constructor as `this.errorDiv`.

**Files:** `CompilationManager.js`

### [ ] Replace uniform type if-else chain with dispatch table
`FeedbackRenderer.js:272-313` has a long if-else chain checking uniform types every frame:
```javascript
if (uniform.type === 'float') { ... }
else if (uniform.type === 'int') { ... }
else if (uniform.type === 'vec2') { ... }
// ... etc
```

**Fix:** Create a dispatch table:
```javascript
const uniformSetters = {
    float: (gl, loc, val) => gl.uniform1f(loc, val),
    int: (gl, loc, val) => gl.uniform1i(loc, val),
    vec2: (gl, loc, val) => gl.uniform2f(loc, val[0], val[1]),
    // ...
};
uniformSetters[uniform.type]?.(gl, location, uniform.value);
```

**Files:** `FeedbackRenderer.js` (lines 272-313), `ShaderPreview.js`

### [ ] Remove unnecessary zero-fill loop in FeedbackNode texture init
`FeedbackNode.js:52-59` manually zeros a `Uint8Array` that's already zero-filled by specification:
```javascript
const pixels = new Uint8Array(width * height * 4);
for (let i = 0; i < pixels.length; i += 4) { // Unnecessary!
    pixels[i] = 0; pixels[i+1] = 0; pixels[i+2] = 0; pixels[i+3] = 0;
}
```

**Fix:** Delete the for loop. `new Uint8Array()` guarantees zero initialization.

**Files:** `FeedbackNode.js` (lines 52-59)

### [ ] Add only-when-changed uniform updates instead of per-frame
`ShaderPreview.js:443-457` fetches custom uniform values from the `UniformRegistry` every frame, even if nothing changed. Same in `FeedbackRenderer.js:274-292`.

**Fix:** Add a dirty flag system to `UniformRegistry`. Only update uniform values when the registry is dirty. Time-based uniforms (`u_time`, `u_mouse`) still update per-frame.

**Files:** `UniformRegistry.js`, `ShaderPreview.js`, `FeedbackRenderer.js`

---

## Architecture Refactors

### [ ] Refactor PatchToy god object into smaller, focused modules
`main.js` (874 lines) is a god object. `PatchToy` creates 10+ dependencies, manages the animation loop, handles color input, sets up all event listeners, handles custom node creation, and orchestrates compilation.

**Fix:** Break into:
- `AppInitializer` -- bootstrapping, GL context creation, dependency wiring
- `EventController` -- all event listener setup, owns AbortController for cleanup
- `ColorInputController` -- color picker logic (lines 73-101)
- `CustomNodeManager` -- GLSL paste handler, custom node creation from code
- `RenderLoop` -- centralized animation frame management

`PatchToy` becomes a thin facade delegating to these modules.

**Files:** `main.js` -> new `AppInitializer.js`, `EventController.js`, `ColorInputController.js`, `CustomNodeManager.js`

### [ ] Eliminate duplicated factory logic in NodeFactory
`NodeFactory.js:20-150` -- `createNode()` and `deserializeNode()` contain near-identical 20+ branch if-else chains. ~130 lines of duplicated logic.

**Fix:** Create a type-to-constructor registry:
```javascript
const NODE_CONSTRUCTORS = new Map([
    ['isPreviewNode', PreviewNode],
    ['isConstantNode', ConstantNode],
    // ...
]);
static getNodeClass(definition) {
    for (const [flag, Ctor] of NODE_CONSTRUCTORS) {
        if (definition[flag]) return Ctor;
    }
    return Node;
}
```
Both methods call `getNodeClass()` and instantiate with appropriate args.

**Files:** `NodeFactory.js`

### [ ] Break down oversized Node.draw() and ShaderCompiler.compileNode() methods
Several methods are far too large:

1. `Node.draw()` (200+ lines) -- shadows, borders, color pickers, title, ports all in one method. Split into `drawBackground()`, `drawTitle()`, `drawColorPicker()`, `drawPorts()`.

2. `ShaderCompiler.compileNode()` (lines 187-386, ~200 lines) -- Split into `resolveInputValues()`, `validateTypes()`, `generateNodeGLSL()`.

3. `NodeGraph.js` (2,322 lines single class) -- Split into `NodeGraph` (data), `GraphInputHandler` (mouse/keyboard), `GraphSerializer` (save/load).

**Files:** `Node.js`, `ShaderCompiler.js`, `NodeGraph.js`

### [ ] Separate rendering logic from data/business logic in Node classes
`Node.js` (555 lines) mixes data storage, Canvas 2D rendering, port calculations, and text input. `ShaderPreview.js` (528 lines) handles WebGL compilation, camera textures, noise rendering, geometry, and animation.

**Fix:** Apply data/renderer split:
- `Node` (data only): id, type, position, connections, definition. No drawing code.
- `NodeRenderer`: takes a Node and ctx, handles all drawing.
- `GLProgramManager`: extracted from ShaderPreview -- shader compilation, program creation, uniform caching.
- `CameraTextureManager`: extracted from ShaderPreview -- camera/video/screen texture management.

**Files:** `Node.js`, `ShaderPreview.js`, `PreviewNode.js`, `GraphRenderer.js`

### [ ] Fix temporal coupling in NodeGraph initialization
`main.js:39-41` -- `NodeGraph` requires properties set after construction:
```javascript
this.nodeGraph = new NodeGraph(...)
this.nodeGraph.addNodeButton = this.addNodeBtn;
this.nodeGraph.sharedGL = this.sharedGL;
this.nodeGraph.uniformRegistry = this.uniformRegistry;
```
Object is in invalid state between construction and property assignment.

**Fix:** Pass all required dependencies through the constructor as an options object.

**Files:** `NodeGraph.js` (constructor), `main.js`

### [ ] Reduce coupling with event bus or mediator pattern
All communication happens through direct method calls and callback properties (`onGraphChanged`, `onUniformValueChanged`, etc.). Every module needs direct references to everything it talks to.

**Fix:** Introduce a lightweight `EventBus`:
- `'graph:changed'` replaces `onGraphChanged`
- `'uniform:changed'` replaces `onUniformValueChanged`
- `'compilation:complete'` / `'compilation:error'`
- `'node:right-click'`

Modules subscribe to events instead of being wired together manually.

**Files:** new `EventBus.js`, `main.js`, `NodeGraph.js`, `CompilationManager.js`, `FeedbackRenderer.js`

---

## Code Quality

### [ ] Extract all magic numbers into a centralized constants file
Magic numbers scattered throughout with no documentation:

- `Node.js:10-11` -- `width = 150, height = 80`
- `Node.js:128` -- port radius `6`
- `Node.js:83` -- font `'12px bold "Pixeloid Sans"'`
- `ConstantNode.js:7` -- `width = 75`
- `main.js:27-28` -- shared canvas `512x512`
- `CompilationManager.js:22` -- debounce `100ms`
- `FloatingCodeEditor.js:72` -- `(instances.length * 30) % 200`
- `FloatingCodeEditor.js:36` -- `{ width: 600, height: 500 }`
- `ShaderPreview.js:116,120` -- noise shader params `4.0`, `10.0`
- `Node.js:43-79` -- colors like `'rgba(45, 45, 45, 0.95)'`, `'#007acc'`, `'#f44336'`

**Fix:** Create `src/constants/UIConstants.js` with `LAYOUT`, `CANVAS`, `TIMING`, `COLORS`, `FONTS` sections. Import and use throughout.

**Files:** new `UIConstants.js`, then update `Node.js`, `ConstantNode.js`, `PreviewNode.js`, `ShaderPreview.js`, `CompilationManager.js`, `main.js`, `UIHelpers.js`, `FloatingCodeEditor.js`

### [ ] Replace magic string node type checks with enum/constants
Multiple files use `node.type` as raw string keys (`ShaderCompiler.js:52`, `NodeFactory.js:57-69`). A typo causes silent failure.

**Fix:** Create `src/constants/NodeTypes.js` with a frozen enum object. Use these constants instead of raw strings everywhere.

**Files:** new `NodeTypes.js`, `NodeDefinitions.js`, `ShaderCompiler.js`, `NodeFactory.js`

### [ ] Fix inconsistent naming conventions across codebase
- Acronym inconsistency: `MidiCCNode` vs `MIDIService`
- Abbreviation inconsistency: `dpr` vs `uniformRegistry`
- Generic property: `Node.data = {}` stores different shapes per node type
- Ambiguous names: `preambleRenames`, `deserialized`

**Fix:** Establish convention -- pick one MIDI capitalization style, rename `this.data` to something descriptive per node type, document non-obvious abbreviations.

**Files:** `MidiCCNode.js`, `MIDIService.js`, `Node.js`, various

### [ ] Move inline CSS style assignments to CSS classes
Multiple locations create DOM elements with 5-10+ individual style property assignments:
- `CompilationManager.js:304-335` -- error display close button (9 style assignments)
- `UIHelpers.js:6-46` -- menu overlay and items
- `ProjectDialogs.js`, `AuthDialogs.js`, `NodeDialogs.js` -- modal dialogs

**Fix:** Move styles to CSS classes in `style.css`. Use `element.className` or `classList.add()` instead of individual `element.style.X = Y` assignments.

**Files:** `style.css`, `CompilationManager.js`, `UIHelpers.js`, `ProjectDialogs.js`, `AuthDialogs.js`, `NodeDialogs.js`

### [ ] Add WebGL vertex attrib state cleanup for shared context
`ShaderPreview.js:504-508` -- Vertex attribute state is set but never cleaned up. With a shared GL context, one renderer's state can pollute another's.

**Fix:** After `gl.drawArrays()`, cleanup: `gl.disableVertexAttribArray()`, `gl.bindBuffer(null)`, `gl.bindFramebuffer(null)`, `gl.useProgram(null)`. Or use WebGL2 VAOs.

**Files:** `ShaderPreview.js`, `FeedbackRenderer.js`

### [ ] Verify uniform location caching in ShaderPreview
`ShaderPreview.js:322-328` -- Confirm uniform locations are queried once in `loadShader()` and cached, not re-queried every frame during `render()`. Same verification needed for `FeedbackRenderer`.

**Files:** `ShaderPreview.js`, `FeedbackRenderer.js`

### [ ] Optimize extractAllFunctions() memory allocation
`ShaderCompiler.js:589-703` -- Creates a boolean array the size of the entire shader code string:
```javascript
const insideCommentOrString = new Array(code.length).fill(false);
```
O(n) memory allocated during every compilation.

**Fix:** Use a state machine approach that tracks comment/string state as it iterates -- O(1) memory instead of O(n).

**Files:** `ShaderCompiler.js` (lines 589-703)

---

## Infrastructure & Tooling

### [ ] Add test infrastructure with Vitest and initial test coverage
Zero test files, no test runner, no coverage, no linting, no type checking.

**Phase 1 (Infrastructure):**
- Add `vitest`, `eslint`, `prettier` as dev dependencies
- Add `test`, `lint`, `format` scripts to `package.json`
- Create `vitest.config.js` with jsdom environment
- Create `.eslintrc.js`

**Phase 2 (Core tests -- highest value):**
- `TypeRegistry` -- type resolution, struct registration, accessor chains, auto-conversion
- `ShaderCompiler` -- single node compilation, multi-node graphs, loops, type coercion, errors
- `NodeFactory` -- correct class instantiation, deserialization round-trip
- `GLSLCommentParser` -- magic comment parsing, validation, edge cases
- `UniformRegistry` -- register, get, clear, overwrite

**Phase 3 (Integration tests):**
- `CompilationManager` -- end-to-end from graph to shader
- `ProjectManager` -- serialize/deserialize round-trip
- Connection type compatibility checks

**Files:** `package.json`, new `vitest.config.js`, `.eslintrc.js`, `.prettierrc`, `tests/` directory

### [ ] Add environment-based configuration and vite.config.js
`config.js` contains only a hardcoded API URL. No `vite.config.js`, no `.env` support, no dev vs production distinction.

**Fix:**
- Create `vite.config.js` with build optimization, env variable handling, source maps
- Create `.env.example` documenting available variables
- Update `config.js` to read from `import.meta.env`
- Add conditional debug logging stripped in production

**Files:** new `vite.config.js`, `.env.example`, `config.js`, `.gitignore`
