import { Node } from './Node.js';
import { COLORS, FONTS, LAYOUT, CANVAS } from '../ui/theme.js';
import { drawLabel, drawTag, fitText, withAlpha } from '../rendering/NodePainter.js';
import { clock } from '../core/Clock.js';
import { loopTrace } from '../core/loopTrace.js';
import { SWITCHER_CONTROL_INPUTS, sceneInputDef } from '../core/library/scenes.js';
import { TRANSITION_BY_KEY, TRANSITION_KEYS, transitionKey, ease, EASING_KEYS, AUTO_MODES } from '../core/scenes.js';
import { controlValueOf } from '../core/control/ControlRuntime.js';

const CONTROL_COUNT = SWITCHER_CONTROL_INPUTS.length;
const ROW_H = LAYOUT.portSpacing;
const FOOTER_H = 16;
const clamp01 = x => (x < 0 ? 0 : x > 1 ? 1 : x);
let appRef = null; // the PatchToy app (shader compiler id mapping), set by tickScenes

/** Notify UI (Parameters panel Scenes section) that a switcher changed. */
export function emitSceneChange(node, what = 'state') {
    try {
        window.dispatchEvent(new CustomEvent('patchtoy:scene', { detail: { id: node.id, what } }));
    } catch (e) { /* ignore */ }
}

/**
 * Value of a CPU-readable source connected to input `inputIndex` of `node`:
 * Param, JS, Float/Int constants, MIDI CC, live sources (Keyboard, XYPad, MidiNote)
 * and other SceneSwitchers. undefined = not connected, null = not readable on the CPU.
 */
export function cpuInputValue(node, inputIndex) {
    const g = node.graph;
    if (!g) return undefined;
    const c = g.connections.find(k => k.toNode === node && k.toInput === inputIndex);
    if (!c) return undefined;
    const src = c.fromNode;
    const port = src.outputs[c.fromOutput] || {};
    let v;
    const ctl = controlValueOf(c); // control-rate nodes (Counter, LFO, math on Params...)
    if (ctl !== undefined) {
        v = ctl;
    } else if (src.isParamNode) {
        if (port.name === 'pulse') v = src.pulse ? 1 : 0;
        else if (port.name === 'since') v = Math.max(0, clock.u.time - (src.pressTime || 0));
        else v = src.data.value;
    } else if (src.isJSNode && typeof src.getOutputValue === 'function') {
        v = src.getOutputValue(c.fromOutput);
    } else if (src.isSceneSwitcher) {
        const u = src.computeUniforms();
        v = port.name === 'progress' ? u.p : port.name === 'index' ? u.idx : null;
    } else if (src.definition && src.definition.isConstantNode) {
        v = src.data.value !== undefined ? src.data.value : src.data.x;
    } else if (src.isMidiCCNode && typeof src.getValue === 'function') {
        v = src.getValue();
    } else if (typeof src.getUniformValue === 'function') {
        v = src.getUniformValue();
    } else {
        return null;
    }
    if (Array.isArray(v)) {
        const acc = String(c.accessor || '').replace(/^\./, '');
        const comp = acc ? 'xyzwrgba'.indexOf(acc[0]) % 4 : 0;
        v = v[Math.max(0, comp)];
    }
    if (typeof v === 'boolean') v = v ? 1 : 0;
    v = Number(v);
    return Number.isFinite(v) ? v : null;
}

/**
 * SceneSwitcher runtime + canvas UI. data (saved): scenes [{name, transition?, duration?}],
 * current, transition, duration, durationUnit, easing, angle, softness, strength, auto,
 * autoBars, autoSeconds, playlist. Runtime (not saved): the running transition.
 *
 * Every frame tick() reads the CPU inputs and auto mode, advances the transition and
 * pushes the uniforms (node_S_a/_b scene indices, _k0/_k1 loop range, _st style,
 * _p eased progress, _pres presence + phase of a/b, _tp transition params, _idx).
 */
/** Auto-advance hold while the live beat is untrusted (ms), see the auto-advance in the per-frame update. */
const AUTO_HOLD_MS = 8000;

export class SceneSwitcherNode extends Node {
    constructor(id, type, x, y) {
        super(id, type, x, y);
        this.isSceneSwitcher = true;
        this.isDynamicInput = true;
        this.width = 196;
        this.fixedWidth = true;
        this.state = { a: 0, b: 0, p: 0, active: false, style: 'crossfade', duration: 2 };
        this.pin = null;            // render_preview: { a, b, p, style } (p eased)
        this._pending = null;       // options of the next transition (style / duration override)
        this._lastSceneInput = undefined;
        this._lastNextInput = undefined;
        this._lastBar = undefined;
        this._sinceSwitch = 0;
        this._lastTime = null;
        this._pushedSig = null;
        this.rebuildTextInputs();
    }

    // ------------------------------------------------------------------
    // Data / ports
    // ------------------------------------------------------------------

    normalizeData() {
        const d = this.data;
        if (!Array.isArray(d.scenes) || !d.scenes.length) d.scenes = [{ name: 'Scene 1' }, { name: 'Scene 2' }];
        d.scenes = d.scenes.map((s, i) => {
            const o = (s && typeof s === 'object') ? { ...s } : { name: String(s ?? '') };
            o.name = String(o.name || '').trim() || `Scene ${i + 1}`;
            if (o.transition !== undefined) {
                const k = transitionKey(o.transition);
                if (k) o.transition = k; else delete o.transition;
            }
            if (o.duration !== undefined && !(Number(o.duration) >= 0)) delete o.duration;
            return o;
        });
        d.transition = transitionKey(d.transition) || 'crossfade';
        d.easing = EASING_KEYS.includes(d.easing) ? d.easing : 'smooth';
        d.auto = AUTO_MODES.includes(d.auto) ? d.auto : 'off';
        d.durationUnit = d.durationUnit === 'beats' ? 'beats' : 'seconds';
        for (const [k, def] of [['duration', 2], ['angle', 0], ['softness', 0.3], ['strength', 1], ['autoBars', 8], ['autoSeconds', 12]]) {
            const n = Number(d[k]);
            d[k] = Number.isFinite(n) ? n : def;
        }
        d.duration = Math.max(0, d.duration);
        d.autoBars = Math.max(1, Math.round(d.autoBars));
        d.autoSeconds = Math.max(0.5, d.autoSeconds);
        d.playlist = Array.isArray(d.playlist) ? d.playlist.map(Number).filter(i => Number.isInteger(i) && i >= 0 && i < d.scenes.length) : [];
        d.current = this.clampIndex(d.current);
    }

    clampIndex(i) {
        const n = (this.data.scenes || []).length;
        const v = Math.round(Number(i));
        return Number.isFinite(v) ? Math.max(0, Math.min(n - 1, v)) : 0;
    }

    /** Ports: control inputs, one input per scene, plus a free input that adds a scene. */
    syncPorts() {
        const n = this.data.scenes.length;
        const want = [...SWITCHER_CONTROL_INPUTS.map(p => ({ ...p })), ...Array.from({ length: n + 1 }, (_, k) => sceneInputDef(k))];
        const same = want.length === this.inputs.length && want.every((p, i) => this.inputs[i] && this.inputs[i].name === p.name);
        if (!same) this.inputs = want;
        // Drop cables to inputs that no longer exist
        const g = this.graph;
        if (g && Array.isArray(g.connections)) g.connections = g.connections.filter(c => c.toNode !== this || c.toInput < this.inputs.length);
        this.updateDimensions();
    }

    /** Data replaced (load, paste, set_node_data): normalize, rebuild ports, settle on data.current. */
    rebuildTextInputs() {
        this.normalizeData();
        this.syncPorts();
        if (!this.state.active) this.state.a = this.state.b = this.data.current;
        emitSceneChange(this, 'meta');
    }

    updateDimensions() {
        const rows = Math.max(this.inputs.length, this.outputs.length, 1);
        this.height = this.heightForRows(rows, FOOTER_H);
    }

    get sceneCount() {
        return this.data.scenes.length;
    }

    sceneName(i) {
        const s = this.data.scenes[i];
        return s ? s.name : `Scene ${i + 1}`;
    }

    /** Scene index of input port i (-1 for control inputs). The free last input maps to the next scene. */
    sceneIndexOfInput(i) {
        const k = i - CONTROL_COUNT;
        return k >= 0 && i < this.inputs.length ? k : -1;
    }

    inputIndexOfScene(k) {
        return CONTROL_COUNT + k;
    }

    isSceneConnected(k) {
        const g = this.graph;
        const idx = this.inputIndexOfScene(k);
        return !!g && g.connections.some(c => c.toNode === this && c.toInput === idx);
    }

    /** Resolve a scene reference: index, numeric string or (case-insensitive) name. */
    resolveScene(ref) {
        if (typeof ref === 'number' && Number.isFinite(ref)) return Math.round(ref) >= 0 && Math.round(ref) < this.sceneCount ? Math.round(ref) : -1;
        const s = String(ref ?? '').trim();
        if (/^-?\d+$/.test(s)) return this.resolveScene(parseInt(s, 10));
        const low = s.toLowerCase();
        const i = this.data.scenes.findIndex(x => x.name.toLowerCase() === low);
        return i >= 0 ? i : this.data.scenes.findIndex(x => x.name.toLowerCase().startsWith(low));
    }

    // Connecting the free last input adds a scene (NodeGraph / automation call these)
    shouldAddNewInput() {
        return this.isSceneConnected(this.sceneCount);
    }

    addDynamicInput() {
        this.data.scenes.push({ name: `Scene ${this.sceneCount + 1}` });
        this.syncPorts();
        emitSceneChange(this, 'meta');
        return true;
    }

    removeDynamicInput() {
        return false;
    }

    getInputPortLabel(i) {
        const k = this.sceneIndexOfInput(i);
        if (k < 0) return this.inputs[i].name;
        if (k >= this.sceneCount) return '+ scene';
        return `${k + 1} ${this.sceneName(k)}`;
    }

    // ------------------------------------------------------------------
    // Selection
    // ------------------------------------------------------------------

    /**
     * Go to a scene. opts: transition (style key), duration (seconds or beats, see
     * data.durationUnit), instant, source ('ui' | 'input' | 'auto' | 'mcp').
     * Returns the resolved index or -1.
     */
    requestScene(ref, opts = {}) {
        const i = this.resolveScene(ref);
        if (i < 0) return -1;
        const pending = {};
        const st = transitionKey(opts.transition);
        if (st) pending.transition = st;
        if (opts.instant) pending.transition = 'cut';
        if (opts.duration !== undefined && Number(opts.duration) >= 0) pending.duration = Number(opts.duration);
        this._pending = Object.keys(pending).length ? pending : null;
        this.data.current = i;
        // Keep a wired Param selector in sync (the cable stays the source of truth)
        if (opts.source !== 'input') this._writeThrough(i);
        this.tick({ advance: false });
        if (this.graph && this.graph.onUniformValueChanged) this.graph.onUniformValueChanged(this);
        if (this.graph && this.graph.render) this.graph.render();
        emitSceneChange(this, 'state');
        return i;
    }

    /** UI edits of runtime fields (transition, duration, easing, auto, scene names...): no recompile. */
    setOptions(patch = {}) {
        for (const [k, v] of Object.entries(patch)) {
            if (k === 'sceneName') continue;
            this.data[k] = v;
        }
        if (patch.sceneName) {
            const { index, name } = patch.sceneName;
            if (this.data.scenes[index]) this.data.scenes[index].name = String(name || '').trim() || `Scene ${index + 1}`;
        }
        if (patch.auto !== undefined) { this._lastBar = undefined; this._sinceSwitch = 0; }
        this.normalizeData();
        this.pushUniforms(true);
        if (this.graph && this.graph.onUniformValueChanged) this.graph.onUniformValueChanged(this);
        if (this.graph && this.graph.render) this.graph.render();
        emitSceneChange(this, patch.sceneName ? 'meta' : 'state');
    }

    /** Next (dir 1) / previous (-1) scene: the playlist, else every connected scene in order. */
    nextScene(dir = 1, opts = {}) {
        let order = this.data.playlist.length ? this.data.playlist : this.data.scenes.map((_, i) => i).filter(i => this.isSceneConnected(i));
        if (!order.length) order = this.data.scenes.map((_, i) => i);
        const cur = this.state.active ? this.state.b : this.data.current;
        const pos = order.indexOf(cur);
        const next = pos < 0 ? order[0] : order[(pos + dir + order.length) % order.length];
        return this.requestScene(next, opts);
    }

    _writeThrough(i) {
        const g = this.graph;
        if (!g) return;
        const c = g.connections.find(k => k.toNode === this && k.toInput === 0);
        if (!c || !c.fromNode.isParamNode || typeof c.fromNode.setValue !== 'function') return;
        const kind = c.fromNode.data.kind;
        if (!['float', 'int', 'enum'].includes(kind)) return;
        try { c.fromNode.setValue(i); } catch (e) { /* out of range etc. */ }
        this._lastSceneInput = i;
    }

    // ------------------------------------------------------------------
    // Runtime
    // ------------------------------------------------------------------

    transitionFor(target) {
        const p = this._pending || {};
        const s = this.data.scenes[target] || {};
        const style = p.transition || s.transition || this.data.transition || 'crossfade';
        let dur = p.duration !== undefined ? p.duration : (s.duration !== undefined ? Number(s.duration) : this.data.duration);
        if (this.data.durationUnit === 'beats') dur = dur * 60 / (clock.u.bpm > 0 ? clock.u.bpm : 120);
        return { style, duration: Math.max(0, dur) };
    }

    /** Per frame (tickScenes). opts.advance = false: apply a request without advancing time. */
    tick({ advance = true } = {}) {
        const S = this.state;
        const d = this.data;
        let dt = 0;
        if (advance) {
            const t = clock.u.time;
            dt = this._lastTime === null ? 0 : Math.max(0, Math.min(0.25, t - this._lastTime));
            this._lastTime = t;

            // CPU inputs: scene selector and next trigger
            const sv = cpuInputValue(this, 0);
            if (typeof sv === 'number') {
                const idx = this.clampIndex(sv);
                if (this._lastSceneInput === undefined) {
                    this._lastSceneInput = idx;
                    if (idx !== d.current && !S.active) { d.current = S.a = S.b = idx; emitSceneChange(this); }
                } else if (idx !== this._lastSceneInput) {
                    this._lastSceneInput = idx;
                    this.requestScene(idx, { source: 'input' });
                }
            } else {
                this._lastSceneInput = undefined;
            }
            const nv = cpuInputValue(this, 1);
            if (typeof nv === 'number') {
                const last = this._lastNextInput;
                this._lastNextInput = nv;
                if (last !== undefined && nv > last && (nv - last >= 0.5 || (last < 0.5 && nv >= 0.5))) this.nextScene(1, { source: 'input' });
            } else {
                this._lastNextInput = undefined;
            }

            // Auto advance ('music': on bars while audio / the metronome drives the beat clock).
            // While live music drives the clock but its beat is not trusted (the published clock
            // coasts: a track change), bars / music hold for up to AUTO_HOLD_MS: no switch on the
            // coasting bars (a bar boundary passed meanwhile is skipped), and music does not drop to
            // its seconds timer on the spot (that switched right at the track change). Past that
            // (music without a beat), bars count the coasting clock and music falls back to seconds,
            // its timer starting then.
            const unsure = clock.untrustedMs();
            const holding = (d.auto === 'bars' || d.auto === 'music') && unsure > 0 && unsure < AUTO_HOLD_MS;
            const auto = holding ? 'hold'
                : d.auto === 'music' ? (clock.mode === 'metronome' || (clock.following && clock.trusted) ? 'bars' : 'seconds') : d.auto;
            if (auto === 'bars' || auto === 'hold') {
                const bar = Math.floor((clock.u.beatCount || 0) / (4 * d.autoBars));
                if (auto === 'bars' && this._lastBar !== undefined && bar !== this._lastBar && !S.active) this.nextScene(1, { source: 'auto' });
                this._lastBar = bar;
            } else {
                this._lastBar = undefined;
            }
            if (d.auto === 'music' && auto !== 'seconds') this._sinceSwitch = 0;
            this._sinceSwitch += dt;
            if (auto === 'seconds' && !S.active && this._sinceSwitch >= d.autoSeconds) this.nextScene(1, { source: 'auto' });
        }

        // Start / reverse a transition when the target changed
        const target = this.clampIndex(d.current);
        if (target !== S.b) {
            if (S.active && target === S.a) {
                S.a = S.b;
                S.b = target;
                S.p = 1 - S.p;
            } else {
                const e = ease(d.easing, S.p);
                const from = S.active ? (e < 0.5 ? S.a : S.b) : S.b;
                const { style, duration } = this.transitionFor(target);
                S.a = from;
                S.b = target;
                S.p = 0;
                S.style = style;
                S.duration = duration;
                S.active = style !== 'cut' && duration > 0.001 && from !== target;
                if (!S.active) S.a = target;
            }
            this._pending = null;
            this._sinceSwitch = 0;
            if (this.graph && this.graph.render) this.graph.render();
            emitSceneChange(this, 'state');
        }
        if (S.active && advance) {
            S.p += dt / Math.max(1e-3, S.duration);
            if (S.p >= 1) {
                S.active = false;
                S.p = 0;
                S.a = S.b;
                emitSceneChange(this, 'state');
            }
        }
        this.pushUniforms();
    }

    /** Uniform values for the current (or pinned) state. */
    computeUniforms() {
        const d = this.data;
        const pin = this.pin;
        const S = pin ? { a: pin.a, b: pin.b, active: pin.a !== pin.b && pin.p > 0 && pin.p < 1, style: pin.style || 'crossfade' } : this.state;
        const active = !!S.active;
        const e = pin ? clamp01(pin.p) : (active ? ease(d.easing, S.p) : 0);
        const T = TRANSITION_BY_KEY[S.style] || TRANSITION_BY_KEY.crossfade;
        let a = S.a, b = S.b;
        if (pin && !active) { a = b = (pin.p >= 1 ? pin.b : pin.a); }
        let k0 = 0, k1 = 1;
        let pres = [1, 1, 0, 0];
        if (active) {
            if (T.single) {
                if (e >= 0.5) { k0 = 1; k1 = 2; }
            } else {
                k1 = 2;
            }
            if (T.presence === 'halves') {
                const out = clamp01(2 * e), inn = clamp01(2 * e - 1);
                pres = [1 - out, inn, out, inn - 1];
            } else if (T.key === 'cut') {
                pres = [e < 0.5 ? 1 : 0, e < 0.5 ? 0 : 1, e < 0.5 ? 0 : 1, e < 0.5 ? -1 : 0];
            } else {
                pres = [1 - e, e, e, e - 1];
            }
        }
        const rad = (Number(d.angle) || 0) * Math.PI / 180;
        return {
            a, b, k0, k1,
            st: active ? T.id : -1,
            p: active ? e : 0,
            pres,
            tp: [rad, clamp01(Number(d.softness)), Math.max(0, Number(d.strength) || 0), 0],
            idx: pin ? (pin.p >= 0.5 ? pin.b : pin.a) : this.clampIndex(d.current),
            active, style: S.style
        };
    }

    /** Is scene k evaluated by the shader right now? (Feedback passes of other scenes are skipped.) */
    isSceneEvaluated(k) {
        const u = this.computeUniforms();
        return (u.k0 <= 0 && u.k1 > 0 && u.a === k) || (u.k0 <= 1 && u.k1 > 1 && u.b === k);
    }

    uniformBase() {
        if (this.compiledVarName) return this.compiledVarName;
        const sc = appRef && appRef.shaderCompiler;
        return `node_${sc ? sc.getRemappedNodeId(this.id) : this.id}`;
    }

    pushUniforms(force = false) {
        const reg = this.graph && this.graph.uniformRegistry;
        if (!reg) return;
        const u = this.computeUniforms();
        const v = this.uniformBase();
        const sig = `${v}|${u.a}|${u.b}|${u.k0}|${u.k1}|${u.st}|${u.p}|${u.pres.join(',')}|${u.tp.join(',')}|${u.idx}`;
        if (!force && sig === this._pushedSig && reg.hasUniform(`${v}_a`)) return;
        this._pushedSig = sig;
        reg.registerUniform(`${v}_a`, 'int', u.a, this);
        reg.registerUniform(`${v}_b`, 'int', u.b, this);
        reg.registerUniform(`${v}_k0`, 'int', u.k0, this);
        reg.registerUniform(`${v}_k1`, 'int', u.k1, this);
        reg.registerUniform(`${v}_st`, 'int', u.st, this);
        reg.registerUniform(`${v}_p`, 'float', u.p, this);
        reg.registerUniform(`${v}_pres`, 'vec4', u.pres, this);
        reg.registerUniform(`${v}_tp`, 'vec4', u.tp, this);
        reg.registerUniform(`${v}_idx`, 'float', u.idx, this);
    }

    /** Public snapshot (MCP list_scenes, UI). */
    describe() {
        const u = this.computeUniforms();
        const d = this.data;
        const S = this.state;
        const out = {
            id: this.id,
            scenes: d.scenes.map((s, i) => {
                const o = { index: i, name: s.name, connected: this.isSceneConnected(i) };
                if (s.transition) o.transition = s.transition;
                if (s.duration !== undefined) o.duration = s.duration;
                return o;
            }),
            current: d.current,
            current_name: this.sceneName(d.current),
            transition: d.transition,
            duration: d.duration,
            duration_unit: d.durationUnit,
            easing: d.easing,
            params: { angle: d.angle, softness: d.softness, strength: d.strength },
            auto: { mode: d.auto, bars: d.autoBars, seconds: d.autoSeconds },
            playlist: d.playlist,
            evaluated: [...new Set([u.k0 <= 0 && u.k1 > 0 ? u.a : null, u.k1 > 1 && u.k0 <= 1 ? u.b : null].filter(x => x !== null))],
        };
        if (S.active) out.transitioning = { from: S.a, to: S.b, style: S.style, progress: +clamp01(S.p).toFixed(3), eased: +u.p.toFixed(3), duration_s: +S.duration.toFixed(3) };
        const sel = this.graph && this.graph.connections.find(c => c.toNode === this && c.toInput === 0);
        if (sel) out.scene_input = { from: `${sel.fromNode.id}:${sel.fromNode.type}`, cpu_readable: cpuInputValue(this, 0) !== null };
        return out;
    }

    needsContinuousRender() {
        return !!this.state.active;
    }

    // ------------------------------------------------------------------
    // Canvas
    // ------------------------------------------------------------------

    /** Clickable "go" tag at the right of scene row k. */
    getGoRect(k) {
        const cy = this.getRowCenterY(this.inputIndexOfScene(k));
        return { x: this.x + this.width - 30, y: cy - 7, w: 20, h: 14 };
    }

    _sceneAt(x, y) {
        for (let k = 0; k < this.sceneCount; k++) {
            const r = this.getGoRect(k);
            if (x >= r.x - 3 && x <= r.x + r.w + 3 && y >= r.y - 3 && y <= r.y + r.h + 3) return k;
        }
        return -1;
    }

    handleMouseDown(x, y, event) {
        const k = this._sceneAt(x, y);
        if (k >= 0) {
            this.requestScene(k, { source: 'ui' });
            return { handled: true, needsRender: true };
        }
        return super.handleMouseDown(x, y, event);
    }

    getControlCursor(x, y) {
        if (this._sceneAt(x, y) >= 0) return 'pointer';
        return super.getControlCursor(x, y);
    }

    drawHeaderTags(ctx, options = {}) {
        const left = this.drawHeaderLed(ctx, !!this.state.active, COLORS.accent2);
        return left;
    }

    drawBody(ctx, options = {}) {
        const u = this.computeUniforms();
        const S = this.state;
        for (let k = 0; k < this.sceneCount; k++) {
            const cy = this.getRowCenterY(this.inputIndexOfScene(k));
            let level = 0;
            if (u.active) level = k === u.b ? u.p : (k === u.a ? 1 - u.p : 0);
            else if (k === u.a) level = 1;
            if (level > 0) {
                const x0 = this.x + 3, w = this.width - 38;
                ctx.fillStyle = withAlpha(COLORS.accent, 0.10 + 0.12 * level);
                ctx.fillRect(x0, cy - ROW_H / 2 + 2, w * level, ROW_H - 4);
            }
            const r = this.getGoRect(k);
            const current = k === this.data.current;
            drawTag(ctx, r, k < 9 ? String(k + 1) : '·', current, COLORS.accent, {
                hovered: this.isHoveringRect(options, r, 2), font: FONTS.value
            });
        }
        // Footer: style, duration, auto mode
        const d = this.data;
        const T = TRANSITION_BY_KEY[S.active ? S.style : d.transition];
        const dur = `${+Number(d.duration).toFixed(2)}${d.durationUnit === 'beats' ? ' beats' : 's'}`;
        const auto = d.auto === 'bars' ? ` · auto ${d.autoBars} bars` : d.auto === 'seconds' ? ` · auto ${d.autoSeconds}s`
            : d.auto === 'music' ? ` · auto ${d.autoBars} bars / ${d.autoSeconds}s` : '';
        const text = fitText(ctx, FONTS.value, `${T ? T.label : d.transition} · ${dur}${auto}`, this.width - 16);
        drawLabel(ctx, text, this.x + 8, this.y + this.height - FOOTER_H / 2 - 5, COLORS.textFaint, 'left', FONTS.value);
    }
}

/** ScenePresence: shows the scene it resolved to (set at compile time) in its title. */
export class ScenePresenceNode extends Node {
    constructor(id, type, x, y) {
        super(id, type, x, y);
        this.isScenePresence = true;
    }

    getDisplayTitle() {
        const base = super.getDisplayTitle();
        return this.sceneLabel ? `${base} · ${this.sceneLabel}` : base;
    }
}

/** Advance every SceneSwitcher (main.js animation loop, before feedback passes and previews). */
export function tickScenes(app) {
    const graph = app && app.nodeGraph;
    if (!graph) return;
    appRef = app;
    for (const n of graph.nodes) if (n.isSceneSwitcher) { loopTrace.node = n; n.tick(); }
}

export { TRANSITION_KEYS };
