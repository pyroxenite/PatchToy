/**
 * Social link previews (edge/social-preview.ts): escaping, privacy, fallbacks.
 * The "API" is the real projects/get and users/get handlers on the in-memory store.
 */
import { test, describe, beforeEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { fresh, event, json, projectData, signupVerified } from './helpers';
import { Mail } from '../shared/mailer';
import * as save from '../projects/save';
import * as getProject from '../projects/get';
import * as visibility from '../projects/toggle-visibility';
import * as getUser from '../users/get';
import * as updateMe from '../users/update-me';
import {
  createHandler, injectMeta, routeOf, escapeHtml, safeImage, genericMeta, PreviewConfig, GENERIC_TITLE,
} from '../edge/social-preview';

const SITE = 'https://patchtoy.test';
const API = 'https://api.patchtoy.test/prod';
const INDEX = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>PatchToy — Node-based GLSL shader playground</title>
    <meta name="description" content="PatchToy is a node-based GLSL shader editor.">
    <meta property="og:title" content="PatchToy">
    <meta property="og:description" content="Patch GLSL shaders together like a modular synth, with live WebGL previews.">
    <link rel="stylesheet" href="/style.css">
</head>
<body><div id="app"></div><script type="module" src="/assets/index-abc.js"></script></body>
</html>`;

const cfg = (extra: Partial<PreviewConfig> = {}): PreviewConfig => ({ apiUrl: API, siteUrl: SITE, ...extra });

let outbox: Mail[];
let calls: string[];

/** fetch() stand-in: index.html from the "site", /api/* from the real handlers. */
function fakeFetch({ indexStatus = 200, hang = false }: { indexStatus?: number; hang?: boolean } = {}) {
  return async (url: string, init?: { signal?: AbortSignal }) => {
    calls.push(url);
    if (url === `${SITE}/index.html`) return new Response(INDEX, { status: indexStatus });
    if (hang) {
      return new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
    }
    const path = url.slice(API.length);
    let m = /^\/api\/projects\/([^/]+)$/.exec(path);
    let res;
    if (m) res = await getProject.handler(event({ path: { id: decodeURIComponent(m[1]) } }));
    else if ((m = /^\/api\/users\/([^/]+)$/.exec(path))) res = await getUser.handler(event({ path: { username: decodeURIComponent(m[1]) } }));
    else return new Response('{"message":"Missing Authentication Token"}', { status: 403 });
    return new Response(res.body, { status: res.statusCode });
  };
}

function cfEvent(uri: string, method = 'GET'): any {
  return { Records: [{ cf: { config: {}, request: { uri, method, querystring: '', headers: {}, clientIp: '203.0.113.1' } } }] };
}

async function run(uri: string, options: Partial<PreviewConfig> = {}, fetchOpts = {}) {
  const handler = createHandler(cfg(options), { fetchImpl: fakeFetch(fetchOpts) as any });
  return handler(cfEvent(uri)) as Promise<any>;
}

const metaContent = (html: string, attr: string, key: string) => {
  const m = new RegExp(`<meta ${attr}="${key.replace(/[:]/g, '\\:')}" content="([^"]*)">`).exec(html);
  return m ? m[1] : null;
};

async function owner(username = 'alice') {
  return signupVerified(outbox, { email: `${username}@example.com`, username, password: 'correct horse' });
}

async function project(token: string, body: Record<string, any> = {}) {
  const r = await save.handler(event({ token, body: { name: 'Prism Drift', data: projectData(3), ...body } }));
  assert.equal(r.statusCode, 201, r.body);
  return json(r);
}

beforeEach(() => {
  ({ outbox } = fresh());
  calls = [];
});

describe('social previews: routes and helpers', () => {
  test('only /p/<id> and /u/<name> with valid ids are handled', () => {
    assert.deepEqual(routeOf('/p/1234-abcd'), { kind: 'project', id: '1234-abcd' });
    assert.deepEqual(routeOf('/u/Alice/'), { kind: 'user', username: 'Alice' });
    for (const bad of ['/', '/index.html', '/p/', '/p/a/b', '/p/%E0%A4%A', '/p/<x>', '/u/ab', '/u/a%20b', '/explore', '/assets/x.js']) {
      assert.equal(routeOf(bad), null, bad);
    }
  });

  test('escaping: every injected value is inert', () => {
    assert.equal(escapeHtml(`"><script>x</script>'&\``), '&quot;&gt;&lt;script&gt;x&lt;/script&gt;&#39;&amp;&#96;');
    const html = injectMeta(INDEX, { title: '"><script>alert(1)</script>', description: "</title><img src=x onerror=alert(2)>", url: `${SITE}/p/x"y`, image: null, type: 'article' });
    assert.ok(!html.includes('<script>alert'), 'no live script');
    assert.ok(!html.includes('<img src=x'), 'no live tag');
    assert.ok(html.includes('&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;'));
    // The original tags are replaced, not duplicated
    assert.equal((html.match(/<title>/g) || []).length, 1);
    assert.equal((html.match(/property="og:title"/g) || []).length, 1);
    assert.equal((html.match(/name="description"/g) || []).length, 1);
    assert.ok(html.includes('<script type="module" src="/assets/index-abc.js"></script>'), 'the app still boots');
  });

  test('images must be https (and on the thumbnails CDN when configured)', () => {
    assert.equal(safeImage('javascript:alert(1)'), null);
    assert.equal(safeImage('http://cdn.test/a.jpg'), null);
    assert.equal(safeImage('https://user:pw@cdn.test/a.jpg'), null);
    assert.equal(safeImage('https://cdn.test/a.jpg'), 'https://cdn.test/a.jpg');
    assert.equal(safeImage('https://evil.test/a.jpg', ['https://cdn.test']), null);
    assert.equal(safeImage('https://cdn.test/thumbs/a.jpg', ['https://cdn.test']), 'https://cdn.test/thumbs/a.jpg');
  });
});

describe('social previews: projects', () => {
  test('a public project: title, author, description, thumbnail, url, large card', async () => {
    const alice = await owner();
    const p = await project(alice.token, { visibility: 'public', description: 'Spectral <b>bands</b> & "drift"' });
    // A thumbnail on an https CDN (the test blob store serves http://blobs.test)
    const res0 = await run(`/p/${p.id}`);
    assert.equal(res0.status, '200');
    const html = res0.body as string;
    assert.equal(metaContent(html, 'property', 'og:title'), 'Prism Drift by @alice');
    assert.equal(metaContent(html, 'property', 'og:description'), 'Spectral &lt;b&gt;bands&lt;/b&gt; &amp; &quot;drift&quot;');
    assert.equal(metaContent(html, 'property', 'og:url'), `${SITE}/p/${p.id}`);
    assert.ok(html.includes('<title>Prism Drift by @alice · PatchToy</title>'));
    assert.equal(metaContent(html, 'name', 'robots'), null, 'public projects may be indexed');
    assert.match(res0.headers['cache-control'][0].value, /max-age=300/);
    assert.match(res0.headers['content-type'][0].value, /text\/html/);
  });

  test('the thumbnail becomes og:image with summary_large_image', async () => {
    const handler = createHandler(cfg({ imageOrigins: ['https://cdn.test'] }), {
      fetchImpl: (async (url: string) => {
        if (url.endsWith('/index.html')) return new Response(INDEX, { status: 200 });
        return new Response(JSON.stringify({ id: 'p1', name: 'Neon', username: 'bob', isPublic: true, visibility: 'public', nodeCount: 4, thumbUrl: 'https://cdn.test/thumbs/p1/a.jpg' }), { status: 200 });
      }) as any,
    });
    const html = (await handler(cfEvent('/p/p1')) as any).body;
    assert.equal(metaContent(html, 'property', 'og:image'), 'https://cdn.test/thumbs/p1/a.jpg');
    assert.equal(metaContent(html, 'name', 'twitter:card'), 'summary_large_image');
    assert.equal(metaContent(html, 'name', 'twitter:image'), 'https://cdn.test/thumbs/p1/a.jpg');
    assert.equal(metaContent(html, 'property', 'og:description'), 'A 4-node shader patch by @bob on PatchToy. Open it to watch it live and remix it.');
  });

  test('private projects never leak: generic tags, nothing from the project', async () => {
    const alice = await owner();
    const p = await project(alice.token, { name: 'Top Secret Sketch', description: 'confidential' });
    const res = await run(`/p/${p.id}`);
    assert.equal(res.status, '200');
    assert.ok(!res.body.includes('Top Secret') && !res.body.includes('confidential') && !res.body.includes('@alice'));
    assert.ok(res.body.includes(`<title>${GENERIC_TITLE}</title>`));
    assert.match(res.headers['cache-control'][0].value, /max-age=60/, 'generic pages are cached briefly');

    // Published, previewed, then made private: a fresh edge container shows nothing
    await visibility.handler(event({ token: alice.token, path: { id: p.id }, body: { visibility: 'public' } }));
    assert.ok((await run(`/p/${p.id}`)).body.includes('Top Secret Sketch'));
    await visibility.handler(event({ token: alice.token, path: { id: p.id }, body: { visibility: 'private' } }));
    assert.ok(!(await run(`/p/${p.id}`)).body.includes('Top Secret'));
  });

  test('even an API answer that says private (or not link-readable) is not previewed', async () => {
    for (const card of [
      { name: 'Leak', username: 'x', isPublic: false, visibility: 'private' },
      { name: 'Leak', username: 'x', isPublic: true, visibility: 'private' },
      { name: 'Leak', username: 'x', isPublic: false, visibility: 'public' },
      { name: 'Leak', username: 'x' },
    ]) {
      const handler = createHandler(cfg(), {
        fetchImpl: (async (url: string) => url.endsWith('/index.html') ? new Response(INDEX, { status: 200 }) : new Response(JSON.stringify(card), { status: 200 })) as any,
      });
      const html = (await handler(cfEvent('/p/abc')) as any).body;
      assert.ok(!html.includes('Leak'), JSON.stringify(card));
    }
  });

  test('unlisted projects: previewed by default with noindex; off with unlisted: false', async () => {
    const alice = await owner();
    const p = await project(alice.token, { name: 'Link Only Loop', visibility: 'unlisted' });
    const on = await run(`/p/${p.id}`);
    assert.equal(metaContent(on.body, 'property', 'og:title'), 'Link Only Loop by @alice');
    assert.equal(metaContent(on.body, 'name', 'robots'), 'noindex');
    const off = await run(`/p/${p.id}`, { unlisted: false });
    assert.ok(!off.body.includes('Link Only Loop'));
  });

  test('timeout: generic tags within the budget, and the next request retries soon', async () => {
    const t = Date.now();
    const res = await run('/p/slow-project', { timeoutMs: 150 }, { hang: true });
    const elapsed = Date.now() - t;
    assert.ok(elapsed < 1000, `answered in ${elapsed} ms`);
    assert.equal(res.status, '200');
    assert.ok(res.body.includes(`<title>${GENERIC_TITLE}</title>`));
  });

  test('API errors give the generic tags; no index.html lets the request through to S3', async () => {
    const handler = createHandler(cfg(), {
      fetchImpl: (async (url: string) => url.endsWith('/index.html') ? new Response(INDEX, { status: 200 }) : new Response('oops', { status: 502 })) as any,
    });
    const res = await handler(cfEvent('/p/abc')) as any;
    assert.ok(res.body.includes(`<title>${GENERIC_TITLE}</title>`));

    const passthrough = await run('/p/abc', {}, { indexStatus: 500 });
    assert.equal(passthrough.uri, '/p/abc', 'the original request continues to the origin');
    assert.equal(passthrough.status, undefined);
  });

  test('other paths, other methods and a missing config pass through untouched', async () => {
    for (const uri of ['/', '/explore/community', '/assets/index.js', '/p/<bad>']) {
      assert.equal((await run(uri)).uri, uri);
    }
    assert.equal(calls.length, 0, 'no fetch for paths that are not previews');
    const handler = createHandler(cfg(), { fetchImpl: fakeFetch() as any });
    assert.equal(((await handler(cfEvent('/p/abc', 'POST'))) as any).uri, '/p/abc');
    assert.equal(((await createHandler(null)(cfEvent('/p/abc'))) as any).uri, '/p/abc');
  });

  test('results are cached per container', async () => {
    const alice = await owner();
    const p = await project(alice.token, { visibility: 'public' });
    const handler = createHandler(cfg(), { fetchImpl: fakeFetch() as any });
    await handler(cfEvent(`/p/${p.id}`));
    await handler(cfEvent(`/p/${p.id}`));
    assert.equal(calls.filter(u => u.includes('/api/projects/')).length, 1);
    assert.equal(calls.filter(u => u.endsWith('/index.html')).length, 1);
  });
});

describe('social previews: user pages', () => {
  test('display name, handle, public project count; never an email or a private project', async () => {
    const alice = await owner();
    await updateMe.handler(event({ token: alice.token, body: { displayName: 'Alice <Liddell>' } }));
    await project(alice.token, { name: 'Shown', visibility: 'public' });
    await project(alice.token, { name: 'Hidden Private Thing' });
    await project(alice.token, { name: 'Hidden Unlisted Thing', visibility: 'unlisted' });
    const res = await run('/u/alice');
    assert.equal(metaContent(res.body, 'property', 'og:title'), 'Alice &lt;Liddell&gt; (@alice)');
    assert.equal(metaContent(res.body, 'property', 'og:description'), 'Shader patches by @alice on PatchToy · 1 public project.');
    assert.equal(metaContent(res.body, 'property', 'og:url'), `${SITE}/u/alice`);
    assert.equal(metaContent(res.body, 'property', 'og:type'), 'profile');
    assert.ok(!res.body.includes('example.com') && !res.body.includes('Hidden'));
  });

  test('unknown users get the generic tags', async () => {
    const res = await run('/u/nobody-here');
    assert.ok(res.body.includes(`<title>${GENERIC_TITLE}</title>`));
    assert.deepEqual(genericMeta(cfg()).url, `${SITE}/`);
  });
});
