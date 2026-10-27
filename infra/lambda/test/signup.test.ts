/**
 * Email-verification sign-up (SECURITY.md M5: no account enumeration through register).
 */
import { test, describe, beforeEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { fresh, event, json, verifyTokenFrom, clearRateLimits, signupVerified } from './helpers';
import { MemoryStore } from '../shared/memory-store';
import { Mail } from '../shared/mailer';
import * as register from '../auth/register';
import * as verifyEmail from '../auth/verify-email';
import * as resend from '../auth/resend-verification';
import * as login from '../auth/login';
import * as verify from '../auth/verify';
import * as password from '../shared/password';
import { signupKey, VERIFY_TOKEN_RE } from '../shared/signup';
import { LIMITS, VERIFY_TOKEN_TTL_MS } from '../shared/limits';

const PW = 'correct horse';

let store: MemoryStore;
let outbox: Mail[];

beforeEach(() => {
  ({ store, outbox } = fresh());
});

const reg = (email: string, username: string, pw = PW, ip?: string) =>
  register.handler(event({ body: { email, username, password: pw }, ip }));
const verifyWith = (token: string, ip?: string) => verifyEmail.handler(event({ body: { token }, ip }));
const signin = (loginName: string, pw = PW, ip?: string) => login.handler(event({ body: { login: loginName, password: pw }, ip }));
const resendFor = (email: string, ip?: string) => resend.handler(event({ body: { email }, ip }));

async function pendingOf(email: string) {
  return store.security.get(`signup#${await signupKey(email)}`);
}

describe('register: one answer for new and existing addresses', () => {
  test('same status and body; a new address gets a link, an existing one a notice', async () => {
    await signupVerified(outbox, { email: 'vic@example.com', username: 'vic', password: PW });
    clearRateLimits(store); // vic's own verification mail used the per-minute allowance
    outbox.length = 0;

    const fresh1 = await reg('new@example.com', 'newbie', 'another secret 1');
    const known = await reg('vic@example.com', 'vic-two', 'another secret 2');
    assert.equal(fresh1.statusCode, 202);
    assert.equal(known.statusCode, fresh1.statusCode);
    assert.equal(known.body, fresh1.body);
    assert.deepEqual(json(fresh1), { pending: true, message: register.CHECK_EMAIL });
    assert.ok(!('token' in json(fresh1)), 'no session before verification');

    assert.equal(outbox.length, 2, 'one mail each');
    const [linkMail, notice] = outbox;
    assert.equal(linkMail.to, 'new@example.com');
    assert.match(linkMail.text, /\/#verify=[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\n/);
    assert.ok(!/[?&]verify=/.test(linkMail.html), 'token only in the fragment');
    assert.ok(linkMail.text.includes('@newbie'), 'the mail names the account being created');
    assert.equal(notice.to, 'vic@example.com');
    assert.match(notice.subject, /tried to sign up/);
    assert.ok(!/#verify=/.test(notice.text + notice.html), 'no link for an existing account');
    assert.ok(!notice.text.includes('vic-two'), 'the notice carries nothing the requester typed');

    // The existing account is untouched; no pending sign-up for its address
    assert.equal(await pendingOf('vic@example.com'), undefined);
    assert.equal((await signin('vic')).statusCode, 200);
    assert.equal((await signin('vic', 'another secret 2')).statusCode, 401);
    // Nothing is created before verification
    assert.equal(await store.getUserByEmail('new@example.com'), null);
  });

  test('both paths take about as long (bcrypt on both, one mail each)', async () => {
    const saved = process.env.BCRYPT_ROUNDS;
    process.env.BCRYPT_ROUNDS = '10';
    try {
      await signupVerified(outbox, { email: 'vic@example.com', username: 'vic', password: PW });
      const time = async (email: string, username: string, ip: string) => {
        const t = process.hrtime.bigint();
        const r = await reg(email, username, 'another secret', ip);
        assert.equal(r.statusCode, 202);
        return Number(process.hrtime.bigint() - t) / 1e6;
      };
      let known = 0;
      let unknown = 0;
      for (let i = 0; i < 3; i++) {
        clearRateLimits(store);
        known += await time('vic@example.com', `vic-alt${i}`, `198.51.100.${60 + i}`);
        unknown += await time(`nobody${i}@example.com`, `nobody${i}`, `198.51.100.${70 + i}`);
      }
      const ratio = unknown / known;
      assert.ok(ratio > 0.5 && ratio < 2, `timing ratio new/existing = ${ratio.toFixed(2)} (${unknown.toFixed(0)} / ${known.toFixed(0)} ms)`);
    } finally {
      process.env.BCRYPT_ROUNDS = saved;
    }
  });

  test('input errors that do not depend on the address stay explicit', async () => {
    await signupVerified(outbox, { email: 'vic@example.com', username: 'vic', password: PW });
    assert.equal((await reg('other@example.com', 'VIC')).statusCode, 409, 'usernames are public: taken is fine to say');
    assert.equal((await reg('bad-address', 'someone')).statusCode, 400);
    assert.equal((await reg('a@example.com', 'someone', 'short')).statusCode, 400);
  });
});

describe('verify-email', () => {
  test('the link creates the account and signs in, once; a reused link is rejected', async () => {
    assert.equal((await reg('Ada@Example.com', 'Ada')).statusCode, 202);
    const token = verifyTokenFrom(outbox);
    assert.match(token, VERIFY_TOKEN_RE);
    // Only the hash is stored
    const stored = await pendingOf('ada@example.com');
    assert.ok(stored && !JSON.stringify(stored.value).includes(token.split('.')[1]));

    const ok = await verifyWith(token);
    assert.equal(ok.statusCode, 200, ok.body);
    const body = json(ok);
    assert.equal(body.username, 'Ada', 'spelling kept');
    assert.equal(body.email, 'ada@example.com');
    assert.equal(await store.getHandleOwner('ada'), body.userId, 'reserved under its key');
    assert.equal(json(await verify.handler(event({ token: body.token }))).username, 'Ada', 'the session works');
    const user = await store.getUserByEmail('ada@example.com');
    assert.ok(user && user.emailVerifiedAt && user.tokenVersion === 0 && user.projectCount === 0);
    assert.equal((await signin('ada')).statusCode, 200, 'password chosen at sign-up');

    const again = await verifyWith(token);
    assert.equal(again.statusCode, 401);
    assert.equal(json(again).code, 'verify_invalid');
    assert.equal([...store.users.values()].filter(u => u.email === 'ada@example.com').length, 1);
  });

  test('an expired link is rejected (24 h)', async () => {
    assert.equal(VERIFY_TOKEN_TTL_MS, 24 * 3600 * 1000);
    await reg('ada@example.com', 'ada');
    const token = verifyTokenFrom(outbox);
    const entry = (await pendingOf('ada@example.com'))!;
    entry.value.expiresAt = Date.now() - 1000; // the record outlives its expiry (TTL deletion is lazy)
    const r = await verifyWith(token);
    assert.equal(r.statusCode, 401);
    assert.equal(json(r).code, 'verify_invalid');
    assert.equal(await store.getUserByEmail('ada@example.com'), null);
  });

  test('malformed, unknown and tampered tokens get the same answer', async () => {
    await reg('ada@example.com', 'ada');
    const token = verifyTokenFrom(outbox);
    const bodies = new Set<string>();
    for (const bad of ['nope', `${token.slice(0, 22)}.${'A'.repeat(43)}`, `${'B'.repeat(22)}.${token.slice(23)}`, `${token}x`]) {
      const r = await verifyWith(bad);
      assert.equal(r.statusCode, 401, bad);
      bodies.add(r.body);
    }
    assert.equal(bodies.size, 1);
    assert.equal((await verifyWith(token)).statusCode, 200, 'the real link still works');
  });

  test('only the newest link of an address works (a later sign-up replaces an earlier one)', async () => {
    // An attacker pre-registers the victim's address with their own password...
    await reg('vic@example.com', 'mallory', 'attacker password');
    const attackerLink = verifyTokenFrom(outbox);
    clearRateLimits(store);
    // ...then the victim signs up: their link wins, the attacker's stops working
    await reg('vic@example.com', 'vic', 'victim password');
    const victimLink = verifyTokenFrom(outbox);
    assert.notEqual(attackerLink, victimLink);
    assert.equal((await verifyWith(attackerLink)).statusCode, 401);
    assert.equal((await verifyWith(victimLink)).statusCode, 200);
    assert.equal((await signin('vic@example.com', 'victim password')).statusCode, 200);
    assert.equal((await signin('vic@example.com', 'attacker password')).statusCode, 401);
  });

  test('a username taken while the sign-up waited becomes a numbered variant to confirm', async () => {
    await reg('first@example.com', 'shader');
    const first = verifyTokenFrom(outbox, 'first@example.com');
    await reg('second@example.com', 'shader');
    const second = verifyTokenFrom(outbox, 'second@example.com');
    assert.equal(json(await verifyWith(second)).username, 'shader');
    const late = json(await verifyWith(first));
    assert.equal(late.username, 'shader2');
    assert.equal(late.user.usernameGenerated, true, 'the app asks to keep or change it');
  });

  test('verification attempts are limited per IP', async () => {
    let last = 0;
    for (let i = 0; i <= LIMITS.verifySubmitPerIp.limit; i++) last = (await verifyWith(`${'A'.repeat(22)}.${'B'.repeat(43)}`, '198.51.100.90')).statusCode;
    assert.equal(last, 429);
  });
});

describe('sign-in before verification', () => {
  test('an unverified sign-up fails like a wrong password', async () => {
    await reg('pending@example.com', 'pending-pat');
    const unverified = await signin('pending@example.com');
    const byName = await signin('pending-pat');
    const unknown = await signin('nobody@example.com');
    assert.equal(unverified.statusCode, 401);
    assert.equal(unverified.body, unknown.body);
    assert.equal(byName.body, unknown.body);
  });

  test('1.x accounts (no verification flag) sign in as verified', async () => {
    store.users.set('legacy-1', {
      userId: 'legacy-1', email: 'old@example.com', username: 'oldie', createdAt: '2025-01-01T00:00:00.000Z',
      passwordHash: await password.hash(PW),
    });
    assert.equal((await signin('old@example.com')).statusCode, 200);
    // Signing up again with that address only sends the notice
    outbox.length = 0;
    assert.equal((await reg('old@example.com', 'oldie-two')).statusCode, 202);
    assert.match(outbox[0].subject, /tried to sign up/);
  });
});

describe('resend verification', () => {
  test('same answer for waiting, verified and unknown addresses; a new link replaces the old one', async () => {
    await signupVerified(outbox, { email: 'vic@example.com', username: 'vic', password: PW });
    await reg('wait@example.com', 'waiter');
    const firstLink = verifyTokenFrom(outbox, 'wait@example.com');
    clearRateLimits(store);
    outbox.length = 0;

    const a = await resendFor('wait@example.com');
    const b = await resendFor('vic@example.com');
    const c = await resendFor('nobody@example.com');
    const d = await resendFor('not-an-address');
    for (const r of [a, b, c, d]) {
      assert.equal(r.statusCode, 200);
      assert.equal(r.body, a.body);
    }
    assert.deepEqual(outbox.map(m => m.to), ['wait@example.com', 'vic@example.com']);
    assert.match(outbox[1].subject, /tried to sign up/);

    const newLink = verifyTokenFrom(outbox, 'wait@example.com');
    assert.notEqual(newLink, firstLink);
    assert.equal((await verifyWith(firstLink)).statusCode, 401, 'older link replaced');
    assert.equal((await verifyWith(newLink)).statusCode, 200);
  });

  test('mails per address are limited silently; requests per IP with a 429', async () => {
    await reg('wait@example.com', 'waiter');
    assert.equal(outbox.length, 1);
    // Right after the sign-up mail: answered as usual, nothing sent, the link still works
    const r = await resendFor('wait@example.com');
    assert.equal(r.statusCode, 200);
    assert.equal(outbox.length, 1);
    const link = verifyTokenFrom(outbox);

    // Hourly cap shared by register and resend (burst window cleared each time)
    const burstKeys = () => { for (const k of [...store.security.keys()]) if (k.startsWith('rl#signup-mail-burst')) store.security.delete(k); };
    for (let i = 0; i < 5; i++) {
      burstKeys();
      assert.equal((await resendFor('wait@example.com', `198.51.100.${120 + i}`)).statusCode, 200);
    }
    assert.equal(outbox.length, LIMITS.signupMailPerEmail.limit, `at most ${LIMITS.signupMailPerEmail.limit} mails an hour`);
    assert.notEqual(verifyTokenFrom(outbox), link);

    let last = 0;
    for (let i = 0; i <= LIMITS.resendVerificationPerIp.limit; i++) last = (await resendFor(`x${i}@example.com`, '198.51.100.99')).statusCode;
    assert.equal(last, 429);
  });

  test('register for a waiting address within the burst window keeps the current link', async () => {
    await reg('wait@example.com', 'waiter', 'first password');
    const link = verifyTokenFrom(outbox);
    const r = await reg('wait@example.com', 'waiter', 'second password');
    assert.equal(r.statusCode, 202);
    assert.equal(outbox.length, 1, 'no second mail within a minute');
    assert.equal((await verifyWith(link)).statusCode, 200, 'nothing replaced without a mail');
    assert.equal((await signin('waiter', 'first password')).statusCode, 200);
  });
});

describe('SIGNUP_VERIFICATION=off (escape hatch)', () => {
  test('restores the immediate sign-up', async () => {
    process.env.SIGNUP_VERIFICATION = 'off';
    try {
      const r = await reg('now@example.com', 'right-now');
      assert.equal(r.statusCode, 201);
      assert.ok(json(r).token);
      assert.equal((await reg('now@example.com', 'again-now')).statusCode, 409);
      assert.equal(outbox.length, 0);
    } finally {
      delete process.env.SIGNUP_VERIFICATION;
    }
  });
});
