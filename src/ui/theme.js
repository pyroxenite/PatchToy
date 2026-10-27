/**
 * PatchToy design tokens — single source of truth for canvas rendering.
 * The DOM side mirrors these as CSS custom properties in style.css (:root).
 *
 * Direction: "modular synth meets pixel art". Near-black graphite surfaces,
 * crisp 1px borders, a warm brand accent taken from the logo, and every GLSL
 * type gets its own signal color so cables read like patch cords.
 */

export const COLORS = {
    // Surfaces (darkest → lightest)
    canvas: '#0c0d11',
    gridDot: '#262a35',
    gridDotMajor: '#3a4050',
    panel: '#14161c',
    nodeBody: '#191b22',
    nodeHeader: '#20232c',
    raised: '#252935',
    hover: '#2c3140',

    // Lines
    border: '#2a2e3a',
    borderStrong: '#3a4050',

    // Text
    text: '#eceef4',
    textDim: '#a0a6b6',
    textFaint: '#626a7c',

    // Brand + status
    accent: '#ff5c2b',
    accentSoft: 'rgba(255, 92, 43, 0.16)',
    accent2: '#f5c84b',
    selection: '#ff5c2b',
    success: '#4ade80',
    warning: '#fbbf24',
    error: '#ff4d5e',
    errorSoft: 'rgba(255, 77, 94, 0.18)',
};

// Signal color per GLSL type (ports + cables)
export const TYPE_COLORS = {
    float: '#8ecbff',
    int: '#5b8cff',
    uint: '#5b8cff',
    bool: '#ff7eb6',
    vec2: '#6ee7b7',
    vec3: '#fcd34d',
    vec4: '#fb923c',
    ivec2: '#5b8cff', ivec3: '#5b8cff', ivec4: '#5b8cff',
    bvec2: '#ff7eb6', bvec3: '#ff7eb6', bvec4: '#ff7eb6',
    mat2: '#c4b5fd', mat3: '#c4b5fd', mat4: '#c4b5fd',
    sampler2D: '#f472b6',
    samplerCube: '#f472b6',
    struct: '#a78bfa',      // fallback for any registered struct (Camera, Ray, ...)
    js: '#e2e8f0',
    // Control-only values (never reach a shader): one-frame events, strings, number lists
    event: '#ffe066',
    string: '#c3e88d',
    list: '#7dd3fc',
    unknown: '#8b93a5',
};

export function typeColor(type) {
    if (!type) return TYPE_COLORS.unknown;
    return TYPE_COLORS[type] || TYPE_COLORS.struct;
}

// Accent per node category (header stripe, library sidebar, search results)
export const CATEGORY_COLORS = {
    output: '#ff5c2b',
    constant: '#8ecbff',
    input: '#4ade80',
    source: '#34d399',     // camera / video / mic / midi / keyboard
    math: '#a78bfa',
    vector: '#818cf8',
    uv: '#60a5fa',         // coordinates & transforms
    noise: '#fcd34d',
    shape: '#2dd4bf',      // 2D SDFs
    sdf3d: '#c084fc',      // 3D SDFs / raymarching
    render3d: '#f0abfc',   // rasterized 3D: Render 3D, meshes, materials, lights (src/render3d)
    color: '#f472b6',
    effect: '#fb923c',
    logic: '#94a3b8',      // loops, blend, map, control flow
    control: '#d4f55a',    // control-rate (CPU, once per frame): LFO, Lag, Counter...
    io: '#38bdf8',         // I/O: OSC, serial, MIDI out, Art-Net (src/core/library/io.js)
    custom: '#e879f9',
    debug: '#2dd4bf',      // probes: value / colour / plot displays
    note: '#f5c84b',
};

export const CATEGORY_LABELS = {
    output: 'Output',
    constant: 'Constants',
    input: 'Inputs',
    source: 'Sources',
    math: 'Math',
    vector: 'Vector',
    uv: 'UV & Transform',
    noise: 'Noise',
    shape: 'Shapes 2D',
    sdf3d: '3D & Raymarch',
    render3d: '3D Render',
    color: 'Color',
    effect: 'Effects',
    logic: 'Logic & Flow',
    control: 'Control',
    io: 'I/O',
    custom: 'Custom',
    debug: 'Debug',
    note: 'Notes',
};

export function categoryColor(category) {
    return CATEGORY_COLORS[category] || COLORS.textFaint;
}

export const FONTS = {
    // Pixeloid is crisp at multiples of 9px
    title: '9px "Pixeloid Sans"',
    titleBold: 'bold 9px "Pixeloid Sans"',
    label: '11px -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", sans-serif',
    value: '9px "Pixeloid Mono"',
    mono: '11px ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace',
};

export const LAYOUT = {
    nodeRadius: 6,
    headerHeight: 24,
    portRadius: 4.5,
    portSpacing: 22,
    cableWidth: 2,
    gridSize: 24,
    gridMajorEvery: 5,
};

// ---------------------------------------------------------------------------
// Node-canvas extras (used by the 2D graph renderer; mirror in CSS if needed)
// ---------------------------------------------------------------------------
export const CANVAS = {
    shadow: 'rgba(0, 0, 0, 0.5)',        // hard pixel drop-shadow under nodes
    cableShadow: 'rgba(6, 7, 10, 0.9)',  // dark underlay that separates crossing cables
    inset: '#0f1116',                    // inline fields, screen wells, meters
    insetBorder: '#272b36',
    insetHover: '#3a4050',
    uniform: '#f5c84b',                  // uniform-mode badge + value tint (= accent2)
    ledOn: '#4ade80',
    ledOff: '#3a4050',
};

export const NODE_LAYOUT = {
    bodyPadTop: 5,       // gap between header and first port row
    bodyPadBottom: 7,    // gap after last row
    portHitRadius: 8,    // must match NodeGraph port hit-testing (dist < 8)
    fieldHeight: 16,     // inline value field height (fits a 22px row)
    shadowOffset: 3,     // hard drop-shadow offset (px, world units)
};
