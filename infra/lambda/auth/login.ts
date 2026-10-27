import { APIGatewayProxyEvent } from 'aws-lambda';
import * as response from '../shared/response';
import * as jwt from '../shared/jwt';
import * as password from '../shared/password';
import { getStore, Store, User } from '../shared/store';
import { handle, parseBody, clientIp, enforceLimit, HttpError } from '../shared/http';
import { usernameFromEmail, normalizeUsername, usernameError } from '../shared/validate';
import { profileOf } from '../shared/profile';
import { LIMITS, loginLockMs } from '../shared/limits';

/**
 * Accounts created before usernames existed get one derived from their email's
 * local part on first login (made unique with a numeric suffix). The app then
 * prompts the user to keep or change it (user.usernameGenerated).
 */
export async function ensureUsername(db: Store, user: User): Promise<User> {
  if (user.username) return lowercaseLegacyUsername(db, user);
  const base = usernameFromEmail(user.email);
  for (let i = 0; i < 50; i++) {
    const candidate = i === 0 ? base : `${base.slice(0, 20 - String(i + 1).length)}${i + 1}`;
    if (await db.getUserByUsername(candidate)) continue;
    if (!(await db.reserveUsername(candidate, user.userId))) continue;
    await db.updateUser(user.userId, { username: candidate, usernameGenerated: true });
    return { ...user, username: candidate, usernameGenerated: true };
  }
  throw new Error('Could not derive a username');
}

/**
 * 1.x stored usernames as typed ("SirKitBoi"); 2.0 looks handles up lowercased, so
 * such accounts had no user page and could not sign in by username. On sign-in the
 * handle becomes lowercase (reserved, projects re-labelled, old reservation released)
 * and the original spelling is kept as the display name. Left as is if the lowercase
 * handle is invalid or taken by someone else.
 */
export async function lowercaseLegacyUsername(db: Store, user: User): Promise<User> {
  const lower = normalizeUsername(user.username);
  if (lower === user.username) return user;
  try {
    if (usernameError(lower)) return user;
    const holder = await db.getUserByUsername(lower);
    if (holder && holder.userId !== user.userId) return user;
    if (!(await db.reserveUsername(lower, user.userId))) return user;
    const displayName = user.displayName || user.username;
    await db.updateUser(user.userId, { username: lower, displayName });
    await db.renameUserProjects(user.userId, lower);
    await db.releaseUsername(user.username, user.userId);
    return { ...user, username: lower, displayName };
  } catch (err: any) {
    console.warn('Login: lowercasing the username failed', err?.name || err);
    return user;
  }
}

const INVALID = 'Invalid credentials';

/**
 * POST /api/auth/login { login (email or username), password }
 *
 * Uniform for unknown accounts: same 401 body and a bcrypt comparison either way.
 * Consecutive failures lock the account (or, for an unknown login, that login string)
 * with exponential backoff; the 429 is the same whether or not the account exists.
 */
export const handler = handle('Login', async (event: APIGatewayProxyEvent) => {
  const db = getStore();
  const { login, password: plainPassword } = parseBody(event);

  if (typeof login !== 'string' || typeof plainPassword !== 'string' || !login || !plainPassword || login.length > 254) {
    return response.error('Login (email or username) and password are required', 400);
  }

  await enforceLimit('login-ip', clientIp(event), LIMITS.loginPerIp.limit, LIMITS.loginPerIp.windowSec);

  // Find user by email or username
  const loginLower = login.trim().toLowerCase();
  let user = await db.getUserByEmail(loginLower);
  if (!user) user = await db.getUserByUsername(loginLower);

  const failureKey = user ? `u#${user.userId}` : `n#${loginLower}`;
  const now = new Date();
  const failures = await db.getAuthFailures(failureKey);
  if (failures && failures.lockedUntil > now.getTime()) {
    const wait = Math.ceil((failures.lockedUntil - now.getTime()) / 1000);
    throw new HttpError(
      `Too many failed sign-in attempts. Try again in ${wait < 90 ? `${wait} seconds` : `${Math.ceil(wait / 60)} minutes`}, or reset your password.`,
      429, { code: 'login_locked', retryAfter: wait },
    );
  }

  let ok = false;
  if (user) ok = await password.verify(plainPassword.slice(0, 256), user.passwordHash);
  else await password.burnTime(plainPassword.slice(0, 256));

  if (!user || !ok) {
    await db.recordAuthFailure(failureKey, now, loginLockMs);
    return response.error(INVALID, 401);
  }
  if (failures) await db.clearAuthFailures(failureKey);

  // Hashes from 1.x (bcrypt cost 10) are upgraded on the next successful sign-in
  if (password.needsRehash(user.passwordHash)) {
    try {
      await db.updateUser(user.userId, { passwordHash: await password.hash(plainPassword) });
    } catch (err: any) {
      console.warn('Login: rehash failed', err?.name || err);
    }
  }

  user = await ensureUsername(db, user);

  const token = await jwt.sign({ userId: user.userId, email: user.email, username: user.username, tv: user.tokenVersion || 0 });
  return response.success({
    token,
    userId: user.userId,
    email: user.email,
    username: user.username,
    user: profileOf(user, { self: true }),
  });
});
