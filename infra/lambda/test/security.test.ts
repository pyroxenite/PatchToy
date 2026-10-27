/**
 * Regression tests for the PatchToy 2.0 security review (SECURITY.md): every
 * [PROVEN] finding has a case here.
 */
import { test, describe, beforeEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'path';
import * as jsonwebtoken from 'jsonwebtoken';
import * as bcrypt from 'bcryptjs';
import { fresh, event, json, projectData, resetTokenFrom, MemoryBlobs, signupVerified } from './helpers';
import { MemoryStore } from '../shared/memory-store';
import { Mail } from '../shared/mailer';
import * as register from '../auth/register';
import * as login from '../auth/login';
import * as verify from '../auth/verify';
import * as requestReset from '../auth/request-password-reset';
import * as resetPassword from '../auth/reset-password';
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
import { FREE_LOGIN_FAILURES, RESET_TOKEN_TTL_MS } from '../shared/limits';
import { MAX_PROJECTS_PER_USER, cleanText, usernameError } from '../shared/validate';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { planProjectUpdate, planReservations } = require(path.resolve(__dirname, '../../../scripts/backfill-plan.cjs'));

const SECRET = process.env.JWT_SECRET as string;
const PW = 'correct horse';

let store: MemoryStore;
let blobs: MemoryBlobs;
let outbox: Mail[];

beforeEach(() => {
  ({ store, blobs, outbox } = fresh());
});

async function signup(username: string, email = `${username}@example.com`) {
  return signupVerified(outbox, { email, username, password: PW });
}

async function signin(loginName: string, pw = PW, ip?: string) {
  return login.handler(event({ body: { login: loginName, password: pw }, ip }));
}

async function createProject(token: string, body: Record<string, any> = {}) {
  const res = await save.handler(event({ token, body: { name: 'Prism', data: projectData(), ...body } }));
  assert.equal(res.statusCode, 201, res.body);
  return json(res);
}

async function requestResetToken(email: string) {
  const before = outbox.length;
  const res = await requestReset.handler(event({ body: { email } }));
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(outbox.length, before + 1, 'a reset mail was sent');
  return resetTokenFrom(outbox);
}

const authStatus = async (token: string) => (await verify.handler(event({ token }))).statusCode;

describe('H2: session tokens', () => {
  test('a password-reset token is never a session token (opaque token or a forged 1.x-style reset JWT)', async () => {
    const bob = await signup('bob');
    const resetToken = await requestResetToken('bob@example.com');
    assert.ok(!resetToken.includes('.'), 'reset tokens are opaque, not JWTs');
    assert.equal(await authStatus(resetToken), 401);
    assert.equal((await list.handler(event({ token: resetToken }))).statusCode, 401);

    // The 1.x reset JWT shape, signed with the real secret
    const legacyReset = jsonwebtoken.sign({ userId: bob.userId, email: 'bob@example.com', type: 'password-reset' }, SECRET, { expiresIn: '1m' });
    assert.equal((await list.handler(event({ token: legacyReset }))).statusCode, 401);
    assert.equal((await save.handler(event({ token: legacyReset, body: { name: 'x', data: projectData() } }))).statusCode, 401);
  });

  test('only HS256 session tokens with the session audience are accepted', async () => {
    const bob = await signup('bob');
    const claims = { userId: bob.userId, email: 'bob@example.com', username: 'bob', tv: 0, typ: 'session' };
    const good = jsonwebtoken.sign(claims, SECRET, { algorithm: 'HS256', audience: jwt.SESSION_AUDIENCE, issuer: jwt.ISSUER });
    assert.equal(await authStatus(good), 200);
    const hs512 = jsonwebtoken.sign(claims, SECRET, { algorithm: 'HS512', audience: jwt.SESSION_AUDIENCE, issuer: jwt.ISSUER });
    assert.equal(await authStatus(hs512), 401);
    const otherAud = jsonwebtoken.sign({ ...claims }, SECRET, { audience: 'patchtoy:reset', issuer: jwt.ISSUER });
    assert.equal(await authStatus(otherAud), 401);
    const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.`;
    assert.equal(await authStatus(none), 401);
    const wrongKey = jsonwebtoken.sign(claims, 'another-secret-0123456789abcdef0123456789', { audience: jwt.SESSION_AUDIENCE, issuer: jwt.ISSUER });
    assert.equal(await authStatus(wrongKey), 401);
  });

  test('1.x session tokens keep working as tokenVersion 0 until the version changes', async () => {
    const bob = await signup('bob');
    const legacy = jsonwebtoken.sign({ userId: bob.userId, email: 'bob@example.com', username: 'bob' }, SECRET, { expiresIn: '30d' });
    assert.equal(await authStatus(legacy), 200);
    await store.incrementTokenVersion(bob.userId);
    assert.equal(await authStatus(legacy), 401);
  });

  test('reset links are single use, expire after 30 minutes, and a reset signs out every session', async () => {
    const bob = await signup('bob');
    const other = json(await signin('bob')).token;
    const token = await requestResetToken('bob@example.com');

    const ok = await resetPassword.handler(event({ body: { token, newPassword: 'new horse battery' } }));
    assert.equal(ok.statusCode, 200, ok.body);
    // Reuse is rejected
    const again = await resetPassword.handler(event({ body: { token, newPassword: 'other horse battery' } }));
    assert.equal(again.statusCode, 401);
    assert.equal(json(again).code, 'reset_invalid');

    // Old sessions (both devices) are revoked; the new password works, the old one doesn't
    assert.equal(await authStatus(bob.token), 401);
    assert.equal(json(await verify.handler(event({ token: other }))).code, 'session_expired');
    assert.equal((await signin('bob')).statusCode, 401);
    const fresh2 = await signin('bob', 'new horse battery');
    assert.equal(fresh2.statusCode, 200);
    assert.equal(await authStatus(json(fresh2).token), 200);

    // Expiry: 30 minutes
    assert.equal(RESET_TOKEN_TTL_MS, 30 * 60 * 1000);
    outbox.length = 0;
    store.security.clear(); // the 1-per-5-minutes mail limit
    const late = await requestResetToken('bob@example.com');
    const rec = [...store.security.entries()].find(([k]) => k.startsWith('reset#'))!;
    assert.ok(Math.abs(rec[1].value.expiresAt - Date.now() - RESET_TOKEN_TTL_MS) < 5000);
    rec[1].value.expiresAt = Date.now() - 1;
    rec[1].expires = 0;
    assert.equal((await resetPassword.handler(event({ body: { token: late, newPassword: 'third horse battery' } }))).statusCode, 401);
  });

  test('a completed reset invalidates older unused reset links', async () => {
    await signup('bob');
    const first = await requestResetToken('bob@example.com');
    store.security.forEach((v, k) => { if (k.startsWith('rl#')) store.security.delete(k); });
    const second = await requestResetToken('bob@example.com');
    assert.equal((await resetPassword.handler(event({ body: { token: second, newPassword: 'new horse battery' } }))).statusCode, 200);
    assert.equal((await resetPassword.handler(event({ body: { token: first, newPassword: 'other horse battery' } }))).statusCode, 401);
  });

  test('the reset link puts the token in the URL fragment', async () => {
    await signup('bob');
    await requestResetToken('bob@example.com');
    const mail = outbox[outbox.length - 1];
    assert.match(mail.text, /https?:\/\/[^\s]+\/#reset=[A-Za-z0-9_-]{43}/);
    assert.ok(!/\?reset=/.test(mail.html));
  });

  test('a weak new password does not use up the reset link', async () => {
    await signup('bob');
    const token = await requestResetToken('bob@example.com');
    assert.equal((await resetPassword.handler(event({ body: { token, newPassword: 'password123' } }))).statusCode, 400);
    assert.equal((await resetPassword.handler(event({ body: { token, newPassword: 'new horse battery' } }))).statusCode, 200);
  });

  test('a rename revokes older tokens and the response carries a working new one', async () => {
    const alice = await signup('alice');
    const second = json(await signin('alice')).token;
    const res = await updateMe.handler(event({ token: alice.token, body: { username: 'alicia' } }));
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(await authStatus(alice.token), 401);
    assert.equal(await authStatus(second), 401);
    assert.equal(json(await verify.handler(event({ token: json(res).token }))).username, 'alicia');
    // A display-name change alone keeps sessions
    const t = json(res).token;
    assert.equal((await updateMe.handler(event({ token: t, body: { displayName: 'Alicia' } }))).statusCode, 200);
    assert.equal(await authStatus(t), 200);
  });

  test('the JWT secret fails closed', async () => {
    const saved = process.env.JWT_SECRET;
    try {
      jwt.resetSecretCacheForTests();
      process.env.JWT_SECRET = 'short';
      await assert.rejects(jwt.getSecret(), jwt.ConfigError);
      const res = await verify.handler(event({ token: 'x.y.z' }));
      assert.equal(res.statusCode, 500);
      delete process.env.JWT_SECRET;
      jwt.resetSecretCacheForTests();
      await assert.rejects(jwt.getSecret(), /missing or shorter/);
    } finally {
      process.env.JWT_SECRET = saved;
      jwt.resetSecretCacheForTests();
    }
  });
});

describe('M1: author names come from the users table', () => {
  test('a stale token cannot publish under a released handle', async () => {
    const mal = await signup('mallory');
    const renamed = await updateMe.handler(event({ token: mal.token, body: { username: 'mallory2' } }));
    assert.equal(renamed.statusCode, 200);
    await signup('mallory', 'victim@example.com'); // someone else takes the freed handle

    const stale = await save.handler(event({ token: mal.token, body: { name: 'Official announcement', data: projectData(), visibility: 'public' } }));
    assert.equal(stale.statusCode, 401);
    const feed = json(await publicList.handler(event({ query: { q: 'mallory' } })));
    assert.equal(feed.projects.length, 0);
  });

  test('the username claim in a valid token is ignored', async () => {
    const bob = await signup('bob');
    const forgedClaim = await jwt.sign({ userId: bob.userId, email: 'bob@example.com', username: 'admin', tv: 0 });
    const p = await createProject(forgedClaim, { visibility: 'public' });
    assert.equal(p.username, 'bob');
    assert.equal(json(await verify.handler(event({ token: forgedClaim }))).username, 'bob');
  });
});

describe('H3: abuse limits', () => {
  test('failed sign-ins lock the account with backoff, then the right password works again', async () => {
    await signup('vic');
    for (let i = 0; i < FREE_LOGIN_FAILURES; i++) {
      assert.equal((await signin('vic', `guess-${i}`)).statusCode, 401);
    }
    const locked = await signin('vic'); // correct password, but locked
    assert.equal(locked.statusCode, 429);
    assert.equal(json(locked).code, 'login_locked');
    assert.ok(Number(locked.headers?.['Retry-After']) > 0);
    // Email and username share the account lock
    assert.equal((await signin('vic@example.com')).statusCode, 429);

    // After the lock expires the correct password signs in and clears the counter
    const entry = [...store.security.entries()].find(([k]) => k.startsWith('af#'))!;
    entry[1].value.lockedUntil = Date.now() - 1;
    assert.equal((await signin('vic')).statusCode, 200);
    assert.ok(![...store.security.keys()].some(k => k.startsWith('af#')));
  });

  test('lockout responses are identical for unknown accounts (no enumeration)', async () => {
    await signup('vic');
    for (let i = 0; i < FREE_LOGIN_FAILURES; i++) {
      await signin('vic', 'nope-nope');
      await signin('nobody-here', 'nope-nope');
    }
    const a = await signin('vic', 'nope-nope');
    const b = await signin('nobody-here', 'nope-nope');
    assert.equal(a.statusCode, 429);
    assert.equal(b.statusCode, 429);
    assert.equal(json(a).code, json(b).code);
  });

  test('sign-in attempts are limited per IP', async () => {
    await signup('vic');
    let last = 0;
    for (let i = 0; i < 61; i++) last = (await signin(`user-${i}`, 'nope-nope', '198.51.100.9')).statusCode;
    assert.equal(last, 429);
    assert.equal((await signin('vic', PW, '198.51.100.10')).statusCode, 200);
  });

  test('registrations are limited per IP and per address', async () => {
    let last = 0;
    for (let i = 0; i < 31; i++) {
      last = (await register.handler(event({ ip: '198.51.100.20', body: { email: `r${i}@example.com`, username: `r-user${i}`, password: PW } }))).statusCode;
    }
    assert.equal(last, 429);
    let sameEmail = 0;
    for (let i = 0; i < 6; i++) {
      sameEmail = (await register.handler(event({ ip: `198.51.100.${30 + i}`, body: { email: 'same@example.com', username: `same${i}`, password: PW } }))).statusCode;
    }
    assert.equal(sameEmail, 429);
  });

  test('reset mails: at most one per address per 5 minutes, same answer either way', async () => {
    await signup('bob');
    outbox.length = 0; // the sign-up verification mail
    const bodies = new Set<string>();
    for (let i = 0; i < 4; i++) {
      const r = await requestReset.handler(event({ body: { email: 'bob@example.com' } }));
      assert.equal(r.statusCode, 200);
      bodies.add(r.body);
    }
    bodies.add((await requestReset.handler(event({ body: { email: 'nobody@example.com' } }))).body);
    assert.equal(outbox.length, 1);
    assert.equal(bodies.size, 1);
    let last = 0;
    for (let i = 0; i < 20; i++) last = (await requestReset.handler(event({ body: { email: `x${i}@example.com` } }))).statusCode;
    assert.equal(last, 429, 'per-IP limit');
  });

  test('bcrypt cost 12, 1.x hashes still verify and are upgraded on sign-in', async () => {
    assert.equal(password.DEFAULT_ROUNDS, 12);
    const saved = process.env.BCRYPT_ROUNDS;
    process.env.BCRYPT_ROUNDS = '6';
    try {
      store.users.set('old-1', {
        userId: 'old-1', email: 'old@example.com', username: 'oldie', createdAt: '2025-01-01T00:00:00.000Z',
        passwordHash: bcrypt.hashSync(PW, 4),
      });
      assert.equal((await signin('oldie')).statusCode, 200);
      assert.equal(bcrypt.getRounds(store.users.get('old-1')!.passwordHash), 6);
      assert.equal((await signin('oldie')).statusCode, 200);
    } finally {
      process.env.BCRYPT_ROUNDS = saved;
    }
  });

  test('common passwords and passwords equal to the username are rejected', async () => {
    for (const pw of ['password123', '12345678', 'qwerty123', 'aaaaaaaa', 'carol-123']) {
      const r = await register.handler(event({ body: { email: 'carol@example.com', username: 'carol-123', password: pw } }));
      assert.equal(r.statusCode, 400, pw);
    }
    assert.equal(password.validatePassword('carol@example.com', { email: 'carol@example.com' }) !== null, true);
    assert.equal(password.validatePassword(PW), null);
  });

  test('project quota per user', async () => {
    const bob = await signup('bob');
    store.users.get(bob.userId)!.projectCount = MAX_PROJECTS_PER_USER - 1;
    const p = await createProject(bob.token);
    const over = await save.handler(event({ token: bob.token, body: { name: 'one more', data: projectData() } }));
    assert.equal(over.statusCode, 403);
    assert.equal(json(over).code, 'project_quota');
    await del.handler(event({ token: bob.token, path: { id: p.id } }));
    await createProject(bob.token);
  });
});

describe('M5: enumeration', () => {
  test('wrong password and unknown account answer the same, both run bcrypt', async () => {
    const saved = process.env.BCRYPT_ROUNDS;
    process.env.BCRYPT_ROUNDS = '10';
    try {
      await signup('vic');
      const a = await signin('vic', 'wrong-password');
      const b = await signin('nobody', 'wrong-password');
      assert.equal(a.statusCode, b.statusCode);
      assert.equal(a.body, b.body);
      const time = async (who: string) => {
        const t = process.hrtime.bigint();
        await signin(who, 'wrong-password', `203.0.113.${50 + Math.floor(Math.random() * 100)}`);
        return Number(process.hrtime.bigint() - t) / 1e6;
      };
      store.security.clear();
      let known = 0;
      let unknown = 0;
      for (let i = 0; i < 3; i++) {
        known += await time('vic');
        unknown += await time(`nobody-${i}`);
      }
      const ratio = unknown / known;
      assert.ok(ratio > 0.5 && ratio < 2, `timing ratio unknown/known = ${ratio.toFixed(2)} (${unknown.toFixed(0)} / ${known.toFixed(0)} ms)`);
    } finally {
      process.env.BCRYPT_ROUNDS = saved;
    }
  });
});

describe('H4: visibility (private / unlisted / public)', () => {
  test('unlisted projects open by link but are not listed; only "public" is', async () => {
    const alice = await signup('alice');
    const link = await createProject(alice.token, { name: 'Link only', visibility: 'unlisted' });
    const legacy = await createProject(alice.token, { name: 'Legacy share', isPublic: true }); // 1.x client
    assert.equal(link.visibility, 'unlisted');
    assert.equal(legacy.visibility, 'unlisted');
    assert.equal((await get.handler(event({ path: { id: link.id } }))).statusCode, 200);

    const feed = json(await publicList.handler(event({})));
    assert.equal(feed.projects.length, 0);
    assert.equal(json(await getUser.handler(event({ path: { username: 'alice' } }))).projects.length, 0);

    const pub = json(await visibility.handler(event({ token: alice.token, path: { id: link.id }, body: { visibility: 'public' } })));
    assert.equal(pub.visibility, 'public');
    assert.deepEqual(json(await publicList.handler(event({}))).projects.map((p: any) => p.id), [link.id]);
    assert.deepEqual(json(await getUser.handler(event({ path: { username: 'alice' } }))).projects.map((p: any) => p.id), [link.id]);

    // Back to unlisted: gone from the lists, the link still works
    await visibility.handler(event({ token: alice.token, path: { id: link.id }, body: { visibility: 'unlisted' } }));
    assert.equal(json(await publicList.handler(event({}))).projects.length, 0);
    assert.equal((await get.handler(event({ path: { id: link.id } }))).statusCode, 200);

    assert.equal((await visibility.handler(event({ token: alice.token, path: { id: link.id }, body: { visibility: 'listed' } }))).statusCode, 400);
  });

  test('the backfill keeps 1.x link-shared projects unlisted', () => {
    const legacyShared = { projectId: 'p1', userId: 'u1', name: 'Shared', isPublic: true, data: { graph: { nodes: [] } } };
    const plan = planProjectUpdate(legacyShared);
    assert.equal(plan.set.visibility, undefined);
    assert.equal(plan.set.publicOwner, undefined);
    assert.deepEqual(plan.remove, []);
    // A stray visibility without a 2.0 listing is removed, a 2.0 listing is kept
    assert.deepEqual(planProjectUpdate({ ...legacyShared, visibility: 'link' }).remove, ['visibility']);
    const listed = planProjectUpdate({ ...legacyShared, visibility: 'public', nameLower: 'shared', views: 0, forks: 0, nodeCount: 0, hasJS: false });
    assert.deepEqual(listed.remove, []);
    assert.equal(listed.set.publicOwner, 'u1');
  });

  test('the backfill adds usernameLower to projects and keeps the display spelling', () => {
    const p = { projectId: 'p1', userId: 'u1', username: 'SirKitBoi', name: 'Glow', nameLower: 'glow', views: 0, forks: 0, nodeCount: 0, hasJS: false };
    assert.deepEqual(planProjectUpdate(p).set, { usernameLower: 'sirkitboi' });
    assert.deepEqual(planProjectUpdate({ ...p, usernameLower: 'sirkitboi' }).set, {}, 'idempotent');
  });

  test('the backfill reserves usernames by lowercase key, drops mixed-case items, reports collisions', () => {
    // Production as of 2.0: lordinateur reserved as is, SirKitBoi reserved as typed
    const prod = planReservations(
      [{ userId: 'u-lord', username: 'lordinateur' }, { userId: 'u-sir', username: 'SirKitBoi' }],
      new Map([['lordinateur', 'u-lord'], ['SirKitBoi', 'u-sir']]),
    );
    assert.deepEqual(prod.reserve, [{ key: 'sirkitboi', userId: 'u-sir', username: 'SirKitBoi' }]);
    assert.deepEqual(prod.release, [{ name: 'SirKitBoi', userId: 'u-sir' }]);
    assert.deepEqual(prod.conflicts, []);
    assert.equal(prod.ok, 1);

    // Second run (after apply): nothing to do
    const again = planReservations(
      [{ userId: 'u-lord', username: 'lordinateur' }, { userId: 'u-sir', username: 'SirKitBoi' }],
      new Map([['lordinateur', 'u-lord'], ['sirkitboi', 'u-sir']]),
    );
    assert.deepEqual([again.reserve, again.release, again.conflicts, again.ok], [[], [], [], 2]);

    // Two users whose names differ only in case: reported, nothing written for that key
    const clash = planReservations(
      [{ userId: 'a', username: 'Neo' }, { userId: 'b', username: 'neo' }],
      new Map([['Neo', 'a']]),
    );
    assert.deepEqual(clash.reserve, []);
    assert.deepEqual(clash.release, []);
    assert.equal(clash.conflicts.length, 2, clash.conflicts.join('; '));
    // Key held by another user
    const taken = planReservations([{ userId: 'a', username: 'Zed' }], new Map([['zed', 'b']]));
    assert.deepEqual(taken.reserve, []);
    assert.equal(taken.conflicts.length, 1);
  });

  test('L3: making a project private drops its public thumbnail; keys are unguessable', async () => {
    const alice = await signup('alice');
    const p = await createProject(alice.token, { visibility: 'public' });
    const t = json(await thumbnail.handler(event({ token: alice.token, path: { id: p.id } })));
    assert.match(t.upload.fields.key, /^thumbs\/[0-9a-f-]{36}\/[0-9a-z]+-[A-Za-z0-9_-]{12}\.jpg$/);
    await visibility.handler(event({ token: alice.token, path: { id: p.id }, body: { visibility: 'private' } }));
    assert.deepEqual(blobs.deleted, [t.upload.fields.key]);
    assert.equal((await store.getProject(p.id))!.thumbKey, undefined);
  });
});

describe('H1 (server side): custom node definitions in project data', () => {
  const withCustom = (customNodes: unknown) => projectData(2, { customNodes });
  test('names must be identifiers, never Object.prototype keys; sizes are capped', async () => {
    const { token } = await signup('carol');
    const save1 = (data: any) => save.handler(event({ token, body: { name: 'x', data } }));
    assert.equal((await save1(withCustom({ Wobble: { customGLSL: 'float wobble(vec2 uv) { return uv.x; }' } }))).statusCode, 201);
    const proto = await save.handler(event({ token, rawBody: '{"name":"x","data":{"graph":{"nodes":[]},"customNodes":{"__proto__":{"customGLSL":"x"}}}}' }));
    assert.equal(proto.statusCode, 400);
    for (const bad of [
      { constructor: { customGLSL: 'x' } },
      { hasOwnProperty: { customGLSL: 'x' } },
      { 'bad name': { customGLSL: 'x' } },
      { '1abc': { customGLSL: 'x' } },
      { Ok: { customGLSL: 42 } },
      { Ok: 'string' },
      { Ok: { customGLSL: 'x'.repeat(64 * 1024 + 1) } },
      Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`N${i}`, { customGLSL: 'x' }])),
    ]) {
      assert.equal((await save1(withCustom(bad))).statusCode, 400, JSON.stringify(Object.keys(bad)).slice(0, 80));
    }
  });
});

describe('Lows', () => {
  test('L1: views dedupe by IP (User-Agent ignored), forks count once per user', async () => {
    const alice = await signup('alice');
    const bob = await signup('bob');
    const p = await createProject(alice.token, { visibility: 'public' });
    let counted = 0;
    for (let i = 0; i < 20; i++) {
      if (json(await view.handler(event({ path: { id: p.id }, ip: '198.51.100.40', userAgent: `bot-${i % 2}` }))).counted) counted++;
    }
    assert.equal(counted, 1);
    for (let i = 0; i < 5; i++) await createProject(bob.token, { forkedFrom: { id: p.id } });
    assert.equal((await store.getProject(p.id))!.forks, 1);
  });

  test('L2: look-alike reserved handles are refused; invisible / bidi characters are stripped', async () => {
    for (const n of ['adm1n', 'patch-toy', 'patchtoy_', 'p4tchtoy', 'support-team', 'moderators', 'the-admin', 'officia1']) {
      assert.equal(usernameError(n), 'That username is reserved', n);
    }
    for (const n of ['badminton', 'modular', 'patcher', 'alice']) assert.equal(usernameError(n), null, n);
    assert.equal(cleanText('a‮evil​', 80, 'Name'), 'aevil');
    const alice = await signup('alice');
    const p = await createProject(alice.token, { name: 'Pa​tch‮', description: 'x⁦y' });
    assert.equal(p.name, 'Patch');
    assert.equal(p.description, 'xy');
    const dn = await updateMe.handler(event({ token: alice.token, body: { displayName: 'PatchToy​ Team' } }));
    assert.equal(json(dn).user.displayName, 'PatchToy Team');
  });

  test('L5: no Allow-Credentials; ALLOWED_ORIGINS narrows Allow-Origin', async () => {
    const r1 = await publicList.handler(event({}));
    assert.equal(r1.headers?.['Access-Control-Allow-Credentials'], undefined);
    process.env.ALLOWED_ORIGINS = 'https://patchtoy.com,http://localhost:5200';
    try {
      const ok = await publicList.handler(event({ origin: 'http://localhost:5200' }));
      assert.equal(ok.headers?.['Access-Control-Allow-Origin'], 'http://localhost:5200');
      const other = await publicList.handler(event({ origin: 'https://evil.example' }));
      assert.equal(other.headers?.['Access-Control-Allow-Origin'], 'https://patchtoy.com');
    } finally {
      delete process.env.ALLOWED_ORIGINS;
    }
  });

  test('L6: malformed percent-encoding in a username is a 400, not a 500', async () => {
    const r = await getUser.handler(event({ path: { username: '%E0%A4%A' } }));
    assert.equal(r.statusCode, 400);
  });

  test('update can change visibility and validates it', async () => {
    const alice = await signup('alice');
    const p = await createProject(alice.token);
    const r = json(await update.handler(event({ token: alice.token, path: { id: p.id }, body: { visibility: 'unlisted' } })));
    assert.equal(r.visibility, 'unlisted');
    assert.equal((await update.handler(event({ token: alice.token, path: { id: p.id }, body: { visibility: 7 } }))).statusCode, 400);
  });
});
