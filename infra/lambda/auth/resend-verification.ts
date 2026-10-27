import { APIGatewayProxyEvent } from 'aws-lambda';
import * as response from '../shared/response';
import * as password from '../shared/password';
import { getStore } from '../shared/store';
import { handle, parseBody, clientIp, enforceLimit } from '../shared/http';
import { LIMITS } from '../shared/limits';
import { signupKey, signupMailAllowed, issueVerification, sendQuietly, paddedNoMail } from '../shared/signup';
import { existingAccountMail } from '../shared/emails';

export const RESEND_MESSAGE = 'If a sign-up is waiting for that address, a new link is on its way. Only the newest link works.';

/**
 * POST /api/auth/resend-verification { email }
 *
 * Always the same 200 answer. A waiting sign-up gets a new link (the older ones stop
 * working, the 24 h start again); an address that already has an account gets the
 * "you already have an account" notice; anything else gets nothing. Limited per IP
 * (429) and, silently, per address (shared with register's mails).
 */
export const handler = handle('Resend verification', async (event: APIGatewayProxyEvent) => {
  const { email } = parseBody(event);
  if (!email || typeof email !== 'string' || email.length > 254) {
    return response.error('Email is required', 400);
  }
  await enforceLimit('resend-ip', clientIp(event), LIMITS.resendVerificationPerIp.limit, LIMITS.resendVerificationPerIp.windowSec);

  const address = email.trim().toLowerCase();
  if (!password.validateEmail(address)) {
    await paddedNoMail();
    return response.success({ message: RESEND_MESSAGE });
  }

  const db = getStore();
  const user = await db.getUserByEmail(address);
  const pending = user ? null : await db.getPendingSignup(await signupKey(address));
  const live = pending && pending.expiresAt > Date.now() ? pending : null;
  if ((user || live) && await signupMailAllowed(address)) {
    if (user) {
      await sendQuietly('Sign-up notice', existingAccountMail({ to: user.email }));
    } else if (live) {
      await issueVerification(db, { email: live.email, username: live.username, passwordHash: live.passwordHash, createdAt: live.createdAt });
    }
  } else {
    await paddedNoMail();
  }
  return response.success({ message: RESEND_MESSAGE });
});
