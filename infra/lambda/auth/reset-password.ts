import { APIGatewayProxyEvent } from 'aws-lambda';
import { getStore } from '../shared/store';
import * as password from '../shared/password';
import * as response from '../shared/response';
import { handle, parseBody, clientIp, enforceLimit } from '../shared/http';
import { hashResetToken } from './request-password-reset';
import { LIMITS } from '../shared/limits';

const INVALID = 'This reset link is invalid, expired or was already used. Request a new one.';

/**
 * POST /api/auth/reset-password { token, newPassword }
 *
 * The token is single use (deleted atomically when consumed) and only valid for the
 * tokenVersion it was issued for. A successful reset bumps tokenVersion, which signs
 * out every existing session (and makes older reset links useless).
 */
export const handler = handle('Reset password', async (event: APIGatewayProxyEvent) => {
  const { token, newPassword } = parseBody(event);
  if (!token || typeof token !== 'string' || !newPassword) {
    return response.error('Token and new password are required', 400);
  }
  await enforceLimit('reset-submit-ip', clientIp(event), LIMITS.resetSubmitPerIp.limit, LIMITS.resetSubmitPerIp.windowSec);
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return response.error(INVALID, 401, { code: 'reset_invalid' });

  const db = getStore();
  const hashed = hashResetToken(token);
  const record = await db.getResetToken(hashed);
  if (!record || record.expiresAt < Date.now()) return response.error(INVALID, 401, { code: 'reset_invalid' });
  const user = await db.getUser(record.userId);
  if (!user || (user.tokenVersion || 0) !== record.tv) return response.error(INVALID, 401, { code: 'reset_invalid' });

  // Check the new password before using up the link
  const policy = password.validatePassword(newPassword, { username: user.username, email: user.email });
  if (policy) return response.error(policy, 400);

  // Single use: the conditional delete succeeds for exactly one request
  const consumed = await db.consumeResetToken(hashed);
  if (!consumed) return response.error(INVALID, 401, { code: 'reset_invalid' });

  await db.updateUser(user.userId, { passwordHash: await password.hash(newPassword as string) });
  await db.incrementTokenVersion(user.userId);
  await db.clearAuthFailures(`u#${user.userId}`);

  return response.success({ message: 'Password successfully reset. Sign in with your new password.' });
});
