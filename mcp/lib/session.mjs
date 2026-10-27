/**
 * PatchToySession - owns the bridge, the projects directory and any
 * auto-launched Vite / headless Chrome, and serializes all app operations.
 * Shared by the MCP server (server.mjs) and the CLI (cli.mjs).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BridgeServer, BridgeError, redactUrl } from './bridge.mjs';
import { makeToken, createOriginPolicy, registeredDevOrigins, registeredDevServers, devServerRole, normalizeOrigin, writePairingFile, removePairingFile } from './auth.mjs';
import { ensureApp, launchBrowser } from './launcher.mjs';
import { ProjectStore, ProjectError } from './projects.mjs';
import { log, warn } from './log.mjs';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Repo-relative path when inside the repo, absolute otherwise. */
export function displayPath(p) {
    if (!p) return p;
    const rel = path.relative(REPO_ROOT, p);
    return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : p;
}

export class ToolError extends Error {
    constructor(message, data) {
        super(message);
        this.name = 'ToolError';
        if (data !== undefined) this.data = data;
    }
}

export class PatchToySession {
    constructor(opts = {}) {
        const env = process.env;
        this.repoRoot = opts.repoRoot || REPO_ROOT;
        this.appUrl = (opts.appUrl || env.PATCHTOY_URL || 'http://localhost:5173').replace(/\/+$/, '/');
        const portEnv = env.PATCHTOY_BRIDGE_PORT;
        this.bridgePort = opts.bridgePort ?? (portEnv !== undefined && portEnv !== '' ? parseInt(portEnv, 10) : 7878);
        this.agentName = opts.agentName || env.PATCHTOY_AGENT_NAME || 'Claude';
        this.clientMode = opts.clientMode || env.PATCHTOY_CLIENT_MODE || 'auto'; // auto | live | headless
        this.headed = opts.headed ?? env.PATCHTOY_HEADED === '1';
        this.persistActive = opts.persistActive ?? true;
        this.store = new ProjectStore(path.resolve(this.repoRoot, opts.projectsDir || env.PATCHTOY_PROJECTS_DIR || 'projects'));

        // Browser origins the bridge accepts: the app URL, PATCHTOY_ALLOWED_ORIGINS and the
        // PatchToy Vite dev servers running from this repo (vite.config.js registers them).
        const allowedOrigins = [this.appUrl, ...(env.PATCHTOY_ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean)];
        const repoRoot = this.repoRoot;
        this.bridge = new BridgeServer({
            port: this.bridgePort,
            agentName: this.agentName,
            allowedOrigins,
            originCheck: createOriginPolicy({ origins: allowedOrigins, dynamic: () => registeredDevOrigins(repoRoot) }),
            // Live tabs on PATCHTOY_URL's origin win; tabs of private test dev servers never count as live
            preferredOrigins: [normalizeOrigin(this.appUrl)].filter(Boolean),
            originRole: (origin) => devServerRole(repoRoot, origin),
            allowPortFallback: opts.allowPortFallback ?? true,
        });

        // Live pairing: the user's own tabs authenticate with this per-run token. The PatchToy
        // dev server hands it to same-origin pages (vite.config.js); otherwise open pairUrl().
        // Off in headless-only sessions (tests, the CLI without --live) unless select_client asks.
        this.pairingToken = makeToken();
        this.livePairing = false;
        this._wantLivePairing = opts.livePairing ?? (this.clientMode !== 'headless');
        this._pairingFile = null;

        this.selectedClientId = null;
        this.activeSlug = null;
        this.browser = null;
        this.context = null;
        this.headlessPage = null; // { page, token, clientId }
        this.viteChild = null;
        this._launching = null;
        this._queue = Promise.resolve();
        this.lastBackup = null;
        this.started = false;
    }

    // ------------------------------------------------------------------
    // Lifecycle
    // ------------------------------------------------------------------

    async start() {
        if (this.started) return;
        this.started = true;
        this.store.ensureDir();
        if (this.persistActive) {
            const st = this.store.readState();
            if (st.active && this.store.exists(st.active)) this.activeSlug = st.active;
        }
        await this.bridge.start();
        if (this._wantLivePairing) this.setLivePairing(true);

        this.bridge.on('project-changed', (client, msg) => {
            this.exclusive(async () => {
                if (!client.loaded || client.loaded.slug !== msg.slug || !msg.project) return;
                if (!this.store.exists(msg.slug)) return;
                const meta = await this.store.read(msg.slug);
                // Owner lock: only the page that holds the current version of the file may write
                // it. Another tab (a duplicate, or one the agent left behind) has an older base:
                // drop its push and detach it instead of overwriting the agent's edits.
                const owner = this._ownerOf(msg.slug);
                if ((owner && owner !== client) || (meta.timestamp && client.loaded.timestamp !== meta.timestamp)) {
                    warn(`ignored edits of ${msg.slug} from ${client.label}: it is not the page that last loaded or saved the file`);
                    this._detach(client, 'another tab or the agent changed this project');
                    return;
                }
                // Ignore pushes exported before the last save (an agent edit may have landed since)
                if (meta.timestamp && msg.project.timestamp && msg.project.timestamp <= meta.timestamp) return;
                const written = await this.store.write(msg.slug, { ...msg.project, name: meta.name, description: meta.description });
                client.loaded = { slug: msg.slug, timestamp: written.timestamp };
                log(`saved user edits from ${client.label} to ${msg.slug}`);
            }).catch(e => warn('failed to save user edits', e.message));
        });
        this.bridge.on('project-detached', (client) => { client.loaded = null; });
        this.bridge.on('client-gone', (client) => {
            if (this.headlessPage && this.headlessPage.clientId === client.id) this.headlessPage.clientId = null;
            if (this.selectedClientId === client.id) this.selectedClientId = null;
        });
        this.bridge.on('client', (client) => {
            if (client.reportedLoaded && !client.loaded) {
                // Page reconnecting after a server restart: trust it if the file is unchanged
                // and no other connected page owns the project (a duplicated tab reports the same)
                const { slug, timestamp } = client.reportedLoaded;
                if (this.store.exists(slug)) {
                    this.store.read(slug).then(d => {
                        if (client.loaded || !this.bridge.clients.has(client)) return;
                        if (d.timestamp === timestamp && !this._ownerOf(slug)) client.loaded = { slug, timestamp };
                        else this._detach(client, 'the project is open in another tab or changed on disk');
                    }).catch(() => { });
                }
            }
            if (this.headlessPage && client.token && client.token === this.headlessPage.token) {
                this.headlessPage.clientId = client.id;
            }
        });
    }

    /**
     * Accept (or stop accepting) the user's own browser tabs. Writes / removes the pairing
     * file the PatchToy dev server reads to pair its same-origin pages automatically.
     */
    setLivePairing(on) {
        if (on === this.livePairing || !this.bridge.port) { this._wantLivePairing = on; return; }
        this.livePairing = on;
        this._wantLivePairing = on;
        if (on) {
            this.bridge.addToken(this.pairingToken, 'live');
            try {
                this._pairingFile = writePairingFile(this.repoRoot, this.bridge.port, this.pairingToken);
            } catch (e) { warn('could not write the live pairing file', e.message); }
            log(`live tabs: PatchToy dev tabs from this repo pair automatically; any other tab can pair by opening ${redactUrl(this.pairUrl())} with the token from get_status (pair_url)`);
        } else {
            this.bridge.removeToken(this.pairingToken);
            removePairingFile(this.repoRoot, this.bridge.port, this.pairingToken);
            this._pairingFile = null;
            for (const c of this.bridge.readyClients()) if (c.authKind === 'live') { try { c.ws.close(4401, 'live pairing disabled'); } catch { /* ignore */ } }
        }
    }

    /** URL that pairs a tab with this server (contains the secret pairing token). */
    pairUrl() {
        const u = new URL(this.appUrl);
        u.searchParams.set('bridge', String(this.bridge.port || this.bridgePort || 7878));
        u.searchParams.set('bridgeToken', this.pairingToken);
        return u.href;
    }

    /** The connected page that holds `slug` loaded, if any. */
    _ownerOf(slug) {
        return this.bridge.readyClients().find(c => c.loaded && c.loaded.slug === slug) || null;
    }

    _detach(client, reason) {
        client.loaded = null;
        if (client.ws.readyState === client.ws.OPEN) {
            client.call('detachProject', { reason }, 10000).catch(() => { });
        }
    }

    async shutdown() {
        if (this.bridge.port) removePairingFile(this.repoRoot, this.bridge.port, this.pairingToken);
        try { if (this.browser) await this.browser.close(); } catch { /* ignore */ }
        this.browser = null;
        if (this.viteChild) {
            try { this.viteChild.kill('SIGTERM'); } catch { /* ignore */ }
            this.viteChild = null;
        }
        try { await this.bridge.close(); } catch { /* ignore */ }
    }

    /** Run fn with exclusive access to the app/projects (tool calls are serialized). */
    exclusive(fn) {
        const run = this._queue.then(() => fn());
        this._queue = run.catch(() => { });
        return run;
    }

    // ------------------------------------------------------------------
    // Clients
    // ------------------------------------------------------------------

    async getClient() {
        if (this.selectedClientId) {
            const c = this.bridge.pickClient(null, this.selectedClientId);
            if (c) return c;
            warn(`selected client ${this.selectedClientId} is gone; falling back to ${this.clientMode}`);
            this.selectedClientId = null;
        }
        const c = this.bridge.pickClient(this.clientMode);
        if (c) return c;
        // Our headless page may just be reloading (e.g. Vite HMR) - give it a moment to reconnect
        if (this.clientMode !== 'live' && this.headlessPage?.page && !this.headlessPage.page.isClosed()) {
            const token = this.headlessPage.token;
            try {
                return await this.bridge.waitForClient(cl => cl.token === token, 10000);
            } catch { /* relaunch below */ }
        }
        if (this.clientMode === 'live') {
            throw new ToolError(`No live browser tab is connected. Open ${this.liveUrl()} in your browser, or call select_client {"mode":"auto"}.`);
        }
        return this.launchHeadless();
    }

    liveUrl() {
        const u = new URL(this.appUrl);
        if (this.bridge.port && this.bridge.port !== 7878) u.searchParams.set('bridge', String(this.bridge.port));
        return u.href;
    }

    async launchHeadless() {
        if (this._launching) return this._launching;
        this._launching = (async () => {
            const { child } = await ensureApp({ url: this.appUrl, repoRoot: this.repoRoot });
            if (child) {
                this.viteChild = child;
                child.on('exit', () => { if (this.viteChild === child) this.viteChild = null; });
            }
            if (!this.browser || !this.browser.isConnected()) {
                this.browser = await launchBrowser({ headed: this.headed });
                this.context = null;
                this.browser.on('disconnected', () => { this.browser = null; this.context = null; this.headlessPage = null; });
            }
            if (!this.context) {
                this.context = await this.browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
            }
            if (this.headlessPage?.page && !this.headlessPage.page.isClosed()) {
                try { await this.headlessPage.page.close(); } catch { /* ignore */ }
            }
            if (this.headlessPage?.token) this.bridge.removeToken(this.headlessPage.token);

            // Per-launch secret: only the page we open can connect as the headless client
            const token = makeToken();
            this.bridge.addToken(token, 'headless');
            const page = await this.context.newPage();
            const pageErrors = [];
            page.on('pageerror', (e) => { pageErrors.push(e.message); warn(`[page] ${e.message}`); });
            page.on('console', (m) => {
                if (m.type() === 'error' && process.env.PATCHTOY_MCP_DEBUG) warn(`[page console] ${m.text()}`);
            });
            page.on('dialog', (d) => d.dismiss().catch(() => { }));
            page.on('crash', () => warn('[page] crashed'));

            const target = new URL(this.appUrl);
            target.searchParams.set('bridge', String(this.bridge.port));
            target.searchParams.set('headless', '1');
            target.searchParams.set('bridgeToken', token);
            this.headlessPage = { page, token, clientId: null };

            const wait = this.bridge.waitForClient(c => c.token === token, 45000);
            log(`opening headless PatchToy: ${redactUrl(target.href)}`);
            try {
                await page.goto(target.href, { waitUntil: 'domcontentloaded', timeout: 45000 });
                const client = await wait;
                this.headlessPage.clientId = client.id;
                return client;
            } catch (err) {
                wait.catch(() => { });
                // Don't leave a dead page behind: later calls would wait for it first
                this.bridge.removeToken(token);
                if (this.headlessPage?.token === token) this.headlessPage = null;
                try { await page.close(); } catch { /* ignore */ }
                const extra = pageErrors.length ? ` Page errors: ${pageErrors.slice(0, 5).join(' | ')}` : '';
                throw new ToolError(`Headless PatchToy did not connect to the bridge: ${err.message}.${extra}`);
            }
        })().finally(() => { this._launching = null; });
        return this._launching;
    }

    isHeadlessClient(client) {
        return !!(this.headlessPage && client && client.token && client.token === this.headlessPage.token && this.headlessPage.page && !this.headlessPage.page.isClosed());
    }

    async call(client, method, params = {}, timeoutMs) {
        try {
            return await client.call(method, params, timeoutMs);
        } catch (err) {
            if (err instanceof BridgeError) throw new ToolError(err.message, err.data);
            throw err;
        }
    }

    // ------------------------------------------------------------------
    // Projects
    // ------------------------------------------------------------------

    setActive(slug) {
        this.activeSlug = slug;
        if (this.persistActive) this.store.writeState({ active: slug });
    }

    async resolveProject(ref) {
        try {
            return await this.store.resolve(ref);
        } catch (e) {
            if (e instanceof ProjectError) throw new ToolError(e.message, e.data);
            throw e;
        }
    }

    async requireSlug(ref) {
        if (ref) {
            const slug = await this.resolveProject(ref);
            if (slug !== this.activeSlug) this.setActive(slug);
            return slug;
        }
        if (this.activeSlug && this.store.exists(this.activeSlug)) return this.activeSlug;
        const projects = (await this.store.list()).map(p => p.slug);
        throw new ToolError('No active project. Call create_project or open_project first.', projects.length ? { projects } : undefined);
    }

    async ensureLoaded(client, slug, { force = false } = {}) {
        const data = await this.store.read(slug);
        if (!force && client.loaded && client.loaded.slug === slug && client.loaded.timestamp === data.timestamp) {
            return { reloaded: false };
        }
        // One owner per project: other pages that had it loaded stop pushing their (now stale) copy
        for (const other of this.bridge.readyClients()) {
            if (other !== client && other.loaded && other.loaded.slug === slug) this._detach(other, `${this.agentName} opened this project in another tab`);
        }
        client.loaded = null;
        const res = await this.call(client, 'loadProject', { project: data, slug, name: data.name || slug, description: data.description || '' }, 90000);
        client.loaded = { slug, timestamp: data.timestamp };
        if (res && res.backup) {
            try {
                this.lastBackup = await this.store.writeBackup(`browser-${client.id}`, res.backup);
                log(`backed up the browser's previous graph to ${this.lastBackup}`);
            } catch (e) { warn('backup failed', e.message); }
            delete res.backup;
            res.backup_file = displayPath(this.lastBackup);
        }
        return { reloaded: true, ...res };
    }

    async saveFromClient(client, slug) {
        const exported = await this.call(client, 'exportProject', {});
        const meta = await this.store.read(slug);
        const written = await this.store.write(slug, { ...exported, name: meta.name, description: meta.description });
        client.loaded = { slug, timestamp: written.timestamp };
        return written;
    }

    /**
     * Run fn(client, slug) against the active (or named) project, loaded in the
     * target browser. Mutating operations are saved back to disk afterwards.
     */
    withProject(ref, fn, { mutating = false } = {}) {
        return this.exclusive(() => this._retryOnDisconnect(async () => {
            const slug = await this.requireSlug(ref);
            const client = await this.getClient();
            const load = await this.ensureLoaded(client, slug);
            let out;
            try {
                out = await fn(client, slug, load);
            } catch (err) {
                // The page may hold a half-applied change: reload from disk on the next call
                // instead of saving the partial graph later.
                if (mutating) client.loaded = null;
                throw err;
            }
            if (mutating) await this.saveFromClient(client, slug);
            return out;
        }));
    }

    /** Run fn(client) with any client (no project needed). */
    withClient(fn) {
        return this.exclusive(() => this._retryOnDisconnect(async () => fn(await this.getClient())));
    }

    /**
     * If the page disconnects mid-call (reload, crash), its in-memory state is
     * gone and disk is still the source of truth, so re-running the whole
     * operation once (reload project from disk, re-apply) is safe.
     */
    async _retryOnDisconnect(fn) {
        try {
            return await fn();
        } catch (err) {
            const msg = String(err?.message || '');
            // A result over the size limit would be sent (and refused) again: never retry it
            if (err?.data?.too_large) throw err;
            if (!/disconnected|not connected|Superseded|shutting down/i.test(msg) || /Bridge shutting down/.test(msg)) throw err;
            warn(`page disconnected during a call (${msg}); retrying once`);
            await new Promise(r => setTimeout(r, 500));
            return await fn();
        }
    }

    status() {
        const target = this.selectedClientId
            ? this.bridge.pickClient(null, this.selectedClientId)
            : this.bridge.pickClient(this.clientMode);
        return {
            app_url: this.appUrl,
            bridge: {
                port: this.bridge.port,
                requested_port: this.bridgePort,
                port_fallback: this.bridge.portFallback,
            },
            client_mode: this.selectedClientId ? `client:${this.selectedClientId}` : this.clientMode,
            clients: this.bridge.readyClients().map(c => ({ ...c.summary(), target: c === target })),
            dev_servers: registeredDevServers(this.repoRoot).map(d => ({ port: d.port, role: d.role, origin: d.origins[0] })),
            live_mode: this.livePairing
                ? `Open ${this.liveUrl()} (a PatchToy dev server from this repo pairs automatically) or pair_url in a browser to watch edits live. Tabs on ${normalizeOrigin(this.appUrl)} are preferred; pages driven by tests or agents (role automation) are never picked automatically.`
                : 'Live tabs are not accepted in this session (headless only). select_client {"mode":"auto"} enables pairing.',
            pair_url: this.livePairing ? this.pairUrl() : undefined,
            allowed_origins: this.bridge.originCheck.allowed ? this.bridge.originCheck.allowed() : undefined,
            active_project: this.activeSlug,
            projects_dir: displayPath(this.store.dir) || '.',
            headless_browser: !!(this.browser && this.browser.isConnected()),
            vite_spawned_by_mcp: !!this.viteChild,
            last_backup: this.lastBackup ? displayPath(this.lastBackup) : undefined,
        };
    }
}
