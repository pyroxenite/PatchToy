/**
 * Visual regression settings (tests/visual/run.mjs).
 *
 * Every projects/<slug>.patchtoy.json is rendered through the MCP render_preview path
 * at DEFAULTS.width x height, once per entry of `frames`, with:
 *   - set_audio {mode: 'metronome', bpm}: deterministic beat clock and audio values;
 *   - time pinned (u_time; the beat follows: 120 BPM -> beat = 2 * time);
 *   - warmup: Feedback buffers, JS node state (setup re-run), control-rate state and
 *     SceneSwitcher runtime state are reset, Math.random is seeded, then `warmup`
 *     frames are stepped at `fps` (fixed dt) ending at the render time. This makes the
 *     feedback simulations (boids, currents, trails, bloom chains) and JS nodes
 *     reproducible: on one machine the renders are bit-exact.
 *
 * Comparison:
 *   exact (default)  the raw render's SHA-256 must match the golden's, as long as the
 *                    platform (OS, Chrome major, GPU renderer) is the one the goldens were
 *                    made on. Otherwise, or with --tolerance, the tolerance check is used.
 *   tolerance        metrics against the stored JPEG golden (tests/lib/compare.mjs), as the
 *                    excess over the golden's own JPEG encoding error, must stay under the
 *                    project's thresholds (multiplied by --tolerance <scale>).
 *
 * Per-project keys: frames, warmup, fps, mouse, date (JS Date pin), exact, tolerance (a
 * PROFILES name or {mae, bad_frac, mean_delta, hist_dist}),
 * note, skip (reason string).
 */

export const DEFAULTS = {
    width: 480,
    height: 300,
    bpm: 120,
    warmup: 90,          // frames at `fps` before each render (1.5 s)
    fps: 60,
    seed: 1,
    mouse: [0.5, 0.5],
    jpegQuality: 0.8,
    // t = 2.05 s: just after the kick on beat 4 (flashes, envelopes high); t = 5.3 s: beat 10.6, off-beat
    frames: [{ time: 2.05 }, { time: 5.3 }],
    exact: true,
    // Thresholds for the tolerance comparison (excess over the golden's own JPEG error)
    tolerance: 'default',
};

/**
 * Tolerance profiles (only used in tolerance mode: another platform / GPU, or --tolerance).
 * Calibration on Apple M1 / ANGLE Metal, 480x300 (blurred MAE, % of pixels off by > 32 after blur):
 *   one frame later (1/60 s): aurora-fjord mae 0.8 / 0%, molten-orbit 2.7 / 1.1%,
 *   hyperbolic-lanterns 4.4 / 0.8%, kaleido-tunnel 17.7 / 27%, js-swarm-points 16.3 / 19%;
 *   3 s later: mae 9 - 46, 10 - 64% of the pixels. So `default` passes noise and sub-frame
 *   drift but fails anything visibly different.
 * Chaotic simulations (boids, currents, random walks, recursive feedback zooms) amplify any
 * floating-point difference, so on another GPU only their structure can be compared:
 * mean colour and luma histogram (`structural`).
 */
export const PROFILES = {
    default: { mae: 2.5, bad_frac: 0.01, mean_delta: 2.5, hist_dist: 0.03 },
    text: { mae: 3, bad_frac: 0.02, mean_delta: 3, hist_dist: 0.04 },          // canvas text: system fonts differ
    feedback: { mae: 6, bad_frac: 0.05, mean_delta: 3, hist_dist: 0.04 },      // feedback trails
    structural: { mae: 40, bad_frac: 0.6, mean_delta: 5, hist_dist: 0.06 },    // chaotic simulations
};

/** Files in projects/ that are not demos (left behind by interrupted e2e runs). */
export const EXCLUDE = [/^e2e-test-/, /^e2e-/];

export const PROJECTS = {
    // Five scenes pinned one by one, plus a transition frame (Kaleido Tunnel -> Molten Orbit, zoom)
    'scene-medley': {
        frames: [
            { time: 3.05, scene: 0 },
            { time: 3.05, scene: 1 },
            { time: 3.05, scene: 2 },
            { time: 3.05, scene: 3 },
            { time: 3.05, scene: 4 },
            { time: 3.05, scene_from: 0, scene: 1, progress: 0.5, transition: 'crossfade' },
        ],
        note: 'scene pinned per frame; scene-owned Feedback passes of the pinned scene run during the warm-up',
    },
    // Real time of day drives the sky: pin the wall clock (the runner also sets the browser timezone to UTC)
    'js-clock-sky': {
        date: '2026-06-21T19:30:00Z',
        tolerance: 'text',
        note: 'Date pinned; canvas text (system fonts) differs between platforms',
    },
    'js-beat-lyrics': {
        exact: false,
        tolerance: 'text',
        note: 'canvas text + 2D canvas blur filter (Chrome rasters it on the GPU or the CPU: tiny run-to-run differences); system fonts differ between platforms',
    },
    'audio-textures': {
        exact: false,
        note: 'spectrum / waveform / spectrogram textures (src/services/AudioTextures.js) keep per-frame state (peak caps, auto-gain) that the warm-up does not reset: tiny run-to-run differences',
    },
    // Spring follows the mouse: pin it off-centre so the spring has somewhere to go
    'js-spring-cursor': { mouse: [0.3, 0.65] },
    'js-swarm-points': { warmup: 120, mouse: [0.6, 0.4], tolerance: 'structural', note: 'Math.random seeded; random walk + feedback trails' },
    'hyperbolic-boids': { warmup: 120, tolerance: 'structural', note: 'feedback simulation (7 passes)' },
    'hyperbolic-currents': { warmup: 120, tolerance: 'structural', note: 'feedback simulation (5 passes)' },
    'kaleido-tunnel': { tolerance: 'structural', note: 'recursive feedback zoom (amplifies tiny differences)' },
    'vection': { tolerance: 'feedback', note: 'feedback trails' },
    'beat-lab': { tolerance: 'feedback', note: 'beat history in a feedback buffer' },
    // Render 3D demos (src/render3d): rasterized meshes, shadow maps, MSAA
    'instanced-flock': { warmup: 120, tolerance: 'structural', note: 'boids feedback simulation drawn as instanced meshes by a Render 3D node' },
    'mesh-sdf-hybrid': { note: 'Render 3D meshes depth-composited with a Raymarch background (bgDepth)' },
    'blender-showcase': { note: 'skinned + animated glTF Model (self-made, embedded data URL) instanced by a Render 3D node' },
    'particle-storm': { warmup: 120, tolerance: 'structural', note: 'half a million particles (Feedback sim) drawn as additive points by a Render 3D node' },
};

export function projectConfig(slug) {
    const p = PROJECTS[slug] || {};
    const tol = p.tolerance ?? DEFAULTS.tolerance;
    const profile = typeof tol === 'string' ? tol : 'custom';
    return {
        ...DEFAULTS,
        ...p,
        profile,
        tolerance: typeof tol === 'string' ? { ...PROFILES[tol] } : { ...PROFILES.default, ...tol },
    };
}
