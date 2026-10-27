import { APIGatewayProxyEvent } from 'aws-lambda';
import { createHash, randomBytes } from 'crypto';
import { getStore } from '../shared/store';
import * as response from '../shared/response';
import { handle, parseBody, clientIp, enforceLimit } from '../shared/http';
import { getMailer } from '../shared/mailer';
import { LIMITS, RESET_TOKEN_TTL_MS } from '../shared/limits';
import { paddedNoMail } from '../shared/signup';

const FRONTEND_URL = () => (process.env.FRONTEND_URL || 'http://localhost:5200').replace(/\/+$/, '');
const MESSAGE = 'If that email exists, a password reset link has been sent';

/** SHA-256 of a reset token: only the hash is stored. */
export function hashResetToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

/**
 * POST /api/auth/request-password-reset { email }
 *
 * Always the same answer (no account enumeration). For a known address: a random
 * single-use token (32 bytes), stored as its SHA-256 with a 30-minute expiry, sent as
 * https://<site>/#reset=<token>. The token is in the fragment, so it never reaches a
 * server log or a Referer header. At most one mail per address per 5 minutes.
 */
export const handler = handle('Request password reset', async (event: APIGatewayProxyEvent) => {
  const { email } = parseBody(event);
  if (!email || typeof email !== 'string' || email.length > 254) {
    return response.error('Email is required', 400);
  }

  await enforceLimit('reset-ip', clientIp(event), LIMITS.resetRequestPerIp.limit, LIMITS.resetRequestPerIp.windowSec);

  const address = email.trim().toLowerCase();
  const db = getStore();
  const user = await db.getUserByEmail(address);
  if (!user) {
    // As slow as sending the mail, so the timing doesn't reveal the account either
    await paddedNoMail();
    return response.success({ message: MESSAGE });
  }

  // Over the per-address limits: answer as usual, send nothing (no mail bombing)
  const allowed = await enforceLimit('reset-mail', address, LIMITS.resetMailPerEmail.limit, LIMITS.resetMailPerEmail.windowSec, { silent: true })
    && await enforceLimit('reset-mail-day', address, LIMITS.resetMailPerEmailDaily.limit, LIMITS.resetMailPerEmailDaily.windowSec, { silent: true });
  if (!allowed) {
    await paddedNoMail();
    return response.success({ message: MESSAGE });
  }

  const token = randomBytes(32).toString('base64url');
  await db.putResetToken(hashResetToken(token), {
    userId: user.userId,
    tv: user.tokenVersion || 0,
    expiresAt: Date.now() + RESET_TOKEN_TTL_MS,
  });

  const resetUrl = `${FRONTEND_URL()}/#reset=${token}`;
  const minutes = Math.round(RESET_TOKEN_TTL_MS / 60000);
  const name = escapeHtml(user.username || 'there');
  try {
    await getMailer()({
      to: user.email,
      subject: 'Reset your PatchToy password',
      html: `<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .button { display: inline-block; padding: 12px 24px; background: #007acc; color: #ffffff !important; text-decoration: none; border-radius: 4px; margin: 20px 0; }
    .footer { margin-top: 30px; font-size: 12px; color: #666; }
  </style>
</head>
<body>
  <div class="container">
    <h2>Reset your password</h2>
    <p>Hi ${name},</p>
    <p>You asked to reset the password of your PatchToy account. Click the button below to choose a new one:</p>
    <a href="${resetUrl}" class="button">Reset password</a>
    <p>Or copy and paste this link into your browser:</p>
    <p><a href="${resetUrl}">${resetUrl}</a></p>
    <p>The link works once and expires in ${minutes} minutes. Resetting your password signs you out on every device.</p>
    <p>If you didn't ask for this, you can ignore this email: your password stays the same.</p>
    <div class="footer"><p>— PatchToy</p></div>
  </div>
</body>
</html>`,
      text: `Hi ${user.username || 'there'},

You asked to reset the password of your PatchToy account. Open this link to choose a new one:
${resetUrl}

The link works once and expires in ${minutes} minutes. Resetting your password signs you out on every device.

If you didn't ask for this, you can ignore this email: your password stays the same.

— PatchToy
`,
    });
  } catch (err: any) {
    // Never log the error object: SES messages can contain the recipient address
    console.error('Password reset mail failed:', err?.name || 'Error');
  }
  return response.success({ message: MESSAGE });
});
