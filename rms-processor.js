// AudioWorklet processor for ultra-low latency audio analysis
class RMSProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.envelope = 0.0;
        this.decayRate = 0.99; // Smooth decay
    }

    process(inputs, outputs, parameters) {
        const input = inputs[0];

        if (input.length > 0) {
            const samples = input[0]; // Get first channel

            // Find peak in this buffer (most responsive to transients)
            let peak = 0.0;
            for (let i = 0; i < samples.length; i++) {
                const abs = Math.abs(samples[i]);
                if (abs > peak) {
                    peak = abs;
                }
            }

            // Also calculate RMS for comparison
            let sum = 0;
            for (let i = 0; i < samples.length; i++) {
                sum += samples[i] * samples[i];
            }
            const rms = Math.sqrt(sum / samples.length);

            // Use whichever is higher (catches both sustained and transient sounds)
            const current = Math.max(peak * 0.7, rms); // Scale peak down slightly

            // Instant attack, smooth decay
            if (current > this.envelope) {
                this.envelope = current;
            } else {
                this.envelope *= this.decayRate;
            }

            // Send value to main thread
            this.port.postMessage({ rms: this.envelope });
        }

        // Keep processor alive
        return true;
    }
}

registerProcessor('rms-processor', RMSProcessor);
