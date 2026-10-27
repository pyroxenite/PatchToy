import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';
import * as jwt from './jwt';
import { enforceLimit } from './http';
import { LIMITS, VERIFY_TOKEN_TTL_MS } from './limits';
import { getMailer, Mail } from './mailer';
import { verificationMail, frontendUrl } from './emails';
import { PendingSignup, Store } from './store';

/**
 * Email-verification sign-up (SECURITY.md M5).
 *
 * A sign-up is stored as a PendingSignup in the security table (24 h TTL) until the
 * address owner opens the link; only then is the user created. Verification tokens are
 * `<key>.<secret>`: `key` is a keyed hash of the address (HMAC with a key derived from the
 * JWT secret, so it reveals nothing), `secret` 32 random bytes. Only SHA-256(token) is
 * stored. One pending sign-up per address: a newer sign-up or a resend replaces it, which
 * also invalidates every older link of that address.
 */

export const VERIFY_TOKEN_RE = /^[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/;

/** Is email verification on? `SIGNUP_VERIFICATION=off` restores immediate sign-up (see RELEASE.md). */
export function verificationEnabled(): boolean {
  return (process.env.SIGNUP_VERIFICATION || 'required').toLowerCase() !== 'off';
}

/** Store key of an address's pending sign-up (never the raw address). */
export async function signupKey(email: string): Promise<string> {
  const key = await jwt.derivedKey('signup');
  return createHmac('sha256', key).update(email).digest('base64url').slice(0, 22);
}

export function hashVerifyToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Constant-time comparison of two hex digests. */
export function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

/**
 * Silent per-address limits shared by register and resend. Resolves false (and counts
 * nothing further) when over a limit: the caller answers as usual and sends nothing.
 */
export async function signupMailAllowed(address: string): Promise<boolean> {
  return await enforceLimit('signup-mail-burst', address, LIMITS.signupMailPerEmailBurst.limit, LIMITS.signupMailPerEmailBurst.windowSec, { silent: true })
    && await enforceLimit('signup-mail', address, LIMITS.signupMailPerEmail.limit, LIMITS.signupMailPerEmail.windowSec, { silent: true })
    && await enforceLimit('signup-mail-day', address, LIMITS.signupMailPerEmailDaily.limit, LIMITS.signupMailPerEmailDaily.windowSec, { silent: true });
}

/** Moving average of how long a mail takes to send (ms), per container. */
let mailMs = Number.isFinite(Number(process.env.MAIL_TIME_ESTIMATE_MS)) && process.env.MAIL_TIME_ESTIMATE_MS !== ''
  ? Number(process.env.MAIL_TIME_ESTIMATE_MS)
  : 150;

/** Send a mail; failures are logged without the error object (SES messages can contain the address). */
export async function sendQuietly(label: string, mail: Mail): Promise<void> {
  const started = Date.now();
  try {
    await getMailer()(mail);
  } catch (err: any) {
    console.error(`${label} mail failed:`, err?.name || 'Error');
  } finally {
    mailMs = mailMs * 0.8 + (Date.now() - started) * 0.2;
  }
}

/**
 * Wait about as long as sending a mail takes, on paths that send nothing for an address
 * that has no account, so their timing doesn't tell the two apart.
 */
export async function paddedNoMail(): Promise<void> {
  const ms = mailMs * (0.85 + Math.random() * 0.3);
  if (ms >= 1) await new Promise((r) => setTimeout(r, ms));
}

/**
 * Store a (new or replacement) pending sign-up with a fresh token and mail the link.
 * Any older link of the address stops working.
 */
export async function issueVerification(
  db: Store,
  pending: Omit<PendingSignup, 'tokenHash' | 'expiresAt'>,
): Promise<void> {
  const key = await signupKey(pending.email);
  const token = `${key}.${randomBytes(32).toString('base64url')}`;
  await db.putPendingSignup(key, {
    ...pending,
    tokenHash: hashVerifyToken(token),
    expiresAt: Date.now() + VERIFY_TOKEN_TTL_MS,
  });
  // The token is in the fragment: it never reaches a server log or a Referer header
  const link = `${frontendUrl()}/#verify=${token}`;
  await sendQuietly('Verification', verificationMail({
    to: pending.email,
    username: pending.username,
    link,
    hours: Math.round(VERIFY_TOKEN_TTL_MS / 3600000),
  }));
}

/**
 * Claim `preferred`, or the first free `preferred2`, `preferred3`, ... (the name was
 * taken while the sign-up waited for its verification). Resolves the claimed name.
 */
export async function claimUsername(db: Store, preferred: string, userId: string): Promise<{ username: string; generated: boolean }> {
  for (let i = 0; i < 50; i++) {
    const candidate = i === 0 ? preferred : `${preferred.slice(0, 20 - String(i + 1).length)}${i + 1}`;
    if (await db.getUserByUsername(candidate)) continue;
    if (!(await db.reserveUsername(candidate, userId))) continue;
    return { username: candidate, generated: i > 0 };
  }
  throw new Error('Could not claim a username');
}
