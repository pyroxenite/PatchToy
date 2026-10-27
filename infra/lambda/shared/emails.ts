import { Mail } from './mailer';

/**
 * Sign-up email templates (HTML + plain text). Every interpolated value is escaped;
 * the only user-chosen value in a mail is the username, which is restricted to
 * `a-z 0-9 _ -` anyway. The password reset mail lives in auth/request-password-reset.ts.
 */

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

/** The site URL used in links (FRONTEND_URL, no trailing slash). */
export function frontendUrl(): string {
  return (process.env.FRONTEND_URL || 'http://localhost:5200').replace(/\/+$/, '');
}

function layout(title: string, body: string): string {
  return `<!DOCTYPE html>
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
    <h2>${escapeHtml(title)}</h2>
${body}
    <div class="footer"><p>— PatchToy</p></div>
  </div>
</body>
</html>`;
}

/** "Confirm your email" with the single-use link that creates the account. */
export function verificationMail({ to, username, link, hours }: { to: string; username: string; link: string; hours: number }): Mail {
  const u = escapeHtml(username);
  const href = escapeHtml(link);
  return {
    to,
    subject: 'Confirm your email to finish signing up for PatchToy',
    html: layout('Finish signing up', `    <p>Hi @${u},</p>
    <p>Someone (hopefully you) signed up for PatchToy with this email address, as <strong>@${u}</strong>. Click the button below to confirm it and finish creating the account:</p>
    <a href="${href}" class="button">Confirm my email</a>
    <p>Or copy and paste this link into your browser:</p>
    <p><a href="${href}">${href}</a></p>
    <p>The link works once and expires in ${hours} hours. If you asked for several emails, only the newest link works.</p>
    <p>If you didn't sign up, ignore this email: no account is created and nobody can use this address without the link.</p>`),
    text: `Hi @${username},

Someone (hopefully you) signed up for PatchToy with this email address, as @${username}. Open this link to confirm it and finish creating the account:
${link}

The link works once and expires in ${hours} hours. If you asked for several emails, only the newest link works.

If you didn't sign up, ignore this email: no account is created and nobody can use this address without the link.

— PatchToy
`,
  };
}

/** Sent instead of a verification link when the address already has an account. */
export function existingAccountMail({ to }: { to: string }): Mail {
  const site = frontendUrl();
  const href = escapeHtml(site);
  return {
    to,
    subject: 'Someone tried to sign up for PatchToy with your email',
    html: layout('You already have a PatchToy account', `    <p>Hi,</p>
    <p>Someone (maybe you) just tried to create a new PatchToy account with this email address. This address already has an account, so nothing was changed and no new account was created.</p>
    <p>If it was you, sign in instead. Forgot your password? Use <em>Forgot password?</em> in the sign-in dialog to reset it.</p>
    <a href="${href}" class="button">Go to PatchToy</a>
    <p>If it wasn't you, you can ignore this email: your account and password are unchanged.</p>`),
    text: `Hi,

Someone (maybe you) just tried to create a new PatchToy account with this email address. This address already has an account, so nothing was changed and no new account was created.

If it was you, sign in instead: ${site}
Forgot your password? Use "Forgot password?" in the sign-in dialog to reset it.

If it wasn't you, you can ignore this email: your account and password are unchanged.

— PatchToy
`,
  };
}
