import { config } from '../core/config.js';

const OVERRIDE_KEY = 'patchtoy_api_override';
const TOKEN_KEY = 'patchtoy_auth_token';

/** Error from the API (status: HTTP status, 0 = network / offline; code: server error code). */
export class ApiError extends Error {
    constructor(message, { status = 0, code = null, offline = false } = {}) {
        super(message);
        this.name = 'ApiError';
        this.status = status;
        this.code = code;
        this.offline = offline;
    }
}

function isLoopback(url) {
    try {
        const u = new URL(url);
        return ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
    } catch (e) {
        return false;
    }
}

/**
 * Resolve the API base URL:
 *   1. `?api=<url>` (remembered in localStorage; `?api=default` forgets it). Any URL in
 *      dev; production builds only accept loopback URLs (a link must not be able to
 *      point someone's sign-in at another server).
 *   2. VITE_API_URL (build / dev env)
 *   3. config.API_URL
 */
export function resolveApiUrl() {
    let override = null;
    try {
        const params = new URLSearchParams(window.location.search);
        const fromUrl = params.get('api');
        if (fromUrl === 'default' || fromUrl === '') {
            localStorage.removeItem(OVERRIDE_KEY);
        } else if (fromUrl) {
            if (import.meta.env?.DEV || isLoopback(fromUrl)) {
                localStorage.setItem(OVERRIDE_KEY, fromUrl.replace(/\/+$/, ''));
            } else {
                console.warn(`[api] ignoring ?api=${fromUrl}: only localhost APIs can be selected in production builds`);
            }
        }
        override = localStorage.getItem(OVERRIDE_KEY);
        if (override && !(import.meta.env?.DEV || isLoopback(override))) {
            localStorage.removeItem(OVERRIDE_KEY);
            override = null;
        }
    } catch (e) {
        override = null;
    }
    const envUrl = import.meta.env?.VITE_API_URL || null;
    const url = override || envUrl || config.API_URL || null;
    return { url: url ? String(url).replace(/\/+$/, '') : null, overridden: !!override };
}

/**
 * Backend capabilities per API URL. A 1.x backend (the deployed API before the 2.0
 * deploy) has no public feed, user pages, views or thumbnails, and only knows
 * `isPublic` (true = shared by link). Probed once per session per URL
 * (GET /api/projects/public: 404 or 403 on 1.x), the last answer is kept in
 * localStorage so the UI can label things right away on the next load.
 */
const CAPS_KEY = 'patchtoy_api_caps';
const capsProbes = new Map(); // baseUrl -> Promise<caps>

function readStoredCaps(url) {
    try {
        const all = JSON.parse(localStorage.getItem(CAPS_KEY) || '{}');
        const c = all[url];
        return c && typeof c.community === 'boolean' ? { community: c.community, legacy: !!c.legacy, known: true } : null;
    } catch (e) {
        return null;
    }
}

function storeCaps(url, caps) {
    try {
        const all = JSON.parse(localStorage.getItem(CAPS_KEY) || '{}');
        all[url] = { community: caps.community, legacy: caps.legacy, at: Date.now() };
        localStorage.setItem(CAPS_KEY, JSON.stringify(all));
    } catch (e) { /* ignore */ }
}

/**
 * API client for backend communication
 */
export class ApiClient {
    constructor() {
        const { url, overridden } = resolveApiUrl();
        this.baseUrl = url;
        this.overridden = overridden;
        // Tokens are kept per API, so a mock server never receives the production token
        this.tokenKey = overridden || (url && url !== config.API_URL) ? `${TOKEN_KEY}@${url}` : TOKEN_KEY;
        this.token = localStorage.getItem(this.tokenKey);
        this.profile = null; // { username, displayName, usernameGenerated } once known
        if (overridden) console.info(`[api] using ${url}`);
        else if (import.meta.env?.DEV && url && !isLoopback(url)) {
            console.info(`[api] dev build using ${url} (the production API). For local data run \`npm run mock-api\` and open ?api=http://localhost:8787 (or \`npm run dev:mock\`).`);
        }
        if (this.token && this.isTokenExpired()) this.clearToken();
        // Last known capabilities of this API (null = never probed); see probeCapabilities()
        this.caps = url ? readStoredCaps(url) : null;
    }

    /**
     * What the backend supports: { community, legacy, known }. `legacy` = a 1.x API (no
     * public feed / user pages / views / thumbnails; visibility is isPublic = link sharing).
     * Cached per API URL for the session; an unreachable API answers { known: false }
     * (not cached, the next call probes again).
     * @returns {Promise<{community: boolean, legacy: boolean, known: boolean}>}
     */
    probeCapabilities() {
        if (!this.isEnabled()) return Promise.resolve({ community: false, legacy: false, known: true, disabled: true });
        const url = this.baseUrl;
        let probe = capsProbes.get(url);
        if (!probe) {
            probe = this.request('GET', '/api/projects/public?limit=1', null, { auth: false }).then(
                () => ({ community: true, legacy: false, known: true }),
                (err) => {
                    // 1.x: /api/projects/{id} answers "Project not found" for id=public (404);
                    // API Gateway answers unknown resources with 403 "Missing Authentication Token"
                    if (err?.status === 404 || err?.status === 403) return { community: false, legacy: true, known: true };
                    capsProbes.delete(url);
                    return { ...(this.caps || { community: true, legacy: false }), known: false };
                }
            ).then((caps) => {
                if (caps.known) {
                    const changed = !this.caps || this.caps.legacy !== caps.legacy;
                    this.caps = caps;
                    storeCaps(url, caps);
                    if (changed) window.dispatchEvent(new CustomEvent('patchtoy:api-caps', { detail: caps }));
                }
                return caps;
            });
            capsProbes.set(url, probe);
        }
        return probe;
    }

    /** A request found the 1.x API (e.g. the public feed answered 404): remember it. */
    markLegacy() {
        if (!this.isEnabled() || this.caps?.legacy) return;
        const caps = { community: false, legacy: true, known: true };
        this.caps = caps;
        capsProbes.set(this.baseUrl, Promise.resolve(caps));
        storeCaps(this.baseUrl, caps);
        window.dispatchEvent(new CustomEvent('patchtoy:api-caps', { detail: caps }));
    }

    /** True once the API is known to be 1.x (sync; probeCapabilities() finds out). */
    isLegacy() {
        return !!this.caps?.legacy;
    }

    /** Community listing / user pages / publishing available (assumed until known otherwise). */
    supportsCommunity() {
        return this.isEnabled() && !this.isLegacy();
    }

    /**
     * Check if backend is enabled
     */
    isEnabled() {
        return this.baseUrl !== null && this.baseUrl !== undefined;
    }

    /**
     * Check if user is logged in
     */
    isLoggedIn() {
        return this.token !== null;
    }

    tokenPayload() {
        if (!this.token) return null;
        try {
            const b64 = this.token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
            return JSON.parse(atob(b64));
        } catch (e) {
            return null;
        }
    }

    isTokenExpired() {
        const p = this.tokenPayload();
        return !p || (p.exp && p.exp * 1000 < Date.now());
    }

    /**
     * Get current user info from token
     */
    getCurrentUser() {
        const payload = this.tokenPayload();
        if (!payload) return null;
        return {
            userId: payload.userId,
            email: payload.email,
            username: payload.username,
            displayName: this.profile?.displayName || ''
        };
    }

    /**
     * Set auth token
     */
    setToken(token) {
        this.token = token;
        localStorage.setItem(this.tokenKey, token);
        window.dispatchEvent(new CustomEvent('patchtoy:auth', { detail: { signedIn: true } }));
    }

    /**
     * Clear auth token
     */
    clearToken({ reason = 'signout', code = null } = {}) {
        const had = this.token !== null;
        this.token = null;
        this.profile = null;
        localStorage.removeItem(this.tokenKey);
        if (had) {
            window.dispatchEvent(new CustomEvent('patchtoy:auth', { detail: { signedIn: false, reason, code } }));
            if (reason === 'expired') window.dispatchEvent(new CustomEvent('patchtoy:session-expired', { detail: { code } }));
        }
    }

    /**
     * Make a request. Throws ApiError (status 0 + offline for network failures).
     * @param {{auth?: boolean}} [opts] - auth: false sends no token (public reads)
     */
    async request(method, path, body = null, { auth = true } = {}) {
        if (!this.isEnabled()) {
            throw new ApiError('Cloud features are not configured', { status: 0, code: 'disabled' });
        }

        const headers = {};
        if (body) headers['Content-Type'] = 'application/json';
        if (auth && this.token) headers['Authorization'] = `Bearer ${this.token}`;

        const options = { method, headers };
        if (body) options.body = JSON.stringify(body);

        let response;
        try {
            response = await fetch(`${this.baseUrl}${path}`, options);
        } catch (err) {
            const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
            throw new ApiError(offline ? 'You are offline' : 'Can’t reach the PatchToy cloud', { status: 0, offline: true });
        }

        let data = null;
        try {
            data = await response.json();
        } catch (e) {
            data = null;
        }

        if (response.status === 401 && auth && this.token) {
            // Token expired, invalid or revoked (password reset / username change elsewhere):
            // sign out here and let the app prompt to sign in again
            this.clearToken({ reason: 'expired', code: data?.code || null });
            throw new ApiError('Your session expired. Sign in again.', { status: 401, code: 'auth' });
        }

        if (!response.ok) {
            const message = data?.error || data?.message || `Request failed (${response.status})`;
            throw new ApiError(message, { status: response.status, code: data?.code || null });
        }

        return data;
    }

    // Auth endpoints
    /**
     * Sign up. With email verification (the default) the answer is
     * { pending: true, message }: the account exists once the emailed link is opened
     * (verifyEmail). A backend with SIGNUP_VERIFICATION=off answers with a session token
     * right away, which is stored as before.
     */
    async register(email, username, password) {
        const data = await this.request('POST', '/api/auth/register', { email, username, password }, { auth: false });
        if (data?.token) {
            this.profile = data.user || null;
            this.setToken(data.token);
            return { ...data, pending: false };
        }
        return { pending: true, message: data?.message || 'Check your email to finish signing up.' };
    }

    /** Complete a sign-up with the token from the emailed /#verify=<token> link; signs in. */
    async verifyEmail(token) {
        const data = await this.request('POST', '/api/auth/verify-email', { token }, { auth: false });
        this.profile = data.user || null;
        this.setToken(data.token);
        return data;
    }

    /** Ask for a new sign-up link. The answer is the same whether or not the address is known. */
    async resendVerification(email) {
        return await this.request('POST', '/api/auth/resend-verification', { email }, { auth: false });
    }

    async login(login, password) {
        const data = await this.request('POST', '/api/auth/login', { login, password }, { auth: false });
        this.profile = data.user || null;
        this.setToken(data.token);
        return data;
    }

    async logout() {
        this.clearToken();
    }

    async verify() {
        return await this.request('GET', '/api/auth/verify');
    }

    async requestPasswordReset(email) {
        return await this.request('POST', '/api/auth/request-password-reset', { email }, { auth: false });
    }

    /** Set a new password with a reset link token. Every session (this one too) ends. */
    async resetPassword(token, newPassword) {
        const data = await this.request('POST', '/api/auth/reset-password', { token, newPassword }, { auth: false });
        this.clearToken();
        return data;
    }

    // Users
    /** Public profile + public projects: { user, projects, cursor }. */
    async getUser(username, { cursor = null } = {}) {
        const q = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
        return await this.request('GET', `/api/users/${encodeURIComponent(username)}${q}`, null, { auth: false });
    }

    /** Update the signed-in user's username / display name. Stores the new token. */
    async updateProfile({ username, displayName } = {}) {
        const body = {};
        if (username !== undefined) body.username = username;
        if (displayName !== undefined) body.displayName = displayName;
        const data = await this.request('PUT', '/api/users/me', body);
        this.profile = data.user || null;
        this.setToken(data.token);
        return data;
    }

    // Project endpoints
    async listProjects() {
        return await this.request('GET', '/api/projects');
    }

    /** Public feed: { projects, cursor }. sort: 'new' | 'popular'. */
    async listPublicProjects({ sort = 'new', q = '', cursor = null, limit = 24 } = {}) {
        const params = new URLSearchParams({ sort, limit: String(limit) });
        if (q) params.set('q', q);
        if (cursor) params.set('cursor', cursor);
        return await this.request('GET', `/api/projects/public?${params}`, null, { auth: false });
    }

    async getProject(projectId) {
        return await this.request('GET', `/api/projects/${encodeURIComponent(projectId)}`);
    }

    /**
     * @param {string} name
     * @param {object} data
     * @param {{description?: string, forkedFrom?: string, visibility?: 'private'|'unlisted'|'public', isPublic?: boolean}} [extra]
     *   isPublic (deprecated): true = publish ('public'), false = private
     */
    async saveProject(name, data, extra = {}) {
        const body = { name, data };
        if (extra.description) body.description = extra.description;
        if (extra.forkedFrom) body.forkedFrom = { id: extra.forkedFrom };
        if (extra.visibility) body.visibility = extra.visibility;
        else if (extra.isPublic !== undefined) body.visibility = extra.isPublic ? 'public' : 'private';
        // 1.x backends only know isPublic (link sharing): send it too, 2.0 prefers visibility
        if (body.visibility) body.isPublic = body.visibility !== 'private';
        return await this.request('POST', '/api/projects', body);
    }

    async updateProject(projectId, updates) {
        return await this.request('PUT', `/api/projects/${encodeURIComponent(projectId)}`, updates);
    }

    async deleteProject(projectId) {
        return await this.request('DELETE', `/api/projects/${encodeURIComponent(projectId)}`);
    }

    /** visibility: 'private' | 'unlisted' (anyone with the link) | 'public' (listed in Community). */
    async setProjectVisibility(projectId, visibility) {
        // isPublic keeps 1.x backends working (they require it; true = shared by link)
        return await this.request('PUT', `/api/projects/${encodeURIComponent(projectId)}/visibility`,
            { visibility, isPublic: visibility !== 'private' });
    }

    /** @deprecated boolean form: true = publish to Community, false = private. */
    async toggleProjectVisibility(projectId, isPublic) {
        return this.setProjectVisibility(projectId, isPublic ? 'public' : 'private');
    }

    /** Count an open of a public project (once per browser session per project). */
    async recordView(projectId) {
        if (this.isLegacy()) return null; // 1.x has no view counter
        const key = `patchtoy_viewed_${projectId}`;
        try {
            if (sessionStorage.getItem(key)) return null;
            sessionStorage.setItem(key, '1');
        } catch (e) { /* private mode: count anyway */ }
        try {
            return await this.request('POST', `/api/projects/${encodeURIComponent(projectId)}/view`);
        } catch (e) {
            return null; // views are best effort
        }
    }

    /**
     * Upload a JPEG thumbnail (Blob) for an owned project: presigned POST straight to storage.
     * Resolves the public thumbnail URL.
     */
    async uploadThumbnail(projectId, blob) {
        const { upload, thumbUrl } = await this.request('POST', `/api/projects/${encodeURIComponent(projectId)}/thumbnail`);
        if (blob.size > upload.maxBytes) throw new ApiError('Thumbnail too large', { status: 413 });
        const form = new FormData();
        for (const [k, v] of Object.entries(upload.fields || {})) form.append(k, v);
        form.append('file', blob, 'thumb.jpg');
        let res;
        try {
            res = await fetch(upload.url, { method: 'POST', body: form });
        } catch (e) {
            throw new ApiError('Thumbnail upload failed (network)', { status: 0, offline: true });
        }
        if (!res.ok) throw new ApiError(`Thumbnail upload failed (${res.status})`, { status: res.status });
        return thumbUrl;
    }

    /**
     * Get public project (no auth required)
     */
    async getPublicProject(projectId) {
        return await this.request('GET', `/api/projects/${encodeURIComponent(projectId)}`, null, { auth: false });
    }
}
