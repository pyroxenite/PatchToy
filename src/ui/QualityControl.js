/**
 * Render quality control (status bar, next to the fps meter): the current mode and
 * render scale of the governed outputs ("Auto · 75%"); click for the menu:
 *
 *   Auto / High / Balanced / Performance   (QualityGovernor.js)
 *   live scales: background / fullscreen, output window
 *   Feedback auto-scale for the open project (sets data.autoScale on its Feedback nodes)
 *
 * Node previews always render at full resolution; recordings and offline exports always
 * render at full quality.
 */
import { quality, QUALITY_MODES, QUALITY_KEYS } from '../rendering/QualityGovernor.js';
import { UIHelpers } from './UIHelpers.js';
import { icon } from './icons.js';

const pct = (s) => `${Math.round(s * 100)}%`;

export class QualityControl {
    constructor(app) {
        this.app = app;
        this.menu = null;
        this.btn = this.createButton();
        quality.on(() => this.update());
        // The governor's activity changes without events (background shown / hidden)
        this._timer = setInterval(() => this.update(), 1000);
        this.update();
    }

    createButton() {
        const btn = document.createElement('button');
        btn.id = 'sbQuality';
        btn.type = 'button';
        btn.className = 'sb-item sb-quality';
        btn.setAttribute('aria-haspopup', 'menu');
        btn.innerHTML = `${icon('sliders', { size: 12 })}<span class="sb-quality-text">Auto</span>`;
        btn.addEventListener('click', () => this.toggleMenu());
        const fps = document.getElementById('sbFps');
        if (fps && fps.parentElement) fps.parentElement.insertBefore(btn, fps);
        return btn;
    }

    /** Label: mode, plus the scale while a governed output renders below 100 %. */
    label() {
        const mode = QUALITY_MODES[quality.mode].label;
        const scales = [];
        for (const g of Object.values(quality.governors)) if (g.active) scales.push(g.scale);
        const s = scales.length ? Math.min(...scales) : null;
        if (s !== null && s < 1) return `${mode} · ${pct(s)}`;
        if (s !== null && quality.governed) return `${mode} · 100%`;
        return mode;
    }

    update() {
        const t = this.btn.querySelector('.sb-quality-text');
        const text = this.label();
        if (t && t.textContent !== text) t.textContent = text;
        const bg = quality.governors.background, out = quality.governors.output;
        const tip = `Render quality: ${QUALITY_MODES[quality.mode].label}` +
            (bg.active ? ` · background ${pct(bg.scale)}` : '') +
            (out.active ? ` · output window ${pct(out.scale)}` : '');
        if (this.btn.getAttribute('data-tip') !== tip) {
            this.btn.setAttribute('data-tip', tip);
            UIHelpers.refreshTooltip?.(this.btn);
        }
        this.btn.classList.toggle('is-scaled', /· (?!100%)\d+%/.test(text));
        if (this.menu && !this.menu.closed) this.renderMenu(this.menu.el.firstChild);
    }

    toggleMenu() {
        if (this.menu && !this.menu.closed) { this.menu.close(); return; }
        const content = document.createElement('div');
        content.className = 'pq-menu';
        this.renderMenu(content);
        this.menu = UIHelpers.openMenu({ anchor: this.btn, content, align: 'end', className: 'pq-pop', onClose: () => { this.menu = null; } });
        // Above the status bar
        const r = this.btn.getBoundingClientRect();
        const m = this.menu.el;
        m.style.top = `${Math.max(8, r.top - m.offsetHeight - 6)}px`;
    }

    feedbackNodes() {
        return (this.app.nodeGraph?.nodes || []).filter(n => n.isFeedbackNode);
    }

    renderMenu(root) {
        if (!root) return;
        const fbs = this.feedbackNodes();
        const opted = fbs.filter(n => n.data && n.data.autoScale).length;
        const bg = quality.governors.background, out = quality.governors.output;
        const row = (label, g) => {
            const st = g.status();
            const state = g.active ? `${pct(g.scale)} · ${Math.round(1000 / Math.max(1, st.avg_ms || 16.7))} fps` : 'not shown';
            return `<div class="pq-row"><span>${label}</span><span class="pq-val${g.active && g.scale < 1 ? ' is-scaled' : ''}">${state}</span></div>`;
        };
        const fbScales = fbs.filter(n => n.data && n.data.autoScale && n.bufferWidth)
            .map(n => `#${n.id} ${n.bufferWidth}×${n.bufferHeight}`).slice(0, 4).join(', ');
        root.innerHTML = `
            <div class="pq-head">Render quality</div>
            <div class="pq-modes" role="radiogroup">
                ${QUALITY_KEYS.map(k => `
                <button type="button" class="pq-mode${quality.mode === k ? ' is-on' : ''}" role="radio" aria-checked="${quality.mode === k}" data-mode="${k}">
                    <span class="pq-dot"></span>
                    <span class="pq-mode-text"><span class="pq-mode-label">${QUALITY_MODES[k].label}</span><span class="pq-mode-hint">${QUALITY_MODES[k].hint}</span></span>
                </button>`).join('')}
            </div>
            <div class="pt-menu-sep"></div>
            ${row('Background / fullscreen', bg)}
            ${row('Output window', out)}
            <div class="pq-row"><span>Node previews</span><span class="pq-val">100% · off-screen paused</span></div>
            <div class="pq-row"><span>Recording / export</span><span class="pq-val">100%</span></div>
            ${fbs.length ? `
            <div class="pt-menu-sep"></div>
            <div class="pq-row"><span>Feedback auto-scale</span><span class="pq-val">${opted} of ${fbs.length} node${fbs.length === 1 ? '' : 's'}</span></div>
            <div class="pq-note">Sizes Feedback buffers to the output being shown (and its render scale). Only for buffers that hold images (trails, blur): simulations stored in pixels need their exact size.${fbScales ? ` Now: ${fbScales}.` : ''}</div>
            <button type="button" class="pt-btn pt-btn--sm pq-fb">${opted === fbs.length ? 'Turn off for this project' : 'Turn on for this project'}</button>` : ''}
        `;
        for (const b of root.querySelectorAll('.pq-mode')) {
            b.addEventListener('click', (e) => {
                e.stopPropagation();
                quality.setMode(b.dataset.mode);
                this.app.shell?.activity?.(`Render quality: ${QUALITY_MODES[b.dataset.mode].label}`, { local: true });
            });
        }
        const fbBtn = root.querySelector('.pq-fb');
        if (fbBtn) {
            fbBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const on = opted !== fbs.length;
                for (const n of fbs) {
                    if (on) n.data.autoScale = true; else delete n.data.autoScale;
                }
                // A project edit: saved with the project, undoable
                this.app.nodeGraph.onGraphChanged?.();
                this.renderMenu(root);
            });
        }
    }
}
