/**
 * Tiny history-API router for the SPA routes.
 *
 *   /                 editor
 *   /p/<projectId>    a cloud project (share link)
 *   /u/<username>     a user's page (public projects)
 *   /explore[/tab]    the project browser (demos | community | mine)
 *
 * Legacy share links (?project=<id>) are rewritten to /p/<id>. The static host
 * serves index.html for every path (CloudFront 403/404 -> /index.html, Vite's
 * SPA fallback in dev), so deep links work on reload.
 */

const DEFAULT_TITLE = 'PatchToy — Node-based GLSL shader playground';
const DEFAULT_DESCRIPTION = 'PatchToy is a node-based GLSL shader editor: patch nodes together like a modular synth and watch live WebGL previews update as you go.';

/**
 * Query params dropped on navigation. Every other one survives route changes:
 * ?bridge / ?bridge=off / ?bridgeToken / ?headless (MCP automation reads them after
 * boot), ?api (local API switch), ?welcome and any other dev flag.
 * Only ?project (legacy share link, rewritten to /p/<id>) and ?reset (consumed) go.
 */
const TRANSIENT_PARAMS = ['project', 'reset', 'verify'];

/**
 * Sign-up links: https://<site>/#verify=<token> (auth/verify-email). The token is read
 * and removed from the URL while this module is evaluated, i.e. before the app makes any
 * request (first-party or third-party), so it never stays in the address bar, the
 * history or a Referer. CommunityManager.handleInitialRoute() consumes it.
 */
let pendingVerifyToken = null;
function captureVerifyToken() {
    try {
        const url = new URL(window.location.href);
        const hash = new URLSearchParams(url.hash.replace(/^#/, ''));
        const token = hash.get('verify') || url.searchParams.get('verify');
        if (!token) return null;
        hash.delete('verify');
        url.searchParams.delete('verify');
        const rest = hash.toString();
        url.hash = rest ? `#${rest}` : '';
        window.history.replaceState(window.history.state, document.title, url.pathname + url.search + url.hash);
        return token;
    } catch (e) {
        return null;
    }
}
pendingVerifyToken = captureVerifyToken();
// The link pasted into a tab that already shows the app only changes the fragment
window.addEventListener('hashchange', () => {
    const token = captureVerifyToken();
    if (token) window.dispatchEvent(new CustomEvent('patchtoy:verify-link', { detail: { token } }));
});

/** The sign-up token from the start-up URL (once; null afterwards or without one). */
export function takeVerifyToken() {
    const t = pendingVerifyToken;
    pendingVerifyToken = null;
    return t;
}

export function parseRoute(location = window.location) {
    const path = location.pathname.replace(/\/+$/, '') || '/';
    let m = /^\/p\/([^/]+)$/.exec(path);
    if (m) return { name: 'project', id: decodeURIComponent(m[1]) };
    m = /^\/u\/([^/]+)$/.exec(path);
    if (m) return { name: 'user', username: decodeURIComponent(m[1]).toLowerCase() };
    m = /^\/explore(?:\/(demos|community|mine))?$/.exec(path);
    if (m) return { name: 'explore', tab: m[1] || null };
    const legacy = new URLSearchParams(location.search).get('project');
    if (legacy) return { name: 'project', id: legacy, legacy: true };
    return { name: 'home' };
}

export const paths = {
    home: () => '/',
    project: (id) => `/p/${encodeURIComponent(id)}`,
    user: (username) => `/u/${encodeURIComponent(username)}`,
    explore: (tab) => (tab ? `/explore/${tab}` : '/explore'),
};

/** Absolute share URL for a project. */
export function projectShareUrl(id) {
    return `${window.location.origin}${paths.project(id)}`;
}

export function userPageUrl(username) {
    return `${window.location.origin}${paths.user(username)}`;
}

function withStickyParams(path) {
    const next = new URLSearchParams(window.location.search);
    for (const key of TRANSIENT_PARAMS) next.delete(key);
    const qs = next.toString();
    return qs ? `${path}?${qs}` : path;
}

const listeners = new Set();

/**
 * Change the URL. `replace` swaps the history entry; `silent` skips route listeners
 * (the caller already shows the target, it only updates the address bar).
 */
export function navigate(path, { replace = false, silent = false, state = null } = {}) {
    const url = withStickyParams(path);
    const current = window.location.pathname + window.location.search;
    if (url !== current) {
        if (replace) window.history.replaceState(state, '', url);
        else window.history.pushState(state, '', url);
    }
    if (!silent) emit();
}

export function onRouteChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

function emit() {
    const route = parseRoute();
    for (const fn of listeners) {
        try {
            fn(route);
        } catch (e) {
            console.error('[router]', e);
        }
    }
}

window.addEventListener('popstate', () => emit());

/* --------------------------------------------------------------------------
 * <title> and meta tags per route
 * ------------------------------------------------------------------------ */

function metaTag(attr, key) {
    let el = document.head.querySelector(`meta[${attr}="${key}"]`);
    if (!el) {
        el = document.createElement('meta');
        el.setAttribute(attr, key);
        document.head.appendChild(el);
    }
    return el;
}

/**
 * Update the document title and description / Open Graph / Twitter tags.
 * Crawlers don't run JS, so these help browser UI, bookmarks and JS-capable
 * unfurlers only; static previews need an edge function (see RELEASE.md).
 */
export function setMeta({ title = null, description = null, image = null, url = null } = {}) {
    const fullTitle = title ? `${title} · PatchToy` : DEFAULT_TITLE;
    const desc = description || DEFAULT_DESCRIPTION;
    document.title = fullTitle;
    metaTag('name', 'description').setAttribute('content', desc);
    metaTag('property', 'og:title').setAttribute('content', title || 'PatchToy');
    metaTag('property', 'og:description').setAttribute('content', desc);
    metaTag('property', 'og:url').setAttribute('content', url || `${window.location.origin}${window.location.pathname}`);
    metaTag('name', 'twitter:card').setAttribute('content', image ? 'summary_large_image' : 'summary');
    const og = metaTag('property', 'og:image');
    if (image) og.setAttribute('content', image);
    else og.remove();
}
