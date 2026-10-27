/**
 * Default code of a new JS node (src/nodes/JSNode.js). Kept in a dependency-free
 * module so the node definition (NodeDefinitions.js) can use it too.
 */

/** Smoothed mouse speed + a hue that drifts faster while you move. */
export const JS_DEFAULT_CODE = `// Smoothed mouse speed and a hue that cycles faster while the mouse moves.
// Inputs: time, dt, frame, resolution, mouse, audio, params, state
const [mx, my] = mouse;
const v = Math.hypot(mx - (state.px ?? mx), my - (state.py ?? my)) / Math.max(dt, 1e-3);
state.px = mx;
state.py = my;
state.speed = damp(state.speed ?? 0, Math.min(v, 4), 6);   // frame-rate independent smoothing
state.hue = ((state.hue ?? 0) + dt * (0.05 + 0.4 * state.speed)) % 1;
const h = state.hue * 6;
const rgb = [0, 4, 2].map(o => clamp(Math.abs(((h + o) % 6) - 3) - 1));
return { speed: float(state.speed), hue: vec3(rgb) };`;

export const JS_DEFAULT_SETUP = `// Runs once before the first frame (async). Example:
// await loadScript('https://cdn.jsdelivr.net/npm/some-lib/dist/lib.min.js');
// state.counter = 0;`;

/** Output signature of the default code (ports exist before the first frame). */
export const JS_DEFAULT_OUTPUTS = [{ name: 'speed', type: 'float' }, { name: 'hue', type: 'vec3' }];
