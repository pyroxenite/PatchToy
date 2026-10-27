import { UIHelpers, h } from './UIHelpers.js';
import { icon } from './icons.js';
import { FloatingCodeEditor } from './FloatingCodeEditor.js';
import { DEMOS } from './demoManifest.js';

/**
 * Demo gallery: browse and open the demo patches shipped in /projects
 * (discovered by demoManifest.js). Names, descriptions and node counts are read
 * from each project JSON when the gallery opens, and cached for the session.
 */

/** Live-input nodes worth flagging on a card (node type -> tag). */
const INPUT_TAGS = {
    Mouse: 'Mouse',
    Camera: 'Webcam',
    Microphone: 'Mic',
    'MIDI CC': 'MIDI',
    'MIDI Note': 'MIDI',
    Keyboard: 'Keys'
};

const PLACEHOLDER_COLORS = ['#ff5c2b', '#f5c84b', '#4ade80', '#8ecbff', '#a78bfa', '#f472b6', '#2dd4bf'];

/** First clause of a description, without "Demo:" style prefixes. */
function tagline(description = '') {
    let s = String(description).trim().replace(/^(high[- ]end\s+)?demo\s*:\s*/i, '');
    const cut = s.search(/[:;]\s|\.\s|\.$/);
    if (cut > 12) s = s.slice(0, cut);
    return s ? s[0].toUpperCase() + s.slice(1) : '';
}

function summarize(demo, data) {
    const nodes = Array.isArray(data.graph?.nodes) ? data.graph.nodes : [];
    const types = new Set(nodes.map(n => n.type));
    const inputs = [...new Set(Object.entries(INPUT_TAGS).filter(([type]) => types.has(type)).map(([, tag]) => tag))];
    return {
        name: String(data.name || '').trim() || demo.fallbackName,
        tagline: tagline(data.description),
        description: String(data.description || '').trim(),
        nodeCount: nodes.length,
        customCount: Object.keys(data.customNodes || {}).length,
        inputs
    };
}

// demo -> Promise<{ text, meta }>, kept for the session (a failed fetch is retried next time).
// Keyed by the manifest entry, which is replaced when the file changes in dev.
const demoCache = new WeakMap();

export function fetchDemo(demo) {
    let entry = demoCache.get(demo);
    if (!entry) {
        entry = fetch(demo.url).then(async (res) => {
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const text = await res.text();
            const data = JSON.parse(text);
            if (!data || !data.graph) throw new Error('Not a PatchToy project file');
            return { text, meta: summarize(demo, data) };
        });
        entry.catch(() => demoCache.delete(demo));
        demoCache.set(demo, entry);
    }
    return entry;
}

function placeholderColor(slug) {
    let hash = 0;
    for (let i = 0; i < slug.length; i++) hash = (hash * 31 + slug.charCodeAt(i)) | 0;
    return PLACEHOLDER_COLORS[Math.abs(hash) % PLACEHOLDER_COLORS.length];
}

function initialsOf(name) {
    const words = name.trim().split(/\s+/).filter(Boolean);
    return (words.length > 1 ? words[0][0] + words[1][0] : (words[0] || '?').slice(0, 2)).toUpperCase();
}

/** The Preview that best represents the patch: the saved background, else the rightmost wired one. */
export function mainPreview(graph) {
    const previews = graph.nodes.filter(n => n.isPreviewNode);
    if (!previews.length) return null;
    const background = previews.find(n => n.isBackground);
    if (background) return background;
    const wired = previews.filter(p => graph.connections.some(c => c.toNode === p));
    const pool = wired.length ? wired : previews;
    return pool.reduce((best, n) => (n.x > best.x ? n : best), pool[0]);
}

/** Zoom and pan so every node fits in the canvas. */
export function fitGraphToView(graph, { margin = 48 } = {}) {
    const nodes = graph.nodes;
    if (!nodes.length) return;
    const rect = graph.canvas.getBoundingClientRect();
    const vw = rect.width || graph.canvas.width;
    const vh = rect.height || graph.canvas.height;
    const minX = Math.min(...nodes.map(n => n.x));
    const minY = Math.min(...nodes.map(n => n.y));
    const maxX = Math.max(...nodes.map(n => n.x + (n.width || 0)));
    const maxY = Math.max(...nodes.map(n => n.y + (n.height || 0)));
    const bw = Math.max(1, maxX - minX);
    const bh = Math.max(1, maxY - minY);
    let zoom = Math.min(1, (vw - 2 * margin) / bw, (vh - 2 * margin) / bh);
    zoom = Math.max(graph.minZoom || 0.1, zoom);
    graph.zoom = zoom;
    graph.panX = (vw - bw * zoom) / 2 - minX * zoom;
    graph.panY = (vh - bh * zoom) / 2 - minY * zoom;
    graph.render();
}

export class DemoGallery {
    /**
     * @param {PatchToy} app - main app (nodeGraph, projectManager, compilationManager,
     *   backgroundRenderer, openProjectFile(), shell)
     */
    constructor(app) {
        this.app = app;
        this.modal = null;
        this.busy = false;

        // Static entry point in index.html: the empty-canvas card (the project browser's
        // Demos tab, as the modal). The top bar Open button belongs to ProjectBrowser.
        document.getElementById('emptyDemosBtn')?.addEventListener('click', () => this.open());
    }

    get demos() {
        return DEMOS;
    }

    /**
     * First visit = nothing autosaved yet. Check before the app's first autosave.
     * Automated browsers (MCP headless page, Playwright) skip the welcome gallery
     * unless the URL asks for it with ?welcome.
     */
    static shouldWelcome() {
        try {
            if (localStorage.getItem('patchtoy_graph') !== null) return false;
            const params = new URLSearchParams(window.location.search);
            if (params.has('welcome')) return true;
            if (params.get('headless') === '1' || navigator.webdriver) return false;
            return DEMOS.length > 0;
        } catch (e) {
            return false;
        }
    }

    /**
     * Open the gallery. With the project browser (src/ui/ProjectBrowser.js) this is its
     * Demos tab; the standalone modal below remains as a fallback.
     * `welcome` adapts the copy for a first visit.
     */
    open({ welcome = false } = {}) {
        if (this.app.projectBrowser) return this.app.projectBrowser.open({ view: 'demos', welcome });
        if (this.modal && !this.modal.closed) {
            this.focusCard();
            return this.modal;
        }

        const m = UIHelpers.createModal({
            kicker: welcome ? 'Welcome to PatchToy' : 'Demos',
            title: welcome ? 'Start from a demo' : 'Demo gallery',
            subtitle: welcome
                ? 'Every demo is a live node graph. Open one to see how it is patched, then tweak anything.'
                : 'Open a demo to see how it is patched. It replaces the graph on the canvas.',
            className: 'pt-modal--gallery',
            onClose: () => {
                if (this.modal === m) this.modal = null;
            }
        });
        this.modal = m;

        // Keys stay inside the dialog: the graph listens on window (Tab opens node
        // search, Delete removes selected nodes). Escape is handled earlier, in capture.
        m.backdrop.addEventListener('keydown', (e) => {
            this.onKeyDown(e);
            e.stopPropagation();
        });

        const grid = h('div', { className: 'dg-grid', role: 'group', 'aria-label': 'Demo projects' });
        this.grid = grid;

        if (!DEMOS.length) {
            m.body.appendChild(h('div', { className: 'dg-empty', text: 'No demos found in /projects.' }));
        }

        const pm = this.app.projectManager;
        const graph = this.app.nodeGraph;
        for (const demo of DEMOS) {
            const card = this.buildCard(demo);
            grid.appendChild(card);
            fetchDemo(demo).then(({ meta }) => {
                const isCurrent = pm?.projectState?.demo === demo.slug && pm.projectTitle === meta.name && graph.nodes.length > 0;
                this.fillCard(card, demo, meta, isCurrent);
            }, (err) => {
                console.warn(`[demos] could not read ${demo.slug}:`, err);
                this.fillCardError(card, demo);
            });
        }
        m.body.classList.add('dg-body');
        m.body.appendChild(grid);

        // Footer: keyboard hints + dismiss
        const hints = h('div', { className: 'dg-hints', 'aria-hidden': 'true' });
        hints.innerHTML = '<kbd>←</kbd><kbd>→</kbd><span>Browse</span><kbd>↵</kbd><span>Open</span><kbd>Esc</kbd><span>Close</span>';
        m.footer.append(
            hints,
            h('div', { className: 'pt-spacer' }),
            UIHelpers.button(welcome ? 'Start from scratch' : 'Close', { variant: welcome ? '' : 'ghost', onClick: () => m.close() })
        );

        setTimeout(() => this.focusCard(), 0);
        return m;
    }

    close() {
        // Called once a demo opened
        if (this.app.projectBrowser?.isOpen()) this.app.projectBrowser.close({ reason: 'opened' });
        this.modal?.close();
    }

    /**
     * Demo cards for the project browser's Demos tab (filled in as the project files load).
     * The grid is kept as this.grid so choose() can show its busy state.
     */
    buildDemoCards(grid) {
        this.grid = grid;
        const pm = this.app.projectManager;
        const graph = this.app.nodeGraph;
        return DEMOS.map((demo) => {
            const card = this.buildCard(demo);
            card.dataset.name = demo.fallbackName.toLowerCase();
            fetchDemo(demo).then(({ meta }) => {
                const isCurrent = pm?.projectState?.demo === demo.slug && pm.projectTitle === meta.name && graph.nodes.length > 0;
                this.fillCard(card, demo, meta, isCurrent);
                card.dataset.name = meta.name.toLowerCase();
                card.dataset.search = `${meta.name} ${meta.description}`.toLowerCase();
                card.dispatchEvent(new CustomEvent('dg:filled', { bubbles: true }));
            }, (err) => {
                console.warn(`[demos] could not read ${demo.slug}:`, err);
                this.fillCardError(card, demo);
            });
            return card;
        });
    }

    buildCard(demo) {
        const card = h('button', {
            type: 'button',
            className: 'dg-card is-pending',
            dataset: { slug: demo.slug }
        });

        const thumb = h('span', { className: 'dg-thumb' });
        if (demo.thumb) {
            const img = h('img', { className: 'dg-img', alt: '', loading: 'lazy', decoding: 'async', draggable: 'false' });
            img.addEventListener('load', () => thumb.classList.add('is-loaded'), { once: true });
            img.addEventListener('error', () => this.applyPlaceholder(thumb, demo, demo.fallbackName), { once: true });
            img.src = demo.thumb;
            thumb.appendChild(img);
        } else {
            this.applyPlaceholder(thumb, demo, demo.fallbackName);
        }
        thumb.appendChild(h('span', { className: 'dg-open', html: `<span>Open</span>${icon('chevronRight')}` }));
        thumb.appendChild(h('span', { className: 'dg-busy', html: '<span class="dg-spinner"></span><span>Opening…</span>' }));

        const info = h('span', { className: 'dg-info' }, [
            h('span', { className: 'dg-name', text: demo.fallbackName }),
            h('span', { className: 'dg-desc' }, [h('span', { className: 'dg-line' })]),
            h('span', { className: 'dg-meta' }, [h('span', { className: 'dg-line dg-line--short' })])
        ]);

        card.append(thumb, info);
        card.setAttribute('aria-label', demo.fallbackName);
        card.addEventListener('click', () => this.choose(demo, card));
        return card;
    }

    applyPlaceholder(thumb, demo, name) {
        thumb.classList.add('is-placeholder', 'is-loaded');
        thumb.style.setProperty('--dg-tint', placeholderColor(demo.slug));
        thumb.querySelector('.dg-img')?.remove();
        let mark = thumb.querySelector('.dg-mark');
        if (!mark) {
            mark = h('span', { className: 'dg-mark' });
            thumb.prepend(mark);
        }
        mark.textContent = initialsOf(name);
    }

    fillCard(card, demo, meta, isCurrent) {
        card.classList.remove('is-pending');
        card.classList.toggle('is-current', !!isCurrent);
        card.querySelector('.dg-name').textContent = meta.name;
        const thumb = card.querySelector('.dg-thumb');
        if (thumb.classList.contains('is-placeholder')) this.applyPlaceholder(thumb, demo, meta.name);

        const desc = card.querySelector('.dg-desc');
        desc.textContent = meta.tagline || 'A PatchToy demo patch';
        if (meta.description) desc.title = meta.description;

        const metaRow = card.querySelector('.dg-meta');
        metaRow.innerHTML = '';
        metaRow.appendChild(h('span', { className: 'dg-count', text: `${meta.nodeCount} node${meta.nodeCount === 1 ? '' : 's'}` }));
        if (meta.customCount) {
            metaRow.appendChild(h('span', { className: 'dg-dot', 'aria-hidden': 'true' }));
            metaRow.appendChild(h('span', { className: 'dg-custom', text: `${meta.customCount} GLSL` }));
        }
        for (const tag of meta.inputs) metaRow.appendChild(h('span', { className: 'pt-badge dg-tag', text: tag }));
        if (isCurrent) thumb.appendChild(h('span', { className: 'pt-badge dg-current', text: 'Open now' }));

        card.setAttribute('aria-label', `${meta.name}. ${meta.tagline}. ${meta.nodeCount} nodes.${isCurrent ? ' Currently open.' : ''}`);
    }

    fillCardError(card, demo) {
        card.classList.remove('is-pending');
        card.classList.add('is-broken');
        card.disabled = true;
        card.querySelector('.dg-desc').textContent = 'Couldn’t read this demo file';
        card.querySelector('.dg-meta').innerHTML = '';
    }

    cards() {
        return this.grid ? [...this.grid.querySelectorAll('.dg-card:not(:disabled)')] : [];
    }

    focusCard(index = null) {
        const cards = this.cards();
        if (!cards.length) return;
        const target = index !== null ? cards[index] : (cards.find(c => c.classList.contains('is-current')) || cards[0]);
        target?.focus({ preventScroll: true });
        target?.scrollIntoView({ block: 'nearest' });
    }

    onKeyDown(e) {
        if (!this.modal || this.modal.closed || e.metaKey || e.ctrlKey || e.altKey) return;

        // Keep Tab focus inside the dialog
        if (e.key === 'Tab') {
            const focusables = [...this.modal.modal.querySelectorAll('button:not(:disabled), [href], input, [tabindex]:not([tabindex="-1"])')];
            if (!focusables.length) return;
            const first = focusables[0];
            const last = focusables[focusables.length - 1];
            if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
            else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
            return;
        }

        const nav = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'];
        if (!nav.includes(e.key)) return;
        const cards = this.cards();
        if (!cards.length) return;
        e.preventDefault();

        const i = cards.indexOf(document.activeElement);
        if (i === -1) {
            this.focusCard();
            return;
        }
        const cols = Math.max(1, getComputedStyle(this.grid).gridTemplateColumns.split(' ').filter(Boolean).length);
        const last = cards.length - 1;
        let next = i;
        switch (e.key) {
            case 'ArrowRight': next = Math.min(last, i + 1); break;
            case 'ArrowLeft': next = Math.max(0, i - 1); break;
            case 'ArrowDown':
                // Jump to the last card when the row below is shorter
                if (i + cols <= last) next = i + cols;
                else if (Math.floor(i / cols) < Math.floor(last / cols)) next = last;
                break;
            case 'ArrowUp': next = i - cols >= 0 ? i - cols : i; break;
            case 'Home': next = 0; break;
            case 'End': next = last; break;
        }
        this.focusCard(next);
    }

    /** Card clicked: confirm if needed, then load. */
    async choose(demo, card) {
        if (this.busy) return;
        const app = this.app;
        const pm = app.projectManager;

        if (app.nodeGraph.nodes.length > 0 && pm.projectState?.isDirty) {
            const cloud = pm.projectState.source === 'cloud' && pm.projectState.projectId;
            const ok = await UIHelpers.confirm({
                title: 'Replace the current patch?',
                message: cloud
                    ? `“${pm.projectTitle}” has unsaved changes. They stay in this browser and come back when you reopen it from the project menu.`
                    : `“${pm.projectTitle}” is only autosaved in this browser, and opening a demo replaces it. Download it first from the project menu to keep a copy.`,
                confirmLabel: 'Open demo'
            });
            if (!ok) {
                card.focus();
                return;
            }
        }

        this.busy = true;
        card.classList.add('is-loading');
        this.grid?.classList.add('is-busy');
        try {
            const opened = await this.load(demo);
            if (opened) this.close();
        } finally {
            this.busy = false;
            card.classList.remove('is-loading');
            this.grid?.classList.remove('is-busy');
        }
    }

    /**
     * Load a demo through the app's regular project-file path, then put its main
     * Preview behind the graph and fit the graph to the view. Resolves true on success.
     */
    async load(demo) {
        const app = this.app;
        const pm = app.projectManager;
        const graph = app.nodeGraph;

        let entry;
        try {
            entry = await fetchDemo(demo);
        } catch (err) {
            UIHelpers.notify(err.message || 'Network error', 'error', { title: `Couldn’t load “${demo.fallbackName}”` });
            return false;
        }
        const { text, meta } = entry;

        // Same safety net as switching cloud projects: unsaved changes to a cloud
        // project are kept as a local copy, restored when it is reopened.
        const ps = pm.projectState;
        if (ps?.source === 'cloud' && ps.projectId && ps.isDirty) {
            pm.saveLocalProjectCopy(ps.projectId, {
                graph: graph.serialize(),
                projectTitle: pm.projectTitle,
                currentProjectId: pm.currentProjectId,
                editorStates: FloatingCodeEditor.getAllStates(),
                projectState: ps
            });
        }

        // Let the "Opening…" state paint before the (synchronous) graph rebuild
        await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));

        const file = new File([text], `${demo.slug}.patchtoy.json`, { type: 'application/json' });
        const result = await app.openProjectFile(file, { title: meta.name });
        if (!result || !result.success) return false;

        pm.projectState.demo = demo.slug;

        // Full-bleed: the demo's main Preview renders behind the graph
        const preview = mainPreview(graph);
        if (preview && typeof graph.onPreviewBackground === 'function' && !app.backgroundRenderer?.isActive(preview)) {
            graph.onPreviewBackground(preview);
        }
        // openProjectFile schedules a compile; when live coding is paused, compile once anyway
        if (app.compilationManager.autoCompile === false) app.compilationManager.compile();

        fitGraphToView(graph);
        pm.saveGraph();

        app.shell?.activity(`Opened demo “${meta.name}”`, { local: true });
        this.toast?.dismiss();
        this.toast = UIHelpers.toast('Drag, rewire or tweak anything. Your changes autosave in this browser.', 'success', {
            title: `Opened “${meta.name}”`,
            duration: 4200
        });
        return true;
    }
}
