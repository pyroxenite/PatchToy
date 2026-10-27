#!/usr/bin/env node
/**
 * Local mock of the PatchToy cloud API, for end-to-end testing without AWS.
 *
 * It runs the REAL Lambda handlers (infra/lambda, transpiled on start with
 * esbuild) against the in-memory store, and fakes the S3 thumbnail bucket
 * (presigned POST uploads + public GETs). Same routes, CORS and JSON shapes as
 * API Gateway.
 *
 *   node scripts/mock-api.mjs                  # http://localhost:8787
 *   node scripts/mock-api.mjs --port 8790 --seed --persist /tmp/patchtoy-mock.json
 *
 * Then open the app with  ?api=http://localhost:8787  (dev server) or set
 * VITE_API_URL=http://localhost:8787. `?api=default` switches back.
 *
 *   --seed            two demo accounts (ada / grace, password "patchtoy123") with a few
 *                     public demo projects from projects/*.patchtoy.json
 *   --persist <file>  keep the in-memory data in a JSON file across restarts
 *   --quiet           no request log
 *   --legacy          answer like the deployed 1.x API: no public feed (GET /api/projects/public
 *                     is "Project not found", 404), no user pages / views / thumbnails / email
 *                     verification (API Gateway's 403 "Missing Authentication Token", without
 *                     CORS headers), visibility only as `isPublic` (required by PUT .../visibility,
 *                     true = shared by link) and the 1.x list / get shapes (no visibility field)
 *
 * Test helpers: GET /__mock/health, POST /__mock/reset, GET /__mock/outbox[?to=<email>]
 * (every mail that would have been sent: sign-up verification links, "you already have an
 * account" notices, password resets; newest last, with `kind`, `link` and `token`). The
 * links are printed too. Sign-up needs the verification link: open it from the outbox
 * (or the log) in the same browser.
 *
 * Listens on 127.0.0.1 only: it has seeded accounts with a known password and a
 * public JWT secret.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LAMBDA_DIR = path.join(ROOT, 'infra', 'lambda');
const OUT_DIR = path.join(LAMBDA_DIR, '.mock-dist');

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

const PORT = Number(arg('port', process.env.MOCK_API_PORT || 8787));
const SEED = !!arg('seed', false);
const PERSIST = typeof arg('persist') === 'string' ? path.resolve(arg('persist')) : null;
const QUIET = !!arg('quiet', false);
const LEGACY = !!arg('legacy', false);
const ORIGIN = `http://localhost:${PORT}`;

// Public, dev-only signing key (>= 32 characters, like production requires)
process.env.JWT_SECRET = process.env.JWT_SECRET || 'patchtoy-mock-secret-not-for-production';
process.env.FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5200';

// ---------------------------------------------------------------------------
// Transpile the lambdas (no bundling: one module graph, so setStore() applies everywhere)
// ---------------------------------------------------------------------------

function listTs(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'dist', '.mock-dist', 'test'].includes(entry.name)) continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTs(p));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

async function buildLambdas() {
  const { build } = await import('esbuild');
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  await build({
    entryPoints: listTs(LAMBDA_DIR),
    outdir: OUT_DIR,
    outbase: LAMBDA_DIR,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    bundle: false,
    logLevel: 'error',
  });
  // Resolve the lambdas' dependencies (bcryptjs, jsonwebtoken, uuid) from infra/lambda/node_modules
  fs.writeFileSync(path.join(OUT_DIR, 'package.json'), JSON.stringify({ type: 'commonjs' }));
  return createRequire(path.join(OUT_DIR, 'index.js'));
}

const requireLambda = await buildLambdas();
const { setStore } = requireLambda('./shared/store.js');
const { MemoryStore } = requireLambda('./shared/memory-store.js');
const { setBlobStore, THUMB_MAX_BYTES, THUMB_CONTENT_TYPE } = requireLambda('./shared/blobs.js');

const handlers = {};
for (const name of [
  'auth/register', 'auth/login', 'auth/verify', 'auth/request-password-reset', 'auth/reset-password',
  'auth/verify-email', 'auth/resend-verification',
  'projects/list', 'projects/get', 'projects/save', 'projects/update', 'projects/delete',
  'projects/toggle-visibility', 'projects/public', 'projects/view', 'projects/thumbnail',
  'users/get', 'users/update-me',
]) {
  handlers[name] = requireLambda(`./${name}.js`).handler;
}

// Mail without SES: the real handlers run, their mails go to an in-memory outbox
// (GET /__mock/outbox) and the links are printed here
const outbox = [];
let mailLog = true;
requireLambda('./shared/mailer.js').setMailer(async (mail) => {
  const m = /https?:\/\/\S+#(reset|verify)=([A-Za-z0-9_.-]+)/.exec(mail.text);
  const kind = m ? m[1] : 'notice';
  outbox.push({ to: mail.to, subject: mail.subject, kind, link: m?.[0] || '', token: m?.[2] || '', text: mail.text, at: new Date().toISOString() });
  if (outbox.length > 100) outbox.shift();
  if (mailLog) console.log(`[mock-api] mail to ${mail.to} (${kind}): ${m?.[0] || mail.subject}`);
});

// ---------------------------------------------------------------------------
// Stores
// ---------------------------------------------------------------------------

const blobs = new Map(); // key -> Buffer

const blobStore = {
  async presignUpload(key) {
    return {
      url: `${ORIGIN}/__mock/s3`,
      fields: { key, 'Content-Type': THUMB_CONTENT_TYPE, policy: 'mock-policy', 'x-amz-signature': 'mock' },
      maxBytes: THUMB_MAX_BYTES,
    };
  },
  publicUrl(key) {
    return key ? `${ORIGIN}/__mock/${key}` : null;
  },
  async delete(key) {
    blobs.delete(key);
  },
};

let store = new MemoryStore();

function loadPersisted() {
  if (!PERSIST || !fs.existsSync(PERSIST)) return false;
  try {
    const raw = JSON.parse(fs.readFileSync(PERSIST, 'utf8'));
    for (const u of raw.users || []) store.users.set(u.userId, u);
    for (const [k, v] of raw.handles || []) store.handles.set(k, v);
    for (const p of raw.projects || []) store.projects.set(p.projectId, p);
    for (const [k, v] of raw.blobs || []) blobs.set(k, Buffer.from(v, 'base64'));
    console.log(`[mock-api] restored ${store.users.size} users, ${store.projects.size} projects from ${PERSIST}`);
    return true;
  } catch (e) {
    console.warn(`[mock-api] could not read ${PERSIST}:`, e.message);
    return false;
  }
}

let persistTimer = null;
function persistSoon() {
  if (!PERSIST) return;
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    const raw = {
      users: [...store.users.values()],
      handles: [...store.handles.entries()],
      projects: [...store.projects.values()],
      blobs: [...blobs.entries()].map(([k, v]) => [k, v.toString('base64')]),
    };
    fs.writeFileSync(PERSIST, JSON.stringify(raw));
  }, 200);
}

function install() {
  setStore(store);
  setBlobStore(blobStore);
}
install();

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Api-Key',
  'Access-Control-Max-Age': '600',
};

/** [method, pattern, handler] - same resources as the API Gateway stack. */
const ROUTES = [
  ['POST', /^\/api\/auth\/register$/, 'auth/register'],
  ['POST', /^\/api\/auth\/login$/, 'auth/login'],
  ['GET', /^\/api\/auth\/verify$/, 'auth/verify'],
  ['POST', /^\/api\/auth\/request-password-reset$/, 'auth/request-password-reset'],
  ['POST', /^\/api\/auth\/reset-password$/, 'auth/reset-password'],
  ['POST', /^\/api\/auth\/verify-email$/, 'auth/verify-email'],
  ['POST', /^\/api\/auth\/resend-verification$/, 'auth/resend-verification'],
  ['GET', /^\/api\/projects$/, 'projects/list'],
  ['POST', /^\/api\/projects$/, 'projects/save'],
  ['GET', /^\/api\/projects\/public$/, 'projects/public'],
  ['GET', /^\/api\/projects\/(?<id>[^/]+)$/, 'projects/get'],
  ['PUT', /^\/api\/projects\/(?<id>[^/]+)$/, 'projects/update'],
  ['DELETE', /^\/api\/projects\/(?<id>[^/]+)$/, 'projects/delete'],
  ['PUT', /^\/api\/projects\/(?<id>[^/]+)\/visibility$/, 'projects/toggle-visibility'],
  ['POST', /^\/api\/projects\/(?<id>[^/]+)\/view$/, 'projects/view'],
  ['POST', /^\/api\/projects\/(?<id>[^/]+)\/thumbnail$/, 'projects/thumbnail'],
  ['PUT', /^\/api\/users\/me$/, 'users/update-me'],
  ['GET', /^\/api\/users\/(?<username>[^/]+)$/, 'users/get'],
];

function send(res, status, body, headers = {}) {
  const isBuffer = Buffer.isBuffer(body);
  res.writeHead(status, {
    ...CORS,
    ...(isBuffer || body === null ? {} : { 'Content-Type': 'application/json' }),
    ...headers,
  });
  res.end(body === null ? undefined : isBuffer ? body : JSON.stringify(body));
}

function readBody(req, limit = 12 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('Payload too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Minimal multipart/form-data parser (fields + one file). */
function parseMultipart(buffer, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!m) throw new Error('Missing multipart boundary');
  const boundary = Buffer.from(`--${m[1] || m[2]}`);
  const fields = {};
  let file = null;
  let pos = buffer.indexOf(boundary);
  while (pos !== -1) {
    const start = pos + boundary.length;
    if (buffer.slice(start, start + 2).toString() === '--') break;
    const next = buffer.indexOf(boundary, start);
    if (next === -1) break;
    const part = buffer.slice(start + 2, next - 2); // strip leading CRLF and trailing CRLF
    const split = part.indexOf('\r\n\r\n');
    const head = part.slice(0, split).toString('utf8');
    const content = part.slice(split + 4);
    const name = /name="([^"]*)"/i.exec(head)?.[1];
    const filename = /filename="([^"]*)"/i.exec(head)?.[1];
    if (filename !== undefined) file = { name, filename, content, type: /content-type:\s*([^\r\n]+)/i.exec(head)?.[1] };
    else if (name) fields[name] = content.toString('utf8');
    pos = next;
  }
  return { fields, file };
}

function lambdaEvent(req, url, params, body) {
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) headers[k] = Array.isArray(v) ? v.join(',') : v;
  return {
    body: body.length ? body.toString('utf8') : null,
    headers,
    multiValueHeaders: {},
    httpMethod: req.method,
    isBase64Encoded: false,
    path: url.pathname,
    pathParameters: Object.keys(params).length ? params : null,
    queryStringParameters: url.searchParams.size ? Object.fromEntries(url.searchParams) : null,
    multiValueQueryStringParameters: null,
    stageVariables: null,
    requestContext: { identity: { sourceIp: req.socket.remoteAddress || '127.0.0.1' } },
    resource: url.pathname,
  };
}

async function handleMock(req, res, url) {
  if (url.pathname === '/__mock/health') return send(res, 200, { ok: true, users: store.users.size, projects: store.projects.size, thumbnails: blobs.size });
  if (url.pathname === '/__mock/outbox' && req.method === 'GET') {
    const to = (url.searchParams.get('to') || '').trim().toLowerCase();
    return send(res, 200, { mails: to ? outbox.filter(m => m.to === to) : outbox });
  }
  if (url.pathname === '/__mock/reset' && req.method === 'POST') {
    store = new MemoryStore();
    blobs.clear();
    outbox.length = 0;
    install();
    if (SEED) await seed();
    persistSoon();
    return send(res, 200, { ok: true });
  }
  if (url.pathname === '/__mock/s3' && req.method === 'POST') {
    const body = await readBody(req);
    let form;
    try {
      form = parseMultipart(body, req.headers['content-type']);
    } catch (e) {
      return send(res, 400, Buffer.from('<Error><Code>MalformedPOSTRequest</Code></Error>'), { 'Content-Type': 'application/xml' });
    }
    const { fields, file } = form;
    const fail = (code, status = 403) => send(res, status, Buffer.from(`<Error><Code>${code}</Code></Error>`), { 'Content-Type': 'application/xml' });
    if (!fields.key || !fields.key.startsWith('thumbs/') || fields.policy !== 'mock-policy') return fail('AccessDenied');
    if (fields['Content-Type'] !== THUMB_CONTENT_TYPE) return fail('AccessDenied');
    if (!file || !file.content.length) return fail('InvalidArgument', 400);
    if (file.content.length > THUMB_MAX_BYTES) return fail('EntityTooLarge', 400);
    blobs.set(fields.key, file.content);
    persistSoon();
    return send(res, 204, null);
  }
  const thumb = /^\/__mock\/(thumbs\/.+)$/.exec(url.pathname);
  if (thumb && (req.method === 'GET' || req.method === 'HEAD')) {
    const data = blobs.get(decodeURIComponent(thumb[1]));
    if (!data) return send(res, 404, Buffer.from('Not found'), { 'Content-Type': 'text/plain' });
    return send(res, 200, req.method === 'HEAD' ? Buffer.alloc(0) : data, { 'Content-Type': THUMB_CONTENT_TYPE, 'Cache-Control': 'public, max-age=31536000, immutable' });
  }
  return send(res, 404, { error: 'Not found' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, ORIGIN);
  const started = Date.now();
  res.on('finish', () => {
    if (!QUIET && !url.pathname.startsWith('/__mock/thumbs')) console.log(`[mock-api] ${req.method} ${url.pathname}${url.search} -> ${res.statusCode} (${Date.now() - started} ms)`);
  });
  try {
    if (req.method === 'OPTIONS') return send(res, 204, null);
    if (url.pathname.startsWith('/__mock/')) return await handleMock(req, res, url);

    if (LEGACY && await handleLegacy(req, res, url)) return;
    const route = ROUTES.find(([method, re]) => method === req.method && re.test(url.pathname));
    if (!route) {
      // API Gateway answers unknown routes with 403 "Missing Authentication Token"
      return send(res, ROUTES.some(([, re]) => re.test(url.pathname)) ? 405 : 403, { message: 'Missing Authentication Token' });
    }
    const params = route[1].exec(url.pathname).groups || {};
    const body = await readBody(req);
    if (body.length > 10 * 1024 * 1024) return send(res, 413, { message: 'Request Too Long' });
    const result = await handlers[route[2]](lambdaEvent(req, url, params, body));
    if (req.method !== 'GET') persistSoon();
    res.writeHead(result.statusCode, { ...CORS, ...Object.fromEntries(Object.entries(result.headers || {}).map(([k, v]) => [k, String(v)])) });
    res.end(result.body);
  } catch (err) {
    console.error('[mock-api] error:', err);
    if (!res.headersSent) send(res, err.status || 500, { message: err.message || 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// --legacy: the 1.x API (what production runs until the 2.0 backend is deployed)
// ---------------------------------------------------------------------------

/** Run a 2.0 handler with a rewritten JSON body; returns { status, data }. */
async function runHandler(name, req, url, params, bodyObj) {
  const body = Buffer.from(bodyObj === undefined ? '' : JSON.stringify(bodyObj));
  const r = await handlers[name](lambdaEvent(req, url, params, body));
  let data = null;
  try { data = JSON.parse(r.body); } catch (e) { data = null; }
  return { status: r.statusCode, data };
}

/** Handles the routes that differ on 1.x; false = fall through to the 2.0 handlers. */
async function handleLegacy(req, res, url) {
  const p = url.pathname;
  const m = req.method;
  // Resources 1.x doesn't have: API Gateway's answer, and no CORS headers on it
  if (/^\/api\/users(\/|$)/.test(p) || /^\/api\/projects\/[^/]+\/(view|thumbnail)$/.test(p) || /^\/api\/auth\/(verify-email|resend-verification)$/.test(p)) {
    res.writeHead(403, { 'Content-Type': 'application/json', 'x-amzn-errortype': 'MissingAuthenticationTokenException' });
    res.end(JSON.stringify({ message: 'Missing Authentication Token' }));
    return true;
  }
  // /api/projects/{id} with id=public
  if (m === 'GET' && p === '/api/projects/public') {
    send(res, 404, { error: 'Project not found' });
    return true;
  }
  const json = async () => { try { return JSON.parse((await readBody(req)).toString('utf8') || '{}'); } catch (e) { return {}; } };
  const reply = (status, data) => { send(res, status, data); persistSoon(); return true; };
  let mm;
  if (m === 'GET' && p === '/api/projects') {
    const { status, data } = await runHandler('projects/list', req, url, {}, undefined);
    if (status !== 200) return reply(status, data);
    return reply(200, { projects: (data.projects || []).map(x => ({ id: x.id, name: x.name, createdAt: x.createdAt, updatedAt: x.updatedAt })) });
  }
  if (m === 'POST' && p === '/api/projects') {
    const { visibility, isPublic = false, forkedFrom, ...rest } = await json();
    const { status, data } = await runHandler('projects/save', req, url, {}, { ...rest, visibility: isPublic ? 'unlisted' : 'private' });
    if (status >= 300) return reply(status, data);
    return reply(status, { id: data.id, name: data.name, username: data.username, createdAt: data.createdAt, updatedAt: data.updatedAt });
  }
  if (m === 'GET' && (mm = /^\/api\/projects\/([^/]+)$/.exec(p))) {
    const { status, data } = await runHandler('projects/get', req, url, { id: decodeURIComponent(mm[1]) }, undefined);
    if (status !== 200) return reply(status, data);
    return reply(200, { id: data.id, name: data.name, username: data.username, data: data.data, isPublic: data.visibility !== 'private', isOwner: data.isOwner, createdAt: data.createdAt, updatedAt: data.updatedAt });
  }
  if (m === 'PUT' && (mm = /^\/api\/projects\/([^/]+)\/visibility$/.exec(p))) {
    const { isPublic } = await json();
    if (isPublic === undefined) return reply(400, { error: 'isPublic field is required' });
    const { status, data } = await runHandler('projects/toggle-visibility', req, url, { id: decodeURIComponent(mm[1]) }, { visibility: isPublic ? 'unlisted' : 'private' });
    if (status !== 200) return reply(status, data);
    return reply(200, { id: decodeURIComponent(mm[1]), isPublic: Boolean(isPublic), updatedAt: new Date().toISOString() });
  }
  return false;
}

// ---------------------------------------------------------------------------
// Seed data
// ---------------------------------------------------------------------------

async function call(name, { body, token, params = {} } = {}) {
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  const r = await handlers[name]({ body: body ? JSON.stringify(body) : null, headers, pathParameters: params, queryStringParameters: null, requestContext: { identity: { sourceIp: '127.0.0.1' } } });
  const data = JSON.parse(r.body);
  if (r.statusCode >= 300) throw new Error(`${name}: ${data.error}`);
  return data;
}

async function seed() {
  const accounts = [
    { username: 'ada', email: 'ada@example.com', displayName: 'Ada L.' },
    { username: 'grace', email: 'grace@example.com', displayName: 'Grace H.' },
  ];
  const tokens = {};
  // Through the real email-verification sign-up (the seed mails are dropped from the outbox)
  mailLog = false;
  for (const a of accounts) {
    await call('auth/register', { body: { email: a.email, username: a.username, password: 'patchtoy123' } });
    const mail = [...outbox].reverse().find(m => m.to === a.email && m.kind === 'verify');
    const r = mail
      ? await call('auth/verify-email', { body: { token: mail.token } })
      : await call('auth/login', { body: { login: a.email, password: 'patchtoy123' } }); // SIGNUP_VERIFICATION=off
    tokens[a.username] = (await call('users/update-me', { token: r.token, body: { displayName: a.displayName } })).token;
  }
  outbox.length = 0;
  store.security.clear(); // the seed's rate-limit counters (127.0.0.1, per-address mail limits)
  mailLog = true;
  const dir = path.join(ROOT, 'projects');
  // Curated demos first (same order as the demo gallery), then any other real demo
  const curated = ['prism-drift', 'hyperbolic-lanterns', 'aurora-fjord', 'kaleido-tunnel', 'molten-orbit', 'liquid-chrome', 'infinite-temple', 'vection'];
  const all = fs.readdirSync(dir).filter(f => f.endsWith('.patchtoy.json') && !/^(e2e|test|debug|tmp)/i.test(f));
  const rank = (f) => { const i = curated.indexOf(f.replace(/\.patchtoy\.json$/, '')); return i === -1 ? curated.length : i; };
  const files = all.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b)).slice(0, 6);
  let i = 0;
  for (const file of files) {
    let data;
    try {
      data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    } catch (e) {
      continue; // a demo being rewritten right now
    }
    const owner = accounts[i++ % accounts.length].username;
    const slug = file.replace(/\.patchtoy\.json$/, '');
    const name = data.name || slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    const { name: _n, description, ...rest } = data;
    try {
      const p = await call('projects/save', { token: tokens[owner], body: { name, description: String(description || '').slice(0, 500), data: rest, visibility: 'public' } });
      const jpg = path.join(dir, 'thumbs', `${slug}.jpg`);
      if (fs.existsSync(jpg) && fs.statSync(jpg).size <= THUMB_MAX_BYTES) {
        const t = await call('projects/thumbnail', { token: tokens[owner], params: { id: p.id } });
        blobs.set(t.upload.fields.key, fs.readFileSync(jpg));
      }
    } catch (e) {
      console.warn(`[mock-api] seed skipped ${file}: ${e.message}`);
    }
  }
  console.log(`[mock-api] seeded users ada / grace (password "patchtoy123") and ${store.projects.size} public projects`);
}

if (!loadPersisted() && SEED) await seed();

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock-api] PatchToy mock API${LEGACY ? ' (1.x mode: --legacy)' : ''} on ${ORIGIN}  (open the app with ?api=${ORIGIN})`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    server.close();
    process.exit(0);
  });
}
