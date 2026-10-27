import { NodeDefinitions } from '../core/NodeDefinitions.js';
import {
    listNodes, groupNodes, scoreNode, highlight, catalogSignature,
    categoryLabel, categoryColorFor, signatureElement, typeColor
} from './nodeCatalog.js';
import { icon } from './icons.js';
import { UIHelpers, escapeHtml } from './UIHelpers.js';
import { renderNodeSnapshot } from './nodeSnapshot.js';

const COLLAPSED_KEY = 'patchtoy_ui_library_collapsed';
const DRAG_MIME = 'application/x-patchtoy-node';
const DRAG_THRESHOLD = 5;
// The node slides out of the hover card onto the cursor over a drag distance long enough
// that it never moves against the cursor's own motion: with smoothstep easing (peak slope
// 1.5) that needs at least 1.5 x the offset; CATCH_UP_SLACK keeps it moving forward at a
// fraction of the cursor speed even at the steepest point.
const CATCH_UP_MIN_PX = 180;
const CATCH_UP_SLACK = 1.3;
const SMOOTHSTEP_PEAK_SLOPE = 1.5;
const CARD_MIN_INNER = 236;
const CARD_MAX_INNER = 340;

/**
 * Left "Library" sidebar: searchable list of node types grouped by category.
 * Click adds a node at the canvas center. Dragging an item pulls the node out of its hover
 * card: it starts where the card shows it and, over a drag distance proportional to its
 * offset from the cursor, slides onto the cursor and scales to the canvas zoom while the card fades out. The motion
 * is tied to drag distance, not time. Released over the canvas, it lands where it's shown.
 */
export class LibraryPanel {
    constructor(app) {
        this.app = app;
        this.root = document.getElementById('librarySidebar');
        this.listEl = document.getElementById('libraryList');
        this.searchEl = document.getElementById('librarySearch');
        this.countEl = document.getElementById('libraryCount');
        this.newBtn = document.getElementById('newGlslNodeBtn');
        this.container = document.getElementById('container');

        this.query = '';
        this.signature = '';
        this.pendingDrag = null;
        this.drag = null;
        this.suppressClick = false;
        this.card = null;
        this.cardTimer = null;
        this.cascade = 0;

        try {
            this.collapsed = new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) || '[]'));
        } catch (e) {
            this.collapsed = new Set();
        }

        this.bindEvents();
        this.refresh(true);
    }

    get graph() {
        return this.app.nodeGraph;
    }

    bindEvents() {
        this.searchEl.addEventListener('input', () => {
            this.query = this.searchEl.value;
            this.render();
        });
        this.searchEl.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                this.focusItem(0);
            } else if (e.key === 'Enter') {
                e.preventDefault();
                const first = this.listEl.querySelector('.lib-item');
                if (first) this.addNodeAtCenter(first.dataset.type);
            } else if (e.key === 'Escape') {
                if (this.searchEl.value) {
                    e.preventDefault();
                    e.stopPropagation();
                    this.searchEl.value = '';
                    this.query = '';
                    this.render();
                } else {
                    this.searchEl.blur();
                }
            }
        });

        this.newBtn.addEventListener('click', () => {
            this.graph.onCustomNodeRequested?.();
        });

        // List interactions (delegated)
        this.listEl.addEventListener('click', (e) => {
            const header = e.target.closest('.lib-group-header');
            if (header) {
                this.toggleGroup(header.parentElement.dataset.category);
                return;
            }
            const item = e.target.closest('.lib-item');
            if (!item) return;
            // "?" on the item: node help (src/ui/help)
            if (e.target.closest('.lib-item-help')) {
                this.suppressClick = false;
                this.hideCard();
                this.openHelp(item.dataset.type);
                return;
            }
            if (this.suppressClick) {
                this.suppressClick = false;
                return;
            }
            this.addNodeAtCenter(item.dataset.type);
        });

        this.listEl.addEventListener('keydown', (e) => {
            const item = e.target.closest('.lib-item');
            if (!item) return;
            const items = [...this.listEl.querySelectorAll('.lib-group:not(.is-collapsed) .lib-item')];
            const i = items.indexOf(item);
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                this.addNodeAtCenter(item.dataset.type);
            } else if (e.key === 'ArrowDown') {
                e.preventDefault();
                this.focusItem(i + 1);
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                if (i === 0) this.searchEl.focus();
                else this.focusItem(i - 1);
            }
        });

        this.listEl.addEventListener('contextmenu', (e) => {
            const item = e.target.closest('.lib-item');
            if (!item) return;
            e.preventDefault();
            this.hideCard();
            this.showItemMenu(item.dataset.type, e);
        });

        // Hover info card
        this.listEl.addEventListener('pointerover', (e) => {
            if (this.drag || this.pendingDrag) return;
            const item = e.target.closest('.lib-item');
            if (!item || item === this.hoverItem) return;
            this.hoverItem = item;
            clearTimeout(this.cardTimer);
            const warm = this.card && this.card.classList.contains('is-visible');
            this.cardTimer = setTimeout(() => this.showCard(item), warm ? 40 : 380);
        });
        this.listEl.addEventListener('pointerleave', () => {
            if (this.drag || this.pendingDrag) return;
            this.hoverItem = null;
            this.hideCard();
        });
        this.listEl.addEventListener('scroll', () => { if (!this.drag) this.hideCard(); }, { passive: true });

        // Drag source: pointer-driven, so the ghost can be the real node at canvas zoom
        this.listEl.addEventListener('pointerdown', (e) => {
            const item = e.target.closest('.lib-item');
            if (e.button !== 0 || !e.isPrimary || !item || e.target.closest('.lib-item-help')) {
                this.hideCard();
                return;
            }
            // Keep a visible card: the node is pulled out of it if this becomes a drag
            clearTimeout(this.cardTimer);
            this.pendingDrag = { type: item.dataset.type, item, x: e.clientX, y: e.clientY };
        });
        window.addEventListener('pointermove', (e) => this.onDragMove(e));
        window.addEventListener('pointerup', (e) => this.onDragEnd(e));
        window.addEventListener('pointercancel', () => this.cancelDrag());
        window.addEventListener('blur', () => this.cancelDrag());
        window.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.drag) {
                e.preventDefault();
                e.stopPropagation();
                this.cancelDrag();
            }
        }, true);

        // Drop target: the canvas container
        let dropTimer = null;
        this.container.addEventListener('dragover', (e) => {
            const types = [...(e.dataTransfer?.types || [])];
            const isNode = types.includes(DRAG_MIME);
            const isFile = types.includes('Files');
            if (!isNode && !isFile) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
            this.container.classList.add('is-drop-target');
            clearTimeout(dropTimer);
            dropTimer = setTimeout(() => this.container.classList.remove('is-drop-target'), 150);
        });
        this.container.addEventListener('drop', (e) => {
            this.container.classList.remove('is-drop-target');
            const type = e.dataTransfer.getData(DRAG_MIME);
            if (type && NodeDefinitions[type]) {
                e.preventDefault();
                this.addNodeAtClient(type, e.clientX, e.clientY);
                return;
            }
            // Dropping a project .json loads it through the regular file input path
            const file = e.dataTransfer.files && e.dataTransfer.files[0];
            if (file && /\.json$/i.test(file.name)) {
                e.preventDefault();
                const input = document.getElementById('loadFileInput');
                try {
                    const dt = new DataTransfer();
                    dt.items.add(file);
                    input.files = dt.files;
                    input.dispatchEvent(new Event('change'));
                } catch (err) {
                    console.warn('Could not load dropped file', err);
                }
            }
        });
    }

    /* ---------------- Rendering ---------------- */

    /** Rebuild if NodeDefinitions changed (or force). */
    refresh(force = false) {
        const sig = catalogSignature();
        if (!force && sig === this.signature) return;
        this.signature = sig;
        this.render();
    }

    render() {
        const query = this.query.trim();
        const all = listNodes();
        this.countEl.textContent = String(all.length);

        let nodes = all;
        if (query) {
            nodes = all
                .map(n => ({ n, s: scoreNode(n, query) }))
                .filter(x => x.s > 0)
                .sort((a, b) => b.s - a.s)
                .map(x => x.n);
        }

        const groups = groupNodes(nodes);
        if (query) {
            // Keep groups ordered by their best match
            const rank = new Map();
            nodes.forEach((n, i) => { if (!rank.has(n.category)) rank.set(n.category, i); });
            groups.sort((a, b) => rank.get(a.category) - rank.get(b.category));
        }

        const frag = document.createDocumentFragment();
        for (const g of groups) {
            const collapsed = !query && this.collapsed.has(g.category);
            const group = document.createElement('div');
            group.className = `lib-group${collapsed ? ' is-collapsed' : ''}`;
            group.dataset.category = g.category;
            group.style.setProperty('--dot', g.color);

            group.innerHTML = `
                <button class="lib-group-header" type="button" aria-expanded="${!collapsed}">
                    ${icon('chevronRight', { size: 12 })}
                    <span class="lib-group-title">${escapeHtml(g.label)}</span>
                    <span class="lib-group-count">${g.nodes.length}</span>
                </button>`;

            const items = document.createElement('div');
            items.className = 'lib-group-items';
            for (const n of g.nodes) {
                const outType = (n.def.outputs && n.def.outputs[0] && n.def.outputs[0].type) || '';
                const el = document.createElement('div');
                el.className = 'lib-item';
                el.tabIndex = 0;
                el.dataset.type = n.name;
                el.setAttribute('role', 'button');
                el.setAttribute('aria-label', `Add ${n.title} node`);
                el.style.setProperty('--dot', g.color);
                el.innerHTML = `
                    <span class="lib-item-dot"></span>
                    <span class="lib-item-name">${highlight(n.title, query)}</span>
                    ${n.def.isCustomNode ? `<span class="pt-badge" title="Custom GLSL node">glsl</span>` : ''}
                    ${outType ? `<span class="lib-item-type" style="--tc:${typeColor(outType)}">${escapeHtml(outType)}</span>` : ''}
                    <button class="lib-item-help" type="button" tabindex="-1" aria-label="Help for ${escapeHtml(n.title)}" data-tip="Node help" data-kbd="F1">${icon('help', { size: 14 })}</button>`;
                items.appendChild(el);
            }
            group.appendChild(items);
            frag.appendChild(group);
        }

        this.listEl.innerHTML = '';
        if (groups.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'lib-empty';
            empty.innerHTML = `No nodes match <strong>${escapeHtml(query)}</strong>.<br>Write your own with <em>New GLSL node</em>.`;
            this.listEl.appendChild(empty);
        } else {
            this.listEl.appendChild(frag);
        }
    }

    toggleGroup(category) {
        if (this.query.trim()) return;
        if (this.collapsed.has(category)) this.collapsed.delete(category);
        else this.collapsed.add(category);
        try {
            localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...this.collapsed]));
        } catch (e) { /* ignore */ }
        const group = this.listEl.querySelector(`.lib-group[data-category="${CSS.escape(category)}"]`);
        if (group) {
            const collapsed = this.collapsed.has(category);
            group.classList.toggle('is-collapsed', collapsed);
            group.querySelector('.lib-group-header')?.setAttribute('aria-expanded', String(!collapsed));
        }
    }

    focusItem(index) {
        const items = [...this.listEl.querySelectorAll('.lib-group:not(.is-collapsed) .lib-item')];
        if (!items.length) return;
        const i = Math.max(0, Math.min(index, items.length - 1));
        items[i].focus();
        items[i].scrollIntoView({ block: 'nearest' });
    }

    focusSearch() {
        this.searchEl.focus();
        this.searchEl.select();
    }

    /* ---------------- Info card ---------------- */

    showCard(item, { instant = false } = {}) {
        const type = item.dataset.type;
        const def = NodeDefinitions[type];
        if (!def || !item.isConnected) return;
        if (!this.card) {
            this.card = document.createElement('div');
            this.card.className = 'pt-node-card';
            document.body.appendChild(this.card);
        }
        const card = this.card;
        card.classList.toggle('is-instant', instant);
        card.style.opacity = '';
        this.cardInfo = null;
        const category = (def.category || 'other');
        card.style.setProperty('--dot', categoryColorFor(category));
        card.innerHTML = `
            <div class="nc-head">
                <span class="nc-title">${escapeHtml(def.displayTitle || type)}</span>
                <span class="nc-cat">${escapeHtml(categoryLabel(category))}</span>
            </div>
            ${def.description ? `<div class="nc-desc">${escapeHtml(def.description)}</div>` : ''}`;

        // The node as it will look on the canvas (falls back to the port signature)
        const snap = this.snapshotFor(type);
        if (snap) {
            const inner = Math.max(CARD_MIN_INNER, Math.min(CARD_MAX_INNER, snap.width));
            const scale = Math.min(1, inner / snap.width);
            card.style.width = `${inner + 24}px`;
            const stage = document.createElement('div');
            stage.className = 'nc-node';
            const img = snap.canvas;
            img.style.width = `${snap.width * scale}px`;
            img.style.height = `${snap.height * scale}px`;
            stage.appendChild(img);
            card.appendChild(stage);
            this.cardInfo = { type, img, scale };
            const hint = document.createElement('div');
            hint.className = 'nc-hint';
            hint.innerHTML = `Click to add · drag onto the canvas<span class="nc-help">${icon('help', { size: 12 })} on the item or <kbd>F1</kbd>: node help</span>`;
            card.appendChild(hint);
        } else {
            card.style.width = '';
            card.appendChild(signatureElement(def));
        }

        const r = item.getBoundingClientRect();
        const sidebarRight = this.root.getBoundingClientRect().right;
        card.style.left = `${Math.round(sidebarRight + 8)}px`;
        card.style.top = '0px';
        const h = card.offsetHeight;
        const top = Math.max(8, Math.min(r.top - 6, window.innerHeight - h - 8));
        card.style.top = `${Math.round(top)}px`;
        card.classList.add('is-visible');
    }

    hideCard() {
        clearTimeout(this.cardTimer);
        this.cardTimer = null;
        if (this.card) {
            this.card.classList.remove('is-visible');
            this.card.style.opacity = '';
        }
    }

    /** Snapshot drawn at 1 graph unit = 1 CSS px (2x on hi-dpi), scaled down by CSS if needed. */
    snapshotFor(type) {
        return renderNodeSnapshot(type, this.graph, { scale: 1 });
    }

    /* ---------------- Drag a node onto the canvas ---------------- */

    onDragMove(e) {
        if (!this.drag) {
            const p = this.pendingDrag;
            if (!p) return;
            if (Math.hypot(e.clientX - p.x, e.clientY - p.y) < DRAG_THRESHOLD) return;
            if (!this.beginDrag(p)) {
                this.pendingDrag = null;
                return;
            }
        }
        this.updateDrag(e.clientX, e.clientY);
    }

    beginDrag({ type, item, x: startX, y: startY }) {
        // The node emerges from the hover card: make sure it's showing (no fade-in)
        const shown = this.card && this.card.classList.contains('is-visible') && this.cardInfo?.type === type;
        if (!shown && item.isConnected) this.showCard(item, { instant: true });
        this.card?.classList.add('is-instant');
        const info = this.cardInfo && this.cardInfo.type === type ? this.cardInfo : null;

        const zoom = this.graph.zoom || 1;
        // Draw at the larger of the canvas zoom and 1x, so scaling the ghost never blurs it
        const res = Math.max(zoom, 1);
        const snap = renderNodeSnapshot(type, this.graph, { scale: res });
        if (!snap) return false;

        // Anchor (node-local units): where the cursor ends up holding the node, on its header
        const ax = snap.margin + Math.min(28, snap.nodeWidth / 2);
        const ay = snap.margin + 12;

        // Start exactly over the card's picture of the node, offset from the cursor
        let s0 = zoom;
        let offX = 0;
        let offY = 0;
        if (info) {
            const r = info.img.getBoundingClientRect();
            s0 = info.scale;
            offX = r.left + ax * s0 - startX;
            offY = r.top + ay * s0 - startY;
            info.img.style.visibility = 'hidden';
        }

        const el = document.createElement('div');
        el.className = 'lib-drag-node';
        const inner = document.createElement('div');
        inner.className = 'lib-drag-node-inner';
        inner.style.transformOrigin = `${ax * res}px ${ay * res}px`;
        inner.appendChild(snap.canvas);
        el.appendChild(inner);
        document.body.appendChild(el);
        document.body.classList.add('is-lib-dragging');

        const catchUp = Math.max(CATCH_UP_MIN_PX, CATCH_UP_SLACK * SMOOTHSTEP_PEAK_SLOPE * Math.hypot(offX, offY));

        this.drag = {
            type, el, inner, res, ax, ay, s0, offX, offY, startX, startY, catchUp,
            grabX: ax - snap.margin, grabY: ay - snap.margin, info, over: false
        };
        return true;
    }

    updateDrag(cx, cy) {
        const d = this.drag;
        if (!d) return;
        const zoom = this.graph.zoom || 1;

        // Progress follows drag distance (reversible: drag back and it returns to the card)
        const k = this.catchUpProgress(d, cx, cy);
        const scale = d.s0 + (zoom - d.s0) * k;
        const px = cx + d.offX * (1 - k);
        const py = cy + d.offY * (1 - k);

        d.el.style.transform = `translate3d(${px - d.ax * d.res}px, ${py - d.ay * d.res}px, 0)`;
        d.inner.style.transform = `scale(${scale / d.res})`;
        if (this.card) this.card.style.opacity = String(1 - k);

        const over = this.isOverCanvas(cx, cy);
        if (over !== d.over) {
            d.over = over;
            this.container.classList.toggle('is-drop-target', over);
        }
    }

    onDragEnd(e) {
        const d = this.drag;
        const pressed = !!this.pendingDrag;
        this.pendingDrag = null;
        if (!d) {
            if (pressed) this.hideCard();
            return;
        }
        const over = this.isOverCanvas(e.clientX, e.clientY);
        // Where the node is drawn right now (it may not have caught up with the cursor yet)
        const k = this.catchUpProgress(d, e.clientX, e.clientY);
        const ax = e.clientX + d.offX * (1 - k);
        const ay = e.clientY + d.offY * (1 - k);
        this.endDrag();
        // The release may land on the list item; don't let its click add a second node
        this.suppressClick = true;
        setTimeout(() => { this.suppressClick = false; }, 0);
        if (over) {
            const p = this.clientToGraph(ax, ay);
            this.createNode(d.type, p.x - d.grabX, p.y - d.grabY);
        }
    }

    /** 0 = node still where the card shows it, 1 = held at the cursor (smoothstep in drag distance). */
    catchUpProgress(d, cx, cy) {
        const t = Math.min(1, Math.hypot(cx - d.startX, cy - d.startY) / d.catchUp);
        return t * t * (3 - 2 * t);
    }

    cancelDrag() {
        this.pendingDrag = null;
        if (this.drag) this.endDrag();
    }

    endDrag() {
        const d = this.drag;
        if (!d) return;
        d.el.remove();
        if (d.info) d.info.img.style.visibility = '';
        this.drag = null;
        document.body.classList.remove('is-lib-dragging');
        this.container.classList.remove('is-drop-target');
        this.hideCard();
        const card = this.card;
        if (card) requestAnimationFrame(() => card.classList.remove('is-instant'));
    }

    /** True when the point is over the node canvas itself (not an overlay, panel or button). */
    isOverCanvas(cx, cy) {
        const hit = document.elementFromPoint(cx, cy);
        if (!hit || !this.container.contains(hit)) return false;
        return !hit.closest('button, input, textarea, select, a, [contenteditable="true"]');
    }

    /* ---------------- Context menu (custom nodes) ---------------- */

    /** Node help panel (src/ui/help/HelpCenter.js listens). */
    openHelp(type) {
        window.dispatchEvent(new CustomEvent('patchtoy:help', { detail: { type } }));
    }

    showItemMenu(type, e) {
        const def = NodeDefinitions[type];
        if (!def) return;
        const at = { left: e.clientX, right: e.clientX, top: e.clientY, bottom: e.clientY, width: 0, height: 0 };
        const items = [
            { icon: 'plus', label: 'Add to canvas', onClick: () => this.addNodeAtCenter(type) },
            { icon: 'help', label: 'Help', hint: 'F1', onClick: () => this.openHelp(type) },
        ];
        if (def.isCustomNode) {
            items.push(
                { icon: 'code', label: 'Edit GLSL…', onClick: () => this.graph.onNodeRightClick?.({ type }, e) },
                { separator: true },
                {
                    icon: 'trash', label: 'Delete node type', danger: true, onClick: async () => {
                        const count = this.graph.nodes.filter(n => n.type === type).length;
                        const ok = await UIHelpers.confirm({
                            title: `Delete “${def.displayTitle || type}”?`,
                            message: count
                                ? `This removes the custom node type and ${count} instance${count === 1 ? '' : 's'} from the canvas.`
                                : 'This removes the custom node type from your library.',
                            confirmLabel: 'Delete',
                            danger: true
                        });
                        if (ok) {
                            this.graph.onCustomNodeDelete?.(type);
                            this.refresh(true);
                            UIHelpers.toast(`Deleted ${def.displayTitle || type}`, 'success');
                        }
                    }
                }
            );
        }
        UIHelpers.openMenu({ anchor: at, items });
    }

    /* ---------------- Adding nodes ---------------- */

    canvasRect() {
        return this.graph.canvas.getBoundingClientRect();
    }

    /** Convert client (screen) coordinates to graph coordinates. */
    clientToGraph(clientX, clientY) {
        const g = this.graph;
        const rect = this.canvasRect();
        return {
            x: (clientX - rect.left - g.panX) / g.zoom,
            y: (clientY - rect.top - g.panY) / g.zoom
        };
    }

    addNodeAtCenter(type) {
        const rect = this.canvasRect();
        const center = this.clientToGraph(rect.left + rect.width / 2, rect.top + rect.height / 2);
        const node = this.createNode(type, center.x, center.y, { centered: true });
        return node;
    }

    addNodeAtClient(type, clientX, clientY) {
        const p = this.clientToGraph(clientX, clientY);
        // Keep the cursor over the node header
        return this.createNode(type, p.x - 18, p.y - 12);
    }

    createNode(type, x, y, { centered = false } = {}) {
        const g = this.graph;
        if (!NodeDefinitions[type]) return null;

        const node = g.addNode(type, x, y);
        if (!node) {
            UIHelpers.toast(`Could not create “${type}”`, 'error');
            return null;
        }

        const pair = node.data && node.data.pairNodeId !== undefined
            ? g.nodes.find(n => n.id === node.data.pairNodeId && n !== node)
            : null;

        if (centered) {
            let dx = -(node.width || 0) / 2;
            let dy = -(node.height || 0) / 2;
            // Cascade repeated adds so nodes don't stack exactly on top of each other
            const occupied = (px, py) => g.nodes.some(n => n !== node && n !== pair && Math.abs(n.x - px) < 6 && Math.abs(n.y - py) < 6);
            let guard = 0;
            while (occupied(node.x + dx, node.y + dy) && guard++ < 20) {
                dx += 24;
                dy += 24;
            }
            node.x += dx;
            node.y += dy;
            if (pair) {
                pair.x += dx;
                pair.y += dy;
            }
        }

        // Select the new node
        if (g.selectionManager && g.selectionManager.selectedNodes) {
            g.selectionManager.selectedNodes.clear();
            g.selectionManager.selectedNodes.add(node);
        }

        if (g.onGraphChanged) g.onGraphChanged();
        g.render();
        this.app.shell?.activity(`Added ${NodeDefinitions[type].displayTitle || type}`, { local: true });
        return node;
    }
}
