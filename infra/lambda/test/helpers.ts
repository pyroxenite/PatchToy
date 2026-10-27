import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { setStore } from '../shared/store';
import { MemoryStore } from '../shared/memory-store';
import { setBlobStore, BlobStore, PresignedUpload } from '../shared/blobs';
import { setMailer, Mail } from '../shared/mailer';

// Set before any handler (shared/jwt) is loaded: the secret is checked at import
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-0123456789abcdef0123456789';
// Fast bcrypt in tests (production uses cost 12; the policy test checks it)
process.env.BCRYPT_ROUNDS = process.env.BCRYPT_ROUNDS || '4';
// The test mailer is instant: no padding on paths that send no mail
process.env.MAIL_TIME_ESTIMATE_MS = process.env.MAIL_TIME_ESTIMATE_MS || '0';

export class MemoryBlobs implements BlobStore {
  deleted: string[] = [];
  presigned: string[] = [];
  async presignUpload(key: string): Promise<PresignedUpload> {
    this.presigned.push(key);
    return { url: 'http://blobs.test/upload', fields: { key }, maxBytes: 150 * 1024 };
  }
  publicUrl(key: string | undefined | null) {
    return key ? `http://blobs.test/${key}` : null;
  }
  async delete(key: string) {
    this.deleted.push(key);
  }
}

/** Fresh in-memory store + blob store + mail outbox for a test. */
export function fresh() {
  const store = new MemoryStore();
  const blobs = new MemoryBlobs();
  const outbox: Mail[] = [];
  setStore(store);
  setBlobStore(blobs);
  setMailer(async (mail) => { outbox.push(mail); });
  return { store, blobs, outbox };
}

/** The verification token of the last sign-up mail (to `to`, if given) in an outbox. */
export function verifyTokenFrom(outbox: Mail[], to?: string): string {
  const mails = to ? outbox.filter(m => m.to === to) : outbox;
  const m = /#verify=([A-Za-z0-9_.-]+)/.exec(mails[mails.length - 1]?.text || '');
  if (!m) throw new Error(`no verification link in the outbox${to ? ` for ${to}` : ''}`);
  return m[1];
}

/** Drop every rate-limit counter (tests that need several mails to one address in a row). */
export function clearRateLimits(store: MemoryStore): void {
  for (const k of [...store.security.keys()]) if (k.startsWith('rl#')) store.security.delete(k);
}

/**
 * Sign up through the email-verification flow: register, open the link from the
 * outbox (verify-email). Resolves the verify-email body (session token included).
 */
export async function signupVerified(outbox: Mail[], body: { email: string; username: string; password: string }, ip?: string) {
  // Lazy: the handlers load shared/jwt, which needs JWT_SECRET (set above)
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const register = require('../auth/register');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const verifyEmail = require('../auth/verify-email');
  const res = await register.handler(event({ body, ip }));
  if (res.statusCode !== 202) throw new Error(`register ${res.statusCode}: ${res.body}`);
  const done = await verifyEmail.handler(event({ body: { token: verifyTokenFrom(outbox, body.email.trim().toLowerCase()) }, ip }));
  if (done.statusCode !== 200) throw new Error(`verify-email ${done.statusCode}: ${done.body}`);
  return json(done) as { token: string; userId: string; username: string; email: string; user: any };
}

/** The reset token of the last reset mail in an outbox. */
export function resetTokenFrom(outbox: Mail[]): string {
  const m = /#reset=([A-Za-z0-9_-]+)/.exec(outbox[outbox.length - 1]?.text || '');
  if (!m) throw new Error('no reset link in the outbox');
  return m[1];
}

interface EventOptions {
  body?: unknown;
  rawBody?: string;
  token?: string | null;
  path?: Record<string, string>;
  query?: Record<string, string>;
  ip?: string;
  userAgent?: string;
  origin?: string;
}

export function event(opts: EventOptions = {}): APIGatewayProxyEvent {
  const headers: Record<string, string> = { 'User-Agent': opts.userAgent || 'node-test' };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.origin) headers.Origin = opts.origin;
  return {
    body: opts.rawBody !== undefined ? opts.rawBody : opts.body === undefined ? null : JSON.stringify(opts.body),
    headers,
    multiValueHeaders: {},
    httpMethod: 'GET',
    isBase64Encoded: false,
    path: '/',
    pathParameters: opts.path || null,
    queryStringParameters: opts.query || null,
    multiValueQueryStringParameters: null,
    stageVariables: null,
    requestContext: { identity: { sourceIp: opts.ip || '203.0.113.7' } } as any,
    resource: '/',
  };
}

export function json(res: APIGatewayProxyResult): any {
  return JSON.parse(res.body);
}

/** Minimal valid project data with `n` nodes. */
export function projectData(n = 2, extra: Record<string, any> = {}) {
  const nodes = Array.from({ length: n }, (_, i) => ({ id: i, type: i === 0 ? 'Preview' : 'UV', x: i * 10, y: 0, data: {} }));
  return { version: '1.0', graph: { nodes, connections: [] }, customNodes: {}, ...extra };
}
