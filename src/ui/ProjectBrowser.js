import { UIHelpers, h, avatarColor, initials } from './UIHelpers.js';
import { icon } from './icons.js';
import { DEMOS } from './demoManifest.js';
import { navigate, paths, setMeta, userPageUrl, sameUsername } from '../core/router.js';
import './community.css';
import { visibilityOf } from '../managers/ProjectManager.js';
import { VISIBILITY_LABELS } from '../managers/CommunityManager.js';
import { comboText } from './help/shortcuts.js';

/**
 * Project browser: one gallery for your own cloud projects, community projects,
 * demos and user pages. Same card grid as the demo gallery (dg-* styles).
 *
 *   My projects  the signed-in user's projects (visibility, rename, delete, copy link)
 *   Community    public projects of every user (newest / popular, search)
 *   Demos        bundled demo patches (DemoGallery builds those cards)
 *   User page    /u/<username>: profile + public projects
 *
 * Two presentations of the same content:
 *   popover  the top bar "Open" button and ⌘O: a panel anchored under the button, no
 *            backdrop, closes on outside click / Esc / opening a project. Transient: it
 *            doesn't touch the URL. A user page opened from it moves to the modal.
 *   modal    deep links and routes (/explore[/tab], /u/<name>, back / forward), the
 *            first-visit welcome and the empty-canvas card: the full-screen dialog,
 *            with the URL following the tab.
 *
 * Every user-provided string (titles, descriptions, usernames) goes through
 * textContent / attributes, never innerHTML.
 */

const PAGE_SIZE = 24;
const PLACEHOLDER_COLORS = ['#ff5c2b', '#f5c84b', '#4ade80', '#8ecbff', '#a78bfa', '#f472b6', '#2dd4bf'];

const TABS = [
    { id: 'mine', label: 'My projects', icon: 'folder' },
    { id: 'community', label: 'Community', icon: 'globe' },
    { id: 'demos', label: 'Demos', icon: 'gallery' },
];
const DEFAULT_VIEW = 'mine';
const POPOVER_SIZE = { width: 860, height: 620 };
/** Shown on "Publish to Community" while the API is 1.x. */
const NEEDS_V2 = 'Available after the 2.0 backend deploy';

const SORTS = {
    demos: [['featured', 'Featured'], ['az', 'A–Z']],
    community: [['new', 'Newest'], ['popular', 'Popular']],
    mine: [['recent', 'Recent'], ['name', 'Name'], ['views', 'Views']],
    user: [['new', 'Newest'], ['popular', 'Popular']],
};

export function relativeDate(value) {
    if (!value) return '';
    const d = new Date(value);
    if (isNaN(d)) return '';
    const diff = (Date.now() - d.getTime()) / 1000;
    if (diff < 60) return 'just now';
    if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)} h ago`;
    if (diff < 86400 * 30) return `${Math.floor(diff / 86400)} d ago`;
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function hashColor(seed = '') {
    let hash = 0;
    for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) | 0;
    return PLACEHOLDER_COLORS[Math.abs(hash) % PLACEHOLDER_COLORS.length];
}

function initialsOf(name = '') {
    const words = String(name).trim().split(/\s+/).filter(Boolean);
    return (words.length > 1 ? words[0][0] + words[1][0] : (words[0] || '?').slice(0, 2)).toUpperCase();
}

function firstSentence(text = '') {
    const s = String(text).trim();
    const cut = s.search(/[.!?]\s|\n/);
    return cut > 12 ? s.slice(0, cut + 1) : s;
}

const compact = (n) => (n >= 10000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n || 0));

/**
 * The 1.x list endpoint returns { id, name, createdAt, updatedAt } only: no isPublic /
 * visibility, so a card can't tell private from shared by link until it changes.
 */
function visibilityKnown(p) {
    return !!p && (p.visibility !== undefined || p.isPublic !== undefined);
}

function iconNode(name, size = 16) {
    const t = document.createElement('template');
    t.innerHTML = icon(name, { size });
    return t.content.firstChild;
}

export class ProjectBrowser {
    /** @param {PatchToy} app - main app (apiClient, demoGallery, community, projectManager) */
    constructor(app) {
        this.app = app;
        this.modal = null;
        this.view = DEFAULT_VIEW;
        this.username = null;
        this.welcome = false;
        this.presentation = 'modal';
        this.states = {};

        // Top bar "Open" button: the popover (clicking it again closes it)
        const btn = document.getElementById('openBtn');
        if (btn) {
            btn.setAttribute('data-kbd', comboText(['Mod', 'O']));
            btn.setAttribute('aria-expanded', 'false');
            btn.addEventListener('click', () => {
                if (this.isOpen() && this.presentation === 'popover') this.close({ reason: 'toggle' });
                else this.open({ view: DEFAULT_VIEW, presentation: 'popover' });
            });
        }

        // Signing in or out changes "My projects" and ownership badges
        window.addEventListener('patchtoy:auth', () => {
            this.states.mine = null;
            if (this.isOpen() && (this.view === 'mine' || this.view === 'user')) this.render();
        });
        // The API turned out to be 1.x (or 2.0): Community / publishing labels change
        window.addEventListener('patchtoy:api-caps', () => {
            if (this.isOpen() && this.view !== 'demos') this.render();
        });
    }

    get api() {
        return this.app.apiClient;
    }

    isOpen() {
        return !!this.modal && !this.modal.closed && this.modal.backdrop.isConnected;
    }

    /** The popover (Open button / ⌘O) is showing. */
    isPopover() {
        return this.isOpen() && this.presentation === 'popover';
    }

    state(view = this.view) {
        // Usernames are case-insensitive: /u/sirkitboi and /u/SirKitBoi are the same page
        if (!this.states[view] || (view === 'user' && !sameUsername(this.states.user.username, this.username))) {
            this.states[view] = {
                username: view === 'user' ? this.username : null,
                items: [],
                cursor: null,
                loaded: false,
                loading: false,
                error: null,
                q: '',
                sort: SORTS[view][0][0],
                seq: 0,
                user: null,
            };
        }
        return this.states[view];
    }

    /* ------------------------------------------------------------------ */
    /* Modal                                                              */
    /* ------------------------------------------------------------------ */

    /**
     * Open (or switch) the browser. Without a view it opens on My projects.
     * @param {{view?: 'demos'|'community'|'mine'|'user', username?: string, welcome?: boolean,
     *   updateUrl?: boolean, presentation?: 'modal'|'popover'}} opts
     *   presentation: 'popover' anchors it under the top bar Open button (see the class doc).
     *   Switching an open browser keeps its presentation unless one is given.
     */
    open({ view = null, username = null, welcome = false, updateUrl = true, presentation = null } = {}) {
        const next = view || DEFAULT_VIEW;
        if (next === 'user') this.username = String(username || '').trim();
        this.welcome = welcome;

        const wanted = presentation || (this.isOpen() ? this.presentation : 'modal');
        // User pages are deep links (/u/<name>): always the modal
        const mode = next === 'user' || welcome ? 'modal' : wanted;
        if (this.isOpen() && this.presentation !== mode) this.close({ reason: 'switch' });
        if (!this.isOpen()) this.buildModal(mode);
        this.setView(next, { updateUrl: updateUrl && mode === 'modal' });
        return this.modal;
    }

    /**
     * @param {{reason?: 'opened'|'outside'|'toggle'|'switch'}} [opts] - why it closes; Esc and the
     *   Close buttons (no reason) return the focus to the Open button when the popover had it
     */
    close({ reason = null } = {}) {
        this.closeReason = reason;
        this.modal?.close();
    }

    buildModal(presentation = 'modal') {
        const popover = presentation === 'popover';
        this.presentation = presentation;
        // Your own list changes between openings (saves, renames elsewhere): reload it
        this.states.mine = null;
        if (this.api?.isEnabled()) this.api.probeCapabilities();
        const anchor = popover ? document.getElementById('openBtn') : null;
        const returnFocus = document.activeElement;
        this.closeReason = null;
        const m = UIHelpers.createModal({
            kicker: 'Open',
            title: popover ? 'Open' : 'My projects',
            subtitle: '',
            className: `pt-modal--gallery pt-modal--browser${popover ? ' pb-popover' : ''}`,
            onClose: () => {
                if (this.modal === m) this.modal = null;
                this.observer?.disconnect();
                cleanupPopover?.();
                if (popover) {
                    // Transient: the URL never changed. Esc / Close: focus back on the Open button
                    const focusWasInside = !document.activeElement || document.activeElement === document.body || m.modal.contains(document.activeElement);
                    if (focusWasInside && !this.closeReason) (anchor || returnFocus)?.focus?.({ preventScroll: true });
                    this.app.community?.updateMeta();
                } else {
                    // Back to the editor's own URL (/p/<id> for a cloud project, else /)
                    this.app.community?.syncEditorUrl({ push: true });
                }
                this.closeReason = null;
            }
        });
        this.modal = m;
        let cleanupPopover = null;
        if (popover) cleanupPopover = this.setupPopover(m, anchor);

        m.backdrop.addEventListener('keydown', (e) => {
            this.onKeyDown(e);
            e.stopPropagation();
        });

        // Tabs + tools bar between the header and the body
        const bar = h('div', { className: 'pb-bar' });
        const tabs = h('div', { className: 'pb-tabs', role: 'tablist', 'aria-label': 'Browse' });
        this.tabButtons = {};
        for (const t of TABS) {
            const btn = h('button', { type: 'button', className: 'pb-tab', role: 'tab', dataset: { view: t.id }, 'aria-selected': 'false' });
            btn.append(iconNode(t.icon), h('span', { text: t.label }));
            btn.addEventListener('click', () => this.setView(t.id));
            tabs.appendChild(btn);
            this.tabButtons[t.id] = btn;
        }

        const tools = h('div', { className: 'pb-tools' });
        const search = h('div', { className: 'pt-input-group pb-search' });
        search.appendChild(iconNode('search'));
        this.searchInput = h('input', { type: 'search', className: 'pt-input', placeholder: 'Search', spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Search projects' });
        search.appendChild(this.searchInput);
        let timer = null;
        this.searchInput.addEventListener('input', () => {
            clearTimeout(timer);
            timer = setTimeout(() => this.onSearch(this.searchInput.value), this.view === 'community' ? 280 : 60);
        });
        this.sortGroup = h('div', { className: 'pb-seg', role: 'radiogroup', 'aria-label': 'Sort' });
        tools.append(search, this.sortGroup);
        bar.append(tabs, tools);
        m.modal.insertBefore(bar, m.body);

        m.body.classList.add('dg-body', 'pb-body');
        this.userHeader = h('div', { className: 'pb-user', hidden: true });
        this.grid = h('div', { className: 'dg-grid', role: 'group', 'aria-label': 'Projects' });
        this.stateEl = h('div', { className: 'pb-state', hidden: true });
        this.moreEl = h('div', { className: 'pb-more', hidden: true });
        this.sentinel = h('div', { className: 'pb-sentinel', 'aria-hidden': 'true' });
        m.body.append(this.userHeader, this.grid, this.stateEl, this.moreEl, this.sentinel);

        this.observer = new IntersectionObserver((entries) => {
            if (entries.some(e => e.isIntersecting)) this.loadMore();
        }, { root: m.body, rootMargin: '0px 0px 320px 0px' });
        this.observer.observe(this.sentinel);

        // Demo card metadata arrives late: re-apply the demo filter as cards fill in
        this.grid.addEventListener('dg:filled', () => {
            if (this.view === 'demos' && (this.state('demos').q || this.state('demos').sort !== 'featured')) this.applyDemoFilter();
        });

        const hints = h('div', { className: 'dg-hints', 'aria-hidden': 'true' });
        hints.innerHTML = '<kbd>←</kbd><kbd>→</kbd><span>Browse</span><kbd>↵</kbd><span>Open</span><kbd>Esc</kbd><span>Close</span>';
        // Import a .json project (same as ⇧⌘O and the project menu)
        const fileBtn = UIHelpers.button('Open file…', { variant: 'ghost', icon: 'upload', onClick: () => this.openFile() });
        fileBtn.classList.add('pb-file-btn');
        fileBtn.setAttribute('data-tip', 'Import a project file (.json)');
        fileBtn.setAttribute('data-kbd', comboText(['Shift', 'Mod', 'O']));
        // New project (the welcome screen: just close onto the empty canvas)
        this.newBtn = UIHelpers.button('New project', {
            variant: 'primary', icon: 'filePlus', onClick: () => {
                const welcome = this.welcome;
                this.close({ reason: 'opened' });
                if (!welcome) this.app.handleNewProject();
            }
        });
        m.footer.append(hints, h('div', { className: 'pt-spacer' }), fileBtn, this.newBtn);
    }

    /** The load-from-file dialog (hidden #loadFileInput); the browser closes first. */
    openFile() {
        if (this.isOpen()) this.close({ reason: 'opened' });
        document.getElementById('loadFileInput')?.click();
    }

    /**
     * Popover presentation: no backdrop (the host lets clicks through), the dialog anchored
     * under the Open button and clamped to the viewport; outside clicks close it.
     * Returns the cleanup.
     */
    setupPopover(m, anchor) {
        m.backdrop.classList.add('pb-popover-host');
        m.modal.setAttribute('aria-modal', 'false');
        if (anchor) {
            m.modal.setAttribute('aria-label', 'Open a project');
            anchor.classList.add('is-open');
            anchor.setAttribute('aria-expanded', 'true');
        }
        const place = () => {
            const margin = 8;
            const vw = window.innerWidth;
            const vh = window.innerHeight;
            const r = anchor && anchor.offsetParent !== null ? anchor.getBoundingClientRect() : { left: (vw - POPOVER_SIZE.width) / 2, bottom: 48 };
            const width = Math.max(280, Math.min(POPOVER_SIZE.width, vw - margin * 2));
            const top = Math.round(r.bottom + 6);
            const height = Math.max(240, Math.min(POPOVER_SIZE.height, vh - top - margin));
            const left = Math.round(Math.max(margin, Math.min(r.left, vw - width - margin)));
            Object.assign(m.modal.style, { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` });
        };
        place();
        const onPointerDown = (e) => {
            if (!this.isOpen() || this.modal !== m) return;
            const t = e.target;
            if (!(t instanceof Element) || m.modal.contains(t)) return;
            if (anchor && anchor.contains(t)) return; // the button's click toggles it
            // Things opened from the panel or floating above it: card menus, dialogs
            // (confirm, sign-in, JS trust prompt), toasts, tooltips, the onboarding tour
            if (t.closest('.pt-menu, .pt-toasts, .pt-tooltip, .pt-tour-card, .pt-tour-spot, .pt-tour-pointer')) return;
            const host = t.closest('.pt-modal-backdrop');
            if (host && host !== m.backdrop) return;
            this.close({ reason: 'outside' });
        };
        document.addEventListener('pointerdown', onPointerDown, true);
        window.addEventListener('resize', place);
        return () => {
            document.removeEventListener('pointerdown', onPointerDown, true);
            window.removeEventListener('resize', place);
            if (anchor) {
                anchor.classList.remove('is-open');
                anchor.setAttribute('aria-expanded', 'false');
            }
        };
    }

    /** Switch tab / page. */
    setView(view, { updateUrl = true } = {}) {
        // A user page is a deep link: from the popover it opens in the modal (with its URL)
        if (view === 'user' && this.presentation === 'popover' && this.isOpen()) {
            this.open({ view: 'user', username: this.username, presentation: 'modal' });
            return;
        }
        if (this.presentation === 'popover') updateUrl = false;
        const previous = this.view;
        this.view = view;
        for (const [id, btn] of Object.entries(this.tabButtons)) {
            const on = id === view;
            btn.classList.toggle('is-active', on);
            btn.setAttribute('aria-selected', on ? 'true' : 'false');
            btn.tabIndex = on || (view === 'user' && id === 'community') ? 0 : -1;
        }
        const st = this.state(view);
        this.searchInput.value = st.q;
        this.searchInput.placeholder = {
            demos: 'Search demos',
            community: 'Search titles or authors',
            mine: 'Search my projects',
            user: 'Search these projects',
        }[view];
        this.renderSort();

        if (updateUrl) {
            // Tab switches replace the history entry; user pages get their own (back returns)
            const path = view === 'user' ? paths.user(this.username) : paths.explore(view);
            const pageChange = view === 'user' || previous === 'user';
            navigate(path, { silent: true, replace: this.urlIsBrowser() && !pageChange });
        }
        this.render();
        setTimeout(() => this.focusCard(), 0);
    }

    urlIsBrowser() {
        return /^\/(explore|u)(\/|$)/.test(window.location.pathname);
    }

    renderSort() {
        this.sortGroup.innerHTML = '';
        const st = this.state();
        for (const [value, label] of SORTS[this.view]) {
            const b = h('button', { type: 'button', className: `pb-seg-btn${st.sort === value ? ' is-active' : ''}`, role: 'radio', 'aria-checked': st.sort === value ? 'true' : 'false', text: label });
            b.addEventListener('click', () => {
                if (st.sort === value) return;
                st.sort = value;
                this.renderSort();
                if (this.view === 'community') this.reload();
                else this.render();
            });
            this.sortGroup.appendChild(b);
        }
    }

    onSearch(value) {
        const st = this.state();
        const q = value.trim().toLowerCase();
        if (q === st.q) return;
        st.q = q;
        if (this.view === 'community') this.reload();
        else this.render();
    }

    reload() {
        const st = this.state();
        // Supersede a page that is still loading (its response is dropped by the seq check)
        st.seq = (st.seq || 0) + 1;
        st.loading = false;
        st.items = [];
        st.cursor = null;
        st.loaded = false;
        st.error = null;
        this.render();
    }

    /* ------------------------------------------------------------------ */
    /* Rendering                                                          */
    /* ------------------------------------------------------------------ */

    setHeading(kicker, title, subtitle) {
        const m = this.modal;
        if (this.presentation === 'popover') {
            // Compact: the tabs say where you are (the hidden heading still labels the dialog)
            m.titleEl.textContent = 'Open';
            m.subtitleEl.hidden = true;
            return;
        }
        const k = m.modal.querySelector('.pt-modal-kicker');
        if (k) k.textContent = kicker;
        m.titleEl.textContent = title;
        m.subtitleEl.textContent = subtitle || '';
        m.subtitleEl.hidden = !subtitle;
    }

    render() {
        if (!this.isOpen()) return;
        const view = this.view;
        this.grid.innerHTML = '';
        this.grid.classList.remove('is-busy');
        this.userHeader.hidden = view !== 'user';
        this.hideState();
        this.moreEl.hidden = true;

        // The window title follows the modal (a deep link); the popover leaves it alone
        const meta = (m) => { if (this.presentation !== 'popover') setMeta(m); };
        if (view === 'demos') {
            const welcome = this.welcome;
            this.setHeading(welcome ? 'Welcome to PatchToy' : 'Open', welcome ? 'Start from a demo' : 'Demos',
                welcome ? 'Every demo is a live node graph. Open one to see how it is patched, then tweak anything.'
                    : 'Open a demo to see how it is patched. It replaces the graph on the canvas.');
            this.newBtn.setLabel(welcome ? 'Start from scratch' : 'New project');
            meta({ title: 'Demos' });
            this.renderDemos();
            return;
        }
        this.newBtn.setLabel('New project');

        const legacy = this.api.isEnabled() && this.api.isLegacy();
        if (view === 'community') {
            this.setHeading('Open', 'Community', 'Public patches shared by PatchToy users. Opening one never changes the original: saving creates your own copy.');
            meta({ title: 'Community', description: 'Public PatchToy shader patches shared by the community.' });
        } else if (view === 'mine') {
            const user = this.api.getCurrentUser();
            this.setHeading('Open', 'My projects', user
                ? (legacy ? `Your cloud projects as @${user.username}. Share one by link from its menu.` : `Your cloud projects as @${user.username}. Public ones are listed in Community and on your page.`)
                : '');
            meta({ title: 'My projects' });
        } else if (view === 'user') {
            this.setHeading('User', `@${this.username}`, '');
            meta({ title: `@${this.username}`, description: `Public PatchToy patches by @${this.username}.` });
            this.renderUserHeader();
        }

        // Cloud views: availability first
        const openFile = ['Open file…', () => this.openFile()];
        const demos = ['Browse demos', () => this.setView('demos')];
        if (!this.api.isEnabled()) {
            return this.showState({
                icon: 'cloud',
                title: 'The PatchToy cloud isn’t configured',
                message: view === 'mine'
                    ? 'This build has no API, so there are no cloud projects. Your patch is autosaved in this browser; open a .json project file or start from a demo.'
                    : 'This build has no API, so community projects, user pages and cloud saves are unavailable. Demos still work.',
                actions: view === 'mine' ? [openFile, [demos[0], demos[1], 'primary']] : [demos]
            });
        }
        if (view === 'mine' && !this.api.isLoggedIn()) {
            return this.showState({
                icon: 'user',
                title: 'Sign in to see your cloud projects',
                message: 'Your current patch is autosaved in this browser. Sign in to save projects to the cloud, open them anywhere and share them with a link. You can also open a .json project file, or start from a demo.',
                actions: [
                    ['Sign in', () => this.app.community?.signIn(() => this.render()), 'primary'],
                    ['Create account', () => this.app.community?.signIn(() => this.render(), { register: true })],
                    openFile,
                    demos
                ]
            });
        }
        if (legacy && (view === 'community' || view === 'user')) return this.showUnavailable(view);

        const st = this.state();
        if (st.loaded || st.items.length) this.renderCloud();
        if (!st.loaded && !st.loading && !st.error) this.loadMore();
        else if (st.error) this.showError(st.error);
        else if (st.loading) this.renderSkeletons();
    }

    /** 1.x API: no public listing / user pages yet. */
    showUnavailable(view = this.view) {
        this.grid.innerHTML = '';
        this.moreEl.hidden = true;
        if (view === 'user') this.userHeader.hidden = true;
        const signedIn = this.api.isLoggedIn();
        this.showState({
            icon: 'globe',
            title: view === 'user' ? 'User pages aren’t available on this server yet' : 'Community isn’t available on this server yet',
            message: 'This PatchToy server still runs the 1.x backend: projects can be shared by link, but public listings, user pages and publishing to Community arrive with the 2.0 backend deploy.',
            actions: [
                [signedIn ? 'My projects' : 'Sign in', () => (signedIn ? this.setView('mine') : this.app.community?.signIn(() => this.setView('mine'))), signedIn ? '' : 'primary'],
                ['Browse demos', () => this.setView('demos'), signedIn ? 'primary' : '']
            ]
        });
    }

    renderSkeletons(count = 8) {
        for (let i = 0; i < count; i++) {
            const card = h('div', { className: 'dg-card is-pending pb-skeleton', 'aria-hidden': 'true' }, [
                h('span', { className: 'dg-thumb' }),
                h('span', { className: 'dg-info' }, [
                    h('span', { className: 'dg-line' }),
                    h('span', { className: 'dg-line dg-line--short' })
                ])
            ]);
            this.grid.appendChild(card);
        }
    }

    hideState() {
        this.stateEl.hidden = true;
        this.stateEl.innerHTML = '';
    }

    showState({ icon: iconName = 'info', title, message = '', actions = [], tone = '' }) {
        this.grid.querySelectorAll('.pb-skeleton').forEach(n => n.remove());
        this.stateEl.innerHTML = '';
        this.stateEl.className = `pb-state${tone ? ` is-${tone}` : ''}`;
        const mark = h('div', { className: 'pb-state-icon' });
        mark.appendChild(iconNode(iconName, 24));
        this.stateEl.append(mark, h('div', { className: 'pb-state-title', text: title }));
        if (message) this.stateEl.appendChild(h('div', { className: 'pb-state-msg', text: message }));
        if (actions.length) {
            const row = h('div', { className: 'pb-state-actions' });
            for (const [label, onClick, variant] of actions) row.appendChild(UIHelpers.button(label, { variant: variant || '', onClick }));
            this.stateEl.appendChild(row);
        }
        this.stateEl.hidden = false;
    }

    showError(err) {
        const st = this.state();
        if (st.items.length) {
            // Keep what we have; offer a retry where "load more" would be
            this.moreEl.hidden = false;
            this.moreEl.innerHTML = '';
            this.moreEl.append(
                h('span', { className: 'pb-more-error', text: err.message || 'Couldn’t load more' }),
                UIHelpers.button('Retry', { size: 'sm', onClick: () => { st.error = null; this.loadMore(); } })
            );
            return;
        }
        if (err.status === 404 && this.view === 'user') {
            return this.showState({
                icon: 'user',
                title: `There’s no user called @${this.username}`,
                message: 'Check the spelling of the link, or browse the community instead.',
                actions: [['Browse community', () => this.setView('community')]]
            });
        }
        const offline = err.offline || err.status === 0;
        this.showState({
            icon: offline ? 'plug' : 'alert',
            tone: 'error',
            title: offline ? (navigator.onLine === false ? 'You’re offline' : 'Can’t reach the PatchToy cloud') : 'Something went wrong',
            message: offline ? 'Check your connection and try again. Demos and local projects keep working.' : (err.message || 'The server returned an error.'),
            actions: [['Retry', () => { st.error = null; this.render(); }, 'primary']]
        });
    }

    /* ---------------- Demos ---------------- */

    renderDemos() {
        const dg = this.app.demoGallery;
        if (!DEMOS.length || !dg) {
            this.showState({ icon: 'gallery', title: 'No demos found', message: 'Demo patches live in /projects.' });
            return;
        }
        // Cards are rebuilt per render (cheap: project files are cached for the session)
        this.demoCards = dg.buildDemoCards(this.grid);
        for (const card of this.demoCards) this.grid.appendChild(card);
        this.applyDemoFilter();
    }

    applyDemoFilter() {
        const st = this.state('demos');
        const cards = this.demoCards || [];
        let shown = 0;
        for (const card of cards) {
            const hay = card.dataset.search || card.dataset.name || '';
            const match = !st.q || hay.includes(st.q);
            card.hidden = !match;
            if (match) shown++;
        }
        const ordered = st.sort === 'az'
            ? [...cards].sort((a, b) => (a.dataset.name || '').localeCompare(b.dataset.name || ''))
            : cards;
        for (const card of ordered) this.grid.appendChild(card);
        if (!shown) {
            this.showState({ icon: 'search', title: `No demos match “${st.q}”`, actions: [['Clear search', () => this.clearSearch()]] });
        } else {
            this.hideState();
        }
    }

    clearSearch() {
        this.searchInput.value = '';
        this.onSearch('');
        this.searchInput.focus();
    }

    /* ---------------- Cloud lists ---------------- */

    async loadMore() {
        const view = this.view;
        if (!this.isOpen() || view === 'demos' || !this.api.isEnabled()) return;
        if (view === 'mine' && !this.api.isLoggedIn()) return;
        if (view !== 'mine' && this.api.isLegacy()) return; // 1.x: no public feed / user pages
        const st = this.state(view);
        if (st.loading || st.error || (st.loaded && !st.cursor)) return;

        const seq = ++st.seq;
        const first = !st.loaded;
        st.loading = true;
        if (first) {
            this.grid.innerHTML = '';
            this.renderSkeletons();
        } else {
            this.moreEl.hidden = false;
            this.moreEl.innerHTML = '';
            this.moreEl.append(h('span', { className: 'dg-spinner' }), h('span', { text: 'Loading more…' }));
        }

        try {
            let items = [];
            let cursor = null;
            if (view === 'community') {
                const res = await this.api.listPublicProjects({ sort: st.sort, q: st.q, cursor: st.cursor, limit: PAGE_SIZE });
                items = res.projects || [];
                cursor = res.cursor || null;
            } else if (view === 'mine') {
                const res = await this.api.listProjects();
                items = res.projects || [];
            } else if (view === 'user') {
                const res = await this.api.getUser(this.username, { cursor: st.cursor });
                items = res.projects || [];
                cursor = res.cursor || null;
                st.user = res.user || null;
                this.adoptUserSpelling(st);
            }
            if (seq !== st.seq || this.states[view] !== st) return; // superseded (search / sort changed)
            const known = new Set(st.items.map(p => p.id));
            st.items.push(...items.filter(p => !known.has(p.id)));
            st.cursor = cursor;
            st.loaded = true;
            st.error = null;
        } catch (err) {
            if (seq !== st.seq) return;
            // 1.x API: /api/projects/public is "Project not found"; /api/users/* doesn't exist
            if (view === 'community' && err.status === 404) this.api.markLegacy();
            st.error = err;
        } finally {
            if (seq === st.seq) st.loading = false;
        }
        if (!this.isOpen() || this.view !== view || this.states[view] !== st) return;
        if (view === 'user') this.renderUserHeader();
        this.moreEl.hidden = true;
        if (st.error) {
            this.grid.querySelectorAll('.pb-skeleton').forEach(n => n.remove());
            if ((view === 'community' || view === 'user') && this.api.isLegacy()) {
                st.error = null;
                return this.showUnavailable(view);
            }
            this.showError(st.error);
            return;
        }
        this.renderCloud();
        if (first) setTimeout(() => this.focusCard(), 0);
        // Fill the viewport: keep paging while the sentinel is visible
        if (st.cursor) requestAnimationFrame(() => this.checkSentinel());
    }

    checkSentinel() {
        if (!this.isOpen()) return;
        const body = this.modal.body.getBoundingClientRect();
        const s = this.sentinel.getBoundingClientRect();
        if (s.top < body.bottom + 320) this.loadMore();
    }

    /** Items of the current view after client-side search and sort. */
    visibleItems() {
        const st = this.state();
        let items = st.items.slice();
        if (this.view !== 'community' && st.q) {
            items = items.filter(p => `${p.name} ${p.description || ''} ${p.username || ''}`.toLowerCase().includes(st.q));
        }
        const byDate = (a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0);
        if (this.view === 'mine') {
            if (st.sort === 'name') items.sort((a, b) => a.name.localeCompare(b.name));
            else if (st.sort === 'views') items.sort((a, b) => (b.views || 0) - (a.views || 0) || byDate(a, b));
            else items.sort(byDate);
        } else if (this.view === 'user') {
            if (st.sort === 'popular') items.sort((a, b) => (b.views || 0) - (a.views || 0) || byDate(a, b));
            else items.sort(byDate);
        }
        return items;
    }

    renderCloud() {
        const st = this.state();
        const items = this.visibleItems();
        const focusedId = document.activeElement?.closest?.('.pb-card')?.dataset.id;
        this.grid.innerHTML = '';
        this.hideState();
        const currentId = this.app.projectManager?.projectState?.projectId;
        for (const p of items) {
            const card = this.buildCloudCard(p, { isCurrent: p.id === currentId });
            this.grid.appendChild(card);
        }
        if (focusedId) this.grid.querySelector(`.pb-card[data-id="${CSS.escape(focusedId)}"]`)?.focus({ preventScroll: true });

        if (!items.length) {
            if (st.q) {
                this.showState({
                    icon: 'search',
                    title: `No projects match “${st.q}”`,
                    message: this.view === 'community' ? 'Search looks at project titles and author names.' : '',
                    actions: [['Clear search', () => this.clearSearch()]]
                });
            } else if (this.view === 'community') {
                this.showState({
                    icon: 'globe',
                    title: 'No public projects yet',
                    message: 'Be the first: save a patch to the cloud, then publish it to Community from My projects.',
                    actions: [['My projects', () => this.setView('mine')]]
                });
            } else if (this.view === 'mine') {
                this.showState({
                    icon: 'cloud',
                    title: 'No cloud projects yet',
                    message: 'Save the patch on the canvas with ⌘S (Ctrl+S) and it shows up here.',
                    actions: [['Save current patch', () => { this.close({ reason: 'opened' }); this.app.saveProject(); }, 'primary'], ['Open file…', () => this.openFile()]]
                });
            } else if (this.view === 'user') {
                const self = sameUsername(this.api.getCurrentUser()?.username, this.username);
                this.showState({
                    icon: 'gallery',
                    title: self ? 'You haven’t shared any projects yet' : `@${this.username} hasn’t shared any projects yet`,
                    message: self ? 'Make a project public from My projects to list it here.' : '',
                    actions: self ? [['My projects', () => this.setView('mine')]] : []
                });
            }
        }
        if (st.cursor && !st.loading) {
            this.moreEl.hidden = false;
            this.moreEl.innerHTML = '';
            this.moreEl.appendChild(UIHelpers.button('Load more', { size: 'sm', onClick: () => this.loadMore() }));
        }
    }

    /* ---------------- User page header ---------------- */

    renderUserHeader() {
        const st = this.state('user');
        const u = st.user;
        const name = this.username;
        const el = this.userHeader;
        el.innerHTML = '';
        el.hidden = false;

        const back = h('button', { type: 'button', className: 'pb-back' });
        back.append(iconNode('chevronRight'), h('span', { text: 'Community' }));
        back.addEventListener('click', () => this.setView('community'));

        const av = h('div', { className: 'pb-avatar', text: initials(u?.displayName || name), 'aria-hidden': 'true' });
        av.style.setProperty('--avatar-bg', avatarColor(name));

        const info = h('div', { className: 'pb-user-info' });
        info.appendChild(h('div', { className: 'pb-user-name', text: u?.displayName || `@${name}` }));
        const meta = h('div', { className: 'pb-user-meta' });
        if (u?.displayName) meta.appendChild(h('span', { className: 'pb-user-handle', text: `@${name}` }));
        if (u?.createdAt) meta.appendChild(h('span', { text: `Joined ${new Date(u.createdAt).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })}` }));
        if (st.loaded) {
            const n = st.items.length;
            meta.appendChild(h('span', { text: `${n}${st.cursor ? '+' : ''} public project${n === 1 ? '' : 's'}` }));
            const views = st.items.reduce((s, p) => s + (p.views || 0), 0);
            if (views) meta.appendChild(h('span', { text: `${compact(views)} view${views === 1 ? '' : 's'}` }));
        }
        info.appendChild(meta);

        const actions = h('div', { className: 'pb-user-actions' });
        const copy = UIHelpers.button('Copy page link', { size: 'sm', icon: 'link' });
        copy.addEventListener('click', () => this.app.community?.copyText(userPageUrl(name), copy));
        actions.appendChild(copy);
        if (sameUsername(this.api.getCurrentUser()?.username, name)) {
            actions.appendChild(UIHelpers.button('Edit profile', { size: 'sm', icon: 'pencil', onClick: () => this.app.community?.showProfileDialog() }));
        }

        el.append(back, h('div', { className: 'pb-user-row' }, [av, info, actions]));
        // The owner's spelling, whatever case the link used
        this.setHeading('User', u?.displayName || `@${name}`, '');
        if (u?.displayName) setMeta({ title: `${u.displayName} (@${name})`, description: `Public PatchToy patches by @${name}.` });
    }

    /* ---------------- Cards ---------------- */

    buildCloudCard(p, { isCurrent = false } = {}) {
        const mine = this.view === 'mine';
        const card = h('div', {
            className: `dg-card pb-card${isCurrent ? ' is-current' : ''}`,
            tabindex: '0',
            role: 'button',
            dataset: { id: p.id },
            'aria-label': `${p.name}${p.username && !mine ? ` by @${p.username}` : ''}${isCurrent ? '. Currently open.' : ''}`
        });

        const thumb = h('span', { className: 'dg-thumb' });
        const placeholder = () => {
            thumb.classList.add('is-placeholder', 'is-loaded');
            thumb.style.setProperty('--dg-tint', hashColor(p.id));
            thumb.querySelector('.dg-img')?.remove();
            if (!thumb.querySelector('.dg-mark')) thumb.prepend(h('span', { className: 'dg-mark', text: initialsOf(p.name) }));
        };
        if (p.thumbUrl) {
            const img = h('img', { className: 'dg-img', alt: '', loading: 'lazy', decoding: 'async', draggable: 'false', referrerPolicy: 'no-referrer' });
            img.addEventListener('load', () => thumb.classList.add('is-loaded'), { once: true });
            img.addEventListener('error', placeholder, { once: true });
            img.src = p.thumbUrl;
            thumb.appendChild(img);
        } else {
            placeholder();
        }
        thumb.appendChild(h('span', { className: 'dg-open', html: `<span>Open</span>${icon('chevronRight')}` }));
        thumb.appendChild(h('span', { className: 'dg-busy', html: '<span class="dg-spinner"></span><span>Opening…</span>' }));
        if (isCurrent) thumb.appendChild(h('span', { className: 'pt-badge dg-current', text: 'Open now' }));
        if (mine && visibilityKnown(p)) {
            const v = visibilityOf(p);
            const vis = h('span', { className: `pt-badge pb-vis ${v === 'private' ? 'is-private' : 'is-public'} is-${v}` });
            vis.append(iconNode(VISIBILITY_LABELS[v].icon, 12), h('span', { text: VISIBILITY_LABELS[v].label }));
            thumb.appendChild(vis);
        }

        // Card actions (top right of the thumbnail)
        const menuBtn = h('button', { type: 'button', className: 'pt-icon-btn pt-icon-btn--sm pb-card-menu', 'aria-label': `Options for ${p.name}`, 'data-tip': 'Options' });
        menuBtn.appendChild(iconNode('more'));
        menuBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.showCardMenu(p, menuBtn, card);
        });
        menuBtn.addEventListener('keydown', (e) => e.stopPropagation());
        thumb.appendChild(menuBtn);

        const info = h('span', { className: 'dg-info' });
        info.appendChild(h('span', { className: 'dg-name', text: p.name, title: p.name }));

        const desc = h('span', { className: 'dg-desc' });
        if (p.forkedFrom && p.forkedFrom.id) {
            desc.classList.add('pb-fork');
            desc.append(iconNode('fork', 12), document.createTextNode('Forked from '));
            const a = this.userLink(p.forkedFrom.username);
            desc.appendChild(a);
            desc.title = `Forked from “${p.forkedFrom.name}” by @${p.forkedFrom.username}`;
        } else {
            desc.textContent = firstSentence(p.description) || (mine
                ? (visibilityKnown(p) ? ({ public: 'Listed in Community', unlisted: 'Anyone with the link can open it', private: 'Only you can open it' }[visibilityOf(p)]) : 'Saved in the cloud')
                : 'A PatchToy patch');
            if (p.description) desc.title = p.description;
        }
        info.appendChild(desc);

        const meta = h('span', { className: 'dg-meta' });
        if (!mine && this.view !== 'user' && p.username) {
            meta.appendChild(this.userLink(p.username, { avatar: true }));
            meta.appendChild(h('span', { className: 'dg-dot', 'aria-hidden': 'true' }));
        }
        const stat = (iconName, value, label) => {
            const s = h('span', { className: 'pb-stat', title: label });
            s.append(iconNode(iconName, 12), h('span', { text: compact(value) }));
            return s;
        };
        if (p.views !== undefined || !this.api.isLegacy()) meta.appendChild(stat('eye', p.views || 0, `${p.views || 0} view${p.views === 1 ? '' : 's'}`)); // 1.x: no views
        if (p.forks) meta.appendChild(stat('fork', p.forks, `${p.forks} forks`));
        meta.appendChild(h('span', { className: 'pb-date', text: relativeDate(p.updatedAt), title: new Date(p.updatedAt).toLocaleString() }));
        if (p.hasJS) meta.appendChild(h('span', { className: 'pt-badge dg-tag pb-js', text: 'JS', title: 'Contains JavaScript nodes (asks before running them)' }));
        info.appendChild(meta);

        card.append(thumb, info);
        const open = () => this.openProject(p, card);
        card.addEventListener('click', (e) => {
            if (e.target.closest('a, button')) return;
            open();
        });
        card.addEventListener('keydown', (e) => {
            if ((e.key === 'Enter' || e.key === ' ') && e.target === card) {
                e.preventDefault();
                open();
            }
        });
        return card;
    }

    /** @username link to a user page (in-app navigation). */
    userLink(username, { avatar = false } = {}) {
        const a = h('a', { className: 'pb-author', href: paths.user(username), 'data-tip': `@${username}’s page` });
        if (avatar) {
            const dot = h('span', { className: 'pb-author-av', text: (username || '?')[0].toUpperCase(), 'aria-hidden': 'true' });
            dot.style.setProperty('--avatar-bg', avatarColor(username));
            a.appendChild(dot);
        }
        a.appendChild(h('span', { text: `@${username}` }));
        a.addEventListener('click', (e) => {
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) return; // new tab
            e.preventDefault();
            e.stopPropagation();
            this.openUser(username);
        });
        a.addEventListener('keydown', (e) => e.stopPropagation());
        return a;
    }

    openUser(username) {
        this.username = String(username).trim();
        this.setView('user');
    }

    /**
     * The page was opened as typed (/u/sirkitboi): show the owner's spelling (@SirKitBoi)
     * once the API answered, and put it in the address bar.
     */
    adoptUserSpelling(st) {
        const shown = st.user?.username;
        if (!shown || shown === this.username || !sameUsername(shown, this.username)) return;
        if (this.states.user !== st) return;
        this.username = shown;
        st.username = shown;
        if (this.isOpen() && this.view === 'user' && /^\/u\/[^/]+\/?$/.test(window.location.pathname)) {
            navigate(paths.user(shown), { silent: true, replace: true });
        }
    }

    async openProject(p, card) {
        if (this.busy) return;
        this.busy = true;
        card.classList.add('is-loading');
        this.grid.classList.add('is-busy');
        try {
            const via = this.view === 'mine' ? 'mine' : this.view === 'user' ? 'user' : 'community';
            const ok = await this.app.community.openCloudProject(p.id, { via });
            if (ok) this.close({ reason: 'opened' });
            else card.focus();
        } finally {
            this.busy = false;
            card.classList.remove('is-loading');
            this.grid?.classList.remove('is-busy');
        }
    }

    showCardMenu(p, anchor, card) {
        const community = this.app.community;
        const own = this.api.getCurrentUser()?.userId && this.view === 'mine';
        anchor.classList.add('is-active');
        const items = [
            { icon: 'chevronRight', label: 'Open', onClick: () => this.openProject(p, card) },
            { icon: 'link', label: 'Copy link', onClick: () => community.copyShareLink(p, { onChange: () => this.refreshItem(p) }) },
        ];
        if (!own && p.username) items.push({ icon: 'user', label: `@${p.username}’s page`, onClick: () => this.openUser(p.username) });
        if (own) {
            // 1.x API: link sharing only (its isPublic); publishing waits for the 2.0 backend.
            // Its list doesn't say which state a project is in, so both choices are offered.
            const legacy = this.api.isLegacy();
            const current = visibilityKnown(p) ? visibilityOf(p) : null;
            items.push(
                // Link sharing and publishing to Community are separate states
                ...[
                    legacy
                        ? { v: 'public', icon: 'globe', label: 'Publish to Community', hint: 'Needs 2.0', disabled: true }
                        : { v: 'public', icon: 'globe', label: 'Publish to Community', hint: 'List it in Community and on your page' },
                    { v: 'unlisted', icon: 'link', label: current === 'public' ? 'Unlist (link only)' : (legacy ? 'Share by link' : 'Share by link only'), hint: legacy ? 'Anyone with the link can open it' : 'Anyone with the link, not listed' },
                    { v: 'private', icon: 'lock', label: 'Make private', hint: 'Only you can open it' }
                ].filter(o => o.v !== current).map(o => ({
                    icon: o.icon, label: o.label, hint: o.hint, disabled: o.disabled,
                    onClick: () => community.setVisibility(p, o.v).then(() => this.refreshItem(p))
                })),
                { icon: 'pencil', label: 'Rename…', onClick: () => community.renameProject(p).then(() => this.refreshItem(p)) },
                { icon: 'download', label: 'Download .json', onClick: () => community.downloadProject(p) },
                { separator: true },
                {
                    icon: 'trash', label: 'Delete', danger: true, onClick: async () => {
                        const deleted = await community.deleteProject(p);
                        if (deleted) {
                            const st = this.state('mine');
                            st.items = st.items.filter(x => x.id !== p.id);
                            this.renderCloud();
                        }
                    }
                }
            );
        }
        const menu = UIHelpers.openMenu({ anchor, align: 'end', className: 'pb-menu', items, onClose: () => anchor.classList.remove('is-active') });
        // Why "Publish to Community" is greyed out (1.x API)
        for (const b of menu.el.querySelectorAll('.pt-menu-item:disabled')) {
            if (b.textContent.includes('Publish')) {
                b.setAttribute('data-tip', NEEDS_V2);
                b.title = NEEDS_V2;
                b.classList.add('pb-needs-v2');
            }
        }
    }

    /** Re-render after an item changed in place (visibility, name). */
    refreshItem() {
        if (!this.isOpen()) return;
        // Community / user lists are cached per session: drop them, they show public projects only
        if (this.view !== 'community') this.states.community = null;
        if (this.view !== 'user') this.states.user = null;
        this.renderCloud();
    }

    /* ------------------------------------------------------------------ */
    /* Keyboard                                                           */
    /* ------------------------------------------------------------------ */

    cards() {
        return this.grid ? [...this.grid.querySelectorAll('.dg-card:not(:disabled):not(.is-pending):not([hidden])')] : [];
    }

    focusCard(index = null) {
        const cards = this.cards();
        if (!cards.length) return;
        const target = index !== null ? cards[index] : (cards.find(c => c.classList.contains('is-current')) || cards[0]);
        target?.focus({ preventScroll: true });
        target?.scrollIntoView({ block: 'nearest' });
    }

    onKeyDown(e) {
        if (!this.isOpen() || e.metaKey || e.ctrlKey || e.altKey) return;

        if (e.key === 'Tab') {
            const focusables = [...this.modal.modal.querySelectorAll('button:not(:disabled):not([tabindex="-1"]), [href], input, [tabindex="0"]')]
                .filter(el => el.offsetParent !== null);
            if (!focusables.length) return;
            const first = focusables[0];
            const last = focusables[focusables.length - 1];
            if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
            else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
            return;
        }

        // Tabs: left / right move between them
        const tab = e.target.closest?.('.pb-tab');
        if (tab && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
            e.preventDefault();
            const ids = TABS.map(t => t.id);
            const i = ids.indexOf(tab.dataset.view);
            const next = ids[(i + (e.key === 'ArrowRight' ? 1 : ids.length - 1)) % ids.length];
            this.setView(next);
            this.tabButtons[next].focus();
            return;
        }
        if (e.target === this.searchInput) {
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                this.focusCard();
            }
            return;
        }
        if (e.target.closest?.('.pb-tools, .pb-user, .pb-state, .pb-more')) return;

        const nav = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'];
        if (!nav.includes(e.key)) {
            if (e.key === '/') {
                e.preventDefault();
                this.searchInput.focus();
                return;
            }
            // Type to search
            if (e.key.length === 1 && /\S/.test(e.key) && e.target.closest?.('.dg-card')) {
                this.searchInput.focus();
            }
            return;
        }
        const cards = this.cards();
        if (!cards.length) return;
        e.preventDefault();

        const i = cards.indexOf(document.activeElement.closest?.('.dg-card'));
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
                if (i + cols <= last) next = i + cols;
                else if (Math.floor(i / cols) < Math.floor(last / cols)) next = last;
                break;
            case 'ArrowUp': next = i - cols >= 0 ? i - cols : i; break;
            case 'Home': next = 0; break;
            case 'End': next = last; break;
        }
        this.focusCard(next);
    }
}
