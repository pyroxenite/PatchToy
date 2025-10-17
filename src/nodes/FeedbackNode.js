import { Node } from './Node.js';
import { ShaderPreview } from '../rendering/ShaderPreview.js';

export class FeedbackNode extends Node {
    constructor(id, type, x, y) {
        super(id, type, x, y);

        this.isFeedbackNode = true;

        // Default buffer resolution
        if (!this.data.width) this.data.width = 512;
        if (!this.data.height) this.data.height = 512;

        // Ping-pong buffers (will be initialized when first rendered)
        this.readBuffer = null;
        this.writeBuffer = null;
        this.gl = null;

        // Track if buffers are initialized
        this.buffersInitialized = false;
    }

    /**
     * Initialize WebGL buffers for ping-pong rendering
     */
    initBuffers(gl) {
        if (this.buffersInitialized && this.gl === gl) return;

        this.gl = gl;
        const width = this.data.width;
        const height = this.data.height;

        // Create two framebuffers for ping-pong
        this.readBuffer = this.createFramebuffer(gl, width, height);
        this.writeBuffer = this.createFramebuffer(gl, width, height);

        this.buffersInitialized = true;

        console.log(`Initialized feedback buffers for node ${this.id}: ${width}x${height}`);
    }

    /**
     * Create a framebuffer with attached texture
     */
    createFramebuffer(gl, width, height) {
        const framebuffer = gl.createFramebuffer();
        const texture = gl.createTexture();

        // Set up texture - initialize with black color
        gl.bindTexture(gl.TEXTURE_2D, texture);

        // Create initial black pixel data
        const pixels = new Uint8Array(width * height * 4);
        for (let i = 0; i < pixels.length; i += 4) {
            pixels[i] = 0;     // R
            pixels[i + 1] = 0; // G
            pixels[i + 2] = 0; // B
            pixels[i + 3] = 255; // A (fully opaque)
        }

        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

        // Attach texture to framebuffer
        gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);

        // Check framebuffer status
        const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
        if (status !== gl.FRAMEBUFFER_COMPLETE) {
            console.error('Framebuffer incomplete:', status);
        }

        // Unbind
        gl.bindTexture(gl.TEXTURE_2D, null);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);

        return { framebuffer, texture };
    }

    /**
     * Swap read and write buffers (ping-pong)
     */
    swap() {
        const temp = this.readBuffer;
        this.readBuffer = this.writeBuffer;
        this.writeBuffer = temp;

        // Debug: Log swap
        console.log(`[Feedback ${this.id}] Swapped buffers - Read texture: ${this.readBuffer?.texture?.constructor.name}@${this.getTextureId(this.readBuffer?.texture)}, Write FB: ${this.getTextureId(this.writeBuffer?.texture)}`);
    }

    /**
     * Debug helper: Get a stable ID for a texture object
     */
    getTextureId(texture) {
        if (!texture) return 'null';
        if (!texture.__debugId) {
            texture.__debugId = Math.random().toString(36).substring(2, 11);
        }
        return texture.__debugId;
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
    cleanup() {
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
