/**
 * Onboarding and in-app help, wired to the app shell (created by AppShell, available as app.help):
 *   - the "?" Help menu in the top bar (#helpBtn): tour, shortcuts, node reference
 *   - the first-run tour (Tour.js), started by itself only when env.js allows it
 *   - node help (NodeHelpPanel.js): F1, right-click → Help, the "?" on library items,
 *     and window event 'patchtoy:help' { type }
 *   - the shortcut cheat sheet (ShortcutSheet.js): ? on the canvas
 *   - the empty-canvas card buttons (#emptyTourBtn, #emptyShortcutsBtn)
 */
import { UIHelpers } from '../UIHelpers.js';
import { NodeDefinitions } from '../../core/NodeDefinitions.js';
import { NodeHelpPanel } from './NodeHelpPanel.js';
import { ShortcutSheet } from './ShortcutSheet.js';
import { Tour } from './Tour.js';
import { shouldAutoStartTour, tourAllowed, resetTour, isAutomatedSession, tourDone, tourFlag } from './env.js';
import { nodeTitle } from '../nodeCatalog.js';

const AUTOSTART_DELAY_MS = 1400;

function isTypingTarget(app) {
    const a = document.activeElement;
    if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable)) return true;
    if (a && a.closest && a.closest('.monaco-editor')) return true;
    if (app && app.nodeGraph && app.nodeGraph.focusedTextInput) return true;
    return false;
}

export class HelpCenter {
    constructor(app) {
        this.app = app;
        app.help = this;
        this.nodeHelp = new NodeHelpPanel(app);
        this.sheet = new ShortcutSheet(app);
        this.tour = null;
        this.hoverLibType = null;
        // A brand-new profile: nothing saved yet (read before the first autosave)
        let firstRun = false;
        try { firstRun = localStorage.getItem('patchtoy_graph') === null; } catch (e) { /* ignore */ }
        this.firstRun = firstRun;

        this.setupButtons();
        this.setupKeys();
        this.setupEvents();
        this.scheduleAutoStart();
    }

    get graph() { return this.app.nodeGraph; }

    /* ---------------- Entry points ---------------- */

    startTour(from = 0) {
        if (!tourAllowed()) {
            UIHelpers.toast('The tour is turned off on this page (?tour=off).', 'info');
            return null;
        }
        this.nodeHelp.close();
        this.sheet.close();
        if (!this.tour) this.tour = new Tour(this.app);
        this.tour.start(from);
        return this.tour;
    }

    stopTour(reason = 'interrupted') {
        this.tour?.stop(reason);
    }

    openShortcuts() {
        return this.sheet.open();
    }

    /** Help for a node type; null = the node reference (search). */
    openNodeHelp(type = null, opts = {}) {
        return this.nodeHelp.show(type, opts);
    }

    /** The single selected node's type (ignores group boxes / panels), else null. */
    selectedType() {
        const sel = this.graph?.selectionManager?.selectedNodes;
        if (!sel || sel.size !== 1) return null;
        const n = [...sel][0];
        return n && !n.isViewOnly && NodeDefinitions[n.type] ? n.type : null;
    }

    /* ---------------- Wiring ---------------- */

    setupButtons() {
        const btn = document.getElementById('helpBtn');
        if (btn) btn.addEventListener('click', () => this.openMenu(btn));
        document.getElementById('emptyTourBtn')?.addEventListener('click', () => this.startTour());
        document.getElementById('emptyShortcutsBtn')?.addEventListener('click', () => this.openShortcuts());
    }

    openMenu(anchor) {
        if (this._menu && !this._menu.closed) { this._menu.close(); return; }
        const type = this.selectedType();
        const items = [
            { icon: 'flag', label: this.tour?.isRunning() ? 'Restart the tour' : 'Take the tour', onClick: () => this.startTour() },
            { icon: 'keyboard', label: 'Keyboard shortcuts', hint: '?', onClick: () => this.openShortcuts() },
            { icon: 'help', label: 'Node reference', hint: 'F1', onClick: () => this.openNodeHelp(null, { focusSearch: true }) },
        ];
        if (type) items.push({ icon: 'info', label: `Help: ${nodeTitle(type)}`, onClick: () => this.openNodeHelp(type) });
        items.push({ separator: true });
        items.push({ icon: 'gallery', label: 'Browse demos', onClick: () => this.app.demoGallery?.open() });
        this._menu = UIHelpers.openMenu({ anchor, items, align: 'end', className: 'pt-help-menu', onClose: () => { this._menu = null; } });
    }

    setupKeys() {
        window.addEventListener('keydown', (e) => {
            if (e.defaultPrevented) return;
            if (e.key === 'F1') {
                e.preventDefault();
                if (isTypingTarget(this.app) && !this.hoverLibType) return;
                const type = this.hoverLibType || this.selectedType();
                if (type) this.nodeHelp.toggle(type);
                else this.openNodeHelp(null, { focusSearch: true });
                return;
            }
            if (e.key === '?' && !e.metaKey && !e.ctrlKey && !e.altKey) {
                if (isTypingTarget(this.app)) return;
                if (this.graph && this.graph.connectingFrom) return;
                // Not over another dialog (the sheet itself toggles)
                if (!this.sheet.isOpen() && document.querySelector('.pt-modal-backdrop')) return;
                e.preventDefault();
                this.sheet.toggle();
            }
        });
    }

    setupEvents() {
        // Right-click → Help (GroupUI), library "?" (LibraryPanel), automation
        window.addEventListener('patchtoy:help', (e) => {
            const type = e.detail && e.detail.type;
            this.openNodeHelp(type && NodeDefinitions[type] ? type : null);
        });
        // F1 over a library item helps with that item
        const list = document.getElementById('libraryList');
        if (list) {
            list.addEventListener('pointerover', (e) => {
                const item = e.target.closest && e.target.closest('.lib-item');
                this.hoverLibType = item ? item.dataset.type : null;
            });
            list.addEventListener('pointerleave', () => { this.hoverLibType = null; });
        }
        // An MCP client taking over the page ends the tour (not remembered as done)
        window.addEventListener('patchtoy:bridge-status', (e) => {
            if (e.detail && e.detail.connected) this.stopTour('interrupted');
        });
    }

    scheduleAutoStart() {
        // Decided on the route the page was opened with: the first-visit demo gallery
        // moves the URL to /explore/demos before the tour starts
        if (!shouldAutoStartTour({ firstRun: this.firstRun })) return;
        setTimeout(() => {
            // Still allowed? (an MCP bridge may have connected meanwhile, a tour may be running)
            if (this.app.shell?.bridge?.connected) return;
            if (tourFlag() !== 'on' && (isAutomatedSession() || tourDone())) return;
            if (this.tour?.isRunning()) return;
            this.startTour();
        }, AUTOSTART_DELAY_MS);
    }

    /** Forget the tour's completion (it starts again on the next first-run-like load). */
    resetTour() {
        resetTour();
    }
}
