/**
 * Data access layer.
 *
 * Handlers talk to a `Store` instead of DynamoDB directly, so the same handler
 * code runs against DynamoDB in AWS (DynamoStore), an in-memory store in unit
 * tests and in the local mock API (scripts/mock-api.mjs).
 */

export interface User {
  userId: string;
  email: string;
  username: string;
  passwordHash: string;
  createdAt: string;
  /** Optional public name shown on the user page (falls back to @username). */
  displayName?: string;
  /** True when the username was derived automatically (legacy accounts); the app prompts to confirm it. */
  usernameGenerated?: boolean;
  usernameChangedAt?: string;
  /**
   * Session epoch: session tokens carry it (`tv`) and stop working when it changes.
   * Bumped on password reset and username change. Missing = 0 (accounts from 1.x).
   */
  tokenVersion?: number;
  /** Number of projects the user owns (quota). Missing on 1.x accounts until the backfill / first save. */
  projectCount?: number;
  /**
   * When the address was confirmed (accounts created through the 2.0 email-verification
   * sign-up). Missing on accounts from 1.x and earlier 2.0 builds: they count as verified
   * (migration-safe default, see RELEASE.md). Unverified sign-ups never reach the users
   * table: they wait in the security table (PendingSignup) until the link is opened.
   */
  emailVerifiedAt?: string;
}

/** Who can open a project: only the owner, anyone with the link, or listed in Community too. */
export type Visibility = 'private' | 'unlisted' | 'public';

/** Public reference to the project a fork was made from. */
export interface ForkRef {
  id: string;
  username: string;
  name: string;
}

export interface Project {
  projectId: string;
  userId: string;
  username: string; // Denormalized for fast reads
  name: string;
  /** Lowercased name, used for search. */
  nameLower?: string;
  description?: string;
  data: any; // The full project JSON
  /** Readable by anyone with the link (unlisted or public). */
  isPublic: boolean;
  /**
   * Present ('public') only while the project is listed in Community: partition key of
   * the sparse public GSI. Unlisted projects have isPublic = true and no visibility.
   */
  visibility?: 'public';
  /** userId, present only while listed: partition key of the optional sparse user-public GSI. */
  publicOwner?: string;
  thumbKey?: string;
  views?: number;
  forks?: number;
  nodeCount?: number;
  hasJS?: boolean;
  forkedFrom?: ForkRef;
  createdAt: string;
  updatedAt: string;
  publishedAt?: string;
  /** Naive view rate limiting: hash of the last viewer and when it was counted. */
  lastViewKey?: string;
  lastViewAt?: string;
}

/** A project without its graph data (lists, cards). */
export type ProjectSummary = Omit<Project, 'data' | 'lastViewKey' | 'lastViewAt'>;

export interface ProjectPatch {
  name?: string;
  description?: string;
  data?: any;
  /** Sets isPublic / visibility / publicOwner together. */
  visibility?: Visibility;
  /** The project's userId; required with visibility 'public' (becomes publicOwner). */
  ownerId?: string;
  thumbKey?: string | null;
  nodeCount?: number;
  hasJS?: boolean;
  username?: string;
  publishedAt?: string;
}

export interface UserPatch {
  username?: string;
  displayName?: string | null;
  passwordHash?: string;
  usernameGenerated?: boolean;
  usernameChangedAt?: string;
}

/** Single-use password reset token (stored under the SHA-256 of the token). */
export interface ResetTokenRecord {
  userId: string;
  /** tokenVersion of the user when issued: a completed reset invalidates older links. */
  tv: number;
  /** Epoch ms. */
  expiresAt: number;
}

/**
 * A sign-up waiting for its email verification (security table, one per address, TTL).
 * Stored under a keyed hash of the address (signupKey), so a newer sign-up or a resend
 * for the same address replaces it, and older links stop working.
 */
export interface PendingSignup {
  email: string;
  username: string;
  passwordHash: string;
  /** SHA-256 (hex) of the current verification token: only the hash is stored. */
  tokenHash: string;
  createdAt: string;
  /** Epoch ms. */
  expiresAt: number;
}

export interface AuthFailures {
  count: number;
  /** Epoch ms; sign-in is refused before it. */
  lockedUntil: number;
}

export interface Page<T> {
  items: T[];
  /** Opaque cursor for the next page, or null when there is none. */
  cursor: string | null;
}

export interface PublicListOptions {
  sort: 'new' | 'popular';
  /** Lowercase search string (matches title or author). */
  q?: string;
  limit: number;
  cursor?: string | null;
}

export interface UserProjectsOptions {
  publicOnly?: boolean;
  limit?: number;
  cursor?: string | null;
}

export interface Store {
  getUser(userId: string): Promise<User | null>;
  getUserByEmail(email: string): Promise<User | null>;
  getUserByUsername(username: string): Promise<User | null>;
  createUser(user: User): Promise<void>;
  updateUser(userId: string, patch: UserPatch): Promise<void>;
  /** Claim a username for a user. Resolves false when someone else holds it. */
  reserveUsername(username: string, userId: string): Promise<boolean>;
  releaseUsername(username: string, userId: string): Promise<void>;

  getProject(projectId: string): Promise<Project | null>;
  createProject(project: Project): Promise<void>;
  /** Apply a patch. `touch` (default true) bumps updatedAt. Returns the new updatedAt. */
  updateProject(projectId: string, patch: ProjectPatch, opts?: { touch?: boolean }): Promise<string>;
  deleteProject(projectId: string): Promise<void>;

  listUserProjects(userId: string, opts?: UserProjectsOptions): Promise<Page<ProjectSummary>>;
  listPublicProjects(opts: PublicListOptions): Promise<Page<ProjectSummary>>;

  /**
   * Count a view of a public project unless the same viewer was the last one
   * counted within `windowMs`. Resolves the new count, or null when not counted.
   */
  recordView(projectId: string, viewerKey: string, now: Date, windowMs: number): Promise<number | null>;
  incrementForks(projectId: string): Promise<void>;
  /** Rewrite the denormalized username on every project of a user. */
  renameUserProjects(userId: string, username: string): Promise<void>;

  /** Atomically bump a user's tokenVersion. Resolves the new value. */
  incrementTokenVersion(userId: string): Promise<number>;
  /** Take one project slot of the user's quota. Resolves false when the quota is used up. */
  reserveProjectSlot(userId: string, max: number): Promise<boolean>;
  releaseProjectSlot(userId: string): Promise<void>;

  // --- abuse limits (security table, items expire through TTL)
  /** Count a hit in the current fixed window of `windowSec`. Resolves the count including this hit. */
  rateHit(key: string, windowSec: number, now: Date): Promise<number>;
  /** True the first time `key` is claimed within `ttlSec` (0 = forever). */
  claimOnce(key: string, ttlSec: number, now: Date): Promise<boolean>;
  getAuthFailures(key: string): Promise<AuthFailures | null>;
  /** Count a failed sign-in; `lockMs(count)` gives the lockout to apply (0 = none). */
  recordAuthFailure(key: string, now: Date, lockMs: (count: number) => number): Promise<AuthFailures>;
  clearAuthFailures(key: string): Promise<void>;
  putResetToken(tokenHash: string, record: ResetTokenRecord): Promise<void>;
  getResetToken(tokenHash: string): Promise<ResetTokenRecord | null>;
  /** Delete the token; resolves its record, or null when it was already used / never existed. */
  consumeResetToken(tokenHash: string): Promise<ResetTokenRecord | null>;
  /** Create or replace the pending sign-up of an address (`key` = signupKey(email)). */
  putPendingSignup(key: string, record: PendingSignup): Promise<void>;
  getPendingSignup(key: string): Promise<PendingSignup | null>;
  /**
   * Delete the pending sign-up if it still carries `tokenHash` (single use: exactly one
   * caller wins). Resolves the record, or null (used, replaced by a newer link, or gone).
   */
  consumePendingSignup(key: string, tokenHash: string): Promise<PendingSignup | null>;
}

/** The visibility of a stored project. */
export function visibilityOf(p: { isPublic?: boolean; visibility?: string }): Visibility {
  if (p.visibility === 'public') return 'public';
  return p.isPublic === true ? 'unlisted' : 'private';
}

let current: Store | null = null;

/** The active store (DynamoDB unless a test / the mock server installed another). */
export function getStore(): Store {
  if (!current) {
    // Lazy require: tests and the mock API never load the AWS SDK clients
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { DynamoStore } = require('./dynamo-store');
    current = new DynamoStore();
  }
  return current as Store;
}

export function setStore(store: Store | null): void {
  current = store;
}

/** Strip the heavy / private fields of a project. */
export function toSummary(p: Project): ProjectSummary {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { data, lastViewKey, lastViewAt, ...rest } = p;
  return rest;
}

/** Cursor helpers (base64url JSON) shared by the store implementations. */
export function encodeCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

export function decodeCursor<T = any>(cursor: string | null | undefined): T | null {
  if (!cursor) return null;
  if (cursor.length > 1024) throw new InvalidCursorError();
  try {
    return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as T;
  } catch (e) {
    throw new InvalidCursorError();
  }
}

export class InvalidCursorError extends Error {
  constructor() {
    super('Invalid cursor');
    this.name = 'InvalidCursorError';
  }
}

/** Popularity order: views, then most recently updated. */
export function byPopularity(a: { views?: number; updatedAt: string }, b: { views?: number; updatedAt: string }): number {
  return (b.views || 0) - (a.views || 0) || (b.updatedAt < a.updatedAt ? -1 : b.updatedAt > a.updatedAt ? 1 : 0);
}

/** Search match on title or author (q already lowercased). */
export function matchesQuery(p: { nameLower?: string; name: string; username: string }, q?: string): boolean {
  if (!q) return true;
  const name = p.nameLower ?? p.name.toLowerCase();
  return name.includes(q) || (p.username || '').toLowerCase().includes(q);
}
