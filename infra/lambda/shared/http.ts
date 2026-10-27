import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { createHmac } from 'crypto';
import * as response from './response';
import * as jwt from './jwt';
import { MAX_BODY_BYTES, ValidationError } from './validate';
import { InvalidCursorError, Project, ProjectSummary, User, getStore, toSummary, visibilityOf } from './store';
import { getBlobStore } from './blobs';

export class HttpError extends Error {
  status: number;
  code?: string;
  /** Seconds, sent as Retry-After (429). */
  retryAfter?: number;
  constructor(message: string, status: number, { code, retryAfter }: { code?: string; retryAfter?: number } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

/** Parse a JSON object body, size-limited. */
export function parseBody(event: APIGatewayProxyEvent): Record<string, any> {
  let raw = event.body || '';
  if (event.isBase64Encoded) raw = Buffer.from(raw, 'base64').toString('utf8');
  if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) throw new HttpError('Request body too large', 413);
  if (!raw) return {};
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch (e) {
    throw new HttpError('Invalid JSON body', 400);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError('Body must be a JSON object', 400);
  return body as Record<string, any>;
}

function header(event: APIGatewayProxyEvent, name: string): string | undefined {
  const headers = event.headers || {};
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === lower) return v ?? undefined;
  return undefined;
}

/** The authenticated caller: identity from the users table (never from the token's claims). */
export interface AuthContext {
  userId: string;
  username: string;
  email: string;
  user: User;
}

/**
 * Resolve a bearer token to the current user, or explain why not:
 * 'missing' (no token), 'invalid' (bad / expired / not a session token),
 * 'revoked' (tokenVersion changed: password reset, username change; or user deleted).
 */
async function authenticate(event: APIGatewayProxyEvent): Promise<AuthContext | 'missing' | 'invalid' | 'revoked'> {
  const token = jwt.extractToken(header(event, 'Authorization'));
  if (!token) return 'missing';
  const payload = await jwt.verify(token);
  if (!payload) return 'invalid';
  const user = await getStore().getUser(payload.userId);
  if (!user || (user.tokenVersion || 0) !== payload.tv) return 'revoked';
  return { userId: user.userId, username: user.username, email: user.email, user };
}

/** The caller, or null (no / invalid / revoked token). */
export async function optionalAuth(event: APIGatewayProxyEvent): Promise<AuthContext | null> {
  const r = await authenticate(event);
  return typeof r === 'string' ? null : r;
}

export async function requireAuth(event: APIGatewayProxyEvent): Promise<AuthContext> {
  const r = await authenticate(event);
  if (r === 'missing') throw new HttpError('Missing authorization token', 401, { code: 'auth_required' });
  if (r === 'invalid') throw new HttpError('Invalid or expired session. Sign in again.', 401, { code: 'session_invalid' });
  if (r === 'revoked') throw new HttpError('Your session has ended (password or username changed). Sign in again.', 401, { code: 'session_expired' });
  return r;
}

/**
 * The client's IP as seen by API Gateway (not X-Forwarded-For, which the client
 * controls). Used for rate limits and view de-duplication, never stored raw.
 */
export function clientIp(event: APIGatewayProxyEvent): string {
  return event.requestContext?.identity?.sourceIp || 'unknown';
}

/**
 * Anonymous viewer key for view de-duplication: an HMAC of the user id (signed in)
 * or the IP. The User-Agent is ignored (trivial to rotate). No raw IP is stored.
 */
export async function viewerKey(event: APIGatewayProxyEvent, userId?: string | null): Promise<string> {
  const key = await jwt.derivedKey('view-hash');
  const who = userId ? `u:${userId}` : `ip:${clientIp(event)}`;
  return createHmac('sha256', key).update(who).digest('base64url').slice(0, 22);
}

/** A rate-limit key that never contains a raw IP / email (HMAC with a derived key). */
export async function limitKey(scope: string, value: string): Promise<string> {
  const key = await jwt.derivedKey('rate-limit');
  return `${scope}#${createHmac('sha256', key).update(value).digest('base64url').slice(0, 22)}`;
}

/**
 * Count a request against a fixed-window limit; throws 429 when over it.
 * `silent`: resolve false instead of throwing (callers that must answer uniformly).
 */
export async function enforceLimit(scope: string, value: string, limit: number, windowSec: number, { silent = false } = {}): Promise<boolean> {
  const count = await getStore().rateHit(await limitKey(scope, value), windowSec, new Date());
  if (count <= limit) return true;
  if (silent) return false;
  throw new HttpError('Too many requests. Wait a few minutes and try again.', 429, { code: 'rate_limited', retryAfter: windowSec });
}

/**
 * CORS: `ALLOWED_ORIGINS` (comma separated) restricts Access-Control-Allow-Origin to
 * those origins (the request's Origin is echoed when allowed). Unset or `*`: any origin.
 * No credentials: the API authenticates with bearer tokens, never cookies.
 */
function applyCors(result: APIGatewayProxyResult, event: APIGatewayProxyEvent): APIGatewayProxyResult {
  const allowed = (process.env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim()).filter(Boolean);
  if (!allowed.length || allowed.includes('*')) return result;
  const origin = header(event, 'Origin') || '';
  const headers: Record<string, any> = { ...(result.headers || {}) };
  headers['Access-Control-Allow-Origin'] = allowed.includes(origin) ? origin : allowed[0];
  headers.Vary = 'Origin';
  return { ...result, headers };
}

/** Wrap a handler: maps HttpError / ValidationError to their status, anything else to 500. */
export function handle(name: string, fn: (event: APIGatewayProxyEvent) => Promise<APIGatewayProxyResult>) {
  return async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    let result: APIGatewayProxyResult;
    try {
      result = await fn(event);
    } catch (err: any) {
      if (err instanceof HttpError) {
        result = response.error(err.message, err.status, err.code ? { code: err.code } : {});
        if (err.retryAfter) result.headers = { ...result.headers, 'Retry-After': String(err.retryAfter) };
      } else if (err instanceof ValidationError) {
        result = response.error(err.message, err.status);
      } else if (err instanceof InvalidCursorError) {
        result = response.error('Invalid cursor', 400);
      } else if (err instanceof jwt.ConfigError) {
        console.error(`${name}: server misconfigured: ${err.message}`);
        result = response.error('Server misconfigured', 500);
      } else {
        console.error(`${name} error:`, err?.name || 'Error', err?.message || '');
        result = response.error('Internal server error', 500);
      }
    }
    return applyCors(result, event);
  };
}

/** Public card shape of a project (never includes data, emails or view bookkeeping). */
export function publicSummary(p: ProjectSummary | Project) {
  const s = 'data' in p ? toSummary(p as Project) : (p as ProjectSummary);
  return {
    id: s.projectId,
    name: s.name,
    description: s.description || '',
    username: s.username,
    /** Anyone with the link can open it (unlisted or public). */
    isPublic: s.isPublic === true,
    /** 'private' | 'unlisted' (link only) | 'public' (listed in Community and on the user page). */
    visibility: visibilityOf(s),
    thumbUrl: getBlobStore().publicUrl(s.thumbKey),
    views: s.views || 0,
    forks: s.forks || 0,
    nodeCount: s.nodeCount ?? null,
    hasJS: s.hasJS === true,
    forkedFrom: s.forkedFrom || null,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

/**
 * A project that just became private: drop its thumbnail (it sits on a public CDN
 * path) so an old card URL stops working. The owner's next save uploads a new one
 * under a new random key.
 */
export async function dropThumbnail(project: Pick<Project, 'projectId' | 'thumbKey'>): Promise<void> {
  if (!project.thumbKey) return;
  await getStore().updateProject(project.projectId, { thumbKey: null }, { touch: false });
  try {
    await getBlobStore().delete(project.thumbKey);
  } catch (err: any) {
    console.warn('Could not delete thumbnail', project.thumbKey, err?.name || err);
  }
}

export function queryParam(event: APIGatewayProxyEvent, name: string): string | undefined {
  const v = event.queryStringParameters?.[name];
  return v === null || v === undefined ? undefined : String(v);
}

export function clampLimit(value: string | undefined, fallback = 24, max = 60): number {
  const n = Number.parseInt(value || '', 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(max, n);
}
