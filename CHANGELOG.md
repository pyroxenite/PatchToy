# Changelog

## 2.0.0 (unreleased)

PatchToy 2.0 is a redesign of the whole editor plus a community layer: share links,
user pages, a public gallery and forks. Projects saved with 1.x open unchanged.

### Render 3D (new)
- **Render 3D node**: rasterized meshes inside one node, output as textures (HDR color, depth, normal) so every effect, Feedback and scene works on them. Lazy rendering (hidden scenes / off-screen outputs cost nothing), MSAA, automatic size following the output and the render-quality governor.
- **Meshes**: Box, Sphere, Torus, Plane, Grid, Cylinder / cone, Torus Knot, Bird, Points, Text Mesh; **Mesh** (transform, instancing, displacement), **Group 3D**.
- **Material sub-graphs** compiled per fragment (Surface node): PBR, Unlit, Toon, Iridescent, Glass.
- **Instancing** from Feedback simulations / JS data textures (Instance Data, Instances From Texture) or procedural (Instance Index, Make Instance, Instance Grid): 100k shadowed boxes in ~5.5 ms, 1M point sprites in ~12 ms at 1080p on an M1 Max.
- **Lights**: directional with soft PCF shadows, point, spot, ambient hemisphere.
- **Raster x raymarch depth compositing**: Render 3D `background` + `bgDepth`, and new optional `depth` / `under` inputs on Raymarch (`depth` on GlassRaymarch).
- **glTF 2.0 import (Blender)**: Model node, .glb drop on the canvas, skinning and animation clips (`time` input: wire Beat.time to dance on the beat).
- MCP: `load_model` tool, list_node_types notes, `get_project` render stats, compile reports for Render 3D programs, render_preview at the render size.
- Demos: Instanced Flock, Particle Storm, Mesh x SDF Hybrid, Blender Showcase. `scripts/make-test-glb.mjs` generates the self-made test models (`assets/models/`).

### Community (new)
- **Open** (top bar, ⌘O): one gallery for **My projects** (private / link only / public,
  rename, delete, copy link, download), **Community** (public projects of every user,
  newest or most viewed, search by title or author) and **Demos**, as a panel under the
  button (full screen for `/explore`, `/u/<name>` links and the first-visit welcome).
  ⇧⌘O imports a project file. Against a 1.x API it offers link sharing only and says
  Community arrives with the 2.0 backend. Same thumbnail cards as the demo picker, with
  loading, empty, error and offline states, keyboard navigation and infinite scroll.
- **Share links** `/p/<projectId>` with history-API routing (legacy `?project=<id>` links
  redirect). Private projects show a clear "private or doesn't exist" message to others.
- **User pages** `/u/<username>`: display name, avatar initial, join date and public
  projects. Author names on cards link there. **Edit profile** (display name, username)
  from the account menu; emails are never shown publicly.
- **Forks**: someone else's project opens read-only with a banner; **Save a copy** saves it
  to your account and records "forked from @author" (shown on cards). Fork and view
  counts per project.
- **Thumbnails**: every cloud save captures a ~480×300 JPEG of the output, uploaded
  straight to S3 (presigned POST) and served through CloudFront.
- Per-route `<title>` and description / Open Graph meta tags.
- **Link previews** in Slack, Discord, iMessage and X for share links `/p/<id>` and user
  pages `/u/<name>` (title, author, description, thumbnail): an optional Lambda@Edge function
  injects the Open Graph / Twitter tags (`ENABLE_SOCIAL_PREVIEWS`, off by default, see
  RELEASE.md step 8). Private projects never get a preview; link-only projects do (with
  `noindex`), unless `SOCIAL_PREVIEWS_UNLISTED=false`.
- If opening a share link replaces a patch that only lived in this browser, a copy is kept
  and can be restored.
- Backend: public feed, user profile, profile update, view counter, thumbnail upload,
  sign-up verification and resend endpoints; a sparse DynamoDB GSI for the public feed; username uniqueness reservations;
  stricter validation and size limits; CORS headers on API Gateway's own errors.
- Local development without AWS: `npm run mock-api` (the real Lambda handlers on an
  in-memory store; mails go to `/__mock/outbox` and its log) and
  `?api=http://localhost:8787` / `VITE_API_URL`.
- Tests: Lambda unit tests (`npm run test:lambda`), community end-to-end test in headless
  Chrome (`npm run test:community`), offline CDK synth check (`infra/test/synth-check.ts`).

### Security (pre-release review, see RELEASE.md "Security settings")
- **Sign-up with email verification (no account enumeration).** Creating an account always
  answers "Check your email to finish signing up": a new address gets a single-use link
  (`/#verify=<token>`, 24 hours, only the newest link works) that creates the account and
  signs in; an address that already has an account gets a "someone tried to sign up with
  your email" notice instead. Signing in before confirming fails like a wrong password, with
  a "Didn’t confirm your email?" resend option (rate limited, same answer for every
  address). Existing accounts count as verified (no migration). Needs SES out of the sandbox;
  `SIGNUP_EMAIL_VERIFICATION=false` is the fallback. Password reset and resend requests for
  unknown addresses take as long as for known ones.
- **Custom nodes can't hijack built-ins.** Custom node names must be identifiers (no
  `__proto__` / `constructor`, no built-in names such as `UV` or `Preview`); the node registry
  has no prototype. A project's custom nodes are scoped to that project (kept in its autosave)
  and never written to your custom node library: opening a community project, a share link,
  a demo or a file leaves the library unchanged ("Keep in my library", or saving the project,
  copies them in). Libraries stored by 1.x are cleaned on load (clashing names renamed to
  `<name>_custom`). Projects embed only the custom nodes they use; the API validates their
  names and sizes. Demos with different versions of the same node (`LensStreak`) open in any order.
- **Sessions can be revoked.** Session tokens carry a `tokenVersion`; a password reset or a
  username change signs out every other session. Only HS256 session tokens with the session
  audience are accepted. Reset links use opaque single-use tokens in the URL fragment, valid
  30 minutes (was a reusable 1-minute JWT that also worked as a session). The app signs out
  and says "Session expired" when the API reports a revoked session.
- **Abuse limits:** sign-in lockout with exponential backoff per account, per-IP limits on
  sign-in / register / reset, one reset mail per address per 5 minutes, 500 projects per
  account, bcrypt cost 12 (old hashes upgraded on sign-in), a common-password blocklist, and
  an optional AWS WAF (`ENABLE_WAF`, off by default). Unknown accounts take as long to reject
  as wrong passwords.
- **Link sharing is not publishing.** Projects are private, *link only* (unlisted) or
  *public* (listed in Community and on your page). "Publish to Community" is a separate,
  explicit action. 1.x "Share link" projects stay link-only after the 2.0 backfill.
- Author names on projects come from the users table (a stale token can't publish under an
  old or reclaimed handle).
- CSP: Monaco is the only allowed CDN path (loaded on demand, with Subresource Integrity),
  `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`, `frame-ancestors 'none'`;
  `Referrer-Policy: strict-origin-when-cross-origin`; nosniff / HSTS on the thumbnails CDN.
  No third-party request happens on page load, and the reset token is removed from the URL first.
- No default JWT secret (fail closed); the secret can live in SSM Parameter Store.
- Projects opened by the MCP agent run their JavaScript for that session only (not added to
  the permanent trust list); `set_node_data` trusts code only when the agent writes code.
  The JavaScript prompt now says that project code can access your PatchToy session.
- Someone else's project can't make your browser contact other websites on open: Video URL
  nodes and image Params from a URL wait for "Load media".
- Smaller fixes: view counts de-duplicated per IP (User-Agent ignored) with a daily cap, forks
  counted once per user; look-alike reserved usernames (`adm1n`, `patch-toy`, …) refused and
  invisible / bidi characters stripped from names and texts; thumbnails dropped when a project
  goes private and stored under unguessable keys; CORS without credentials, origins
  configurable; malformed usernames in URLs answer 400; the mock API listens on 127.0.0.1.

### Reliability fixes from the pre-release review
- A patch whose autosave contains an unknown node type (e.g. a missing custom node) is no
  longer destroyed on restore: unknown nodes are kept as data and written back; a failed
  restore keeps a raw copy (`patchtoy_graph_corrupt`) and never autosaves over it.
- Opening a password reset link keeps the current patch.
- Reloading `/p/<id>` with unsaved edits restores them (with "Revert to saved"); unsaved edits
  to another cloud project are kept as its local copy when a share link opens.
- Community search / sort: a newer query no longer loses to a slower older response.
- Dev builds log which API they use; `npm run dev:mock` points the dev server at the mock API.

### Editor redesign
- New "modular synth meets pixel art" design system (`src/ui/theme.js`, pixel icon set):
  app shell with top bar, node library sidebar, status bar, compile pill, toasts, menus
  and dialogs (no more native `alert` / `prompt`).
- Node painter rewrite: typed port colours, category colours, inline value fields,
  preview nodes with background / fullscreen toggles.
- Quick node search (Tab), library panel with search and drag-and-drop, keyboard shortcuts.

### Node library
- Data-driven GLSL library (`src/core/library/`): math, vector, UV, noise, shapes, 3D SDFs,
  colour, effects, logic and sources, checked by `scripts/check-definitions.mjs`.
- **Effect amount inputs**: every UV / effect / colour node takes a trailing `amount`
  (0 = exact bypass, 1 = full effect), so effects can be faded and automated.
- New nodes: Comment (sticky notes), Keyboard, XY Pad, MIDI Note, Param, JS, Scene
  Switcher, debug / probe nodes, control-rate nodes.

### Patching
- **Node groups** (subgraphs): group, collapse, enter / exit with a zoom transition (also
  by zooming into the group's minimap), exposed ports with editable names. Unplugging a
  cable inside a group keeps the outside cable; dropping a cable on a group box adds a new
  input ("virtual" until it is connected inside).
- **Undo / redo** for every graph edit.
- **Control-rate signals**: values that are the same for every pixel (Params, LFOs, Beat,
  Time, Mouse and math on them) run once per frame on the CPU and reach shaders as
  uniforms (diamond ports, pixelated cables); a Sample node reads pixels back.
- **Comments** on the canvas with light markdown.
- **Parameters panel**: every Param node of the patch as a form (sections, order,
  float / int / bool / color / enum / trigger kinds), also over a fullscreen preview.

### Live inputs, music and beat sync
- **Audio / beat engine** (`AudioEngine` + AudioWorklet): microphone, music files, tab
  audio or a metronome; FFT bands, kick onsets, tempo and a phase-locked beat exposed as
  uniforms (`u_beat`, `u_beatPhase`, `u_kick`, `u_level`, …); tap tempo and BPM display.
- Global clock (`src/core/Clock.js`) shared by shaders, Param pulses and the transport.
- **Stable beat clock**: while the tracker is unsure (a new track, a break) the published
  clock coasts at the last trusted tempo, then glides to the new one without jumps;
  `u_beatTrust` / Beat `gate` fade beat effects meanwhile. Beat node options: clock
  stable | raw, gate fade | hold | off, threshold. The tracker holds steady tempos much
  better on weak, room-mic input.
- **Audio textures** (spectrum, waveform, spectrogram), **MIDI learn** for Params, and an
  OSC / MIDI-out / serial bridge through the MCP server.

### JavaScript nodes
- **JS node**: per-frame JavaScript whose return values become typed live uniforms,
  plus canvas / data textures. Code from someone else (files, links, community) stays
  paused until the user allows it (per-browser trust list).

### Scenes and transitions
- **Scene Switcher** with transitions (crossfades, wipes and more), auto mode (seconds,
  bars, music) and a Scenes section in the Parameters panel.

### Output and performance
- Output window / performance mode, real-time recording and offline frame-exact export.
- Render-quality governor (dynamic resolution, display refresh detection).
- Editor speed: scrubbing a value no longer recompiles shaders (60 fps on heavy demos),
  feedback shaders link in the background, cached cable drawing, fewer redraws.

### Demos
- Bundled demo projects (`projects/*.patchtoy.json`) with thumbnails, a demo gallery on
  first visit, and JS / Params example projects.

### MCP server (AI agents)
- `mcp/server.mjs`: an MCP server that creates, edits, compiles and renders PatchToy
  projects through the real app (live tab or headless Chrome), plus a CLI and an
  end-to-end test (`npm run test:mcp`).

### Fixes
- "New project" after working on a cloud project no longer overwrites that project on the
  next save (the project state is now reset).
- Modal logo and stylesheet / script paths are absolute, so deep links load correctly.
- The CloudFront CSP now allows thumbnail images and uploads, and media from `blob:` /
  `https:` (music files, Video URL node).
