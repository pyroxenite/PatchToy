/**
 * Social link previews (Open Graph / Twitter cards) for share links `/p/<id>` and user
 * pages `/u/<name>`.
 *
 * Lambda@Edge, origin-request trigger on the site distribution's `/p/*` and `/u/*`
 * behaviours (infra/lib/patchtoy-stack.ts, ENABLE_SOCIAL_PREVIEWS). Crawlers (Slack,
 * Discord, iMessage, X...) don't run JavaScript, so the meta tags must be in the HTML:
 * on a cache miss this function fetches the site's index.html and the project / user
 * card from the public API, injects the tags and returns the page itself. Every visitor
 * gets the same page (no user-agent sniffing, so nothing in the cache key varies):
 * CloudFront caches it for a few minutes per path, and the SPA boots from it as usual.
 *
 * Privacy:
 * - The API is called without credentials, so a private project answers 404 and its
 *   page gets the generic PatchToy tags. A card that still says "private" (or isn't
 *   link-readable) is treated the same, whatever the API returned.
 * - Unlisted (link-only) projects get a preview by default: the owner shared the link,
 *   and the preview is what the people they share it with expect to see. The page then
 *   carries `robots: noindex`. `unlisted: false` in the config turns these off.
 * - Every injected value is HTML-escaped; the image must be an https URL (and, when
 *   configured, on the thumbnails CDN).
 *
 * Fallbacks: API error, timeout, unknown project / user, malformed path -> the generic
 * PatchToy tags (short cache). index.html unavailable -> the request continues to S3 as
 * before (403 -> /index.html via the distribution's error responses).
 *
 * Lambda@Edge has no environment variables: the configuration is compiled in at synth
 * time (esbuild `define` of __PREVIEW_CONFIG__, see the site stack).
 */
import type { CloudFrontRequestEvent, CloudFrontRequest, CloudFrontResultResponse } from 'aws-lambda';

export interface PreviewConfig {
  /** API base URL, e.g. https://abc.execute-api.eu-west-3.amazonaws.com/prod */
  apiUrl: string;
  /** Canonical site URL for og:url and for fetching index.html, e.g. https://patchtoy.com */
  siteUrl: string;
  /** Previews for unlisted (link-only) projects. Default true. */
  unlisted?: boolean;
  /** Allowed og:image origins (the thumbnails CDN). Empty: any https URL. */
  imageOrigins?: string[];
  /** Image for pages without a thumbnail (https URL). Optional. */
  defaultImage?: string;
  /** Budget for the API and index.html fetches, ms. Default 1500. */
  timeoutMs?: number;
  /** Cache-Control max-age of a page with a preview, seconds. Default 300. */
  cacheSeconds?: number;
}

declare const __PREVIEW_CONFIG__: PreviewConfig | undefined;

export interface Meta {
  title: string;
  description: string;
  url: string;
  image?: string | null;
  imageAlt?: string;
  type: 'website' | 'article' | 'profile';
  noindex?: boolean;
}

export type Route = { kind: 'project'; id: string } | { kind: 'user'; username: string };

export const GENERIC_TITLE = 'PatchToy — Node-based GLSL shader playground';
export const GENERIC_DESCRIPTION = 'PatchToy is a node-based GLSL shader editor: patch nodes together like a modular synth and watch live WebGL previews update as you go.';

const PROJECT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const USERNAME_RE = /^[a-z0-9_-]{3,20}$/;

// ------------------------------------------------------------------ text helpers

export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"'`]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }[c] as string));
}

/** Plain one-line text: no control / invisible / bidi characters, collapsed spaces, at most `max` characters. */
export function cleanText(value: unknown, max: number): string {
  const s = String(value ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

/** An https image URL, on an allowed origin when a list is given; otherwise null. */
export function safeImage(value: unknown, allowedOrigins: string[] = []): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null;
  let u: URL;
  try {
    u = new URL(value);
  } catch (e) {
    return null;
  }
  if (u.protocol !== 'https:' || u.username || u.password) return null;
  if (allowedOrigins.length && !allowedOrigins.includes(u.origin)) return null;
  return u.toString();
}

// ------------------------------------------------------------------ routes

export function routeOf(uri: string): Route | null {
  const path = uri.replace(/\/+$/, '');
  let m = /^\/p\/([^/]+)$/.exec(path);
  if (m) {
    const id = safeDecode(m[1]);
    return id && PROJECT_ID_RE.test(id) ? { kind: 'project', id } : null;
  }
  m = /^\/u\/([^/]+)$/.exec(path);
  if (m) {
    const username = safeDecode(m[1])?.toLowerCase();
    return username && USERNAME_RE.test(username) ? { kind: 'user', username } : null;
  }
  return null;
}

function safeDecode(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch (e) {
    return null;
  }
}

// ------------------------------------------------------------------ meta

export function genericMeta(cfg: Pick<PreviewConfig, 'siteUrl' | 'defaultImage' | 'imageOrigins'>): Meta {
  return {
    title: GENERIC_TITLE,
    description: GENERIC_DESCRIPTION,
    url: `${cfg.siteUrl}/`,
    image: cfg.defaultImage ? safeImage(cfg.defaultImage) : null,
    type: 'website',
  };
}

/** The <head> tags for a page. Every value is escaped. */
export function renderTags(meta: Meta): string {
  const tag = (attr: 'name' | 'property', key: string, content: string) => `<meta ${attr}="${key}" content="${escapeHtml(content)}">`;
  const tags = [
    `<title>${escapeHtml(meta.title === GENERIC_TITLE ? meta.title : `${meta.title} · PatchToy`)}</title>`,
    tag('name', 'description', meta.description),
    `<link rel="canonical" href="${escapeHtml(meta.url)}">`,
    tag('property', 'og:site_name', 'PatchToy'),
    tag('property', 'og:type', meta.type),
    tag('property', 'og:title', meta.title),
    tag('property', 'og:description', meta.description),
    tag('property', 'og:url', meta.url),
  ];
  if (meta.image) {
    tags.push(tag('property', 'og:image', meta.image));
    if (meta.imageAlt) tags.push(tag('property', 'og:image:alt', meta.imageAlt));
  }
  tags.push(
    tag('name', 'twitter:card', meta.image ? 'summary_large_image' : 'summary'),
    tag('name', 'twitter:title', meta.title),
    tag('name', 'twitter:description', meta.description),
  );
  if (meta.image) tags.push(tag('name', 'twitter:image', meta.image));
  if (meta.noindex) tags.push(tag('name', 'robots', 'noindex'));
  return tags.join('\n    ');
}

const REPLACED_TAGS = [
  /<title\b[^>]*>[\s\S]*?<\/title>\s*/gi,
  /<meta\s+[^>]*\bname\s*=\s*["']?(?:description|robots|twitter:[\w:-]+)["']?[^>]*>\s*/gi,
  /<meta\s+[^>]*\bproperty\s*=\s*["']?og:[\w:-]+["']?[^>]*>\s*/gi,
  /<link\s+[^>]*\brel\s*=\s*["']?canonical["']?[^>]*>\s*/gi,
];

/** index.html with its title / description / og / twitter tags replaced by `meta`'s. */
export function injectMeta(html: string, meta: Meta): string {
  let out = html;
  for (const re of REPLACED_TAGS) out = out.replace(re, '');
  const tags = renderTags(meta);
  const charset = /<meta\s+charset\s*=\s*["']?[\w-]+["']?\s*\/?>/i.exec(out);
  if (charset) {
    const at = charset.index + charset[0].length;
    return `${out.slice(0, at)}\n    ${tags}${out.slice(at)}`;
  }
  const head = /<head\b[^>]*>/i.exec(out);
  if (head) {
    const at = head.index + head[0].length;
    return `${out.slice(0, at)}\n    ${tags}${out.slice(at)}`;
  }
  return `${tags}\n${out}`;
}

// ------------------------------------------------------------------ data

type FetchLike = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<{ status: number; ok?: boolean; json(): Promise<any>; text(): Promise<string> }>;

class Timeout extends Error {}

async function withTimeout<T>(ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ctrl.abort();
      reject(new Timeout('timeout'));
    }, ms);
  });
  try {
    return await Promise.race([run(ctrl.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Card of a link-readable project as a preview, or null when it must not get one. */
export function projectPreview(cfg: PreviewConfig, id: string, p: any): Meta | null {
  if (!p || typeof p !== 'object') return null;
  const visibility = p.visibility ?? (p.isPublic === true ? 'unlisted' : 'private');
  // Never anything for a project that isn't link-readable, whatever else the answer says
  if (p.isPublic !== true || (visibility !== 'public' && visibility !== 'unlisted')) return null;
  if (visibility === 'unlisted' && cfg.unlisted === false) return null;
  const name = cleanText(p.name, 100) || 'Untitled project';
  const username = cleanText(p.username, 20);
  const by = username ? ` by @${username}` : '';
  const nodes = Number.isInteger(p.nodeCount) && p.nodeCount > 0 ? `${p.nodeCount}-node ` : '';
  const description = cleanText(p.description, 280)
    || `A ${nodes}shader patch${by} on PatchToy. Open it to watch it live and remix it.`;
  const image = safeImage(p.thumbUrl, cfg.imageOrigins) || (cfg.defaultImage ? safeImage(cfg.defaultImage) : null);
  return {
    title: `${name}${by}`,
    description,
    url: `${cfg.siteUrl}/p/${encodeURIComponent(id)}`,
    image,
    imageAlt: image ? `${name}${by}` : undefined,
    type: 'article',
    noindex: visibility === 'unlisted',
  };
}

/** A user page as a preview (public profile + public projects only), or null. */
export function userPreview(cfg: PreviewConfig, username: string, body: any): Meta | null {
  const user = body?.user;
  if (!user || typeof user !== 'object' || String(user.username || '').toLowerCase() !== username) return null;
  const handle = `@${username}`;
  const display = cleanText(user.displayName, 40);
  const projects = Array.isArray(body.projects) ? body.projects.filter((c: any) => c && c.isPublic === true && (c.visibility ?? 'public') === 'public') : [];
  const count = projects.length ? ` · ${projects.length}${body.cursor ? '+' : ''} public project${projects.length === 1 && !body.cursor ? '' : 's'}` : '';
  const withThumb = projects.find((c: any) => safeImage(c.thumbUrl, cfg.imageOrigins));
  const image = withThumb ? safeImage(withThumb.thumbUrl, cfg.imageOrigins) : (cfg.defaultImage ? safeImage(cfg.defaultImage) : null);
  return {
    title: display ? `${display} (${handle})` : handle,
    description: `Shader patches by ${handle} on PatchToy${count}.`,
    url: `${cfg.siteUrl}/u/${encodeURIComponent(username)}`,
    image,
    imageAlt: image ? `A project by ${handle}` : undefined,
    type: 'profile',
  };
}

// ------------------------------------------------------------------ handler

interface Cached<T> {
  value: T;
  expires: number;
}

const MAX_CACHE = 500;

export function createHandler(cfg: PreviewConfig | null | undefined, { fetchImpl, now = Date.now }: { fetchImpl?: FetchLike; now?: () => number } = {}) {
  const doFetch: FetchLike = fetchImpl || ((url, init) => fetch(url, init as any) as any);
  const metaCache = new Map<string, Cached<Meta | null>>();
  let indexCache: Cached<string> | null = null;

  const remember = (key: string, value: Meta | null, ttlMs: number) => {
    if (metaCache.size >= MAX_CACHE) metaCache.delete(metaCache.keys().next().value as string);
    metaCache.set(key, { value, expires: now() + ttlMs });
  };

  async function indexHtml(c: PreviewConfig, budget: number): Promise<string | null> {
    if (indexCache && indexCache.expires > now()) return indexCache.value;
    try {
      const html = await withTimeout(budget, async (signal) => {
        const r = await doFetch(`${c.siteUrl}/index.html`, { signal, headers: { accept: 'text/html' } });
        if (r.status !== 200) throw new Error(`index.html ${r.status}`);
        return r.text();
      });
      if (!/<head\b/i.test(html) || html.length > 512 * 1024) return null;
      // Short: after a site deploy, a stale copy would reference pruned assets
      indexCache = { value: html, expires: now() + 30 * 1000 };
      return html;
    } catch (e) {
      return null;
    }
  }

  async function routeMeta(c: PreviewConfig, route: Route, budget: number): Promise<Meta | null> {
    const key = route.kind === 'project' ? `p:${route.id}` : `u:${route.username}`;
    const hit = metaCache.get(key);
    if (hit && hit.expires > now()) return hit.value;
    const url = route.kind === 'project'
      ? `${c.apiUrl}/api/projects/${encodeURIComponent(route.id)}`
      : `${c.apiUrl}/api/users/${encodeURIComponent(route.username)}`;
    try {
      const meta = await withTimeout(budget, async (signal) => {
        // No credentials, ever: the API answers as it would to an anonymous visitor
        const r = await doFetch(url, { signal, headers: { accept: 'application/json' } });
        if (r.status === 404 || r.status === 400 || r.status === 403) return null;
        if (r.status !== 200) throw new Error(`api ${r.status}`);
        const body = await r.json();
        return route.kind === 'project' ? projectPreview(c, route.id, body) : userPreview(c, route.username, body);
      });
      remember(key, meta, 60 * 1000);
      return meta;
    } catch (e) {
      remember(key, null, 10 * 1000); // errors / timeouts: retry soon
      return null;
    }
  }

  return async function handler(event: CloudFrontRequestEvent): Promise<CloudFrontRequest | CloudFrontResultResponse> {
    const request = event.Records[0].cf.request;
    if (!cfg || !cfg.apiUrl || !cfg.siteUrl) return request;
    if (request.method !== 'GET' && request.method !== 'HEAD') return request;
    const route = routeOf(request.uri);
    if (!route) return request;

    const c: PreviewConfig = { ...cfg, apiUrl: cfg.apiUrl.replace(/\/+$/, ''), siteUrl: cfg.siteUrl.replace(/\/+$/, '') };
    const budget = c.timeoutMs ?? 1500;
    const [html, meta] = await Promise.all([indexHtml(c, budget), routeMeta(c, route, budget)]);
    // Without the page, let S3 + the error responses serve index.html as usual
    if (!html) return request;

    const body = injectMeta(html, meta || genericMeta(c));
    const maxAge = meta ? (c.cacheSeconds ?? 300) : 60;
    return {
      status: '200',
      statusDescription: 'OK',
      headers: {
        'content-type': [{ key: 'Content-Type', value: 'text/html; charset=utf-8' }],
        'cache-control': [{ key: 'Cache-Control', value: `public, max-age=${maxAge}` }],
      },
      body: request.method === 'HEAD' ? '' : body,
    };
  };
}

export const handler = createHandler(typeof __PREVIEW_CONFIG__ !== 'undefined' ? __PREVIEW_CONFIG__ : null);
