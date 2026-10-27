/**
 * Help content for a node type, generated from its definition (src/core/NodeDefinitions.js)
 * plus a few hand-written notes for the trickiest nodes (NOTES below).
 *
 * Pure data (no DOM): NodeHelpPanel.js renders it.
 *
 * Read defensively: definitions are being extended (control-rate ports, audio textures...),
 * so every field is optional and unknown fields are ignored.
 *   def.description, def.category, def.displayTitle
 *   def.inputs[]  { name, type, default?, description?, optional?, functionOf?, rate?, cpuInput?, sceneInput?, generic?, inline? }
 *   def.outputs[] { name, type, description? }
 *   def.amountInput / amountBypass / amountNote / identityAtZero   (src/core/library/amount.js)
 *   def.rate === 'control', def.evaluate (JS twin), def.cpuSource, node-kind flags   (src/core/control/rates.js)
 */
import { NodeDefinitions } from '../../core/NodeDefinitions.js';
import { categoryLabel, categoryColorFor, nodeTitle } from '../nodeCatalog.js';

// Node kinds whose outputs are pushed from the CPU (rates.js SOURCE_FLAGS)
const SOURCE_FLAGS = ['isParamNode', 'isJSNode', 'isKeyboardNode', 'isXYPadNode', 'isMidiNoteNode', 'isMidiCCNode', 'isMicrophoneNode'];
// Port types that only exist at control rate
const CONTROL_ONLY_TYPES = new Set(['event', 'string', 'list']);

const TYPE_NAMES = {
    float: 'number', int: 'integer', bool: 'true / false',
    vec2: '2D vector (x, y)', vec3: '3D vector / RGB', vec4: '4D vector / RGBA',
    sampler2D: 'texture', samplerCube: 'cube texture',
    mat2: '2×2 matrix', mat3: '3×3 matrix', mat4: '4×4 matrix',
    T: 'any of float / vec2 / vec3 / vec4 (matches what you connect)',
    any: 'any type',
    event: 'event (a trigger, control rate only)',
    string: 'text (control rate only)',
    list: 'list of numbers (control rate only)',
};

export function typeName(type) {
    if (!type) return '';
    return TYPE_NAMES[type] || (/^[A-Z]/.test(type) ? `${type} struct` : type);
}

/* --------------------------------------------------------------------------
 * Hand-written notes
 * ------------------------------------------------------------------------ */

const PROBE_NOTE = {
    title: 'Debug probe',
    body: 'Probes read values back from the GPU and draw them on the node: they never change the image. ' +
        'Right-click the probe to choose where it samples (bottom-left origin, center, the mouse, or a custom uv); ' +
        'whole-frame probes (Frame Stats, Histogram) scan a coarse 64-wide grid. NaN / Inf show in red, a common cause of black pixels.',
    tip: 'Plug one into the middle of a chain to see what a cable carries before it reaches the Preview.',
};

export const NOTES = {
    Feedback: {
        title: 'Last frame, as a texture',
        body: 'Whatever reaches in is drawn into an off-screen buffer every frame; out is the previous frame of that buffer. ' +
            'Sample it with Texture Sample (at a slightly zoomed / rotated / offset uv) and mix it back into in for trails, echoes, ' +
            'reaction-diffusion and other simulations. Use a float format (rgba16f / rgba32f) to keep values outside 0..1.',
        tip: 'UV → Scale UV (0.99) → Texture Sample(tex = Feedback.out) → Mix with your shape → Feedback.in, and Feedback.out → Preview.',
    },
    Raymarch: {
        title: 'The sdf input is a function',
        body: 'sdf is not a single value: the graph connected to it is compiled into a function of the scene point p and ' +
            'evaluated at every step of every ray. Build it from 3D primitives (Sphere, Box, Torus…), Translate3D / Rotate3D / Repeat3D ' +
            'and the SDF combine nodes; unconnected primitives use the scene point automatically, and Scene Point gives you p explicitly.',
        tip: 'Sphere → SDF Smooth Union ← Box, then into sdf; color → Preview. Use hit / n / ao / shadow for your own shading.',
    },
    GlassRaymarch: {
        title: 'The sdf input is a function',
        body: 'Like Raymarch, sdf is a sub-graph evaluated as a function of the scene point p. The ray refracts into the object, ' +
            'marches inside, bounces (total internal reflection) and exits. The node gives you directions, not a picture: ' +
            'look exitR / exitG / exitB up in an environment (a texture, a gradient or a sky function) and multiply by transmit, ' +
            'then mix in a reflection with fresnel.',
        tip: 'Start from the Glass demo (Open, Demos tab) and swap the sdf sub-graph.',
    },
    SceneSwitcher: {
        title: 'Scenes and transitions',
        body: 'Each scene input gets its own sub-graph, and only the visible scene (two during a transition) is evaluated, so ' +
            'many heavy scenes cost no more than one. Pick a scene in the Parameters panel (Scenes), by clicking a row on the node, with ' +
            'keys 1-9, or from the scene / next inputs, which are control rate (Param, Counter, Beat Divider, JS, MIDI…). ' +
            'The transition style "custom" uses the transition input: a sub-graph built from Transition Input.',
        tip: 'Wire Scene Presence into the amount input of effects inside a scene for per-scene entrances and exits.',
    },
    ScenePresence: {
        title: 'Where am I in the transition?',
        body: 'Use it inside a scene, i.e. anywhere upstream of a Scene Switcher scene input: presence goes 0 → 1 while the scene ' +
            'enters and 1 → 0 while it leaves, following the transition’s duration and easing. Outside a scene it is always 1.',
        tip: 'presence → any effect’s amount (0 = bypass) makes the effect fade in with its scene.',
    },
    TransitionInput: {
        title: 'Only meaningful in a custom transition',
        body: 'Build a Scene Switcher’s custom transition from this node: a and b are the leaving and entering scenes, progress ' +
            'runs 0 → 1 and uv is the frame coordinate. Connect the result to the switcher’s transition input and set its style to custom.',
    },
    Param: {
        title: 'A knob in the Parameters panel',
        body: 'Every Param appears in the Parameters panel (P), whatever group you are looking at or how far you zoom. Its value is a ' +
            'live uniform: dragging it never recompiles the shader. Pick the kind (float, int, bool, vec2-4, color, enum, trigger, image, text) ' +
            'and range in the panel’s settings; double-click the node to find it in the panel, Alt+double-click to rename it.',
        tip: 'Param → amount of an effect, or → the scene input of a Scene Switcher.',
    },
    JS: {
        title: 'JavaScript every frame',
        body: 'Double-click to edit. setup runs once (it may await loadScript(url)); code runs every frame with time, dt, frame, ' +
            'resolution, mouse, audio, params (Param values by label) and a persistent state object. Whatever you return becomes typed ' +
            'outputs: numbers → float, arrays → vecN, booleans → bool, a canvas or texture(…) → sampler2D, { name: value } for several. ' +
            'Outputs are control rate: pushed as live uniforms without recompiling.',
        tip: 'return { wobble: Math.sin(time * 3) * 0.5 + 0.5 } and connect wobble to an effect amount.',
    },
    Sample: {
        title: 'GPU → CPU, one frame late',
        body: 'Reads one pixel of a pixel-rate value back to the CPU so control nodes (Threshold, Counter, Scene Switcher…) can react to ' +
            'what a shader computes. The read is asynchronous, so the value lags one frame.',
    },
    Beat: {
        title: 'Locked to the music',
        body: 'The beat clock comes from the audio menu in the top bar: beat tracking on the mic / file / tab audio, tap tempo or the ' +
            'metronome. pulse flashes on each beat, phase and bar ramp 0..1, time is beat-locked time (a drop-in for Time). ' +
            'clock stable (default) is the published clock: after a track change it holds the old tempo, then glides to the new one, never ' +
            'jumping; raw is the tracker\'s live estimate (diagnostics). gate fade (default) fades pulse while the clock is unsure, hold freezes ' +
            'every output then catches up, off never gates; threshold sets where (on u_beatTrust). The gate output is that fade (1 without live audio). ' +
            'confidence says how locked the tracker is: multiply beat effects by it so they fade in when the beat is found and out when it is lost (0 with audio off).',
        tip: 'Beat.pulse × Beat.confidence → an effect amount (pulse already fades with the gate). Driving your own shape from phase or bar? Multiply it by gate too. No audio yet? Pick Metro in the audio menu.',
    },
    BeatEnvelope: {
        title: 'Shapes for the beat',
        body: 'Turns a phase 0..1 (the beat phase by default) into an envelope: exp decay, a short attack-decay, a sidechain pump, a saw or a sine. ' +
            'k sets how sharp it is. Feed it Beat.bar for one envelope per bar, or fract(x) of anything for your own rhythm. ' +
            'On the built-in beat phase (phase unconnected) gate fade fades it while the beat clock is unsure (a track change; pump fades to no ducking).',
        tip: 'Shape "pump" into a Scale UV amount gives the classic sidechain breathing.',
    },
    BeatDivider: {
        title: 'Events on the beat',
        body: 'Fires every N beats of the stable beat clock (1 = each beat, 4 = each bar, 0.5 = eighths). unsure hold (default) skips the events ' +
            'while the clock is unsure (u_beatTrust < 0.5: right after a track change), so counters and scene pickers don\'t step on beats that ' +
            'are not in the music; fire always fires.',
        tip: 'Beat Divider → Counter → Select Index for a palette that changes every bar.',
    },
    Audio: {
        title: 'Follows the audio menu',
        body: 'level / bass / mid / high are auto-gained 0..1 and kick jumps to 1 on every kick drum. They come from the source chosen in the top-bar ' +
            'audio menu (Mic, File, Tab, Metro): with audio off they stay at 0.',
    },
    Preview: {
        title: 'Your output',
        body: 'Shows whatever you connect. The largest Preview (or the one you set as background from its menu) is what the output window, recording and ' +
            'thumbnails use. Drop any cable on empty canvas to get a quick Preview of it.',
    },
    Comment: {
        title: 'Notes',
        body: 'Double-click to write; # starts a heading and - a bullet. ⌘/Ctrl+Enter finishes, Esc cancels. Notes are not part of the shader.',
    },
};

/** Notes for a node type (hand-written; probes share one). */
export function notesFor(type, def = NodeDefinitions[type]) {
    const out = [];
    if (NOTES[type]) out.push(NOTES[type]);
    else if (def && def.isProbeNode) out.push(PROBE_NOTE);
    if (def && def.isCustomNode) {
        out.push({
            title: 'Your GLSL node',
            body: 'Double-click (or right-click → Edit GLSL…) to change its code. Function parameters become inputs and out / return values become outputs; ' +
                'comments like // @default and // @range above parameters set defaults.',
        });
    }
    return out;
}

/* --------------------------------------------------------------------------
 * Rate
 * ------------------------------------------------------------------------ */

function rateInfo(def) {
    if (!def) return null;
    const inputs = Array.isArray(def.inputs) ? def.inputs : [];
    const outputs = Array.isArray(def.outputs) ? def.outputs : [];
    const controlPorts = inputs.filter(i => i && (i.rate === 'control' || i.cpuInput)).map(i => i.name);
    const pixelPorts = inputs.filter(i => i && i.rate === 'pixel').map(i => i.name);
    const controlOnlyOut = outputs.filter(o => o && CONTROL_ONLY_TYPES.has(o.type)).map(o => o.name);

    let kind = 'pixel';
    let summary;
    if (def.rate === 'control') {
        kind = 'control';
        summary = 'Control rate: runs once per frame in JavaScript, before rendering, and can keep state. Its ports are diamonds and its cables dashed; ' +
            'its outputs reach shaders as live uniforms (changing them never recompiles). Pixel values can’t feed it directly: read one back with a Sample node.';
    } else if (SOURCE_FLAGS.some(f => def[f])) {
        kind = 'source';
        summary = 'CPU source: its values are computed on the CPU and pushed to shaders as live uniforms every frame (control rate), so they can drive control nodes too.';
    } else if (typeof def.evaluate === 'function') {
        kind = 'infer';
        summary = def.cpuSource
            ? 'Adapts to what it is connected to: with control-rate or constant inputs it runs on the CPU (control rate, live uniforms); with a pixel-rate input it runs per pixel in the shader.'
            : 'Adapts to what it is connected to: per pixel in the shader when any input is pixel rate, once per frame on the CPU when all inputs are control rate, and folded into a constant otherwise.';
    } else {
        // Plain pixel nodes: only worth a line when a port says otherwise
        if (!controlPorts.length && !pixelPorts.length && !controlOnlyOut.length) return null;
        summary = 'Pixel rate: computed for every pixel in the shader.';
    }
    const details = [];
    if (controlPorts.length) details.push(`Control-rate input${controlPorts.length > 1 ? 's' : ''}: ${controlPorts.join(', ')}. Connect CPU values (Param, LFO, Counter, JS, MIDI…), not pixel values.`);
    if (pixelPorts.length) details.push(`Pixel-rate input${pixelPorts.length > 1 ? 's' : ''}: ${pixelPorts.join(', ')}. Accepts any shader sub-graph.`);
    if (controlOnlyOut.length) details.push(`Control-only output${controlOnlyOut.length > 1 ? 's' : ''}: ${controlOnlyOut.join(', ')} (event / text / list values only connect to nodes that run in JS).`);
    return { kind, summary, details };
}

/* --------------------------------------------------------------------------
 * Ports
 * ------------------------------------------------------------------------ */

function prettyDefault(v) {
    if (v === undefined || v === null || v === '') return null;
    const s = String(v);
    return s.length > 48 ? s.slice(0, 46) + '…' : s;
}

function functionSignature(fo) {
    if (!fo || typeof fo !== 'object') return null;
    const params = Array.isArray(fo.params) ? fo.params.map(p => `${p.name}: ${p.type}`).join(', ') : '';
    return `(${params}) → ${fo.returns || '?'}`;
}

function inputHelp(inp, def) {
    if (!inp || typeof inp !== 'object') return null;
    const badges = [];
    let text = inp.description || '';
    const fsig = functionSignature(inp.functionOf);
    if (fsig) {
        badges.push({ kind: 'fn', label: 'function' });
        const lead = `Sub-graph input, compiled as a function ${fsig} and evaluated many times per pixel.`;
        text = text ? `${text}. ${lead}` : lead;
    }
    if (inp.rate === 'control' || inp.cpuInput) badges.push({ kind: 'control', label: 'control' });
    else if (inp.rate === 'pixel') badges.push({ kind: 'pixel', label: 'pixel' });
    if (inp.sceneInput) badges.push({ kind: 'scene', label: 'scene' });
    if (inp.optional) badges.push({ kind: 'opt', label: 'optional' });
    if (def.amountInput && inp.name === def.amountInput) {
        badges.push({ kind: 'amount', label: 'amount' });
        if (!text) text = '0 = bypass, 1 = full effect';
    }
    if (!text && inp.sceneInput) text = 'A scene: the sub-graph connected here is shown when this scene is selected.';
    if (!text && inp.type === 'sampler2D') text = 'A texture (Feedback output, camera, video, image Param…).';
    if (!text && inp.type === 'T') text = 'Takes a float or a vector; the output follows its size.';
    if (!text && /^(uv|p)$/.test(inp.name) && inp.type === 'vec2') text = 'Coordinates to evaluate at (defaults to the screen UV).';
    return {
        name: inp.name,
        type: inp.type,
        typeName: typeName(inp.type),
        default: prettyDefault(inp.default),
        description: text,
        badges,
    };
}

function outputHelp(out) {
    if (!out || typeof out !== 'object') return null;
    const badges = CONTROL_ONLY_TYPES.has(out.type) ? [{ kind: 'control', label: 'control only' }] : [];
    return { name: out.name, type: out.type, typeName: typeName(out.type), description: out.description || '', badges };
}

/* --------------------------------------------------------------------------
 * Public
 * ------------------------------------------------------------------------ */

/**
 * @returns {null | {type, title, category, categoryLabel, color, description, notes, inputs, outputs,
 *                   amount, rate, dynamicPorts, isCustom}}
 */
export function helpFor(type) {
    const def = NodeDefinitions[type];
    if (!def) return null;
    const inputs = (Array.isArray(def.inputs) ? def.inputs : []).map(i => inputHelp(i, def)).filter(Boolean);
    const outputs = (Array.isArray(def.outputs) ? def.outputs : []).map(outputHelp).filter(Boolean);

    let amount = null;
    if (def.amountInput) {
        const bypass = def.amountBypass && typeof def.amountBypass === 'object'
            ? Object.entries(def.amountBypass).map(([k, v]) => `${k} = ${v}`)
            : [];
        amount = {
            input: def.amountInput,
            summary: 'The last input, amount (default 1), fades the effect: 0 or less is an exact bypass, 1 is the full effect, and values in ' +
                'between fade it continuously in its own way (angles and offsets scale, zooms move in log space, counts grow) rather than cross-fading. ' +
                'Drive it with a Param, an LFO, Beat or Scene Presence.',
            bypass,
        };
    }

    const category = def.category || 'other';
    let dynamicPorts = null;
    if (def.isJSNode) dynamicPorts = 'Outputs are defined by what the code returns.';
    else if (def.isDynamicInput) dynamicPorts = 'Inputs grow as you connect them.';
    else if (def.isParamNode) dynamicPorts = 'The output type follows the Param’s kind.';

    return {
        type,
        title: nodeTitle(type, def),
        category,
        categoryLabel: categoryLabel(category),
        color: categoryColorFor(category),
        description: def.description || '',
        notes: notesFor(type, def),
        inputs,
        outputs,
        amount,
        rate: rateInfo(def),
        dynamicPorts,
        isCustom: !!def.isCustomNode,
    };
}
