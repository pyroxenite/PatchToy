import { UIHelpers, h } from '../ui/UIHelpers.js';
import { AuthDialogs } from '../ui/AuthDialogs.js';
import { FloatingCodeEditor } from '../ui/FloatingCodeEditor.js';
import { fitGraphToView, mainPreview } from '../ui/DemoGallery.js';
import { parseRoute, navigate, onRouteChange, paths, projectShareUrl, setMeta, takeVerifyToken, sameUsername, USERNAME_RE, USERNAME_RULE } from '../core/router.js';
import { captureThumbnail } from '../services/thumbnail.js';
import { icon } from '../ui/icons.js';
import { visibilityOf } from './ProjectManager.js';

/** Labels of the three visibility states (security review H4: link sharing is not publishing). */
/** Why "Publish to Community" is unavailable on a 1.x API (ApiClient.isLegacy()). */
export const NEEDS_V2_BACKEND = 'Available after the 2.0 backend deploy';

export const VISIBILITY_LABELS = {
    private: { label: 'Private', icon: 'lock', sub: 'Only you can open it.' },
    unlisted: { label: 'Link only', icon: 'link', sub: 'Anyone with the link can open it. Not listed in Community or on your page.' },
    public: { label: 'Public', icon: 'globe', sub: 'Listed in Community and on your page. Anyone can open it.' },
};

/**
 * Community features glue: share links (/p/<id>), user pages (/u/<name>),
 * opening someone else's project (read-only until you save a copy = fork),
 * thumbnails on cloud save, visibility / rename / delete of your projects,
 * and the profile (username / display name).
 */
export class CommunityManager {
    constructor(app) {
        this.app = app;
        this.routing = false;
        this.banner = null;
        this.thumbTimer = null;

        onRouteChange((route) => this.onRoute(route));
        // 1.x or 2.0 backend? (labels "Publish to Community", the account menu, user pages).
        // One small GET after the start-up requests, for signed-in users (the project browser
        // and the share dialogs probe on their own); a 1.x API answers it with a 404
        const probe = () => { if (this.api?.isEnabled() && this.api.isLoggedIn()) this.api.probeCapabilities(); };
        setTimeout(probe, 1500);
        window.addEventListener('patchtoy:auth', (e) => { if (e.detail?.signedIn) probe(); });
        window.addEventListener('patchtoy:project-state', () => this.updateChrome());
        // A sign-up link opened in a tab that already runs the app (fragment change only)
        window.addEventListener('patchtoy:verify-link', (e) => {
            if (e.detail?.token && this.api.isEnabled()) this.completeSignup(e.detail.token);
        });
        window.addEventListener('patchtoy:auth', () => {
            this.updateChrome();
            UIHelpers.updateAccountButton(this.api);
        });
        // A revoked / expired session (password reset or username change elsewhere): say so, offer sign-in
        window.addEventListener('patchtoy:session-expired', () => {
            if (this._expiredToast) return;
            this._expiredToast = true;
            setTimeout(() => { this._expiredToast = false; }, 4000);
            UIHelpers.toast('You were signed out (your password or username changed, or the session expired). Your patch is still here.', 'warning', {
                title: 'Session expired',
                duration: 10000,
                action: { label: 'Sign in', onClick: () => this.signIn() }
            });
        });
    }

    get api() {
        return this.app.apiClient;
    }

    get pm() {
        return this.app.projectManager;
    }

    /* ------------------------------------------------------------------ */
    /* Routing                                                            */
    /* ------------------------------------------------------------------ */

    /**
     * Startup: act on the URL. Returns true when it handled initialisation
     * (main.js then skips its default project restore).
     */
    async handleInitialRoute() {
        // Sign-up link (/#verify=<token>, already removed from the URL by the router):
        // finish the sign-up in the background while the requested route loads as usual
        const verifyToken = takeVerifyToken();
        if (verifyToken && this.api.isEnabled()) this.completeSignup(verifyToken);

        const route = parseRoute();
        if (route.name === 'project') {
            // Reload of a cloud project with unsaved edits: keep the edits (offer to revert)
            if (this.restoreDirtyAutosave(route.id)) return true;
            this.stashLocalPatch();
            if (!this.api.isEnabled()) {
                this.app.initDefaultProject();
                UIHelpers.notify('This build has no cloud API, so shared projects can’t be opened.', 'warning', { title: 'Can’t open the shared project' });
                navigate(paths.home(), { replace: true, silent: true });
                return true;
            }
            const ok = await this.openCloudProject(route.id, { via: 'link', initial: true });
            if (!ok) {
                this.app.initDefaultProject();
                this.syncEditorUrl();
                this.stashed = null;
            } else if (this.stashed) {
                this.offerStashRestore();
            }
            return true;
        }
        if (route.name === 'user' || route.name === 'explore') {
            this.app.initDefaultProject();
            this.app.projectBrowser.open(route.name === 'user'
                ? { view: 'user', username: route.username, updateUrl: false }
                : { view: route.tab || undefined, updateUrl: false });
            return true;
        }
        return false;
    }

    /**
     * Opening a share link replaces the autosaved patch. If that patch was local-only
     * (never saved to the cloud), keep a copy so it can be restored.
     */
    stashLocalPatch() {
        this.stashed = null;
        try {
            const raw = localStorage.getItem('patchtoy_graph');
            if (!raw) return;
            const data = JSON.parse(raw);
            const nodes = data?.graph?.nodes || data?.nodes || [];
            const ps = data?.projectState;
            const source = ps?.source;
            if (nodes.length && source === 'cloud' && ps.projectId && ps.isDirty) {
                // Unsaved edits to another cloud project: keep them as its local copy, which
                // loadCloudProject prefers when it is newer than the cloud version
                this.pm.saveLocalProjectCopy(ps.projectId, data);
                return;
            }
            if (!nodes.length || source === 'cloud') return; // cloud projects can be reopened
            localStorage.setItem('patchtoy_graph_before_link', raw);
            this.stashed = { title: data.projectTitle || 'Untitled Project' };
        } catch (e) {
            this.stashed = null;
        }
    }

    /**
     * The autosave is project `id` with unsaved edits (a reload of /p/<id>): restore it
     * instead of the cloud copy, and offer "Revert to saved".
     */
    restoreDirtyAutosave(id) {
        let data = null;
        try {
            data = JSON.parse(localStorage.getItem('patchtoy_graph') || 'null');
        } catch (e) {
            return false;
        }
        const ps = data?.projectState;
        if (!ps || ps.source !== 'cloud' || ps.projectId !== id || !ps.isDirty || !data.graph?.nodes?.length) return false;
        this.app.initDefaultProject();
        if (this.pm.projectState?.projectId !== id) return false;
        navigate(paths.project(id), { replace: true, silent: true });
        this.updateMeta();
        this.updateChrome();
        setTimeout(() => {
            UIHelpers.toast('Your unsaved changes to this project were restored from this browser.', 'info', {
                title: `“${this.pm.projectTitle}” has unsaved changes`,
                duration: 10000,
                action: {
                    label: 'Revert to saved',
                    onClick: async () => {
                        const ok = await UIHelpers.confirm({
                            title: 'Revert to the saved version?',
                            message: 'Your unsaved changes in this browser are discarded and the last saved version opens.',
                            confirmLabel: 'Revert',
                            danger: true
                        });
                        if (!ok) return;
                        try { localStorage.removeItem(`patchtoy_project_${id}`); } catch (e) { /* ignore */ }
                        this.pm.markClean();
                        this.openCloudProject(id, { via: 'link', initial: true });
                    }
                }
            });
        }, 600);
        return true;
    }

    offerStashRestore() {
        const { title } = this.stashed;
        setTimeout(() => {
            UIHelpers.toast('It was only saved in this browser, so a copy was kept.', 'info', {
                title: `Your previous patch “${title}” was replaced`,
                duration: 12000,
                action: {
                    label: 'Restore it',
                    onClick: () => {
                        const raw = localStorage.getItem('patchtoy_graph_before_link');
                        if (!raw) return;
                        localStorage.setItem('patchtoy_graph', raw);
                        localStorage.removeItem('patchtoy_graph_before_link');
                        window.location.assign(paths.home());
                    }
                }
            });
        }, 1200);
    }

    /** Back / forward. */
    async onRoute(route) {
        const browser = this.app.projectBrowser;
        this.routing = true;
        try {
            if (route.name === 'user') {
                browser.open({ view: 'user', username: route.username, updateUrl: false });
            } else if (route.name === 'explore') {
                browser.open({ view: route.tab || undefined, updateUrl: false });
            } else {
                if (browser.isOpen()) browser.close();
                if (route.name === 'project' && route.id !== this.pm.projectState?.projectId) {
                    const ok = await this.openCloudProject(route.id, { via: 'link' });
                    if (!ok) this.syncEditorUrl();
                }
            }
        } finally {
            this.routing = false;
        }
    }

    /** The URL of what the editor shows: /p/<id> for a cloud project, else /. */
    editorPath() {
        const ps = this.pm.projectState;
        return ps?.source === 'cloud' && ps.projectId ? paths.project(ps.projectId) : paths.home();
    }

    syncEditorUrl({ push = false } = {}) {
        if (this.routing) return;
        navigate(this.editorPath(), { replace: !push, silent: true });
        this.updateMeta();
    }

    /** Window title while the browser is open or a cloud project is shown (AppShell asks every sync). */
    documentTitle() {
        if (this.app.projectBrowser?.isOpen()) return document.title;
        const ps = this.pm.projectState;
        if (ps?.source === 'cloud' && ps.projectId && ps.ownerUsername && !ps.isOwner) {
            return `${this.pm.projectTitle} by @${ps.ownerUsername} · PatchToy`;
        }
        return null;
    }

    updateMeta() {
        if (this.app.projectBrowser?.isOpen()) return;
        const ps = this.pm.projectState;
        if (ps?.source === 'cloud' && ps.projectId) {
            const by = ps.ownerUsername ? ` by @${ps.ownerUsername}` : '';
            setMeta({ title: `${this.pm.projectTitle}${by}`, description: ps.description || null, image: ps.thumbUrl || null });
        } else {
            setMeta({});
        }
    }

    /* ------------------------------------------------------------------ */
    /* Opening cloud projects                                             */
    /* ------------------------------------------------------------------ */

    /**
     * Open a cloud project by id (share link, community card, user page, my projects).
     * Someone else's project opens as a view: edits stay in this browser and saving
     * creates your own copy. JS nodes in it pause until allowed (jsRuntime trust prompt).
     * @returns {Promise<boolean>}
     */
    async openCloudProject(projectId, { via = 'link', initial = false } = {}) {
        const app = this.app;
        const pm = this.pm;

        if (!initial && app.nodeGraph.nodes.length > 0 && pm.projectState?.isDirty && pm.projectState?.projectId !== projectId) {
            const cloud = pm.projectState.source === 'cloud' && pm.projectState.projectId;
            if (!cloud) {
                const ok = await UIHelpers.confirm({
                    title: 'Replace the current patch?',
                    message: `“${pm.projectTitle}” is only autosaved in this browser, and opening this project replaces it. Download or save it first to keep a copy.`,
                    confirmLabel: 'Open project'
                });
                if (!ok) return false;
            }
        }

        FloatingCodeEditor.closeAll();
        let result;
        try {
            // Its custom nodes stay scoped to it (never written to your library)
            result = await pm.loadCloudProject(projectId, (name, glsl) => app.createCustomNode(name, glsl, true, { scope: 'project' }), { throwErrors: true });
        } catch (err) {
            this.reportOpenError(err);
            return false;
        }
        if (!result || !result.success) return false;

        if (result.editorStates && result.editorStates.length > 0) {
            FloatingCodeEditor.restoreAllStates(result.editorStates, app.nodeGraph.nodes);
        }

        const ps = pm.projectState;
        const graph = app.nodeGraph;
        if (!ps.isOwner) {
            // Show it like a demo: main Preview full-bleed behind the graph, graph fitted
            const preview = mainPreview(graph);
            if (preview && !graph.nodes.some(n => n.isPreviewNode && n.isBackground) && typeof graph.onPreviewBackground === 'function') {
                graph.onPreviewBackground(preview);
            }
            fitGraphToView(graph);
            if (ps.isPublic) this.api.recordView(projectId);
        }
        app.compilationManager.scheduleCompile();
        if (app.compilationManager.autoCompile === false) app.compilationManager.compile();
        graph.render();
        pm.saveGraph();
        UIHelpers.updateAccountButton(this.api);

        navigate(paths.project(projectId), { replace: initial || via === 'link', silent: true });
        this.updateMeta();
        this.updateChrome();

        if (!ps.isOwner) {
            app.offerKeepCustomNodes?.();
            // The viewing banner (updateChrome) explains the read-only mode and offers "Save a copy"
            app.shell?.activity(`Opened “${pm.projectTitle}” by @${ps.ownerUsername} · changes stay in this browser until you save a copy`, { local: true });
        } else {
            app.shell?.activity(`Opened “${pm.projectTitle}”`, { local: true });
        }
        return true;
    }

    reportOpenError(err) {
        if (err?.status === 404) {
            const signedIn = this.api.isLoggedIn();
            UIHelpers.notify(
                signedIn
                    ? 'Its owner may have made it private or deleted it. Private projects can only be opened by their owner.'
                    : 'Its owner may have made it private or deleted it. If it’s yours, sign in to open it.',
                'warning',
                {
                    title: 'This project is private or doesn’t exist',
                    duration: 9000,
                    action: signedIn ? { label: 'Browse community', onClick: () => this.app.projectBrowser.open({ view: 'community' }) }
                        : { label: 'Sign in', onClick: () => this.signIn(() => this.onRoute(parseRoute())) }
                }
            );
        } else if (err?.offline || err?.status === 0) {
            UIHelpers.notify('Check your connection and reload to try again.', 'error', { title: 'Can’t reach the PatchToy cloud' });
        } else {
            UIHelpers.notify(err?.message || 'Unknown error', 'error', { title: 'Failed to load project' });
        }
    }

    /* ------------------------------------------------------------------ */
    /* Chrome: viewing banner + save button                               */
    /* ------------------------------------------------------------------ */

    isViewingOthers() {
        const ps = this.pm.projectState;
        return !!(ps && ps.source === 'cloud' && ps.projectId && !ps.isOwner);
    }

    updateChrome() {
        const viewing = this.isViewingOthers();
        const ps = this.pm.projectState;
        const saveBtn = document.getElementById('saveCloudBtn');
        const label = saveBtn?.querySelector('.tb-btn-label');
        if (label && !this.app._saving) label.textContent = viewing ? 'Save a copy' : 'Save';
        if (saveBtn && viewing) {
            saveBtn.setAttribute('data-tip', this.api.isLoggedIn() ? 'Save your own copy (fork)' : 'Sign in to save your own copy');
        }

        if (!viewing) {
            this.banner?.remove();
            this.banner = null;
            return;
        }
        if (!this.banner) {
            this.banner = h('div', { className: 'pt-viewing', role: 'status' });
            document.getElementById('container')?.appendChild(this.banner);
        }
        const b = this.banner;
        b.innerHTML = '';
        const who = h('a', { className: 'pt-viewing-author', href: paths.user(ps.ownerUsername), text: `@${ps.ownerUsername}` });
        who.addEventListener('click', (e) => {
            if (e.metaKey || e.ctrlKey) return;
            e.preventDefault();
            this.app.projectBrowser.open({ view: 'user', username: ps.ownerUsername });
        });
        const text = h('span', { className: 'pt-viewing-text' });
        text.append('Viewing ', h('strong', { text: `“${ps.title || this.pm.projectTitle}”` }), ' by ', who);
        if (ps.forkedFrom?.username) {
            text.append(h('span', { className: 'pt-viewing-fork', text: ` · forked from @${ps.forkedFrom.username}` }));
        }
        text.append(h('span', { className: 'pt-viewing-hint', text: ' · read-only: changes stay in this browser' }));
        const copyBtn = UIHelpers.button('Save a copy', { size: 'sm', variant: 'primary', icon: 'fork', onClick: () => this.app.saveProject() });
        const shareBtn = h('button', { type: 'button', className: 'pt-icon-btn pt-icon-btn--sm', 'aria-label': 'Copy link', 'data-tip': 'Copy link', html: icon('link') });
        shareBtn.addEventListener('click', () => this.copyText(projectShareUrl(ps.projectId), null, 'Link copied'));
        b.append(text, shareBtn, copyBtn);
    }

    /* ------------------------------------------------------------------ */
    /* Saving: thumbnails                                                 */
    /* ------------------------------------------------------------------ */

    /**
     * After a cloud save of an own project: capture the preview now (before the
     * graph can change), upload in the background. Failures are only logged.
     */
    async afterCloudSave() {
        const ps = this.pm.projectState;
        if (!ps?.projectId || !ps.isOwner || !this.api.isLoggedIn()) return;
        if (this.api.isLegacy()) return; // 1.x API: no thumbnails
        const projectId = ps.projectId;
        let blob = null;
        try {
            blob = await captureThumbnail(this.app);
        } catch (e) {
            console.warn('[thumbnail] capture failed:', e);
        }
        if (!blob) return;
        const upload = this.api.uploadThumbnail(projectId, blob).then((url) => {
            if (this.pm.projectState?.projectId === projectId) {
                this.pm.projectState.thumbUrl = url;
                this.updateMeta();
            }
            window.dispatchEvent(new CustomEvent('patchtoy:thumbnail', { detail: { projectId, url, bytes: blob.size } }));
            return url;
        }).catch((err) => {
            console.warn('[thumbnail] upload failed:', err.message || err);
            return null;
        });
        this.lastThumbnailUpload = upload;
        return upload;
    }

    /* ------------------------------------------------------------------ */
    /* Project actions (browser cards, project menu)                      */
    /* ------------------------------------------------------------------ */

    async copyText(text, button = null, message = 'Copied to clipboard') {
        try {
            await navigator.clipboard.writeText(text);
            if (button?.setLabel) {
                const prev = button.querySelector('span')?.textContent;
                button.setLabel('Copied');
                setTimeout(() => button.setLabel(prev), 1600);
            }
            UIHelpers.toast(text, 'success', { title: message, duration: 2600 });
            return true;
        } catch (e) {
            ProjectLinkDialog.show({ title: 'Copy this link', url: text });
            return false;
        }
    }

    /**
     * Copy a project's share link. A private one asks first: share by link only, or
     * publish to Community (two separate choices).
     */
    async copyShareLink(project, { onChange = null } = {}) {
        const url = projectShareUrl(project.id);
        const own = sameUsername(this.api.getCurrentUser()?.username, project.username) || project.isOwner;
        // The 1.x list doesn't report visibility: ask as if private, without claiming it is
        const unknown = project.visibility === undefined && project.isPublic === undefined;
        if (visibilityOf(project) === 'private' && own) {
            await this.api.probeCapabilities();
            const legacy = this.api.isLegacy();
            const choice = await UIHelpers.choose({
                title: unknown ? `Share “${project.name}” by link?` : `“${project.name}” is private`,
                message: legacy
                    ? `${unknown ? 'Only you can open its link unless link sharing is on.' : 'Only you can open its link while it is private.'} Let anyone with the link open it (not listed anywhere). Publishing to Community arrives with the 2.0 backend.`
                    : 'Only you can open its link while it is private. Let anyone with the link open it (not listed anywhere), or publish it to Community (listed there and on your page).',
                buttons: [
                    { label: 'Cancel', value: null, variant: 'ghost' },
                    { spacer: true },
                    { label: unknown ? 'Just copy the link' : 'Copy private link', value: 'copy' },
                    ...(legacy ? [] : [{ label: 'Publish to Community', value: 'public' }]),
                    { label: 'Anyone with the link', value: 'unlisted', variant: 'primary' }
                ]
            });
            if (!choice) return false;
            if (choice !== 'copy') {
                const ok = await this.setVisibility(project, choice, { quiet: true });
                if (!ok) return false;
                onChange?.(project);
            }
        }
        const v = visibilityOf(project);
        return this.copyText(url, null, v === 'private' ? 'Private link copied' : 'Share link copied');
    }

    /**
     * Change visibility of an own project ('private' | 'unlisted' | 'public'; a boolean
     * means public / private). Updates `project` in place.
     */
    async setVisibility(project, visibility, { quiet = false } = {}) {
        if (typeof visibility === 'boolean') visibility = visibility ? 'public' : 'private';
        if (visibility === 'public' && this.api.isLegacy()) {
            // A 1.x API would only make it link-shared while the UI said "Public"
            UIHelpers.notify(`This server runs the 1.x backend, which can only share by link. ${NEEDS_V2_BACKEND}.`, 'warning', { title: 'Publishing to Community isn’t available yet' });
            return false;
        }
        try {
            await this.api.setProjectVisibility(project.id, visibility);
        } catch (err) {
            UIHelpers.notify(err.message, 'error', { title: 'Could not change visibility' });
            return false;
        }
        project.visibility = visibility;
        project.isPublic = visibility !== 'private';
        if (visibility === 'private') project.thumbUrl = null; // the server dropped the public thumbnail
        const ps = this.pm.projectState;
        if (ps?.projectId === project.id) {
            ps.visibility = visibility;
            ps.isPublic = project.isPublic;
            this.pm.saveGraph();
            // Re-upload a thumbnail for the open project (kept private by its new random key)
            if (visibility === 'private') this.afterCloudSave();
        }
        // Community / user page caches are stale now
        const browser = this.app.projectBrowser;
        if (browser) {
            browser.states.community = null;
            browser.states.user = null;
        }
        if (!quiet) {
            const L = VISIBILITY_LABELS[visibility];
            UIHelpers.toast(L.sub, 'success', {
                title: visibility === 'public' ? `“${project.name}” is published to Community` : `“${project.name}”: ${L.label.toLowerCase()}`,
                action: visibility !== 'private' ? { label: 'Copy link', onClick: () => this.copyText(projectShareUrl(project.id), null, 'Share link copied') } : undefined
            });
        }
        return true;
    }

    renameProject(project) {
        return new Promise((resolve) => {
            const m = UIHelpers.createModal({ title: 'Rename project', subtitle: '', onClose: () => resolve(false) });
            const name = UIHelpers.field({ label: 'Project name', value: project.name });
            name.input.maxLength = 80;
            m.body.appendChild(name.field);
            const save = UIHelpers.button('Rename', { variant: 'primary' });
            m.footer.append(UIHelpers.button('Cancel', { variant: 'ghost', onClick: () => m.close() }), save);
            const submit = async () => {
                const value = name.input.value.trim();
                if (!value) return m.setError('Project name is required.');
                if (value === project.name) return m.close();
                save.disabled = true;
                try {
                    await this.api.updateProject(project.id, { name: value });
                } catch (err) {
                    save.disabled = false;
                    return m.setError(err.message || 'Rename failed');
                }
                project.name = value;
                const pm = this.pm;
                if (pm.projectState?.projectId === project.id) {
                    pm.projectTitle = value;
                    pm.projectState.title = value;
                    const t = document.getElementById('projectTitleDisplay');
                    if (t) t.textContent = value;
                    pm.saveGraph();
                    this.updateMeta();
                }
                UIHelpers.toast(`Renamed to “${value}”`, 'success');
                resolve(true);
                m.close();
            };
            save.addEventListener('click', submit);
            name.input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
            setTimeout(() => name.input.select(), 0);
        });
    }

    async downloadProject(project) {
        try {
            const full = await this.api.getProject(project.id);
            const blob = new Blob([JSON.stringify(full.data, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${String(project.name).replace(/[\\/:*?"<>|]+/g, '-')}.json`;
            a.click();
            URL.revokeObjectURL(url);
        } catch (err) {
            UIHelpers.notify(err.message, 'error', { title: 'Download failed' });
        }
    }

    async deleteProject(project) {
        const ok = await UIHelpers.confirm({
            title: `Delete “${project.name}”?`,
            message: 'This permanently removes the project from the cloud, and its link stops working. This cannot be undone.',
            confirmLabel: 'Delete project',
            danger: true
        });
        if (!ok) return false;
        try {
            await this.api.deleteProject(project.id);
        } catch (err) {
            UIHelpers.notify(err.message, 'error', { title: 'Delete failed' });
            return false;
        }
        UIHelpers.toast(`Deleted “${project.name}”`, 'success');
        if (this.pm.projectState?.projectId === project.id) this.pm.clearProject();
        const browser = this.app.projectBrowser;
        if (browser) {
            browser.states.community = null;
            browser.states.user = null;
        }
        return true;
    }

    /** Share dialog for the current cloud project (project menu). */
    async shareCurrentProject() {
        const ps = this.pm.projectState;
        if (!(ps?.source === 'cloud' && ps.projectId)) {
            if (!this.api.isLoggedIn()) {
                return this.signIn(() => this.app.saveProject());
            }
            const ok = await UIHelpers.confirm({
                title: 'Save to share',
                message: 'Only cloud projects have a link. Save this patch to your account first.',
                confirmLabel: 'Save to cloud'
            });
            if (ok) await this.app.saveProject();
            if (!(this.pm.projectState?.source === 'cloud' && this.pm.projectState.projectId)) return;
        }
        await this.api.probeCapabilities(); // 1.x API: no "Publish to Community"
        const s = this.pm.projectState;
        const project = { id: s.projectId, name: this.pm.projectTitle, isPublic: !!s.isPublic, visibility: visibilityOf(s), username: s.ownerUsername, isOwner: s.isOwner };
        ProjectLinkDialog.show({
            title: 'Share project',
            url: projectShareUrl(project.id),
            project,
            community: this
        });
    }

    /* ------------------------------------------------------------------ */
    /* Account                                                            */
    /* ------------------------------------------------------------------ */

    signIn(onSuccess = null, { register = false } = {}) {
        const done = () => {
            UIHelpers.updateAccountButton(this.api);
            this.updateChrome();
            this.maybePromptUsername();
            onSuccess?.();
        };
        return register ? AuthDialogs.showRegister(this.api, done) : AuthDialogs.showLogin(this.api, done);
    }

    /** Open a sign-up link: create the account and sign in (AuthDialogs.completeSignup). */
    completeSignup(token) {
        return AuthDialogs.completeSignup(this.api, token, () => {
            UIHelpers.updateAccountButton(this.api);
            this.updateChrome();
            this.maybePromptUsername();
        });
    }

    /** Legacy accounts got a generated username: offer to change it once. */
    maybePromptUsername() {
        if (!this.api.profile?.usernameGenerated) return;
        setTimeout(() => this.showProfileDialog({ firstTime: true }), 300);
    }

    showProfileDialog({ firstTime = false } = {}) {
        const user = this.api.getCurrentUser();
        if (!user) return this.signIn();
        const m = UIHelpers.createModal({
            title: firstTime ? 'Choose your username' : 'Edit profile',
            subtitle: firstTime
                ? `Your projects are shown as @${user.username}. Keep it or pick another one.`
                : 'Your username and display name appear on your page and on your public projects. Your email is never shown.'
        });
        const username = UIHelpers.field({ label: 'Username', value: user.username, hint: `${USERNAME_RULE}. Capitals are kept, but @Name and @name are the same handle. Your page: /u/<username>`, autocomplete: 'username' });
        username.input.maxLength = 20;
        const display = UIHelpers.field({ label: 'Display name (optional)', value: this.api.profile?.displayName || user.displayName || '', placeholder: 'Ada Lovelace' });
        display.input.maxLength = 40;
        m.body.append(username.field, display.field);
        const save = UIHelpers.button(firstTime ? 'Keep this username' : 'Save', { variant: 'primary' });
        username.input.addEventListener('input', () => {
            if (firstTime) save.setLabel(username.input.value.trim() === user.username ? 'Keep this username' : 'Save');
        });
        m.footer.append(UIHelpers.button('Cancel', { variant: 'ghost', onClick: () => m.close() }), save);

        const submit = async () => {
            const name = username.input.value.trim();
            if (!USERNAME_RE.test(name)) return m.setError(`Usernames are ${USERNAME_RULE}.`);
            save.disabled = true;
            try {
                const body = { username: name };
                const dn = display.input.value.trim();
                if (dn !== (this.api.profile?.displayName || '')) body.displayName = dn;
                await this.api.updateProfile(body);
            } catch (err) {
                save.disabled = false;
                return m.setError(err.message || 'Could not update your profile');
            }
            m.close();
            UIHelpers.updateAccountButton(this.api);
            const ps = this.pm.projectState;
            if (ps?.isOwner && ps.ownerUsername !== name) {
                ps.ownerUsername = name;
                this.pm.saveGraph();
            }
            const browser = this.app.projectBrowser;
            if (browser) {
                browser.states = {};
                if (browser.isOpen() && browser.view === 'user') browser.openUser(name);
            }
            UIHelpers.toast(`Your page: ${window.location.origin}${paths.user(name)}`, 'success', { title: 'Profile saved' });
        };
        save.addEventListener('click', submit);
        [username.input, display.input].forEach(inp => inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); }));
        setTimeout(() => username.input.select(), 0);
        return m;
    }

    /** Extra account menu entries (UIHelpers.showAccountMenu). */
    accountMenuItems() {
        const user = this.api.getCurrentUser();
        const browser = this.app.projectBrowser;
        // A 1.x API has no user pages or profile endpoint
        const legacy = this.api.isLegacy();
        return [
            !legacy && { icon: 'user', label: 'My page', hint: user ? `/u/${user.username}` : '', onClick: () => browser.open({ view: 'user', username: user.username }) },
            { icon: 'folder', label: 'My projects', onClick: () => browser.open({ view: 'mine', presentation: 'popover' }) },
            !legacy && { icon: 'pencil', label: 'Edit profile…', onClick: () => this.showProfileDialog() },
        ].filter(Boolean);
    }
}

/**
 * Link dialog: a read-only URL with a copy button, and (for an own project) the
 * public / private switch.
 */
export class ProjectLinkDialog {
    static show({ title, url, project = null, community = null }) {
        const own = project && project.isOwner;
        const m = UIHelpers.createModal({
            title,
            subtitle: project ? '' : 'Copy the link below.',
            className: 'pt-modal--wide pt-share'
        });
        const status = h('div', { className: 'pt-share-status' });
        const renderStatus = () => {
            status.innerHTML = '';
            const v = visibilityOf(project);
            const L = VISIBILITY_LABELS[v];
            const mark = h('span', { className: `pt-share-icon ${v === 'private' ? 'is-private' : 'is-public'}`, html: icon(L.icon) });
            const text = h('div', { className: 'pt-share-text' }, [
                h('div', { className: 'pt-share-title', text: L.label }),
                h('div', { className: 'pt-share-sub', text: own ? L.sub : 'Anyone with the link can open it.' })
            ]);
            status.append(mark, text);
            if (own && community) {
                // Sharing a link and publishing to Community are separate choices
                const options = [
                    { v: 'private', label: 'Private' },
                    { v: 'unlisted', label: community.api.isLegacy() ? 'Share by link' : 'Link only' },
                    { v: 'public', label: 'Publish to Community' }
                ].filter(o => o.v !== v);
                const legacy = community.api.isLegacy();
                for (const o of options) {
                    const btn = UIHelpers.button(o.label, { size: 'sm', variant: o.v === 'public' ? 'primary' : '' });
                    btn.dataset.visibility = o.v;
                    if (o.v === 'public' && legacy) {
                        // 1.x API: link sharing only. The wrapper carries the tooltip (a disabled
                        // button gets no pointer events)
                        btn.disabled = true;
                        const wrap = h('span', { className: 'pb-needs-v2-wrap', 'data-tip': NEEDS_V2_BACKEND, title: NEEDS_V2_BACKEND });
                        wrap.appendChild(btn);
                        status.appendChild(wrap);
                        continue;
                    }
                    btn.addEventListener('click', async () => {
                        btn.disabled = true;
                        await community.setVisibility(project, o.v, { quiet: true });
                        renderStatus();
                    });
                    status.appendChild(btn);
                }
            }
        };
        if (project) {
            renderStatus();
            m.body.appendChild(status);
        }

        const row = h('div', { className: 'pt-copy-row' });
        const input = h('input', { type: 'text', className: 'pt-input pt-input--mono', readOnly: true, 'aria-label': 'Link' });
        input.value = url;
        const copyBtn = UIHelpers.button('Copy link', { variant: 'primary', icon: 'copy' });
        copyBtn.addEventListener('click', () => {
            navigator.clipboard?.writeText(url).then(() => {
                copyBtn.setLabel('Copied');
                setTimeout(() => copyBtn.setLabel('Copy link'), 1800);
            }, () => {
                input.select();
                UIHelpers.toast('Press ⌘C to copy the selected link', 'info');
            });
        });
        row.append(input, copyBtn);
        m.body.appendChild(row);
        m.body.style.paddingBottom = '20px';
        m.footer.appendChild(UIHelpers.button('Done', { onClick: () => m.close() }));
        setTimeout(() => input.select(), 0);
        return m;
    }
}
