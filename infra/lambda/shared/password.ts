import * as bcrypt from 'bcryptjs';
import { randomBytes } from 'crypto';

/**
 * Password hashing (bcrypt) and policy.
 *
 * Cost 12. Hashes made with a lower cost (1.x used 10) still verify; login rehashes
 * them at the current cost (needsRehash). BCRYPT_ROUNDS lowers the cost for the unit
 * tests only (never set it in a deployment).
 */
export const DEFAULT_ROUNDS = 12;
function rounds(): number {
  const n = Number.parseInt(process.env.BCRYPT_ROUNDS || '', 10);
  return Number.isInteger(n) && n >= 4 && n <= 15 ? n : DEFAULT_ROUNDS;
}

export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 256;

/** The most common passwords of 8+ characters (subset of public breach top lists), lowercased. */
const COMMON_PASSWORDS = new Set([
  'password', 'password1', 'password12', 'password123', 'password1234', 'passw0rd', 'p@ssw0rd', 'p@ssword',
  'password!', 'password01', 'passwort', 'motdepasse', 'contraseña', 'contrasena',
  '12345678', '123456789', '1234567890', '12345678910', '0123456789', '87654321', '11111111', '00000000',
  '123123123', '12341234', '11223344', '1q2w3e4r', '1q2w3e4r5t', '1qaz2wsx', 'zaq12wsx', 'qwertyuiop',
  'qwerty123', 'qwerty12', 'qwerty1234', 'qwertyui', 'asdfghjkl', 'asdfasdf', 'azertyuiop', 'zxcvbnm1',
  'abc12345', 'abcd1234', 'abcdefgh', 'aa123456', 'a1234567', 'iloveyou', 'iloveyou1', 'sunshine',
  'princess', 'football', 'baseball', 'superman', 'trustno1', 'welcome1', 'welcome123', 'whatever',
  'starwars', 'computer', 'michelle', 'jennifer', 'corvette', 'mercedes', 'shadow12', 'master123',
  'letmein1', 'letmein123', 'changeme', 'changeme1', 'admin123', 'administrator', 'monkey123', 'dragon12',
  'access14', 'mustang1', 'internet', 'samsung1', 'pokemon1', 'chocolate', 'butterfly', 'liverpool',
  'qwerty12345', 'q1w2e3r4', 'q1w2e3r4t5', 'zaq1zaq1', 'secret123', 'default1', 'test1234', 'testtest',
  'user1234', 'login123', 'hello123', 'freedom1', 'ncc1701d', 'shader123', 'patchtoy', 'patchtoy1',
]);

export async function hash(password: string): Promise<string> {
  return bcrypt.hash(password, rounds());
}

export async function verify(password: string, hashed: string): Promise<boolean> {
  return bcrypt.compare(password, hashed);
}

/** True when a stored hash uses a lower cost than the current one. */
export function needsRehash(hashed: string): boolean {
  try {
    return bcrypt.getRounds(hashed) < rounds();
  } catch (e) {
    return false;
  }
}

const dummies = new Map<number, Promise<string>>();

/**
 * Run a full bcrypt comparison against a throwaway hash (same cost), so a login
 * for an unknown account takes as long as one with a wrong password.
 */
export async function burnTime(password: string): Promise<void> {
  const r = rounds();
  if (!dummies.has(r)) dummies.set(r, bcrypt.hash(randomBytes(16).toString('hex'), r));
  await bcrypt.compare(password, await dummies.get(r)!);
}

/**
 * Password policy: 8-256 characters, not a common password, not the username or email.
 * Returns an error message, or null when acceptable.
 */
export function validatePassword(password: unknown, { username = '', email = '' } = {}): string | null {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  }
  if (password.length > MAX_PASSWORD_LENGTH) return 'Password is too long';
  const lower = password.toLowerCase();
  if (COMMON_PASSWORDS.has(lower) || /^(.)\1+$/.test(password)) {
    return 'That password is too common. Choose a less guessable one.';
  }
  const u = String(username || '').toLowerCase();
  const e = String(email || '').toLowerCase();
  if ((u && lower === u) || (e && (lower === e || lower === e.split('@')[0]))) {
    return 'Your password can’t be your username or email.';
  }
  return null;
}

/**
 * Validate email format
 */
export function validateEmail(email: string): boolean {
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return re.test(email);
}

/**
 * Alias for hash (for backward compatibility)
 */
export const hashPassword = hash;
