/**
 * Abuse limits enforced in the handlers (DynamoDB counters with TTL, see Store).
 * They complement the optional AWS WAF rate rules (ENABLE_WAF, RELEASE.md), which stop
 * floods before they reach Lambda; these work per account / email as well as per IP.
 */
export const LIMITS = {
  /** Sign-in attempts per IP (any account). */
  loginPerIp: { limit: 60, windowSec: 15 * 60 },
  /** Accounts created per IP. */
  registerPerIp: { limit: 30, windowSec: 60 * 60 },
  /** Registration attempts per email address. */
  registerPerEmail: { limit: 5, windowSec: 60 * 60 },
  /** Reset requests per IP. */
  resetRequestPerIp: { limit: 20, windowSec: 60 * 60 },
  /** Reset mails per address (over it the request is answered as usual, no mail is sent). */
  resetMailPerEmail: { limit: 1, windowSec: 5 * 60 },
  resetMailPerEmailDaily: { limit: 5, windowSec: 24 * 60 * 60 },
  /** Reset attempts (token submissions) per IP. */
  resetSubmitPerIp: { limit: 30, windowSec: 60 * 60 },
  /**
   * Sign-up mails per address (verification links and "you already have an account"
   * notices, from register and resend together). Over a limit the request is answered
   * as usual and nothing is sent or changed (no mail bombing, no enumeration).
   */
  signupMailPerEmailBurst: { limit: 1, windowSec: 60 },
  signupMailPerEmail: { limit: 3, windowSec: 60 * 60 },
  signupMailPerEmailDaily: { limit: 6, windowSec: 24 * 60 * 60 },
  /** "Resend verification email" requests per IP. */
  resendVerificationPerIp: { limit: 20, windowSec: 60 * 60 },
  /** Verification link submissions per IP. */
  verifySubmitPerIp: { limit: 30, windowSec: 60 * 60 },
  /** Views counted per viewer per day, across all projects. */
  viewsPerViewerDaily: { limit: 200, windowSec: 24 * 60 * 60 },
};

/** Failed sign-ins allowed before the account (or the typed login) is locked. */
export const FREE_LOGIN_FAILURES = 5;
const LOCK_BASE_MS = 30 * 1000;
const LOCK_MAX_MS = 15 * 60 * 1000;

/** Lockout after `count` consecutive failures: 30 s, doubling, at most 15 minutes. */
export function loginLockMs(count: number): number {
  if (count < FREE_LOGIN_FAILURES) return 0;
  return Math.min(LOCK_MAX_MS, LOCK_BASE_MS * 2 ** (count - FREE_LOGIN_FAILURES));
}

/** Password reset links are valid this long (single use). */
export const RESET_TOKEN_TTL_MS = 30 * 60 * 1000;

/** Email verification links (sign-up) are valid this long (single use). */
export const VERIFY_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
