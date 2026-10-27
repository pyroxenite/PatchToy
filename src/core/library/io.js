/**
 * I/O nodes (library group "I/O"): control-rate nodes that talk to other apps and
 * hardware. They run once per frame in JavaScript like the Control nodes
 * (src/core/library/control.js, src/core/control/ControlRuntime.js).
 *
 *   OSC In / OSC Out, Serial In / Serial Out, Art-Net Out  go through the local I/O
 *       bridge (`npm run io-bridge`, mcp/lib/io-bridge.mjs) via src/io/IOClient.js:
 *       browsers cannot open UDP sockets.
 *   MIDI Out CC / MIDI Out Note  use Web MIDI output in the browser directly
 *       (src/io/MIDIOutput.js), no bridge.
 *
 * Nothing leaves the app until the user enables I/O for the session in
 * Output > I/O, and network destinations / serial ports must be on the user's
 * allowlist there (a project cannot add them). Every node keeps its last values
 * when nothing arrives, never throws, and reports its connection state and last
 * message on its status line (node._io = { state: ok | wait | error | off, text }),
 * drawn by src/nodes/IONode.js.
 *
 * Side effects only happen in live evaluations (ctx.scratch is false):
 * render_preview evaluations see the held values and send nothing.
 */
import { libNode } from './define.js';
import { ioClient } from '../../io/IOClient.js';
import { midiOutput } from '../../io/MIDIOutput.js';
import { oscMatch } from '../../io/osc-pattern.mjs';
import { isOscAddress } from '../../io/allowlist.mjs';

const CAT = 'io';
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;
/** A finite number, else the fallback. */
const num = (x, d = 0) => (Number.isFinite(+x) ? +x : d);
const fired = (e) => (typeof e === 'number' ? e > 0 : !!e);

function ioNode(spec) {
    const { options = [], data = {}, js, cleanup, ...rest } = spec;
    const optData = {};
    for (const o of options) optData[o.key] = o.default;
    const def = libNode({
        category: CAT,
        ...rest,
        data: { ...optData, ...data },
        js,
        body: () => { throw new Error(`${spec.displayTitle || 'this'} node runs at control rate (in JavaScript), not in GLSL`); }
    });
    def.rate = 'control';
    def.isControlNode = true;
    def.isIONode = true;
    def.inlineInputs = true;
    if (options.length) {
        def.options = options;
        def.hasInputFields = true;
        def.data = { ...(def.data || {}), ...optData, ...data };
    }
    if (typeof cleanup === 'function') def.ioCleanup = cleanup;
    return def;
}

const opt = (ctx, key, values, fallback) => {
    const v = String(ctx.data[key] !== undefined ? ctx.data[key] : fallback).trim().toLowerCase();
    return values.includes(v) ? v : fallback;
};

const intField = (v, fallback) => {
    const n = Math.round(Number(String(v ?? '').trim()));
    return Number.isFinite(n) && String(v ?? '').trim() !== '' ? n : fallback;
};

/** Status for the node's status line (live evaluations only). */
function status(ctx, state, text) {
    if (ctx.scratch) return;
    const node = ctx.node;
    const prev = node._io;
    if (prev && prev.state === state && prev.text === text) return;
    node._io = { state, text, t: Date.now() };
}

const fmtNum = (x) => {
    if (typeof x !== 'number' || !Number.isFinite(x)) return String(x);
    const r = Math.abs(x) >= 1000 || Number.isInteger(x) ? Math.round(x) : +x.toFixed(3);
    return String(r);
};
function fmtArgs(args, max = 4) {
    const a = (args || []).slice(0, max).map(v => (typeof v === 'string' ? `"${v.length > 12 ? v.slice(0, 11) + '…' : v}"` : Array.isArray(v) ? `[${v.length}]` : typeof v === 'boolean' ? (v ? 'T' : 'F') : v === null ? 'nil' : fmtNum(v)));
    if ((args || []).length > max) a.push('…');
    return a.join(' ');
}
const ago = (t) => {
    const s = (Date.now() - t) / 1000;
    return s < 1 ? '' : s < 60 ? ` · ${Math.round(s)}s ago` : ` · ${Math.round(s / 60)}m ago`;
};

const numericArgs = (args) => {
    const out = [];
    for (const a of args || []) {
        if (typeof a === 'number' && Number.isFinite(a)) out.push(a);
        else if (typeof a === 'boolean') out.push(a ? 1 : 0);
    }
    return out;
};
const comps = (v) => (Array.isArray(v) ? v.map(x => num(x)) : [num(v)]);
const connected = (ctx, name) => !!(ctx.inTypes && ctx.inTypes[name]);

/** Send pacing shared by the Out nodes: { send } given the mode, the trigger and a change key. */
function shouldSend(S, ctx, mode, rate, key, trig) {
    const t = now();
    if (S.epoch !== ioClient.epoch) { S.epoch = ioClient.epoch; S.lastKey = null; } // resend after a reconnect
    if (fired(trig)) return true;
    const minGap = rate > 0 ? 1 / rate : 0;
    const since = t - (S.lastT || 0);
    if (mode === 'event') return false;
    if (mode === 'rate') return rate > 0 && since >= minGap;
    return key !== S.lastKey && since >= minGap; // change
}

const SEND_OPTION = { key: 'send', label: 'send', values: ['change', 'rate', 'event'], default: 'change' };

export const IONodes = {
    'OSCIn': ioNode({
        displayTitle: 'OSC In',
        description: "Receives OSC messages (UDP) through the I/O bridge (npm run io-bridge) on data.port (default 9000, 127.0.0.1 only unless LAN input is enabled in Output > I/O). data.address is an OSC address pattern (* ? [abc] {a,b}; '/x/**' matches everything below /x; empty = every address). Outputs hold the last matching message: value = first number, vec = first four numbers (vec4, missing 0), text = first string argument, list = all numbers, addr = the address it came on; trig fires (pulse count) on every matching message, count = messages so far. Booleans read as 1 / 0. Send from TouchDesigner (OSC Out CHOP), Max ([udpsend 127.0.0.1 9000]), Ableton (Connection Kit / TouchOSC) or node scripts/osc-send-demo.mjs.",
        inputs: [],
        outputs: [
            { name: 'value', type: 'float' }, { name: 'vec', type: 'vec4' }, { name: 'text', type: 'string' },
            { name: 'list', type: 'list' }, { name: 'addr', type: 'string' }, { name: 'trig', type: 'event' }, { name: 'count', type: 'float' }
        ],
        textFields: [
            { key: 'address', label: 'addr', default: '/patchtoy/*' },
            { key: 'port', label: 'port', default: '9000' }
        ],
        js: (I, ctx) => {
            const S = ctx.state;
            if (!S.init) Object.assign(S, { init: true, value: 0, vec: [0, 0, 0, 0], text: '', list: [], addr: '', count: 0, seq: -1, lastAt: 0 });
            let trig = 0;
            const port = intField(ctx.data.port, 9000);
            const pattern = String(ctx.data.address ?? '').trim();
            if (!ctx.scratch) {
                ioClient.touch();
                if (!(port >= 1024 && port <= 65535)) status(ctx, 'error', 'port must be 1024..65535');
                else if (pattern && !isOscAddress(pattern)) status(ctx, 'error', 'address must start with / (no spaces)');
                else {
                    const p = ioClient.wantOsc(port, ctx.node.id);
                    const fresh = S.seq < 0;
                    const msgs = ioClient.oscSince(port, Math.max(0, S.seq));
                    let last = null;
                    for (const m of msgs) {
                        if (!oscMatch(pattern, m.address)) continue;
                        last = m;
                        if (!fresh) trig++;
                    }
                    S.seq = msgs.length ? msgs[msgs.length - 1].seq : Math.max(0, S.seq);
                    if (last) {
                        const nums = numericArgs(last.args);
                        S.value = nums.length ? nums[0] : S.value;
                        S.vec = [0, 1, 2, 3].map(i => nums[i] ?? 0);
                        const str = last.args.find(a => typeof a === 'string');
                        S.text = str !== undefined ? str : '';
                        S.list = nums;
                        S.addr = last.address;
                        S.lastAt = Date.now();
                        S.lastArgs = last.args;
                    }
                    S.count += trig;
                    const link = ioClient.linkState();
                    if (link.state !== 'ok') status(ctx, link.state, link.text);
                    else if (p.error) status(ctx, 'error', `:${port} ${p.error}`);
                    else if (!p.listening) status(ctx, 'wait', `opening udp :${port}…`);
                    else if (S.lastAt) status(ctx, 'ok', `:${port} ${S.addr} ${fmtArgs(S.lastArgs)}${ago(S.lastAt)}`);
                    else status(ctx, 'ok', `listening :${port}${p.bind === '0.0.0.0' ? ' (LAN)' : ''} · no ${pattern || 'messages'} yet`);
                }
            }
            return { value: S.value, vec: S.vec.slice(), text: S.text, list: S.list.slice(), addr: S.addr, trig, count: S.count };
        }
    }),

    'OSCOut': ioNode({
        displayTitle: 'OSC Out',
        description: "Sends an OSC message (UDP) to data.host:data.port through the I/O bridge, with the components of value (float or vec2/3/4 -> 1-4 arguments), then text (a string argument, when connected) and list (numbers, when connected). data.send: 'change' (default: when the arguments change, at most rate messages / s, the final value always goes out), 'rate' (rate messages / s continuously) or 'event' (only when trig fires); trig also sends in every mode. data.types 'float' (f) or 'int' (i) for the numbers. The destination must be allowed in Output > I/O (the node shows 'not allowed' until then). sent fires on each message, count = messages sent.",
        inputs: [
            { name: 'value', type: 'T', default: '0.0' },
            { name: 'trig', type: 'event' },
            { name: 'rate', type: 'float', default: '30.0', description: 'Max messages / s (change) or messages / s (rate)' },
            { name: 'text', type: 'string', default: '' },
            { name: 'list', type: 'list', default: '' }
        ],
        outputs: [{ name: 'sent', type: 'event' }, { name: 'count', type: 'float' }],
        textFields: [
            { key: 'address', label: 'addr', default: '/patchtoy/value' },
            { key: 'host', label: 'host', default: '127.0.0.1' },
            { key: 'port', label: 'port', default: '9001' }
        ],
        options: [SEND_OPTION, { key: 'types', label: 'types', values: ['float', 'int'], default: 'float' }],
        js: (I, ctx) => {
            const S = ctx.state;
            if (S.count === undefined) S.count = 0;
            const address = String(ctx.data.address ?? '').trim();
            const host = String(ctx.data.host ?? '').trim();
            const port = intField(ctx.data.port, 9001);
            const asInt = opt(ctx, 'types', ['float', 'int'], 'float') === 'int';
            const nums = comps(I.value).map(v => (asInt ? Math.round(v) : v));
            const args = nums.slice();
            let types = (asInt ? 'i' : 'f').repeat(nums.length);
            if (connected(ctx, 'text')) { args.push(String(I.text ?? '')); types += 's'; }
            if (connected(ctx, 'list') && Array.isArray(I.list)) {
                for (const v of I.list.slice(0, 256)) { args.push(asInt ? Math.round(+v || 0) : (+v || 0)); types += asInt ? 'i' : 'f'; }
            }
            let sent = 0;
            if (!ctx.scratch) {
                ioClient.touch();
                if (!isOscAddress(address)) status(ctx, 'error', 'address must start with / (no spaces)');
                else if (!host || !(port >= 1 && port <= 65535)) status(ctx, 'error', 'set host and port');
                else {
                    const mode = opt(ctx, 'send', SEND_OPTION.values, 'change');
                    const key = JSON.stringify(args);
                    let failed = null;
                    if (shouldSend(S, ctx, mode, Number(I.rate) || 0, key, I.trig)) {
                        const r = ioClient.oscSend(host, port, address, args, types);
                        if (r.ok) {
                            S.lastKey = key;
                            S.lastT = now();
                            S.count++;
                            S.lastArgs = args;
                            S.lastAt = Date.now();
                            sent = 1;
                        } else failed = r;
                    }
                    const c = failed || ioClient.checkDest(host, port);
                    if (!c.ok) status(ctx, c.state, c.text);
                    else if (S.lastAt) status(ctx, 'ok', `→ ${host}:${port} ${address} ${fmtArgs(S.lastArgs)}`);
                    else status(ctx, 'ok', `→ ${host}:${port} ready`);
                }
            }
            return { sent, count: S.count };
        }
    }),

    'SerialIn': ioNode({
        displayTitle: 'Serial In',
        description: "Reads a serial device (Arduino, sensors...) through the I/O bridge. data.port = the device (e.g. /dev/tty.usbmodem1101 on macOS, COM3 on Windows; pick and allow it in Output > I/O), data.baud (default 115200, must match Serial.begin()). data.mode 'lines' (default): each text line -> text, list = the numbers in it (separated by commas, spaces, tabs or ;), value = its first number; 'bytes': list = the bytes of the last chunk, value = its last byte. trig fires per line / chunk, count = lines so far. Outputs hold the last values. Try /dev/mock-sensor with npm run io-bridge -- --mock-serial.",
        inputs: [],
        outputs: [
            { name: 'text', type: 'string' }, { name: 'list', type: 'list' }, { name: 'value', type: 'float' },
            { name: 'trig', type: 'event' }, { name: 'count', type: 'float' }
        ],
        textFields: [
            { key: 'port', label: 'port', default: '' },
            { key: 'baud', label: 'baud', default: '115200' }
        ],
        options: [{ key: 'mode', label: 'mode', values: ['lines', 'bytes'], default: 'lines' }],
        js: (I, ctx) => {
            const S = ctx.state;
            if (!S.init) Object.assign(S, { init: true, text: '', list: [], value: 0, count: 0, seq: -1, lastAt: 0 });
            let trig = 0;
            const path = String(ctx.data.port ?? '').trim();
            const baud = intField(ctx.data.baud, 115200);
            const mode = opt(ctx, 'mode', ['lines', 'bytes'], 'lines');
            if (!ctx.scratch) {
                ioClient.touch();
                if (!path) status(ctx, 'off', 'set port (pick it in Output › I/O)');
                else {
                    const s = ioClient.wantSerial(path, baud, mode, ctx.node.id);
                    const fresh = S.seq < 0;
                    const msgs = ioClient.serialSince(path, Math.max(0, S.seq));
                    let last = null;
                    for (const m of msgs) { last = m; if (!fresh) trig++; }
                    S.seq = msgs.length ? msgs[msgs.length - 1].seq : Math.max(0, S.seq);
                    if (last) {
                        if (last.line !== null) {
                            S.text = last.line;
                            S.list = last.line.split(/[\s,;]+/).filter(Boolean).map(Number).filter(Number.isFinite);
                            if (S.list.length) S.value = S.list[0];
                        } else if (last.bytes) {
                            S.list = last.bytes.slice();
                            S.text = '';
                            if (S.list.length) S.value = S.list[S.list.length - 1];
                        }
                        S.lastAt = Date.now();
                    }
                    S.count += trig;
                    const link = ioClient.linkState();
                    const short = path.replace(/^\/dev\/(tty\.|cu\.)?/, '');
                    if (link.state !== 'ok') status(ctx, link.state, link.text);
                    else if (ioClient.features && ioClient.features.serial === false) status(ctx, 'error', ioClient.features.serialError || 'serial unavailable in the bridge');
                    else if (s.error && !s.open) status(ctx, 'error', `${short}: ${s.error}`);
                    else if (!ioClient.serialAllow.includes(path)) status(ctx, 'wait', `${short} not allowed · Output › I/O`);
                    else if (!s.open) status(ctx, 'wait', `opening ${short}…`);
                    else if (S.lastAt) status(ctx, 'ok', `${short} · ${mode === 'lines' ? `"${S.text.slice(0, 24)}"` : `${S.list.length} bytes`}${ago(S.lastAt)}`);
                    else status(ctx, 'ok', `${short} open @${baud} · no data yet`);
                }
            }
            return { text: S.text, list: S.list.slice(), value: S.value, trig, count: S.count };
        }
    }),

    'SerialOut': ioNode({
        displayTitle: 'Serial Out',
        description: "Writes to a serial device through the I/O bridge (port and baud like Serial In; the port must be allowed in Output > I/O). data.format 'csv' (default: the components of value then the list numbers, comma-separated, one line each: '0.5,1,0\\n' - parse with Serial.parseFloat() on an Arduino), 'text' (the text input + newline) or 'bytes' (value / list numbers as raw bytes 0..255). data.send 'change' (at most rate writes / s), 'rate' or 'event' (trig); trig also writes in every mode. sent fires per write.",
        inputs: [
            { name: 'value', type: 'T', default: '0.0' },
            { name: 'text', type: 'string', default: '' },
            { name: 'list', type: 'list', default: '' },
            { name: 'trig', type: 'event' },
            { name: 'rate', type: 'float', default: '30.0', description: 'Max writes / s (change) or writes / s (rate)' }
        ],
        outputs: [{ name: 'sent', type: 'event' }, { name: 'count', type: 'float' }],
        textFields: [
            { key: 'port', label: 'port', default: '' },
            { key: 'baud', label: 'baud', default: '115200' }
        ],
        options: [SEND_OPTION, { key: 'format', label: 'format', values: ['csv', 'text', 'bytes'], default: 'csv' }],
        js: (I, ctx) => {
            const S = ctx.state;
            if (S.count === undefined) S.count = 0;
            const path = String(ctx.data.port ?? '').trim();
            const baud = intField(ctx.data.baud, 115200);
            const format = opt(ctx, 'format', ['csv', 'text', 'bytes'], 'csv');
            const nums = comps(I.value).concat(connected(ctx, 'list') && Array.isArray(I.list) ? I.list.slice(0, 1024).map(v => +v || 0) : []);
            let payload, label;
            if (format === 'text') { const t = String(I.text ?? ''); payload = { text: `${t}\n` }; label = `"${t.slice(0, 20)}"`; }
            else if (format === 'bytes') { const b = nums.map(v => Math.max(0, Math.min(255, Math.round(v)))); payload = { bytes: b }; label = `${b.length} bytes`; }
            else { const line = nums.map(v => String(+v.toFixed(4))).join(','); payload = { text: `${line}\n` }; label = line.slice(0, 24); }
            let sent = 0;
            if (!ctx.scratch) {
                ioClient.touch();
                if (!path) status(ctx, 'off', 'set port (pick it in Output › I/O)');
                else {
                    const s = ioClient.wantSerial(path, baud, 'lines', ctx.node.id, true); // a Serial In on the same port sets baud / mode
                    const mode = opt(ctx, 'send', SEND_OPTION.values, 'change');
                    const key = JSON.stringify(payload);
                    const short = path.replace(/^\/dev\/(tty\.|cu\.)?/, '');
                    if (shouldSend(S, ctx, mode, Number(I.rate) || 0, key, I.trig)) {
                        const r = ioClient.serialWrite(path, payload);
                        if (r.ok) {
                            S.lastKey = key;
                            S.lastT = now();
                            S.count++;
                            S.label = label;
                            sent = 1;
                            status(ctx, 'ok', `→ ${short} ${label}`);
                        } else status(ctx, r.state, r.text);
                    } else if (!S.label) {
                        const link = ioClient.linkState();
                        if (link.state !== 'ok') status(ctx, link.state, link.text);
                        else if (s.error && !s.open) status(ctx, 'error', `${short}: ${s.error}`);
                        else if (!ioClient.serialAllow.includes(path)) status(ctx, 'wait', `${short} not allowed · Output › I/O`);
                    }
                }
            }
            return { sent, count: S.count };
        }
    }),

    'MIDIOutCC': ioNode({
        displayTitle: 'MIDI Out CC',
        description: "Sends a MIDI Control Change with Web MIDI (in the browser, no bridge) whenever its 7-bit value changes: value 0..1 (data.range 'unit', default) or 0..127 ('midi') on channel 1-16, controller cc 0-127. data.device = part of the output's name (empty = the first output: IAC Driver on macOS, loopMIDI on Windows, or a USB synth). Needs I/O enabled for the session in Output > I/O (the browser may also ask for MIDI permission). sent fires per message, midi = the value sent (0..127).",
        inputs: [
            { name: 'value', type: 'float', default: '0.0' },
            { name: 'channel', type: 'float', default: '1.0' },
            { name: 'cc', type: 'float', default: '1.0' }
        ],
        outputs: [{ name: 'sent', type: 'event' }, { name: 'midi', type: 'float' }],
        textFields: [{ key: 'device', label: 'device', default: '' }],
        options: [{ key: 'range', label: 'range', values: ['unit', 'midi'], default: 'unit' }],
        js: (I, ctx) => {
            const S = ctx.state;
            const unit = opt(ctx, 'range', ['unit', 'midi'], 'unit') === 'unit';
            const v = Math.max(0, Math.min(127, Math.round(unit ? num(I.value) * 127 : num(I.value))));
            const ch = Math.max(1, Math.min(16, Math.round(num(I.channel, 1))));
            const cc = Math.max(0, Math.min(127, Math.round(num(I.cc, 1))));
            let sent = 0;
            if (!ctx.scratch) {
                const device = String(ctx.data.device ?? '').trim();
                if (!ioClient.available) status(ctx, 'off', 'MIDI out needs the browser app');
                else if (!ioClient.optIn) status(ctx, 'wait', 'I/O off · enable in Output › I/O');
                else {
                    const key = `${ch}|${cc}|${v}|${device}`;
                    if (key !== S.key) {
                        const r = midiOutput.send(device, [0xB0 | (ch - 1), cc, v]);
                        if (r.ok) { S.key = key; sent = 1; status(ctx, 'ok', `${r.name} · ch${ch} cc${cc} = ${v}`); }
                        else status(ctx, r.state, r.text);
                    }
                }
            }
            return { sent, midi: v };
        }
    }),

    'MIDIOutNote': ioNode({
        displayTitle: 'MIDI Out Note',
        description: "Plays MIDI notes with Web MIDI (browser, no bridge). trig plays note (0-127, 60 = middle C) at velocity (0..1) for length seconds; or connect gate: note on while gate >= 0.5, off when it falls (changing note while the gate is held moves the note). channel 1-16, data.device = part of the output name (empty = first output). Notes still sounding are released when the node is deleted or I/O is disabled. Needs I/O enabled in Output > I/O. sent fires per note on, playing = 1 while a note sounds.",
        inputs: [
            { name: 'trig', type: 'event' },
            { name: 'gate', type: 'float', default: '0.0' },
            { name: 'note', type: 'float', default: '60.0' },
            { name: 'velocity', type: 'float', default: '0.8' },
            { name: 'length', type: 'float', default: '0.25', description: 'Seconds (trig)' },
            { name: 'channel', type: 'float', default: '1.0' }
        ],
        outputs: [{ name: 'sent', type: 'event' }, { name: 'playing', type: 'float' }],
        textFields: [{ key: 'device', label: 'device', default: '' }],
        js: (I, ctx) => {
            const S = ctx.state;
            const note = Math.max(0, Math.min(127, Math.round(num(I.note, 60))));
            const vel = Math.max(1, Math.min(127, Math.round(Math.max(0, Math.min(1, num(I.velocity, 0.8))) * 127)));
            const ch = Math.max(1, Math.min(16, Math.round(num(I.channel, 1))));
            let sent = 0;
            if (!ctx.scratch) {
                const device = String(ctx.data.device ?? '').trim();
                S.device = device;
                const off = () => {
                    if (!S.held) return;
                    midiOutput.send(S.held.device, [0x80 | (S.held.ch - 1), S.held.note, 0]);
                    S.held = null;
                    S.offAt = 0;
                };
                const on = () => {
                    off();
                    const r = midiOutput.send(device, [0x90 | (ch - 1), note, vel]);
                    if (r.ok) { S.held = { note, ch, device }; sent = 1; status(ctx, 'ok', `${r.name} · ch${ch} note ${note} vel ${vel}`); }
                    else status(ctx, r.state, r.text);
                    return r.ok;
                };
                if (!ioClient.available) status(ctx, 'off', 'MIDI out needs the browser app');
                else if (!ioClient.optIn) { off(); status(ctx, 'wait', 'I/O off · enable in Output › I/O'); }
                else {
                    const t = now();
                    if (connected(ctx, 'gate')) {
                        const high = num(I.gate) >= 0.5;
                        if (high && !S.gateHigh) on();
                        else if (!high && S.gateHigh) off();
                        else if (high && S.held && S.held.note !== note) on();
                        S.gateHigh = high;
                    }
                    if (fired(I.trig) && on()) S.offAt = t + Math.max(0.01, Number(I.length) || 0.25);
                    if (S.offAt && t >= S.offAt) off();
                    if (!S.held && midiOutput.state !== 'ready' && midiOutput.state !== 'idle') status(ctx, 'error', midiOutput.error || 'MIDI unavailable');
                    else if (!S.held && !ctx.node._io) status(ctx, 'ok', 'ready · waiting for trig / gate');
                }
            }
            return { sent, playing: S.held ? 1 : 0 };
        },
        cleanup: (node) => {
            const S = node._ctlState;
            if (S && S.held) {
                try { midiOutput.send(S.held.device, [0x80 | (S.held.ch - 1), S.held.note, 0]); } catch (e) { /* ignore */ }
                S.held = null;
            }
        }
    }),

    'ArtNetOut': ioNode({
        displayTitle: 'Art-Net Out',
        description: "Sends a DMX universe over Art-Net (UDP, ArtDmx) through the I/O bridge to data.host (a node / interface IP, or a broadcast address such as 2.255.255.255) on data.port (6454). Channel values come from list (numbers) followed by the components of value (when connected), written from channel start (1-512) on; data.scale 'unit' (0..1 -> 0..255, default) or 'byte' (0..255). universe 0-32767 (Net / Sub-Net / Universe = 15-bit port address). Sent when the channels change (at most rate packets / s) and once a second otherwise (DMX nodes expect a refresh). The host must be allowed in Output > I/O (e.g. 2.255.255.255:6454). channels = the DMX length sent.",
        inputs: [
            { name: 'list', type: 'list', default: '' },
            { name: 'value', type: 'T', default: '0.0' },
            { name: 'start', type: 'float', default: '1.0', description: 'First DMX channel (1-512)' },
            { name: 'universe', type: 'float', default: '0.0' },
            { name: 'rate', type: 'float', default: '30.0', description: 'Max packets / s' }
        ],
        outputs: [{ name: 'sent', type: 'event' }, { name: 'channels', type: 'float' }],
        textFields: [
            { key: 'host', label: 'host', default: '127.0.0.1' },
            { key: 'port', label: 'port', default: '6454' }
        ],
        options: [{ key: 'scale', label: 'scale', values: ['unit', 'byte'], default: 'unit' }],
        js: (I, ctx) => {
            const S = ctx.state;
            if (S.count === undefined) S.count = 0;
            const unit = opt(ctx, 'scale', ['unit', 'byte'], 'unit') === 'unit';
            const vals = (connected(ctx, 'list') && Array.isArray(I.list) ? I.list.slice(0, 512).map(v => +v || 0) : [])
                .concat(connected(ctx, 'value') ? comps(I.value) : []);
            const start = Math.max(1, Math.min(512, Math.round(num(I.start, 1))));
            const len = Math.min(512, start - 1 + vals.length);
            const data = new Array(Math.max(2, len)).fill(0);
            for (let i = 0; i < vals.length && start - 1 + i < 512; i++) data[start - 1 + i] = Math.max(0, Math.min(255, Math.round(unit ? vals[i] * 255 : vals[i])));
            let sent = 0;
            if (!ctx.scratch) {
                ioClient.touch();
                const host = String(ctx.data.host ?? '').trim();
                const port = intField(ctx.data.port, 6454);
                const universe = Math.max(0, Math.min(32767, Math.round(num(I.universe))));
                if (!host || !(port >= 1 && port <= 65535)) status(ctx, 'error', 'set host and port');
                else {
                    const key = `${universe}|${data.join(',')}`;
                    const t = now();
                    if (S.epoch !== ioClient.epoch) { S.epoch = ioClient.epoch; S.lastKey = null; }
                    const rate = Math.max(1, Math.min(44, Number(I.rate) || 30));
                    const due = (key !== S.lastKey && t - (S.lastT || 0) >= 1 / rate) || t - (S.lastT || 0) >= 1;
                    if (due) {
                        const r = ioClient.artnetSend(host, universe, data, port);
                        if (r.ok) {
                            S.lastKey = key;
                            S.lastT = t;
                            S.count++;
                            sent = 1;
                            status(ctx, 'ok', `→ ${host} u${universe} · ${vals.length} ch from ${start}`);
                        } else {
                            S.lastT = t; // retry at the refresh rate, not every frame
                            status(ctx, r.state, r.text);
                        }
                    }
                }
            }
            return { sent, channels: len };
        }
    })
};
