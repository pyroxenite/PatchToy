/**
 * MIDI Service - Singleton for managing Web MIDI API access
 * Tracks all MIDI CC values and provides them to MidiCCNodes
 */
export class MIDIService {
    constructor() {
        if (MIDIService.instance) {
            return MIDIService.instance;
        }
        MIDIService.instance = this;

        this.midiAccess = null;
        this.isEnabled = false;
        this.inputs = [];

        // Store CC values: key = "channel_cc" (e.g., "1_7" for channel 1, CC 7)
        // value = { value: 0-127, normalized: 0.0-1.0, timestamp: ms }
        this.ccValues = new Map();

        // Subscribers: Map<nodeId, callback>
        this.subscribers = new Map();

        // Note subscribers: Map<id, callback({ channel, note, velocity, on, allOff })>
        this.noteSubscribers = new Map();

        // Raw channel-message subscribers (MIDI learn / mappings, src/services/MidiMapper.js):
        // Map<id, callback({ status, type, channel, data1, data2, device, simulated })>
        this.rawSubscribers = new Map();
    }

    /**
     * Request MIDI access from browser
     */
    /** Request MIDI access. Overlapping calls (double click) share one request. */
    enable() {
        if (this.isEnabled) return Promise.resolve(true);
        if (this._enabling) return this._enabling;
        const p = this._requestAccess();
        this._enabling = p;
        p.finally(() => { if (this._enabling === p) this._enabling = null; });
        return p;
    }

    async _requestAccess() {
        if (!navigator.requestMIDIAccess) {
            if (!this._warnedUnsupported) { this._warnedUnsupported = true; console.error('[MIDI] Web MIDI API not supported in this browser'); }
            return false;
        }

        try {
            this.midiAccess = await navigator.requestMIDIAccess();
            this.isEnabled = true;
            this.lastError = null;

            // Setup input listeners
            this.setupInputs();

            // Listen for device connect/disconnect
            this.midiAccess.onstatechange = (e) => {
                this.setupInputs();
                try {
                    window.dispatchEvent(new CustomEvent('patchtoy:midi', { detail: { what: 'devices', port: e.port.name, state: e.port.state } }));
                } catch (err) { /* ignore */ }
            };

            return true;

        } catch (error) {
            // Every click on a MIDI node retries after a denial: log each kind of failure once
            const key = (error && (error.name || error.message)) || String(error);
            if (this.lastError !== key) console.error('[MIDI] Failed to enable:', error);
            this.lastError = key;
            this.isEnabled = false;
            return false;
        }
    }

    /**
     * Setup listeners for all MIDI inputs
     */
    setupInputs() {
        if (!this.midiAccess) return;

        // Clear old inputs
        this.inputs = [];

        // Iterate over all inputs
        for (const input of this.midiAccess.inputs.values()) {
            this.inputs.push(input);

            // Listen for MIDI messages
            input.onmidimessage = (message) => {
                this.handleMIDIMessage(message, input);
            };
        }

    }

    /**
     * Handle incoming MIDI message
     */
    handleMIDIMessage(message, input = null) {
        const [status, data1, data2] = message.data;

        // Extract message type and channel (0-15)
        const messageType = status & 0xF0;
        const channel = (status & 0x0F) + 1; // Convert to 1-16

        // Channel messages (not clock / sysex) go to the raw subscribers first
        if (status >= 0x80 && status < 0xF0 && this.rawSubscribers.size) {
            const event = {
                status, type: messageType, channel, data1: data1 & 0x7F, data2: (data2 || 0) & 0x7F,
                device: (input && input.name) || '', simulated: !!message.simulated
            };
            for (const callback of this.rawSubscribers.values()) {
                try {
                    callback(event);
                } catch (e) {
                    console.error('[MIDI] raw subscriber failed:', e);
                }
            }
        }

        // Handle Control Change messages (0xB0)
        if (messageType === 0xB0) {
            const ccNumber = data1;
            const value = Math.max(0, Math.min(127, data2 || 0));
            this.updateCC(channel, ccNumber, value);
            // CC 120 (all sound off) / 123 (all notes off)
            if (ccNumber === 120 || ccNumber === 123) {
                this.emitNote({ channel, note: -1, velocity: 0, on: false, allOff: true });
            }
        }

        // Note on (0x90, velocity 0 = note off) / note off (0x80)
        if (messageType === 0x90 || messageType === 0x80) {
            const velocity = Math.max(0, Math.min(127, data2 || 0));
            const on = messageType === 0x90 && velocity > 0;
            this.emitNote({ channel, note: data1, velocity: on ? velocity / 127 : 0, on });
        }
    }

    emitNote(event) {
        for (const callback of this.noteSubscribers.values()) {
            try {
                callback(event);
            } catch (e) {
                console.error('[MIDI] note subscriber failed:', e);
            }
        }
    }

    /** Subscribe to note on/off events: callback({ channel 1-16, note 0-127, velocity 0..1, on, allOff }) */
    subscribeNotes(id, callback) {
        this.noteSubscribers.set(id, callback);
    }

    unsubscribeNotes(id) {
        this.noteSubscribers.delete(id);
    }

    /** Subscribe to every channel message (CC, notes, pitch bend, aftertouch...) with its device name. */
    subscribeRaw(id, callback) {
        this.rawSubscribers.set(id, callback);
    }

    unsubscribeRaw(id) {
        this.rawSubscribers.delete(id);
    }

    /**
     * Feed a message as if a device had sent it (tests, automation simulate_midi):
     * reaches MIDI CC / Note nodes and mappings even without Web MIDI.
     */
    simulate(bytes, device = '') {
        const data = Uint8Array.from((bytes || []).map(b => Math.max(0, Math.min(255, Math.round(Number(b) || 0)))));
        if (!data.length) return;
        this.handleMIDIMessage({ data, simulated: true }, device ? { name: String(device) } : null);
    }

    /** MIDI outputs (empty until enabled). */
    getOutputs() {
        if (!this.midiAccess || !this.midiAccess.outputs) return [];
        return Array.from(this.midiAccess.outputs.values());
    }

    /** Send bytes to the outputs named `device` (every output when empty). Returns the number of ports. */
    send(device, bytes) {
        let n = 0;
        for (const out of this.getOutputs()) {
            if (device && out.name !== device) continue;
            try {
                out.send(bytes);
                n++;
            } catch (e) { /* port closed */ }
        }
        return n;
    }

    /**
     * Update a CC value and notify subscribers
     */
    updateCC(channel, ccNumber, value) {
        const key = `${channel}_${ccNumber}`;
        const normalized = value / 127.0;

        this.ccValues.set(key, {
            value: value,
            normalized: normalized,
            timestamp: Date.now()
        });

        // Notify subscribers interested in this CC
        for (const [nodeId, callback] of this.subscribers.entries()) {
            callback(channel, ccNumber, normalized);
        }
    }

    /**
     * Get current CC value (normalized 0.0-1.0)
     */
    getCC(channel, ccNumber) {
        const key = `${channel}_${ccNumber}`;
        const data = this.ccValues.get(key);
        return data ? data.normalized : 0.0;
    }

    /**
     * Subscribe to CC updates
     */
    subscribe(nodeId, callback) {
        this.subscribers.set(nodeId, callback);
    }

    /**
     * Unsubscribe from CC updates
     */
    unsubscribe(nodeId) {
        this.subscribers.delete(nodeId);
    }

    /**
     * Disable MIDI
     */
    disable() {
        if (!this.isEnabled) return;

        // Close all inputs
        if (this.midiAccess) {
            for (const input of this.midiAccess.inputs.values()) {
                input.onmidimessage = null;
            }
        }

        this.midiAccess = null;
        this.isEnabled = false;
        this.inputs = [];
        this.ccValues.clear();
        // Subscribers stay: nodes subscribe once (constructor) and must hear a later enable()
        this.emitNote({ channel: 0, note: -1, velocity: 0, on: false, allOff: true });
    }

    /**
     * Get list of available MIDI devices
     */
    getDevices() {
        if (!this.midiAccess) return [];

        return Array.from(this.midiAccess.inputs.values()).map(input => ({
            id: input.id,
            name: input.name,
            manufacturer: input.manufacturer,
            state: input.state
        }));
    }
}

// Export singleton instance
export const midiService = new MIDIService();
