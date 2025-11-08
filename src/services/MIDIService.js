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
    }

    /**
     * Request MIDI access from browser
     */
    async enable() {
        if (this.isEnabled) {
            console.log('[MIDI] Already enabled');
            return true;
        }

        if (!navigator.requestMIDIAccess) {
            console.error('[MIDI] Web MIDI API not supported in this browser');
            return false;
        }

        try {
            this.midiAccess = await navigator.requestMIDIAccess();
            this.isEnabled = true;

            // Setup input listeners
            this.setupInputs();

            // Listen for device connect/disconnect
            this.midiAccess.onstatechange = (e) => {
                console.log('[MIDI] Device state changed:', e.port.name, e.port.state);
                this.setupInputs();
            };

            console.log('[MIDI] Enabled successfully');
            return true;

        } catch (error) {
            console.error('[MIDI] Failed to enable:', error);
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
            console.log('[MIDI] Found input:', input.name);
            this.inputs.push(input);

            // Listen for MIDI messages
            input.onmidimessage = (message) => {
                this.handleMIDIMessage(message);
            };
        }

        console.log(`[MIDI] Listening to ${this.inputs.length} input(s)`);
    }

    /**
     * Handle incoming MIDI message
     */
    handleMIDIMessage(message) {
        const [status, data1, data2] = message.data;

        // Extract message type and channel (0-15)
        const messageType = status & 0xF0;
        const channel = (status & 0x0F) + 1; // Convert to 1-16

        // Handle Control Change messages (0xB0)
        if (messageType === 0xB0) {
            const ccNumber = data1;
            const value = data2;
            this.updateCC(channel, ccNumber, value);
        }
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
        this.subscribers.clear();

        console.log('[MIDI] Disabled');
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
