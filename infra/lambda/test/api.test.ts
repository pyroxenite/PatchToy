import { test, describe, beforeEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { fresh, event, json, projectData, MemoryBlobs, signupVerified } from './helpers';
import { Mail } from '../shared/mailer';
import { MemoryStore } from '../shared/memory-store';
import * as register from '../auth/register';
import * as login from '../auth/login';
import * as verify from '../auth/verify';
import * as save from '../projects/save';
import * as get from '../projects/get';
import * as list from '../projects/list';
import * as update from '../projects/update';
import * as del from '../projects/delete';
import * as visibility from '../projects/toggle-visibility';
import * as publicList from '../projects/public';
import * as view from '../projects/view';
import * as thumbnail from '../projects/thumbnail';
import * as getUser from '../users/get';
import * as updateMe from '../users/update-me';
import * as password from '../shared/password';
import * as jwt from '../shared/jwt';
import { MAX_DATA_BYTES } from '../shared/validate';

let store: MemoryStore;
let blobs: MemoryBlobs;
let outbox: Mail[];

beforeEach(() => {
  ({ store, blobs, outbox } = fresh());
});

async function signup(username: string, email = `${username}@example.com`) {
  return signupVerified(outbox, { email, username, password: 'correct horse' });
}

async function createProject(token: string, body: Record<string, any> = {}) {
  const res = await save.handler(event({ token, body: { name: 'Prism', data: projectData(), ...body } }));
  assert.equal(res.statusCode, 201, res.body);
  return json(res);
}

async function makePublic(token: string, id: string, isPublic = true) {
  const res = await visibility.handler(event({ token, path: { id }, body: { visibility: isPublic ? 'public' : 'private' } }));
  assert.equal(res.statusCode, 200, res.body);
  return json(res);
}

describe('auth', () => {
  test('register, login (email or username) and verify', async () => {
    const a = await signup('Alice');
    assert.equal(a.username, 'Alice', 'the spelling is kept');

    const byName = await login.handler(event({ body: { login: 'ALICE', password: 'correct horse' } }));
    assert.equal(byName.statusCode, 200);
    const byEmail = await login.handler(event({ body: { login: 'alice@example.com', password: 'correct horse' } }));
    assert.equal(json(byEmail).username, 'Alice');

    const bad = await login.handler(event({ body: { login: 'alice', password: 'nope nope' } }));
    assert.equal(bad.statusCode, 401);

    const v = await verify.handler(event({ token: a.token }));
    assert.equal(json(v).username, 'Alice');
    assert.equal((await verify.handler(event({ token: 'garbage' }))).statusCode, 401);
  });

  test('usernames are validated, reserved and unique', async () => {
    await signup('bob');
    const dup = await register.handler(event({ body: { email: 'other@example.com', username: 'BOB', password: 'correct horse' } }));
    assert.equal(dup.statusCode, 409);
    const reserved = await register.handler(event({ body: { email: 'x@example.com', username: 'admin', password: 'correct horse' } }));
    assert.equal(reserved.statusCode, 400);
    const invalid = await register.handler(event({ body: { email: 'y@example.com', username: 'a b<script>', password: 'correct horse' } }));
    assert.equal(invalid.statusCode, 400);
    // An address with an account: the generic "check your email" answer (no enumeration)
    const email = await register.handler(event({ body: { email: 'bob@example.com', username: 'bobby', password: 'correct horse' } }));
    assert.equal(email.statusCode, 202);
    assert.equal(json(email).pending, true);
  });

  test('legacy accounts without a username get one derived from the email on login', async () => {
    store.users.set('legacy-1', {
      userId: 'legacy-1',
      email: 'old.timer+x@example.com',
      username: '',
      passwordHash: await password.hash('correct horse'),
      createdAt: '2025-01-01T00:00:00.000Z',
    });
    await signup('old-timer-x'); // takes the first candidate
    const res = await login.handler(event({ body: { login: 'old.timer+x@example.com', password: 'correct horse' } }));
    assert.equal(res.statusCode, 200, res.body);
    const body = json(res);
    assert.equal(body.username, 'old-timer-x2');
    assert.equal(body.user.usernameGenerated, true);

    // Confirming the generated name clears the flag
    const confirm = await updateMe.handler(event({ token: body.token, body: { username: 'old-timer-x2' } }));
    assert.equal(confirm.statusCode, 200, confirm.body);
    assert.equal(json(confirm).user.usernameGenerated, false);
  });

  test('malformed bodies are rejected', async () => {
    assert.equal((await register.handler(event({ rawBody: '{not json' }))).statusCode, 400);
    assert.equal((await login.handler(event({ rawBody: '[1,2]' }))).statusCode, 400);
    const huge = await register.handler(event({ rawBody: JSON.stringify({ email: 'x'.repeat(500 * 1024) }) }));
    assert.equal(huge.statusCode, 413);
  });
});

describe('projects', () => {
  test('save validates name, description and payload size', async () => {
    const { token } = await signup('carol');
    assert.equal((await save.handler(event({ body: { name: 'x', data: projectData() } }))).statusCode, 401);
    assert.equal((await save.handler(event({ token, body: { name: '   ', data: projectData() } }))).statusCode, 400);
    assert.equal((await save.handler(event({ token, body: { name: 'x'.repeat(81), data: projectData() } }))).statusCode, 400);
    assert.equal((await save.handler(event({ token, body: { name: 'ok', data: { nope: true } } }))).statusCode, 400);
    assert.equal((await save.handler(event({ token, body: { name: 'ok', data: projectData(), description: 'd'.repeat(501) } }))).statusCode, 400);
    const big = projectData(1, { blob: 'x'.repeat(MAX_DATA_BYTES) });
    assert.equal((await save.handler(event({ token, body: { name: 'big', data: big } }))).statusCode, 413);

    const created = await createProject(token, { name: '  Prism\u0000  Drift ', data: projectData(3, { graph: { nodes: [{ type: 'JS' }, { type: 'UV' }], connections: [] } }) });
    assert.equal(created.name, 'Prism Drift');
    assert.equal(created.nodeCount, 2);
    assert.equal(created.hasJS, true);
    assert.equal(created.isPublic, false);
  });

  test('private projects are only readable by their owner', async () => {
    const alice = await signup('alice');
    const bob = await signup('bob');
    const p = await createProject(alice.token);

    const anon = await get.handler(event({ path: { id: p.id } }));
    assert.equal(anon.statusCode, 404);
    assert.match(json(anon).error, /private or does not exist/);
    assert.equal((await get.handler(event({ token: bob.token, path: { id: p.id } }))).statusCode, 404);

    const own = await get.handler(event({ token: alice.token, path: { id: p.id } }));
    assert.equal(own.statusCode, 200);
    assert.equal(json(own).isOwner, true);
    assert.ok(json(own).data.graph);

    assert.equal((await get.handler(event({ path: { id: 'not-a-uuid' } }))).statusCode, 404);
  });

  test('public projects are readable without auth and never expose emails', async () => {
    const alice = await signup('alice');
    const p = await createProject(alice.token);
    await makePublic(alice.token, p.id);

    const res = await get.handler(event({ path: { id: p.id } }));
    assert.equal(res.statusCode, 200);
    const body = json(res);
    assert.equal(body.isOwner, false);
    assert.equal(body.username, 'alice');
    assert.ok(!res.body.includes('@example.com'));
    assert.equal(res.headers?.['Access-Control-Allow-Origin'], '*');
    assert.equal(res.headers?.['Access-Control-Allow-Credentials'], undefined);
  });

  test('update and delete are owner only; list includes visibility and thumbnails', async () => {
    const alice = await signup('alice');
    const bob = await signup('bob');
    const p = await createProject(alice.token);

    assert.equal((await update.handler(event({ token: bob.token, path: { id: p.id }, body: { name: 'mine now' } }))).statusCode, 403);
    const upd = await update.handler(event({ token: alice.token, path: { id: p.id }, body: { name: 'Renamed', description: 'Hello' } }));
    assert.equal(upd.statusCode, 200, upd.body);
    assert.equal(json(upd).name, 'Renamed');

    await thumbnail.handler(event({ token: alice.token, path: { id: p.id } }));
    const mine = json(await list.handler(event({ token: alice.token }))).projects;
    assert.equal(mine.length, 1);
    assert.equal(mine[0].name, 'Renamed');
    assert.equal(mine[0].description, 'Hello');
    assert.equal(mine[0].isPublic, false);
    assert.match(mine[0].thumbUrl, /^http:\/\/blobs\.test\/thumbs\//);
    assert.equal(mine[0].data, undefined);

    assert.equal((await del.handler(event({ token: bob.token, path: { id: p.id } }))).statusCode, 403);
    assert.equal((await del.handler(event({ token: alice.token, path: { id: p.id } }))).statusCode, 200);
    assert.equal(blobs.deleted.length, 1);
    assert.equal((await get.handler(event({ token: alice.token, path: { id: p.id } }))).statusCode, 404);
  });

  test('thumbnail uploads are owner only and replace the previous image', async () => {
    const alice = await signup('alice');
    const bob = await signup('bob');
    const p = await createProject(alice.token);
    assert.equal((await thumbnail.handler(event({ token: bob.token, path: { id: p.id } }))).statusCode, 403);
    assert.equal((await thumbnail.handler(event({ path: { id: p.id } }))).statusCode, 401);

    const first = json(await thumbnail.handler(event({ token: alice.token, path: { id: p.id } })));
    assert.ok(first.upload.url && first.upload.fields.key);
    await new Promise(r => setTimeout(r, 2));
    const second = json(await thumbnail.handler(event({ token: alice.token, path: { id: p.id } })));
    assert.notEqual(first.thumbUrl, second.thumbUrl);
    assert.deepEqual(blobs.deleted, [first.upload.fields.key]);
    // A thumbnail doesn't count as an edit
    const stored = await store.getProject(p.id);
    assert.equal(stored!.updatedAt, p.updatedAt);
  });
});

describe('community', () => {
  test('public feed: only public projects, newest first, paginated', async () => {
    const alice = await signup('alice');
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const p = await createProject(alice.token, { name: `Patch ${i}` });
      ids.push(p.id);
      if (i !== 2) await makePublic(alice.token, p.id);
    }
    const first = json(await publicList.handler(event({ query: { limit: '2' } })));
    assert.deepEqual(first.projects.map((p: any) => p.name), ['Patch 4', 'Patch 3']);
    assert.ok(first.cursor);
    const second = json(await publicList.handler(event({ query: { limit: '2', cursor: first.cursor } })));
    assert.deepEqual(second.projects.map((p: any) => p.name), ['Patch 1', 'Patch 0']);
    assert.equal(second.cursor, null);

    await makePublic(alice.token, ids[4], false);
    const after = json(await publicList.handler(event({})));
    assert.ok(!after.projects.some((p: any) => p.id === ids[4]));

    assert.equal((await publicList.handler(event({ query: { cursor: '%%%' } }))).statusCode, 400);
  });

  test('search matches title or author; popular sorts by views', async () => {
    const alice = await signup('alice');
    const bob = await signup('bob');
    const a = await createProject(alice.token, { name: 'Aurora Fjord', visibility: 'public' });
    const b = await createProject(bob.token, { name: 'Molten Orbit', visibility: 'public' });

    const byTitle = json(await publicList.handler(event({ query: { q: 'AURORA' } })));
    assert.deepEqual(byTitle.projects.map((p: any) => p.id), [a.id]);
    const byAuthor = json(await publicList.handler(event({ query: { q: 'bob' } })));
    assert.deepEqual(byAuthor.projects.map((p: any) => p.id), [b.id]);

    // Views: distinct viewers count, a repeat from the same viewer doesn't, the owner doesn't
    for (const ip of ['198.51.100.1', '198.51.100.2']) {
      assert.equal(json(await view.handler(event({ path: { id: a.id }, ip }))).counted, true);
    }
    assert.equal(json(await view.handler(event({ path: { id: a.id }, ip: '198.51.100.2' }))).counted, false);
    assert.equal(json(await view.handler(event({ token: alice.token, path: { id: a.id } }))).counted, false);

    const popular = json(await publicList.handler(event({ query: { sort: 'popular' } })));
    assert.deepEqual(popular.projects.map((p: any) => p.id), [a.id, b.id]);
    assert.equal(popular.projects[0].views, 2);
    const newest = json(await publicList.handler(event({ query: { sort: 'new' } })));
    assert.deepEqual(newest.projects.map((p: any) => p.id), [b.id, a.id]);
  });

  test('views are not counted for private projects', async () => {
    const alice = await signup('alice');
    const p = await createProject(alice.token);
    assert.equal((await view.handler(event({ path: { id: p.id } }))).statusCode, 404);
  });

  test('forks record the source from the server and bump its fork count', async () => {
    const alice = await signup('alice');
    const bob = await signup('bob');
    const src = await createProject(alice.token, { name: 'Original', visibility: 'public' });
    const priv = await createProject(alice.token, { name: 'Secret' });

    const denied = await save.handler(event({ token: bob.token, body: { name: 'copy', data: projectData(), forkedFrom: { id: priv.id } } }));
    assert.equal(denied.statusCode, 404);

    const fork = await createProject(bob.token, {
      name: 'Original (remix)',
      forkedFrom: { id: src.id, username: 'someone-else', name: 'spoofed' },
    });
    assert.deepEqual(fork.forkedFrom, { id: src.id, username: 'alice', name: 'Original' });
    assert.equal((await store.getProject(src.id))!.forks, 1);
    assert.equal(json(await get.handler(event({ token: bob.token, path: { id: fork.id } }))).forkedFrom.username, 'alice');
  });

  test('user page lists only public projects, without emails', async () => {
    const alice = await signup('alice');
    const pub = await createProject(alice.token, { name: 'Shown', visibility: 'public' });
    await createProject(alice.token, { name: 'Hidden' });

    const res = await getUser.handler(event({ path: { username: 'Alice' } }));
    assert.equal(res.statusCode, 200);
    const body = json(res);
    assert.equal(body.user.username, 'alice');
    assert.equal(body.user.email, undefined);
    assert.equal(body.user.userId, undefined);
    assert.deepEqual(body.projects.map((p: any) => p.id), [pub.id]);
    assert.ok(!res.body.includes('example.com'));

    assert.equal((await getUser.handler(event({ path: { username: 'nobody-here' } }))).statusCode, 404);
    assert.equal((await getUser.handler(event({ path: { username: '../etc' } }))).statusCode, 404);
  });

  test('renaming a user relabels their projects and frees the old handle', async () => {
    const alice = await signup('alice');
    await signup('bob');
    const p = await createProject(alice.token, { visibility: 'public' });

    assert.equal((await updateMe.handler(event({ token: alice.token, body: { username: 'bob' } }))).statusCode, 409);
    assert.equal((await updateMe.handler(event({ token: alice.token, body: { username: 'me' } }))).statusCode, 400);
    assert.equal((await updateMe.handler(event({ token: alice.token, body: { displayName: 'x'.repeat(41) } }))).statusCode, 400);

    const res = await updateMe.handler(event({ token: alice.token, body: { username: 'Alicia', displayName: ' Alice  Liddell ' } }));
    assert.equal(res.statusCode, 200, res.body);
    const body = json(res);
    assert.equal(body.username, 'Alicia');
    assert.equal(body.user.displayName, 'Alice Liddell');
    assert.equal(json(await verify.handler(event({ token: body.token }))).username, 'Alicia');
    assert.equal((await store.getProject(p.id))!.username, 'Alicia');
    assert.equal((await store.getProject(p.id))!.usernameLower, 'alicia');
    assert.equal(await store.getHandleOwner('alice'), null, 'old handle released');

    // The old handle can be registered again
    await signup('alice', 'new-alice@example.com');
    const page = json(await getUser.handler(event({ path: { username: 'alicia' } })));
    assert.equal(page.user.displayName, 'Alice Liddell');
    assert.equal(page.projects.length, 1);
  });
});

describe('usernames: spelling kept, case ignored', () => {
  /** A 1.x account: username as typed, maybe a reservation item spelled the same way. */
  async function legacyUser(userId: string, username: string, { mixedReservation = false } = {}) {
    store.users.set(userId, {
      userId,
      email: `${userId}@example.com`,
      username,
      passwordHash: await password.hash('correct horse'),
      createdAt: '2025-01-01T00:00:00.000Z',
    });
    if (mixedReservation) store.handles.set(username, userId);
  }

  test('sign-up keeps the spelling; another case of the name is taken (409)', async () => {
    const s = await signup('SirKitBoi');
    assert.equal(s.username, 'SirKitBoi');
    assert.equal(store.handles.get('sirkitboi'), s.userId);
    const dup = await register.handler(event({ body: { email: 'other@example.com', username: 'sirkitboi', password: 'correct horse' } }));
    assert.equal(dup.statusCode, 409);
    // Reserved names are refused in any case
    const reserved = await register.handler(event({ body: { email: 'x@example.com', username: 'Admin', password: 'correct horse' } }));
    assert.equal(reserved.statusCode, 400);
    const bad = await register.handler(event({ body: { email: 'y@example.com', username: 'Sir Kit', password: 'correct horse' } }));
    assert.equal(bad.statusCode, 400);
    assert.ok(!/lowercase/i.test(bad.body), 'no "lowercase" in the message');
  });

  test('user pages resolve in any case and show the stored spelling', async () => {
    const s = await signup('SirKitBoi');
    await createProject(s.token, { visibility: 'public' });
    for (const name of ['sirkitboi', 'SIRKITBOI', 'SirKitBoi']) {
      const res = await getUser.handler(event({ path: { username: name } }));
      assert.equal(res.statusCode, 200, name);
      const page = json(res);
      assert.equal(page.user.username, 'SirKitBoi');
      assert.equal(page.projects.length, 1);
      assert.equal(page.projects[0].username, 'SirKitBoi');
    }
  });

  test('sign-in by username works in any case; the session carries the spelling', async () => {
    await signup('SirKitBoi');
    for (const name of ['sirkitboi', 'SIRKITBOI', ' SirKitBoi ']) {
      const res = await login.handler(event({ body: { login: name, password: 'correct horse' } }));
      assert.equal(res.statusCode, 200, name);
      assert.equal(json(res).username, 'SirKitBoi');
      assert.equal(json(await verify.handler(event({ token: json(res).token }))).username, 'SirKitBoi');
    }
  });

  test('1.x account with a mixed-case reservation: resolves, and sign-in moves it to the key', async () => {
    await legacyUser('legacy-sir', 'SirKitBoi', { mixedReservation: true });
    assert.equal((await getUser.handler(event({ path: { username: 'SirKitBoi' } }))).statusCode, 200);

    const res = await login.handler(event({ body: { login: 'SirKitBoi', password: 'correct horse' } }));
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(json(res).username, 'SirKitBoi');
    assert.equal(store.users.get('legacy-sir')!.username, 'SirKitBoi', 'the spelling is never changed');
    assert.equal(store.handles.get('sirkitboi'), 'legacy-sir');
    assert.equal(store.handles.has('SirKitBoi'), false, 'mixed-case item released');

    // Now any case works, and the name can't be taken in another case
    const page = await getUser.handler(event({ path: { username: 'sirkitboi' } }));
    assert.equal(json(page).user.username, 'SirKitBoi');
    assert.equal((await login.handler(event({ body: { login: 'SIRKITBOI', password: 'correct horse' } }))).statusCode, 200);
    const dup = await register.handler(event({ body: { email: 'z@example.com', username: 'sirKitBoi', password: 'correct horse' } }));
    assert.equal(dup.statusCode, 409);
  });

  test('1.x account without any reservation: resolves, and sign-in reserves the key', async () => {
    await legacyUser('legacy-bare', 'LordInateur');
    const page = await getUser.handler(event({ path: { username: 'LordInateur' } }));
    assert.equal(page.statusCode, 200);
    const res = await login.handler(event({ body: { login: 'LordInateur', password: 'correct horse' } }));
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(store.handles.get('lordinateur'), 'legacy-bare');
    assert.equal(store.users.get('legacy-bare')!.username, 'LordInateur');
    assert.equal(json(await getUser.handler(event({ path: { username: 'lordinateur' } }))).user.username, 'LordInateur');
    // Signing in again changes nothing
    assert.equal((await login.handler(event({ body: { login: 'lordinateur', password: 'correct horse' } }))).statusCode, 200);
    assert.deepEqual([...store.handles.entries()], [['lordinateur', 'legacy-bare']]);
  });

  test('a lowercase 1.x name without a reservation is found by the key', async () => {
    await legacyUser('legacy-low', 'lordinateur');
    assert.equal(json(await getUser.handler(event({ path: { username: 'LORDINATEUR' } }))).user.username, 'lordinateur');
  });

  test('a case-only change keeps the handle: no reservation change, sessions kept, projects relabelled', async () => {
    const s = await signup('SirKitBoi');
    await signup('bob');
    const p = await createProject(s.token, { visibility: 'public' });
    const tv = store.users.get(s.userId)!.tokenVersion || 0;

    const res = await updateMe.handler(event({ token: s.token, body: { username: 'sirKitBoi' } }));
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(json(res).username, 'sirKitBoi');
    assert.equal(store.users.get(s.userId)!.tokenVersion || 0, tv, 'no token bump');
    assert.equal(store.users.get(s.userId)!.usernameChangedAt, undefined);
    assert.equal(json(await verify.handler(event({ token: s.token }))).username, 'sirKitBoi', 'old session still works');
    assert.equal(store.handles.get('sirkitboi'), s.userId);
    assert.equal((await store.getProject(p.id))!.username, 'sirKitBoi');
    assert.equal(json(await getUser.handler(event({ path: { username: 'SIRKITBOI' } }))).user.username, 'sirKitBoi');

    // A different name still needs to be free; changing to it releases the key
    assert.equal((await updateMe.handler(event({ token: s.token, body: { username: 'BOB' } }))).statusCode, 409);
    const renamed = await updateMe.handler(event({ token: s.token, body: { username: 'KitCat' } }));
    assert.equal(renamed.statusCode, 200, renamed.body);
    assert.equal(store.handles.get('kitcat'), s.userId);
    assert.equal(store.handles.has('sirkitboi'), false);
    assert.ok((store.users.get(s.userId)!.tokenVersion || 0) > tv, 'a real rename ends other sessions');
  });

  test('a case-only change on a 1.x account replaces its mixed-case reservation', async () => {
    await legacyUser('legacy-sir', 'SirKitBoi', { mixedReservation: true });
    const token = await jwt.sign({ userId: 'legacy-sir', email: 'legacy-sir@example.com', username: 'SirKitBoi', tv: 0 });
    const res = await updateMe.handler(event({ token, body: { username: 'Sirkitboi' } }));
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual([...store.handles.entries()], [['sirkitboi', 'legacy-sir']]);
  });

  test('a different-name rename of a 1.x account releases both the key and the mixed-case item', async () => {
    await legacyUser('legacy-sir', 'SirKitBoi', { mixedReservation: true });
    store.handles.set('sirkitboi', 'legacy-sir');
    const token = await jwt.sign({ userId: 'legacy-sir', email: 'legacy-sir@example.com', username: 'SirKitBoi', tv: 0 });
    const res = await updateMe.handler(event({ token, body: { username: 'Knight' } }));
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual([...store.handles.entries()], [['knight', 'legacy-sir']]);
  });

  test('search by author works in any case', async () => {
    const s = await signup('SirKitBoi');
    const p = await createProject(s.token, { name: 'Glow', visibility: 'public' });
    assert.equal((await store.getProject(p.id))!.usernameLower, 'sirkitboi');
    for (const q of ['sirkitboi', 'SIRKIT', 'KitBoi']) {
      const res = json(await publicList.handler(event({ query: { q } })));
      assert.deepEqual(res.projects.map((x: any) => x.id), [p.id], q);
      assert.equal(res.projects[0].username, 'SirKitBoi');
    }
  });

  test('forks record the source author with its spelling; updates refresh old project items', async () => {
    const s = await signup('SirKitBoi');
    const bob = await signup('bob');
    const p = await createProject(s.token, { visibility: 'public' });
    const fork = await createProject(bob.token, { forkedFrom: p.id });
    assert.equal(fork.forkedFrom.username, 'SirKitBoi');

    // An item written before usernameLower existed gets it on the next update
    const item = store.projects.get(p.id)!;
    delete item.usernameLower;
    const res = await update.handler(event({ token: s.token, path: { id: p.id }, body: { name: 'Glow 2' } }));
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(store.projects.get(p.id)!.usernameLower, 'sirkitboi');
  });
});
