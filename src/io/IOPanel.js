import { h, UIHelpers } from '../ui/UIHelpers.js';
import { ioClient, IO_DEFAULT_PORT } from './IOClient.js';
import { midiOutput } from './MIDIOutput.js';
import { parseAllowEntry } from './allowlist.mjs';

/**
 * Output > I/O: the I/O bridge popover (OSC / serial / Art-Net through
 * `npm run io-bridge`, MIDI out through Web MIDI).
 *   - bridge status with a copyable start command when it isn't running
 *   - pairing token (paste the token or the printed URL), port, unpair
 *   - "Enable I/O for this session" opt-in, LAN OSC input
 *   - allowed destinations (host:port list) + destinations the patch requested
 *   - serial port picker (scan through the bridge, allow per port)
 *   - MIDI outputs, activity counters, last message in / out / error
 * Settings live in the browser (src/io/IOClient.js), never in project files.
 */

const START_CMD = 'npm run io-bridge';

function copy(text, label = 'Copied') {
    const done = () => UIHelpers.toast(text, 'success', { title: label, duration: 1800 });
    try {
        navigator.clipboard.writeText(text).then(done, () => UIHelpers.toast(text, 'info', { title: 'Copy this' }));
    } catch (e) {
        UIHelpers.toast(text, 'info', { title: 'Copy this' });
    }
}

const ago = (t) => {
    if (!t) return '';
    const s = Math.round((Date.now() - t) / 1000);
    return s < 2 ? 'now' : s < 60 ? `${s}s ago` : `${Math.round(s / 60)}m ago`;
};

const fmtArgs = (args) => (args || []).slice(0, 6).map(v => (typeof v === 'number' ? +v.toFixed(3) : JSON.stringify(v))).join(' ');

export class IOPanel {
    constructor(app) {
        this.app = app;
        this.pop = null;
        this.root = null;
        this.els = {};
        this.unsub = null;
        this.timer = null;
        this.ports = null;
        this.scanError = null;
    }

    get isOpen() { return !!(this.pop && !this.pop.closed); }

    toggle(anchor) {
        if (this.isOpen) { this.pop.close(); return; }
        this.open(anchor);
    }

    open(anchor = document.getElementById('outputBtn')) {
        if (this.isOpen) return;
        ioClient.touch();
        if (ioClient.token) ioClient.start();
        this.root = h('div', { className: 'op io-panel' });
        this.pop = UIHelpers.openMenu({
            anchor,
            content: this.root,
            align: 'end',
            className: 'pt-output-pop pt-io-pop',
            onClose: () => {
                this.pop = null;
                this.root = null;
                if (this.unsub) this.unsub();
                this.unsub = null;
                clearInterval(this.timer);
            }
        });
        this.unsub = ioClient.on((reason) => this.render(reason !== 'error' && reason !== 'ports'));
        this.timer = setInterval(() => this.render(false), 500);
        this.render(true);
    }

    render(full) {
        if (!this.root) return;
        const active = document.activeElement;
        const typing = active && this.root.contains(active) && active.tagName === 'INPUT' && active.type !== 'checkbox';
        if (full && !typing) this.build();
        else if (!this.els.status) this.build();
        this.update();
    }

    build() {
        const root = this.root;
        root.innerHTML = '';
        const els = this.els = {};
        const c = ioClient;

        els.status = h('span', { className: 'op-status' });
        root.appendChild(h('div', { className: 'op-head' }, [h('span', { className: 'pt-label', text: 'I/O · OSC · Serial · MIDI · DMX' }), els.status]));

        // ---------------- Bridge
        root.appendChild(h('div', { className: 'op-sec' }, [h('span', { className: 'pt-label', text: 'Bridge' })]));
        els.bridgeLine = h('div', { className: 'io-line' });
        root.appendChild(els.bridgeLine);
        els.hint = h('div', { className: 'io-hint' }, [
            h('span', { className: 'io-hint-text', text: 'Browsers cannot open UDP or serial ports. Start the local bridge in a terminal at the repo root:' }),
            h('div', { className: 'io-cmd' }, [
                h('code', { text: START_CMD }),
                h('button', { className: 'pt-btn pt-btn--sm', text: 'Copy', 'data-tip': 'Copy the command', onClick: () => copy(START_CMD, 'Command copied') })
            ]),
            h('span', { className: 'io-hint-text', text: 'It prints a pairing token (and a URL with ?ioToken=…). Paste either below.' })
        ]);
        root.appendChild(els.hint);

        const tokenIn = h('input', { className: 'pt-input pt-input--mono io-token', type: 'password', placeholder: c.token ? 'paired · paste a new token to re-pair' : 'pairing token or URL', 'aria-label': 'Pairing token', autocomplete: 'off', spellcheck: 'false' });
        const pair = () => {
            const v = tokenIn.value.trim();
            if (!v) return;
            c.setToken(v);
            tokenIn.value = '';
            this.render(true);
        };
        tokenIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') pair(); });
        const portIn = h('input', { className: 'pt-input pt-input--mono op-num io-port', type: 'number', min: '1', max: '65535', value: String(c.port), 'aria-label': 'Bridge port', 'data-tip': `Bridge WebSocket port on 127.0.0.1 (default ${IO_DEFAULT_PORT})` });
        portIn.addEventListener('change', () => { if (!c.setPort(portIn.value)) portIn.value = String(c.port); });
        root.appendChild(h('div', { className: 'op-row' }, [
            h('span', { className: 'op-row-label', text: 'Token' }), tokenIn,
            h('button', { className: 'pt-btn pt-btn--sm', text: 'Pair', onClick: pair })
        ]));
        const row = h('div', { className: 'op-row' }, [h('span', { className: 'op-row-label', text: 'Port' }), portIn, h('span', { className: 'op-unit', text: '127.0.0.1 only' })]);
        if (c.token) row.appendChild(h('button', { className: 'pt-btn pt-btn--sm pt-btn--ghost', text: 'Unpair', 'data-tip': 'Forget the token', onClick: () => { c.unpair(); this.render(true); } }));
        root.appendChild(row);

        // ---------------- Opt-in
        root.appendChild(h('div', { className: 'op-sec' }, [h('span', { className: 'pt-label', text: 'Permission' })]));
        const opt = h('input', { type: 'checkbox', className: 'op-check io-optin', checked: c.optIn });
        opt.addEventListener('change', () => {
            c.setOptIn(opt.checked);
            if (opt.checked && this._hasMidiNodes()) midiOutput.enable().then(() => this.render(true));
            this.render(true);
        });
        root.appendChild(h('label', { className: `op-check-label op-check-row io-optin-row${c.optIn ? ' is-on' : ''}` }, [opt, h('span', { text: 'Enable I/O for this session — lets this tab send OSC, Art-Net, serial and MIDI, and listen on OSC ports. Off again when the tab closes.' })]));
        const lan = h('input', { type: 'checkbox', className: 'op-check', checked: c.lan });
        lan.addEventListener('change', () => c.setLan(lan.checked));
        root.appendChild(h('label', { className: 'op-check-label op-check-row', 'data-tip': 'OSC In listens on 0.0.0.0 instead of 127.0.0.1, so phones / other computers can send to this machine' }, [lan, h('span', { text: 'Accept OSC from other devices on the network (LAN)' })]));

        // ---------------- Destinations
        root.appendChild(h('div', { className: 'op-sec' }, [h('span', { className: 'pt-label', text: 'Allowed destinations' }), h('span', { className: 'io-sec-note', text: 'OSC Out · Art-Net' })]));
        const chips = h('div', { className: 'io-chips' });
        if (!c.allow.length) chips.appendChild(h('span', { className: 'io-empty', text: 'None yet: nothing can be sent.' }));
        for (const a of c.allow) {
            chips.appendChild(h('span', { className: 'io-chip' }, [
                h('span', { text: a }),
                h('button', { className: 'io-chip-x', 'aria-label': `Remove ${a}`, text: '×', onClick: () => c.removeAllow(a) })
            ]));
        }
        root.appendChild(chips);
        const destIn = h('input', { className: 'pt-input pt-input--mono io-dest', type: 'text', placeholder: '127.0.0.1:9001 · 10.0.0.20:7000 · host:*', 'aria-label': 'Add destination', spellcheck: 'false' });
        const add = () => {
            const v = destIn.value.trim();
            if (!v) return;
            if (!parseAllowEntry(v)) { UIHelpers.toast(`"${v}" is not host:port, host:port-port or host:*`, 'error', { title: 'Destination' }); return; }
            c.addAllow(v);
            destIn.value = '';
        };
        destIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
        root.appendChild(h('div', { className: 'op-row' }, [destIn, h('button', { className: 'pt-btn pt-btn--sm', text: 'Add', onClick: add })]));
        els.requested = h('div', { className: 'io-requested' });
        root.appendChild(els.requested);

        // ---------------- Serial
        root.appendChild(h('div', { className: 'op-sec' }, [h('span', { className: 'pt-label', text: 'Serial ports' }), h('span', { className: 'io-sec-note', text: 'Serial In · Serial Out' })]));
        const schips = h('div', { className: 'io-chips' });
        if (!c.serialAllow.length) schips.appendChild(h('span', { className: 'io-empty', text: 'No port picked.' }));
        for (const p of c.serialAllow) {
            schips.appendChild(h('span', { className: 'io-chip' }, [
                h('span', { text: p }),
                h('button', { className: 'io-chip-x', 'aria-label': `Remove ${p}`, text: '×', onClick: () => c.removeSerial(p) })
            ]));
        }
        root.appendChild(schips);
        const sel = h('select', { className: 'op-select io-serial-select', 'aria-label': 'Serial port' });
        const ports = c.serialList || [];
        sel.appendChild(h('option', { value: '', text: ports.length ? 'Pick a port…' : (c.connected ? 'Scan to list ports' : 'Connect the bridge to list ports') }));
        for (const p of ports) {
            const o = h('option', { value: p.path, text: `${p.path}${p.manufacturer ? ` · ${p.manufacturer}` : ''}` });
            if (c.serialAllow.includes(p.path)) o.disabled = true;
            sel.appendChild(o);
        }
        sel.addEventListener('change', () => { if (sel.value) { c.addSerial(sel.value); copy(sel.value, 'Allowed · path copied for the Serial node'); } });
        const scan = h('button', {
            className: 'pt-btn pt-btn--sm', text: 'Scan', disabled: !c.connected || (c.features && c.features.serial === false),
            'data-tip': c.features && c.features.serial === false ? (c.features.serialError || 'Serial unavailable in the bridge') : 'List the serial ports the bridge sees',
            onClick: async () => {
                try { this.scanError = null; await c.listSerialPorts(); } catch (e) { this.scanError = e.message; }
                this.render(true);
            }
        });
        root.appendChild(h('div', { className: 'op-row' }, [sel, scan]));
        if (this.scanError) root.appendChild(h('div', { className: 'io-error', text: this.scanError }));
        if (c.features && c.features.serial === false) root.appendChild(h('div', { className: 'op-note', text: c.features.serialError || 'Serial is unavailable in this bridge.' }));
        els.requestedSerial = h('div', { className: 'io-requested' });
        root.appendChild(els.requestedSerial);

        // ---------------- MIDI out
        root.appendChild(h('div', { className: 'op-sec' }, [h('span', { className: 'pt-label', text: 'MIDI out' }), h('span', { className: 'io-sec-note', text: 'Web MIDI · no bridge' })]));
        els.midi = h('div', { className: 'io-line' });
        root.appendChild(els.midi);

        // ---------------- Activity
        root.appendChild(h('div', { className: 'op-sec' }, [h('span', { className: 'pt-label', text: 'Activity' })]));
        els.activity = h('div', { className: 'io-activity' });
        root.appendChild(els.activity);
        root.appendChild(h('div', { className: 'op-foot', text: 'The bridge only listens on 127.0.0.1, needs the token, and refuses anything this tab has not enabled and allowed. Settings stay in this browser, not in project files.' }));
    }

    _hasMidiNodes() {
        const g = this.app && this.app.nodeGraph;
        return !!(g && g.nodes.some(n => n.type === 'MIDIOutCC' || n.type === 'MIDIOutNote'));
    }

    update() {
        const els = this.els;
        if (!els.status) return;
        const c = ioClient;
        const link = c.linkState();
        const label = { ok: 'Active', wait: c.connected ? 'Paired · disabled' : 'Connecting…', error: c.status === 'auth-failed' ? 'Token rejected' : 'Bridge not running', off: c.token ? 'Idle' : 'Not paired' }[link.state];
        if (els.status.textContent !== label) els.status.textContent = label;
        els.status.dataset.state = link.state;

        // Bridge line
        let text;
        if (!c.token) text = 'Not paired: start the bridge, then paste its token.';
        else if (c.status === 'connected') text = `Connected to 127.0.0.1:${c.port} · session ${c.session || '?'}${c.features && c.features.serial ? ' · serial' : ''}${c.features && c.features.serialMock ? ' (+ mock ports)' : ''}`;
        else if (c.status === 'auth-failed') text = 'The bridge rejected the token (it changes each time the bridge starts): paste the new one.';
        else if (c.status === 'down') text = `Bridge not running on 127.0.0.1:${c.port}. Retrying…`;
        else text = `Connecting to 127.0.0.1:${c.port}…`;
        this._setLine(els.bridgeLine, link.state === 'wait' && c.connected ? 'ok' : link.state, text);
        els.hint.hidden = c.status === 'connected';

        // Requested destinations
        const req = [...c.requested.keys()].filter(k => !c.allow.includes(k));
        const reqKey = req.join('|');
        if (els.requested.dataset.key !== reqKey) {
            els.requested.dataset.key = reqKey;
            els.requested.innerHTML = '';
            if (req.length) {
                els.requested.appendChild(h('div', { className: 'io-req-title', text: 'Requested by this patch' }));
                for (const k of req) {
                    els.requested.appendChild(h('div', { className: 'io-req' }, [
                        h('code', { text: k }),
                        h('button', { className: 'pt-btn pt-btn--sm', text: 'Allow', 'data-tip': `Let this browser send to ${k}`, onClick: () => { c.addAllow(k); this.render(true); } })
                    ]));
                }
            }
        }
        const reqS = [...c.requestedSerial.keys()].filter(k => !c.serialAllow.includes(k));
        const reqSKey = reqS.join('|');
        if (els.requestedSerial.dataset.key !== reqSKey) {
            els.requestedSerial.dataset.key = reqSKey;
            els.requestedSerial.innerHTML = '';
            if (reqS.length) {
                els.requestedSerial.appendChild(h('div', { className: 'io-req-title', text: 'Requested by this patch' }));
                for (const k of reqS) {
                    els.requestedSerial.appendChild(h('div', { className: 'io-req' }, [
                        h('code', { text: k }),
                        h('button', { className: 'pt-btn pt-btn--sm', text: 'Allow', onClick: () => { c.addSerial(k); this.render(true); } })
                    ]));
                }
            }
        }

        // MIDI
        const m = midiOutput;
        const outs = m.outputs();
        const midiKey = `${m.state}|${outs.map(o => o.name).join(',')}|${c.optIn}`;
        if (els.midi.dataset.key !== midiKey) {
            els.midi.dataset.key = midiKey;
            els.midi.innerHTML = '';
            let st = 'off', t;
            if (m.state === 'ready') { st = outs.length ? 'ok' : 'wait'; t = outs.length ? outs.map(o => o.name).join(' · ') : 'No MIDI outputs (enable the IAC Driver in Audio MIDI Setup, or loopMIDI on Windows)'; }
            else if (m.state === 'unsupported' || m.state === 'denied') { st = 'error'; t = m.error; }
            else if (m.state === 'requesting') { st = 'wait'; t = 'Waiting for MIDI permission…'; }
            else t = 'Not requested yet';
            els.midi.appendChild(this._dot(st));
            els.midi.appendChild(h('span', { className: 'io-line-text', text: t }));
            if (m.state === 'idle' || m.state === 'denied') {
                els.midi.appendChild(h('button', { className: 'pt-btn pt-btn--sm', text: 'Enable MIDI', disabled: !c.optIn, 'data-tip': c.optIn ? 'Ask the browser for MIDI output access' : 'Enable I/O for this session first', onClick: () => m.enable().then(() => this.render(true)) }));
            }
        }

        // Activity
        const s = c.stats;
        const lines = [
            `out  OSC ${s.oscOut} · Art-Net ${s.artnetOut} · serial ${s.serialOut} · MIDI ${midiOutput.sent}`,
            `in   OSC ${s.oscIn} · serial ${s.serialIn}`,
        ];
        const listen = [...c.oscPorts.entries()].map(([p, r]) => `:${p}${r.listening ? (r.bind === '0.0.0.0' ? ' LAN' : '') : r.error ? ' ✕' : ' …'}`);
        if (listen.length) lines.push(`OSC In ${listen.join(' ')}`);
        if (c.lastIn) lines.push(`last in  ${c.lastIn.kind === 'osc' ? `${c.lastIn.address} ${fmtArgs(c.lastIn.args)}` : `${c.lastIn.path} ${c.lastIn.line !== null && c.lastIn.line !== undefined ? JSON.stringify(c.lastIn.line) : `${c.lastIn.bytes} bytes`}`} · ${ago(c.lastIn.t)}`);
        if (c.lastOut) lines.push(`last out ${c.lastOut.dest || c.lastOut.path || ''} ${c.lastOut.address || ''} ${c.lastOut.args ? fmtArgs(c.lastOut.args) : c.lastOut.channels !== undefined ? `${c.lastOut.channels} ch` : ''} · ${ago(c.lastOut.t)}`);
        if (c.lastError && Date.now() - c.lastError.t < 60000) lines.push(`error ${c.lastError.error} · ${ago(c.lastError.t)}`);
        const txt = lines.join('\n');
        if (els.activity.textContent !== txt) els.activity.textContent = txt;
    }

    _dot(state) {
        return h('span', { className: 'io-dot', 'data-state': state });
    }

    _setLine(el, state, text) {
        const key = `${state}|${text}`;
        if (el.dataset.key === key) return;
        el.dataset.key = key;
        el.innerHTML = '';
        el.appendChild(this._dot(state));
        el.appendChild(h('span', { className: 'io-line-text', text }));
    }
}
