/**
 * GroupUI - DOM side of node groups (src/graph/NodeGroups.js):
 *  - breadcrumb bar over the canvas while a group is open (Root › Scene › Lighting)
 *  - canvas context menu (group / ungroup / rename / open / delete ...)
 *  - inline rename field over a group box title, and over a box port label / the matching
 *    row of the inside "From outside" / "To outside" panels (NodeGroups portLabels)
 *  - "Rename ports" dialog (box context menu)
 *  - "delete contents or just ungroup?" dialog
 *  - port picker when a cable is dropped on a group box
 * Styles: .pt-crumbs*, .pt-group-* in style.css.
 */
import { UIHelpers, h } from './UIHelpers.js';
import { icon, injectIconSprite } from './icons.js';
import { NodeDefinitions } from '../core/NodeDefinitions.js';
import { GROUP_LAYOUT } from '../rendering/NodePainter.js';

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
const MOD = IS_MAC ? '⌘' : 'Ctrl+';
const SHIFT = IS_MAC ? '⇧' : 'Shift+';

function cursorAnchor(e) {
    const x = e.clientX, y = e.clientY;
    return { left: x, right: x, top: y, bottom: y, width: 0, height: 0 };
}

export class GroupUI {
    constructor(ctl) {
        this.ctl = ctl;
        this.el = null;
        this.renameEl = null;
        this._menu = null;
    }

    get graph() { return this.ctl.graph; }

    // ------------------------------------------------------------------
    // Breadcrumbs
    // ------------------------------------------------------------------

    _ensureBar() {
        if (this.el || typeof document === 'undefined') return this.el;
        const canvas = this.graph.canvas;
        const host = (canvas && canvas.parentElement) || document.getElementById('container');
        if (!host) return null;
        injectIconSprite();
        this.el = h('nav', { className: 'pt-crumbs', 'aria-label': 'Group path' });
        this.trail = h('div', { className: 'pt-crumbs-trail' });
        this.hint = h('span', { className: 'pt-crumbs-hint', html: '<kbd>Esc</kbd><span>up a level</span>' });
        this.el.append(this.trail, this.hint);
        // Keep canvas shortcuts (Esc, Backspace...) away from the bar's buttons
        this.el.addEventListener('mousedown', (e) => e.stopPropagation());
        host.appendChild(this.el);
        return this.el;
    }

    update() {
        const bar = this._ensureBar();
        if (!bar) return;
        const ctl = this.ctl;
        const scope = ctl.scope;
        bar.classList.toggle('is-visible', scope !== null);
        if (scope === null) {
            this.trail.replaceChildren();
            return;
        }
        const path = ctl.path(scope);
        const parts = [];
        path.forEach((p, i) => {
            const last = i === path.length - 1;
            if (i > 0) parts.push(h('span', { className: 'pt-crumb-sep', html: icon('chevronRight', { size: 12 }), 'aria-hidden': 'true' }));
            if (last) {
                const accent = ctl.groupAccent(p.id);
                const proxy = ctl.proxyFor(p.id);
                const count = proxy ? proxy.count : ctl.subtreeNodes(p.id).filter(n => !n.isCommentNode).length;
                const cur = h('span', {
                    className: 'pt-crumb is-current',
                    title: 'Double-click to rename',
                    style: { '--crumb-accent': accent },
                }, [
                    h('span', { className: 'pt-crumb-dot', 'aria-hidden': 'true' }),
                    h('span', { className: 'pt-crumb-name', text: p.name }),
                    h('span', { className: 'pt-crumb-count', text: String(count) }),
                ]);
                cur.addEventListener('dblclick', () => this.renameCurrentCrumb(cur, p.id));
                parts.push(cur);
            } else {
                const btn = h('button', {
                    className: 'pt-crumb' + (p.id === null ? ' is-root' : ''),
                    type: 'button',
                    title: p.id === null ? 'Back to the root graph' : `Open “${p.name}”`,
                });
                if (p.id === null) btn.insertAdjacentHTML('beforeend', icon('layers', { size: 14 }));
                btn.appendChild(h('span', { className: 'pt-crumb-name', text: p.name }));
                btn.addEventListener('click', () => ctl.setScope(p.id));
                parts.push(btn);
            }
        });
        this.trail.replaceChildren(...parts);
    }

    renameCurrentCrumb(el, gid) {
        const grp = this.ctl.getGroup(gid);
        if (!grp) return;
        const input = h('input', { className: 'pt-input pt-crumb-input', type: 'text', value: grp.name, spellcheck: false });
        el.replaceWith(input);
        input.focus();
        input.select();
        let done = false;
        const finish = (commit) => {
            if (done) return;
            done = true;
            if (commit && this.ctl.renameGroup(gid, input.value)) this.ctl.changed(`Renamed group to “${input.value.trim()}”`);
            this.update();
        };
        input.addEventListener('keydown', (e) => {
            e.stopPropagation();
            if (e.key === 'Enter') { e.preventDefault(); finish(true); }
            else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
        });
        input.addEventListener('blur', () => finish(true));
    }

    // ------------------------------------------------------------------
    // Inline rename over a group box
    // ------------------------------------------------------------------

    cancelRename() {
        if (this.renameEl) {
            const el = this.renameEl;
            this.renameEl = null;
            el._cancel = true;
            if (el._unfollow) el._unfollow();
            el.remove();
        }
    }

    beginRename(gid) {
        const ctl = this.ctl;
        const g = this.graph;
        this.cancelRename();
        const grp = ctl.getGroup(gid);
        if (!grp) return;
        const proxy = ctl.proxyFor(gid);
        if (!proxy || !ctl.view().proxies.includes(proxy)) return;
        const G = GROUP_LAYOUT;
        const input = h('input', {
            className: 'pt-input pt-group-rename',
            type: 'text',
            value: grp.name,
            spellcheck: false,
            'aria-label': 'Group name',
            style: { '--crumb-accent': proxy.accent },
        });
        // Placed over the group box header for the current pan / zoom; re-placed after every
        // canvas render (wheel pan / zoom while typing, review E-m8), hidden when the box is not shown
        const place = () => {
            const p = ctl.proxyFor(gid);
            const shown = !!p && ctl.view().proxies.includes(p);
            input.style.display = shown ? '' : 'none';
            if (!shown) return;
            const rect = g.canvas.getBoundingClientRect();
            const z = g.zoom || 1;
            input.style.left = `${Math.round(rect.left + g.panX + (p.x + 22) * z)}px`;
            input.style.top = `${Math.round(rect.top + g.panY + (p.y + 5) * z)}px`;
            input.style.width = `${Math.round(Math.max(150, (p.width - 100) * z))}px`;
            input.style.height = `${Math.round(Math.max(24, (G.headerH - 10) * z))}px`;
            input.style.fontSize = `${Math.max(12, Math.min(18, Math.round(18 * z)))}px`;
        };
        place();
        const unfollow = typeof g.addOverlay === 'function' ? g.addOverlay(place) : () => {};
        input._unfollow = unfollow;
        document.body.appendChild(input);
        this.renameEl = input;
        input.focus();
        input.select();
        const finish = (commit) => {
            if (input._done || input._cancel) return;
            input._done = true;
            unfollow();
            if (this.renameEl === input) this.renameEl = null;
            input.remove();
            if (commit && ctl.renameGroup(gid, input.value)) ctl.changed(`Renamed group to “${input.value.trim()}”`);
            g.render();
        };
        input.addEventListener('keydown', (e) => {
            e.stopPropagation();
            if (e.key === 'Enter') { e.preventDefault(); finish(true); }
            else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
        });
        input.addEventListener('blur', () => finish(true));
        input.addEventListener('mousedown', (e) => e.stopPropagation());
    }

    // ------------------------------------------------------------------
    // Port names (group box ports / boundary panel rows)
    // ------------------------------------------------------------------

    /** Where the port `key` of group `gid` shows in the current view: { rect, port } or null. */
    _portSpot(gid, key) {
        const ctl = this.ctl;
        const v = ctl.view();
        if (ctl.scope === gid && v.inPanel) {
            for (const panel of [v.inPanel, v.outPanel]) {
                const i = panel.indexOfKey(key);
                if (i >= 0) return { rect: panel.portLabelRect(i), port: panel.rows[i] };
            }
            return null;
        }
        const proxy = ctl.proxyFor(gid);
        if (!proxy || !v.proxies.includes(proxy)) return null;
        const kind = key.startsWith('o:') ? 'out' : 'in';
        const i = proxy.indexOfKey(kind, key);
        return i >= 0 ? { rect: proxy.portLabelRect(kind, i), port: proxy.portAt(kind, i) } : null;
    }

    /** Inline field over a port label: Enter keeps, Esc cancels, an empty name restores the automatic one. */
    beginPortRename(gid, key) {
        const ctl = this.ctl;
        const g = this.graph;
        this.cancelRename();
        const grp = ctl.getGroup(gid);
        const spot = grp && this._portSpot(gid, key);
        if (!spot || !spot.port) return;
        const auto = spot.port.autoLabel || spot.port.label;
        const accent = ctl.proxyFor(gid)?.accent || ctl.groupAccent(gid);
        const input = h('input', {
            className: 'pt-input pt-group-rename pt-group-port-rename',
            type: 'text',
            value: spot.port.label,
            placeholder: auto,
            maxLength: 60,
            spellcheck: false,
            'aria-label': `Port name (empty: ${auto})`,
            title: `Port name. Leave empty for the automatic name “${auto}”.`,
            style: { '--crumb-accent': accent },
        });
        const place = () => {
            const sp = this._portSpot(gid, key);
            input.style.display = sp ? '' : 'none';
            if (!sp) return;
            const rect = g.canvas.getBoundingClientRect();
            const z = g.zoom || 1;
            const r = sp.rect;
            const w = Math.max(140, r.w * z);
            const left = r.align === 'right' ? rect.left + g.panX + (r.x + r.w) * z - w : rect.left + g.panX + r.x * z;
            input.style.left = `${Math.round(left)}px`;
            input.style.top = `${Math.round(rect.top + g.panY + (r.y + r.h / 2) * z - Math.max(22, r.h * z) / 2)}px`;
            input.style.width = `${Math.round(w)}px`;
            input.style.height = `${Math.round(Math.max(22, r.h * z))}px`;
            input.style.fontSize = `${Math.max(11, Math.min(15, Math.round(13 * z)))}px`;
            input.style.textAlign = r.align === 'right' ? 'right' : 'left';
        };
        place();
        const unfollow = typeof g.addOverlay === 'function' ? g.addOverlay(place) : () => {};
        input._unfollow = unfollow;
        document.body.appendChild(input);
        this.renameEl = input;
        input.focus();
        input.select();
        const finish = (commit) => {
            if (input._done || input._cancel) return;
            input._done = true;
            unfollow();
            if (this.renameEl === input) this.renameEl = null;
            input.remove();
            if (commit) {
                const text = input.value.trim();
                const label = text === auto ? '' : text;
                if (ctl.setPortLabel(gid, key, label)) ctl.changed(label ? `Renamed port “${auto}” to “${label}”` : `Port “${auto}” uses its automatic name again`);
            }
            g.render();
        };
        input.addEventListener('keydown', (e) => {
            e.stopPropagation();
            if (e.key === 'Enter') { e.preventDefault(); finish(true); }
            else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
        });
        input.addEventListener('blur', () => finish(true));
        input.addEventListener('mousedown', (e) => e.stopPropagation());
    }

    /** Dialog listing every box port of a group with a name field (empty = automatic name). */
    openPortNames(gid) {
        const ctl = this.ctl;
        const grp = ctl.getGroup(gid);
        if (!grp) return;
        const ports = ctl.groupPorts(gid);
        const m = UIHelpers.createModal({
            title: `Port names of “${grp.name}”`,
            subtitle: 'Names shown on the group box and on the panels inside. Leave a field empty for the automatic name.',
            className: 'pt-group-ports-modal',
        });
        const fields = [];
        const section = (title, list) => {
            if (!list.length) return;
            m.body.appendChild(h('div', { className: 'pt-label pt-group-ports-head', text: title }));
            for (const p of list) {
                const f = UIHelpers.field({ label: `${p.auto}${p.type ? ` · ${p.type}` : ''}`, placeholder: p.auto, value: p.custom ? p.label : '' });
                f.input.maxLength = 60;
                f.input.dataset.portKey = p.key;
                f.input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } });
                m.body.appendChild(f.field);
                fields.push({ port: p, input: f.input });
            }
        };
        section('Inputs', ports.filter(p => p.kind === 'in'));
        section('Outputs', ports.filter(p => p.kind === 'out'));
        if (!fields.length) m.body.appendChild(h('div', { className: 'pt-field-hint', text: 'This group has no ports yet: connect a cable across its boundary or expose a port from inside.' }));
        const save = () => {
            let n = 0;
            for (const { port, input } of fields) {
                const text = input.value.trim();
                if (ctl.setPortLabel(gid, port.key, text === port.auto ? '' : text)) n++;
            }
            m.close();
            if (n) ctl.changed(`Renamed ${n} port${n === 1 ? '' : 's'} of “${grp.name}”`);
            else this.graph.render();
        };
        m.footer.append(
            UIHelpers.button('Cancel', { onClick: () => m.close() }),
            UIHelpers.button('Save', { variant: 'primary', onClick: save }),
        );
        setTimeout(() => (fields[0]?.input || m.footer.lastChild)?.focus(), 0);
        return m;
    }

    // ------------------------------------------------------------------
    // Context menu
    // ------------------------------------------------------------------

    showContextMenu(e, item, pos) {
        const ctl = this.ctl;
        const g = this.graph;
        const sel = g.selectionManager.selectedNodes;
        if (this._menu && !this._menu.closed) this._menu.close();

        // Right-clicking an unselected item selects it alone
        if (item && !item.isBoundaryPanel && !sel.has(item)) {
            sel.clear();
            sel.add(item);
            g.render();
        }
        const selItems = ctl.selectedItems();
        const proxies = selItems.filter(n => n.isGroupProxy);
        const items = [];

        if (item && item.isGroupProxy) {
            const gid = item.group.id;
            items.push({ header: this._menuHeader(item.name, `${item.count} nodes${item.subgroups ? ` · ${item.subgroups} subgroup${item.subgroups === 1 ? '' : 's'}` : ''}`, item.accent) });
            items.push({ icon: 'folder', label: 'Open group', hint: 'Enter', onClick: () => ctl.enter(gid) });
            items.push({ icon: 'pencil', label: 'Rename…', onClick: () => ctl.ui.beginRename(gid) });
            // Port names: the port under the cursor, or all of them in a dialog
            const hit = pos && item.portLabelAt ? item.portLabelAt(pos.x, pos.y) : null;
            if (hit && hit.port) {
                const pk = hit.port.key;
                items.push({ icon: 'pencil', label: `Rename port “${hit.port.label}”…`, hint: 'Dbl-click', onClick: () => ctl.ui.beginPortRename(gid, pk) });
                if (hit.port.custom) items.push({ icon: 'undo', label: `Reset to “${hit.port.autoLabel}”`, onClick: () => { if (ctl.setPortLabel(gid, pk, '')) ctl.changed(`Port “${hit.port.autoLabel}” uses its automatic name again`); } });
            }
            if (item.inPorts.length || item.outPorts.length) items.push({ icon: 'pencil', label: 'Rename ports…', onClick: () => ctl.ui.openPortNames(gid) });
            items.push({ separator: true });
            items.push({ icon: 'layers', label: selItems.length > 1 ? `Group ${selItems.length} items` : 'Group into a new group', hint: `${MOD}G`, onClick: () => ctl.groupSelection() });
            items.push({ icon: 'expand', label: proxies.length > 1 ? `Ungroup ${proxies.length} groups` : 'Ungroup', hint: `${SHIFT}${MOD}G`, onClick: () => ctl.ungroupSelection() });
            if (ctl.scope !== null) items.push({ icon: 'arrowUp', label: 'Move out of this group', onClick: () => ctl.moveSelectionToParent() });
            items.push({ icon: 'copy', label: 'Duplicate', hint: `${MOD}C ${MOD}V`, onClick: () => { g.copySelectedNodes(); g.pasteNodes(); g.history?.hint('Duplicate'); } });
            items.push({ separator: true });
            items.push({ icon: 'trash', label: proxies.length > 1 ? 'Delete groups…' : 'Delete group…', hint: '⌫', danger: true, onClick: () => g.deleteSelectedNodes() });
        } else if (item && !item.isViewOnly) {
            const def = NodeDefinitions[item.type] || {};
            const action = item.isCommentNode ? { icon: 'pencil', label: 'Edit note' }
                : def.isCustomNode ? { icon: 'code', label: 'Edit GLSL…' }
                    : def.hasColorPicker ? { icon: 'gear', label: 'Pick color…' } : null;
            if (action) {
                items.push({ ...action, hint: 'Dbl-click', onClick: () => g.onNodeRightClick && g.onNodeRightClick(item, e) });
                items.push({ separator: true });
            }
            // Node-specific settings (e.g. debug probes: sample point, history length)
            const own = typeof item.getContextMenuItems === 'function' ? item.getContextMenuItems() : null;
            if (own && own.length) items.push(...own, { separator: true });
            items.push({ icon: 'layers', label: selItems.length > 1 ? `Group ${selItems.length} items` : 'Group', hint: `${MOD}G`, onClick: () => ctl.groupSelection() });
            if (ctl.scope !== null) items.push({ icon: 'arrowUp', label: 'Move out of this group', onClick: () => ctl.moveSelectionToParent() });
            items.push({ icon: 'copy', label: 'Duplicate', hint: `${MOD}C ${MOD}V`, onClick: () => { g.copySelectedNodes(); g.pasteNodes(); g.history?.hint('Duplicate'); } });
            // Node help panel (src/ui/help/HelpCenter.js)
            items.push({ icon: 'help', label: 'Help', hint: 'F1', onClick: () => window.dispatchEvent(new CustomEvent('patchtoy:help', { detail: { type: item.type } })) });
            items.push({ separator: true });
            items.push({ icon: 'trash', label: selItems.length > 1 ? `Delete ${selItems.length} items` : 'Delete', hint: '⌫', danger: true, onClick: () => g.deleteSelectedNodes() });
        } else {
            // Empty canvas (or a boundary panel)
            if (item && item.isBoundaryPanel) {
                const ri = item.rowAt(pos.x, pos.y);
                const row = ri >= 0 ? item.rows[ri] : null;
                if (row && !row.expose && ctl.scope !== null) {
                    const sc = ctl.scope, rk = row.key;
                    items.push({ icon: 'pencil', label: `Rename port “${row.label}”…`, hint: 'Dbl-click', onClick: () => ctl.ui.beginPortRename(sc, rk) });
                    if (row.custom) items.push({ icon: 'undo', label: `Reset to “${row.autoLabel}”`, onClick: () => { if (ctl.setPortLabel(sc, rk, '')) ctl.changed(`Port “${row.autoLabel}” uses its automatic name again`); } });
                    items.push({ separator: true });
                }
                if (row && row.exposed && !row.conns.length) {
                    const ref = item.side === 'in' ? row.target : row.source;
                    if (ref) {
                        items.push({ icon: 'close', label: `Remove exposed ${item.side === 'in' ? 'input' : 'output'}`, onClick: () => ctl.unexpose(ctl.scope, item.side === 'in' ? 'in' : 'out', ref.node.id, ref.index) });
                        items.push({ separator: true });
                    }
                }
            }
            items.push({ icon: 'plus', label: 'Add node…', hint: 'Tab', onClick: () => g.quickNodeSearch && g.quickNodeSearch.show(g.addNodeButton) });
            if (selItems.length) items.push({ icon: 'layers', label: `Group ${selItems.length} selected`, hint: `${MOD}G`, onClick: () => ctl.groupSelection() });
            items.push({ icon: 'check', label: 'Select all', hint: `${MOD}A`, onClick: () => g.selectAll() });
            // Undo / redo (src/core/History.js)
            const hist = g.history;
            if (hist) {
                const u = hist.canUndo() ? hist.peekUndo() : null;
                const r = hist.canRedo() ? hist.peekRedo() : null;
                items.push({ separator: true });
                items.push({ icon: 'undo', label: u ? `Undo ${u}` : 'Undo', hint: `${MOD}Z`, disabled: !u, onClick: () => hist.undo() });
                items.push({ icon: 'redo', label: r ? `Redo ${r}` : 'Redo', hint: `${SHIFT}${MOD}Z`, disabled: !r, onClick: () => hist.redo() });
            }
            if (ctl.scope !== null) {
                const parent = ctl.parentOf(ctl.scope);
                const pname = parent === null ? 'Root' : (ctl.getGroup(parent) || {}).name;
                items.push({ separator: true });
                items.push({ icon: 'arrowUp', label: `Up to ${pname}`, hint: 'Esc', onClick: () => ctl.exitUp() });
            }
        }
        this._menu = UIHelpers.openMenu({ anchor: cursorAnchor(e), items, offset: 2, className: 'pt-group-menu' });
    }

    _menuHeader(title, sub, accent) {
        return h('div', { className: 'pt-group-menu-head', style: { '--crumb-accent': accent } }, [
            h('span', { className: 'pt-crumb-dot', 'aria-hidden': 'true' }),
            h('span', { className: 'pt-group-menu-title', text: title }),
            h('span', { className: 'pt-group-menu-sub', text: sub }),
        ]);
    }

    // ------------------------------------------------------------------
    // Dialogs
    // ------------------------------------------------------------------

    confirmDeleteGroups(proxies, looseCount = 0) {
        const n = proxies.reduce((s, p) => s + p.count, 0);
        const title = proxies.length === 1 ? `Delete group “${proxies[0].name}”?` : `Delete ${proxies.length} groups?`;
        const what = proxies.length === 1 ? `It contains ${n} node${n === 1 ? '' : 's'}.` : `They contain ${n} node${n === 1 ? '' : 's'}.`;
        const extra = looseCount ? ` The ${looseCount} other selected node${looseCount === 1 ? '' : 's'} will be deleted either way.` : '';
        return UIHelpers.choose({
            title,
            message: `${what} Delete the contents too, or ungroup and keep them?${extra}`,
            buttons: [
                { label: 'Cancel', value: null, variant: 'ghost' },
                { spacer: true },
                { label: 'Ungroup, keep nodes', value: 'ungroup' },
                { label: 'Delete with contents', value: 'contents', variant: 'danger' },
            ],
        });
    }

    /** Cable dropped on a group box body: choose which inner port it connects to. */
    openPortPicker(proxy, drag, e) {
        const ctl = this.ctl;
        const list = ctl.pickerCandidates(proxy.group.id, drag);
        if (this._menu && !this._menu.closed) this._menu.close();
        const items = [{ header: this._menuHeader(proxy.name, drag.reverse ? 'connect from an inner output' : 'connect to an inner input', proxy.accent) }];
        if (!drag.reverse && !ctl.isInSubtree(drag.node, proxy.group.id) && !ctl._hasInFeed(proxy.group.id, drag.node.id, drag.index)) {
            // A group input patched to this output, connected inside later (virtual input)
            items.push({
                label: 'New input',
                hint: 'connect inside later',
                onClick: () => ctl.dropNewInput(proxy, drag.node, drag.index),
            });
            items.push({ separator: true });
        }
        if (!list.length) {
            items.push({ label: 'No compatible ports inside', disabled: true });
        }
        for (const c of list.slice(0, 60)) {
            items.push({
                label: c.label,
                hint: c.type || '',
                badge: c.linked ? 'patched' : (c.depth > 0 ? 'nested' : undefined),
                onClick: () => {
                    // connect() already fires the graph change + render on success
                    const ok = drag.reverse
                        ? ctl.connect(c.node, c.index, drag.node, drag.index, null)
                        : ctl.connect(drag.node, drag.index, c.node, c.index, drag.accessor);
                    if (ok) {
                        ctl.ui.update();
                        try { window.toy && window.toy.shell && window.toy.shell.activity(`Connected into “${proxy.name}”`, { local: true }); } catch (err) { /* ignore */ }
                    } else {
                        UIHelpers.toast(`Could not connect ${c.label}${c.type ? ` (${c.type})` : ''}`, 'warning', { title: 'Cannot connect' });
                    }
                },
            });
        }
        const anchor = e ? cursorAnchor(e) : null;
        if (!anchor) return;
        this._menu = UIHelpers.openMenu({ anchor, items, offset: 4, className: 'pt-group-picker' });
    }
}
