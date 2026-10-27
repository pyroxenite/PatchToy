/**
 * MIDI mappings (MIDI learn) for Param nodes and SceneSwitcher controls.
 *
 * Mappings live in node.data.midi (an array, saved with the project, copied with
 * the node). Each mapping:
 *   id        'm1', 'm2'... (unique per node)
 *   type      'cc' | 'note' | 'pitchbend' | 'aftertouch'
 *   number    CC / note number 0..127 (null for pitchbend / aftertouch)
 *   channel   1..16, 0 = any channel
 *   device    input name it was learned from ('' = any); matched by name, so a
 *             mapping survives unplugging / reconnecting the controller
 *   target    Param: 'value' | 'x' 'y' 'z' 'w' (vecN component) | 'hue' 'sat' 'bright'
 *             'r' 'g' 'b' 'a' (color) | 'option' (enum: this note selects `option`) |
 *             'step' (enum: next option per press)
 *             SceneSwitcher: 'scene' (go to scene `option`) | 'next' | 'prev' | 'select' (knob buckets)
 *   option    option / scene index (target 'option' / 'scene')
 *   mode      CC encoding: 'absolute' | 'relative-2c' (two's complement: 1 = +1, 127 = -1) |
 *             'relative-64' (64-centred: 65 = +1, 63 = -1) | 'relative-sb' (signed bit: 1 = +1, 65 = -1)
 *   press     note / button behaviour: bool 'toggle' | 'momentary'; float/int/vec from a note:
 *             'velocity' (note-on velocity -> value) | 'toggle' | 'momentary' (max while held)
 *   pickup    soft takeover: an absolute control does not move the value until it
 *             passes through the current value (default on for absolute CCs)
 *   invert    reverse the control direction
 *   min, max  range trim inside the Param's range (null = the Param's min / max)
 *   slew      smoothing time in seconds (0 = none)
 *   hires     14-bit CC: number (0..31) = MSB, number + 32 = LSB
 *   sens      relative encoders: ticks scale (1 = 1/128 of the range per tick)
 *   feedback  send the value back to the controller (LED rings, motor faders)
 *
 * MIDI-driven value changes are performance input: they go straight through
 * node.setValue(..., { commit: false }) (no undo step) and the project is saved
 * debounced. Creating / editing / removing a mapping is a project edit.
 */
import { midiService } from './MIDIService.js';
import { normalizeKind, paramRange, valueToUnit, unitToValue, snap, paramLabel, VEC_SIZE } from '../core/paramKinds.js';

export const MIDI_SOURCE_TYPES = ['cc', 'note', 'pitchbend', 'aftertouch'];
export const CC_MODES = ['absolute', 'relative-2c', 'relative-64', 'relative-sb'];
export const CC_MODE_LABEL = {
    absolute: 'Absolute',
    'relative-2c': 'Relative (two’s complement)',
    'relative-64': 'Relative (64-centred)',
    'relative-sb': 'Relative (signed bit)',
};
export const COLOR_TARGETS = ['hue', 'sat', 'bright', 'r', 'g', 'b', 'a'];
export const COLOR_TARGET_LABEL = { hue: 'Hue', sat: 'Saturation', bright: 'Brightness', r: 'Red', g: 'Green', b: 'Blue', a: 'Alpha' };
export const SCENE_TARGETS = ['scene', 'next', 'prev', 'select'];
const COMP = ['x', 'y', 'z', 'w'];
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const LEARN_OBSERVE_MS = 1200;   // watch a freshly learned CC this long to detect encoders / 14-bit
const MAPPABLE = new Set(['float', 'int', 'bool', 'vec2', 'vec3', 'vec4', 'color', 'enum', 'trigger']);

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const numOr = (v, fb) => {
    const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
    return isNum(n) ? n : fb;
};

/** "C3" for note 60 (C3 = middle C, as in Ableton / Yamaha). */
export function noteName(n) {
    const k = Math.round(Number(n));
    if (!(k >= 0 && k <= 127)) return String(n);
    return `${NOTE_NAMES[k % 12]}${Math.floor(k / 12) - 2}`;
}

/** Note number from 60, '60', 'C3', 'c#3', 'Db2'... (null when not a note). */
export function parseNote(v) {
    if (isNum(v)) return Math.round(v);
    const s = String(v ?? '').trim();
    if (/^\d+$/.test(s)) return Number(s);
    const m = /^([a-g])([#b]?)(-?\d+)$/i.exec(s);
    if (!m) return null;
    let k = NOTE_NAMES.indexOf(m[1].toUpperCase());
    if (m[2] === '#') k += 1;
    if (m[2] === 'b') k -= 1;
    const n = (Number(m[3]) + 2) * 12 + k;
    return n >= 0 && n <= 127 ? n : null;
}

export function isMappableParam(node) {
    return !!(node && node.isParamNode && MAPPABLE.has(normalizeKind(node.data.kind)));
}

/** Short source label: "CC 21 · ch1", "Note C3 · ch10", "Pitch bend · ch1". */
export function sourceLabel(m, { channel = true, short = false } = {}) {
    let s;
    if (m.type === 'cc') s = m.hires ? `CC ${m.number}/${m.number + 32}` : `CC ${m.number}`;
    else if (m.type === 'note') s = `Note ${noteName(m.number)}`;
    else if (m.type === 'pitchbend') s = short ? 'Bend' : 'Pitch bend';
    else if (m.type === 'aftertouch') s = short ? 'AT' : 'Aftertouch';
    else s = String(m.type);
    if (channel) s += ` · ${m.channel ? `ch${m.channel}` : 'any ch'}`;
    return s;
}

/** Badge text for a list of mappings ("CC 21 · ch1", "CC 21 / CC 22 · ch1", "3 notes · ch10"). */
export function mappingsLabel(list) {
    if (!list || !list.length) return '';
    if (list.length === 1) return sourceLabel(list[0]);
    const chans = new Set(list.map(m => m.channel));
    const ch = chans.size === 1 ? ` · ${list[0].channel ? `ch${list[0].channel}` : 'any ch'}` : '';
    if (list.length > 2 && list.every(m => m.type === 'note')) return `${list.length} notes${ch}`;
    return list.map(m => sourceLabel(m, { channel: !ch, short: true })).join(' / ') + ch;
}

// ----------------------------------------------------------------------
// Color helpers (hue / saturation / brightness targets)
// ----------------------------------------------------------------------

function rgbToHsv([r, g, b]) {
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const d = max - min;
    let h = 0;
    if (d > 1e-9) {
        if (max === r) h = ((g - b) / d) % 6;
        else if (max === g) h = (b - r) / d + 2;
        else h = (r - g) / d + 4;
        h /= 6;
        if (h < 0) h += 1;
    }
    return [h, max > 0 ? d / max : 0, max];
}

function hsvToRgb([h, s, v]) {
    const i = Math.floor(h * 6);
    const f = h * 6 - i;
    const p = v * (1 - s);
    const q = v * (1 - f * s);
    const t = v * (1 - (1 - f) * s);
    switch (((i % 6) + 6) % 6) {
        case 0: return [v, t, p];
        case 1: return [q, v, p];
        case 2: return [p, v, t];
        case 3: return [p, q, v];
        case 4: return [t, p, v];
        default: return [v, p, q];
    }
}

// ----------------------------------------------------------------------
// Mapping normalization
// ----------------------------------------------------------------------

/** Default target for a node (Param kind or switcher). */
function defaultTarget(node, type) {
    if (node.isSceneSwitcher) return 'scene';
    const kind = normalizeKind(node.data.kind);
    if (kind === 'vec2' || kind === 'vec3' || kind === 'vec4') return 'x';
    if (kind === 'color') return 'hue';
    if (kind === 'enum' && type === 'note') return 'option';
    return 'value';
}

/** Targets that take a continuous 0..1 input (vs press / release). */
export function isContinuousTarget(node, m) {
    if (node.isSceneSwitcher) return m.target === 'select';
    const kind = normalizeKind(node.data.kind);
    if (kind === 'bool' || kind === 'trigger') return false;
    if (kind === 'enum') return m.target === 'value';
    return true;
}

/** Validate + fill a mapping for a node. Throws Error with a readable message. */
export function normalizeMapping(node, raw, existing = []) {
    const m = { ...(raw || {}) };
    const type = String(m.type || '').toLowerCase().replace(/[^a-z]/g, '');
    const alias = { cc: 'cc', controlchange: 'cc', control: 'cc', note: 'note', noteon: 'note', pitchbend: 'pitchbend', bend: 'pitchbend', pb: 'pitchbend', aftertouch: 'aftertouch', at: 'aftertouch', pressure: 'aftertouch', channelpressure: 'aftertouch' };
    m.type = alias[type];
    if (!m.type) throw new Error(`type must be one of ${MIDI_SOURCE_TYPES.join(', ')} (got ${JSON.stringify(raw && raw.type)})`);
    if (m.type === 'cc' || m.type === 'note') {
        const n = m.type === 'note' ? parseNote(m.number) : numOr(m.number, null);
        if (!(n >= 0 && n <= 127)) throw new Error(`${m.type === 'cc' ? 'CC' : 'note'} number must be 0..127${m.type === 'note' ? " or a name like 'C3'" : ''} (got ${JSON.stringify(m.number)})`);
        m.number = Math.round(n);
    } else {
        m.number = null;
    }
    const ch = numOr(m.channel, 0);
    if (!(ch >= 0 && ch <= 16)) throw new Error(`channel must be 1..16 (0 = any), got ${JSON.stringify(m.channel)}`);
    m.channel = Math.round(ch);
    m.device = m.device == null ? '' : String(m.device);
    m.target = m.target == null || m.target === '' ? defaultTarget(node, m.type) : String(m.target).toLowerCase();
    if (node.isSceneSwitcher) {
        if (!SCENE_TARGETS.includes(m.target)) throw new Error(`a SceneSwitcher mapping target is one of ${SCENE_TARGETS.join(', ')}`);
        if (m.target === 'scene') {
            const i = Math.round(numOr(m.option, 0));
            if (!(i >= 0 && i < node.data.scenes.length)) throw new Error(`scene index ${m.option} out of range (0..${node.data.scenes.length - 1})`);
            m.option = i;
        } else delete m.option;
    } else {
        const kind = normalizeKind(node.data.kind);
        if (!MAPPABLE.has(kind)) throw new Error(`a ${kind} param can't be MIDI-mapped`);
        const allowed = kind === 'vec2' || kind === 'vec3' || kind === 'vec4' ? COMP.slice(0, VEC_SIZE[kind])
            : kind === 'color' ? COLOR_TARGETS.filter(t => t !== 'a' || node.data.alpha)
                : kind === 'enum' ? ['value', 'option', 'step'] : ['value'];
        if (m.target === 'value' && allowed[0] !== 'value') m.target = allowed[0];
        if (kind === 'color') {
            const ca = { hsv: 'hue', h: 'hue', saturation: 'sat', s: 'sat', brightness: 'bright', v: 'bright', red: 'r', green: 'g', blue: 'b', alpha: 'a' };
            if (ca[m.target]) m.target = ca[m.target];
        }
        if (!allowed.includes(m.target)) throw new Error(`target for a ${kind} param is one of ${allowed.join(', ')} (got ${JSON.stringify(raw.target)})`);
        if (m.target === 'option') {
            const n = (node.data.options || []).length;
            const i = Math.round(numOr(m.option, 0));
            if (!(i >= 0 && i < n)) throw new Error(`option index ${m.option} out of range (0..${n - 1})`);
            m.option = i;
        } else delete m.option;
    }
    const continuous = isContinuousTarget(node, m);
    if (m.type === 'cc') {
        if (m.mode === undefined || m.mode === null || m.mode === '') m.mode = 'absolute';
        const ma = { relative: 'relative-2c', twos: 'relative-2c', '2c': 'relative-2c', 'twos-complement': 'relative-2c', '64': 'relative-64', offset: 'relative-64', 'binary-offset': 'relative-64', sb: 'relative-sb', 'signed-bit': 'relative-sb', abs: 'absolute' };
        m.mode = ma[m.mode] || m.mode;
        if (!CC_MODES.includes(m.mode)) throw new Error(`mode must be one of ${CC_MODES.join(', ')}`);
        m.hires = !!m.hires && m.number < 32 && m.mode === 'absolute';
    } else {
        delete m.mode;
        m.hires = false;
    }
    const absolute = m.type === 'pitchbend' || m.type === 'aftertouch' || (m.type === 'cc' && m.mode === 'absolute');
    // Soft takeover: default on for absolute CCs (springy pitch bend / aftertouch: off)
    m.pickup = continuous && absolute ? (m.pickup === undefined || m.pickup === null ? m.type === 'cc' : !!m.pickup) : false;
    m.invert = !!m.invert;
    const pressModes = !node.isSceneSwitcher && normalizeKind(node.data.kind) === 'bool' ? ['toggle', 'momentary'] : ['velocity', 'toggle', 'momentary'];
    if (!node.isSceneSwitcher && (normalizeKind(node.data.kind) === 'bool' || (continuous && m.type === 'note'))) {
        const def = normalizeKind(node.data.kind) === 'bool' ? (m.type === 'note' ? 'toggle' : 'momentary') : 'velocity';
        m.press = pressModes.includes(m.press) ? m.press : def;
    } else delete m.press;
    m.min = continuous && m.min !== undefined && m.min !== null && m.min !== '' ? numOr(m.min, null) : null;
    m.max = continuous && m.max !== undefined && m.max !== null && m.max !== '' ? numOr(m.max, null) : null;
    m.slew = continuous ? Math.max(0, Math.min(30, numOr(m.slew, 0))) : 0;
    m.sens = Math.max(0.05, Math.min(64, numOr(m.sens, 1)));
    m.feedback = !!m.feedback;
    if (!m.id || existing.some(o => o.id === m.id && o !== raw)) {
        let k = 1;
        const ids = new Set(existing.map(o => o.id));
        while (ids.has(`m${k}`)) k++;
        m.id = `m${k}`;
    }
    // Keep the stored object compact
    for (const key of Object.keys(m)) if (m[key] === null || m[key] === undefined) delete m[key];
    if (!m.hires) delete m.hires;
    if (!m.pickup) delete m.pickup;
    if (!m.invert) delete m.invert;
    if (!m.slew) delete m.slew;
    if (m.sens === 1) delete m.sens;
    if (!m.feedback) delete m.feedback;
    if (!m.device) delete m.device;
    return m;
}

/** Same physical control (type, number, channel, device). */
function sameSource(a, b) {
    return a.type === b.type && (a.number ?? null) === (b.number ?? null) && (a.channel || 0) === (b.channel || 0) && (a.device || '') === (b.device || '');
}

// ----------------------------------------------------------------------
// The mapper
// ----------------------------------------------------------------------

export class MidiMapper {
    constructor() {
        this.app = null;
        this.state = new Map();      // `${nodeId}:${mappingId}` -> runtime state
        this.learn = null;           // { target, step, learned: [], startedAt }
        this.learnMode = false;      // global learn mode: one target after another
        this.observe = null;         // freshly learned CC under observation (encoder / 14-bit detection)
        this.slewing = new Set();    // state keys with a running slew
        this.slewRaf = 0;
        this.lastSlewT = 0;
        this.capture = null;         // collects effects during simulate()
        this.feedbackDirty = new Set();
        this.feedbackRaf = 0;
        this.activityRaf = 0;
        this.activityIds = new Set();
        this.lastMessage = null;
        this.messageCount = 0;
        this.saveTimer = 0;
        midiService.subscribeRaw('midi-mapper', (ev) => this.handle(ev));
        if (typeof window !== 'undefined') {
            window.addEventListener('patchtoy:param', (e) => {
                const d = e.detail || {};
                if (d.what === 'value' || d.what === undefined) this.queueFeedback(d.id);
            });
            window.addEventListener('patchtoy:midi', (e) => {
                if (e.detail && e.detail.what === 'devices') this.resendFeedback();
            });
        }
    }

    attach(app) {
        this.app = app;
        return this;
    }

    /**
     * A project is replaced: runtime state is keyed by node id, which the next project
     * reuses (pickup / soft-takeover, slew, toggles), and a learn in progress targets an old node.
     */
    resetProject() {
        this.state.clear();
        this.slewing.clear();
        if (this.slewRaf) { try { cancelAnimationFrame(this.slewRaf); } catch (e) { /* ignore */ } this.slewRaf = 0; }
        this.observe = null;
        this.feedbackDirty.clear();
        if (this.learn) this.cancelLearn();
    }

    get graph() {
        return this.app ? this.app.nodeGraph : null;
    }

    emit(what, extra = {}) {
        try {
            window.dispatchEvent(new CustomEvent('patchtoy:midi', { detail: { what, ...extra } }));
        } catch (e) { /* ignore */ }
    }

    // ------------------------------------------------------------------
    // Mappings on nodes
    // ------------------------------------------------------------------

    mappingsOf(node) {
        return node && Array.isArray(node.data && node.data.midi) ? node.data.midi.filter(m => m && typeof m === 'object') : [];
    }

    mappedNodes() {
        const g = this.graph;
        return g ? g.nodes.filter(n => (n.isParamNode || n.isSceneSwitcher) && this.mappingsOf(n).length) : [];
    }

    /** The app's undo history (src/core/History.js), when present. */
    get history() {
        return (this.app && this.app.history) || (this.graph && this.graph.history) || null;
    }

    /**
     * Replace a node's mappings (always a new array: copies of a node never share it).
     * A project edit and its own undo step ("MIDI learn", "Remove MIDI mapping"...):
     * pending MIDI-driven value changes are absorbed first, so the step holds only
     * the mapping. Inside a History batch (an MCP command) the batch is the step.
     */
    setMappings(node, list, { label = 'MIDI mapping', silent = false, amend = false } = {}) {
        const next = (list || []).map(m => ({ ...m }));
        const H = this.history;
        const own = H && !H._restoring && !(H.batchDepth > 0) && typeof H.capture === 'function';
        if (own && !amend) {
            try { H.flush(); } catch (e) { /* history is optional */ }
        }
        if (next.length) node.data.midi = next;
        else delete node.data.midi;
        for (const key of [...this.state.keys()]) {
            if (key.startsWith(`${node.id}:`) && !next.some(m => key === `${node.id}:${m.id}`)) this.state.delete(key);
        }
        if (own) {
            // amend: an automatic refinement of the last step (encoder detection) is absorbed
            try { H.capture(amend ? { silent: true } : { label, sealed: true, mergeable: false }); } catch (e) { /* ignore */ }
        }
        if (!silent) this.changed(node);
        return next;
    }

    /**
     * Run fn without the graph's onUniformValueChanged hook: MIDI is performance
     * input, never an undo step (History treats that hook as "maybe the user's").
     * The project is saved debounced instead.
     */
    quiet(node, fn) {
        const g = node.graph;
        const orig = g && g.onUniformValueChanged;
        if (g) g.onUniformValueChanged = null;
        try {
            return fn();
        } finally {
            if (g) g.onUniformValueChanged = orig;
            this.scheduleSave();
        }
    }

    changed(node) {
        this.app?.projectManager?.markDirty?.();
        this.queueFeedback(node.id);
        this.emit('mappings', { id: node.id });
        try {
            window.dispatchEvent(new CustomEvent('patchtoy:param', { detail: { id: node.id, what: 'midi' } }));
        } catch (e) { /* ignore */ }
    }

    addMapping(node, raw, { replace = 'source', label = 'Map MIDI' } = {}) {
        const list = this.mappingsOf(node);
        const m = normalizeMapping(node, raw, list);
        let next = list;
        if (replace === 'source') next = list.filter(o => !sameSource(o, m));
        if (replace === 'target') next = list.filter(o => !(o.target === m.target && (o.option ?? null) === (m.option ?? null)));
        if (replace === 'all') next = [];
        next = [...next, m];
        this.setMappings(node, next, { label });
        return m;
    }

    updateMapping(node, id, patch, { amend = false } = {}) {
        const list = this.mappingsOf(node);
        const i = list.findIndex(m => m.id === id);
        if (i < 0) throw new Error(`no mapping ${id}`);
        const merged = { ...list[i], ...patch };
        for (const [k, v] of Object.entries(patch)) if (v === null) delete merged[k];
        const m = normalizeMapping(node, merged, list.filter((_, k) => k !== i));
        m.id = list[i].id;
        const next = list.slice();
        next[i] = m;
        this.state.delete(`${node.id}:${id}`); // pickup / relative state restarts
        this.setMappings(node, next, { label: 'Edit MIDI mapping', amend });
        return m;
    }

    removeMapping(node, id) {
        const list = this.mappingsOf(node);
        this.setMappings(node, list.filter(m => m.id !== id), { label: 'Remove MIDI mapping' });
    }

    clearMappings(node) {
        if (this.mappingsOf(node).length) this.setMappings(node, [], { label: 'Clear MIDI mapping' });
    }

    stateOf(node, m) {
        const key = `${node.id}:${m.id}`;
        let st = this.state.get(key);
        if (!st) this.state.set(key, st = { key, picked: false, lastT: null, written: undefined, down: false, lsb: 0, msb: 0, waiting: null, inputAt: 0 });
        return st;
    }

    // ------------------------------------------------------------------
    // Learn
    // ------------------------------------------------------------------

    /**
     * Wait for the next control to map onto target:
     *   { kind: 'param', nodeId }  (vecN: one control per component, enum + notes: one per option)
     *   { kind: 'scene', nodeId, target: 'scene' | 'next' | 'prev', option }
     */
    startLearn(target) {
        this.learn = { target, step: 0, learned: [], startedAt: Date.now() };
        this.emit('learn', { target });
    }

    cancelLearn() {
        if (!this.learn) return;
        const t = this.learn.target;
        this.learn = null;
        this.emit('learn', { target: null, cancelled: t });
    }

    setLearnMode(on) {
        this.learnMode = !!on;
        if (!on) this.cancelLearn();
        this.emit('learn-mode', { on: this.learnMode });
    }

    isLearning(target) {
        const l = this.learn && this.learn.target;
        if (!l || !target) return !!l;
        return l.kind === target.kind && l.nodeId === target.nodeId && (target.kind === 'param' || (l.target === target.target && (l.option ?? null) === (target.option ?? null)));
    }

    /** Text for the learn hint ("Move a control for “Speed”", "… y of “Pos”"). */
    learnHint() {
        const l = this.learn;
        if (!l) return '';
        const node = this.graph && this.graph.nodes.find(n => n.id === l.target.nodeId);
        if (!node) return '';
        if (l.target.kind === 'scene') {
            const what = l.target.target === 'scene' ? `scene “${node.sceneName(l.target.option)}”` : l.target.target === 'next' ? 'next scene' : 'previous scene';
            return `Press a pad / key for ${what}`;
        }
        const kind = normalizeKind(node.data.kind);
        const name = `“${paramLabel(node)}”`;
        if (VEC_SIZE[kind]) return `Move a control for ${COMP[l.step]} of ${name}`;
        if (kind === 'enum' && l.learned.length && l.learned[0].type === 'note') return `Press a note for “${node.data.options[l.step]}” (${name})`;
        if (kind === 'bool' || kind === 'trigger') return `Press a pad / key or a button for ${name}`;
        return `Move a knob or press a key for ${name}`;
    }

    /** A message while learning. Returns true when consumed. */
    learnMessage(ev) {
        const l = this.learn;
        const g = this.graph;
        const node = g && g.nodes.find(n => n.id === l.target.nodeId);
        if (!node) { this.cancelLearn(); return false; }
        let type = null, number = null;
        if (ev.type === 0xB0) { type = 'cc'; number = ev.data1; }
        else if (ev.type === 0x90 && ev.data2 > 0) { type = 'note'; number = ev.data1; }
        else if (ev.type === 0xE0) {
            const v = (ev.data2 << 7) | ev.data1;
            if (Math.abs(v - 8192) < 800) return true; // bend springing back to centre
            type = 'pitchbend';
        } else return ev.type === 0x80 || ev.type === 0x90 || ev.type === 0xD0 || ev.type === 0xA0; // note-off / aftertouch: ignored while learning
        // 14-bit LSB of a CC learned in this session
        if (type === 'cc' && l.learned.some(m => m.type === 'cc' && m.number + 32 === number)) return true;
        const src = { type, number, channel: ev.channel, device: ev.device || '' };
        // A control already learned in this session (still moving): wait for another one
        if (l.learned.some(m => sameSource(m, { ...src, number: type === 'pitchbend' ? null : number }))) return true;

        let m;
        try {
            if (node.isSceneSwitcher) {
                m = this.addMapping(node, { ...src, target: l.target.target, option: l.target.option }, { replace: 'target', label: 'MIDI learn' });
                this.finishLearn(node, m);
                return true;
            }
            const kind = normalizeKind(node.data.kind);
            if (VEC_SIZE[kind]) {
                m = this.addMapping(node, { ...src, target: COMP[l.step] }, { replace: l.step === 0 ? 'all' : 'target', label: 'MIDI learn' });
                l.learned.push(m);
                l.step++;
                this.observeLearned(node, m, ev);
                if (l.step >= VEC_SIZE[kind]) this.finishLearn(node, m);
                else this.emit('learn', { target: l.target, step: l.step });
                return true;
            }
            if (kind === 'enum' && type === 'note') {
                m = this.addMapping(node, { ...src, target: 'option', option: l.step }, { replace: l.step === 0 ? 'all' : 'target', label: 'MIDI learn' });
                l.learned.push(m);
                l.step++;
                if (l.step >= node.data.options.length) this.finishLearn(node, m);
                else this.emit('learn', { target: l.target, step: l.step });
                return true;
            }
            if (kind === 'enum' && l.learned.length) return true; // a CC after notes: ignore
            m = this.addMapping(node, src, { replace: 'all', label: 'MIDI learn' });
            this.observeLearned(node, m, ev);
            this.finishLearn(node, m);
        } catch (e) {
            console.warn('[MIDI learn]', e.message);
            this.cancelLearn();
        }
        return true;
    }

    finishLearn(node, m) {
        const target = this.learn && this.learn.target;
        this.learn = null;
        this.emit('learned', { id: node.id, mapping: m, target });
        this.emit('learn', { target: null });
    }

    /** Watch a freshly learned CC: relative encoder patterns, 14-bit LSB. */
    observeLearned(node, m, ev) {
        if (m.type !== 'cc') return;
        this.observe = { nodeId: node.id, id: m.id, number: m.number, channel: m.channel, values: [ev.data2], lsb: 0, until: Date.now() + LEARN_OBSERVE_MS };
        clearTimeout(this._observeTimer);
        this._observeTimer = setTimeout(() => this.finishObserve(), LEARN_OBSERVE_MS + 20);
    }

    observeMessage(ev) {
        const o = this.observe;
        if (!o || ev.type !== 0xB0 || (o.channel && ev.channel !== o.channel)) return false;
        if (ev.data1 === o.number) {
            o.values.push(ev.data2);
            // Switch to relative as soon as the pattern is clear (before the absolute pickup applies it)
            if (o.values.length >= 10 || (o.values.length >= 3 && MidiMapper.detectEncoding(o.values))) this.finishObserve();
        } else if (ev.data1 === o.number + 32 && o.number < 32) {
            o.lsb++;
            if (o.lsb >= 3) this.finishObserve();
        }
        return false;
    }

    /** Classify the observed values. Absolute knobs never repeat a value while moving. */
    static detectEncoding(values) {
        if (!values || values.length < 3) return null;
        let repeats = 0;
        for (let i = 1; i < values.length; i++) if (values[i] === values[i - 1]) repeats++;
        if (repeats < 1) return null;
        const inR = (v, a, b) => v >= a && v <= b;
        if (values.every(v => inR(v, 1, 15) || inR(v, 113, 127))) return 'relative-2c';
        if (values.every(v => inR(v, 49, 79) && v !== 64)) return 'relative-64';
        if (values.every(v => inR(v, 1, 15) || inR(v, 65, 79)) && values.some(v => v >= 65)) return 'relative-sb';
        return null;
    }

    finishObserve() {
        const o = this.observe;
        if (!o) return;
        this.observe = null;
        clearTimeout(this._observeTimer);
        const node = this.graph && this.graph.nodes.find(n => n.id === o.nodeId);
        if (!node || !this.mappingsOf(node).some(m => m.id === o.id)) return;
        const mode = MidiMapper.detectEncoding(o.values);
        const patch = {};
        if (mode) patch.mode = mode;
        else if (o.lsb >= 2 && o.number < 32) patch.hires = true;
        if (Object.keys(patch).length) {
            try {
                const m = this.updateMapping(node, o.id, patch, { amend: true });
                this.emit('detected', { id: node.id, mapping: m, mode: m.mode, hires: !!m.hires });
            } catch (e) { /* ignore */ }
        }
    }

    // ------------------------------------------------------------------
    // Incoming messages
    // ------------------------------------------------------------------

    matches(m, ev) {
        if (m.channel && ev.channel !== m.channel) return false;
        if (m.device && ev.device && ev.device !== m.device) return false;
        switch (m.type) {
            case 'cc': return ev.type === 0xB0 && (ev.data1 === m.number || (m.hires && ev.data1 === m.number + 32));
            case 'note': return (ev.type === 0x90 || ev.type === 0x80) && ev.data1 === m.number;
            case 'pitchbend': return ev.type === 0xE0;
            case 'aftertouch': return ev.type === 0xD0;
        }
        return false;
    }

    handle(ev) {
        this.messageCount++;
        this.lastMessage = { ...ev, time: Date.now() };
        this.flashActivity(null);
        if (this.observe) this.observeMessage(ev);
        if (this.learn && this.learnMessage(ev)) return;
        const g = this.graph;
        if (!g) return;
        for (const node of g.nodes) {
            if (!node.isParamNode && !node.isSceneSwitcher) continue;
            const list = node.data && node.data.midi;
            if (!Array.isArray(list) || !list.length) continue;
            for (const m of list) {
                if (!m || !this.matches(m, ev)) continue;
                try {
                    const fx = node.isSceneSwitcher ? this.applyScene(node, m, ev) : this.applyParam(node, m, ev);
                    if (fx) {
                        this.flashActivity(node.id);
                        if (this.capture) this.capture.push({ node_id: node.id, mapping: m.id, ...fx });
                    }
                } catch (e) {
                    console.warn('[MIDI] mapping failed:', e.message);
                }
            }
        }
    }

    /** Press / release from a note or a CC-as-button. null = no edge. */
    pressOf(m, ev, st) {
        if (m.type === 'note') return ev.type === 0x90 && ev.data2 > 0 ? 'down' : 'up';
        // Encoder: every tick is a press
        if (m.type === 'cc' && m.mode && m.mode !== 'absolute') return this.inputOf(m, ev, st).delta ? 'down' : null;
        const down = m.type === 'pitchbend' ? Math.abs(((ev.data2 << 7) | ev.data1) - 8192) > 4096
            : m.type === 'aftertouch' ? ev.data1 >= 64 : ev.data2 >= 64;
        const was = st.down;
        st.down = down;
        if (down && !was) return 'down';
        if (!down && was) return 'up';
        return null;
    }

    /** Continuous input t in 0..1 (absolute), or { delta } ticks (relative). */
    inputOf(m, ev, st) {
        if (m.type === 'pitchbend') return { t: ((ev.data2 << 7) | ev.data1) / 16383 };
        if (m.type === 'aftertouch') return { t: ev.data1 / 127 };
        if (m.type === 'note') return { t: ev.type === 0x90 ? ev.data2 / 127 : null, note: ev.type === 0x90 && ev.data2 > 0 ? 'down' : 'up' };
        const v = ev.data2;
        switch (m.mode) {
            case 'relative-2c': return { delta: v === 0 ? 0 : v < 64 ? v : v - 128 };
            case 'relative-64': return { delta: v - 64 };
            case 'relative-sb': return { delta: v === 0 || v === 64 ? 0 : v < 64 ? v : -(v - 64) };
        }
        if (m.hires) {
            if (ev.data1 === m.number) { st.msb = v; st.lsb = 0; }
            else st.lsb = v;
            return { t: ((st.msb << 7) | st.lsb) / 16383 };
        }
        return { t: v / 127 };
    }

    // --- Param targets ---------------------------------------------------

    /** Range used for a target (Param range, or 0..1 for color channels). */
    targetRange(node, m) {
        const kind = normalizeKind(node.data.kind);
        if (kind === 'color') return { min: 0, max: 1, step: 0, scale: 'linear' };
        if (kind === 'enum') return { min: 0, max: Math.max(1, (node.data.options || []).length - 1), step: 1, scale: 'linear' };
        const r = paramRange(node.data);
        return VEC_SIZE[kind] ? { ...r, scale: 'linear' } : r;
    }

    /** Unit-space bounds of a mapping (range trim + invert). */
    unitBounds(node, m) {
        const r = this.targetRange(node, m);
        let u0 = m.min !== undefined && m.min !== null ? valueToUnit(m.min, r) : 0;
        let u1 = m.max !== undefined && m.max !== null ? valueToUnit(m.max, r) : 1;
        if (m.invert) [u0, u1] = [u1, u0];
        return { r, u0, u1 };
    }

    /** The scalar the mapping drives, read from the Param's current value. */
    readTarget(node, m) {
        const d = node.data;
        const kind = normalizeKind(d.kind);
        if (kind === 'float' || kind === 'int' || kind === 'enum') return Number(d.value) || 0;
        const v = Array.isArray(d.value) ? d.value : [];
        if (VEC_SIZE[kind]) return Number(v[COMP.indexOf(m.target)]) || 0;
        if (kind === 'color') {
            if (m.target === 'hue' || m.target === 'sat' || m.target === 'bright') {
                const hsv = rgbToHsv([v[0] || 0, v[1] || 0, v[2] || 0]);
                if (m.target === 'hue' && node._midiHue !== undefined && hsv[1] < 1e-3) return node._midiHue;
                return hsv[m.target === 'hue' ? 0 : m.target === 'sat' ? 1 : 2];
            }
            return Number(v['rgba'.indexOf(m.target)] ?? 1) || 0;
        }
        return 0;
    }

    /** Write the scalar back into the Param (commit: false = no undo, debounced save). */
    writeTarget(node, m, x) {
        const d = node.data;
        const kind = normalizeKind(d.kind);
        const r = this.targetRange(node, m);
        let value;
        if (kind === 'float' || kind === 'int') value = snap(x, r, kind);
        else if (kind === 'enum') value = Math.round(x);
        else if (VEC_SIZE[kind]) {
            value = Array.isArray(d.value) ? [...d.value] : [];
            value[COMP.indexOf(m.target)] = snap(x, r, 'float');
        } else if (kind === 'color') {
            const v = Array.isArray(d.value) ? [...d.value] : [0, 0, 0];
            if (m.target === 'hue' || m.target === 'sat' || m.target === 'bright') {
                const hsv = rgbToHsv([v[0] || 0, v[1] || 0, v[2] || 0]);
                if (m.target === 'hue') {
                    node._midiHue = x;
                    hsv[0] = x >= 1 ? 0.99999 : x;
                    if (hsv[1] < 1e-3) hsv[1] = 1;      // grey has no hue: saturate
                    if (hsv[2] < 1e-3) hsv[2] = 1;
                } else if (node._midiHue !== undefined && hsv[1] < 1e-3) {
                    hsv[0] = node._midiHue;
                }
                if (m.target === 'sat') hsv[1] = x;
                if (m.target === 'bright') hsv[2] = x;
                const rgb = hsvToRgb(hsv);
                v[0] = rgb[0]; v[1] = rgb[1]; v[2] = rgb[2];
            } else {
                v['rgba'.indexOf(m.target)] = clamp01(x);
            }
            value = v;
        } else return null;
        node.setValue(value, { commit: false, source: 'midi' });
        const st = this.stateOf(node, m);
        st.written = this.readTarget(node, m);
        this.scheduleSave();
        return node.data.value;
    }

    applyParam(node, m, ev) {
        const kind = normalizeKind(node.data.kind);
        const st = this.stateOf(node, m);
        st.inputAt = performance.now();

        if (kind === 'trigger') {
            if (this.pressOf(m, ev, st) !== 'down') return null;
            this.quiet(node, () => node.press());
            return { pulse: true, value: node.data.value };
        }
        if (kind === 'bool') {
            const p = this.pressOf(m, ev, st);
            if (!p) return null;
            let next = !!node.data.value;
            if (m.press === 'momentary') next = p === 'down';
            else if (p === 'down') next = !next;
            else return null;
            node.setValue(next, { commit: false, source: 'midi' });
            this.scheduleSave();
            return { value: next };
        }
        if (kind === 'enum') {
            const n = (node.data.options || []).length;
            if (m.target === 'option' || m.target === 'step') {
                if (this.pressOf(m, ev, st) !== 'down') return null;
                const next = m.target === 'option' ? m.option : ((Math.round(node.data.value) || 0) + 1) % n;
                node.setValue(next, { commit: false, source: 'midi' });
                this.scheduleSave();
                return { value: next, selected: node.data.options[next] };
            }
            const inp = this.inputOf(m, ev, st);
            if (inp.delta !== undefined) {
                if (!inp.delta) return null;
                const next = Math.max(0, Math.min(n - 1, (Math.round(node.data.value) || 0) + Math.sign(inp.delta) * (m.invert ? -1 : 1)));
                node.setValue(next, { commit: false, source: 'midi' });
                this.scheduleSave();
                return { value: next, selected: node.data.options[next] };
            }
            if (inp.t === null || inp.t === undefined) return null;
            // Buckets over the (trimmed) option range
            const { u0, u1 } = this.unitBounds(node, m);
            const u = u0 + (u1 - u0) * inp.t;
            const next = Math.max(0, Math.min(n - 1, Math.floor(u * n - 1e-9 * Math.sign(u))));
            if (next === Math.round(node.data.value)) return null;
            node.setValue(next, { commit: false, source: 'midi' });
            this.scheduleSave();
            return { value: next, selected: node.data.options[next] };
        }

        // Continuous targets: float, int, vecN components, color channels
        const { r, u0, u1 } = this.unitBounds(node, m);
        const span = u1 - u0;
        const cur = this.readTarget(node, m);
        // Something else moved the value (UI, scene, MCP): pick up again
        if (st.written !== undefined && Math.abs(cur - st.written) > 1e-6 * Math.max(1, Math.abs(r.max - r.min)) && !this.slewing.has(st.key)) {
            st.picked = false;
            st.written = undefined;
        }
        const curT = Math.abs(span) > 1e-12 ? clamp01((valueToUnit(cur, r) - u0) / span) : 0;
        const inp = this.inputOf(m, ev, st);
        let t;
        if (inp.delta !== undefined) {
            if (!inp.delta) return null;
            const base = st.target !== undefined && this.slewing.has(st.key) ? clamp01((valueToUnit(st.target, r) - u0) / (span || 1)) : curT;
            const per = kind === 'int' ? Math.max(1 / 128, 1 / Math.max(1, Math.abs(r.max - r.min) * Math.abs(span))) : 1 / 128;
            t = clamp01(base + inp.delta * per * (m.sens || 1));
            st.picked = true;
        } else if (m.type === 'note') {
            const press = m.press || 'velocity';
            if (press === 'velocity') {
                if (inp.note !== 'down') return null;
                t = inp.t;
            } else if (press === 'momentary') {
                t = inp.note === 'down' ? 1 : 0;
            } else {
                if (inp.note !== 'down') return null;
                t = curT > 0.5 ? 0 : 1;
            }
        } else {
            if (inp.t === null || inp.t === undefined) return null;
            t = inp.t;
            if (m.pickup && !st.picked) {
                const tol = m.hires || m.type === 'pitchbend' ? 0.006 : 1.5 / 127;
                const crossed = st.lastT !== null && (st.lastT - curT) * (t - curT) <= 0;
                if (Math.abs(t - curT) <= tol || crossed) {
                    st.picked = true;
                    st.waiting = null;
                } else {
                    st.lastT = t;
                    const waiting = t < curT ? 'up' : 'down';
                    if (st.waiting !== waiting) {
                        st.waiting = waiting;
                        this.emit('pickup', { id: node.id, mapping: m.id, waiting });
                    }
                    return { pickup: 'waiting', knob: +t.toFixed(4), value_at: +curT.toFixed(4) };
                }
            }
            st.lastT = t;
        }
        if (st.waiting) {
            st.waiting = null;
            this.emit('pickup', { id: node.id, mapping: m.id, waiting: null });
        }
        const x = unitToValue(u0 + span * t, r);
        if (m.slew > 0) {
            st.target = x;
            if (st.cur === undefined || !this.slewing.has(st.key)) st.cur = cur;
            st.nodeId = node.id;
            st.mapping = m;
            st.tau = m.slew / 3; // ~95 % of the way after `slew` seconds
            this.slewing.add(st.key);
            this.startSlew();
            return { target: x, slew: m.slew };
        }
        const value = this.writeTarget(node, m, x);
        return { value };
    }

    // --- Smoothing (slew) --------------------------------------------------

    startSlew() {
        if (this.slewRaf) return;
        this.lastSlewT = performance.now();
        const step = () => {
            this.slewRaf = 0;
            const now = performance.now();
            const dt = Math.min(0.1, Math.max(0, (now - this.lastSlewT) / 1000));
            this.lastSlewT = now;
            const g = this.graph;
            for (const key of [...this.slewing]) {
                const st = this.state.get(key);
                const node = st && g && g.nodes.find(n => n.id === st.nodeId);
                if (!st || !node) { this.slewing.delete(key); continue; }
                const m = this.mappingsOf(node).find(x => x.id === st.mapping.id);
                if (!m) { this.slewing.delete(key); continue; }
                const r = this.targetRange(node, m);
                const k = 1 - Math.exp(-dt / Math.max(1e-3, st.tau));
                const spanAbs = Math.max(1e-6, Math.abs(r.max - r.min));
                const diff = st.target - st.cur;
                // Exponential glide with a minimum speed, so the tail ends
                let delta = diff * k;
                const minStep = spanAbs * dt / Math.max(1e-3, st.tau * 3) * 0.25;
                if (Math.abs(delta) < minStep) delta = Math.sign(diff) * Math.min(Math.abs(diff), minStep);
                st.cur += delta;
                const done = Math.abs(st.target - st.cur) <= 1e-5 * spanAbs;
                if (done) st.cur = st.target;
                this.writeTarget(node, m, st.cur);
                this.flashActivity(node.id);
                if (done) this.slewing.delete(key);
            }
            if (this.slewing.size) this.slewRaf = requestAnimationFrame(step);
        };
        this.slewRaf = requestAnimationFrame(step);
    }

    // --- Scene targets -----------------------------------------------------

    applyScene(sw, m, ev) {
        const st = this.stateOf(sw, m);
        if (m.target === 'select') {
            const inp = this.inputOf(m, ev, st);
            const n = sw.data.scenes.length;
            let i;
            if (inp.delta !== undefined) {
                if (!inp.delta) return null;
                return { scene: this.quiet(sw, () => sw.nextScene(Math.sign(inp.delta) * (m.invert ? -1 : 1), { source: 'midi' })) };
            }
            if (inp.t === null || inp.t === undefined) return null;
            const t = m.invert ? 1 - inp.t : inp.t;
            i = Math.max(0, Math.min(n - 1, Math.floor(t * n - 1e-9)));
            const cur = sw.state && sw.state.active ? sw.state.b : sw.data.current;
            if (i === cur || i === st.lastScene) return null;
            st.lastScene = i;
            return { scene: this.quiet(sw, () => sw.requestScene(i, { source: 'midi' })) };
        }
        if (this.pressOf(m, ev, st) !== 'down') return null;
        if (m.target === 'scene') return { scene: this.quiet(sw, () => sw.requestScene(m.option, { source: 'midi' })) };
        return { scene: this.quiet(sw, () => sw.nextScene(m.target === 'prev' ? -1 : 1, { source: 'midi' })) };
    }

    // ------------------------------------------------------------------
    // Feedback: activity flash, MIDI out echo, save
    // ------------------------------------------------------------------

    flashActivity(id) {
        if (id !== null && id !== undefined) this.activityIds.add(id);
        if (this.activityRaf) return;
        const flush = () => {
            this.activityRaf = 0;
            const ids = [...this.activityIds];
            this.activityIds.clear();
            this.emit('activity', { ids, message: this.lastMessage });
        };
        this.activityRaf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(flush) : setTimeout(flush, 16);
    }

    scheduleSave() {
        clearTimeout(this.saveTimer);
        this.saveTimer = setTimeout(() => {
            const app = this.app;
            if (!app) return;
            if (typeof app.debouncedSave === 'function') app.debouncedSave();
            else app.projectManager?.saveGraph?.();
        }, 400);
    }

    queueFeedback(id) {
        if (id === undefined || id === null || !midiService.isEnabled) return;
        this.feedbackDirty.add(id);
        if (this.feedbackRaf) return;
        this.feedbackRaf = requestAnimationFrame(() => {
            this.feedbackRaf = 0;
            const ids = [...this.feedbackDirty];
            this.feedbackDirty.clear();
            const g = this.graph;
            if (!g) return;
            for (const id2 of ids) {
                const node = g.nodes.find(n => n.id === id2);
                if (node) this.sendFeedback(node);
            }
        });
    }

    resendFeedback() {
        for (const n of this.mappedNodes()) this.sendFeedback(n, { force: true });
    }

    /** Echo the node's value to the controller (mappings with feedback: true). */
    sendFeedback(node, { force = false } = {}) {
        if (!midiService.isEnabled) return 0;
        let sent = 0;
        for (const m of this.mappingsOf(node)) {
            if (!m.feedback) continue;
            const st = this.stateOf(node, m);
            // Don't fight the hand on the control that caused the change
            if (!force && performance.now() - st.inputAt < 150) continue;
            const bytes = this.feedbackBytes(node, m);
            if (!bytes) continue;
            const sig = bytes.join(',');
            if (!force && st.lastSent === sig) continue;
            st.lastSent = sig;
            for (const b of bytes.length > 3 ? [bytes.slice(0, 3), bytes.slice(3)] : [bytes]) sent += midiService.send(m.device || '', b);
        }
        return sent;
    }

    /** MIDI bytes representing the current value for a mapping (null = nothing to send). */
    feedbackBytes(node, m) {
        const ch = Math.max(0, (m.channel || 1) - 1);
        let t;
        if (node.isSceneSwitcher) {
            const cur = node.data.current;
            if (m.target === 'scene') t = cur === m.option ? 1 : 0;
            else if (m.target === 'select') t = node.data.scenes.length > 1 ? cur / (node.data.scenes.length - 1) : 0;
            else return null;
        } else {
            const kind = normalizeKind(node.data.kind);
            if (kind === 'trigger') return null;
            if (kind === 'bool') t = node.data.value ? 1 : 0;
            else if (kind === 'enum' && m.target === 'option') t = Math.round(node.data.value) === m.option ? 1 : 0;
            else if (kind === 'enum' && m.target === 'step') return null;
            else {
                const { r, u0, u1 } = this.unitBounds(node, m);
                const span = u1 - u0;
                t = Math.abs(span) > 1e-12 ? clamp01((valueToUnit(this.readTarget(node, m), r) - u0) / span) : 0;
            }
        }
        if (m.type === 'note') return [0x90 | ch, m.number, t >= 0.5 ? 127 : 0];
        if (m.type === 'pitchbend') {
            const v = Math.round(t * 16383);
            return [0xE0 | ch, v & 0x7F, (v >> 7) & 0x7F];
        }
        if (m.type === 'aftertouch') return null;
        if (m.mode && m.mode !== 'absolute') return [0xB0 | ch, m.number, Math.round(t * 127)]; // LED rings take absolute values
        if (m.hires) {
            const v = Math.round(t * 16383);
            return [0xB0 | ch, m.number, (v >> 7) & 0x7F, 0xB0 | ch, m.number + 32, v & 0x7F];
        }
        return [0xB0 | ch, m.number, Math.round(t * 127)];
    }

    // ------------------------------------------------------------------
    // Description (MCP list_params / UI)
    // ------------------------------------------------------------------

    describe(node, m) {
        const st = this.state.get(`${node.id}:${m.id}`);
        const out = { ...m, label: sourceLabel(m) };
        if (m.type === 'note') out.note = noteName(m.number);
        if (m.pickup) out.picked_up = !!(st && st.picked);
        if (st && st.waiting) out.pickup_waiting = st.waiting;
        if (m.target === 'option' && node.isParamNode) out.option_name = node.data.options?.[m.option];
        if (m.target === 'scene' && node.isSceneSwitcher) out.scene_name = node.sceneName(m.option);
        return out;
    }

    /** Pickup status of a node's mappings ('up' / 'down' = turn the knob that way). */
    pickupWaiting(node) {
        for (const m of this.mappingsOf(node)) {
            const st = this.state.get(`${node.id}:${m.id}`);
            if (st && st.waiting) return st.waiting;
        }
        return null;
    }

    /**
     * Feed raw messages as if a device sent them (tests / MCP simulate_midi).
     * Returns the effects on mapped Params / switchers.
     */
    simulate(messages, device = '') {
        const effects = [];
        const prev = this.capture;
        this.capture = effects;
        try {
            for (const msg of messages) midiService.simulate(msg, device);
        } finally {
            this.capture = prev;
        }
        return effects;
    }
}

export const midiMapper = new MidiMapper();
