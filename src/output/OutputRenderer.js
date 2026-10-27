import { ShaderPreview } from '../rendering/ShaderPreview.js';
import { buildMesh, isIdentity } from './Calibration.js';
import { ensureCanvasSize } from '../rendering/glResources.js';

/**
 * GPU side of the output toolkit. Everything renders in the app's shared WebGL
 * context (Feedback render targets only exist there):
 *
 *   SourceRenderer  renders one Preview node's current shader into an offscreen
 *                   framebuffer at any size (recording / output resolution).
 *   WarpPass        draws such a frame into the shared canvas, optionally through
 *                   the projection-mapping warp (keystone + grid mesh), edge blend,
 *                   polygon mask or a test pattern.
 *   copyToCanvas    copies the drawn region onto a 2D canvas (recorder canvas,
 *                   output window canvas) - a GPU-side drawImage, no readPixels.
 */

/** A ShaderPreview without its own requestAnimationFrame loop (rendered on demand). */
class ManualPreview extends ShaderPreview {
    animate() { /* driven by the output loop */ }
}

export class SourceRenderer {
    constructor(app) {
        this.app = app;
        this.gl = app.sharedGL;
        this.preview = new ManualPreview(null, app.videoElement, {
            sharedGL: this.gl,
            offscreen: true,
            width: 16,
            height: 16,
            uniformRegistry: app.uniformRegistry || null
        });
        // The 16x16 framebuffer created by the constructor is replaced by per-size targets
        if (this.preview.framebuffer) {
            this.gl.deleteTexture(this.preview.framebuffer.texture);
            this.gl.deleteFramebuffer(this.preview.framebuffer.framebuffer);
            this.preview.framebuffer = null;
        }
        this.preview.graph = app.nodeGraph;
        this.node = null;
        this.srcProgram = null;
        this.targets = new Map(); // "WxH" -> { framebuffer, texture, w, h, stamp, used }
    }

    /** Follow the node's renderer: reload when it linked a new program. */
    sync(node) {
        const r = node && node.renderer;
        if (node !== this.node) {
            this.node = node;
            this.srcProgram = undefined;
        }
        const program = r ? r.program : null;
        if (program === this.srcProgram) return;
        this.srcProgram = program;
        if (program && r.currentShaderSource) {
            if (!this.preview.loadShader(r.currentShaderSource)) this.clearProgram();
        } else {
            this.clearProgram();
        }
    }

    clearProgram() {
        this.preview.program = null; // releases the shared program (ProgramCache)
        this.preview.customUniformValues = [];
    }

    target(w, h) {
        const key = `${w}x${h}`;
        let t = this.targets.get(key);
        if (!t) {
            const fb = this.preview.createFramebuffer(this.gl, w, h);
            t = { ...fb, w, h, stamp: -1, used: 0 };
            this.targets.set(key, t);
        }
        t.used = performance.now();
        return t;
    }

    /**
     * Render the node's shader at w x h (once per stamp, e.g. clock.frame) and
     * return the colour texture. Without a shader the frame is black.
     */
    render(node, w, h, stamp = null) {
        const gl = this.gl;
        this.sync(node);
        const t = this.target(w, h);
        if (stamp !== null && t.stamp === stamp) return t.texture;
        t.stamp = stamp;
        const p = this.preview;
        if (!p.program) {
            gl.bindFramebuffer(gl.FRAMEBUFFER, t.framebuffer);
            gl.viewport(0, 0, w, h);
            gl.clearColor(0, 0, 0, 1);
            gl.clear(gl.COLOR_BUFFER_BIT);
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            return t.texture;
        }
        p.framebuffer = t;
        p.width = w;
        p.height = h;
        // Same values as the node's own preview this frame (graph video sources, feedback reads)
        if (node && node.renderer && node.renderer.customUniformValues) p.customUniformValues = node.renderer.customUniformValues;
        p.refreshTextureUniforms();
        p.render();
        p.framebuffer = null;
        return t.texture;
    }

    /** Free render targets not used for a while (resolution changes). */
    gc(maxAgeMs = 3000) {
        const now = performance.now();
        for (const [key, t] of this.targets) {
            if (now - t.used > maxAgeMs) {
                this.gl.deleteTexture(t.texture);
                this.gl.deleteFramebuffer(t.framebuffer);
                this.targets.delete(key);
            }
        }
    }

    destroy() {
        for (const t of this.targets.values()) {
            this.gl.deleteTexture(t.texture);
            this.gl.deleteFramebuffer(t.framebuffer);
        }
        this.targets.clear();
        this.clearProgram();
        // The noise program, quad and camera texture are shared per context (glResources)
        this.preview.destroy();
        this.preview = null;
    }
}

const VS = `#version 300 es
in vec4 a_pos;
in vec2 a_uv;
out vec2 v_uv;
void main() {
    v_uv = a_uv;
    gl_Position = a_pos;
}`;

const FS = `#version 300 es
precision highp float;
in vec2 v_uv;                 // content uv, origin top-left
uniform sampler2D u_tex;
uniform int u_hasTex;
uniform vec2 u_contentSize;   // pixels
uniform vec2 u_outSize;       // pixels
uniform int u_pattern;        // 0 off, 1 grid, 2 bars, 3 white
uniform vec4 u_blend;         // left, right, top, bottom widths (content uv)
uniform float u_blendCurve;
uniform float u_blendGamma;
uniform int u_maskCount;
uniform vec2 u_mask[32];      // output space, origin top-left
uniform int u_maskInvert;
uniform float u_maskFeather;  // pixels
out vec4 fragColor;

float ramp(float x) {
    x = clamp(x, 0.0, 1.0);
    float f = x < 0.5 ? 0.5 * pow(2.0 * x, u_blendCurve) : 1.0 - 0.5 * pow(2.0 * (1.0 - x), u_blendCurve);
    return pow(f, 1.0 / u_blendGamma);
}

float line(float d, float px) {
    // anti-aliased line of half-width px pixels; d = distance in pixels
    return 1.0 - smoothstep(px - 0.75, px + 0.75, d);
}

vec3 testPattern(vec2 uv) {
    vec2 px = uv * u_contentSize;
    if (u_pattern == 3) return vec3(1.0);
    if (u_pattern == 2) {
        // colour bars (75%) over a grey ramp and a PLUGE-style strip
        if (uv.y < 0.67) {
            int i = int(floor(uv.x * 7.0));
            vec3 bars[7] = vec3[7](vec3(.75), vec3(.75,.75,0.), vec3(0.,.75,.75), vec3(0.,.75,0.), vec3(.75,0.,.75), vec3(.75,0.,0.), vec3(0.,0.,.75));
            return bars[clamp(i, 0, 6)];
        }
        if (uv.y < 0.78) return vec3(floor(uv.x * 16.0) / 15.0);
        return vec3(uv.x);
    }
    // grid: square cells, crosshair, centre circle, border, corner triangles
    float cell = u_contentSize.y / 9.0;
    vec2 g = abs(mod(px + cell * 0.5, cell) - cell * 0.5);
    vec2 c = u_contentSize * 0.5;
    vec3 col = vec3(0.04);
    col = mix(col, vec3(0.45), line(min(g.x, g.y), 0.6));
    vec2 sub = abs(mod(px + cell * 0.25, cell * 0.5) - cell * 0.25);
    col = mix(col, vec3(0.2), line(min(sub.x, sub.y), 0.4) * 0.8);
    float cross = min(abs(px.x - c.x), abs(px.y - c.y));
    col = mix(col, vec3(1.0, 0.36, 0.17), line(cross, 1.2));
    float r = length(px - c);
    col = mix(col, vec3(1.0), line(abs(r - u_contentSize.y * 0.4), 1.2));
    col = mix(col, vec3(1.0), line(abs(r - u_contentSize.y * 0.12), 1.0));
    vec2 e = min(px, u_contentSize - px);
    col = mix(col, vec3(0.96, 0.78, 0.29), line(min(e.x, e.y), 2.0));
    // corner markers: TL red, TR green, BR blue, BL yellow
    float m = cell * 0.9;
    if (px.x < m && px.y < m && px.x + px.y < m) col = vec3(1.0, 0.2, 0.25);
    if (px.x > u_contentSize.x - m && px.y < m && (u_contentSize.x - px.x) + px.y < m) col = vec3(0.3, 0.9, 0.5);
    if (px.x > u_contentSize.x - m && px.y > u_contentSize.y - m && (u_contentSize.x - px.x) + (u_contentSize.y - px.y) < m) col = vec3(0.35, 0.55, 1.0);
    if (px.x < m && px.y > u_contentSize.y - m && px.x + (u_contentSize.y - px.y) < m) col = vec3(1.0, 0.85, 0.2);
    return col;
}

float segDist(vec2 p, vec2 a, vec2 b) {
    vec2 pa = p - a, ba = b - a;
    float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-9), 0.0, 1.0);
    return length(pa - ba * h);
}

float polygonMask(vec2 frag) {
    // frag: output pixels, origin top-left
    bool inside = false;
    float d = 1e9;
    vec2 prev = u_mask[0] * u_outSize;
    for (int i = 0; i < 32; i++) {
        if (i >= u_maskCount) break;
        int j = i + 1 == u_maskCount ? 0 : i + 1;
        vec2 a = u_mask[i] * u_outSize;
        vec2 b = u_mask[j] * u_outSize;
        if (((a.y > frag.y) != (b.y > frag.y)) && (frag.x < (b.x - a.x) * (frag.y - a.y) / (b.y - a.y) + a.x)) inside = !inside;
        d = min(d, segDist(frag, a, b));
    }
    float m = inside ? (u_maskFeather > 0.0 ? smoothstep(0.0, u_maskFeather, d) : 1.0) : 0.0;
    return u_maskInvert == 1 ? 1.0 - m : m;
}

void main() {
    vec2 uv = v_uv;
    vec3 col;
    if (u_pattern > 0) col = testPattern(uv);
    else if (u_hasTex == 1) col = texture(u_tex, vec2(uv.x, 1.0 - uv.y)).rgb;
    else col = vec3(0.0);

    float b = 1.0;
    if (u_blend.x > 0.0) b *= ramp(uv.x / u_blend.x);
    if (u_blend.y > 0.0) b *= ramp((1.0 - uv.x) / u_blend.y);
    if (u_blend.z > 0.0) b *= ramp(uv.y / u_blend.z);
    if (u_blend.w > 0.0) b *= ramp((1.0 - uv.y) / u_blend.w);
    col *= b;

    if (u_maskCount >= 3) {
        vec2 frag = vec2(gl_FragCoord.x, u_outSize.y - gl_FragCoord.y);
        col *= polygonMask(frag);
    }
    fragColor = vec4(col, 1.0);
}`;

function compile(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(s);
        gl.deleteShader(s);
        throw new Error(`Output warp shader: ${log}`);
    }
    return s;
}

const IDENTITY = { corners: [[0, 0], [1, 0], [1, 1], [0, 1]], gridSize: 0, grid: [], blend: { left: 0, right: 0, top: 0, bottom: 0, curve: 2, gamma: 2.2 }, mask: { points: [], invert: false, feather: 0 }, pattern: 'off' };
const PATTERN_IDS = { off: 0, grid: 1, bars: 2, white: 3 };

export class WarpPass {
    constructor(gl) {
        this.gl = gl;
        const vs = compile(gl, gl.VERTEX_SHADER, VS);
        const fs = compile(gl, gl.FRAGMENT_SHADER, FS);
        const p = gl.createProgram();
        gl.attachShader(p, vs);
        gl.attachShader(p, fs);
        gl.linkProgram(p);
        gl.deleteShader(vs);
        gl.deleteShader(fs);
        if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`Output warp link: ${gl.getProgramInfoLog(p)}`);
        this.program = p;
        this.loc = {};
        for (const name of ['u_tex', 'u_hasTex', 'u_contentSize', 'u_outSize', 'u_pattern', 'u_blend', 'u_blendCurve', 'u_blendGamma', 'u_maskCount', 'u_mask', 'u_maskInvert', 'u_maskFeather']) {
            this.loc[name] = gl.getUniformLocation(p, name);
        }
        // Own vertex array object: the rest of the app uses the default VAO
        this.vao = gl.createVertexArray();
        this.posBuf = gl.createBuffer();
        this.uvBuf = gl.createBuffer();
        this.idxBuf = gl.createBuffer();
        gl.bindVertexArray(this.vao);
        const aPos = gl.getAttribLocation(p, 'a_pos');
        const aUv = gl.getAttribLocation(p, 'a_uv');
        gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuf);
        gl.enableVertexAttribArray(aPos);
        gl.vertexAttribPointer(aPos, 4, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.uvBuf);
        gl.enableVertexAttribArray(aUv);
        gl.vertexAttribPointer(aUv, 2, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.idxBuf);
        gl.bindVertexArray(null);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
        this.meshKey = null;
        this.count = 0;
        this.maskArray = new Float32Array(64);
    }

    _mesh(cal) {
        const key = JSON.stringify([cal.corners, cal.gridSize, cal.grid]);
        if (key === this.meshKey) return;
        this.meshKey = key;
        const simple = isIdentity(cal);
        const mesh = buildMesh(cal, simple ? 1 : (cal.gridSize ? 48 : 24));
        const gl = this.gl;
        gl.bindVertexArray(this.vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuf);
        gl.bufferData(gl.ARRAY_BUFFER, mesh.pos, gl.DYNAMIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.uvBuf);
        gl.bufferData(gl.ARRAY_BUFFER, mesh.uv, gl.DYNAMIC_DRAW);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.idxBuf);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.idx, gl.DYNAMIC_DRAW);
        gl.bindVertexArray(null);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
        this.count = mesh.idx.length;
    }

    /**
     * Draw `texture` (content frame, contentW x contentH) into the bottom-left
     * outW x outH region of the shared canvas (grown if needed). cal = null: plain blit.
     */
    draw(texture, contentW, contentH, outW, outH, cal = null) {
        const gl = this.gl;
        const c = cal || IDENTITY;
        ensureCanvasSize(gl, outW, outH);
        this._mesh(c);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, outW, outH);
        gl.disable(gl.BLEND);
        gl.disable(gl.DEPTH_TEST);
        gl.disable(gl.SCISSOR_TEST);
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.useProgram(this.program);
        const L = this.loc;
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, texture || null);
        gl.uniform1i(L.u_tex, 0);
        gl.uniform1i(L.u_hasTex, texture ? 1 : 0);
        gl.uniform2f(L.u_contentSize, contentW, contentH);
        gl.uniform2f(L.u_outSize, outW, outH);
        gl.uniform1i(L.u_pattern, PATTERN_IDS[c.pattern] || 0);
        const b = c.blend;
        gl.uniform4f(L.u_blend, b.left, b.right, b.top, b.bottom);
        gl.uniform1f(L.u_blendCurve, b.curve);
        gl.uniform1f(L.u_blendGamma, b.gamma);
        const pts = c.mask.points;
        const n = pts.length >= 3 ? Math.min(32, pts.length) : 0;
        gl.uniform1i(L.u_maskCount, n);
        if (n) {
            this.maskArray.fill(0);
            for (let i = 0; i < n; i++) { this.maskArray[i * 2] = pts[i][0]; this.maskArray[i * 2 + 1] = pts[i][1]; }
            gl.uniform2fv(L.u_mask, this.maskArray);
        }
        gl.uniform1i(L.u_maskInvert, c.mask.invert ? 1 : 0);
        gl.uniform1f(L.u_maskFeather, c.mask.feather || 0);
        gl.bindVertexArray(this.vao);
        gl.drawElements(gl.TRIANGLES, this.count, gl.UNSIGNED_SHORT, 0);
        gl.bindVertexArray(null);
        gl.bindTexture(gl.TEXTURE_2D, null);
    }

    destroy() {
        const gl = this.gl;
        gl.deleteProgram(this.program);
        gl.deleteVertexArray(this.vao);
        gl.deleteBuffer(this.posBuf);
        gl.deleteBuffer(this.uvBuf);
        gl.deleteBuffer(this.idxBuf);
    }
}

/** Copy the bottom-left w x h region of the shared GL canvas onto a 2D context. */
export function copyToCanvas(gl, ctx2d, w, h) {
    const glCanvas = gl.canvas;
    ctx2d.drawImage(glCanvas, 0, glCanvas.height - h, w, h, 0, 0, w, h);
}
