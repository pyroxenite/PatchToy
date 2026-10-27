#!/usr/bin/env node
/**
 * End-to-end test of the community features in headless Chrome, against the
 * local mock API (scripts/mock-api.mjs). No AWS involved.
 *
 *   node scripts/e2e-community.mjs [--out <screenshot dir>] [--app http://localhost:5291] [--keep]
 *
 * Starts the mock API (port 8797) and, unless --app is given, a private Vite dev
 * server on port 5291 with HMR off. Flow:
 *   sign-up with email verification (check-your-email state, unconfirmed sign-in fails
 *   generically, resend, the link from the mock mailer signs in and leaves the URL, a
 *   reused link is refused, an existing address gets the same answer) ->
 *   alice registers -> opens a JS demo (trust prompt) -> saves to the cloud (thumbnail
 *   uploaded) -> makes it public; bob registers -> finds it in Community -> opens it
 *   (trust prompt, read-only banner) -> saves a copy (fork) -> visits alice's page;
 *   an anonymous visitor opens the share link, and a private project's link;
 *   user-provided text is escaped; offline state; back/forward routing.
 *   The top bar Open button / ⌘O (popover on My projects; tab order My projects, Community,
 *   Demos; Esc / outside click close it; ⇧⌘O imports a file), and a 1.x backend
 *   (mock-api --legacy on the next port): Share by link works, Publish to Community is
 *   disabled, Community shows its "not available yet" state.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true);
};
const OUT = path.resolve(arg('out', path.join(ROOT, 'e2e-community-out')));
const API_PORT = Number(arg('api-port', 8797));
const API = `http://localhost:${API_PORT}`;
const APP_PORT = Number(arg('app-port', 5291));
let APP = arg('app', null);
fs.mkdirSync(OUT, { recursive: true });

const results = [];
let failed = 0;
async function step(name, fn) {
  const t = Date.now();
  try {
    await fn();
    results.push(`  ✔ ${name} (${Date.now() - t} ms)`);
    console.log(results[results.length - 1]);
  } catch (err) {
    failed++;
    results.push(`  ✖ ${name}: ${err.message.split('\n')[0]}`);
    console.log(results[results.length - 1]);
    throw err;
  }
}
function assert(cond, message) {
  if (!cond) throw new Error(`assertion failed: ${message}`);
}

// ---------------------------------------------------------------- servers
const children = [];
async function waitFor(url, ms = 60000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch (e) { /* not up yet */ }
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error(`timeout waiting for ${url}`);
}

// Links in the mock's mails point at the app under test
const mock = spawn(process.execPath, [path.join(ROOT, 'scripts/mock-api.mjs'), '--port', String(API_PORT), '--seed', '--quiet'], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, FRONTEND_URL: APP || `http://localhost:${APP_PORT}` },
});
children.push(mock);
mock.stderr.on('data', d => process.stderr.write(`[mock] ${d}`));
await waitFor(`${API}/__mock/health`, 180000);

let vite = null;
if (!APP) {
  const { createServer } = await import('vite');
  vite = await createServer({ root: ROOT, configFile: path.join(ROOT, 'vite.config.js'), server: { port: APP_PORT, strictPort: true, hmr: false }, logLevel: 'error' });
  await vite.listen();
  APP = `http://localhost:${APP_PORT}`;
}

async function shutdown() {
  for (const c of children) c.kill('SIGTERM');
  await vite?.close();
}

// ---------------------------------------------------------------- browser
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
});

const pageErrors = [];
async function newUser(label) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: APP });
  const page = await context.newPage();
  page.on('pageerror', e => pageErrors.push(`${label}: ${e.message}`));
  page.on('dialog', async d => {
    pageErrors.push(`${label}: unexpected native dialog "${d.message()}"`);
    await d.dismiss();
  });
  return { context, page };
}

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';
const url = (p) => `${APP}${p}${p.includes('?') ? '&' : '?'}api=${encodeURIComponent(API)}`;
const shot = (page, name) => page.screenshot({ path: path.join(OUT, name) });

/** Mails the mock API "sent" to an address (newest last). */
async function mailsTo(email) {
  return (await (await fetch(`${API}/__mock/outbox?to=${encodeURIComponent(email)}`)).json()).mails;
}

async function fillSignup(page, email, username, password = 'correct horse battery') {
  await page.click('#accountBtn');
  await page.getByText('Create an account').click();
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.locator('.pt-modal', { hasText: 'Check your email' }).waitFor();
}

/** Sign up through the dialog, then open the verification link from the mock mailer. */
async function register(page, username) {
  const email = `${username}@example.com`;
  await fillSignup(page, email, username);
  const mail = (await mailsTo(email)).filter(m => m.kind === 'verify').pop();
  assert(mail && mail.link, `verification mail for ${email}`);
  await page.goto(mail.link, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction((u) => window.toy?.apiClient?.getCurrentUser()?.username === u, username);
  await page.waitForFunction(() => window.toy?.community);
}

async function answerTrustPrompt(page, choice) {
  const dialog = page.locator('.pt-modal', { hasText: 'contains JavaScript nodes' });
  await dialog.waitFor({ timeout: 15000 });
  await dialog.getByRole('button', { name: choice }).click();
  await dialog.waitFor({ state: 'detached' });
}

/** The project browser on a tab: the top bar Open button (popover) unless one is open already. */
async function openExplore(page, tab) {
  if (!(await page.locator('.pt-modal--browser').count())) {
    await page.click('#openBtn');
    await page.locator('.pt-modal--browser.pb-popover').waitFor();
  }
  await page.locator(`.pb-tab[data-view="${tab}"]`).click();
  await page.waitForFunction(() => !document.querySelector('.pt-modal--browser .pb-skeleton'));
}

const browserState = (page) => page.evaluate(() => {
  const b = window.toy.projectBrowser;
  return {
    open: b.isOpen(),
    popover: b.isPopover(),
    view: b.view,
    tabs: [...document.querySelectorAll('.pb-tab')].map(t => t.dataset.view),
    path: location.pathname,
    focus: document.activeElement?.id || '',
  };
});

let projectId = null;
let secretId = null;

try {
  const alice = await newUser('alice');
  const bob = await newUser('bob');
  const anon = await newUser('anon');

  await step('sign-up with email verification: check your email, unconfirmed sign-in fails generically, resend', async () => {
    const { page } = await newUser('carol');
    await page.goto(url('/'), { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.toy?.community);
    await fillSignup(page, 'carol@example.com', 'carol');
    assert(!(await page.evaluate(() => window.toy.apiClient.isLoggedIn())), 'not signed in before verification');
    const dialog = page.locator('.pt-modal', { hasText: 'Check your email' });
    assert((await dialog.innerText()).includes('carol@example.com'), 'names the address');
    assert(await dialog.getByRole('button', { name: /Resend email/ }).isDisabled(), 'resend cools down after the first mail');
    await page.waitForTimeout(400);
    await shot(page, '00a-signup-check-email.png');
    const mails = await mailsTo('carol@example.com');
    assert(mails.length === 1 && mails[0].kind === 'verify', `one verification mail (${mails.length})`);

    // Signing in before confirming: the generic failure, plus the resend path
    await dialog.getByRole('button', { name: 'Back to sign in' }).click();
    await page.getByLabel('Email or username').fill('carol');
    await page.getByLabel('Password').fill('correct horse battery');
    await page.getByRole('button', { name: 'Sign in' }).click();
    const login = page.locator('.pt-modal', { hasText: 'Welcome back' });
    await login.locator('.pt-form-error', { hasText: 'Confirm your email first' }).waitFor();
    await login.getByText('Didn’t confirm your email?').click();
    const resend = page.locator('.pt-modal', { hasText: 'Signed up but lost the email' });
    await resend.getByLabel('Email').fill('carol@example.com');
    await resend.getByRole('button', { name: 'Send link' }).click();
    await resend.getByText('If a sign-up is waiting for that address').waitFor();
    await shot(page, '00b-signup-resend.png');
    // Within a minute of the first mail: same answer, no second mail (per-address limit)
    assert((await mailsTo('carol@example.com')).length === 1, 'resend is rate limited per address');
    await page.keyboard.press('Escape');
  });

  await step('the emailed link signs in; the token leaves the URL before any request; a reused link is refused', async () => {
    const { page } = await newUser('carol-link');
    // The same browser that started the sign-up remembers the mock API (?api=); here a fresh one does it first
    await page.goto(url('/'), { waitUntil: 'domcontentloaded' });
    const { link, token } = (await mailsTo('carol@example.com')).pop();
    assert(new URL(link).hash.startsWith('#verify='), `link in the fragment: ${link}`);
    const requests = [];
    page.on('request', r => requests.push({ url: r.url(), referer: r.headers().referer || '' }));
    await page.goto(link, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.toy?.apiClient?.getCurrentUser()?.username === 'carol');
    await page.waitForSelector('.pt-toast:has-text("Welcome, @carol")');
    assert(!(await page.evaluate(() => location.href)).includes(token), 'token stripped from the URL');
    assert(!(await page.evaluate(() => location.hash)).includes('verify'), 'no #verify left');
    const leaks = requests.filter(r => r.url.includes(token) || r.referer.includes(token));
    assert(!leaks.length, `token sent in ${leaks.map(r => r.url).join(', ')}`);
    const foreign = requests.filter(r => { const o = new URL(r.url).origin; return o !== new URL(APP).origin && o !== new URL(API).origin && !r.url.startsWith('data:') && !r.url.startsWith('blob:'); });
    assert(!foreign.length, `third-party requests: ${foreign.map(r => r.url).join(', ')}`);
    const verifyCalls = requests.filter(r => r.url.endsWith('/api/auth/verify-email'));
    assert(verifyCalls.length === 1, 'one verify-email call');
    await page.waitForTimeout(300);
    await shot(page, '00c-signup-verified.png');

    // The same link again (another browser): refused, with the way forward
    const { page: again } = await newUser('carol-reuse');
    await again.goto(url('/'), { waitUntil: 'domcontentloaded' });
    await again.goto(link, { waitUntil: 'domcontentloaded' });
    const expired = again.locator('.pt-modal', { hasText: 'Sign-up link expired' });
    await expired.waitFor({ timeout: 15000 });
    assert(await expired.getByRole('button', { name: 'Send a new link' }).count(), 'offers a new link');
    assert(!(await again.evaluate(() => window.toy.apiClient.isLoggedIn())), 'not signed in');
    await again.waitForTimeout(500);
    await shot(again, '00d-signup-link-reused.png');
  });

  await step('signing up with an address that has an account looks the same; its owner gets a notice', async () => {
    const { page } = await newUser('dup');
    await page.goto(url('/'), { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.toy?.community);
    await fillSignup(page, 'ada@example.com', 'not-ada', 'some other password');
    const text = await page.locator('.pt-modal', { hasText: 'Check your email' }).innerText();
    assert(text.includes('We sent a link to ada@example.com'), 'same check-your-email state');
    const mails = await mailsTo('ada@example.com');
    assert(mails.length === 1 && mails[0].kind === 'notice' && !mails[0].link, `notice, no link (${JSON.stringify(mails.map(m => m.kind))})`);
    const r = await (await fetch(`${API}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login: 'ada', password: 'patchtoy123' }) })).json();
    assert(r.username === 'ada', 'the existing account is unchanged');
  });

  await step('alice registers through the sign-up dialog', async () => {
    await alice.page.goto(url('/'), { waitUntil: 'domcontentloaded' });
    await alice.page.waitForFunction(() => window.toy?.community);
    await register(alice.page, 'alice');
  });

  await step('Open button: a popover on My projects (tabs: My projects, Community, Demos); Esc, outside click, ⌘O, ⇧⌘O', async () => {
    const page = alice.page;
    const before = new URL(page.url()).pathname;
    await page.click('#openBtn');
    await page.locator('.pt-modal--browser.pb-popover').waitFor();
    let st = await browserState(page);
    assert(st.popover && st.view === 'mine', `popover on My projects (${JSON.stringify(st)})`);
    assert(st.tabs.join(',') === 'mine,community,demos', `tab order ${st.tabs}`);
    assert(st.path === before, `the popover leaves the URL alone (${st.path})`);
    await page.waitForTimeout(250); // the pop-in animation scales it
    const box = await page.locator('.pb-popover').boundingBox();
    const btn = await page.locator('#openBtn').boundingBox();
    assert(Math.abs(box.y - (btn.y + btn.height + 6)) <= 2 && box.width <= 860 && box.height <= 620, `anchored under the button ${JSON.stringify(box)}`);
    assert(!(await page.evaluate(() => getComputedStyle(document.querySelector('.pb-popover-host')).backgroundColor !== 'rgba(0, 0, 0, 0)')), 'no dimmed backdrop');
    await page.keyboard.press('Escape');
    st = await browserState(page);
    assert(!st.open && st.focus === 'openBtn', `Esc closes, focus back on Open (${JSON.stringify(st)})`);
    // ⌘O opens it on My projects; a click outside closes it
    await page.mouse.click(900, 700);
    await page.keyboard.press(`${MOD}+o`);
    await page.locator('.pt-modal--browser.pb-popover').waitFor();
    assert((await browserState(page)).view === 'mine', '⌘O opens My projects');
    await page.mouse.click(1300, 800);
    assert(!(await browserState(page)).open, 'outside click closes it');
    // ⇧⌘O: the file import dialog
    const chooser = page.waitForEvent('filechooser', { timeout: 5000 });
    await page.keyboard.press(`${MOD}+Shift+o`);
    await chooser;
  });

  await step('gallery Demos tab lists the bundled demos', async () => {
    await openExplore(alice.page, 'demos');
    await alice.page.waitForSelector('.dg-card[data-slug="js-clock-sky"]:not(.is-pending)');
    assert((await browserState(alice.page)).popover, 'in the popover');
    await alice.page.waitForTimeout(800);
    await shot(alice.page, '01-gallery-demos.png');
  });

  await step('alice opens a demo with a JS node: trust prompt, then runs it', async () => {
    await alice.page.click('.dg-card[data-slug="js-clock-sky"]');
    await answerTrustPrompt(alice.page, 'Run');
    await alice.page.waitForFunction(() => window.toy.nodeGraph.nodes.some(n => n.isJSNode && n.trust === 'trusted'));
  });

  await step('alice saves to the cloud; a JPEG thumbnail is captured and uploaded', async () => {
    await alice.page.evaluate(() => { window.__thumb = new Promise(r => window.addEventListener('patchtoy:thumbnail', e => r(e.detail), { once: true })); });
    await alice.page.waitForTimeout(1500); // let the shader render a few frames
    await alice.page.click('#saveCloudBtn');
    await alice.page.waitForFunction(() => window.toy.projectManager.projectState.source === 'cloud');
    const detail = await alice.page.evaluate(() => Promise.race([window.__thumb, new Promise(r => setTimeout(() => r(null), 15000))]));
    assert(detail && detail.url, 'thumbnail uploaded');
    assert(detail.bytes > 2000 && detail.bytes < 140 * 1024, `thumbnail size ${detail.bytes}`);
    projectId = await alice.page.evaluate(() => window.toy.projectManager.projectState.projectId);
    assert(new URL(alice.page.url()).pathname === `/p/${projectId}`, `url after save ${alice.page.url()}`);
    const img = await fetch(detail.url);
    assert(img.ok && img.headers.get('content-type') === 'image/jpeg', 'thumbnail served');
    console.log(`    thumbnail: ${detail.bytes} bytes`);
  });

  await step('My projects: alice publishes the project to Community from the card menu', async () => {
    await openExplore(alice.page, 'mine');
    const card = alice.page.locator(`.pb-card[data-id="${projectId}"]`);
    await card.waitFor();
    assert((await card.locator('.pb-vis').innerText()).toLowerCase().includes('private'), 'starts private');
    await card.locator('.pb-card-menu').click();
    await alice.page.locator('.pt-menu.pb-menu .pt-menu-item', { hasText: 'Publish to Community' }).click();
    await alice.page.waitForFunction((id) => document.querySelector(`.pb-card[data-id="${id}"] .pb-vis.is-public`), projectId);
    await alice.page.waitForSelector(`.pb-card[data-id="${projectId}"] .dg-thumb.is-loaded img`);
    await alice.page.mouse.move(5, 5);
    await alice.page.waitForTimeout(400);
    await shot(alice.page, '03-gallery-my-projects.png');
  });

  await step('alice: user-provided text is escaped; a private project exists', async () => {
    const ids = await alice.page.evaluate(async () => {
      const api = window.toy.apiClient;
      const data = { version: '1.0', graph: { nodes: [{ id: 0, type: 'Preview', x: 0, y: 0, data: {} }], connections: [] }, customNodes: {} };
      const xss = await api.saveProject('<img src=x onerror="window.__xss=1">', data, { description: '<script>window.__xss=2</script>', visibility: 'public' });
      const secret = await api.saveProject('Secret sketch', data);
      return { xss: xss.id, secret: secret.id };
    });
    secretId = ids.secret;
    assert(ids.xss && ids.secret, 'created');
  });

  await step('bob registers and finds alice\'s project in Community (search by author)', async () => {
    await bob.page.goto(url('/'), { waitUntil: 'domcontentloaded' });
    await bob.page.waitForFunction(() => window.toy?.community);
    await register(bob.page, 'bob');
    await openExplore(bob.page, 'community');
    await bob.page.waitForSelector(`.pb-card[data-id="${projectId}"]`);
    // The hostile title renders as text
    const xss = bob.page.locator('.pb-card .dg-name', { hasText: '<img src=x' });
    await xss.waitFor();
    assert(await bob.page.evaluate(() => window.__xss === undefined), 'no script ran');
    await bob.page.waitForSelector(`.pb-card[data-id="${projectId}"] .dg-thumb.is-loaded img`);
    await bob.page.mouse.move(5, 5);
    await bob.page.waitForTimeout(300);
    await shot(bob.page, '02-gallery-community.png');

    await bob.page.fill('.pb-search input', 'alice');
    await bob.page.waitForFunction((id) => {
      const cards = [...document.querySelectorAll('.pb-card')];
      return cards.length >= 1 && cards.every(c => c.querySelector('.pb-author span:last-child')?.textContent === '@alice') && cards.some(c => c.dataset.id === id);
    }, projectId);
    await bob.page.fill('.pb-search input', 'zzz-nothing');
    await bob.page.waitForSelector('.pb-state-title:has-text("No projects match")');
    await bob.page.fill('.pb-search input', '');
    await bob.page.waitForSelector(`.pb-card[data-id="${projectId}"]`);
  });

  await step('bob opens it from Community: JS trust prompt, read-only banner, view counted', async () => {
    await bob.page.click(`.pb-card[data-id="${projectId}"] .dg-name`);
    await answerTrustPrompt(bob.page, 'Keep paused');
    await bob.page.waitForSelector('.pt-viewing');
    assert(new URL(bob.page.url()).pathname === `/p/${projectId}`, `url ${bob.page.url()}`);
    const blocked = await bob.page.evaluate(() => window.toy.nodeGraph.nodes.filter(n => n.isJSNode).every(n => n.trust === 'blocked'));
    assert(blocked, 'JS nodes stay paused');
    assert((await bob.page.locator('#saveCloudBtn .tb-btn-label').innerText()) === 'Save a copy', 'save button says Save a copy');
    assert((await bob.page.title()).includes('by @alice'), `title ${await bob.page.title()}`);
  });

  await step('anonymous visitor opens the share link /p/<id>', async () => {
    await anon.page.goto(url(`/p/${projectId}`), { waitUntil: 'domcontentloaded' });
    const dialog = anon.page.locator('.pt-modal', { hasText: 'contains JavaScript nodes' });
    await dialog.waitFor({ timeout: 20000 });
    await anon.page.waitForTimeout(800);
    await shot(anon.page, '05-share-link-trust-prompt.png');
    await dialog.getByRole('button', { name: 'Keep paused' }).click();
    await anon.page.waitForSelector('.pt-viewing');
    await anon.page.waitForTimeout(1200);
    await shot(anon.page, '06-share-link-opened.png');
    const og = await anon.page.evaluate(() => document.querySelector('meta[property="og:title"]')?.content);
    assert(og && og.includes('by @alice'), `og:title ${og}`);
  });

  await step('a share link to a project without JS opens straight away', async () => {
    const { page } = await newUser('anon3');
    const list = await (await fetch(`${API}/api/projects/public?q=aurora`)).json();
    const aurora = list.projects[0];
    assert(aurora && !aurora.hasJS, 'seeded aurora project');
    await page.goto(url(`/p/${aurora.id}`), { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.pt-viewing');
    assert(!(await page.locator('.pt-modal', { hasText: 'contains JavaScript nodes' }).count()), 'no trust prompt without JS');
    await page.waitForTimeout(2500);
    await shot(page, '06b-share-link-opened-no-js.png');
  });

  await step('a private project link shows a clear message to others', async () => {
    const { page: p } = await newUser('anon2');
    await p.goto(url(`/p/${secretId}`), { waitUntil: 'domcontentloaded' });
    await p.waitForSelector('.pt-toast:has-text("private or doesn")', { timeout: 15000 });
    assert(new URL(p.url()).pathname === '/', `falls back to the editor (${p.url()})`);
    await p.waitForTimeout(800);
    await shot(p, '07-private-link.png');
  });

  await step('views: bob + anonymous counted, owner not', async () => {
    const r = await (await fetch(`${API}/api/projects/${projectId}`)).json();
    assert(r.views === 2, `views ${r.views}`);
  });

  await step('bob saves a copy (fork): forkedFrom recorded and shown', async () => {
    await bob.page.locator('.pt-viewing').getByRole('button', { name: 'Save a copy' }).click();
    await bob.page.waitForFunction(() => window.toy.projectManager.projectState.isOwner === true);
    const ps = await bob.page.evaluate(() => window.toy.projectManager.projectState);
    assert(ps.forkedFrom && ps.forkedFrom.username === 'alice' && ps.forkedFrom.id, 'forkedFrom in state');
    assert(ps.projectId !== projectId, 'new id');
    await bob.page.waitForSelector('.pt-viewing', { state: 'detached' });
    assert((await bob.page.locator('#saveCloudBtn .tb-btn-label').innerText()) === 'Save', 'save button back to Save');
    await openExplore(bob.page, 'mine');
    const card = bob.page.locator(`.pb-card[data-id="${ps.projectId}"]`);
    await card.waitFor();
    assert((await card.locator('.pb-fork').innerText()).includes('@alice'), 'card shows forked from @alice');
    await bob.page.waitForTimeout(500);
    await shot(bob.page, '08-fork-in-my-projects.png');
    const src = await (await fetch(`${API}/api/projects/${projectId}`)).json();
    assert(src.forks === 1, `forks ${src.forks}`);
  });

  await step('alice sets a display name from the account menu (Edit profile)', async () => {
    while (await alice.page.locator('.pt-modal-backdrop').count()) {
      await alice.page.keyboard.press('Escape');
      await alice.page.waitForTimeout(100);
    }
    await alice.page.click('#accountBtn');
    await alice.page.locator('.pt-menu .pt-menu-item', { hasText: 'Edit profile' }).click();
    await alice.page.getByLabel('Display name (optional)').fill('Alice <b>Liddell</b>');
    await alice.page.locator('.pt-modal', { hasText: 'Edit profile' }).getByRole('button', { name: 'Save' }).click();
    await alice.page.waitForSelector('.pt-toast:has-text("Profile saved")');
    const u = await (await fetch(`${API}/api/users/alice`)).json();
    assert(u.user.displayName === 'Alice <b>Liddell</b>' && u.user.email === undefined, `profile ${JSON.stringify(u.user)}`);
  });

  await step('user page /u/alice from an author link; back/forward routing', async () => {
    // From the popover, a user page (a deep link) opens in the modal with its URL
    while (await bob.page.locator('.pt-modal-backdrop').count()) await bob.page.keyboard.press('Escape');
    await openExplore(bob.page, 'community');
    await bob.page.locator(`.pb-popover .pb-card[data-id="${projectId}"] .pb-author`).click();
    await bob.page.waitForSelector('.pt-modal--browser:not(.pb-popover) .pb-user-name');
    assert(new URL(bob.page.url()).pathname === '/u/alice', `url ${bob.page.url()}`);
    await bob.page.keyboard.press('Escape');
    await bob.page.waitForFunction(() => !document.querySelector('.pt-modal--browser'));

    // The modal presentation (as /explore/community opens it): tab URLs, back / forward
    await bob.page.evaluate(() => window.toy.projectBrowser.open({ view: 'community' }));
    await bob.page.waitForFunction(() => location.pathname === '/explore/community' && !document.querySelector('.pt-modal--browser .pb-skeleton'));
    await bob.page.locator(`.pb-card[data-id="${projectId}"] .pb-author`).click();
    await bob.page.waitForSelector('.pb-user-name');
    assert(new URL(bob.page.url()).pathname === '/u/alice', `url ${bob.page.url()}`);
    await bob.page.waitForSelector(`.pb-card[data-id="${projectId}"]`);
    assert(!(await bob.page.locator(`.pb-card[data-id="${secretId}"]`).count()), 'private project not listed');
    assert((await bob.page.title()).includes('@alice'), 'title');
    assert((await bob.page.locator('.pb-user-name').innerText()) === 'Alice <b>Liddell</b>', 'display name shown as text');
    await bob.page.mouse.move(5, 5);
    await bob.page.waitForTimeout(400);
    await shot(bob.page, '04-user-page.png');

    await bob.page.goBack();
    await bob.page.waitForFunction(() => location.pathname === '/explore/community' && document.querySelector('.pb-tab.is-active')?.dataset.view === 'community');
    await bob.page.goForward();
    await bob.page.waitForFunction(() => location.pathname === '/u/alice' && document.querySelector('.pb-user-name'));
    await bob.page.keyboard.press('Escape');
    await bob.page.waitForFunction(() => !document.querySelector('.pt-modal--browser'));
    assert(/^\/p\//.test(new URL(bob.page.url()).pathname), `closing returns to the project url (${bob.page.url()})`);
  });

  await step('deep link /u/alice on a fresh load', async () => {
    const p = await anon.context.newPage();
    await p.goto(url('/u/alice'), { waitUntil: 'domcontentloaded' });
    await p.waitForSelector(`.pb-card[data-id="${projectId}"]`, { timeout: 20000 });
    await p.close();
  });

  await step('usernames keep capitals but ignore case (/u/ALICE, sign-up as DoraTheDev, "My page")', async () => {
    // Any case reaches the page; the address bar and heading take the owner's spelling
    const p = await anon.context.newPage();
    await p.goto(url('/u/ALICE'), { waitUntil: 'domcontentloaded' });
    await p.waitForSelector(`.pb-card[data-id="${projectId}"]`, { timeout: 20000 });
    await p.waitForFunction(() => location.pathname === '/u/alice');
    await p.close();

    const { page, context } = await newUser('dora');
    await page.goto(url('/'), { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.toy?.community);
    await register(page, 'DoraTheDev');
    const api = await (await fetch(`${API}/api/users/dorathedev`)).json();
    assert(api.user?.username === 'DoraTheDev', `stored spelling ${JSON.stringify(api.user)}`);
    // The same name in another case is taken
    const dup = await fetch(`${API}/api/auth/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'dora2@example.com', username: 'dorathedev', password: 'correct horse battery' }),
    });
    assert(dup.status === 409, `duplicate in another case: ${dup.status}`);
    // Own page in another case: still "mine" (Edit profile shown)
    await page.evaluate(() => window.toy.projectBrowser.open({ view: 'user', username: 'DORATHEDEV' }));
    await page.waitForSelector('.pb-user-actions >> text=Edit profile');
    await page.waitForFunction(() => location.pathname === '/u/DoraTheDev');
    // Case-only profile change: allowed, keeps the session
    await page.locator('.pb-user-actions >> text=Edit profile').click();
    await page.getByLabel('Username').fill('doraTheDev');
    await page.locator('.pt-modal', { hasText: 'Edit profile' }).getByRole('button', { name: 'Save' }).click();
    await page.waitForSelector('.pt-toast:has-text("Profile saved")');
    await page.waitForFunction(() => window.toy.apiClient.getCurrentUser()?.username === 'doraTheDev');
    await context.close();
  });

  await step('routing keeps automation / dev query params (?bridge, ?bridgeToken, ?headless, ?api)', async () => {
    const { page } = await newUser('params');
    const qs = `bridge=off&headless=1&bridgeToken=tok123&api=${encodeURIComponent(API)}&devflag=1`;
    await page.goto(`${APP}/u/alice?${qs}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector(`.pb-card[data-id="${projectId}"]`, { timeout: 20000 });
    const keep = () => page.evaluate(() => Object.fromEntries(new URLSearchParams(location.search)));
    const check = async (where) => {
      const p = await keep();
      for (const k of ['bridge', 'headless', 'bridgeToken', 'api', 'devflag']) assert(p[k] !== undefined, `${where}: ?${k} kept (${JSON.stringify(p)})`);
      assert(p.bridgeToken === 'tok123' && p.bridge === 'off', `${where}: values intact`);
    };
    await check('user page');
    await page.locator('.pb-tab[data-view="community"]').click();
    await check('tab switch');
    await page.locator(`.pb-card[data-id="${projectId}"] .dg-name`).click();
    await answerTrustPrompt(page, 'Keep paused');
    await page.waitForFunction((id) => location.pathname === `/p/${id}`, projectId);
    await check('project route');
    await page.goBack();
    await page.waitForFunction(() => location.pathname.startsWith('/explore'));
    await check('back');
  });

  await step('offline / unreachable API state', async () => {
    const { page } = await newUser('offline');
    await page.goto(`${APP}/explore/community?api=${encodeURIComponent('http://localhost:9')}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.pb-state-title:has-text("reach the PatchToy cloud")', { timeout: 20000 });
    await page.waitForTimeout(500);
    await shot(page, '09-offline-state.png');
  });

  await step('1.x backend (mock-api --legacy): Share by link works, Publish to Community disabled, Community unavailable', async () => {
    const LEGACY_API = `http://localhost:${API_PORT + 1}`;
    const legacy = spawn(process.execPath, [path.join(ROOT, 'scripts/mock-api.mjs'), '--port', String(API_PORT + 1), '--seed', '--quiet', '--legacy'], { stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(legacy);
    await waitFor(`${LEGACY_API}/__mock/health`, 180000);
    const { page } = await newUser('legacy');
    // 1.x has no CORS on unknown resources: the browser logs those, they are expected here
    await page.goto(`${APP}/?api=${encodeURIComponent(LEGACY_API)}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.toy?.community);
    await page.evaluate(() => window.toy.apiClient.login('ada', 'patchtoy123'));
    await openExplore(page, 'mine');
    assert((await page.evaluate(() => window.toy.apiClient.caps)).legacy === true, 'detected as 1.x');
    const card = page.locator('.pb-popover .pb-card').first();
    await card.waitFor();
    assert(!(await card.locator('.pb-vis').count()), 'no visibility badge (the 1.x list does not say)');
    await card.locator('.pb-card-menu').click();
    const publish = page.locator('.pt-menu.pb-menu .pt-menu-item', { hasText: 'Publish to Community' });
    assert(await publish.isDisabled(), 'Publish to Community disabled');
    assert((await publish.getAttribute('data-tip')) === 'Available after the 2.0 backend deploy', 'its tooltip');
    await page.waitForTimeout(300);
    await shot(page, '10-legacy-card-menu.png');
    await page.locator('.pt-menu.pb-menu .pt-menu-item', { hasText: 'Share by link' }).click();
    await page.waitForSelector('.pb-popover .pb-card .pb-vis.is-unlisted');
    const id = await card.getAttribute('data-id');
    const shared = await (await fetch(`${LEGACY_API}/api/projects/${id}`)).json();
    assert(shared.isPublic === true, 'shared by link on the 1.x API (anonymous GET works)');
    await page.locator('.pb-tab[data-view="community"]').click();
    await page.waitForSelector('.pb-popover .pb-state-title:has-text("Community isn’t available on this server yet")');
    await page.waitForTimeout(300);
    await shot(page, '11-legacy-community.png');
    await page.close();
    legacy.kill('SIGTERM');
  });

  await step('no page errors or native dialogs', async () => {
    assert(pageErrors.length === 0, pageErrors.join(' | '));
  });
} catch (err) {
  console.error(err);
} finally {
  await browser.close();
  await shutdown();
  console.log(`\n${failed ? 'FAILED' : 'PASSED'}: ${results.filter(r => r.includes('✔')).length} steps ok, ${failed} failed. Screenshots in ${OUT}`);
  process.exit(failed ? 1 : 0);
}
