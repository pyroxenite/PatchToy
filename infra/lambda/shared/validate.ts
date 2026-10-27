import type { Visibility } from './store';

/**
 * Input validation shared by the handlers. Everything a client sends is
 * size-limited and type-checked here before it reaches the store.
 */

/** Largest accepted request body (DynamoDB items are capped at 400 KB). */
export const MAX_BODY_BYTES = 380 * 1024;
/** Largest accepted project data (serialized JSON). */
export const MAX_DATA_BYTES = 350 * 1024;
export const MAX_NAME_LENGTH = 80;
export const MAX_DESCRIPTION_LENGTH = 500;
export const MAX_DISPLAY_NAME_LENGTH = 40;
export const MAX_NODES = 2000;
/** Custom node definitions embedded in a project (customNodes). */
export const MAX_CUSTOM_NODES = 100;
export const MAX_CUSTOM_GLSL_LENGTH = 64 * 1024;
/** Same rule as the app (src/core/customNodes.js): an identifier, no Object.prototype names. */
export const CUSTOM_NODE_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,48}$/;
const FORBIDDEN_KEYS = new Set([...Object.getOwnPropertyNames(Object.prototype), '__proto__', 'prototype', 'constructor']);

/** Per-account project quota. */
export const MAX_PROJECTS_PER_USER = 500;

export const VISIBILITIES: Visibility[] = ['private', 'unlisted', 'public'];

export const USERNAME_RE = /^[a-z0-9_-]{3,20}$/;

/** Handles that would collide with app routes or impersonate the service. */
export const RESERVED_USERNAMES = new Set([
  'admin', 'administrator', 'root', 'system', 'support', 'help', 'api', 'app', 'www', 'mail',
  'me', 'u', 'p', 'user', 'users', 'project', 'projects', 'public', 'community', 'demo', 'demos',
  'gallery', 'explore', 'login', 'logout', 'register', 'signup', 'signin', 'settings', 'account',
  'patchtoy', 'official', 'staff', 'moderator', 'null', 'undefined', 'anonymous',
  'mod', 'mods', 'moderators', 'team', 'security', 'abuse', 'noreply', 'no-reply', 'postmaster', 'webmaster',
]);

/** Words a handle may not start or end with, after folding look-alikes (adm1n, p4tchtoy, patch-toy). */
const RESERVED_STEMS = ['patchtoy', 'admin', 'moderator', 'official', 'support'];
/** Exact handles (after folding) that are reserved too. */
const RESERVED_EXACT = ['staff', 'root', 'system', 'mod', 'mods', 'team', 'security', 'help', 'api'];

/** Fold a handle for look-alike checks: drop - and _, map digits that read as letters. */
export function usernameSkeleton(username: string): string {
  const map: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b', '9': 'g' };
  return username.replace(/[-_]/g, '').replace(/[0-9]/g, (d) => map[d] || d).replace(/l/g, 'i');
}

function isReservedLookalike(username: string): boolean {
  const skel = usernameSkeleton(username);
  if (RESERVED_EXACT.some((w) => usernameSkeleton(w) === skel)) return true;
  return RESERVED_STEMS.some((w) => {
    const stem = usernameSkeleton(w);
    return skel.startsWith(stem) || skel.endsWith(stem);
  });
}

export class ValidationError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'ValidationError';
    this.status = status;
  }
}

/**
 * Invisible / direction-changing characters that can disguise text (zero-width
 * spaces and joiners, bidi overrides and isolates, BOM, soft hyphen).
 */
// eslint-disable-next-line no-misleading-character-class
const INVISIBLE_RE = /[\u00AD\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g;

/** Collapse whitespace, strip control and invisible / bidi characters, NFKC-normalise and trim. */
export function cleanText(value: unknown, max: number, field: string, { multiline = false } = {}): string {
  if (typeof value !== 'string') throw new ValidationError(`${field} must be a string`);
  let s = value.normalize('NFKC').replace(INVISIBLE_RE, '');
  // eslint-disable-next-line no-control-regex
  s = s.replace(multiline ? /[\u0000-\u0009\u000B-\u001F\u007F]/g : /[\u0000-\u001F\u007F]/g, ' ');
  s = multiline ? s.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim() : s.replace(/\s+/g, ' ').trim();
  if (s.length > max) throw new ValidationError(`${field} must be at most ${max} characters`);
  return s;
}

export function validateProjectName(value: unknown): string {
  const name = cleanText(value, MAX_NAME_LENGTH, 'Name');
  if (!name) throw new ValidationError('Name is required');
  return name;
}

export function validateDescription(value: unknown): string {
  if (value === undefined || value === null) return '';
  return cleanText(value, MAX_DESCRIPTION_LENGTH, 'Description', { multiline: true });
}

export function validateDisplayName(value: unknown): string {
  if (value === undefined || value === null) return '';
  return cleanText(value, MAX_DISPLAY_NAME_LENGTH, 'Display name');
}

/** Lowercase + validate a username. Returns an error message, or null when valid. */
export function usernameError(username: string): string | null {
  if (!USERNAME_RE.test(username)) return 'Username must be 3-20 characters (lowercase letters, numbers, _ and -)';
  if (RESERVED_USERNAMES.has(username) || isReservedLookalike(username)) return 'That username is reserved';
  return null;
}

export function normalizeUsername(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/** A username suggestion from an email local part (legacy accounts without one). */
export function usernameFromEmail(email: string): string {
  let base = String(email || '').split('@')[0].toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  if (base.length > 16) base = base.slice(0, 16);
  if (base.length < 3) base = `${base}user`.slice(0, 16);
  if (RESERVED_USERNAMES.has(base) || isReservedLookalike(base)) base = 'patcher';
  return base;
}

export interface ProjectStats {
  nodeCount: number;
  hasJS: boolean;
}

/**
 * Validate project data: a JSON object with a graph of nodes, under the size cap.
 * Returns stats used on cards.
 */
export function validateProjectData(data: unknown): ProjectStats {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new ValidationError('Project data must be an object');
  const json = JSON.stringify(data);
  if (Buffer.byteLength(json, 'utf8') > MAX_DATA_BYTES) {
    throw new ValidationError(`Project is too large (max ${Math.round(MAX_DATA_BYTES / 1024)} KB)`, 413);
  }
  const d = data as any;
  const graph = d.graph !== undefined ? d.graph : d; // very old format: graph data at the top level
  if (!graph || typeof graph !== 'object' || !Array.isArray(graph.nodes)) {
    throw new ValidationError('Project data must contain a graph with nodes');
  }
  if (graph.nodes.length > MAX_NODES) throw new ValidationError(`Too many nodes (max ${MAX_NODES})`);
  if (graph.connections !== undefined && !Array.isArray(graph.connections)) throw new ValidationError('Invalid graph connections');
  for (const n of graph.nodes) {
    if (!n || typeof n !== 'object' || typeof n.type !== 'string') throw new ValidationError('Invalid node in graph');
  }
  validateCustomNodes(d.customNodes);
  return {
    nodeCount: graph.nodes.length,
    hasJS: graph.nodes.some((n: any) => n.type === 'JS'),
  };
}

/**
 * customNodes: { [name]: { customGLSL, category?, inputs?, outputs? } }. Names are
 * identifiers (no Object.prototype keys); built-in name clashes are rejected by the app,
 * which knows its node library.
 */
export function validateCustomNodes(customNodes: unknown): void {
  if (customNodes === undefined || customNodes === null) return;
  if (typeof customNodes !== 'object' || Array.isArray(customNodes)) throw new ValidationError('Invalid custom nodes');
  const names = Object.keys(customNodes as object);
  if (names.length > MAX_CUSTOM_NODES) throw new ValidationError(`Too many custom nodes (max ${MAX_CUSTOM_NODES})`);
  for (const name of names) {
    if (!CUSTOM_NODE_NAME_RE.test(name) || FORBIDDEN_KEYS.has(name)) {
      throw new ValidationError(`Invalid custom node name: ${JSON.stringify(name.slice(0, 60))}`);
    }
    const def = (customNodes as Record<string, any>)[name];
    if (!def || typeof def !== 'object' || Array.isArray(def)) throw new ValidationError(`Invalid custom node ${name}`);
    if (typeof def.customGLSL !== 'string' || !def.customGLSL || def.customGLSL.length > MAX_CUSTOM_GLSL_LENGTH) {
      throw new ValidationError(`Custom node ${name}: customGLSL must be a string of at most ${MAX_CUSTOM_GLSL_LENGTH} characters`);
    }
    if (def.category !== undefined && (typeof def.category !== 'string' || def.category.length > 40)) {
      throw new ValidationError(`Custom node ${name}: invalid category`);
    }
    for (const key of ['inputs', 'outputs']) {
      if (def[key] !== undefined && (!Array.isArray(def[key]) || def[key].length > 64)) {
        throw new ValidationError(`Custom node ${name}: invalid ${key}`);
      }
    }
  }
}

/**
 * Requested visibility from a body: `visibility` ('private' | 'unlisted' | 'public'),
 * or the 1.x boolean `isPublic` (true = anyone with the link, i.e. unlisted).
 * Returns undefined when neither is present.
 */
export function parseVisibility(body: Record<string, any>): Visibility | undefined {
  if (body.visibility !== undefined && body.visibility !== null) {
    if (!VISIBILITIES.includes(body.visibility)) throw new ValidationError("visibility must be 'private', 'unlisted' or 'public'");
    return body.visibility;
  }
  if (body.isPublic !== undefined) {
    if (typeof body.isPublic !== 'boolean') throw new ValidationError('isPublic must be a boolean');
    return body.isPublic ? 'unlisted' : 'private';
  }
  return undefined;
}

/** Project ids are UUIDs; anything else is rejected before touching the store. */
export function isProjectId(id: unknown): id is string {
  return typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}
