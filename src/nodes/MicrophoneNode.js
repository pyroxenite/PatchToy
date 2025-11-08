import { Node } from './Node.js';

export class MicrophoneNode extends Node {
    constructor(id, type, x, y) {
        super(id, type, x, y);

        this.isMicrophoneNode = true;

        // Audio context and analysis
        this.audioContext = null;
        this.microphone = null;
        this.processor = null;

        // RMS value (updated at audio rate)
        this.rmsValue = 0.0;
        this.peakRMS = 0.0;

        // Decay in samples (higher = slower decay)
        this.decayRate = 0.9995; // Very slow decay for smooth falloff

        // State
        this.isActive = false;
        this.error = null;
    }

    // Override handleMouseDown to auto-enable microphone on any click
    handleMouseDown(x, y, event) {
        // Auto-enable microphone if not already enabled (uses user gesture from this click)
        if (!this.isActive) {
            console.log('[Microphone Node] Auto-enabling microphone from user gesture...');
            this.enable().then(success => {
                if (success) {
                    const btn = document.getElementById('micBtn');
                    if (btn) {
                        btn.style.background = '#007acc';
                        btn.style.borderColor = '#007acc';
                        btn.title = 'Microphone Active';
                    }
                }
            });
        }

        // Call parent to handle normal node interaction
        return super.handleMouseDown ? super.handleMouseDown(x, y, event) : null;
    }

    /**
     * Initialize microphone access
     */
    async enable() {
        if (this.isActive) return true;

        try {
            // Request microphone access with minimal latency
            const stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: false,
                    noiseSuppression: false,
                    autoGainControl: false,
                    latency: 0,
                    channelCount: 1
                }
            });

            // Create audio context with absolute minimum latency
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)({
                latencyHint: 'interactive',
                sampleRate: 48000
            });

            // Load the AudioWorklet processor
            await this.audioContext.audioWorklet.addModule('rms-processor.js');

            // Create microphone source
            this.microphone = this.audioContext.createMediaStreamSource(stream);

            // Create AudioWorklet node for audio-rate RMS calculation
            this.processor = new AudioWorkletNode(this.audioContext, 'rms-processor');

            // Receive RMS values from the worklet
            this.processor.port.onmessage = (event) => {
                this.rmsValue = event.data.rms;
            };

            // Connect: microphone -> processor
            // Note: No need to connect to destination unless we want to hear it
            this.microphone.connect(this.processor);

            this.isActive = true;
            this.error = null;


            return true;

        } catch (error) {
            console.error('Failed to enable microphone:', error);
            this.error = error.message;
            this.isActive = false;
            return false;
        }
    }

    /**
     * Disable microphone
     */
    disable() {
        if (!this.isActive) return;

        if (this.processor) {
            this.processor.disconnect();
            this.processor.onaudioprocess = null;
        }

        if (this.microphone) {
            this.microphone.disconnect();
            const stream = this.microphone.mediaStream;
            if (stream) {
                stream.getTracks().forEach(track => track.stop());
            }
        }

        if (this.audioContext) {
            this.audioContext.close();
        }

        this.audioContext = null;
        this.processor = null;
        this.microphone = null;
        this.isActive = false;

        console.log('Microphone disabled');
    }

    /**
     * Get current RMS value
     */
    getRMS() {
        return this.rmsValue;
    }

    /**
     * Cleanup
     */
    cleanup() {
        this.disable();
    }
}
