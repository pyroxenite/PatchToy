/**
 * MIDI mappings over automation / MCP: midi_map, midi_unmap, simulate_midi, plus
 * the mappings in list_params / list_scenes and Param data.midi in set_node_data /
 * build_graph. Installed from AutomationAPI.js (installMidiAutomation).
 * The mapping model lives in src/services/MidiMapper.js.
 */
import { midiMapper, normalizeMapping, sourceLabel, parseNote, MIDI_SOURCE_TYPES, CC_MODES, SCENE_TARGETS } from '../services/MidiMapper.js';
import { midiService } from '../services/MIDIService.js';
import { paramLabel } from '../core/paramKinds.js';

const OPTION_KEYS = ['target', 'option', 'mode', 'press', 'pickup', 'invert', 'min', 'max', 'slew', 'hires', 'sens', 'feedback', 'device', 'id'];

export function installMidiAutomation(AutomationAPI, AutomationError) {
    const P = AutomationAPI.prototype;
    AutomationAPI.METHODS.push('midiMap', 'midiUnmap', 'simulateMidi');

    Object.assign(P, {
        _midiMapper() {
            if (!midiMapper.app && this.toy) midiMapper.attach(this.toy);
            return midiMapper;
        },

        _midiDescribe(node) {
            const M = this._midiMapper();
            return M.mappingsOf(node).map(m => M.describe(node, m));
        },

        /** The node a midi_map / midi_unmap call targets: a Param or a SceneSwitcher. */
        _midiTarget({ param, node_id, label, scene_node } = {}) {
            if (scene_node !== undefined && scene_node !== null && scene_node !== '') {
                const sw = this._getNode(scene_node);
                if (!sw.isSceneSwitcher) throw new AutomationError(`Node #${sw.id} is a ${sw.type}, not a SceneSwitcher`);
                return sw;
            }
            let id = node_id;
            let lab = label;
            if (param !== undefined && param !== null && param !== '') {
                if (typeof param === 'number' || /^\d+$/.test(String(param))) id = param;
                else lab = param;
            }
            if (id !== undefined && id !== null && id !== '') {
                const n = this._getNode(id);
                if (n.isSceneSwitcher) return n;
            }
            try {
                return this._resolveParam(id, lab);
            } catch (e) {
                if (/needs node_id or label/.test(e.message)) throw new AutomationError('midi_map needs param (Param id or label) or scene_node (SceneSwitcher id)');
                throw e;
            }
        },

        _midiResult(node, extra = {}) {
            const out = { ...extra };
            if (node.isParamNode) out.param = this._describeParam(node);
            else out.switcher = { id: node.id, scenes: node.data.scenes.map((s, i) => `${i}:${s.name}`), current: node.data.current, midi: this._midiDescribe(node) };
            return out;
        },

        /**
         * midi_map: map a MIDI control onto a Param (or a SceneSwitcher action).
         * { param | node_id | label | scene_node, type, number, channel, device, options, add, learn }
         */
        midiMap(params = {}) {
            const M = this._midiMapper();
            const node = this._midiTarget(params);
            const opts = { ...(params.options || {}) };
            for (const k of OPTION_KEYS) if (params[k] !== undefined && opts[k] === undefined) opts[k] = params[k];
            if (node.isSceneSwitcher) {
                const action = params.action ?? opts.target ?? (params.scene !== undefined ? 'scene' : undefined);
                if (action !== undefined) opts.target = action;
                if (params.scene !== undefined) {
                    const i = typeof this._sceneRef === 'function' ? this._sceneRef(node, params.scene) : Number(params.scene);
                    opts.option = i;
                    if (!opts.target) opts.target = 'scene';
                }
                if (!opts.target) throw new AutomationError(`A SceneSwitcher mapping needs action (${SCENE_TARGETS.join(' | ')}) and, for 'scene', scene (index or name)`);
            }
            if (params.learn) {
                const target = node.isSceneSwitcher
                    ? { kind: 'scene', nodeId: node.id, target: opts.target, option: opts.option }
                    : { kind: 'param', nodeId: node.id };
                M.startLearn(target);
                this.activity(`started MIDI learn for ${node.isParamNode ? paramLabel(node) : `Scene Switcher #${node.id}`}`);
                return this._midiResult(node, { learning: true, hint: M.learnHint(), next: 'Move a control on the device (or simulate_midi): the next message is mapped.' });
            }
            if (params.type === undefined) throw new AutomationError(`midi_map needs type (${MIDI_SOURCE_TYPES.join(' | ')}) and number (CC / note), or learn: true`);
            const raw = { ...opts, type: params.type, number: params.number, channel: params.channel ?? opts.channel ?? 1, device: params.device ?? opts.device };
            let m;
            try {
                // Same target replaced unless add: true (same physical control is always replaced)
                m = M.addMapping(node, raw, { replace: params.add ? 'source' : 'target', label: 'Map MIDI' });
                if (!params.add) {
                    const list = M.mappingsOf(node);
                    const pruned = list.filter(o => o === m || o.id === m.id || !(o.type === m.type && o.number === m.number && o.channel === m.channel && (o.device || '') === (m.device || '')));
                    if (pruned.length !== list.length) M.setMappings(node, pruned, { label: 'Map MIDI', silent: true });
                }
            } catch (e) {
                throw new AutomationError(e.message, {
                    types: MIDI_SOURCE_TYPES, cc_modes: CC_MODES,
                    hint: "options: target (vecN 'x'|'y'|'z'|'w', color 'hue'|'sat'|'bright'|'r'|'g'|'b'|'a', enum 'value' (CC buckets) | 'option' (+ option index) | 'step'), mode, pickup, invert, min, max, slew (s), press ('toggle'|'momentary'|'velocity'), hires, sens, feedback"
                });
            }
            this.activity(`mapped ${sourceLabel(m)} to ${node.isParamNode ? paramLabel(node) : `Scene Switcher #${node.id}`}`);
            return this._midiResult(node, { mapping: M.describe(node, m) });
        },

        /** midi_unmap: remove mappings of a Param / switcher (all, or those matching id / type / number / channel / action). */
        midiUnmap(params = {}) {
            const M = this._midiMapper();
            const node = this._midiTarget(params);
            const list = M.mappingsOf(node);
            const has = (v) => v !== undefined && v !== null && v !== '';
            const filter = ['id', 'type', 'number', 'channel', 'action', 'scene'].some(k => has(params[k]));
            let sceneIdx;
            if (node.isSceneSwitcher && has(params.scene)) sceneIdx = typeof this._sceneRef === 'function' ? this._sceneRef(node, params.scene) : Number(params.scene);
            let numberRef = params.number;
            if (has(numberRef) && params.type === 'note') numberRef = parseNote(numberRef) ?? numberRef;
            const drop = list.filter(m => {
                if (!filter) return true;
                if (has(params.id) && m.id !== params.id) return false;
                if (has(params.type) && m.type !== String(params.type).toLowerCase()) return false;
                if (has(numberRef) && m.number !== Number(numberRef)) return false;
                if (has(params.channel) && (m.channel || 0) !== Number(params.channel)) return false;
                if (has(params.action) && m.target !== params.action) return false;
                if (sceneIdx !== undefined && m.option !== sceneIdx) return false;
                return true;
            });
            if (!drop.length) {
                throw new AutomationError(list.length ? 'No mapping matches' : `${node.isParamNode ? `“${paramLabel(node)}”` : `Scene Switcher #${node.id}`} has no MIDI mapping`, { midi: this._midiDescribe(node) });
            }
            M.setMappings(node, list.filter(m => !drop.includes(m)), { label: 'Remove MIDI mapping' });
            this.activity(`removed ${drop.length} MIDI mapping${drop.length === 1 ? '' : 's'}`);
            return this._midiResult(node, { removed: drop.map(m => ({ id: m.id, label: sourceLabel(m) })) });
        },

        /**
         * simulate_midi: feed MIDI bytes as if a controller sent them (tests: there is no
         * Web MIDI in headless browsers). { status, data1, data2 } or { messages: [[s, d1, d2], ...] }.
         */
        async simulateMidi(params = {}) {
            const M = this._midiMapper();
            const msgs = [];
            if (Array.isArray(params.messages)) {
                for (const m of params.messages) {
                    if (Array.isArray(m)) msgs.push(m);
                    else if (m && typeof m === 'object') msgs.push([m.status, m.data1 ?? 0, m.data2 ?? 0]);
                }
            }
            if (params.status !== undefined) msgs.push([params.status, params.data1 ?? 0, params.data2 ?? 0]);
            if (!msgs.length) throw new AutomationError('simulate_midi needs status (+ data1, data2) or messages [[status, data1, data2], ...] (e.g. [176, 21, 64] = CC 21 = 64 on channel 1, [144, 60, 100] = note C3 on)');
            for (const m of msgs) {
                const s = Number(m[0]);
                if (!(s >= 0x80 && s <= 0xEF)) throw new AutomationError(`status ${m[0]} is not a channel message (0x80..0xEF: 128 note off, 144 note on, 176 CC, 208 aftertouch, 224 pitch bend; + channel - 1)`);
            }
            const learning = M.learn ? { ...M.learn.target } : null;
            const effects = M.simulate(msgs, params.device || '');
            // Let slews / trigger pulses run a frame when asked
            const wait = Math.max(0, Math.min(5000, Number(params.wait_ms) || 0));
            if (wait) await new Promise(r => setTimeout(r, wait));
            if (M.observe) M.finishObserve(); // learn: classify the encoder now (tests don't wait 1.2 s)
            // MIDI values are performance input, not an undo step: inside an undo batch
            // (an MCP command) absorb them, unless MIDI learn created a mapping
            const H = this.toy && this.toy.history;
            if (H && H.batchDepth > 0 && !(learning && !M.learn) && typeof H.capture === 'function') {
                try { H.capture({ silent: true }); } catch (e) { /* ignore */ }
            }
            const ids = [...new Set([...effects.map(e => e.node_id), ...(learning ? [learning.nodeId] : [])])];
            const out = { sent: msgs.length, effects, midi_enabled: !!midiService.isEnabled };
            if (learning) {
                out.learn = M.learn ? { still_learning: true, hint: M.learnHint() } : { done: true };
            }
            out.nodes = ids.map(id => {
                const n = this.graph.nodes.find(x => x.id === id);
                if (!n) return null;
                return n.isParamNode
                    ? { id, label: paramLabel(n), value: n.data.value, pulse: !!n.pulse, midi: this._midiDescribe(n) }
                    : { id, type: n.type, current: n.data.current, current_name: n.sceneName?.(n.data.current), midi: this._midiDescribe(n) };
            }).filter(Boolean);
            this.graph.render?.();
            return out;
        },
    });

    // list_params: mappings per param
    const baseDescribeParam = P._describeParam;
    P._describeParam = function (node) {
        const out = baseDescribeParam.call(this, node);
        const midi = this._midiDescribe(node);
        if (midi.length) out.midi = midi;
        return out;
    };

    // list_scenes: mappings per switcher
    const baseListScenes = P.listScenes;
    if (typeof baseListScenes === 'function') {
        P.listScenes = function (params) {
            const out = baseListScenes.call(this, params);
            if (out && Array.isArray(out.switchers)) {
                for (const s of out.switchers) {
                    const n = this.graph.nodes.find(x => x.id === s.id);
                    const midi = n ? this._midiDescribe(n) : [];
                    if (midi.length) s.midi = midi;
                }
            }
            return out;
        };
    }

    // set_node_data / build_graph: Param data.midi = [{type, number, channel, ...}] (validated)
    const baseApplyParam = P._applyParamData;
    if (typeof baseApplyParam === 'function') {
        P._applyParamData = function (node, data) {
            if (!data || typeof data !== 'object' || data.midi === undefined) return baseApplyParam.call(this, node, data);
            const { midi, ...rest } = data;
            const res = Object.keys(rest).length ? baseApplyParam.call(this, node, rest) : { changed: [], disconnected: [], ignoredWhileConnected: [] };
            const list = midi === null ? [] : Array.isArray(midi) ? midi : [midi];
            const out = [];
            try {
                for (const m of list) out.push(normalizeMapping(node, m, out));
            } catch (e) {
                throw new AutomationError(`data.midi: ${e.message}`);
            }
            this._midiMapper().setMappings(node, out, { label: 'MIDI mapping' });
            res.changed.push('midi');
            return res;
        };
    }

    const baseTypeNotes = P._typeNotes;
    P._typeNotes = function (name, def) {
        const notes = baseTypeNotes.call(this, name, def);
        if (def && def.isParamNode) {
            notes.push("MIDI: midi_map {param, type: 'cc'|'note'|'pitchbend'|'aftertouch', number, channel, options} maps a controller (saved in data.midi, matched by device name + channel); list_params shows the mappings; simulate_midi feeds test messages.");
        }
        return notes;
    };
}
