import { APIGatewayProxyEvent } from 'aws-lambda';
import { v4 as uuidv4 } from 'uuid';
import * as response from '../shared/response';
import * as jwt from '../shared/jwt';
import * as password from '../shared/password';
import { getStore } from '../shared/store';
import { handle, parseBody, clientIp, enforceLimit } from '../shared/http';
import { normalizeUsername, usernameError } from '../shared/validate';
import { profileOf } from '../shared/profile';
import { LIMITS } from '../shared/limits';
import { verificationEnabled, signupMailAllowed, issueVerification, sendQuietly } from '../shared/signup';
import { existingAccountMail } from '../shared/emails';

/** The one answer to every accepted sign-up, whether or not the address has an account. */
export const CHECK_EMAIL = 'Check your email to finish signing up. The link expires in 24 hours.';

/**
 * POST /api/auth/register { email, username, password }
 *
 * Email-verification sign-up (default, SECURITY.md M5): the answer is always
 * 202 { pending: true, message: CHECK_EMAIL }, and
 *   - a new address gets a single-use verification link (24 h); the account is created
 *     only when it is opened (auth/verify-email.ts). Until then the sign-up waits in the
 *     security table and sign-in fails like any wrong password;
 *   - an address that already has an account gets a "someone tried to sign up with your
 *     email" notice instead, and nothing changes.
 * Both paths do the same work (bcrypt hash, the same rate-limit counters, one mail), so
 * neither the body nor the timing says whether the address is registered. Over the
 * per-address mail limits nothing is sent or changed (same answer).
 *
 * Errors that don't depend on the address stay explicit: invalid input (400), a taken
 * username (409: usernames are public anyway), rate limits (429, per IP / per address
 * typed, whether or not it exists).
 *
 * SIGNUP_VERIFICATION=off (escape hatch while SES is in sandbox, see RELEASE.md) restores
 * the immediate sign-up: 201 with a session token, 409 "Email already in use".
 */
export const handler = handle('Register', async (event: APIGatewayProxyEvent) => {
  const db = getStore();
  const { email: rawEmail, username: rawUsername, password: plainPassword } = parseBody(event);

  if (typeof rawEmail !== 'string' || typeof rawUsername !== 'string' || typeof plainPassword !== 'string' ||
      !rawEmail || !rawUsername || !plainPassword) {
    return response.error('Email, username, and password are required', 400);
  }

  const email = rawEmail.trim().toLowerCase();
  if (email.length > 254 || !password.validateEmail(email)) {
    return response.error('Invalid email format', 400);
  }

  await enforceLimit('register-ip', clientIp(event), LIMITS.registerPerIp.limit, LIMITS.registerPerIp.windowSec);
  await enforceLimit('register-email', email, LIMITS.registerPerEmail.limit, LIMITS.registerPerEmail.windowSec);

  const username = normalizeUsername(rawUsername);
  const badUsername = usernameError(username);
  if (badUsername) return response.error(badUsername, 400);

  const passwordError = password.validatePassword(plainPassword, { username, email });
  if (passwordError) return response.error(passwordError, 400);

  if (!verificationEnabled()) return registerImmediately(email, username, plainPassword);

  // Usernames are public (/u/<name>): saying one is taken leaks nothing about emails.
  // (A name claimed by another pending sign-up isn't held: whoever verifies first gets
  // it, the other account gets a numbered variant and is asked to confirm it.)
  if (await db.getUserByUsername(username)) {
    return response.error('Username already taken', 409);
  }

  const existing = await db.getUserByEmail(email);
  // Hash on both paths so a known address answers as slowly as a new one
  const passwordHash = await password.hash(plainPassword);
  const mayMail = await signupMailAllowed(email);
  if (mayMail) {
    if (existing) {
      await sendQuietly('Sign-up notice', existingAccountMail({ to: existing.email }));
    } else {
      await issueVerification(db, { email, username, passwordHash, createdAt: new Date().toISOString() });
    }
  }
  return response.success({ pending: true, message: CHECK_EMAIL }, 202);
});

/** Pre-verification behaviour (SIGNUP_VERIFICATION=off): the account exists at once. */
async function registerImmediately(email: string, username: string, plainPassword: string) {
  const db = getStore();
  if (await db.getUserByEmail(email)) {
    return response.error('Email already in use', 409);
  }
  // Legacy accounts have no reservation item: check the username index too
  if (await db.getUserByUsername(username)) {
    return response.error('Username already taken', 409);
  }

  const userId = uuidv4();
  if (!(await db.reserveUsername(username, userId))) {
    return response.error('Username already taken', 409);
  }

  const user = {
    userId,
    email,
    username,
    passwordHash: await password.hash(plainPassword),
    createdAt: new Date().toISOString(),
    tokenVersion: 0,
    projectCount: 0,
  };
  try {
    await db.createUser(user);
  } catch (err) {
    await db.releaseUsername(username, userId);
    throw err;
  }

  const token = await jwt.sign({ userId, email, username, tv: 0 });
  return response.success({ token, userId, email, username, user: profileOf(user, { self: true }) }, 201);
}
