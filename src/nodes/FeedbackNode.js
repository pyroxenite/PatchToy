import { Node } from './Node.js';
import { ShaderPreview } from '../rendering/ShaderPreview.js';
import { programCache } from '../rendering/glResources.js';

/**
 * Texture formats a Feedback buffer can use (data.format). rgba8 clamps to 0..1 with
 * 8-bit steps; the float formats keep any value (particle state, positions, HDR) but
 * need EXT_color_buffer_float to be rendered to. Without it they fall back to rgba8.
 */
export const FEEDBACK_FORMATS = {
    rgba8: { internal: 'RGBA', type: 'UNSIGNED_BYTE', float: false },
    rgba16f: { internal: 'RGBA16F', type: 'HALF_FLOAT', float: true },
    rgba32f: { internal: 'RGBA32F', type: 'FLOAT', float: true },
};

// Framebuffer completeness per context and texture format: checkFramebufferStatus is a
// synchronous GPU round trip (tens of ms on a busy GPU), and the answer does not depend
// on the size, so each format is checked once (buffer resizes then cost no round trip)
const completeFormats = new WeakMap(); // gl -> Map(format key -> complete)

const warnedOnce = new Set();
function warnOnce(message) {
    if (warnedOnce.has(message)) return;
    warnedOnce.add(message);
    console.warn(message);
}

/**
 * Resolve a requested format / filter against what the context supports.
 * Returns { name, internalFormat, type, linear }.
 */
export function resolveFeedbackFormat(gl, format, filter) {
    let name = typeof format === 'string' && format ? format.toLowerCase() : 'rgba8';
    if (!FEEDBACK_FORMATS[name]) {
        warnOnce(`Feedback: unknown format "${format}" (use rgba8, rgba16f or rgba32f), using rgba8`);
        name = 'rgba8';
    }
    let linear = filter !== 'nearest';
    if (FEEDBACK_FORMATS[name].float) {
        const isWebGL2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
        if (!isWebGL2 || !gl.getExtension('EXT_color_buffer_float')) {
            warnOnce(`Feedback: ${name} render targets need EXT_color_buffer_float, which this browser lacks; falling back to rgba8`);
            name = 'rgba8';
        } else if (name === 'rgba32f' && linear && !gl.getExtension('OES_texture_float_linear')) {
            warnOnce('Feedback: linear filtering of rgba32f needs OES_texture_float_linear, which this browser lacks; using nearest');
            linear = false;
        }
    }
    const f = FEEDBACK_FORMATS[name];
    return { name, internalFormat: gl[f.internal], type: gl[f.type], linear };
}

export class FeedbackNode extends Node {
    constructor(id, type, x, y) {
        super(id, type, x, y);

        this.isFeedbackNode = true;

        // Default buffer resolution
        if (!this.data.width) this.data.width = 512;
        if (!this.data.height) this.data.height = 512;
        // Texture format ('rgba8' | 'rgba16f' | 'rgba32f') and sampling filter ('linear' | 'nearest')
        if (!this.data.format) this.data.format = 'rgba8';
        if (!this.data.filter) this.data.filter = 'linear';

        // Ping-pong buffers (will be initialized when first rendered)
        this.readBuffer = null;
        this.writeBuffer = null;
        this.gl = null;

        // Track if buffers are initialized
        this.buffersInitialized = false;
    }

    getHeaderIcon() {
        return 'feedback';
    }

    /**
     * Initialize WebGL buffers for ping-pong rendering.
     * scale: buffer size relative to data.width / height (data.autoScale, see
     * QualityGovernor.feedbackScale; 1 otherwise). A scale change keeps the content
     * (resampled into the new buffers) so trails don't restart.
     */
    initBuffers(gl, scale = 1) {
        const fullW = Math.max(1, Math.min(4096, Math.round(this.data.width) || 512));
        const fullH = Math.max(1, Math.min(4096, Math.round(this.data.height) || 512));
        const s = scale > 0 && scale < 1 ? scale : 1;
        const width = Math.max(1, Math.round(fullW * s));
        const height = Math.max(1, Math.round(fullH * s));
        const formatKey = `${this.data.format || 'rgba8'}|${this.data.filter || 'linear'}`;
        if (this.buffersInitialized && this.gl === gl && this.bufferWidth === width && this.bufferHeight === height &&
            this.bufferFormatKey === formatKey) return;

        // Only the auto-scale changed: resample the current content into the new buffers
        const keep = this.buffersInitialized && this.gl === gl && this.bufferFormatKey === formatKey &&
            this.bufferFullW === fullW && this.bufferFullH === fullH ? this.readBuffer : null;
        const oldW = this.bufferWidth, oldH = this.bufferHeight;
        const old = keep ? { read: this.readBuffer, write: this.writeBuffer } : null;

        // Size / format changed (or new context): release the old buffers first
        if (this.buffersInitialized && !old) this.releaseBuffers();

        this.gl = gl;
        this.bufferWidth = width;
        this.bufferHeight = height;
        this.bufferFullW = fullW;
        this.bufferFullH = fullH;
        this.bufferScale = width / fullW;
        this.bufferFormatKey = formatKey;

        let format = resolveFeedbackFormat(gl, this.data.format, this.data.filter);

        // Create two framebuffers for ping-pong
        this.readBuffer = this.createFramebuffer(gl, width, height, format);
        this.writeBuffer = this.createFramebuffer(gl, width, height, format);

        // A float target the driver can't render to: fall back to rgba8
        if ((this.readBuffer.incomplete || this.writeBuffer.incomplete) && format.name !== 'rgba8') {
            console.warn(`Feedback #${this.id}: ${format.name} framebuffer is incomplete, falling back to rgba8`);
            this._deleteBuffers(this.readBuffer, this.writeBuffer);
            format = resolveFeedbackFormat(gl, 'rgba8', this.data.filter);
            this.readBuffer = this.createFramebuffer(gl, width, height, format);
            this.writeBuffer = this.createFramebuffer(gl, width, height, format);
        }
        this.bufferFormat = format.name;
        this.bufferFilter = format.linear ? 'linear' : 'nearest';

        if (old) {
            try {
                const filter = format.linear ? gl.LINEAR : gl.NEAREST;
                for (const dst of [this.readBuffer, this.writeBuffer]) {
                    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, old.read.framebuffer);
                    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, dst.framebuffer);
                    gl.blitFramebuffer(0, 0, oldW, oldH, 0, 0, width, height, gl.COLOR_BUFFER_BIT, filter);
                }
            } catch (e) { /* content restarts (cleared) */ }
            gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
            gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
            this._deleteBuffers(old.read, old.write);
        }

        this.buffersInitialized = true;

    }

    _deleteBuffers(...bufs) {
        const gl = this.gl;
        if (!gl) return;
        for (const b of bufs) {
            if (!b) continue;
            gl.deleteTexture(b.texture);
            gl.deleteFramebuffer(b.framebuffer);
        }
    }

    /**
     * Create a framebuffer with attached texture
     * (format: resolveFeedbackFormat() result; default rgba8 + linear)
     */
    createFramebuffer(gl, width, height, format = null) {
        const fmt = format || resolveFeedbackFormat(gl, 'rgba8', 'linear');
        const framebuffer = gl.createFramebuffer();
        const texture = gl.createTexture();

        // Set up texture - initialize with black color
        gl.bindTexture(gl.TEXTURE_2D, texture);

        if (fmt.name === 'rgba8') {
            // Transparent black: WebGL zero-initializes textures created from null (no
            // width x height x 4 byte upload from JS)
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        } else {
            // Float formats: WebGL2 zero-initializes textures created from null
            gl.texImage2D(gl.TEXTURE_2D, 0, fmt.internalFormat, width, height, 0, gl.RGBA, fmt.type, null);
        }
        const filter = fmt.linear ? gl.LINEAR : gl.NEAREST;
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

        // Attach texture to framebuffer
        gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);

        // Check framebuffer status (once per format, see completeFormats)
        let known = completeFormats.get(gl);
        if (!known) completeFormats.set(gl, known = new Map());
        const key = `${fmt.internalFormat}|${fmt.type}`;
        let incomplete = known.has(key) ? !known.get(key) : null;
        if (incomplete === null) {
            const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
            incomplete = status !== gl.FRAMEBUFFER_COMPLETE;
            known.set(key, !incomplete);
            if (incomplete) {
                console.error('Framebuffer incomplete:', status, fmt.name);
            }
        }

        // Unbind
        gl.bindTexture(gl.TEXTURE_2D, null);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);

        return { framebuffer, texture, incomplete };
    }

    /**
     * Swap read and write buffers (ping-pong)
     */
    swap() {
        const temp = this.readBuffer;
        this.readBuffer = this.writeBuffer;
        this.writeBuffer = temp;
    }

    /**
     * Get the texture to read from (previous frame)
     */
    getReadTexture() {
        return this.readBuffer ? this.readBuffer.texture : null;
    }

    /**
     * Get the framebuffer to write to (current frame)
     */
    getWriteFramebuffer() {
        return this.writeBuffer ? this.writeBuffer.framebuffer : null;
    }

    /**
     * Clean up WebGL resources
     */
    /** The node is going away (deleted, project switch): buffers and the pass's program reference. */
    cleanup() {
        if (!this.gl) return;
        // The pass's program is shared (ProgramCache): drop this node's reference
        if (this.compiledProgram && this.compiledProgram.entry) {
            try { programCache(this.gl).release(this.compiledProgram.entry); } catch (e) { /* ignore */ }
        }
        // ...and the one still linking in the background (FeedbackRenderer async compile)
        if (this.pendingLink) {
            try { programCache(this.gl).release(this.pendingLink.entry); } catch (e) { /* ignore */ }
        }
        this.pendingLink = null;
        this.compiledProgram = null;
        this.compiledShader = null;
        this.releaseBuffers();
    }

    /** Free the ping-pong buffers (size / format change, cleanup). */
    releaseBuffers() {
        if (!this.gl) return;

        if (this.readBuffer) {
            this.gl.deleteTexture(this.readBuffer.texture);
            this.gl.deleteFramebuffer(this.readBuffer.framebuffer);
        }

        if (this.writeBuffer) {
            this.gl.deleteTexture(this.writeBuffer.texture);
            this.gl.deleteFramebuffer(this.writeBuffer.framebuffer);
        }

        this.readBuffer = null;
        this.writeBuffer = null;
        this.buffersInitialized = false;
    }
}
