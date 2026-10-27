import { APIGatewayProxyEvent } from 'aws-lambda';
import { v4 as uuidv4 } from 'uuid';
import * as response from '../shared/response';
import * as jwt from '../shared/jwt';
import { getStore, User } from '../shared/store';
import { handle, parseBody, clientIp, enforceLimit } from '../shared/http';
import { profileOf } from '../shared/profile';
import { LIMITS } from '../shared/limits';
import { VERIFY_TOKEN_RE, hashVerifyToken, sameHash, claimUsername } from '../shared/signup';

export const VERIFY_INVALID = 'This sign-up link is invalid, expired or was already used. Sign in, or sign up again to get a new link.';

/**
 * POST /api/auth/verify-email { token }
 *
 * Completes an email-verification sign-up (auth/register.ts): the link's token is
 * checked against the address's pending sign-up (latest link only, 24 h, single use:
 * the conditional delete succeeds for exactly one request), then the account is created
 * and a session token returned (same shape as login), so the link signs the user in.
 *
 * Every failure (malformed, unknown, expired, replaced, already used, address taken in
 * the meantime) gets the same 401 { code: 'verify_invalid' }.
 */
export const handler = handle('Verify email', async (event: APIGatewayProxyEvent) => {
  const { token } = parseBody(event);
  if (!token || typeof token !== 'string') return response.error('Token is required', 400);
  await enforceLimit('verify-submit-ip', clientIp(event), LIMITS.verifySubmitPerIp.limit, LIMITS.verifySubmitPerIp.windowSec);
  const invalid = () => response.error(VERIFY_INVALID, 401, { code: 'verify_invalid' });
  if (!VERIFY_TOKEN_RE.test(token)) return invalid();

  const db = getStore();
  const key = token.slice(0, 22);
  const hashed = hashVerifyToken(token);
  const pending = await db.getPendingSignup(key);
  if (!pending || pending.expiresAt < Date.now() || !sameHash(hashed, pending.tokenHash)) return invalid();

  // Single use: only one request can delete the record carrying this token hash
  const consumed = await db.consumePendingSignup(key, hashed);
  if (!consumed) return invalid();

  // The address got an account another way meanwhile (e.g. SIGNUP_VERIFICATION=off): never a second one
  if (await db.getUserByEmail(consumed.email)) return invalid();

  const userId = uuidv4();
  const { username, generated } = await claimUsername(db, consumed.username, userId);
  const now = new Date().toISOString();
  const user: User = {
    userId,
    email: consumed.email,
    username,
    passwordHash: consumed.passwordHash,
    createdAt: now,
    emailVerifiedAt: now,
    tokenVersion: 0,
    projectCount: 0,
    ...(generated ? { usernameGenerated: true } : {}),
  };
  try {
    await db.createUser(user);
  } catch (err) {
    await db.releaseUsername(username, userId);
    throw err;
  }

  const session = await jwt.sign({ userId, email: user.email, username, tv: 0 });
  return response.success(
    { token: session, userId, email: user.email, username, user: profileOf(user, { self: true }), verified: true },
    200,
    { 'Cache-Control': 'no-store' },
  );
});
