import {
  Store, User, UserPatch, Project, ProjectPatch, ProjectSummary, Page,
  PublicListOptions, UserProjectsOptions, toSummary, encodeCursor, decodeCursor,
  byPopularity, matchesQuery, InvalidCursorError, Visibility, ResetTokenRecord, AuthFailures, PendingSignup,
} from './store';

const clone = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

/** Set isPublic / visibility / publicOwner for a visibility (same attributes as DynamoStore). */
function applyVisibility(p: Project, v: Visibility) {
  p.isPublic = v !== 'private';
  if (v === 'public') {
    p.visibility = 'public';
    p.publicOwner = p.userId;
  } else {
    delete p.visibility;
    delete p.publicOwner;
  }
}

/**
 * In-memory Store with the same observable behaviour as DynamoStore.
 * Used by the lambda unit tests and the local mock API (scripts/mock-api.mjs).
 */
export class MemoryStore implements Store {
  users = new Map<string, User>();
  handles = new Map<string, string>(); // username -> userId
  projects = new Map<string, Project>();
  /** Security table: rate counters, claims, sign-in failures, reset tokens (key -> { value, expires }). */
  security = new Map<string, { value: any; expires: number }>();
  /** Monotonic clock so successive writes in one millisecond still order correctly. */
  private lastStamp = 0;

  private stamp(): string {
    const t = Math.max(Date.now(), this.lastStamp + 1);
    this.lastStamp = t;
    return new Date(t).toISOString();
  }

  private sec(key: string, now = Date.now()) {
    const e = this.security.get(key);
    if (!e) return null;
    if (e.expires && e.expires <= now) {
      this.security.delete(key);
      return null;
    }
    return e;
  }

  async getUser(userId: string) {
    return clone(this.users.get(userId) || null);
  }

  async getUserByEmail(email: string) {
    for (const u of this.users.values()) if (u.email === email) return clone(u);
    return null;
  }

  async getUserByUsername(username: string) {
    for (const u of this.users.values()) if (u.username === username) return clone(u);
    return null;
  }

  async createUser(user: User) {
    if (this.users.has(user.userId)) throw new Error('ConditionalCheckFailed');
    this.users.set(user.userId, clone(user));
  }

  async updateUser(userId: string, patch: UserPatch) {
    const u = this.users.get(userId);
    if (!u) throw new Error('User not found');
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      if (v === null) delete (u as any)[k];
      else (u as any)[k] = v;
    }
  }

  async reserveUsername(username: string, userId: string) {
    const holder = this.handles.get(username);
    if (holder && holder !== userId) return false;
    this.handles.set(username, userId);
    return true;
  }

  async releaseUsername(username: string, userId: string) {
    if (this.handles.get(username) === userId) this.handles.delete(username);
  }

  async getProject(projectId: string) {
    return clone(this.projects.get(projectId) || null);
  }

  async createProject(project: Project) {
    const p = clone(project);
    p.nameLower = p.name.toLowerCase();
    applyVisibility(p, project.visibility === 'public' ? 'public' : p.isPublic ? 'unlisted' : 'private');
    p.views = p.views || 0;
    p.forks = p.forks || 0;
    this.projects.set(p.projectId, p);
  }

  async updateProject(projectId: string, patch: ProjectPatch, opts: { touch?: boolean } = {}) {
    const p = this.projects.get(projectId);
    if (!p) throw new Error('Project not found');
    const touch = opts.touch !== false;
    if (patch.name !== undefined) {
      p.name = patch.name;
      p.nameLower = patch.name.toLowerCase();
    }
    if (patch.description !== undefined) p.description = patch.description;
    if (patch.data !== undefined) p.data = clone(patch.data);
    if (patch.nodeCount !== undefined) p.nodeCount = patch.nodeCount;
    if (patch.hasJS !== undefined) p.hasJS = patch.hasJS;
    if (patch.username !== undefined) p.username = patch.username;
    if (patch.publishedAt !== undefined) p.publishedAt = patch.publishedAt;
    if (patch.thumbKey === null) delete p.thumbKey;
    else if (patch.thumbKey !== undefined) p.thumbKey = patch.thumbKey;
    if (patch.visibility !== undefined) applyVisibility(p, patch.visibility);
    if (touch) p.updatedAt = this.stamp();
    return p.updatedAt;
  }

  async deleteProject(projectId: string) {
    this.projects.delete(projectId);
  }

  private page<T>(list: T[], opts: { limit: number; cursor?: string | null }): Page<T> {
    const c = decodeCursor<{ o: number }>(opts.cursor);
    if (c && (typeof c.o !== 'number' || c.o < 0)) throw new InvalidCursorError();
    const offset = c ? c.o : 0;
    const items = list.slice(offset, offset + opts.limit);
    const next = offset + items.length;
    return { items, cursor: next < list.length ? encodeCursor({ o: next }) : null };
  }

  async listUserProjects(userId: string, opts: UserProjectsOptions = {}) {
    const list = [...this.projects.values()]
      .filter(p => p.userId === userId && (!opts.publicOnly || p.visibility === 'public'))
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
      .map(p => clone(toSummary(p)));
    return this.page<ProjectSummary>(list, { limit: Math.min(opts.limit || 500, 500), cursor: opts.cursor });
  }

  async listPublicProjects(opts: PublicListOptions) {
    let list = [...this.projects.values()].filter(p => p.visibility === 'public' && matchesQuery(p, opts.q));
    list = opts.sort === 'popular'
      ? list.sort(byPopularity)
      : list.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    return this.page<ProjectSummary>(list.map(p => clone(toSummary(p))), opts);
  }

  async recordView(projectId: string, viewerKey: string, now: Date, windowMs: number) {
    const p = this.projects.get(projectId);
    if (!p || !p.isPublic) return null;
    const cutoff = new Date(now.getTime() - windowMs).toISOString();
    if (p.lastViewKey === viewerKey && p.lastViewAt && p.lastViewAt >= cutoff) return null;
    p.views = (p.views || 0) + 1;
    p.lastViewKey = viewerKey;
    p.lastViewAt = now.toISOString();
    return p.views;
  }

  async incrementForks(projectId: string) {
    const p = this.projects.get(projectId);
    if (p) p.forks = (p.forks || 0) + 1;
  }

  async renameUserProjects(userId: string, username: string) {
    for (const p of this.projects.values()) if (p.userId === userId) p.username = username;
  }

  async incrementTokenVersion(userId: string) {
    const u = this.users.get(userId);
    if (!u) throw new Error('User not found');
    u.tokenVersion = (u.tokenVersion || 0) + 1;
    return u.tokenVersion;
  }

  async reserveProjectSlot(userId: string, max: number) {
    const u = this.users.get(userId);
    if (!u) return false;
    if ((u.projectCount || 0) >= max) return false;
    u.projectCount = (u.projectCount || 0) + 1;
    return true;
  }

  async releaseProjectSlot(userId: string) {
    const u = this.users.get(userId);
    if (u && (u.projectCount || 0) > 0) u.projectCount = (u.projectCount || 0) - 1;
  }

  async rateHit(key: string, windowSec: number, now: Date) {
    const start = Math.floor(now.getTime() / 1000 / windowSec) * windowSec;
    const k = `rl#${key}#${start}`;
    const e = this.sec(k, now.getTime());
    const count = (e ? e.value : 0) + 1;
    this.security.set(k, { value: count, expires: (start + windowSec) * 1000 });
    return count;
  }

  async claimOnce(key: string, ttlSec: number, now: Date) {
    const k = `once#${key}`;
    if (this.sec(k, now.getTime())) return false;
    this.security.set(k, { value: true, expires: ttlSec ? now.getTime() + ttlSec * 1000 : 0 });
    return true;
  }

  async getAuthFailures(key: string) {
    const e = this.sec(`af#${key}`);
    return e ? (clone(e.value) as AuthFailures) : null;
  }

  async recordAuthFailure(key: string, now: Date, lockMs: (count: number) => number) {
    const k = `af#${key}`;
    const e = this.sec(k, now.getTime());
    const count = (e ? e.value.count : 0) + 1;
    const lock = lockMs(count);
    const value: AuthFailures = { count, lockedUntil: lock > 0 ? now.getTime() + lock : (e ? e.value.lockedUntil : 0) };
    this.security.set(k, { value, expires: now.getTime() + 24 * 3600 * 1000 });
    return clone(value);
  }

  async clearAuthFailures(key: string) {
    this.security.delete(`af#${key}`);
  }

  async putResetToken(tokenHash: string, record: ResetTokenRecord) {
    this.security.set(`reset#${tokenHash}`, { value: clone(record), expires: record.expiresAt });
  }

  async getResetToken(tokenHash: string) {
    const e = this.sec(`reset#${tokenHash}`);
    return e ? (clone(e.value) as ResetTokenRecord) : null;
  }

  async consumeResetToken(tokenHash: string) {
    const e = this.sec(`reset#${tokenHash}`);
    if (!e) return null;
    this.security.delete(`reset#${tokenHash}`);
    return clone(e.value) as ResetTokenRecord;
  }

  async putPendingSignup(key: string, record: PendingSignup) {
    this.security.set(`signup#${key}`, { value: clone(record), expires: record.expiresAt });
  }

  async getPendingSignup(key: string) {
    const e = this.sec(`signup#${key}`);
    return e ? (clone(e.value) as PendingSignup) : null;
  }

  async consumePendingSignup(key: string, tokenHash: string) {
    const e = this.security.get(`signup#${key}`);
    if (!e || e.value.tokenHash !== tokenHash) return null;
    this.security.delete(`signup#${key}`);
    return clone(e.value) as PendingSignup;
  }
}
