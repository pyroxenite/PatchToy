<p align="center">
  <img src="patchtoy-large.png" alt="PatchToy" width="300"/>
</p>

# PatchToy

A node-based visual editor for creating GLSL shaders in real-time.

**Try it**: [patchtoy.com](https://patchtoy.com)

## Development

Option 1: Use Vite dev server
```bash
npm install
npm run dev
```

The project is vanilla JS; Vite serves it as-is in development (demo discovery, the
SPA fallback for `/p/<id>` and `/u/<name>` links and the MCP bridge rely on it, so plain
static servers such as Live Server are no longer enough).

### Local cloud API (no AWS)

`scripts/mock-api.mjs` runs the real Lambda handlers (`infra/lambda`) against an in-memory
store, with a fake thumbnail bucket. Point the app at it with `?api=`:

```bash
npm run mock-api                      # http://localhost:8787, demo users ada / grace (password "patchtoy123")
open "http://localhost:5200/?api=http://localhost:8787"   # ?api=default switches back
```

`npm run dev:mock` (= `VITE_API_URL=http://localhost:8787 vite`) does the same for a whole
dev session. Without either, `npm run dev` uses the **production** API (the console says so).
The mock listens on 127.0.0.1 only and prints password-reset links (also at
`GET /__mock/outbox`). In production builds `?api=` only accepts localhost URLs.

Tests: `npm run test:lambda` (handler unit tests, in-memory DynamoDB), `npm run test:community`
(headless Chrome end-to-end: sign-up, cloud save with thumbnail, publish, community, share
link, fork, user page), `npm run test:mcp`.

## MCP server (AI agents)

`mcp/server.mjs` is an [MCP](https://modelcontextprotocol.io) server that lets Claude (or any MCP client) create, edit, compile and render PatchToy projects. It drives the real app over a local WebSocket bridge. When it needs a browser, it auto-starts Vite and a headless Chrome. If you have the dev server open in your browser, it edits your tab live instead, so you can watch it work. Dev tabs pair with the server through a per-run token that only this repo's dev server hands out; other local pages can't connect (see [mcp/README.md](mcp/README.md#security)).

```bash
npm install
claude            # the repo's .mcp.json registers the "patchtoy" server (approve it once)
```

Projects are saved as `projects/<slug>.patchtoy.json` (the same format as "Download project"). Tools include `create_project`, `list_node_types`, `build_graph`, `connect`, `create_custom_node`, `compile` (WebGL errors mapped to nodes) and `render_preview` (returns a PNG). There's also a CLI that needs no MCP client (`node mcp/cli.mjs tools`) and an end-to-end test (`npm run test:mcp`). See [mcp/README.md](mcp/README.md).

## Testing

```bash
npm test                          # everything, in sequence (about 2-3 min)
npm test -- --only visual         # stages: definitions, e2e, visual, build (--skip build, --bail)
npm run test:visual               # visual regression + shader compile check only
npm run test:visual:update        # regenerate the visual goldens (after an intended change)
npm run test:visual -- --only scene-medley,vection
```

`npm test` (`scripts/test.mjs`) starts its own Vite dev server on a free port (never 5173 or 5200), with HMR and file watching off, so edits made while it runs never reload the page under test. It then runs these stages and prints a summary table. The exit code is 1 if any stage failed. The server and every child process (MCP server, headless Chrome) are stopped at the end, also on failure or Ctrl-C.

1. **definitions**: `scripts/check-definitions.mjs`, static checks of the node library (no browser).
2. **e2e**: `mcp/test-e2e.mjs`, the MCP server end to end, against the private server, with a scratch projects folder (`PATCHTOY_PROJECTS_DIR`), so `projects/` is never touched.
3. **visual**: `tests/visual/run.mjs`, described below.
4. **build**: `vite build` into a temporary folder.

Headless Chrome only: the browser stages need Google Chrome (or `PATCHTOY_CHROME_PATH`) and `playwright-core` (a devDependency).

### Visual regression (`tests/visual/`)

Every `projects/*.patchtoy.json` (except `e2e-*` leftovers) is opened through the MCP tool handlers in a fresh headless browser context, so results never depend on the order the projects run in. For each project the suite:

- **checks shader compilation**: each Preview and each Feedback pass, with errors, warnings and compile time;
- **renders frames** through `render_preview` at 480×300 and compares them with `tests/visual/golden/<slug>-<n>.jpg`. The frames and the per-project settings are in `tests/visual/config.mjs`.

Renders are deterministic:

- **Time and beat:** `u_time` is pinned, and the metronome (`set_audio`, 120 BPM) drives the beat and audio uniforms.
- **Scenes:** scene-medley pins each of its scenes, plus one transition frame.
- **Warm-up:** each render uses `render_preview {warmup: N}`. This clears the Feedback buffers, resets the JS node state (setup runs again), the control-rate state and the SceneSwitcher state, and seeds `Math.random`. It then steps N frames at a fixed 60 fps (clock manual mode + `app.tickFrame`) up to the render time, so feedback simulations, trails, bloom chains and JS nodes reproduce exactly.
- **JS inputs:** JS projects are trusted, because MCP-opened projects count as authored locally. The mouse is pinned, the wall clock is pinned for `js-clock-sky` (`date`), and the timezone is UTC.

**Comparison:**

- **Exact (default):** on the platform the goldens were made on (OS, Chrome major version and GPU, recorded in `golden/manifest.json`), the SHA-256 of the raw RGBA render must equal the golden's. This holds for every project except two, which are compared in tolerance mode (`exact: false` in `config.mjs`). `js-beat-lyrics`: its 2D-canvas blur filter is rastered on the GPU or the CPU from run to run. `audio-textures`: the audio textures keep per-frame state that the warm-up does not reset.
- **Tolerance:** used on any other platform, with `--tolerance <scale>`, or for projects marked `exact: false`. Metrics are measured against the JPEG golden, as the excess over the golden's own JPEG error, which is stored in the manifest:
  - blurred mean absolute error;
  - the share of pixels off by more than 32 after a 3×3 blur;
  - the mean colour shift;
  - a soft-binned luma histogram distance.

  Each project has a threshold profile in `config.mjs`:
  - `default`: most projects;
  - `text`: canvas text (system fonts differ between platforms);
  - `feedback`: trails;
  - `structural`: chaotic simulations (hyperbolic-boids, hyperbolic-currents, js-swarm-points, kaleido-tunnel), where only the mean colour and histogram are meaningful across GPUs.

On failure, `tests/visual/out/` (gitignored) receives `<image>.golden.png`, `.actual.png`, `.diff.png` (heatmap) and `.strip.png` (all three side by side), plus `report.json`. Goldens are JPEG at quality 80, about 1 MB in total.

**Regenerate the goldens** after an intended visual change, or when a project is added or changed: `npm run test:visual:update` (or `-- --update --only <slug>`). Look at the new images before committing them.

### CI (`.github/workflows/test.yml`)

The workflow runs `npm test` on `ubuntu-latest` with the preinstalled Google Chrome. Without a GPU, Chrome falls back to SwiftShader (software WebGL). The launcher always passes `--ignore-gpu-blocklist --enable-unsafe-swiftshader`. The workflow adds `PATCHTOY_CHROME_ARGS="--use-angle=swiftshader --use-gl=angle"` (extra flags for the headless Chrome) so the software renderer is chosen explicitly.

SwiftShader is slow: a local SwiftShader run of the full suite took about 36 minutes, against about 1 minute on an Apple M1 GPU. The warm-ups of hyperbolic-lanterns and scene-medley ran for minutes. So CI caps the warm-up with `--max-warmup 10` and compares against a Linux golden set made the same way: `--set linux`, i.e. `tests/visual/golden-linux/`. The cap is stored in the manifest, and an image rendered with a different warm-up than its golden is compared in tolerance mode and flagged.

To create the Linux set, run the workflow manually with `update_goldens`. It uploads the set as the `visual-goldens-linux` artifact; commit it. Until it exists, CI runs `npm test -- --skip visual` plus a non-blocking visual report against the macOS goldens (`--tolerance 3`). The image quality itself transfers well: rendered with full warm-ups, every SwiftShader image that finished within the old 120 s render timeout matched the M1 goldens within tolerance, with a near-zero excess error.

`--tolerance`, `--set` and `--max-warmup` can also be set with `PATCHTOY_VISUAL_TOLERANCE`, `PATCHTOY_GOLDEN_SET` and `PATCHTOY_VISUAL_MAX_WARMUP`. Diff images and the report are uploaded as an artifact.

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

### Node Groups
Big patches are organized into **groups** (subgraphs). At the root a group shows as one box (folder tab, name, node count, a minimap of its contents) whose ports are the cables crossing its boundary; **double-click** it to open it. A breadcrumb bar (Root › Scene › Lighting) shows where you are: click a crumb, or press **Esc** / **Backspace** with nothing selected to go up a level. Inside a group, the *From outside* and *To outside* panels list the cables that cross the boundary.

- **⌘G / Ctrl+G** groups the selection (nodes and group boxes, so groups can nest); **⇧⌘G** ungroups. Right-click for a menu with Group / Ungroup / Rename / Open / Move out of this group / Delete.
- Rename by double-clicking the box title or the current breadcrumb. Deleting a box asks whether to delete its contents or just ungroup. Copy / paste copies a group with everything inside.
- New nodes (Tab search, library drag-and-drop, cable drops) go into the group that is open.
- **Connecting across a boundary.** Drag to or from a box port: it connects the inner node it stands for. To make a new port, open the group and drop an inner output on the **expose output** socket of the *To outside* panel (or reverse-drag an unconnected inner input onto **expose an input** on the *From outside* panel); the port then appears on the box. You can also drop a cable on a box body to pick any inner port from a list, or drag from a *From outside* row to an inner input.
- Groups are view/organization data only (`graph.groups` in the project file): the compiled shader is exactly the same as without them.

### Node Library
About 160 built-in nodes, grouped by category:

| Category | Nodes |
|---|---|
| Inputs / Sources | Time, UV, Mouse, Resolution · Camera, VideoURL, ScreenCapture (each also outputs a `tex` texture), Microphone, MIDI CC, MidiNote, Keyboard, XYPad · Audio, Beat, BeatEnvelope (see [Music & beat sync](#music--beat-sync)) |
| Math | Add, Subtract, Multiply, Divide, Abs, Floor, Ceil, Round, Fract, Mod, Min, Max, Clamp, Saturate, Pow, Sqrt, Exp, Log, Sign, Step, Smoothstep, Mix, Remap, Sin, Cos, Tan, Asin, Acos, Atan2, Negate, OneMinus, Oscillator |
| Vector | Dot, Cross, Normalize, Length, Distance, Reflect, Refract, Split, MakeVec2/3/4, Swizzle, Rotate2D |
| UV & Transform | CenteredUV, PolarCoords, RotateUV, ScaleUV, TranslateUV, TileUV, MirrorUV, Kaleidoscope, Pixelate, Twirl, WaveUV |
| Noise | Random, ValueNoise, PerlinNoise, PerlinNoise3D, SimplexNoise, FBM, Voronoi, DomainWarp |
| Shapes 2D | Circle, Rect, RoundedRect, Ring, Segment, Triangle, Hexagon, Star, Polygon, Fill, Stroke, SDFUnion / Subtract / Intersect (+ Smooth variants), SDFOnion, SDFRound |
| 3D Render | Render 3D, Mesh, Group 3D, Model (glTF) · Box / Sphere / Torus / Plane / Grid / Cylinder / Torus Knot / Bird / Points / Text Mesh · PBR / Unlit / Toon / Iridescent / Glass Material, Surface · Instance Index, Make Instance, Instance Data, Instances From Texture, Instance Grid · Directional / Point / Spot / Ambient Light (see [Render 3D](#render-3d-rasterized-meshes)) |
| 3D & Raymarch | Raymarch, ScenePoint, Sphere, Box, Torus, Cylinder, Capsule, Plane, Translate3D, Rotate3D, Repeat3D, CameraRay, CameraObject, OrbitalCamera, Lambert, BlinnPhong, Fresnel |
| Color | HSVToRGB, RGBToHSV, CosinePalette, Gradient, ColorRamp, HueShift, Saturation, BrightnessContrast, Gamma, Grayscale, Invert, Posterize, Tint, TonemapACES |
| Effects | Feedback, TextureSample, TextureBlur, ChromaticAberration, EdgeDetect, Vignette, Grain, Dither, Scanlines, Glow |
| Logic & Flow | Blend, Map, ForLoopStart/End, Compare, Select, And, Or, Not |
| Control | LFO, Lag, Slew Limiter, Spring, Trigger, Counter, Timer, Sample & Hold, Toggle, Threshold, Envelope Follower, Random (control), Delay, Gate, Select (index), Math Expression, Beat Divider, Sample, Text Pick, Number List, Text Texture, List Texture (see [Control rate](#control-rate-cpu-once-per-frame)) |
| I/O | OSC In, OSC Out, Serial In, Serial Out, MIDI Out CC, MIDI Out Note, Art-Net Out (see [Connecting hardware & other apps](#connecting-hardware--other-apps)) |

- **Generic math**: most math, vector and logic nodes accept `float`, `vec2`, `vec3` or `vec4`. The output follows the widest connected input and scalars are broadcast, so `Multiply(color, 0.5)` works.
- **Inline values**: unconnected scalar inputs show an editable field on the node (stored in `node.data[input]`).
- **Conventions**: 2D nodes default to aspect-correct UVs (0.5 = center). Shapes output a signed distance `d` and an anti-aliased `mask`. Noise outputs `n` in 0..1. Colors are vec3 RGB in 0..1.
- **Raymarching**: whatever is wired into `Raymarch.sdf` is compiled into a GLSL function `float scene(vec3 p)`. 3D primitives with an unconnected `p` use the scene point automatically, so `Sphere → Raymarch` already renders. Combine shapes with the SDF operators and feed `Raymarch.color` to a Preview, or shade it yourself using `n`, `p`, `ao` and `shadow`.
- `node scripts/check-definitions.mjs` validates every node definition without a browser.

## Render 3D (rasterized meshes)

Everything else in PatchToy is a fragment shader; **Render 3D** draws real geometry. A Render 3D node is "a 3D scene inside one node": it rasterizes meshes with real vertex and fragment shaders in the shared GL context and **outputs textures**: `color` (HDR, gamma-encoded like `Raymarch.color`, premultiplied alpha = coverage), `depth` and `normal`. Bloom, chromatic aberration, Feedback, scenes and Preview work on them unchanged.

- **Objects** go into its `item1`, `item2`, ... inputs (connecting the last free one adds the next): **Mesh** (geometry + material + transform + instances), **Model** (glTF), **Group 3D** (up to four objects / lights moved together; groups nest) and lights.
- **Geometry**: Box, Sphere, Torus, Plane, Grid (lines), Cylinder / cone, Torus Knot, Bird (low-poly, flappable wings), Points (sprites), Text Mesh (extruded pixel-font text). Params are CPU values: wire a Param to rebuild the mesh live.
- **Materials are sub-graphs** (like `Raymarch.sdf`): whatever is wired into `Mesh.material` is compiled into a GLSL function evaluated per fragment. The **Surface** node gives it the world position, normal, uv, view direction, instance id / colour, vertex colour and local position. Presets: **PBR Material** (metal / rough), **Unlit**, **Toon**, **Iridescent** (thin film), **Glass** (glass-lite: Fresnel reflections, blended). A plain colour works too (default PBR with that base colour); unconnected = grey PBR.
- **Instancing**: `Mesh.instances` is a sub-graph evaluated per instance in the vertex shader. **Instance Index** (id, count, t, random), **Make Instance** (position, Euler rotation, `forward` to align with a velocity, scale, colour), **Instance Data** / **Instances From Texture** (texels of a Feedback simulation or a JS `dataTexture`: instance i = texel (i mod W, i div W), attributes stacked in `blocks`), **Instance Grid**. `count` 0 = automatic (texture size, grid size). One draw call for all instances; **Points** draw with `gl.POINTS` (no vertex buffer).
- **Displacement**: `Mesh.displace` = per-vertex offset sub-graph (Surface in vertex context: local position, normal, uv, vertex colour; Instance Index). The Bird mesh stores a wing weight in its vertex colour alpha for flapping.
- **Lights**: Directional (sun; one soft PCF shadow map per scene, `data.castShadow`, `shadowCenter` / `shadowSize`, `data.softness`), Point, Spot, Ambient (sky / ground hemisphere, also reflected by shiny materials). No light connected: a default sun + sky. Light inputs are GLSL: Params, Time, Beat animate them without recompiling.
- **Camera**: the CameraObject / OrbitalCamera nodes (same conventions as Raymarch: vertical fov in degrees). Unconnected: **drag** on the node's preview to orbit (shift: pan), **scroll** to zoom.
- **Raster x raymarch compositing.** Depth convention: `depth.r` = distance from the camera position to the surface along the view ray, in world units, the same quantity as `Raymarch.t`; `data.far` where nothing was drawn (with MSAA, edge pixels hold an average). Two ways to mix:
  - Render 3D `background` = `Raymarch.color` and `bgDepth` = `Raymarch.t`: the raymarched world is drawn first with its depth, so meshes are depth-tested against the SDF surfaces (with MSAA). See **Mesh x SDF Hybrid**.
  - `Raymarch.depth` = Render 3D `depth` (and `under` = its `color`): rays stop at the rasterized surfaces and `Raymarch.color` shows the meshes where they are nearer. GlassRaymarch has `depth` too.
- **glTF (Blender)**: drop a `.glb` on the canvas (it is wired into a Render 3D, created if needed), double-click a Model node to pick a file, or MCP `load_model`. Supported: meshes and the node hierarchy, PBR metal / rough materials (base colour, metal / rough, normal, emissive, occlusion textures; alpha mask / blend; unlit), vertex colours, skinning (4 weights, up to 1024 joints), animation clips (translation / rotation / scale; linear, step, cubic spline). `clip` picks the clip, `time` drives it (wire `Beat.time` to dance on the beat). Not supported: Draco / meshopt compression (a clear error), morph targets, `KHR_texture_transform`, second uv sets. Blender export: File > Export > glTF 2.0 (.glb), compression off. Models up to 15 MB are saved in the project as a data URL (with a warning above 5 MB); larger ones load for the session only.
- **Rendering is lazy**: a Render 3D node renders once per frame when something binds its textures (or its own preview is drawn), so hidden scenes and off-screen previews cost nothing, and `render_preview` renders it at the pinned time. `data.size` `auto` (default) follows the output being shown (its aspect and render-quality scale, up to `data.maxSize`); `fixed` uses `data.width` x `data.height`. `data.msaa` 0 / 2 / 4, `near` / `far`, `fog` (fades to the background colour), `exposure`, `tonemap` (`gamma` default, `aces`, `linear`).
- **Performance** (Apple M1 Max, Chrome / Metal, 1920 x 1080, MSAA 4x, GPU time): 100k instanced boxes with a shadow map 5.5 ms; 300k boxes 6.9 ms; 100k birds with shadows 9.7 ms; 250k point sprites 5.4 ms; 1M point sprites 11.6 ms.
- Demos: **Instanced Flock** (2048 boids from a Feedback sim as winged meshes with shadows), **Particle Storm** (524k Feedback particles as additive point sprites), **Mesh x SDF Hybrid**, **Blender Showcase** (a skinned, animated glTF jelly instanced 7 times, dancing on the beat). Code: `src/render3d/`, node definitions in `src/core/library/render3d.js`.

## Control rate (CPU, once per frame)

Every cable used to be **pixel rate**: compiled into GLSL and evaluated for every pixel, with no memory between frames. Ports now also have a **control rate**: values computed **once per frame in JavaScript**, before rendering, which can **keep state** (smoothing, counting, delays). Rate is a property of the port, not a type: a float is a float.

- **Looks**: control ports are **diamonds** (pixel ports stay circles), control cables are thinner and **dashed**, events (one-frame pulses) are **dotted** with a lightning bolt on the port. Control nodes show their live value and a sparkline; math nodes running at control rate show their value next to the output.
- **control → pixel** is always allowed: the value becomes a live uniform (`node_<id>_c<k>`), so changing it never recompiles. **pixel → control** is rejected ("pixel values live on the GPU: use a Sample node"). Control → control runs in dependency order every frame; a loop needs a **Delay** node.
- **Inference**: math, vector and logic nodes (Add, Multiply, Mix, Clamp, Sin, Remap, MakeVec3, Split, Select...) run at control rate when all their inputs are CPU values (Param, LFO, Beat, Audio, JS, MIDI, Keyboard, constants); any pixel input (UV, noise...) compiles them to GLSL as before. Each has a JS twin with GLSL semantics (`js` next to `expr` in `src/core/library/*.js`). Projects render the same; math fed only by Params / Beat now reaches the shader as a uniform.
- **Sources**: Param, JS outputs, MIDI CC / Note, Keyboard, XY Pad, Microphone, Beat and Audio are control rate. The SceneSwitcher `scene` / `next` inputs are control-rate ports (a Counter on a Beat Divider can pick scenes).
- **Control-only values**: `event` (Trigger, Beat Divider, Threshold on/off), `string` (Text Pick, the **text** Param kind, JS) and `list` (Number List, JS). Strings and lists reach shaders through **Text Texture** (canvas text) and **List Texture** (data texture). **Sample** reads a pixel value at a uv point back to the CPU (one frame late, through the debug-probe readback).
- **JS nodes** get control inputs: declare `// @input speed float = 1` in the code, then read `speed` (or `inputs.speed`).
- Example: `projects/control-rate.patchtoy.json`. Code: `src/core/control/` (rates, runtime, compiler hook, JS math), `src/core/library/control.js`. `?control=off` disables inference (for comparisons).

## Music & beat sync

Shaders can react to music, or just stay on the beat. The **audio section** in the top bar picks the source and shows a beat LED, the BPM with a confidence meter, a **Tap** button and a level meter. Click it for the source choice, band meters, manual BPM, **Lock BPM** and an offset slider.

| Source | What it is |
|---|---|
| **Mic** | The microphone, for music playing in the room (speakers → room → mic). Echo cancellation, noise suppression and AGC are off. The mic button in the top bar toggles it. |
| **File** | An audio file played through the app. Drop it anywhere on the window or pick it in the popover. Play/pause, seek and loop are in the popover. |
| **Tab** | Another tab's (or the system's) audio through Chrome's screen-share picker. Tick "Share tab audio"; the video track is dropped. |
| **Metronome** | No audio: a fixed-BPM clock. Audio values follow a virtual groove (kick and bass on every beat, snare on 2 and 4, hats on 8ths). Use it for headless renders, or with no music at all. |

**In any GLSL** (custom nodes, expressions), these uniforms are available without wiring and are declared only when used:

| Uniform | Meaning |
|---|---|
| `u_level`, `u_bass` (20–150 Hz), `u_lowMid`, `u_mid`, `u_high` | Smoothed, auto-gained band levels, 0..1 |
| `u_kick` | Jumps to 1 on a kick-drum onset, then decays (~110 ms) |
| `u_beat` | 1 on each beat, then decays: `exp(-6 * u_beatPhase)`, faded by the certainty gate `smoothstep(0.25, 0.75, u_beatTrust)` (no change without live audio) |
| `u_beatPhase`, `u_barPhase` | 0..1 within the beat, and within a 4-beat bar |
| `u_beatCount`, `u_bpm` | Integer beat counter, tempo of the stable clock (smoothed: it glides with tempo changes, no per-beat jitter or steps) |
| `u_beatTime` | `u_beatCount` + an eased `u_beatPhase`: a beat-locked "time" that surges on each beat |
| `u_beatConfidence` | 0..1, how sure the beat is: 0 = no beat or coasting, ~0.5 = tentative, ~1 = locked and phase-confirmed. Smoothed (no flicker), falls within ~1 s when the beat is lost. 1 with the Metronome, with a tapped tempo, and for a File whose tempo you locked; 0 with audio off. Multiply beat-driven effects by it so they fade in as the beat locks and fade out when it is lost. |
| `u_beatTrust` | 0..1, how far the stable beat clock can be relied on: 0 while it coasts on an untrusted estimate (after a track change), rising as it glides onto the new tempo, about `u_beatConfidence` once locked. Always 1 without live audio (off, Metronome, taps, export, `render_preview`). Gate phase-driven effects with `smoothstep(0.25, 0.75, u_beatTrust)` (= Beat → `gate`). |
| `u_beatRaw` | `vec4`: the tracker's raw live estimate (phase, bar phase, count, bpm), for diagnostics (Beat Lab). It jumps when the tracker relocks. |
| `u_time` | Seconds (one global clock for every preview, feedback pass and the background) |

**Nodes** (Sources): **Audio** (`level, bass, mid, high, kick`), **Beat** (`pulse` with a `decay` input, `phase, bar, count, bpm`, `time` = `u_beatTime × rate`, a drop-in for Time, `confidence` = `u_beatConfidence` and `gate`, the certainty gate) and **BeatEnvelope**. BeatEnvelope shapes any 0..1 phase, by default the beat phase: `exp`, `ad`, `pump` (sidechain ducking), `saw` or `sine`, with sharpness `k`.

**Stable beat clock.** The tracker's own estimate goes chaotic for a few seconds when the music changes: after a skip to another song it keeps the old tempo for a moment, then relocks with a tempo step and a fast phase slew. Shaders and nodes don't see that estimate directly. They see a *published* clock (`src/core/Clock.js`) that only takes over an estimate once it is trusted:
- **lock:** trusted. The published tempo follows the tracker, and the phase follows by bending the rate (at most ±25 %).
- **coast:** the estimate is untrusted (confidence below 0.2, the tempo stepped by more than 3 %, or the phase moved more than 0.12 beat) for 0.4 s, or at once when it is clearly gone (a new track). The clock keeps the last trusted tempo and its continuous phase. Short dips (weak onsets through a mic) are ridden out.
- **glide:** a new estimate has held still for 1 s (and two of its beats). The tempo glides to it over one bar (smoothstep, monotonic), and the phase is pulled in by bending the rate.

`u_beatPhase` therefore never jumps, `u_beatTime` never runs backwards, and `u_bpm` moves smoothly from the old tempo to the new one (124 → 140 BPM over about 1.4 s, at most 0.23 BPM per frame). The top-bar readout dims ("Searching…") while the clock coasts. `u_beatTrust` says how far the clock can be relied on, and `u_beat` fades with it. Without live audio (off, Metronome, taps, export) the published clock *is* the raw one, so silent and metronome renders are unchanged. The tracker still needs about 1 s to notice a hard cut; until then it (and the clock) continue the old beat.

**Beat node options** (pills on the node):
- **clock:** `stable` (default, the published clock) or `raw` (the tracker's live estimate, for diagnostics).
- **gate:** `fade` (default: `pulse` × the gate), `hold` (every output freezes while trust < threshold, then catches up by bending its rate, never backwards) or `off`.
- **threshold** (default 0.5): `gate = smoothstep(threshold − 0.25, threshold + 0.25, u_beatTrust)`. The `gate` output is the same value.

BeatEnvelope fades the same way when it runs on the built-in beat phase (its `gate` pill: `fade` / `off`). A pump fades to 1, i.e. no ducking. Beat Divider skips its events while the clock is unsure (`unsure: hold`, or `fire`). The Scene Switcher's bars / music auto-advance holds for up to 8 s while the beat is unsure, so a track change doesn't trigger a scene switch. After that, bars count the coasting clock and music falls back to its seconds timer, which starts then.

**House pattern** for music couplings (the demos' Music groups): `drive = music × smoothstep(0.02, 0.12, Audio.level)`; beat couplings × `Beat.confidence` (0 with the audio off); `pulse` and BeatEnvelope already carry the gate; other beat-phase couplings (Beat `phase` / `bar` into your own shapes, custom GLSL on `u_beatPhase`) also × `Beat.gate` (GLSL: `smoothstep(0.25, 0.75, u_beatTrust)`). The Beat Lab demo shows the raw estimate (white) and the stable clock (green) side by side.

**How it works.** An AudioWorklet analyses the source in 5 ms frames. It computes FFT band levels and a spectral-flux onset signal, whitened per band and weighted towards the low end. The tempo estimate comes from the autocorrelation of the onsets over the last 8 s (and 3 s, to spot changes fast), scored over multiples of each candidate period (70–180 BPM). Octave and ratio ambiguities (×2, ×½, ×3/2, ×4/3) are settled by how the beats line up: at double time every other beat is an off-beat, and at a wrong ratio no beat alignment collects the onsets of every bar. A Kalman filter on beat time, period and tempo drift then follows the beat. After each predicted beat it measures where the onsets actually landed, weighted by how clear they are, so the tempo glides with a live drummer, an accelerando or a DJ's pitch nudge instead of stepping. When the music gets unclear (a breakdown, a fill, talking), it coasts at the last tempo and phase instead of jumping. Weak onsets there barely count, and a phase is only abandoned for one where real drum hits land. With a weak, room-coloured signal (speakers picked up by a laptop mic), single onsets are smeared and late: the filter learns how scattered their timing is, holds the tempo to the steady long-term estimate instead of wandering after each one, and its confidence also counts how consistently tempo and phase agree over several bars. After a track change it relocks in about 3–4 s.

Beats are drawn slightly *ahead* so they land on the audible beat. The engine accounts for analysis delay, output latency, mic input latency and display latency. If your setup still looks early or late, use the **offset** slider (±200 ms, saved).

**What to expect with arbitrary music:**
- **Robust, from the first second:** energy and kicks (`u_level`, `u_bass`, `u_kick`). They work with any music, including beatless or rubato material.
- **Needs a steady pulse:** `u_beat`, `u_beatPhase`, `u_beatTime`. They need music with a steady pulse (most pop, electronic, hip-hop, rock). Lock takes about 6–7 s. Tempo drift of a few percent is followed, and track changes relock in about 3–4 s. Heavily syncopated grooves can take 10+ s to settle, very noisy rooms lock less reliably, and ambient or rubato music gives low confidence; the clock then freewheels. `u_beatConfidence` (Beat → `confidence`) tells shaders how sure the beat is, and `u_beatTrust` (Beat → `gate`) how far the stable clock can be relied on.
- **Bar position (`u_barPhase`) is not detected:** the first tap of a tap sequence marks the downbeat.
- **Overrides:** **Tap** (tempo from the taps, phase from the last tap; the first tap sets the downbeat), a typed **BPM** (locks the tempo while the phase keeps tracking), **Lock BPM**, and **Metronome** for a fixed clock.

The top-bar play/pause button is the transport. **Paused** freezes `u_time`, the beat clock and the audio uniforms (and pauses a playing file) as well as auto-compile.

For agents, the MCP server adds `set_audio` (`metronome` / `file` / `off`), `get_audio_status` and `beat` / `beat_phase` arguments on `render_preview`, so a frame can be rendered at an exact beat position. See [mcp/README.md](mcp/README.md).

## Connecting hardware & other apps

The **I/O** nodes exchange control-rate values with other software and devices: **OSC In / OSC Out**, **Serial In / Serial Out**, **MIDI Out CC / MIDI Out Note** and **Art-Net Out** (library group "I/O"). Browsers cannot open UDP sockets, so OSC, serial and Art-Net go through a small local process, the **I/O bridge**. MIDI out uses Web MIDI directly in the browser.

```bash
npm run io-bridge                     # WebSocket on 127.0.0.1:7879, prints a pairing token + URL
npm run io-bridge -- --mock-serial    # adds /dev/mock-loopback (echo) and /dev/mock-sensor (fake Arduino)
npm run osc-demo                      # sends /patchtoy/lfo, /xy, /color, /beat to 127.0.0.1:9000
```

1. Start the bridge. Open the printed URL (`…?ioToken=…`), or paste the token in **Output › I/O settings…**.
2. Tick **Enable I/O for this session**. Until you do, nothing is sent, listened to or opened.
3. Add the destinations your patch sends to (`host:port`, `host:9000-9010` or `host:*`). When a patch asks for another destination, the panel lists it under "Requested by this patch" with an **Allow** button. Pick serial ports with **Scan**.

Each I/O node shows its state on a status line: green = working (with the last message), amber = waiting (not enabled, not allowed, opening), red = error (bridge not running, port in use), grey = not paired. Outputs keep their last values. `render_preview` sends nothing.

**Example:** `projects/io-osc.patchtoy.json` ("OSC Driven"). Four OSC In nodes on port 9000 drive a kaleidoscopic ring: `/patchtoy/lfo` sets its size, `/xy` its center, `/color` its tint and `/beat` a flash. An OSC Out echoes the flash to `127.0.0.1:9001`. Without OSC, it runs on a built-in LFO.

**OSC (TouchDesigner, Max, Ableton…).** OSC In listens on UDP `port` (127.0.0.1 only, unless **Accept OSC from other devices** is ticked). Its `address` is an OSC pattern (`*`, `?`, `[abc]`, `{a,b}`; `/x/**` matches everything below `/x`). It outputs the first number (`value`), the first four (`vec`), the first string (`text`), every number (`list`) and the address. `trig` fires once per message. OSC Out sends `value` (1–4 floats or ints), then the `text` and `list` inputs if they are connected. It sends on change (rate-limited), at a fixed rate or on `trig`. Bundles are accepted, and the codec is in-repo (`mcp/lib/osc.mjs`, OSC 1.0 plus common type tags).
- *TouchDesigner*: an **OSC Out CHOP** → network address `127.0.0.1`, port `9000`; channel names become addresses (`/patchtoy/lfo`). To receive from PatchToy, use an **OSC In CHOP / DAT** on port 9001 and allow `127.0.0.1:9001`.
- *Max/MSP*: `[udpsend 127.0.0.1 9000]` fed with `/patchtoy/lfo $1`; `[udpreceive 9001]` for OSC Out.
- *Ableton Live*: Max for Live's **Connection Kit** (OSC Send / OSC TouchOSC devices) maps any parameter to an OSC address; or send through a TouchOSC / Max device.
- From another computer or a phone: tick LAN input and send to this machine's IP. To send *to* another machine, allow its `ip:port`.

**Serial (Arduino, sensors).** Serial In reads lines (`text`, the numbers in it as `list`, the first number as `value`, `trig` per line) or raw bytes. Serial Out writes the `value` / `list` numbers as CSV lines (`0.5,1,0\n`), `text` lines or raw bytes. Set `port` (e.g. `/dev/tty.usbmodem1101`, `COM3`) and `baud` to match `Serial.begin()`. One port can feed a Serial In and a Serial Out together. Serial uses the `serialport` npm package, an optional dependency with prebuilt macOS / Windows / Linux binaries. Without it the bridge still runs OSC and Art-Net and says serial is unavailable. Web Serial is not used, so it works in any browser.
```cpp
void setup() { Serial.begin(115200); }
void loop() { Serial.print(analogRead(A0)); Serial.print(','); Serial.println(analogRead(A1)); delay(20); }
```

**MIDI out.** MIDI Out CC sends a Control Change whenever its 7-bit value changes. MIDI Out Note plays notes on `trig` (lasting `length` seconds) or follows a `gate`. `device` matches part of an output's name (empty = the first output). On macOS, enable the **IAC Driver** in Audio MIDI Setup to reach Ableton / Max on the same machine; on Windows use loopMIDI. MIDI out needs the same per-session I/O permission and the browser's MIDI permission. MIDI input stays in the MIDI CC / MidiNote nodes.

**DMX / Art-Net.** Art-Net Out turns a `list` (and/or `value`) into one DMX universe: channels from `start`, 0..1 scaled to 0..255 (or raw bytes), sent as ArtDmx over UDP 6454. It sends on change (up to `rate`, max 44/s) and refreshes once a second. Point `host` at the node's IP or a broadcast address (`2.255.255.255`, `10.255.255.255`) and allow `host:6454`. Use a Serial In / Number List / JS node for the channel list.

**Security.** The bridge accepts connections from the local machine only and does nothing until you say so:
- the WebSocket binds to **127.0.0.1** only. It checks the Host header (against DNS rebinding) and accepts browser pages only from the **PatchToy app's own origin**: the `--app` URL (default `PATCHTOY_URL` or `http://localhost:5173/`) and the PatchToy dev servers running from this repo, the same Origin policy as the MCP bridge. Other localhost pages are refused. Add a deployed app's origin with `--origin`;
- connections must authenticate with the **per-run token** first. The comparison is constant-time, with a 5 s deadline and a lock-out after repeated failures. The token changes every time the bridge starts, and the app removes `?ioToken` from the address bar right after reading it;
- nothing is sent, listened to or opened before the **per-session opt-in**. It resets when the tab closes, and turning it off closes the bridge's sockets and ports;
- outbound UDP only goes to **destinations you allowed**, and serial only opens **ports you picked**. Serial names must be device names (`/dev/…`, `COMn`). These lists live in your browser (localStorage), **never in project files**, so a shared project cannot add a destination: it can only ask. The bridge enforces the opt-in and the lists again on its side;
- OSC In listens on 127.0.0.1 unless you enable LAN input. Messages, rates, sockets and ports are capped per connection;
- the MCP `io_bridge` tool can pair and enable I/O only in headless pages it launched itself, never in your own tab.

A paired, enabled tab can still send anything its patch computes to the destinations you allowed. Only allow hosts you control, and turn I/O off when you are done. Code: `mcp/lib/io-bridge.mjs` (bridge), `scripts/io-bridge.mjs` (CLI), `src/io/` (client, panel, MIDI out, allowlist), `src/core/library/io.js` (nodes).

## Controls

- **Tab**: Open node browser
- **⌘O / ⇧⌘O**: Open panel (My projects, Community, Demos) / import a project file
- **Drag**: Move nodes or create selection box
- **Shift+Click**: Multi-select nodes
- **Delete/Backspace**: Delete selection
- **Click input port**: Disconnect
- **Double-click node**: Open inspector (for nodes with dialogs); on a group box: open the group
- **Right-click**: Context menu (group, ungroup, rename, delete...)
- **⌘G / ⇧⌘G**: Group / ungroup the selection
- **Esc / Backspace** (nothing selected): Leave the open group
- **Click connection midpoint**: Add accessor

## Shader Inspection

Each Preview node has a "View Compiled Shader" button showing the generated GLSL. Compilation errors highlight the problematic node in red.

## Community & cloud saves

Sign in to save projects to the cloud (`⌘S`). Projects are private by default.

- **Open** (top bar, `⌘O` / `Ctrl+O`) shows a panel under the button with three tabs:
  **My projects** (your cloud projects: private / link only / public, rename, delete,
  copy link, download), **Community** (public projects of every user, newest or most
  viewed, search by title or author) and **Demos** (bundled patches). `⇧⌘O` /
  `Ctrl+Shift+O` imports a project file (.json). Links such as `/explore/community` open
  the same browser full screen.
- **1.x backend**: until the 2.0 backend is deployed, the API only knows link sharing.
  The app detects it (no public feed) and offers **Share by link**; **Publish to
  Community** is disabled and the Community tab says it isn't available yet. Test this
  locally with `node scripts/mock-api.mjs --seed --legacy`.
- **Share links**: every cloud project has a link, `patchtoy.com/p/<id>`. Public projects
  open for anyone; private ones only for their owner (others get a clear message).
- **User pages**: `patchtoy.com/u/<username>` lists someone's public projects. Author
  names on cards link there. Edit your display name or username from the account menu.
  Emails are never shown.
- **Forks**: someone else's project opens read-only (a banner says so; your edits stay in
  this browser). **Save a copy** saves it to your account, recording "forked from @author".
- **Thumbnails**: each cloud save captures a small JPEG of the output for the cards.
- **Safety**: JavaScript nodes in a project from someone else stay paused until you allow
  them (the "This project contains JavaScript nodes" prompt); titles and descriptions are
  always rendered as text.

Backend: [infra/BACKEND_README.md](infra/BACKEND_README.md). Release / deploy steps: [RELEASE.md](RELEASE.md).
What's new in 2.0: [CHANGELOG.md](CHANGELOG.md).

## Tips

- Use the Raymarch node for 3D SDF scenes; ForLoops cover other iterative effects
- Blend nodes work great for color palettes, 3D camera interpolation or transitioning between scenes 
- Uniform mode constants + Map node = easy parameter ranges
- Check compiled shader output to debug generation issues
