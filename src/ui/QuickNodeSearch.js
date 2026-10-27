import { NodeDefinitions } from '../core/NodeDefinitions.js';
import {
    listNodes, groupNodes, scoreNode, highlight, signatureHtml, signatureElement,
    categoryLabel, categoryColorFor, catalogSignature
} from './nodeCatalog.js';
import { renderNodeSnapshot } from './nodeSnapshot.js';
import { icon } from './icons.js';
import { UIHelpers, escapeHtml } from './UIHelpers.js';

// Info-pane node preview
const PREVIEW_DELAY_MS = 70;     // pause before drawing an uncached node
const PREVIEW_MAX_HEIGHT = 260;  // CSS px; taller nodes are scaled down
const PREVIEW_MIN_HEIGHT = 130;  // ...but not below this (the pane scrolls instead)
const PREWARM_RADIUS = 3;        // rows either side of the selection drawn while idle

// Snapshots per node type, shared across palette openings. Cleared whenever the
// node catalog changes; entries also remember their definition object.
const snapshotCache = { signature: null, entries: new Map() };

/**
 * QuickNodeSearch - command-palette style node search + ghost node placement.
 * Opened with Tab (NodeGraph) or the "Add node" button.
 */
export class QuickNodeSearch {
    constructor(nodeGraph) {
        this.nodeGraph = nodeGraph;
        this.searchBox = null;
        this.ghostNode = null;
        this.infoPaneNode = null; // Track which node's info is shown
    }

    /**
     * Show the quick node search palette
     */
    show(buttonElement) {
        // Don't open if already open
        if (this.searchBox) return;

        const container = document.createElement('div');
        container.className = 'pt-palette';
        container.setAttribute('role', 'dialog');
        container.setAttribute('aria-label', 'Add node');

        // --- Top row: search input + custom node button
        const searchRow = document.createElement('div');
        searchRow.className = 'qs-top';
        searchRow.innerHTML = icon('search');

        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'qs-input';
        input.placeholder = 'Search nodes…';
        input.spellcheck = false;
        input.autocomplete = 'off';
        input.setAttribute('aria-label', 'Search nodes');

        const customButton = document.createElement('button');
        customButton.className = 'pt-btn pt-btn--sm';
        customButton.innerHTML = `${icon('code')}<span>GLSL node</span>`;
        customButton.setAttribute('data-tip', 'Write a custom GLSL node');
        customButton.addEventListener('mousedown', (e) => e.preventDefault());
        customButton.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.close();
            if (this.nodeGraph.onCustomNodeRequested) {
                this.nodeGraph.onCustomNodeRequested();
            }
        });

        searchRow.appendChild(input);
        searchRow.appendChild(customButton);

        // --- Category tabs
        const tabsContainer = document.createElement('div');
        tabsContainer.className = 'qs-tabs';

        // --- Results + info pane
        const contentArea = document.createElement('div');
        contentArea.className = 'qs-content';

        const resultsList = document.createElement('div');
        resultsList.className = 'qs-results';
        resultsList.setAttribute('role', 'listbox');

        const infoPane = document.createElement('div');
        infoPane.className = 'qs-info';

        contentArea.appendChild(resultsList);
        contentArea.appendChild(infoPane);

        // --- Footer with keyboard hints
        const footer = document.createElement('div');
        footer.className = 'qs-footer';
        footer.innerHTML = `
            <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
            <span><kbd>↵</kbd> place</span>
            <span><kbd>Tab</kbd> category</span>
            <span class="pc-spacer"></span>
            <span><kbd>Esc</kbd> close</span>`;

        container.appendChild(searchRow);
        container.appendChild(tabsContainer);
        container.appendChild(contentArea);
        container.appendChild(footer);
        document.body.appendChild(container);

        this.positionPalette(container);

        this.searchBox = {
            container,
            input,
            customButton,
            tabsContainer,
            resultsList,
            infoPane,
            selectedIndex: 0,
            results: [],
            allNodes: {},
            activeCategory: 'all',
            query: ''
        };

        this.rebuildCatalog();

        // Initial render with all nodes
        this.updateResults('');
        this.updateInfoPaneForSelection();

        input.addEventListener('input', (e) => {
            this.searchBox.selectedIndex = 0;
            this.updateResults(e.target.value);
            this.updateInfoPaneForSelection();
        });

        input.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                this.navigateDown();
                this.applySelection();
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                this.navigateUp();
                this.applySelection();
            } else if (e.key === 'Enter') {
                e.preventDefault();
                this.selectCurrent();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                this.close();
            } else if (e.key === 'Tab') {
                e.preventDefault();
                if (!input.value.trim()) this.cycleCategory(e.shiftKey ? -1 : 1);
            }
        });

        // Close on click outside
        const closeOnClickOutside = (e) => {
            if (!this.searchBox || this.searchBox.container !== container) {
                document.removeEventListener('mousedown', closeOnClickOutside);
                return;
            }
            if (!container.contains(e.target)) {
                this.close();
                document.removeEventListener('mousedown', closeOnClickOutside);
            }
        };
        setTimeout(() => document.addEventListener('mousedown', closeOnClickOutside), 0);

        input.focus();
    }

    positionPalette(container) {
        // Centre over the canvas area, near the top (command-palette style)
        const area = document.getElementById('container');
        const rect = area ? area.getBoundingClientRect() : { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
        const width = Math.min(720, window.innerWidth - 24);
        const left = Math.max(12, Math.min(rect.left + (rect.width - width) / 2, window.innerWidth - width - 12));
        container.style.left = `${Math.round(left)}px`;
        container.style.top = `${Math.round(rect.top + Math.min(56, rect.height * 0.08))}px`;
    }

    rebuildCatalog() {
        this.searchBox.allNodes = {};
        this.searchBox.catalog = listNodes();
        for (const n of this.searchBox.catalog) {
            if (!this.searchBox.allNodes[n.category]) this.searchBox.allNodes[n.category] = [];
            this.searchBox.allNodes[n.category].push(n.name);
        }
        this.searchBox.groups = groupNodes(this.searchBox.catalog);
    }

    cycleCategory(dir) {
        const cats = ['all', ...this.searchBox.groups.map(g => g.category)];
        const i = cats.indexOf(this.searchBox.activeCategory);
        this.searchBox.activeCategory = cats[(i + dir + cats.length) % cats.length];
        this.searchBox.selectedIndex = 0;
        this.updateResults('');
        this.updateInfoPaneForSelection();
        const active = this.searchBox.tabsContainer.querySelector('.qs-tab.is-active');
        active?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }

    navigateDown() {
        // Skip headers when navigating
        let newIndex = this.searchBox.selectedIndex + 1;
        while (newIndex < this.searchBox.results.length && this.searchBox.results[newIndex].isHeader) {
            newIndex++;
        }
        if (newIndex >= this.searchBox.results.length) return;
        this.searchBox.selectedIndex = newIndex;
    }

    navigateUp() {
        // Skip headers when navigating
        let newIndex = this.searchBox.selectedIndex - 1;
        while (newIndex >= 0 && this.searchBox.results[newIndex].isHeader) {
            newIndex--;
        }
        if (newIndex < 0) return;
        this.searchBox.selectedIndex = newIndex;
    }

    /** Update the selected row's highlight without rebuilding the list. */
    applySelection(scroll = true) {
        const sb = this.searchBox;
        if (!sb) return;
        const rows = sb.resultsList.querySelectorAll('.qs-item');
        let selectedEl = null;
        rows.forEach(row => {
            const on = Number(row.dataset.index) === sb.selectedIndex;
            row.classList.toggle('is-selected', on);
            row.setAttribute('aria-selected', String(on));
            if (on) selectedEl = row;
        });
        if (scroll && selectedEl) selectedEl.scrollIntoView({ block: 'nearest' });
        this.updateInfoPaneForSelection();
    }

    selectCurrent() {
        if (this.searchBox.results.length > 0) {
            const selectedItem = this.searchBox.results[this.searchBox.selectedIndex];
            if (selectedItem && !selectedItem.isHeader) {
                this.selectNode(selectedItem.name);
            }
        }
    }

    showInfoPane(nodeName) {
        const infoPane = this.searchBox.infoPane;
        if (this.infoPaneNode === nodeName && infoPane.childElementCount > 0) return;
        infoPane.innerHTML = '';

        if (!nodeName) {
            const emptyText = document.createElement('div');
            emptyText.className = 'qs-empty-info';
            emptyText.textContent = 'Select a node to see details';
            infoPane.appendChild(emptyText);
            this.infoPaneNode = null;
            return;
        }

        const def = NodeDefinitions[nodeName];
        if (!def) return;

        this.infoPaneNode = nodeName;
        const category = def.category || 'other';

        // Title row (+ delete for custom nodes)
        const titleRow = document.createElement('div');
        titleRow.className = 'qs-info-head';
        titleRow.style.setProperty('--dot', categoryColorFor(category));
        titleRow.innerHTML = `
            <span class="lib-group-swatch"></span>
            <span class="qs-info-title">${escapeHtml(def.displayTitle || nodeName)}</span>
            <span class="pt-badge">${escapeHtml(categoryLabel(category))}</span>`;

        if (def.isCustomNode) {
            const deleteBtn = document.createElement('button');
            deleteBtn.className = 'pt-icon-btn pt-icon-btn--sm';
            deleteBtn.setAttribute('data-tip', 'Delete custom node');
            deleteBtn.innerHTML = icon('trash');
            deleteBtn.addEventListener('mousedown', (e) => e.preventDefault());
            deleteBtn.addEventListener('click', async (e) => {
                e.preventDefault();
                e.stopPropagation();
                const ok = await UIHelpers.confirm({
                    title: `Delete “${def.displayTitle || nodeName}”?`,
                    message: 'The custom node type and all its instances will be removed.',
                    confirmLabel: 'Delete',
                    danger: true
                });
                if (!ok || !this.searchBox) return;

                if (this.nodeGraph.onCustomNodeDelete) {
                    this.nodeGraph.onCustomNodeDelete(nodeName);
                }

                this.rebuildCatalog();
                this.infoPaneNode = null;
                this.showInfoPane(null);
                this.updateResults(this.searchBox.input.value);
                this.updateInfoPaneForSelection();
                this.searchBox.input.focus();
            });
            titleRow.appendChild(deleteBtn);
        }

        infoPane.appendChild(titleRow);

        if (def.description) {
            // Clamped so the node stays in view; click to read the rest
            const desc = document.createElement('div');
            desc.className = 'qs-desc is-clamped';
            desc.textContent = def.description;
            infoPane.appendChild(desc);
            if (desc.scrollHeight > desc.clientHeight + 1) {
                desc.classList.add('is-expandable');
                desc.title = 'Click to show all';
                desc.addEventListener('mousedown', (e) => e.preventDefault());
                desc.addEventListener('click', () => {
                    const open = desc.classList.toggle('is-clamped');
                    desc.title = open ? 'Click to show all' : '';
                });
            }
        }

        // The node as it will look on the canvas (falls back to the port signature)
        this.renderNodePreview(nodeName, def);
    }

    /**
     * Put the canvas snapshot of `nodeName` into the info pane. Cached snapshots go in
     * straight away; uncached ones are drawn after a short pause so holding an arrow key
     * through the list doesn't create (and dispose) a node per row.
     */
    renderNodePreview(nodeName, def) {
        const sb = this.searchBox;
        clearTimeout(this.previewTimer);
        this.previewTimer = null;

        const stage = document.createElement('div');
        stage.className = 'qs-node';
        sb.infoPane.appendChild(stage);

        const fill = (snap) => {
            if (!this.searchBox || this.infoPaneNode !== nodeName || !stage.isConnected) return;
            stage.classList.remove('is-pending');
            if (!snap) {
                const sig = document.createElement('div');
                sig.innerHTML = '<div class="pt-label qs-section-label">Signature</div>';
                sig.appendChild(signatureElement(def));
                stage.replaceWith(sig);
                return;
            }
            // Fit inside the pane (never upscale: the snapshot is drawn at canvas size).
            // Tall nodes shrink to the room left below the description, within reason.
            const pane = sb.infoPane;
            const availW = Math.max(120, stage.clientWidth - 16);
            const room = pane.getBoundingClientRect().bottom - stage.getBoundingClientRect().top - 14 - 14;
            const availH = Math.max(PREVIEW_MIN_HEIGHT, Math.min(PREVIEW_MAX_HEIGHT, room));
            const scale = Math.min(1, availW / snap.width, availH / snap.height);
            const img = snap.canvas;
            img.style.width = `${snap.width * scale}px`;
            img.style.height = `${snap.height * scale}px`;
            stage.replaceChildren(img);
        };

        const cached = this.cachedSnapshot(nodeName);
        if (cached !== undefined) {
            fill(cached);
            this.schedulePrewarm();
            return;
        }
        stage.classList.add('is-pending');
        this.previewTimer = setTimeout(() => {
            this.previewTimer = null;
            if (!this.searchBox || this.infoPaneNode !== nodeName) return;
            fill(this.snapshotFor(nodeName));
            this.schedulePrewarm();
        }, PREVIEW_DELAY_MS);
    }

    /** Cached snapshot for a type: a snapshot, null (drawing failed), or undefined (not cached). */
    cachedSnapshot(type) {
        const sig = catalogSignature();
        if (sig !== snapshotCache.signature) {
            snapshotCache.signature = sig;
            snapshotCache.entries.clear();
        }
        const entry = snapshotCache.entries.get(type);
        // Editing a custom node replaces its definition object, so identity catches edits
        if (!entry || entry.def !== NodeDefinitions[type]) return undefined;
        return entry.snap;
    }

    snapshotFor(type) {
        const cached = this.cachedSnapshot(type);
        if (cached !== undefined) return cached;
        const snap = renderNodeSnapshot(type, this.nodeGraph, { scale: 1 });
        snapshotCache.entries.set(type, { def: NodeDefinitions[type], snap });
        return snap;
    }

    /** While idle, draw the rows next to the selection so stepping onto them is instant. */
    schedulePrewarm() {
        if (this.prewarmHandle) return;
        const idle = window.requestIdleCallback || ((cb) => setTimeout(() => cb({ timeRemaining: () => 8 }), 50));
        this.prewarmHandle = idle((deadline) => {
            this.prewarmHandle = null;
            const sb = this.searchBox;
            if (!sb) return;
            const around = [];
            for (let d = 1; d <= PREWARM_RADIUS; d++) {
                for (const i of [sb.selectedIndex + d, sb.selectedIndex - d]) {
                    const item = sb.results[i];
                    if (item && !item.isHeader) around.push(item.name);
                }
            }
            for (const type of around) {
                if (deadline.timeRemaining() < 4) break;
                if (this.cachedSnapshot(type) === undefined) this.snapshotFor(type);
            }
        });
    }

    cancelPreviewWork() {
        clearTimeout(this.previewTimer);
        this.previewTimer = null;
        if (this.prewarmHandle) {
            (window.cancelIdleCallback || clearTimeout)(this.prewarmHandle);
            this.prewarmHandle = null;
        }
    }

    updateInfoPaneForSelection() {
        if (!this.searchBox) return;
        if (this.searchBox.results.length > 0) {
            const selectedItem = this.searchBox.results[this.searchBox.selectedIndex];
            if (selectedItem && !selectedItem.isHeader) {
                this.showInfoPane(selectedItem.name);
            } else {
                this.showInfoPane(null);
            }
        } else {
            this.showInfoPane(null);
        }
    }

    renderTabs() {
        const sb = this.searchBox;
        const tabs = sb.tabsContainer;
        tabs.innerHTML = '';
        const mk = (cat, label, color, count) => {
            const tab = document.createElement('button');
            tab.type = 'button';
            tab.className = `qs-tab${sb.activeCategory === cat ? ' is-active' : ''}`;
            if (color) tab.style.setProperty('--dot', color);
            tab.innerHTML = `${color ? '<span class="lib-group-swatch"></span>' : ''}${escapeHtml(label)}`;
            if (count !== undefined) tab.title = `${count} node${count === 1 ? '' : 's'}`;
            tab.addEventListener('mousedown', (e) => e.preventDefault());
            tab.addEventListener('click', (e) => {
                e.stopPropagation();
                sb.activeCategory = cat;
                sb.selectedIndex = 0;
                this.updateResults('');
                this.updateInfoPaneForSelection();
                sb.input.focus();
            });
            tabs.appendChild(tab);
        };
        mk('all', 'All', null, sb.catalog.length);
        for (const g of sb.groups) mk(g.category, g.label, g.color, g.nodes.length);
    }

    updateResults(query) {
        const sb = this.searchBox;
        const resultsList = sb.resultsList;
        resultsList.innerHTML = '';
        sb.query = query;

        const hasQuery = query.trim().length > 0;
        sb.results = [];

        if (hasQuery) {
            sb.tabsContainer.style.display = 'none';
            const ranked = sb.catalog
                .map(n => ({ n, s: scoreNode(n, query) }))
                .filter(x => x.s > 0)
                .sort((a, b) => b.s - a.s)
                .map(x => x.n);
            const groups = groupNodes(ranked);
            const rank = new Map();
            ranked.forEach((n, i) => { if (!rank.has(n.category)) rank.set(n.category, i); });
            groups.sort((a, b) => rank.get(a.category) - rank.get(b.category));
            for (const g of groups) {
                sb.results.push({ isHeader: true, category: g.category, label: g.label, color: g.color });
                for (const n of g.nodes) sb.results.push({ isHeader: false, name: n.name, title: n.title, category: g.category, color: g.color });
            }
        } else {
            sb.tabsContainer.style.display = '';
            this.renderTabs();
            const groups = sb.activeCategory === 'all'
                ? sb.groups
                : sb.groups.filter(g => g.category === sb.activeCategory);
            for (const g of groups) {
                if (sb.activeCategory === 'all') {
                    sb.results.push({ isHeader: true, category: g.category, label: g.label, color: g.color });
                }
                for (const n of g.nodes) sb.results.push({ isHeader: false, name: n.name, title: n.title, category: g.category, color: g.color });
            }
        }

        // Ensure selectedIndex is on a non-header item
        if (sb.selectedIndex >= sb.results.length) sb.selectedIndex = 0;
        if (sb.results.length > 0 && sb.results[sb.selectedIndex]?.isHeader) {
            for (let i = sb.selectedIndex; i < sb.results.length; i++) {
                if (!sb.results[i].isHeader) {
                    sb.selectedIndex = i;
                    break;
                }
            }
        }

        if (sb.results.length === 0) {
            const none = document.createElement('div');
            none.className = 'qs-none';
            none.innerHTML = `No nodes match <strong>${escapeHtml(query)}</strong>.<br>Try a type like <code>vec3</code>, or write a custom GLSL node.`;
            resultsList.appendChild(none);
            return;
        }

        const frag = document.createDocumentFragment();
        sb.results.forEach((item, index) => {
            const elem = document.createElement('div');
            if (item.isHeader) {
                elem.className = 'qs-header';
                elem.style.setProperty('--dot', item.color);
                elem.innerHTML = `<span class="lib-group-swatch"></span>${escapeHtml(item.label)}`;
            } else {
                const def = NodeDefinitions[item.name];
                elem.className = `qs-item${index === sb.selectedIndex ? ' is-selected' : ''}`;
                elem.dataset.index = String(index);
                elem.setAttribute('role', 'option');
                elem.style.setProperty('--dot', item.color);
                elem.innerHTML = `
                    <span class="lib-item-dot"></span>
                    <span class="qs-item-name">${highlight(item.title, query)}</span>
                    ${def?.isCustomNode ? '<span class="pt-badge">glsl</span>' : ''}
                    <span class="qs-item-sig">${def ? signatureHtml(def) : ''}</span>`;

                elem.addEventListener('mousemove', () => {
                    if (sb.selectedIndex === index) return;
                    sb.selectedIndex = index;
                    this.applySelection(false);
                });

                elem.addEventListener('mousedown', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    this.selectNode(item.name);
                });
            }
            frag.appendChild(elem);
        });
        resultsList.appendChild(frag);
        const selected = resultsList.querySelector('.qs-item.is-selected');
        if (selected) selected.scrollIntoView({ block: 'nearest' });
    }

    selectNode(nodeType) {
        this.close();

        // Create ghost node at mouse position - delegate to nodeGraph
        this.nodeGraph.createGhostNode(nodeType);
    }

    close() {
        this.cancelPreviewWork();
        if (this.searchBox) {
            this.searchBox.container.remove();
            this.searchBox = null;
            this.infoPaneNode = null;
        }
    }

    /**
     * Ghost node management
     */
    hasGhostNode() {
        return this.ghostNode !== null;
    }

    getGhostNode() {
        return this.ghostNode;
    }

    setGhostNode(node) {
        // A previous ghost never joined the graph: release it first (key listeners, MIDI, renderer)
        if (this.ghostNode && this.ghostNode !== node) this.cancelGhostNode();
        this.ghostNode = node;
    }

    placeGhostNode() {
        if (this.ghostNode) {
            const node = this.ghostNode;
            this.nodeGraph.nodes.push(node);
            this.nodeGraph.groupCtl?.adoptNew(node); // lands in the open group
            this.ghostNode = null;
            // Registered like NodeGraph.addNode does
            if (node.isPreviewNode && node.renderer && this.nodeGraph.previewNodes) this.nodeGraph.previewNodes.set(node.id, node.renderer);

            // Auto-pair ForLoopStart with ForLoopEnd
            if (node.isForLoopStartNode) {
                // Create paired ForLoopEnd node to the right
                const pairX = node.x + 300;
                const pairY = node.y;
                const pairNode = this.nodeGraph.addNode('ForLoopEnd', pairX, pairY);

                if (pairNode) {
                    // Copy varTypes for initial creation
                    pairNode.data.varTypes = [...node.data.varTypes];

                    // Link them together
                    node.data.pairNodeId = pairNode.id;
                    pairNode.data.pairNodeId = node.id;

                    // Update pair's ports
                    pairNode.updatePorts();
                }
            }

            if (this.nodeGraph.onGraphChanged) {
                this.nodeGraph.onGraphChanged();
            }
            this.nodeGraph.render();
            return true;
        }
        return false;
    }

    updateGhostNodePosition(x, y) {
        if (this.ghostNode) {
            this.ghostNode.x = x;
            this.ghostNode.y = y;
            return true;
        }
        return false;
    }

    cancelGhostNode() {
        // The ghost never joined the graph: release what its constructor set up
        // (Keyboard key listeners, MIDI subscriptions, preview renderers)
        const ghost = this.ghostNode;
        this.ghostNode = null;
        if (ghost) {
            try {
                if (ghost.isPreviewNode && ghost.renderer) ghost.renderer.destroy();
                if (ghost.cleanup) ghost.cleanup();
            } catch (e) { /* best effort */ }
        }
        this.nodeGraph.render();
    }

    drawGhostNode(ctx) {
        if (this.ghostNode) {
            ctx.save();
            ctx.globalAlpha = 0.5;
            this.ghostNode.draw(ctx, {
                isSelected: false
            });
            ctx.restore();
        }
    }
}
