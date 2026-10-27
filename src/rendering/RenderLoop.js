/**
 * RenderLoop - one per page: renders every live ShaderPreview (Preview nodes, the
 * background / fullscreen preview, help previews) once per animation frame, after the
 * frame's control ticks and Feedback passes (main.js calls frame() at the end of its
 * requestAnimationFrame callback). Replaces the per-preview requestAnimationFrame loops.
 *
 * Skipped work:
 *   - Preview nodes that are not visible: outside the canvas viewport, inside a group
 *     that is not open (another scope), or while the page is hidden. They resume (and
 *     the canvas redraws them) as soon as they are visible again.
 *   - Small thumbnails (quality other than High): a preview drawn under 160 CSS px wide
 *     renders every 2nd frame, under 80 px every 4th.
 *   - previews whose render() was suspended (output performance mode) cost nothing.
 *
 * Every preview is rendered in its own try/catch: one failing preview never stops
 * the others or the loop. Also polls async shader links (KHR_parallel_shader_compile)
 * and feeds the quality governor.
 */
import { quality } from './QualityGovernor.js';
import { programCache, shrinkCanvas } from './glResources.js';
import { loopErrors } from '../core/loopTrace.js';

const SMALL_PX = 160;
const TINY_PX = 80;

export class RenderLoop {
    constructor() {
        this.previews = new Set();
        this.hooks = new Set();
        this.app = null;
        this.frameNo = 0;
        this.lastNow = 0;
        this.warned = new WeakSet();
        this.stats = { frames: 0, rendered: 0, offscreen: 0, throttled: 0, errors: 0, ms: 0 };
        this._lastShrink = 0;
    }

    attach(app) {
        this.app = app;
    }

    add(preview) {
        this.previews.add(preview);
    }

    remove(preview) {
        this.previews.delete(preview);
    }

    has(preview) {
        return this.previews.has(preview);
    }

    /** Per-frame callback (after the previews); returns an unsubscribe function. */
    onFrame(fn) {
        this.hooks.add(fn);
        return () => this.hooks.delete(fn);
    }

    /**
     * Is a Preview node drawn on the canvas right now? Same viewport test (24 unit
     * margin) as GraphRenderer's culling, plus the open group scope.
     */
    nodeVisible(node) {
        const g = node.graph;
        if (!g || !g.canvas || !Array.isArray(g.nodes)) return true; // detached helper nodes
        if (g._originalRender) return false; // a fullscreen preview covers the canvas
        const ctl = g.groupCtl;
        if (ctl) {
            if (ctl.isTransitioning && ctl.isTransitioning()) return true;
            if (ctl.isVisible && !ctl.isVisible(node)) return false;
        }
        const canvas = g.canvas;
        const dpr = window.devicePixelRatio || 1;
        const cssW = canvas.width / dpr, cssH = canvas.height / dpr;
        const zoom = g.zoom || 1;
        const vx0 = -g.panX / zoom, vy0 = -g.panY / zoom;
        const vx1 = vx0 + cssW / zoom, vy1 = vy0 + cssH / zoom;
        const margin = 24;
        return !(node.x > vx1 + margin || node.y > vy1 + margin ||
            node.x + node.width < vx0 - margin || node.y + node.height < vy0 - margin);
    }

    /** Should this preview render in the current frame? */
    isDue(p) {
        const node = p.ownerNode;
        if (!node) return true;
        const g = node.graph;
        // Not on the canvas (quick-search ghost, library hover card): always cheap noise
        if (!g || !Array.isArray(g.nodes) || !g.nodes.includes(node)) return true;
        if (!this.nodeVisible(node)) { this.stats.offscreen++; return false; }
        if (quality.mode !== 'high') {
            const px = node.width * (g.zoom || 1);
            const every = px < TINY_PX ? 4 : px < SMALL_PX ? 2 : 1;
            if (every > 1 && (this.frameNo + (node.id | 0)) % every !== 0 && p.frameCount > 0) {
                this.stats.throttled++;
                return false;
            }
        }
        return true;
    }

    frame(now) {
        if (typeof document !== 'undefined' && document.hidden) return;
        const t0 = performance.now();
        this.frameNo++;
        this.stats.frames++;
        const dt = this.lastNow ? now - this.lastNow : 0;
        this.lastNow = now;
        const gl = this.app && this.app.sharedGL;
        // Async shader links that finished since the last frame
        if (gl) {
            try { programCache(gl).poll(); } catch (e) { this._warn(this, '[render] program poll failed', e); }
        }
        let bgShown = false;
        let thumbW = 0, thumbH = 0;
        for (const p of this.previews) {
            if (!this.isDue(p)) continue;
            try {
                p.frameTick();
                this.stats.rendered++;
                if (p.governor === 'background' && p.lastRenderShown) bgShown = true;
                if (p.ownerNode && p.framebuffer) {
                    if (p.width > thumbW) thumbW = p.width;
                    if (p.height > thumbH) thumbH = p.height;
                }
            } catch (e) {
                this.stats.errors++;
                // Attributed to the Preview node (or the background / fullscreen preview), throttled
                loopErrors.report(p.ownerNode ? 'render' : `render (${p.governor || 'preview'})`, p.ownerNode || null, e);
            }
        }
        // Node previews are outputs too (Feedback auto-scale sizes buffers for the largest shown)
        if (thumbW) quality.noteOutput('previews', thumbW, thumbH, 1, now);
        const gov = quality.governors.background;
        if (bgShown) gov.sample(dt, now); else gov.idle();
        for (const fn of this.hooks) {
            try { fn(now); } catch (e) { this._warn(fn, '[render] frame hook failed', e); }
        }
        if (gl && now - this._lastShrink > 5000) {
            this._lastShrink = now;
            try { shrinkCanvas(gl); } catch (e) { /* ignore */ }
        }
        this.stats.ms = performance.now() - t0;
    }

    _warn(key, msg, e) {
        if (this.warned.has(key)) return;
        this.warned.add(key);
        console.warn(msg, e);
    }

    status() {
        return { previews: this.previews.size, frame: this.frameNo, ...this.stats };
    }
}

export const renderLoop = new RenderLoop();
