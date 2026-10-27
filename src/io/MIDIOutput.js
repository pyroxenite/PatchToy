/**
 * Web MIDI output for the MIDI Out CC / Note nodes (src/core/library/io.js).
 * Runs in the browser directly, no bridge: navigator.requestMIDIAccess() gives
 * access to every MIDI output of the OS (IAC Driver on macOS, loopMIDI on
 * Windows, USB synths...). Reuses the MIDIService access when MIDI input is
 * already enabled, otherwise requests its own (quietly: no console errors when
 * Web MIDI is unavailable or denied).
 *
 * Gated by the same per-session I/O opt-in as the bridge (Output > I/O).
 */
import * as MIDIServiceModule from '../services/MIDIService.js';

class MIDIOutput {
    constructor() {
        this.access = null;
        this.state = 'idle';     // idle | requesting | ready | unsupported | denied
        this.error = null;
        this.sent = 0;
        this.last = null;
        this._req = null;
    }

    get supported() {
        return typeof navigator !== 'undefined' && typeof navigator.requestMIDIAccess === 'function';
    }

    /** Request MIDI access (once). Resolves to true when outputs can be used. */
    enable() {
        if (this.access) return Promise.resolve(true);
        const svc = MIDIServiceModule.midiService;
        if (svc && svc.midiAccess) {
            this.access = svc.midiAccess;
            this.state = 'ready';
            return Promise.resolve(true);
        }
        if (!this.supported) {
            this.state = 'unsupported';
            this.error = 'Web MIDI is not available in this browser';
            return Promise.resolve(false);
        }
        if (this._req) return this._req;
        this.state = 'requesting';
        this._req = navigator.requestMIDIAccess({ sysex: false }).then((access) => {
            this.access = access;
            this.state = 'ready';
            this.error = null;
            return true;
        }).catch((e) => {
            this.state = 'denied';
            this.error = (e && e.message) || 'MIDI access denied';
            return false;
        }).finally(() => { this._req = null; });
        return this._req;
    }

    outputs() {
        if (!this.access) return [];
        return Array.from(this.access.outputs.values()).map(o => ({ id: o.id, name: o.name, manufacturer: o.manufacturer, state: o.state }));
    }

    /** Output whose name contains `device` (case-insensitive); '' = the first one. */
    pick(device) {
        if (!this.access) return null;
        const outs = Array.from(this.access.outputs.values()).filter(o => o.state !== 'disconnected');
        const q = String(device || '').trim().toLowerCase();
        if (!q) return outs[0] || null;
        return outs.find(o => String(o.name || '').toLowerCase().includes(q)) || null;
    }

    /** { ok, state, text, name } */
    send(device, bytes) {
        if (!this.access) {
            if (this.state === 'idle') this.enable();
            return { ok: false, state: this.state === 'requesting' ? 'wait' : 'error', text: this.error || 'requesting MIDI access…' };
        }
        const out = this.pick(device);
        if (!out) return { ok: false, state: 'error', text: device ? `no MIDI output matching "${device}"` : 'no MIDI outputs (IAC Driver / loopMIDI?)' };
        try {
            out.send(bytes);
        } catch (e) {
            return { ok: false, state: 'error', text: e.message };
        }
        this.sent++;
        this.last = { name: out.name, bytes: Array.from(bytes), t: Date.now() };
        return { ok: true, state: 'ok', text: 'sent', name: out.name };
    }

    describe() {
        return { state: this.state, error: this.error || undefined, outputs: this.outputs(), sent: this.sent, last: this.last || undefined };
    }
}

export const midiOutput = new MIDIOutput();
