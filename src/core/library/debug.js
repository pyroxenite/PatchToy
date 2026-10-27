/**
 * Debug / probe nodes: output-style sinks that evaluate their input sub-graph on
 * the GPU at a sample point (or over a coarse grid of the whole frame) and read the
 * result back to the CPU, so values can be shown as numbers, swatches and plots.
 *
 * They have inputs only and are never compiled into other shaders. The node
 * classes live in src/nodes/ProbeNode.js, the GPU side in
 * src/rendering/ProbeRenderer.js.
 *
 * Shared data:
 *   sample: 'origin' (uv 0,0 = bottom-left corner) | 'center' (0.5, 0.5) |
 *           'mouse' (u_mouse) | 'custom' (data.u, data.v)
 */

export const PROBE_SAMPLE_MODES = ['origin', 'center', 'mouse', 'custom'];

const SAMPLE_NOTE = "data.sample picks where the input is evaluated: 'origin' = uv (0,0), the bottom-left corner (default), 'center' = (0.5, 0.5), 'mouse' = the u_mouse position, 'custom' = (data.u, data.v).";

const probe = (kind, view, spec) => ({
    category: 'debug',
    outputs: [],
    isProbeNode: true,
    probeKind: kind, // 'point' = one pixel at the sample point, 'grid' = coarse frame grid
    probeView: view,
    glsl: null, // never compiled into other shaders (ProbeRenderer compiles the input sub-graph)
    ...spec
});

export const DebugNodes = {
    'ValueDisplay': probe('point', 'value', {
        displayTitle: 'Value Display',
        description: `Shows the numeric value of its input (float, int, bool, vec2, vec3, vec4; the type is detected) evaluated at one pixel and read back from the GPU. NaN and +/-Inf are highlighted in red (a common cause of black pixels). data.precision = decimals (0-6). ${SAMPLE_NOTE}`,
        inputs: [{ name: 'value', type: 'any' }],
        data: { precision: 3, sample: 'origin', u: 0.5, v: 0.5 }
    }),

    'ColorDisplay': probe('point', 'color', {
        displayTitle: 'Color Display',
        description: `Shows the colour of its input (vec3 / vec4; float = gray) at one pixel: a large swatch, hex, 0-1 RGB(A) values and a CLIP indicator when a channel is outside 0..1 (HDR or negative; the swatch shows the clamped colour). ${SAMPLE_NOTE}`,
        inputs: [{ name: 'color', type: 'any' }],
        data: { precision: 3, sample: 'origin', u: 0.5, v: 0.5 }
    }),

    'Plot': probe('point', 'plot', {
        displayTitle: 'Plot',
        description: `Scrolling time-series of its input (float, or vecN = one coloured line per component) sampled every frame at one pixel. data.seconds = history length, data.range 'auto' | 'fixed' (data.min / data.max), data.beats = overlay beat ticks of the beat clock (bars taller). Drag the corner to resize. ${SAMPLE_NOTE}`,
        inputs: [{ name: 'value', type: 'any' }],
        data: { seconds: 5, range: 'auto', min: -1, max: 1, beats: false, precision: 3, sample: 'origin', u: 0.5, v: 0.5, width: 280, height: 170 }
    }),

    'XYScope': probe('point', 'xy', {
        displayTitle: 'XY Scope',
        description: `Plots a vec2 input as a point in the plane with a fading trail over time (x = horizontal, y = vertical), like an oscilloscope in XY mode (Lissajous curves). data.seconds = trail length, data.range 'auto' | 'fixed' (data.min / data.max for both axes), data.aspectLock = same scale on both axes. Drag the corner to resize. ${SAMPLE_NOTE}`,
        inputs: [{ name: 'xy', type: 'any' }],
        data: { seconds: 2, range: 'auto', min: -1, max: 1, aspectLock: true, precision: 3, sample: 'origin', u: 0.5, v: 0.5, width: 220, height: 240 }
    }),

    'FrameStats': probe('grid', 'stats', {
        displayTitle: 'Frame Stats',
        description: 'Evaluates its input over the whole frame on a coarse grid (64 samples wide, same aspect as the preview, e.g. 64x40) and shows per-channel min, max and mean plus the number of NaN / Inf samples. Coarse: thin features between grid points are missed. data.precision = decimals.',
        inputs: [{ name: 'value', type: 'any' }],
        data: { precision: 3 }
    }),

    'Histogram': probe('grid', 'histogram', {
        displayTitle: 'Histogram',
        description: "Histogram of its input over the whole frame (coarse 64-wide grid, like Frame Stats). data.channel 'luma' (Rec. 709 luma of the colour; a float is shown as is) | 'rgb' (one histogram per channel), data.bins (8-64), data.range 'fixed' (data.min..data.max, default 0..1, out-of-range samples counted at the edges) | 'auto'. Drag the corner to resize.",
        inputs: [{ name: 'value', type: 'any' }],
        data: { channel: 'luma', bins: 32, range: 'fixed', min: 0, max: 1, width: 240, height: 150 }
    }),

    'LED': probe('point', 'led', {
        displayTitle: 'LED',
        description: `A status light for a bool or a float: lit when the value (first component) is > data.threshold (a bool input lights when true). Red when NaN. Handy for triggers, beats and conditions. ${SAMPLE_NOTE}`,
        inputs: [{ name: 'value', type: 'any' }],
        data: { threshold: 0.5, sample: 'origin', u: 0.5, v: 0.5 }
    })
};
