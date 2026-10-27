# PatchToy Architecture

PatchToy is a vanilla JS + Vite app with no framework. You patch nodes on a canvas. The graph compiles to GLSL ES 3.00 fragment shaders, plus a CPU "control-rate" layer, and renders live in one shared WebGL2 context.

This document maps the code as of 2.0. Paths are relative to the repo root. User-facing docs are in [README.md](README.md), MCP details in [mcp/README.md](mcp/README.md), the backend and deploy in [infra/BACKEND_README.md](infra/BACKEND_README.md) and [RELEASE.md](RELEASE.md).

## Contents

1. [Source map](#source-map)
2. [App wiring and the frame loop](#app-wiring-and-the-frame-loop)
3. [Core graph and compiler](#core-graph-and-compiler)
4. [Node definitions and the library](#node-definitions-and-the-library)
5. [Node groups](#node-groups)
6. [Control-rate system](#control-rate-system)
7. [Clock](#clock)
8. [Audio: engine, worklet tracker, audio textures](#audio-engine-worklet-tracker-audio-textures)
9. [Scenes](#scenes)
10. [JS node runtime](#js-node-runtime)
11. [Params panel and MIDI learn](#params-panel-and-midi-learn)
12. [History (undo / redo)](#history-undo--redo)
13. [Rendering, program cache, QualityGovernor](#rendering-program-cache-qualitygovernor)
14. [Render 3D](#render-3d-srcrender3d)
15. [Output toolkit](#output-toolkit-srcoutput)
16. [Projects, persistence, trust](#projects-persistence-trust)
17. [Community features and the backend](#community-features-and-the-backend)
18. [MCP server, WebSocket bridge, IO bridge](#mcp-server-websocket-bridge-io-bridge-mcp)
19. [Test suite](#test-suite)
20. [Extending PatchToy](#extending-patchtoy)

## Source map

| Path | What lives there |
|---|---|
| `main.js` | `PatchToy` app class: owns the subsystems, custom GLSL node creation, frame loop. Exposed as `window.toy`. |
| `src/core/` | Graph model (`NodeGraph`), `ShaderCompiler`, `TypeRegistry`, `NodeDefinitions`, `Clock`, `History`, scenes, router, built-in uniforms, simulation reset. |
| `src/core/library/` | Built-in node library declared with `libNode()` (math, vector, uv, noise, shape, sdf3d, color, effect, logic, control, audio, sources, params, scenes, io, debug, render3d) and the shared `pt_*` GLSL (`glsl.js`). |
| `src/core/control/` | Control-rate inference (`rates.js`), CPU evaluation (`ControlRuntime.js`), GPU stand-ins (`compiler.js`), safe expression parser, GLSL-semantics math in JS. |
| `src/nodes/` | Node classes (base `Node.js`, Preview, Feedback, JS, Param, SceneSwitcher, Probe, MIDI, Camera, ...). |
| `src/graph/` | Canvas editor: `GraphRenderer`, `NodeFactory`, `NodeGroups`, `SelectionManager`. |
| `src/rendering/` | `RenderLoop`, `ShaderPreview`, `FeedbackRenderer`, `BackgroundRenderer`, `ProbeRenderer`, `glResources` (program cache), `QualityGovernor`, `NodePainter`. |
| `src/render3d/` | Rasterised 3D (Render 3D node, glTF, geometry, instancing). |
| `src/output/` | Output windows, projection-mapping calibration, recording, offline export, codecs and muxers. |
| `src/io/` | Browser side of OSC / serial / Art-Net (through the IO bridge) and Web MIDI out. |
| `src/services/` | `AudioEngine` + `audio/beat-worklet.js`, `AudioTextures`, `MIDIService`, `MidiMapper`, `ApiClient`, `thumbnail`. |
| `src/managers/` | `CompilationManager`, `UniformRegistry`, `ProjectManager`, `CommunityManager`. |
| `src/automation/` | `BridgeClient` (WebSocket to the MCP server) and `AutomationAPI` (the commands it runs). |
| `src/ui/` | App shell, panels (Library, Params, Audio, Scenes), dialogs, gallery / project browser, help center and tour, theme and icons. |
| `mcp/` | MCP server, CLI, bridge, IO bridge, OSC codec, e2e test. |
| `infra/` | AWS CDK stacks and Lambda handlers for the 2.0 backend. |
| `scripts/`, `tests/` | Test runners, mock API, thumbnails, perf, IO-bridge CLI. |
| `projects/` | Bundled demo projects (`<slug>.patchtoy.json`), full-size renders (`<slug>.png`) and gallery thumbs (`thumbs/<slug>.jpg`). |

## App wiring and the frame loop

`PatchToy` (`main.js`) creates a hidden canvas with a shared WebGL2 context. The WebGL1 fallback exists in code, but the renderers assume WebGL2. It then builds `UniformRegistry`, `NodeGraph`, `ShaderCompiler`, `ApiClient`, `ProjectManager`, `BackgroundRenderer`, `FeedbackRenderer`, `CompilationManager`, Render 3D (`installRender3D`), `History`, `QualityGovernor` and `AppShell`, plus the demo gallery, project browser and community manager.

`AppShell` (`src/ui/AppShell.js`) builds:
- LibraryPanel, AudioPanel and ParamsPanel;
- OutputPanel, which creates `OutputManager` and `IOPanel`;
- HelpCenter.

It also drives the status bar from window events (`patchtoy:compile`, `patchtoy:bridge-status`, ...).

**Graph changes:** `onGraphChanged` marks the project dirty, rebuilds the global node-id mapping and schedules a compile (debounced). The Feedback shaders compile in that compile; a changed pass links in the background while its previous program keeps rendering (with auto-compile off they recompile on every change instead). `onUniformValueChanged` only schedules an autosave. Scrubbing an inline (non-uniform) Float / Vec constant compiles it as a temporary uniform (`ConstantNode.liveUniform`, one relink) and compiles the literal back when the scrub ends.

**One rAF frame loop** (`startAnimationLoop`). The Clock's own rAF callback is registered when its module is imported, so it always runs first. Then the loop runs these phases:

1. `tickParams` (Param triggers)
2. `controlRuntime.tick` (control-rate nodes and JS nodes)
3. `tickScenes`
4. `feedbackRenderer.renderFeedbackNodes()`
5. `compilationManager.renderProbes()`
6. `renderLoop.frame(now)` (every visible Preview)

Each phase is guarded: `loopErrors.report` blames the node named by `loopTrace.node` and rate-limits repeated messages. A throw never stops the loop. When the clock is manual (output window, offline export), the owner steps the frame itself through `app.tickFrame`.

## Core graph and compiler

### Graph model

`src/core/NodeGraph.js` holds flat arrays: `nodes`, `connections`, `nextNodeId`, pan / zoom and `groups`.

- **Connections:** `Connection(fromNode, fromOutput, toNode, toInput, accessor)`. The accessor is a swizzle and/or struct member path, for example `.xy` or `.position.xy`. It is serialized under the legacy key `swizzle`.
- **One cable per input.** Connecting to an occupied input replaces the old cable; an output can fan out.
- **Saved format:** `serialize()` writes nodes as `{id, type, x, y, data}` (Preview nodes add size and `isBackground`). Pan / zoom are always those of the root view.
- **Unknown node types survive a round trip:** they are kept in `missingNodes` / `missingConnections` and written back unchanged.
- **`deserialize()`:**
  - frees GPU and stream resources first, starts a new program-cache epoch and resets the project runtime (`src/core/simulation.js`);
  - then rebuilds dynamic ports (Blend, ForLoop) and reloads groups.

`NodeFactory` picks the node class from definition flags (`isPreviewNode`, `rate === 'control'`, `isLibraryNode`, ...). It applies `def.migrateData` when restoring saved data.

### Compilation

`CompilationManager.scheduleCompile()` debounces for 100 ms, then calls `compile()`.

**`compile()`:**
- Skips the compile when `graphSignature()` is unchanged. The signature covers ids, types, definitions, ports, data and cables.
- Builds `globalNodeIdRemap` (sorted ids → 0..n-1), so a node gets the same `node_N` name in every shader.
- Compiles, in order: Feedback passes, Render 3D programs, every connected Preview, then probes.

**`ShaderCompiler`** (one shared instance):
- `compileFromNodeAsOutput` walks upstream from the output node through `compileNode` / `compileNodeBody`:
  - results are memoised per scope;
  - an `inProgress` set rejects cycles. Feedback nodes are the only way to close a loop.
- Per input:
  - connected values go through `convertForInput`, which applies `TypeRegistry` auto-conversions such as float → vecN or vec3 → vec4;
  - unconnected inputs use `node.data[input]` or the default;
  - `functionOf` inputs are compiled as standalone GLSL functions in their own scope ("lambdas", e.g. `Raymarch.sdf`).
- `validateTypes` resolves generic and `any` outputs on the node instance, never on the shared definition.
- `def.glsl(node, inputs, compiler)` returns `{code, output, uniforms, preamble, requiresFunction}`. Helper functions are deduplicated by content and renamed when names collide.

**`buildFragmentShader`** assembles the final shader:
- built-in uniform declarations, added only for the uniforms the code actually uses (`src/core/builtinUniforms.js`, word-boundary scan);
- struct definitions (`TypeRegistry`: `Camera`, `Ray`, the Render 3D structs);
- helper functions, scene functions and `main()`.

It records `mainCodeStartLine` so driver errors can be mapped back to nodes.

**Uniforms:**
- Constants in uniform mode, Params, control-rate outputs and JS outputs become uniforms named after the node (`node_N…`).
- After a compile, `UniformRegistry` maps each name to `{type, value, sourceNodeId}`, and renderers read it every frame.
- `liveUniform.pushLiveUniform(node)` updates a node's entries without recompiling. Value changes never recompile.

**Feedback.** Each Feedback node owns two framebuffers used in ping-pong. Its input sub-graph renders into the write buffer, and readers sample the previous frame. A Feedback node does not traverse its inputs inside another shader; this is what breaks cycles.

**Loops.** `ForLoopStart` declares the loop variables and opens `for (...) {`. `ForLoopEnd` writes the updated values back and closes the loop. The body is whatever compiles between the two in depth-first order, and the end node forces its start to compile first.

**Errors:**
- WebGL errors `ERROR: 0:L:` map to the node that generated line L, using a per-preview line → node table.
- Graph errors carry `errorNodeId`; the node is painted red.
- Feedback-pass errors and JS runtime errors (`setRuntimeError`) are reported in the same console.

**Drawing:**
- `GraphRenderer` draws the current group scope only: grid, cables, the drag cable, loop brackets and tooltips. It redraws only when something changed or a preview produced a frame.
- `NodePainter` holds stateless drawing primitives.
- Colours, fonts and layout tokens are in `src/ui/theme.js`, mirrored as CSS variables in `style.css`.

### Custom GLSL nodes

**Creation.** `main.js:createCustomNode` parses magic comments with `src/utils/GLSLCommentParser.js` and registers the result as a `NodeDefinitions` entry. Directives: `@node`, `@title`, `@category`, `@input name "Label" default=... defaultNode=...`, `@option`, `@description`. Comments are generated when the code has none.

**Policy** (`src/core/customNodes.js`):
- names match `^[A-Za-z][A-Za-z0-9_]{0,48}$` and may not shadow built-ins;
- at most 100 custom nodes, 64 KB of GLSL each.

**Scope and storage:**
- user library: localStorage `patchtoy_custom_nodes`;
- project scope: embedded in the project file. Only the custom nodes the graph actually uses are embedded (`collectCustomNodes`).

## Node definitions and the library

`src/core/NodeDefinitions.js` merges four sources:
- hand-written entries (Preview, Feedback, ForLoop, Camera, Microphone, JS, ...);
- `Legacy*Overrides`, which replace old nodes in place with the same key and input order;
- the library modules from `src/core/library/`;
- control-rate "twins" (`installControlTwins`).

`NODE_CATEGORIES`: output, constant, input, source, math, vector, uv, noise, shape, sdf3d, render3d, color, effect, logic, control, io, custom, debug, note. `scripts/check-definitions.mjs` enforces categories, ports and descriptions.

### `libNode(spec)` (`library/define.js`)

Returns a regular definition, so library nodes go through the normal compiler path.

- **Generic types:** inputs and outputs of type `'T'` resolve per node to the widest connected float / vec2 / vec3 / vec4. `scalar: true` keeps a float input scalar, and `cast` forces a type.
- **Code:** `expr(I, ctx)` gives a single-output expression. `body(I, ctx)` returns `{code, out: {name: expr}}`; each output becomes `node_N_<name>`.
- **CPU twin:** an optional `js(I, ctx)` twin becomes `def.evaluate` and lets the node run at control rate.
- **Shared GLSL:** `pt_*` functions from `library/glsl.js` are collected automatically, dependencies first.
- **Defaults:** `'@p'` as a default means "the 3D sample point".

### Amount convention (`library/amount.js`)

`effectNode()` appends a final `amount` input:
- 0 is an exact bypass (identity);
- 1 is the original effect;
- values in between fade continuously.

It is always the last input, so index-based cables in old projects stay valid. Scene presence outputs are meant to be wired into `amount` inputs.

## Node groups

`src/graph/NodeGroups.js` and `src/ui/GroupUI.js`.

**Groups are view-only metadata.** The compiled graph stays flat: the compiler, Feedback, History and MCP never see groups. Previews inside a closed group simply don't render.

**Saved record** (`graph.groups[]`): `{id, name, parentId, nodeIds, x, y, color?, collapsed?, exposed?, portLabels?}`.
- `nodeIds` lists direct members only; each node belongs to its innermost group.
- Member positions are coordinates inside their own scope.

**Classes:**
- `GroupProxy`: a child group drawn as a single box with a minimap. Its ports are synthesised from the cables that cross the boundary, deduplicated by source port.
- `BoundaryPanel`: the "From outside" / "To outside" panels shown inside an open group.
- `ViewLink`: a cable between visible items. It can aggregate several real connections.
- `NodeGroups`: scope and view cache (`buildView`, `withScope`). Handles create / ungroup / move, exposed ports, rewiring, copy / paste, and `serializeGroups` / `load`, which sanitises ids and drops bad members.

**UI** (`GroupUI`): breadcrumbs (Root › A › B), context menus, rename, the port-names dialog, and the port picker when a cable is dropped on a box. `setScope` fires a `patchtoy:scope` event.

**Transitions:** entering or leaving a group (parent ↔ child only) animates for 640 ms with in-out cubic easing.
- The camera zooms into the box's minimap while the inner scope fades in; `GraphRenderer.renderTransition` cross-fades two offscreen layers.
- The zoom wheel can scrub the transition by hand. It settles to the nearer end after 140 ms idle.
- Jumps across several levels cut instead, and `prefers-reduced-motion` turns transitions off.
- These transitions are unrelated to scene transitions.

## Control-rate system

`src/core/control/`. Some nodes run once per frame on the CPU instead of once per pixel.

**Rates** (`rates.js`). Pixel nodes are drawn with circular ports; control nodes with diamond ports and dashed cables.
- **pixel:** GLSL.
- **control:** JS once per frame, may keep state. Examples: LFO, Lag, Slew, Spring, Counter, SampleHold, Delay, MathExpression, BeatDivider, TextPick, TextTexture, and the IO nodes.
- **free:** known on the CPU. It is compiled as GLSL when a shader needs it.

**`nodeKind(node)`:**
- `control`: `def.rate === 'control'`.
- `source`: Param, JS, Keyboard, XYPad, MIDI and Microphone nodes.
- `infer`: the node has a `def.evaluate` twin. It becomes pixel if any input is pixel, control if any input is control or a CPU source, and free otherwise.
- `pixel`: everything else.

**Plan.** `ControlPlan` holds kinds, rates, a topological `order`, the uniform-backed nodes, rate violations and errors. It is cached per graph fingerprint (`getControlPlan`).

**Rules:**
- pixel → control cables are rejected: use a **Sample** node, which reads one frame late through the probe readback.
- `event`, `string` and `list` values only connect to JS-run nodes.

**GPU side** (`control/compiler.js`): a control node is replaced by uniforms `node_N_c<k>`, and its inputs are not traversed. Control sub-graphs, including Delay loops, never reach GLSL. CPU-made textures (Text / List Texture) are bound as `sampler2D`.

**CPU side** (`ControlRuntime.tick`):
- evaluates `def.evaluate`, or `jsRuntime.runOne` for JS nodes, in plan order;
- runs `def.post` hooks afterwards (Delay);
- pushes finite outputs to the UniformRegistry;
- keeps per-node state in `_ctlOut` / `_ctlState` / `_ctlError`.

`evaluateScratch` / `restoreLive` support pinned-time renders.

**Helpers and switch:**
- `expr.js` is a recursive-descent parser; nothing is eval'd.
- `vmath.js` reproduces GLSL semantics in JS: `mod`, broadcasting, `smoothstep`, rounding.
- `legacyTwins.js` gives hand-written nodes CPU twins.
- Kill switch: `?control=off`, or localStorage `patchtoy_control_rate = 'off'`, compiles everything at pixel rate.

## Clock

`src/core/Clock.js`, singleton `clock`. It is the single time base (`u_time`, pause, manual stepping) and the beat clock.

`applyClockUniforms(gl, locs)` uploads the clock uniforms without allocating. ShaderPreview, FeedbackRenderer and Render 3D call it.

### Raw clock vs published clock

There are two beat clocks.

**Raw clock** (`rawPos`, `rawPeriodMs`): the tracker's live estimate. It follows one of three sources:
- the worklet tracker while `following` (hysteresis: start at confidence ≥ 0.35, stop below 0.2);
- the metronome;
- a tap anchor.

Each frame it advances by `dt / period`, then slews toward the target. It never runs backwards and never exceeds 2× speed. It is exposed only as `u_beatRaw = vec4(phase, barPhase, count, bpm)`.

**Published ("stable") clock** (`pubPos`, `pubTempo`, `pubState`): what every shader sees.
- Without live audio, or in metronome mode, it copies the raw clock bit for bit (`_publishRaw`).
- With live audio, `_publishLive` runs a state machine:
  - **coast:** keep the last tempo and a continuous phase. Entered when, for 400 ms (`BAD_MS`):
    - the estimate is untrusted (confidence below 0.2 while trusted, below 0.35 while untrusted);
    - a locked tempo jumps by more than 3 %;
    - the phase error exceeds 0.12 beat.

    It is entered at once when the estimate is clearly gone: confidence below 0.1, a tempo step above 8 % or a phase move above 0.25 beat (a new track). During the 400 ms grace the clock **holds** (tempo and rate kept, no phase bend, half trust), so short dips of weak room-mic onsets don't throw a good lock away. Going live always starts in coast.
  - **glide:** a candidate estimate that has held still (tempo within 1.5 %, little slew, for at least max(1 s, 2 beats)) is approached with a monotonic smoothstep tempo glide over 4 beats.
  - **lock:** reached once the glide ends and the phase error is below 0.03 beat. The tempo then follows the tracker (τ 400 ms).
  - Phase is corrected by bending the rate by at most ±25 % (smoothed, τ 150 ms). The published phase never jumps and never runs backwards.

### `u_beatTrust`

Reports how far the published clock can be relied on, from 0 to 1.
- **Trusted:** it slews (up τ 500 ms, down τ 120 ms) toward the product of:
  - phase agreement;
  - tempo agreement;
  - confidence;
  - a confidence-drop factor: 1 within 1.5 deviations below the confidence's own recent mean, 0 beyond 3.5. Mean and spread are learned while locked from values within the normal band (τ 8-10 s), so a lasting fall (a new track the tracker hasn't noticed, a wrong-phase relock) keeps trust down while confidence that always fluctuates (room mic, syncopation) doesn't;
  - ½ while holding.
- **Untrusted:** it slews toward 0.
- **Always 1** without live audio, in manual steps and in pinned renders.
- `u_beat` is multiplied by `beatGate(trust)`, a smoothstep around 0.5. Effects that couple to beat phase should do the same; the Beat node's `gate` output provides it.

### Uniforms

| Uniform | Source |
|---|---|
| `u_beat`, `u_beatPhase`, `u_barPhase` (4-beat bar), `u_beatCount`, `u_beatTime` (count + eased phase), `u_bpm` | published clock |
| `u_beatConfidence` | tracker confidence (1 for metronome / locked file) |
| `u_beatTrust` | see above |
| `u_beatRaw` | raw clock (diagnostics; Beat Lab shows both clocks) |
| `u_level`, `u_bass`, `u_lowMid`, `u_mid`, `u_high`, `u_kick` | AudioEngine. In metronome mode they come from `Clock.groove`, a synthetic kick / snare / hat. |

### Gestures

- `setMode('free' | 'metronome')`.
- `setBpm`, which keeps the phase.
- `tap`: median of up to 9 taps, 30-300 BPM. The first tap makes the beat a downbeat.
- `offsetMs`: ±200 ms, set from the audio settings.

Every gesture re-snaps the published clock, which is then trusted.

### Deterministic renders

- `withOverride({time, beat, bpm}, fn)` pins the clock for a render: `render_preview {beat_phase}` and the visual tests. Inside it, confidence and trust are 1.
- `setManual(on, {owner})` / `step(dt)` let the output window and offline export drive time.

### Beat node and BeatEnvelope

Defined in `src/core/library/sources.js`; option pills are drawn by `OptionNode`.

**Beat node.** Outputs: pulse, phase, bar, count, bpm, time, confidence, gate. Options (`BEAT_OPTIONS`):
- `clock`: `stable` (default, the published clock) or `raw` (`u_beatRaw`).
- `gate`:
  - `fade` (default): the pulse is multiplied by the trust gate.
  - `hold`: control rate only. The node keeps its own position, freezes while trust is below the threshold, then catches up to the nearest bar. In GLSL it falls back to `fade` with a compiler warning.
  - `off`.

**BeatEnvelope.** `shape` is exp, ad, pump, saw or sine; `k` sets sharpness. It is gated the same way when its `phase` input is unconnected.

## Audio: engine, worklet tracker, audio textures

### AudioEngine

`src/services/AudioEngine.js`, singleton `audioEngine`, owns the one AudioContext.

**Sources:**
- `mic`: getUserMedia with processing off;
- `file`: an `<audio>` element, looping, drag-and-drop anywhere;
- `tab`: getDisplayMedia, audio only;
- `metronome`;
- `off`.

**Worklet wiring.** The `patchtoy-analysis` worklet node has two inputs: input 0 is the analysed source, input 1 is the Microphone-node meter. Microphone nodes ref-count the mic.

**Worklet messages** are kept in a ~0.5 s ring:
- a state vector of 16 values;
- an optional texture frame;
- mic RMS.

**`update()`** runs every frame while live:
- maps AudioContext time to display time (output latency; mic input latency; −20 ms for tabs);
- for files, reads the entry audible *now*;
- feeds the kick envelope and the beat reference to the Clock.

**Commands to the worklet:** `tempo`, `lock`, `reset`, `textures`.

### Beat worklet

`src/services/audio/beat-worklet.js`. Self-contained, so it also runs under Node for tests. `BeatTracker`:
- Hann window and 1024-point FFT every ~5.3 ms, giving about 21 log bands;
- whitened spectral flux as onset strength;
- tempo by autocorrelation over 8 s and 3 s windows (70-180 BPM), with fast / slow switching and octave resolution (a metrical ratio the 8 s window disagrees with must win three re-checks in a row; one the slow path reverted is vetoed, so no tempo ping-pong);
- a Kalman filter on beat time, period and drift. Its timing noise is learned from the scatter of the measured errors (clean drums a few ms, room mic 15-25 ms), so noisy timing neither drags the period nor triggers maneuver detection. While the 8 s tempo estimate is steady (±0.3 % for 4 s, octave-folded) the period is held to it (τ ≈ 5 s) with less process noise;
- comb phase alignment;
- confidence = periodicity × hit rate, with long-term evidence as a floor (`updateEvidence`): the tempo agrees with the steady 8 s estimate and the tracked phase is the best, clearly peaked comb alignment over 8 s and 4 s. Weak but consistent onsets therefore still give a confident beat; the floor goes when the hit rate collapses against its own recent level (new track, break);
- kick detection below 200 Hz.

It posts the state (`MSG` layout: level, bands, kick, BPM, confidence, beat time, period, locked, ...) at about 94 Hz. Reported times are signal times with the analysis delay removed. While textures are wanted, `TextureTap` also posts the power spectrum and a 1024-sample waveform aligned to a rising zero crossing. Tunables are in `TRACKER_DEFAULTS`.

### Audio textures

`src/services/AudioTextures.js` (`audioTextures`) and `src/core/audioTextureConfig.js`.

**Kinds:**
- spectrum: RG16F, level and peak hold;
- waveform: R16F;
- spectrogram: 256-row ring, only new rows uploaded.

**Built-ins:** `u_spectrum`, `u_waveform`, `u_spectrogram`. The `AudioTexture` node exposes other bin counts, scales, smoothing and history lengths, with one GPU texture per distinct config key.

**Data modes:**
- `live`: worklet frames, auto-gained;
- `synth`: a deterministic metronome mix at the clock's beat position, used for headless and tests;
- `zero`: audio off.

**Upload and lifetime:**
- Textures upload lazily, at most once per frame, on first bind.
- The worklet stops posting texture frames 1.5 s after the last use.
- Unused textures are swept.

**Effect nodes:** SpectrumBars, WaveformLine and CircularSpectrum are in `library/audio.js`.

**Declared only when used:** audio and beat uniforms and samplers are declared only in shaders that reference them, through the built-in uniform scan.

## Scenes

`src/core/scenes.js`, `src/core/library/scenes.js`, `src/nodes/SceneSwitcherNode.js`, `src/ui/ScenesSection.js`.

**Inputs of a Scene Switcher:**
- `scene` and `next` (CPU inputs);
- `transition`, a `functionOf` input `(sc_a, sc_b, sc_p, sc_uv)` for custom transitions;
- numbered vec4 scene inputs.

**Node data:**
- `scenes[{name, transition?, duration?}]`, `current`;
- transition style, duration in seconds or beats, easing;
- auto mode: off / bars / seconds / music;
- playlist.

**Codegen:**
- Each scene compiles to its own function `node_S_s<i>()`. Values shared with `main` are hoisted to globals; position-dependent nodes are compiled per scene.
- `node_S_run()` loops over uniform bounds: one scene when idle, two during a transition. Graphs without a switcher are unaffected.

**Transitions:** 15 styles in `TRANSITIONS` (cut, crossfade, wipes, ..., custom) and 7 easings in `EASINGS`.

**Runtime** (`SceneSwitcherNode.tick`):
- reads the CPU inputs and runs auto mode (it waits up to 8 s while the beat is untrusted);
- advances progress and pushes `_a, _b, _k0, _k1, _p, ...` uniforms. Switching never recompiles.
- `sceneGates` / `feedbackPassActive` skip Feedback passes that only hidden scenes use.

**ScenePresence** outputs presence / phase / leaving for the scene it belongs to, found by reachability. Wire it into `amount` inputs for per-scene entrances and exits.

**UI:** `ScenesSection` sits in the Params panel. Number keys switch scenes, and MIDI can map scene / next / prev / select.

## JS node runtime

`src/nodes/JSNode.js`, `src/nodes/jsRuntime.js` (singleton `jsRuntime`), `src/core/jsDefaults.js`.

**Execution:**
- Code runs on the main thread, compiled with `new Function` / `AsyncFunction`. There is no worker or sandbox; the trust prompt below is the safety mechanism.
- The runtime runs once per frame inside `ControlRuntime.tick`, in plan order, so upstream control nodes are fresh.
- `setupCode` runs once (async). It gets `loadScript`, `state`, `params`, `canvas`, `texture`, `dataTexture`, and re-runs with a fresh state when its source changes.
- The frame function receives `time, dt, frame, resolution, mouse, audio, params, state, inputs, list, event, damp, ...`. It must not return a Promise.

**Inputs:** declared with `// @input name type [= default]`, up to 12. Types: float, int, bool, vec2-4, event, string, list.

**Outputs** come from the return value:
- number / boolean / 2-4 arrays become float / bool / vecN uniforms;
- strings, lists and events are control-only;
- a canvas, video or ImageBitmap, or `texture()` / `dataTexture()`, becomes a `sampler2D`;
- an object returns named outputs (up to 16).

Values are pushed to the UniformRegistry every frame. Only a change of output signature rebuilds ports and recompiles, with a 500 ms cooldown against flapping. Canvases re-upload only when drawn to. Data textures use float formats with fallbacks.

**Errors:** a throw marks the node and is reported in the console, throttled to once per 5 s per message. NaN or Infinity outputs are sent as 0.

**Trust.** Trust is keyed on `setupCode + "\0" + code`:
- trusted code is stored in localStorage `patchtoy_js_trusted` (up to 200 entries);
- projects opened through MCP get session-only trust;
- the default snippet is always trusted.

Unknown code stays *paused*, and one prompt per project asks "This project contains JavaScript nodes. Run them?". Undo never trusts code.

## Params panel and MIDI learn

### Param node

Defined in `library/params.js`; kinds in `src/core/paramKinds.js`: float, int, bool, vec2-4, color, enum, trigger, image, text.
- Everything lives in `node.data` (label, kind, value, min / max / step, scale, options, section, order, ...) and is saved with the project.
- `ParamNode.setValue(raw, {commit})` coerces the value and pushes the live uniform. It dispatches `patchtoy:param`, and nothing recompiles.
- Triggers are a vec3 `(pulse, count, press time)`. Text is control-rate only. Image binds a sampler.

### ParamsPanel

`src/ui/ParamsPanel.js` is a DOM panel. It lists every Param in the project, whatever the open group or zoom, grouped by `data.section`, ordered by `data.order` and reorderable by drag. It hosts `ScenesSection` and the MIDI learn UI.

### MIDI

**`MIDIService`** wraps Web MIDI: raw, CC and note subscribers, `send()` and `simulate()`.

**`MidiMapper`** (`src/services/MidiMapper.js`):
- **Storage:** mappings are stored in `node.data.midi[]` on Param and SceneSwitcher nodes, so they are saved, copied and undone with the node.
- **Mapping fields:**
  - type (cc / note / pitchbend / aftertouch), number, channel, device;
  - target (value, a component, hue / sat / ..., option, step, scene / next / prev / select);
  - mode (absolute or relative encodings), pickup (soft takeover), invert, range, slew, 14-bit, feedback.
- **Learn:** `startLearn(target)` binds the next message.
  - Vectors learn one component per control.
  - Enums can learn one note per option.
  - A fresh CC is watched for 1.2 s to detect relative encoders or a 14-bit pair.
  - Global learn mode: click a row, touch a control, repeat.
- **Undo:** editing mappings is undoable. MIDI-driven value changes are not undo steps (debounced save only).
- **UI:** `MidiLearnUI` draws the learn buttons, badges, the mapping editor and the top-bar LED.

**MCP:** `src/automation/midiAutomation.js` adds `midi_map`, `midi_unmap` and `simulate_midi`.

**Standalone nodes:** `MidiCC` (with its own learn button and smoothing), `MidiNote`, `Keyboard` and `XYPad` are source nodes that push live uniforms.

## History (undo / redo)

`src/core/History.js`. Bindings: ⌘Z / Ctrl+Z, ⇧⌘Z / Ctrl+Y, the context menu and the MCP tools `undo` / `redo` / `history`.

**Snapshots, not commands.** A snapshot holds:
- one JSON string per node, with live values stripped: MIDI readings, a switcher's current scene, trigger counters;
- the cable keys;
- one string per group record;
- one string per custom GLSL definition.

Unchanged strings are shared with the previous snapshot. View, open group, z-order and output calibration are not recorded.

**Steps store diffs:** `[before, after]` pairs of the changed entities only. Limits: 100 steps, about 24 MB.

**When a step is taken.** User gestures schedule a capture:
- pointer up, so a drag is one step;
- input events, debounced 500 ms; data edits to the same node within 1 s merge;
- blur and drop.

Graph changes that no user gesture explains are absorbed silently (MIDI, JS outputs, auto mode).

**API:**
- `hint(label)` names the next step.
- `beginBatch` / `endBatch` / `batch(label, fn)` group work into one step. Every MCP command is a batch.
- `record(label, fn)`.

**Restore in place.** Live nodes keep their GPU buffers, JS state and streams. A recompile happens only if compile-relevant state changed. Loading a project or starting a new one clears the history.

## Rendering, program cache, QualityGovernor

**Shared context and program cache** (`src/rendering/glResources.js`, state per GL context):
- `ProgramCache` keys programs by vertex + fragment source and refcounts them, keeping up to 24 idle. Failures are cached too.
- Optional parallel linking of the previews via `KHR_parallel_shader_compile` (localStorage `patchtoy_async_compile = '1'`). Feedback passes always link that way in scheduled compiles.
- `newEpoch()` runs on project switch.
- Also owns the shared quad, the camera texture (uploaded once per frame) and `presentTexture`, a GPU copy to a 2D canvas with no readPixels.
- Managed objects are protected against stray `gl.delete*` calls.

**Renderers:**
- **`RenderLoop`** renders registered `ShaderPreview`s. It skips previews that are off-screen or inside closed groups, and hidden tabs. Outside High quality, small thumbnails render at half or quarter rate.
- **`ShaderPreview`** loads programs (possibly pending), sets `u_resolution`, the clock uniforms, `u_mouse`, `u_camera` and registry uniforms (samplers from unit 1).
- **`SharedCanvasPreview`** renders in the shared canvas and blits to a 2D target, optionally at a governed scale. Used by the background (`BackgroundRenderer`), fullscreen and help previews.
- **`FeedbackRenderer`** runs the Feedback passes, sized by `quality.feedbackScale`. Its `injectFeedbackTextures` binds feedback, image Params, JS and Render 3D textures, audio textures, mic and MIDI CC values for every renderer.

**Probes** (`ProbeRenderer`, `src/nodes/ProbeNode.js`, `library/debug.js`): Value, Color, Plot, XY Scope, Frame Stats, Histogram and LED.
- `gl_FragCoord` is rewritten through `u_probeMap`, and all probes draw into one atlas.
- Results come back through an async PBO + fence readback, collected a frame later with no stall.
- `sampleNow` is a blocking read for MCP calls and export.

### QualityGovernor

`src/rendering/QualityGovernor.js`, with the status-bar menu in `src/ui/QualityControl.js`.

**Modes** (localStorage `patchtoy_render_quality`):
- Auto: scale 1 → 0.5, the default;
- High: 1;
- Balanced: 0.75 → 0.5;
- Performance: 0.5 → 0.25.

**Governors:** two `ScaleGovernor`s, `background` (editor background and fullscreen) and `output` (the output window). Each measures its window's rAF delta against the target: 60 fps, or the display refresh if lower.
- **Step down** one `SCALE_LEVELS` entry after sustained frames above 1.2× the target. If that gains less than 6 %, the step is undone and the governor backs off for 8 s, doubling up to 2 min.
- **Step up** after a hold of 1.5 s, doubling up to 30 s after a failed step-up.
- A compile holds the scale for 1.5 s.

**Refresh rate.** `RefreshEstimator` measures it with idle rAF bursts (at startup, on focus and on screen change), snaps to common Hz values and caches the result per screen. Busy frames may only raise the estimate.

**Feedback auto-scale.** Feedback nodes with `data.autoScale` size their buffers to the outputs shown in the last 0.5 s (a project toggle in the menu), with hysteresis, and not while a governor judges a step it may undo. Framebuffer completeness is checked once per format. `holdFullQuality()` forces full size while recording or exporting.

## Render 3D (`src/render3d/`)

Definitions are in `src/core/library/render3d.js`. That module is DOM-free: it registers the `Material` / `Light` / `Instance` structs and the `Geometry` / `Object3D` port types, and adds the `pt_r3*` GLSL. The runtime is installed by `installRender3D(app)`, which sets `app.render3d`.

**A texture source.** A `Render3D` node is a 3D scene inside one node.
- Outputs: `color` (RGBA16F, premultiplied), `depth` (R32F, distance along the view ray, the same convention as `Raymarch.t`) and `normal`.
- In a Preview or Feedback compile, its inputs are not traversed. Its outputs are `sampler2D` uniforms bound like JS textures (`jsTextureNodeId`).

**Scene inputs:**
- `item1..N` (up to 64): Mesh, Model, Group 3D (nesting up to 12, loops rejected) and lights;
- `camera`, `background`, `bgDepth`.

**Geometry nodes:** box, sphere, torus, plane, grid, cylinder, torus knot, bird, text and points, built on the CPU.

**Compile** (`compile.js`, called after the Feedback passes). Per drawn object, the shared ShaderCompiler generates:
- a vertex shader: camera; object and group TRS in GLSL, so Params and Time animate them; the `instances` sub-graph as `Instance fn(id, count)`; the `displace` sub-graph; skinning; points;
- a fragment shader: the `material` sub-graph, or a glTF material; PBR (GGX / Smith / Schlick), toon, glass-lite and unlit shading; PCF shadows; fog; MRT outputs;
- a shadow vertex shader.

Variants are linked lazily through the ProgramCache.

**Render** (`Render3DNode`):
- Renders lazily, on the first bind of a frame. Freshness is keyed on frame, time, beat and size.
- `GLStateGuard` saves and restores all GL state it touches, because the render can happen inside another renderer's uniform setup.
- Pass order:
  1. shadow map (first shadow-casting directional light, 256-4096 px);
  2. background;
  3. opaque objects;
  4. blended objects;
  5. MSAA resolve.
- Instanced draws up to 16.7 M instances.
- Size: `auto` follows the largest output shown, times its quality scale, capped by `maxSize` (default 1920). `fixed` uses `data.width` × `data.height`.

**glTF** (`gltf.js`, no dependencies):
- Supports GLB / glTF, PBR textures, skins and animation clips, and KHR unlit / emissive / quantization. Draco and meshopt are rejected with a clear error.
- Models up to `MODEL_SIZE_CAP` (15 MB) are stored in the project as data URLs. Larger files are kept for the session only.
- Dropping a `.glb` creates a Model node, wired into a Render 3D node.

**MCP:** `automation.js` adds the MCP notes, stats and `load_model`.

## Output toolkit (`src/output/`)

**OutputManager** (`app.output`, created by `OutputPanel`):
- Source: `'main'` (the background preview, else the first Preview) or a node id.
- `renderInto`: a `SourceRenderer` at the target size → `WarpPass` (calibration) → canvas.

**OutputWindow** is a same-origin popup:
- It takes over the clock (`clock.setManual(owner)`) and drives frames at the projector's refresh rate.
- It uses the `output` governor and the Window Management API to place itself on a screen.
- Performance mode suspends editor rendering.

**Calibration** (`Calibration.js`), for projection mapping:
- Catmull-Rom grid warp followed by a keystone homography;
- edge blend, a polygon mask and test patterns.

It is stored per display in the project (`graph.output.calibrations`), with a per-machine localStorage fallback.

**Recording:**
- **Realtime** (`Recorder.js`): MediaRecorder on the canvas stream, with optional audio from AudioEngine. The WebM duration is fixed afterwards.
- **Offline export** (`OfflineExporter.js`):
  - Steps the manual clock at a fixed `1/fps` through `tickFrame`, with an optional reset "from start", seeded `Math.random` and a frozen mouse.
  - Encodes with WebCodecs into an in-memory WebM or MP4 muxer (`muxers.js`), or writes PNG frames to a zip or a folder.
  - `liveInputs()` warns about inputs that stay live: mic, MIDI, camera, I/O.

**Formats** (`codecs.js`): presets (720p to 4K, square, vertical), frame rates, bitrates and codec probing (H.264 profiles, VP9, VP8).

## Projects, persistence, trust

**Project file** (`*.patchtoy.json`): `{name, description, version: '1.0', timestamp, graph: {nodes, connections, nextNodeId, panX, panY, zoom, groups?, output?}, customNodes: {Name: {category, inputs, outputs, customGLSL}}, editorStates}`.

**ProjectManager:**
- Autosaves to localStorage `patchtoy_graph`. A failed restore keeps the raw data in `patchtoy_graph_corrupt` and turns autosave off.
- Keeps a local copy per cloud project; on open, the newer of the local and cloud copies wins.
- Load order:
  1. release the previous project's custom nodes;
  2. register the project's custom nodes in project scope;
  3. set the content gate;
  4. `deserialize`.

**Demos.** `src/ui/demoManifest.js` globs `projects/*.patchtoy.json` at build time, excluding `e2e-*`, `test-*`, `tmp-*` and `*.test.*`. Only the small `projects/thumbs/*.jpg` thumbnails are bundled.
- `CURATED_ORDER` comes first.
- `DemoGallery` opens a demo through `app.openProjectFile` and makes its main Preview the background.
- Thumbnails come from `npm run thumbs` (`scripts/make-thumbs.mjs`, macOS `sips`). It converts the 1280×800 `projects/<slug>.png` render into a 640×400 JPEG.
- The full-size renders are made headless with the MCP CLI, for example: `node mcp/cli.mjs --project beat-lab set_audio '{"mode":"metronome"}' render_preview '{"width":1280,"height":800,"time":10.04,"warmup":600}' --out projects/beat-lab.png`.

**Trust gates** for projects that aren't yours:
- JS code needs the JS trust prompt (see [JS node runtime](#js-node-runtime)).
- Remote media goes through `src/core/contentGate.js`: Video URL and image-Param loads from other websites wait behind one "This project loads media from other websites" prompt. Files you open yourself are unrestricted.

## Community features and the backend

### Front end

**Router** (`src/core/router.js`):
- Routes: `/`, `/p/<id>`, `/u/<username>`, `/explore[/demos|community|mine]`.
- The legacy `?project=<id>` form is rewritten to `/p/<id>`.
- The sign-up `#verify=` token is removed from the URL before any request.
- `setMeta` sets the title and Open Graph tags.

**ApiClient** (`src/services/ApiClient.js`):
- **API URL:** dev builds honour `?api=`; production builds accept only loopback URLs there. Then `VITE_API_URL`, then `config.API_URL`.
- **Session:** a JWT stored per API URL, so a mock server never sees the production token. A 401 signs the user out.
- **Capability probe:** `GET /api/projects/public?limit=1`. A 404 or 403 means a 1.x backend: community features are hidden and saving still works.

**Visibility:** `private`, `unlisted` (link only) and `public` (listed in Community). Legacy `isPublic: true` maps to unlisted.

**CommunityManager:**
- **Opening someone else's project:** it opens read-only like a demo, and a view is recorded once per browser session.
- **Saving it** creates a fork (`forkedFrom`).
- **Thumbnails:** after a cloud save, `services/thumbnail.js` captures a 480×300 JPEG (≤ 140 KB) and uploads it through a presigned S3 POST.

**ProjectBrowser:** one gallery (⌘O) with tabs for My projects, Community, Demos and user pages. User text is set only through `textContent`.

**Dialogs:** `AuthDialogs` handles sign-up with email verification, login and password reset. `ProjectDialogs` handles save, share and the project menu.

### Backend (`infra/`, AWS CDK)

**`PatchToyStack`** (site):
- S3 + CloudFront + ACM + Route53 for `dist/`.
- A strict CSP. `'unsafe-eval'` is allowed for JS nodes.
- SPA fallback.
- Optional Lambda@Edge `edge/social-preview.ts` on `/p/*` and `/u/*` for Open Graph tags (`ENABLE_SOCIAL_PREVIEWS`).

**`PatchToyBackendStack`** (only with `DEPLOY_BACKEND=true`):
- **DynamoDB:**
  - `PatchToy-Users` (email and username indexes);
  - `PatchToy-Projects` (per-user index; sparse public feed index; optional popular and user-public indexes, each added in its own deploy);
  - `PatchToy-Security`, with TTL: rate limits, lockouts, pending sign-ups, tokens.
- **Storage:** an S3 thumbnails bucket behind CloudFront (OAC).
- **API Gateway** (throttled), with Node 20 Lambdas.

**Endpoints** (all under `/api`):
- auth: `register`, `login`, `verify`, `verify-email`, `resend-verification`, `request-password-reset`, `reset-password`;
- projects:
  - `GET` and `POST /projects`;
  - `GET /projects/public`;
  - `GET`, `PUT`, `DELETE /projects/{id}`;
  - `PUT /projects/{id}/visibility`;
  - `POST /projects/{id}/view`;
  - `POST /projects/{id}/thumbnail`;
- users: `GET /users/{username}`, `PUT /users/me`.

**Shared Lambda code** (`infra/lambda/shared/`):
- **Store:** the `Store` interface (`store.ts`), with `DynamoStore` and an in-memory store for tests and the mock.
- **Auth:**
  - HS256 JWT with audience, issuer and token version (`jwt.ts`). A password reset or username change signs other sessions out.
  - bcrypt cost 12 with constant-time handling of unknown accounts (`password.ts`).
- **Limits** (`validate.ts`, `limits.ts`):
  - project data ≤ 350 KB, ≤ 2000 nodes, ≤ 500 projects per user;
  - HMAC-keyed rate limits;
  - login lockout.
- **Sign-up and email:** sign-up is pending until the email link is opened, and only token hashes are stored (`signup.ts`, `emails.ts`, SES `mailer.ts`).

**Local and offline tools:**
- `scripts/mock-api.mjs` (`npm run mock-api`) runs the real handlers against the memory store with a fake S3 on `127.0.0.1:8787`. Flags: `--seed`, `--persist`, `--legacy`. Point the app at it with `npm run dev:mock` or `?api=`.
- `npm run test:lambda` runs the handler tests.
- `infra/test/synth-check.ts` synthesises both stacks offline.

Deploy steps are in [RELEASE.md](RELEASE.md).

## MCP server, WebSocket bridge, IO bridge (`mcp/`)

### MCP server

`mcp/server.mjs` is a stdio MCP server that lets an agent drive the real app. `mcp/cli.mjs` runs the same tool handlers from a shell, headless by default, with images written to files. All logging goes to stderr.

**`PatchToySession`** (`lib/session.mjs`):
- Owns the bridge, the `ProjectStore` and any Vite or Chrome it launched (`lib/launcher.mjs`).
- Serialises tool calls (`exclusive()`).
- `withProject()` loads the project in the chosen page, runs the tool, and for mutating tools saves the page's graph back to disk. An operation is retried once if the page disconnects.

**Tools** (`lib/tools.mjs`, plus `midiTools`, `ioTools` and `render3dTools`): 47 tools, each `{name, inputSchema (zod), annotations, handler}`. Page-side commands live in `src/automation/AutomationAPI.js`. Each command runs as one undo batch, with `alert` / `confirm` / `prompt` stubbed during the call.

**Projects on disk** (`lib/projects.mjs`):
- Files are `projects/<slug>.patchtoy.json`, written atomically.
- The active project is kept in `projects/.mcp-state.json`.
- Before an agent replaces a live tab's graph, it is backed up to `projects/.backups/`.

**`save_path` confinement:** paths must be inside the repo, the temp directory or `PATCHTOY_SAVE_DIRS`, and are checked after resolving symlinks. Hidden folders and `node_modules` are refused. Recordings default to `exports/`.

### WebSocket bridge

The server is `lib/bridge.mjs`; the page side is `src/automation/BridgeClient.js`.

**Connection:**
- The bridge listens on `127.0.0.1` only and accepts an exact-origin allowlist (`lib/auth.mjs`).
- The first frame must be a hello carrying a token, within 5 s. Tokens are compared in constant time.
- The server proves itself with an HMAC of a nonce.
- Frames are limited to 64 KB before authentication. Large results are sent in chunks.
- Heartbeat every 15 s.

**Client roles:**
- `headless`: a per-launch token;
- `live`: the user's tab, paired with the pairing token;
- `automation`: webdriver pages, or pages served by a private dev server.

In auto mode the user's visible live tab wins; automation pages are used only when selected explicitly.

**Pairing through Vite** (`vite.config.js`):
- `GET /__patchtoy/bridge-probe?port=N` hands the token from `node_modules/.cache/patchtoy-mcp/bridge-<port>.json` to same-origin loopback requests only.
- Each dev server registers `devserver-<pid>-<port>.json` with its role (`private` when HMR is off).
- Production builds need `localStorage.patchtoyBridge = 'on'` and a pairing URL.

### IO bridge

`lib/io-bridge.mjs`, CLI `scripts/io-bridge.mjs` (`npm run io-bridge`). A separate local process for what browsers can't do:
- OSC over UDP, in and out (`lib/osc.mjs` codec);
- serial, through the optional `serialport` package, with mock ports for tests;
- Art-Net / DMX out.

MIDI out uses Web MIDI directly (`src/io/MIDIOutput.js`).

**Protocol:** WebSocket on `127.0.0.1:7879`. `hello {token}` → `welcome` → `config {optIn, allow, serial, lan}`, then ops (`osc.listen`, `osc.send`, `serial.open`, `serial.write`, `artnet.send`, ...).

**Security:**
- Loopback Host check (DNS rebinding) and the same origin policy as the MCP bridge.
- A 144-bit token, with a lockout after repeated failures.
- **Opt-in:** nothing is sent, opened or listened to until the tab has opted in (per tab session).
- **Allowlist:** outbound sends must match the `host:port` allowlist (`src/io/allowlist.mjs`, shared by app and bridge). The allowlist lives in localStorage, never in project files, so a shared patch cannot add destinations.
- OSC In binds loopback unless LAN is enabled.
- Rate and size limits on every channel.

**App side:** `src/io/IOClient.js`, `IOPanel` (Output > I/O) and `library/io.js` (OSC In / Out, Serial In / Out, Art-Net Out, MIDI Out CC / Note). The IO nodes are control-rate nodes and show a status line.

## Test suite

`npm test` (`scripts/test.mjs`) runs these stages in order:

| Stage | Command | Covers |
|---|---|---|
| definitions | `scripts/check-definitions.mjs` | No browser. Every definition's category, ports and description; `glsl()` with mock inputs including generic types; balanced code with no `undefined`; `pt_*` references resolve; JS twins run. |
| e2e | `mcp/test-e2e.mjs` | The MCP server end to end over stdio, against a scratch projects dir: building, compiling, errors with node attribution, rendering, audio and textures, bridge security and robustness, IO bridge round trips, MIDI, recording, output. |
| history | `scripts/e2e-history.mjs` | Undo / redo. |
| stability | `scripts/e2e-stability.mjs` | Regressions from the review: project reset and switch, races, device permissions, export reproducibility, ... |
| visual | `tests/visual/run.mjs` | Renders every demo project and compares it with goldens, plus a compile check per project. |
| build | `vite build` into a temp dir | The production bundle builds. |

**Runner:**
- One private Vite dev server (`tests/lib/vite-server.mjs`): a free port that is never 5173, 5200 or 7878, with HMR and the file watcher off, so it registers as "private". All browser stages share it, and it is shut down at the end.
- Options: `--only`, `--skip`, `--bail`; `--update-goldens`, `--tolerance`, `--set` and `--max-warmup` are passed to the visual stage.

**Visual goldens** (`tests/visual/`):
- **Rendering:** 480×300 JPEGs in `golden/`, plus a `manifest.json` holding the SHA-256 of each raw render and a platform key.
- **Determinism** (`config.mjs`):
  - metronome at 120 BPM, UTC;
  - a 90-frame warm-up at 60 fps with seed 1;
  - frames at t = 2.05 s and 5.3 s;
  - per-project overrides.
- **Comparison:** exact SHA match on the same platform. Elsewhere, tolerance profiles (default, text, feedback, structural) compare against each golden's own JPEG error.
- **Golden sets:** `--set linux` uses `golden-linux/`.
- **Diffs** go to `tests/visual/out/`.
- **Regenerating:** `npm run test:visual:update` or `npm test -- --only visual --update-goldens`. Regenerate only for intended visual changes.

**Outside `npm test`:**
- `npm run test:community`: headless sign-up, save, publish, fork and user pages against the mock API.
- `npm run test:lambda`: backend handler tests.
- `scripts/perf.mjs`: fps, CPU / GPU per phase, compile time, GL memory; `--leaks`.

**CI** (`.github/workflows/test.yml`): Ubuntu with SwiftShader. Visual tests are non-blocking until a Linux golden set exists.

## Extending PatchToy

### Add a library node

Add a `libNode()` entry to the right `src/core/library/*.js` module:

```javascript
'Clamp': libNode({
    category: 'math',
    description: 'Limits x to the range [min, max].',
    inputs: [
        { name: 'x', type: 'T', default: '0.5' },
        { name: 'min', type: 'T', default: '0.0', scalar: true },
        { name: 'max', type: 'T', default: '1.0', scalar: true }
    ],
    outputs: [{ name: 'out', type: 'T' }],
    expr: I => `clamp(${I.x}, ${I.min}, ${I.max})`,
    js: I => map3(I.x, I.min, I.max, clamp)   // optional CPU twin: allows control rate
}),
```

It appears in the library panel and quick search automatically (`src/ui/nodeCatalog.js`). Then run `node scripts/check-definitions.mjs`.

**Other definition fields:**
- Effects should use `effectNode()` to get the `amount` input.
- Shared GLSL goes into `library/glsl.js` as a `pt_*` function.
- New built-in uniforms go into `src/core/builtinUniforms.js`; they are then declared automatically wherever they are used, and the renderers must set them.

### Hand-written definitions

Hand-written definitions in `NodeDefinitions.js` use the raw form:

```javascript
{ category, description, inputs, outputs, glsl: (node, inputs, compiler) => ({ code, output, uniforms?, preamble?, requiresFunction? }) }
```

- `requiresFunction` emits `definition.glslFunction` once per shader.
- Structs are registered with `TypeRegistry.registerStruct(name, members)`.
- A node needing its own canvas UI or runtime gets a class in `src/nodes/`, selected by a definition flag in `NodeFactory`.

### Custom GLSL nodes

Custom GLSL nodes need no code changes: write a GLSL function with `@node` / `@input` comments in the app's code editor (see README).
