# PatchToy MCP server

An [MCP](https://modelcontextprotocol.io) server that lets an AI agent (Claude Code, Claude Desktop, any MCP client) **create, view, edit, compile and render PatchToy projects** on its own.

It doesn't re-implement the node graph in Node.js. It drives a **running instance of the real app** over a local WebSocket bridge, so dynamic ports (Blend, ForLoop, polymorphic math nodes), custom GLSL nodes, real WebGL compile errors and rendering all behave exactly as they do for a user.

```
 MCP client (Claude)  ──stdio──►  mcp/server.mjs ──ws://127.0.0.1:7878──►  PatchToy page
                                     │                                     src/automation/BridgeClient.js
                                     │                                     src/automation/AutomationAPI.js
                                     ├── projects/<slug>.patchtoy.json  (source of truth, auto-saved)
                                     └── auto-launch: Vite dev server + headless Chrome (playwright-core)
```

## Setup

```bash
npm install          # installs @modelcontextprotocol/sdk, ws, zod, playwright-core
```

Requirements: Node 18+ and Google Chrome (or set `PATCHTOY_CHROME_PATH` to a Chrome/Chromium binary). No Playwright browser download is needed.

### Claude Code

The repo ships a project-scoped `.mcp.json`, so starting `claude` in the repo root offers to enable the **patchtoy** server (approve it once). Check it with `claude mcp list`. To register it by hand:

```bash
claude mcp add patchtoy -- node /absolute/path/to/PatchToy/mcp/server.mjs
```

### Other MCP clients

Run `node mcp/server.mjs` as a stdio server (absolute path recommended). All paths are resolved relative to the script, so the working directory doesn't matter.

### Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `PATCHTOY_URL` | `http://localhost:5173` | App URL. If nothing answers there (and it's local), the server starts Vite (`vite --port <port> --strictPort`) from the repo root and stops it on exit. An already-running dev server is reused. |
| `PATCHTOY_BRIDGE_PORT` | `7878` | WebSocket bridge port (`0` = random). If 7878 is taken (e.g. a second Claude session), a random port is used and live mode is unavailable for that instance. |
| `PATCHTOY_CLIENT_MODE` | `auto` | `auto` (prefer the user's tab), `live` (only the user's tab) or `headless` (never touch the user's tab). |
| `PATCHTOY_CHROME_PATH` | system Chrome | Browser executable for headless mode. |
| `PATCHTOY_CHROME_ARGS` | – | Extra space-separated Chrome flags for headless mode (CI: `--use-angle=swiftshader`). |
| `PATCHTOY_HEADED` | unset | `1` shows the auto-launched browser window. |
| `PATCHTOY_PROJECTS_DIR` | `<repo>/projects` | Where project files live. |
| `PATCHTOY_AGENT_NAME` | `Claude` | Name used in the app's activity messages ("Claude added Noise node"). |
| `PATCHTOY_ALLOWED_ORIGINS` | – | Extra comma-separated page origins allowed to connect to the bridge (exact origins, e.g. `https://patchtoy.example`). By default only the `PATCHTOY_URL` origin and the PatchToy dev servers running from this repo are accepted; see [Security](#security). |
| `PATCHTOY_SAVE_DIRS` | – | Extra comma-separated folders `save_path` may write to (default: the repo, the temp folder). |
| `PATCHTOY_MCP_DEBUG` | unset | `1` forwards headless page console errors to stderr. |

Logs go to **stderr** only; stdout is the MCP channel.

## Live mode vs headless mode

**Live mode.** Open the app from the Vite dev server of this repo (`npm run dev`, any port) while the MCP server is running. Dev tabs pair with the server by themselves: the page asks its own dev server (same-origin `/__patchtoy/bridge-probe`) for the server's per-run pairing token and connects to `ws://127.0.0.1:7878` (`?bridge=PORT` for another port). See [Pairing your own tab](#pairing-your-own-tab) for other setups. Tools then operate in **your tab**, and you watch the agent build the graph in real time. Each edit fires `patchtoy:activity` events ("Claude connected UV → Sin") and the connection state fires `patchtoy:bridge-status`. Edits you make by hand in that tab (moving nodes, tweaking values) are synced back to the project file. Before the agent opens a project in your tab, your previous unsaved graph is backed up to `projects/.backups/`.

**Headless mode.** If no browser tab is connected, the first tool call that needs the app starts Vite if needed, then a headless Chrome on `<url>?bridge=<port>&headless=1`. Startup takes about 1 to 3 seconds. WebGL works headless (ANGLE/Metal on macOS, SwiftShader fallback elsewhere). `select_client {"mode":"headless"}` forces this mode even when your tab is open.

Selection order in `auto`: live tabs on `PATCHTOY_URL`'s origin first, then tabs of the other regular dev servers of this repo, then any live tab (most recently visible first within each), then the headless page (auto-launched on demand). `get_status` shows every connected client with its `origin` and `role` and which one is the current target, plus the registered dev servers.

Pages driven by tests or other agents never become the live target: a paired page that reports `navigator.webdriver` (Playwright, Puppeteer, WebDriver) or is served by a **private** dev server (HMR off, as `tests/lib/vite-server.mjs` starts them, or `PATCHTOY_DEV_ROLE=private`) gets role `automation`. Such pages are never picked by `auto` / `live` / `headless`; `select_client {client_id}` can still target one explicitly. `PATCHTOY_DEV_ROLE=dev` makes an HMR-off server count as a regular one.

Disable the bridge in a dev tab with `?bridge=off` or `localStorage.patchtoyBridge = 'off'`. Production builds never load it from a link: see the opt-in below.

### Pairing your own tab

- **Dev server from this repo (the usual case): nothing to do.** Start the MCP server (Claude Code via `.mcp.json`, `npm run mcp`, or `node mcp/cli.mjs --live ...`), keep or open `http://localhost:<dev port>/`. Within a few seconds the tab shows the MCP pill. The server writes its token to `node_modules/.cache/patchtoy-mcp/bridge-<port>.json` (mode 0600, removed on exit), and `vite.config.js` gives it only to same-origin pages on a loopback host. Each running dev server also registers its origins there, so the bridge accepts tabs from it whatever `PATCHTOY_URL` says.
- **Anything else (another checkout, a fixed port, a build):** call `get_status` and open its `pair_url` (`<PATCHTOY_URL>?bridge=<port>&bridgeToken=<token>`). The page keeps the token in `sessionStorage` for reloads and removes it from the address bar. The page's origin must be allowed (`PATCHTOY_URL` or `PATCHTOY_ALLOWED_ORIGINS`).
- **Production build:** first run `localStorage.patchtoyBridge = 'on'` in that tab's devtools console, then open the `pair_url`. Without the opt-in a production page ignores `?bridge`.
- The token changes every time the MCP server starts. Dev tabs fetch the new one on their own; a tab paired with a `pair_url` needs the new URL (it stops retrying when the server refuses its token).
- Headless-only sessions (`PATCHTOY_CLIENT_MODE=headless`, the CLI without `--live`, the tests) do not accept live tabs at all; `select_client {"mode":"auto"}` turns pairing on.

## Security

The bridge lets a page run commands for the agent and lets the agent write files, so it only talks to pages it can authenticate:

- It listens on `127.0.0.1` only.
- **Origin allowlist.** Browser handshakes must come from the `PATCHTOY_URL` origin, a PatchToy dev server registered from this repo, or `PATCHTOY_ALLOWED_ORIGINS` (exact origins; loopback origins also match their `localhost` / `127.0.0.1` / `[::1]` aliases). Other localhost sites (Storybook, Jupyter, a downloaded HTML file) get HTTP 403. Rejections are logged to stderr (rate-limited).
- **Token.** The first frame must be a `hello` with a valid token: the per-launch token of the headless page the server opened, or the per-run live pairing token. Wrong, missing or late (5 s) tokens are closed with code 4401 and logged. Only pages with the headless token count as headless.
- **Server proof.** The page sends a random nonce; the `welcome` must carry `HMAC-SHA256(token, "patchtoy-bridge-v1:" + nonce)`, so a page never runs commands from another program listening on the port. Failed connections back off exponentially (0.5 s to 30 s) and stop after 8 attempts; focusing the tab retries.
- **One owner per project.** Only the tab that last loaded or saved a project file may write it. When the agent opens a project in another tab, the previous tab is detached; a duplicated tab or a tab with an older copy has its edits ignored and is detached. Client ids are per page load, so duplicated tabs don't knock each other off.
- **File names.** Export names coming from the page are reduced to a safe basename (`[A-Za-z0-9._-]`, forced `.webm` / `.mp4` / `.zip` extension) inside `exports/`. `save_path` must stay inside the repo, the temp folder or `PATCHTOY_SAVE_DIRS` after resolving symlinks, may not enter hidden folders or `node_modules`, and gets the file type's extension. `set_audio` only reads audio files outside hidden folders. Project files are named by slug only.
- **Frame limits.** Until its `hello` authenticated, a connection may only send frames of 64 KB (bigger: closed with 1009). Authenticated pages split results over 1 MB into `chunk` frames; the server reassembles up to 512 MB of JSON (about 380 MB of exported file). A bigger result fails that one call with a size error and is not retried.
- **Heartbeat.** The server pings every 15 s and drops a page that missed two pongs (sleeping laptop, crashed renderer), so calls fail fast instead of waiting for their timeout. In `auto` mode a live tab hidden for over 30 s loses to the headless page (background tabs throttle rendering).
- **One command at a time.** Pages run commands in arrival order, one at a time (`stopRecording` excepted, so it can cancel an export), and put the page's own `alert` / `confirm` / `prompt` back whenever no command runs.
- The I/O bridge (`npm run io-bridge`) uses the same Origin policy (its `--app` URL, this repo's dev servers, `--origin`) plus its own pairing token.
- Shared helpers (tokens, origin policy, safe paths, per-connection frame limits) live in `mcp/lib/auth.mjs`.

## Projects on disk

`projects/<slug>.patchtoy.json` uses the same format as the app's **Download project** file, plus `name` and `description`:

```json
{ "name": "Plasma", "description": "...", "version": "1.0", "timestamp": "...",
  "graph": { "nodes": [...], "connections": [...], "nextNodeId": 9, "panX": 0, "panY": 0, "zoom": 1 },
  "customNodes": { "ValueNoise": { "customGLSL": "...", "inputs": [...], "outputs": [...] } },
  "editorStates": [] }
```

The file on disk is the source of truth. Every mutating tool loads the project into the target page if needed (through the app's own `ProjectManager.loadProjectFromFile`, so custom nodes get registered), applies the edit, and writes the result back before returning. You can also open these files in the app with **Load local file**. The project's custom GLSL nodes are stored inside it.

## Tools

| Tool | What it does |
|---|---|
| `get_status` | Bridge port, connected tabs (live/headless) and which one is targeted, active project, app URL. |
| `select_client` | Target `auto` / `live` / `headless`, or a specific `client_id`. |
| `list_projects` | Projects in `projects/` with node counts; marks the active one. |
| `create_project` | `{name, description?, template?: "empty"\|"basic"}`: creates the file, makes it active and opens it. `basic` = UV + Time → Vec3 → Preview. |
| `open_project` | `{name}`: makes a project active and loads it in the app. |
| `get_project` | `{name?}`: concise graph: nodes `{id,type,x,y,w,h,data,inputs:["x:float <- 3.uv.x"],outputs:["out:vec3"]}` and connections `"3.uv.x -> 5.x"`. With node groups: each node's `group`, `groups[]` and `root_nodes`. |
| `delete_project` / `duplicate_project` / `rename_project` | File management. |
| `list_node_types` | `{category?, search?, include_glsl?}`: node types read live from the app, with ports, defaults, editable data, descriptions and notes (dynamic inputs, polymorphic types, pairing, device needs). Includes custom nodes. |
| `add_node` | `{type, x?, y?, data?}`: auto-placed to the right if no coordinates. Returns id + ports (+ `pair` for ForLoopStart). |
| `remove_node` | `{id}` |
| `set_node_data` | `{id, data}`: merges data (Float `value`, Vec `x/y/z/w`, `useUniform`, Color `r/g/b` or `hex`, UV `mode`, Map ranges...). Library nodes also take inline values for any unconnected input, keyed by input name: a number, `[x, y(, z, w)]`, a GLSL literal like `"vec3(1.0, 0.5, 0.0)"` or `true/false` for bool inputs (`null` restores the default). Uses the same recompile/uniform path as the UI: uniform-mode constants and live sources (XYPad, Keyboard, MidiNote) only update the uniform. Unknown fields and invalid values are rejected with the valid list. |
| `move_node` | `{id, x, y}` |
| `connect` | `{from_node, from_output?, to_node, to_input?, accessor?}`: ports by name or index. Uses the app's type validation; replaces existing input connections; grows Blend/ForLoop inputs; rejects cycles. Errors list the valid ports, and warnings flag type problems early. |
| `disconnect` | `{to_node, to_input?}` or `{from_node, from_output?}` |
| `create_custom_node` / `update_custom_node` | `{name, glsl, force?}`: GLSL function → node via the app's `createCustomNode`. The code is compile-checked first, with line-numbered errors. |
| `build_graph` | `{nodes:[{key,type,x?,y?,data?}], connections:[{from:"key.output[.swizzle]", to:"key.input"}], clear?, layout?, groups?:[{key,name,nodes:[node keys/ids or group keys/ids],parent?,color?}]}`: batch-builds a graph (optionally organized into node groups; `group_ids` maps keys to ids), auto-layouts it and compiles. Node data / connection failures don't abort the build but make the top-level `ok` false. Returns `{ok, error?, ids:{key:id}, errors?, warnings?, compile}`. |
| `compile` | `{name?, include_source?}`: per Preview: ok, compiler errors and warnings, WebGL errors with line, offending code and the generating node, uniforms, and optionally the fragment shader. `feedback: [{id, ok, errors, glsl_errors?}]` reports each Feedback node's pass (a separate shader); a failing pass makes `ok` false. |
| `render_preview` | `{preview_id?, node_id?, output?, width?, height?, time?, beat?, beat_phase?, bpm?, mouse?, save_path?, scene?, scene_from?, progress?, transition?, scene_node?}`: PNG of a Preview (or of any node's output) at a given size and `u_time`, plus pixel stats (`blank`, mean color, luma range). `beat` (in beats, e.g. `4.5`) or `beat_phase` (0..1, plus an optional integer `beat`) pins the beat clock. `u_beat`, `u_beatPhase`, `u_barPhase`, `u_beatCount`, `u_beatTime`, `u_beatConfidence` (1), `u_beatTrust` (1), `u_beatRaw` (= the pinned clock) and the audio values (`u_kick`, `u_bass`, ... from the metronome groove) are then deterministic. `u_time` follows the beat unless `time` is given. `bpm` defaults to the metronome tempo. Without `beat`, the beat values are derived from `time`, so renders are reproducible either way. SceneSwitcher: `scene` pins a scene, `{scene_from, scene, progress, transition}` pins a transition frame (`progress` = eased 0..1; `scene_node` picks the switcher). |
| `screenshot_editor` | `{fit_view?, save_path?}`: PNG of the editor (full page screenshot when headless; node-canvas capture in a live tab). |
| `auto_layout` | `{name?, fit_view?}`: left-to-right by dependency depth, crossing-reduced, no overlaps. With groups, every scope (root and each group) is laid out on its own, with group boxes as nodes of their parent scope; Comment notes go in a row above their scope. |
| `undo` / `redo` | `{steps?, name?}`: the app's undo history, shared with the user's ⌘Z / ⇧⌘Z. Every mutating tool call is one step (`build_graph` included, labelled "Claude: Build graph"); the user's own edits are steps too. Returns the undone / redone labels and the next ones. Loading / creating a project clears the history. |
| `history` | `{limit?, name?}`: undo / redo step labels, newest first, plus counts and memory use. |
| `set_background_preview` | `{preview_id \| null}`: the app's "preview as background" toggle. |
| `group_nodes` | `{name, node_ids, parent_group?, color?}`: put nodes and/or groups (ids like `"g3"`) into a new node group. Groups are view metadata: compilation is unchanged. Returns the group with its synthesized box ports. |
| `ungroup` | `{group_id}`: dissolve a group (id or name); its members move to the parent scope. |
| `rename_group` | `{group_id, name}` |
| `rename_group_port` | `{group_id, port?, label?, ports?}`: name a group box port (shown on the box and on the inside "From outside" / "To outside" rows) instead of the automatic "Add.a"-style name. `port` = key from `list_groups` `port_keys` (`s:<src>:<out>`, `x:<node>:<in>`, `o:<node>:<out>`), `in:N` / `out:N`, or its label; `label: ""` restores the automatic name; `ports: {port: label}` renames several. Saved with the project (`portLabels`), undoable. |
| `list_groups` | `{name?}`: `[{id, name, parent, nodes, children, node_count, inputs, outputs, x, y}]` plus `root_nodes`. |
| `set_audio` | `{mode: "metronome"\|"file"\|"off", bpm?, url_or_path?, play?, loop?, offset_ms?, locked?}`: what drives the global audio / beat uniforms and the Audio / Beat / BeatEnvelope nodes. `metronome` is a fixed `bpm` (default 120), needs no audio and works headless. `file` plays an http(s) URL, or a local audio file that the server reads and sends to the page (≤ 60 MB, relative paths resolve from the repo root), and tracks its beat. `off` stops the analysis, and the beat clock free-runs (`bpm` sets its tempo). Returns the audio status. The beat uniforms / nodes follow a *stable* published clock: while the tracker's estimate is untrusted (a track change) it coasts at the last trusted tempo, then glides to the new one without phase jumps; `u_beatTrust` (Beat → `gate`) says how far it can be relied on, and `u_beatRaw` is the raw estimate. Without live audio (metronome / off) nothing changes. |
| `list_params` | `{name?}`: the Param nodes as the Parameters panel shows them: `sections:[{name, params:[{id, label, kind, value, default, min, max, step, scale, options, selected, alpha, hex, description, outputs, group}]}]`. |
| `set_param` | `{node_id? \| label?, value}`: set a Param's value (live uniform, never recompiles). The value follows the kind: number, `true/false`, `[x, y(, z, w)]`, `"#rrggbb"` or `[r, g, b(, a)]`, option index or name (enum), image URL / data URL (image); a trigger fires with `true` / `"press"`. |
| `list_scenes` | `{name?}`: every SceneSwitcher: scenes `[{index, name, connected, transition?, duration?}]`, `current`, the running `transitioning` `{from, to, style, progress, eased}`, `evaluated` (the scenes the shader runs now), defaults (transition, duration, easing, angle / softness / strength), auto mode, playlist, the ScenePresence nodes per scene and the scene-owned Feedback passes (`running`). Also lists the transition styles. |
| `set_scene` | `{node_id?, scene, transition?, duration?, instant?}`: transition to a scene (index, name or `next` / `prev`); `transition` / `duration` override this switch. Live uniforms, never recompiles. |
| `get_audio_status` | Source, tempo (`bpm` = the stable published clock's tempo, `detected_bpm` = the tracker's, `confidence` = `u_beatConfidence`: 0 no beat / coasting, ~0.5 tentative, ~1 locked; `locked`; under `clock`: `beat_trusted`, `beat_trust` = `u_beatTrust`, `beat_state` lock / glide / coast / direct of the stable published clock and `raw_bpm` of the tracker's estimate), beat position (`count`, `phase`, `bar_phase`), band levels, A/V offset, latency, file transport (`name`, `playing`, `position`, `duration`) and the list of audio uniforms. |

### Render 3D (meshes, glTF)

- `load_model {path | url, node_id?, name?, x?, y?, connect?, fit?}`: loads a glTF 2.0 model (.glb, or .gltf with embedded data) into a Model node: a new one wired into the first Render 3D node (a Render 3D + Preview are created when there is none), or `node_id`. `path` is read by the server and confined like `save_path` (the repo, the temp folder, `PATCHTOY_SAVE_DIRS`, `PATCHTOY_MODEL_DIRS`; no hidden folders, no symlinks; .glb / .gltf only, at most 64 MB). Returns the model summary (meshes, primitives, triangles, joints, clips, bounds, warnings). Draco / meshopt files are rejected with a clear message.
- `get_project` adds `render3d` to Render 3D nodes (render size, MSAA, draws, instances, triangles, points, shadow, CPU ms, objects with their instance counts, lights) and `model` to Model nodes. `compile` adds a `render3d` report per Render 3D node (a failing program fails the compile). `build_graph` may connect to any `itemN` of a Render 3D node (missing items are created).
- `render_preview` renders Render 3D nodes at the requested size (in `size: 'auto'`) and at the pinned time; it waits for models that are still loading.

### Param nodes (the Parameters panel)

A `Param` node is a UI parameter: every Param in the patch (any group) is listed in the editor's Parameters panel (top bar sliders button, `P`), grouped by `section` and sorted by `order`. Everything lives in node data, so it is saved with the project:

`label` (pretty name), `kind` (`float` `int` `bool` `vec2` `vec3` `vec4` `color` `enum` `trigger` `image`), `value`, `default` (double-click a slider to reset), `min`/`max`/`step` + `scale` (`linear`/`log`), `options` (enum), `alpha` (color → vec4), `section`, `order`, `description` (tooltip), and for images `wrap` / `filter`.

Outputs follow the kind: `value` (float/int/vecN; bool → `value` float 0/1 + `on` bool), `color` (vec3 or vec4), `index` (enum, int), `pulse` / `count` / `since` (trigger: 1 for one frame per press, press count, seconds since the last press) and `tex` (image, sampler2D). Values are live uniforms: `set_param` and `set_node_data {value}` never recompile, `set_node_data {kind}` does.

```json
{"nodes": [{"key": "speed", "type": "Param", "data": {"label": "Speed", "kind": "float", "min": 0, "max": 4, "value": 1, "section": "Motion"}},
           {"key": "tint", "type": "Param", "data": {"label": "Tint", "kind": "color", "value": "#ff8800", "section": "Look"}}]}
```

### MIDI mappings (MIDI learn)

In the Parameters panel each Param row has a MIDI learn button (click it, move a knob or press a key; the row then shows a badge such as `CC 21 · ch1` or `Note C3 · ch10`, click it for options), the header has a learn mode (click a row or a scene button, touch a control, repeat; Esc ends), and scene buttons / previous / next are learnable too (right-click). Mappings are saved in node data (`data.midi`, with channel and device name, so they survive reconnects); MIDI-driven values are not undo steps, creating / editing / removing a mapping is.

| Tool | Arguments / result |
|------|--------------------|
| `midi_map` | `{param \| scene_node + action ('scene' + scene, 'next', 'prev', 'select'), type: cc\|note\|pitchbend\|aftertouch, number (CC, or note 60 / 'C3'), channel (1-16, 0 = any), device?, options?, add?, learn?}`. Options: `target` (vecN `x`/`y`/`z`/`w`, color `hue`/`sat`/`bright`/`r`/`g`/`b`/`a`, enum `value` = CC buckets / `option` + `option` index / `step`), `mode` (`absolute`, `relative-2c`, `relative-64`, `relative-sb`), `pickup` (soft takeover, default on for absolute CCs), `invert`, `min` / `max` (range trim), `slew` (seconds), `press` (`toggle` / `momentary` / `velocity`), `hires` (14-bit CC n + n+32), `sens`, `feedback` (MIDI out echo). `learn: true` arms MIDI learn: the next message is mapped. |
| `midi_unmap` | `{param \| scene_node, id?, type?, number?, channel?, action?, scene?}`: remove all / the matching mappings. |
| `simulate_midi` | `{status, data1, data2}` or `{messages: [[status, data1, data2], ...], device?, wait_ms?}`: feed bytes as if a controller sent them (no Web MIDI headless). Returns `effects` and the touched nodes. |

`list_params` shows `midi: [{id, type, number, note, channel, device, target, mode, pickup, picked_up, pickup_waiting, ..., label}]` per mapped Param, `list_scenes` the switcher mappings.

```json
{"param": "Speed", "type": "cc", "number": 21, "channel": 1, "options": {"slew": 0.2}}
{"messages": [[176, 21, 0], [176, 21, 64], [176, 21, 127]]}
```

### Scenes (SceneSwitcher, ScenePresence)

A `SceneSwitcher` shows one of its scene inputs (`'0'`, `'1'`, ...; connecting the free last input adds a scene, a scene name also works as `to_input`) and transitions between two of them. Each scene's exclusive upstream sub-graph is compiled into its own GLSL function (`vec4 node_S_s<i>()`); `node_S_run()` calls one or two of them in a loop whose bounds are uniforms, so only the shown scene runs (two during a transition) whatever the scene count. Values the rest of the pass computes anyway are shared through globals; position-dependent nodes (UV, noise at the pixel...) are evaluated inside the scene so transitions can sample a scene at moved coordinates (zoom, push, pixelate, displacement). Feedback passes used only by hidden scenes are skipped (Feedback `data.keepRunning: true` keeps a simulation running).

data: `scenes` (names or `{name, transition?, duration?}` - per-scene entrance), `current`, `transition` (`cut crossfade dissolve wipe iris zoom push slide luma displace pixelate self self-add sequential custom`), `duration` + `durationUnit` (`seconds` | `beats`), `easing`, `angle` / `softness` / `strength`, `auto` (`off` | `bars` | `seconds` | `music` = bars while music or the metronome drives the beat clock, else seconds), `autoBars`, `autoSeconds`, `playlist`. The selection is CPU-side: `set_scene`, `data.current`, the Parameters panel (Scenes section), keys 1-9, the node's number tags, the `scene` input (a Param / JS / Float value) and the `next` input (rising value, e.g. a Param trigger).

`ScenePresence` inside a scene outputs that scene's `presence` (0 hidden .. 1 shown, eased over the transition), `phase` (-1 -> 0 entering, 0 -> 1 leaving) and `leaving`; the scene is found by graph reachability. Wire it into effect `amount` inputs (0 = identity) for per-scene entrances and exits. `TransitionInput` (a, b, progress, uv) builds a custom transition sub-graph for the switcher's `transition` input (style `custom`). Example: `projects/scene-medley.patchtoy.json`.

### Control rate (LFO, Lag, Counter, Beat Divider, Sample...)

Ports have a **rate**. *pixel* ports compile into GLSL (per pixel); *control* ports are computed once per frame in JavaScript before rendering and may keep state; their values reach shaders as live uniforms (`node_<id>_c<k>`), so they never recompile.

- `list_node_types {category: "control"}` lists the Control group (LFO, Lag, Slew, Spring, Trigger, Counter, Timer, SampleHold, Toggle, Threshold, EnvelopeFollower, RandomValue, Delay, Gate, SelectIndex, MathExpression, BeatDivider, Sample, TextPick, NumberList, TextTexture, ListTexture). Each type reports `rate` (`control`, `inferred` for math with a JS twin, `control source` for Param / JS / MIDI / Keyboard...) and `options` (enumerated data fields such as LFO `shape: sine|tri|saw|square|random`, `unit: hz|beats`).
- `get_project`: every node has `rate` (`pixel` | `control` | `free` = a CPU constant compiled inline), `port_rates` when not all pixel, and for nodes evaluated in JS `control: {values, compiled_as_uniforms, events_fired?, error?}`; the graph has `control_rate: {nodes, evaluated_per_frame, live_uniforms, eval_ms, compile_count, violations?}` (`compile_count` lets you check that animating a control value never recompiles).
- `connect` / `build_graph` reject **pixel -> control** (`... is a control-rate input and UV #3 is computed per pixel (pixel values live on the GPU: use a Sample node ...)`), event / string / list outputs into shader inputs (use TextTexture / ListTexture, or Counter / Toggle / EnvelopeFollower for events), and control loops without a **Delay** (a Delay's `in` is read one frame late, so loops through it are fine).
- Rate inference: math / vector / logic nodes (and Beat, Audio, BeatEnvelope, Vec2/3/4, Map...) run at control rate when every connected input is a CPU value; one pixel input makes them GLSL again. Events read as numbers (pulses this frame) in math; numbers drive event inputs by their rising edge.
- `render_preview {time | beat}` evaluates the control graph at the pinned time (stateless nodes are exact; stateful ones report their current value).
- SceneSwitcher `scene` / `next` are control-rate inputs. JS nodes declare control inputs in code: `// @input speed float = 1` (types float int bool vec2 vec3 vec4 event string list), read as `speed` / `inputs.speed`; JS outputs may be strings, `list(array)` and `event(fired)`.

```json
{"nodes": [{"key": "lfo", "type": "LFO", "data": {"rate": 0.25, "shape": "tri"}},
           {"key": "lag", "type": "Lag", "data": {"up": 0.5, "down": 0.5}},
           {"key": "bd", "type": "BeatDivider", "data": {"every": 4}},
           {"key": "cnt", "type": "Counter", "data": {"length": 3}},
           {"key": "sw", "type": "SceneSwitcher", "data": {"scenes": ["A", "B", "C"]}}],
 "connections": [{"from": "lfo.out", "to": "lag.in"}, {"from": "bd.beat", "to": "cnt.trig"}, {"from": "cnt.count", "to": "sw.scene"}]}
```

Example project: `projects/control-rate.patchtoy.json`.

### Audio textures

The audio source (`set_audio`) is also available as textures, for classic visualiser looks:

| Global sampler | Texture | Contents |
|---|---|---|
| `u_spectrum` | 512 x 1 RG16F | `r` = FFT magnitude in dB, auto-gained to 0..1 and smoothed; `g` = falling peak hold. `x` = frequency, log-spaced 30 Hz .. 16 kHz (`f = 30 * 533.3^x`). |
| `u_waveform` | 1024 x 1 R16F | The latest ~21 ms of samples, signed -1..1 (0 = silence), trigger-aligned on a rising zero crossing and auto-gained. |
| `u_spectrogram` | 256 x 256 R16F | A ring buffer of spectra (4 s, 64 rows/s). Row = `floor(u_time * 64) mod 256`, so read it with time on one axis: `texture(u_spectrogram, vec2(freq, (u_time - age) / 4.0 - 0.5 / 256.0))`, with `age` from 0 to ~3.95 s. |

Any GLSL (custom nodes, expressions) can use them without wiring. They are declared only when the code references them, and bound and uploaded only then, at most once per frame.

- **Audio Texture** (sources) outputs a texture with other options as `data`: `kind` (`spectrum` / `waveform` / `spectrogram`), `bins`, `scale` (`log` / `linear`), `smoothing`, `history` (2 / 4 / 8 s). Each distinct option set is one shared texture. Other outputs: `value` is the texture at the `uv` input (for a spectrogram, `uv.x` = time from 0 oldest to 1 now and `uv.y` = frequency), and `head` is the newest spectrogram row.
- **Spectrum Bars**, **Waveform Line** and **Circular Spectrum** turn a `tex` input (default `u_spectrum` / `u_waveform`) into anti-aliased bar masks with peak caps, an oscilloscope line with glow, or polar bars around a ring. Each has an `amount` input: 0 draws nothing, 1 is full height.
- **Sources.** Live input (mic, file, tab) reuses the beat tracker's FFT: while a shader uses a texture, the worklet also posts its power spectrum and a 1024-sample waveform. File sources pick the frame that is audible now, like `u_bass`. With the metronome, a deterministic synthetic mix (kick, bass line, chords, snare, hats) is evaluated at the beat clock, so `render_preview {beat}` gives the same textures every time, spectrogram history included. With audio `off`, the textures are zeros. While the clock is paused, they freeze.
- `get_audio_status` lists the bound textures under `textures`: mode, max / mean, upload count, `upload_bytes_last_frame`, and `program_links` (constant while nothing recompiles). Example: `projects/audio-textures.patchtoy.json`.

### JS nodes

A `JS` node runs JavaScript in the page every frame (double-click it to edit; one editor holds both blocks, split by `// @setup` and `// @frame`).

- `data.setupCode` runs once (async): `await loadScript(url)` loads a script tag; keep things in `state`.
- `data.code` runs every frame with `time`, `dt`, `frame`, `resolution` `[w, h]`, `mouse` `[x, y]` (0..1), `audio` (`level bass mid high kick beat beatPhase barPhase beatCount bpm beatTime confidence trust raw`; the beat values are the stable published clock, `trust` = `u_beatTrust`, `raw` = `[phase, bar phase, count, bpm]` of the tracker's raw estimate), `params` (Param values by label) and `state`. Helpers: `float int bool vec2 vec3 vec4 clamp mix damp(current, target, rate)`, plus `canvas texture dataTexture` for texture outputs.
- The return value defines typed output ports: a number → `out` float, `true` → bool, `[x, y, z]` → vec3, or `{ speed: float(v), hue: vec3(r, g, b) }` for named outputs. Values are pushed as live uniforms every frame; the graph recompiles only when the output names / types change. `get_project` shows `js: {status, values, recompiles, error, textures}`.
- Errors show on the node and in the shader console (each message once) and never stop the render loop.
- Trust: code set through MCP (and projects opened through MCP) counts as authored locally and runs. In the browser, a project (file, URL, gallery, cloud) whose JS code was not written in this browser asks once, "This project contains JavaScript nodes. Run them?"; until then the nodes show *paused*.

**Texture outputs (sampler2D).** Return a canvas, `texture(source, {filter, wrap})` or `dataTexture(array, width, height = 1, channels = 4)`:

- `canvas(w, h)` (in setup) makes a 2D canvas that is uploaded only on frames where something was drawn on it (or after `c.dirty = true`). Canvases made otherwise, and videos, are uploaded every frame. Canvas top = `v = 1`, like images.
- `dataTexture(...)` uploads a `Float32Array` or number array as an RGBA32F texture (RGBA16F, then RGBA8 clamped to 0..1, as fallbacks), NEAREST filtered, every frame. Element `i` (channels x, y, z, w; missing channels are 0, alpha 1) is texel `(i % width, i / width)`: read it in GLSL with `texelFetch(tex, ivec2(i, 0), 0)` for a `width × 1` texture (`texelFetch(tex, ivec2(i % W, i / W), 0)` in general), or with TextureSample at `uv = ((i + 0.5) / W, 0.5)`. Example: 21 hand landmarks × vec4 → `dataTexture(lm, 21, 1, 4)`.
- A texture's size and kind are part of the output signature (changing them recompiles; changing the content doesn't). Textures live in the app's shared GL context, so Preview, Feedback passes, the background preview and fullscreen can all sample them; they are freed when the node is deleted or another project is loaded.

Demo 1, **beat lyrics** (a new word on every beat, warped by a shader). JS node with
```js
// setup
state.c = canvas(512, 256);
state.g = state.c.getContext('2d');
state.words = ['FEEL', 'THE', 'BEAT', 'MOVE', 'YOUR', 'BODY'];
state.last = -1;
// frame
// A new word on every beat; the canvas is only re-uploaded on the frames it is drawn.
// While the beat clock is unsure (a track change: audio.trust low) the word holds.
if ((audio.trust ?? 1) < 0.5) return { words: texture(state.c), pulse: float(audio.beat) };
const n = Math.floor(audio.beatCount);
if (n !== state.last) {
  state.last = n;
  const g = state.g;
  g.fillStyle = '#000'; g.fillRect(0, 0, 512, 256);
  g.fillStyle = '#fff'; g.font = 'bold 132px sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(state.words[n % state.words.length], 256, 136);
}
return { words: texture(state.c), pulse: float(audio.beat) };
```
and `create_custom_node {name: "LyricWarp"}`:
```glsl
vec3 lyricWarp(vec2 uv, sampler2D words, float pulse) {
    vec2 p = (uv - 0.5) * (1.0 - 0.12 * pulse);
    p.x += 0.03 * sin(p.y * 18.0 + u_time * 3.0);
    p.y += 0.02 * sin(p.x * 11.0 - u_time * 2.0);
    vec2 q = p + 0.5;
    float off = 0.006 + 0.02 * pulse;
    vec3 ink = vec3(texture(words, q + vec2(off, 0.0)).r, texture(words, q).g, texture(words, q - vec2(off, 0.0)).b);
    vec3 bg = mix(vec3(0.05, 0.02, 0.1), vec3(0.25, 0.05, 0.2), uv.y);
    return bg + ink * vec3(1.0, 0.85, 0.6) * (0.8 + 0.6 * pulse);
}
```
wired `UV.uv → LyricWarp.uv`, `JS.words → LyricWarp.words`, `JS.pulse → LyricWarp.pulse`, `LyricWarp → Preview`.

Demo 2, **glowing random walk** (32 points in a data texture). JS node with
```js
// setup
state.p = Array.from({ length: 32 }, (_, i) => ({ x: Math.random(), y: Math.random(), hue: i / 32 }));
// frame
// 32 points on a random walk -> a 32x1 RGBA32F data texture (x, y, brightness, hue)
const d = new Float32Array(32 * 4);
state.p.forEach((q, i) => {
  q.x = (q.x + (Math.random() - 0.5) * 0.8 * dt + 1) % 1;
  q.y = (q.y + (Math.random() - 0.5) * 0.8 * dt + 1) % 1;
  d.set([q.x, q.y, 0.6 + 0.4 * Math.sin(time * 2 + i), q.hue], i * 4);
});
return { points: dataTexture(d, 32, 1, 4) };
```
and `create_custom_node {name: "GlowDots"}`:
```glsl
vec3 glowDots(vec2 uv, sampler2D points) {
    vec3 col = vec3(0.0);
    for (int i = 0; i < 32; i++) {
        vec4 p = texelFetch(points, ivec2(i, 0), 0); // element i = texel (i, 0): x, y, brightness, hue
        float d = length(uv - p.xy);
        vec3 tint = 0.55 + 0.45 * cos(6.28318 * (p.w + vec3(0.0, 0.33, 0.67)));
        col += tint * p.z * 0.0006 / (d * d + 0.00025);
    }
    return col / (1.0 + col);
}
```
wired `UV.uv → GlowDots.uv`, `JS.points → GlowDots.points`, `GlowDots → Preview`. Connect the JS node's texture output after its first frame has run (or set `data.outputs` like `[{"name": "points", "type": "sampler2D"}]` up front), since the ports come from the returned value.

### Port and connection syntax

- Ports are referenced by **name** (`"uv"`, `"color"`, `"x"`) or **0-based index**. Custom-node outputs are called `out`. Custom-node inputs accept the GLSL parameter name or its display name.
- Accessors (swizzles and struct members) go in `accessor` (`".xy"`, `".rgb"`, `".position.xy"`) or, in `build_graph`, as a suffix on the source: `"uv.uv.x"`. On generic outputs (Mix, Add, Blend, ForLoop...) they are checked against the type the compiler resolves from the node's connected inputs; `build_graph` retries such connections after the rest of the graph is wired, so connection order doesn't matter.
- In `build_graph`, a bare `"key"` means the node's default port. Existing node ids work in place of keys, which lets you extend a graph. `ForLoopStart` with key `loop` also defines `loop_end`.

### Effect amount convention

Every effect-like node has a trailing float input **`amount`** (inline default `1.0`), so scene transitions can fade effects in and out:

- `amount = 0` (or less) is an exact bypass: the output is the unprocessed input (`uv` for UV transforms, `color` for colour adjustments and post effects, the plain texture read for TextureBlur / ChromaticAberration), or no contribution for generators (Glow → 0, EdgeDetect → no edges, Vignette.mask → 1).
- `amount = 1` is the full effect and compiles to exactly the same GLSL as before the input existed.
- In between, each effect fades continuously in its own way, not by cross-fading: angles, offsets and strengths scale (RotateUV, TranslateUV, Twirl, WaveUV, Grain, Scanlines, ChromaticAberration, TextureBlur radius...); zoom (`scale^amount`) and Pixelate cell size (from one pixel) move in log space; Kaleidoscope grows its mirrored wedges continuously (log space) from one unfolded view; TileUV grows the tile count from 1 while the tiles fold together; MirrorUV sweeps the mirror line in from beyond the frame edge; Dither / Posterize coarsen the quantization step from 1/1023; Saturation / Gamma / BrightnessContrast blend their factor from the neutral value.

Nodes: RotateUV, ScaleUV, TranslateUV, TileUV, MirrorUV, Kaleidoscope, Pixelate, Twirl, WaveUV, Vignette, Grain, Dither, Scanlines, Glow, ChromaticAberration, TextureBlur, EdgeDetect, HueShift, Saturation, BrightnessContrast, Gamma, Grayscale, Invert, Posterize, Tint. `list_node_types` shows the convention as a note on each of them. In code, the definitions carry `amountInput: 'amount'`, `identityAtZero: true` and `amountBypass` (output → bypass expression), see `src/core/library/amount.js`.

The input is always last, so saved connections (stored by index) are unaffected. Three nodes already had an input called `amount` with a different meaning, and it was renamed: **Grain** `amount` → `intensity`, **ChromaticAberration** `amount` → `strength`, **Saturation** `amount` → `saturation`. Saved projects are migrated on load. In new graphs, set the renamed input (e.g. `{"intensity": 0.05}`), because `amount` is now the 0..1 fade.

## Example session

```text
> create_project {"name": "Plasma"}
< {"created":"plasma","file":"projects/plasma.patchtoy.json","target":"headless"}

> build_graph {"nodes":[{"key":"uv","type":"UV"},{"key":"t","type":"Time"},{"key":"s","type":"Sin"},
                {"key":"c","type":"Vec3","data":{"useUniform":false}},{"key":"p","type":"Preview"}],
               "connections":[{"from":"uv.uv.x","to":"c.x"},{"from":"t","to":"s.x"},{"from":"s","to":"c.y"},
                              {"from":"uv.uv.y","to":"c.z"},{"from":"c","to":"p.color"}]}
< {"ids":{"uv":0,"t":1,"s":2,"c":3,"p":4},"nodes_created":5,"connections_made":5,"compile":{"ok":true,"previews":[{"id":4,"ok":true}]}}

> render_preview {"width": 512, "time": 2.5}
< [image/png]  {"target":"Preview #4","width":512,"height":320,"stats":{"blank":false,...}}

> create_custom_node {"name":"Rings","glsl":"float rings(vec2 uv, float freq) { return 0.5 + 0.5 * sin(length(uv - 0.5) * freq - u_time); }"}
> add_node {"type":"Rings"}                         # -> id 5
> connect {"from_node":0,"to_node":5,"to_input":"uv"}
> connect {"from_node":5,"to_node":3,"to_input":"z"}
> compile {}
```

## CLI (no MCP client needed)

`mcp/cli.mjs` runs the same tool handlers directly against an auto-launched headless PatchToy. Images are written to files. It uses a random bridge port, so it never interferes with a running MCP server or your tabs (pass `--live` to allow your tab).

```bash
node mcp/cli.mjs tools                      # list tools
node mcp/cli.mjs help build_graph           # description + JSON schema

# Several tools in one run (one browser launch); JSON inline, @file or - (stdin)
node mcp/cli.mjs create_project '{"name":"Demo"}' \
                 build_graph @graph.json \
                 compile \
                 render_preview '{"width":768,"time":2}' --out demo.png

# Operate on an existing project
node mcp/cli.mjs --project demo set_node_data '{"id":3,"data":{"value":4}}' render_preview --out out/
```

Options: `--project <name>`, `--out <file.png|dir>`, `--url <app url>`, `--live`, `--headed`, `--keep-going`, `--quiet`. `render_preview`/`screenshot_editor` also accept `save_path` (relative to the repo root; confined to the repo, the temp folder and `PATCHTOY_SAVE_DIRS`). The active project persists between runs in `projects/.mcp-state.json`. Exit code is 1 if a tool failed.

## End-to-end test

```bash
node mcp/test-e2e.mjs                                       # auto-starts Vite + headless Chrome
PATCHTOY_URL=http://localhost:5199 node mcp/test-e2e.mjs    # reuse a running dev server
PATCHTOY_PROJECTS_DIR=/tmp/pt node mcp/test-e2e.mjs          # use this projects dir (default: a fresh temp dir, removed afterwards)
```

The test drives `mcp/server.mjs` through the MCP SDK client over stdio. It creates a project, registers a custom value-noise node, builds UV → noise / Time → Sin → Vec3 → Preview, edits it, compiles, renders a PNG and checks it isn't blank. It also checks error reporting (bad ports, GLSL errors with line numbers and node attribution), swizzles on generic outputs, inline input values, uniform-only updates, Feedback pass errors, the saved background preview, the disk round-trip, layout, screenshot and duplicate/open, then deletes everything it created. The audio check sets the metronome with `set_audio`. It builds a custom node that reads `u_beat` with no wiring, plus a Beat node, and checks that only the used audio uniforms are declared. It then confirms that `render_preview` at `beat_phase` 0 and 0.5 gives different images and reads `get_audio_status`. The audio texture check covers several points. The metronome spectrum texture is non-zero and deterministic per beat. `u_spectrum` is declared only where GLSL uses it. Custom GLSL and Spectrum Bars render. Textures keep uploading every frame without a shader relink. With audio switched off, the texture is zero.

## In-app bridge (for app developers)

- `src/automation/BridgeClient.js` handles the WebSocket client: reconnection with backoff, JSON `{id, method, params}` → `{id, result|error}`, hello/visibility messages, token/nonce authentication, and the dev-only gating (production: `localStorage.patchtoyBridge = 'on'` plus a `bridgeToken`). Its bridge parameters are kept in `sessionStorage` so a reload (Vite HMR) keeps working even after the app strips the query string.
- `src/automation/AutomationAPI.js` holds the command handlers on `window.toy`: NodeGraph, CompilationManager, ShaderCompiler, ProjectManager, `createCustomNode`. While a command runs, native `alert/confirm/prompt` are intercepted and their text is returned as `app_messages`.
- Window events: `patchtoy:bridge-status` `{connected, clientName, port, headless, gaveUp?, error?}` and `patchtoy:activity` `{message, agent, time}`.

## Known limitations

- Device nodes (Camera, Microphone, MIDI, ScreenCapture, VideoURL) produce black/0 in headless mode. Audio-reactive shaders render deterministically with `set_audio {mode:"metronome"}` and `render_preview {beat_phase}`. `set_audio` file mode also works headless (the launcher passes `--autoplay-policy=no-user-gesture-required`). In a live tab, Chrome may block playback until the user clicks the page.
- `render_preview` renders a single frame at `time`. Feedback nodes show their current buffer, not a re-simulated history. With `beat` / `beat_phase`, the Feedback passes are first run (twice) at the pinned values, so render-target chains (graded frame, bright pass, bloom) show that beat; recursive simulations just advance two frames. For reproducible renders of simulations, pass `warmup: N`. It clears the Feedback buffers, resets the JS node state (setup runs again), the control-rate state and the SceneSwitcher state, and seeds `Math.random` (`seed`, default 1). It then steps N frames at a fixed timestep (`warmup_fps`, default 60) ending at the render time. `date` (ISO string or epoch ms) pins what `Date` / `Date.now()` return to JS nodes during the warm-up. The visual regression suite (`tests/visual/`) renders every demo this way.
- In live mode `screenshot_editor` captures only the node canvas (with any background preview), not DOM toolbars or dialogs.
- JS nodes run on the main thread: an infinite loop in `data.code` freezes the tab (there is no time limit). Their inputs are the frame values above and Param values; GLSL values can't be read back into JS.
- There is no undo for agent edits (the app has no undo stack). Use `duplicate_project` as a checkpoint.
- A second MCP server instance can't use port 7878 at the same time; it falls back to a random port (headless only).
- In dev mode each tab asks its dev server every 2.5 s (a same-origin fetch, silent in the console) whether an MCP server with live pairing listens on the bridge port, and only opens the WebSocket when it does.

### I/O bridge (OSC / serial / MIDI out / Art-Net)

The I/O nodes (category `io`) talk to other apps and hardware through a separate local process, `npm run io-bridge` (`mcp/lib/io-bridge.mjs`: 127.0.0.1 only, token-paired, per-session opt-in, allowlisted destinations; see the README section "Connecting hardware & other apps").

| Tool | Arguments / result |
|------|--------------------|
| `io_bridge` | `{action?: 'status' \| 'configure' \| 'unpair' \| 'list_serial', token?, port?, opt_in?, allow?: ["host:port"], serial?: ["/dev/..."], lan?, wait_ms?}`. Status of the app's I/O client (link state, opt-in, allowlist, requested destinations, OSC In ports, serial ports, counters, last in / out message, MIDI outputs) and of every I/O node. `configure` / `unpair` only work on headless clients: in the user's own tab, pairing, permission and the allowlist are the user's decisions (Output › I/O). |

`get_project` adds `io {state ok | wait | error | off, status, messages}` to each I/O node and an `io` summary. `node mcp/test-e2e.mjs` round-trips values and events through a real bridge (OSC Out → UDP → OSC In) and a mock serial port (echo).
