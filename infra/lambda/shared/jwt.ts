import * as jwt from 'jsonwebtoken';
import { createHmac } from 'crypto';

/**
 * Session tokens (HS256 JWTs).
 *
 * - Signed with a secret of at least 32 characters, read from SSM Parameter Store
 *   (JWT_SECRET_PARAM, SecureString) or the JWT_SECRET env var. There is no default:
 *   a missing or short secret fails closed (cold start throws / requests get 500).
 * - Every session token carries `aud` / `iss` / `typ: 'session'` and the user's
 *   `tv` (tokenVersion). The auth middleware (shared/http.ts) compares `tv` with the
 *   users table, so a password reset or a username change signs out every older token.
 * - Only HS256 is accepted.
 * - Password-reset tokens are NOT JWTs (opaque random values stored hashed, single
 *   use, see auth/request-password-reset.ts), so they can never be used as a session.
 */

export const SESSION_AUDIENCE = 'patchtoy:session';
export const ISSUER = 'patchtoy';
export const MIN_SECRET_LENGTH = 32;
const SESSION_EXPIRY = '30d';
const ALGORITHM = 'HS256';

export interface TokenPayload {
  userId: string;
  email: string;
  username: string;
  /** tokenVersion of the user when the token was issued (0 for tokens issued before 2.0). */
  tv: number;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

function checked(secret: string | undefined | null, source: string): string {
  if (!secret || secret.length < MIN_SECRET_LENGTH) {
    throw new ConfigError(`JWT secret (${source}) is missing or shorter than ${MIN_SECRET_LENGTH} characters`);
  }
  return secret;
}

// Fail closed at cold start when the secret comes from the environment
if (!process.env.JWT_SECRET_PARAM) checked(process.env.JWT_SECRET, 'JWT_SECRET');

let cached: string | null = null;
let loading: Promise<string> | null = null;

async function loadSecret(): Promise<string> {
  const param = process.env.JWT_SECRET_PARAM;
  if (!param) return checked(process.env.JWT_SECRET, 'JWT_SECRET');
  // Provided by the Lambda Node.js runtime (marked external in the CDK bundling)
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');
  const r = await new SSMClient({}).send(new GetParameterCommand({ Name: param, WithDecryption: true }));
  return checked(r?.Parameter?.Value, `SSM ${param}`);
}

/** The signing secret, loaded once per container. Rejects (ConfigError) when misconfigured. */
export async function getSecret(): Promise<string> {
  if (cached) return cached;
  if (!loading) {
    loading = loadSecret().then((s) => (cached = s)).finally(() => { loading = null; });
  }
  return loading;
}

/** Tests only: forget the cached secret. */
export function resetSecretCacheForTests(): void {
  cached = null;
  loading = null;
}

/** A key derived from the secret for another purpose (e.g. view hashing), so the JWT key is never reused as-is. */
export async function derivedKey(label: string): Promise<Buffer> {
  return createHmac('sha256', await getSecret()).update(`patchtoy:${label}`).digest();
}

/** Sign a session token for a user. */
export async function sign(payload: TokenPayload): Promise<string> {
  const { userId, email, username, tv } = payload;
  return jwt.sign({ userId, email, username, tv: tv || 0, typ: 'session' }, await getSecret(), {
    algorithm: ALGORITHM,
    expiresIn: SESSION_EXPIRY,
    audience: SESSION_AUDIENCE,
    issuer: ISSUER,
    subject: userId,
  });
}

/**
 * Verify a session token. Returns null for anything that isn't a valid session token
 * (bad signature, other algorithm, expired, reset or other token types).
 *
 * Tokens issued before 2.0 (no aud / iss / typ, no tv) are accepted as tokenVersion 0
 * until they expire, unless LEGACY_SESSION_TOKENS=reject. Every user starts at
 * tokenVersion 0, so a password reset or rename still revokes them.
 */
export async function verify(token: string): Promise<TokenPayload | null> {
  const secret = await getSecret();
  let p: any;
  try {
    p = jwt.verify(token, secret, { algorithms: [ALGORITHM] });
  } catch (err) {
    return null;
  }
  if (!p || typeof p !== 'object' || typeof p.userId !== 'string' || !p.userId) return null;

  if (p.typ === 'session' && p.aud === SESSION_AUDIENCE && p.iss === ISSUER) {
    return { userId: p.userId, email: p.email, username: p.username, tv: Number.isInteger(p.tv) ? p.tv : 0 };
  }
  const legacy = p.aud === undefined && p.iss === undefined && p.typ === undefined && p.type === undefined && p.tv === undefined;
  if (legacy && process.env.LEGACY_SESSION_TOKENS !== 'reject') {
    return { userId: p.userId, email: p.email, username: p.username, tv: 0 };
  }
  return null;
}

/**
 * Extract token from Authorization header
 */
export function extractToken(authHeader?: string): string | null {
  if (!authHeader) return null;

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    return null;
  }

  return parts[1];
}
