import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  QueryCommand,
  UpdateCommand,
  DeleteCommand,
  QueryCommandInput,
} from '@aws-sdk/lib-dynamodb';
import {
  Store, User, UserPatch, Project, ProjectPatch, ProjectSummary, Page,
  PublicListOptions, UserProjectsOptions, encodeCursor, decodeCursor,
  byPopularity, matchesQuery, InvalidCursorError, ResetTokenRecord, AuthFailures, PendingSignup,
} from './store';
import { usernameKey } from './validate';

const USERS_TABLE = () => process.env.USERS_TABLE || 'PatchToy-Users';
const PROJECTS_TABLE = () => process.env.PROJECTS_TABLE || 'PatchToy-Projects';
/** Sparse GSI: partition `visibility` ('public' only on public projects), sort `updatedAt`. */
const PUBLIC_INDEX = () => process.env.PUBLIC_INDEX || 'public-updatedAt-index';
/** Optional second GSI (partition `visibility`, sort `views`), added in a later deployment. */
const POPULAR_INDEX = () => process.env.POPULAR_INDEX || '';
/**
 * Optional sparse GSI (partition `publicOwner`, sort `updatedAt`, card attributes only)
 * for user pages, added in a later deployment (ENABLE_USER_PUBLIC_INDEX, see RELEASE.md).
 */
const USER_PUBLIC_INDEX = () => process.env.USER_PUBLIC_INDEX || '';
/** Abuse limits, single-use reset tokens, view / fork claims. Partition `pk`, TTL `ttl`. */
const SECURITY_TABLE = () => process.env.SECURITY_TABLE || 'PatchToy-Security';
/** Without the popular index, "popular" ranks at most this many of the newest public projects. */
const POPULAR_SCAN_CAP = 300;
/** Pages read for the popular fallback (each page is at most 1 MB of card attributes). */
const POPULAR_SCAN_PAGES = 3;
/** Most items one page of a filtered query reads. */
const MAX_PAGE_ITEMS = 100;
/** A user's own list returns at most this many projects per request (= the per-user quota). */
const OWN_LIST_CAP = 500;
/** User page fallback (no user-public index yet): pages of the public index scanned for one author. */
const USER_PAGE_FALLBACK_PAGES = 2;
/**
 * Reservation items in the users table (`userId = "username#<key>"`, `handleOwner`): they make
 * usernames unique and are the case-insensitive username index (key = usernameKey(name)).
 * 1.x accounts reserved by the first backfill may still have an item spelled as typed
 * ("username#SirKitBoi"); sign-in and the backfill replace it with the key item.
 */
const HANDLE_PREFIX = 'username#';

/** Attributes returned for project cards (everything but the graph data and view bookkeeping). */
export const SUMMARY_ATTRIBUTES = [
  'projectId', 'userId', 'username', 'name', 'nameLower', 'description', 'isPublic', 'visibility',
  'thumbKey', 'views', 'forks', 'nodeCount', 'hasJS', 'forkedFrom', 'createdAt', 'updatedAt', 'publishedAt',
];

/** Cursor keys a client may send back, per index (ExclusiveStartKey is never taken blindly). */
const CURSOR_KEYS: Record<string, string[]> = {
  public: ['projectId', 'visibility', 'updatedAt'],
  popular: ['projectId', 'visibility', 'views'],
  user: ['projectId', 'userId', 'updatedAt'],
  userPublic: ['projectId', 'publicOwner', 'updatedAt'],
};

const nowSec = (d = new Date()) => Math.floor(d.getTime() / 1000);

function conditionFailed(err: any) {
  return err?.name === 'ConditionalCheckFailedException';
}

interface Sender {
  send(command: any): Promise<any>;
}

function projection() {
  const names: Record<string, string> = {};
  const parts = SUMMARY_ATTRIBUTES.map((attr, i) => {
    names[`#p${i}`] = attr;
    return `#p${i}`;
  });
  return { ProjectionExpression: parts.join(', '), names };
}

function startKey(cursor: string | null | undefined, kind: keyof typeof CURSOR_KEYS, expect: Record<string, any> = {}) {
  const key = decodeCursor<Record<string, unknown>>(cursor);
  if (!key) return undefined;
  if (typeof key !== 'object' || Array.isArray(key)) throw new InvalidCursorError();
  const allowed = CURSOR_KEYS[kind];
  for (const [k, v] of Object.entries(key)) {
    if (!allowed.includes(k)) throw new InvalidCursorError();
    if (typeof v !== 'string' && typeof v !== 'number') throw new InvalidCursorError();
  }
  for (const [k, v] of Object.entries(expect)) {
    if (key[k] !== v) throw new InvalidCursorError();
  }
  return key;
}

export class DynamoStore implements Store {
  private db: Sender;

  constructor(client?: Sender) {
    this.db = client || DynamoDBDocumentClient.from(new DynamoDBClient({}), {
      marshallOptions: { removeUndefinedValues: true },
    });
  }

  // ---------------------------------------------------------------- users

  async getUser(userId: string): Promise<User | null> {
    const r = await this.db.send(new GetCommand({ TableName: USERS_TABLE(), Key: { userId } }));
    return (r.Item as User) || null;
  }

  async getUserByEmail(email: string): Promise<User | null> {
    const r = await this.db.send(new QueryCommand({
      TableName: USERS_TABLE(),
      IndexName: 'email-index',
      KeyConditionExpression: 'email = :email',
      ExpressionAttributeValues: { ':email': email },
      Limit: 1,
    }));
    return (r.Items?.[0] as User) || null;
  }

  async getUserByUsername(username: string): Promise<User | null> {
    const raw = String(username || '').trim();
    const key = usernameKey(raw);
    if (!key) return null;
    const owner = await this.getHandleOwner(key);
    if (owner) {
      const user = await this.getUser(owner);
      // A stale reservation (owner renamed since, release failed) falls through to the index
      if (user && usernameKey(user.username) === key) return user;
    }
    // No reservation (accounts the backfill hasn't reached): exact match, as typed then as the key
    const exact = await this.queryUsername(raw);
    if (exact || key === raw) return exact;
    return this.queryUsername(key);
  }

  /** username-index, exact (case-sensitive) match. */
  private async queryUsername(username: string): Promise<User | null> {
    const r = await this.db.send(new QueryCommand({
      TableName: USERS_TABLE(),
      IndexName: 'username-index',
      KeyConditionExpression: 'username = :username',
      ExpressionAttributeValues: { ':username': username },
      Limit: 1,
    }));
    return (r.Items?.[0] as User) || null;
  }

  async createUser(user: User): Promise<void> {
    await this.db.send(new PutCommand({
      TableName: USERS_TABLE(),
      Item: user,
      ConditionExpression: 'attribute_not_exists(userId)',
    }));
  }

  async updateUser(userId: string, patch: UserPatch): Promise<void> {
    const sets: string[] = [];
    const removes: string[] = [];
    const names: Record<string, string> = {};
    const values: Record<string, any> = {};
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      names[`#${k}`] = k;
      if (v === null) {
        removes.push(`#${k}`);
      } else {
        values[`:${k}`] = v;
        sets.push(`#${k} = :${k}`);
      }
    }
    if (!sets.length && !removes.length) return;
    await this.db.send(new UpdateCommand({
      TableName: USERS_TABLE(),
      Key: { userId },
      UpdateExpression: [sets.length ? `SET ${sets.join(', ')}` : '', removes.length ? `REMOVE ${removes.join(', ')}` : ''].join(' ').trim(),
      ConditionExpression: 'attribute_exists(userId)',
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: Object.keys(values).length ? values : undefined,
    }));
  }

  async reserveUsername(username: string, userId: string): Promise<boolean> {
    const key = usernameKey(username);
    if (!key) return false;
    try {
      await this.db.send(new PutCommand({
        TableName: USERS_TABLE(),
        Item: { userId: HANDLE_PREFIX + key, handleOwner: userId, createdAt: new Date().toISOString() },
        ConditionExpression: 'attribute_not_exists(userId) OR handleOwner = :owner',
        ExpressionAttributeValues: { ':owner': userId },
      }));
      return true;
    } catch (err: any) {
      if (err?.name === 'ConditionalCheckFailedException') return false;
      throw err;
    }
  }

  async releaseUsername(username: string, userId: string): Promise<void> {
    const raw = String(username || '').trim();
    const key = usernameKey(raw);
    if (key) await this.releaseHandle(key, userId);
    if (raw && raw !== key) await this.releaseHandle(raw, userId);
  }

  async getHandleOwner(name: string): Promise<string | null> {
    if (!name) return null;
    const r = await this.db.send(new GetCommand({ TableName: USERS_TABLE(), Key: { userId: HANDLE_PREFIX + name } }));
    return typeof r.Item?.handleOwner === 'string' ? r.Item.handleOwner : null;
  }

  async releaseHandle(name: string, userId: string): Promise<void> {
    if (!name) return;
    try {
      await this.db.send(new DeleteCommand({
        TableName: USERS_TABLE(),
        Key: { userId: HANDLE_PREFIX + name },
        ConditionExpression: 'handleOwner = :owner',
        ExpressionAttributeValues: { ':owner': userId },
      }));
    } catch (err: any) {
      if (err?.name !== 'ConditionalCheckFailedException') throw err;
    }
  }

  // ------------------------------------------------------------- projects

  async getProject(projectId: string): Promise<Project | null> {
    const r = await this.db.send(new GetCommand({ TableName: PROJECTS_TABLE(), Key: { projectId } }));
    return (r.Item as Project) || null;
  }

  async createProject(project: Project): Promise<void> {
    const item: Project = {
      ...project,
      nameLower: project.name.toLowerCase(),
      usernameLower: (project.username || '').toLowerCase(),
      views: project.views || 0,
      forks: project.forks || 0,
    };
    // Listed ('public') projects carry the sparse GSI keys; unlisted / private ones don't
    if (item.visibility === 'public') {
      item.isPublic = true;
      item.publicOwner = item.userId;
    } else {
      delete item.visibility;
      delete item.publicOwner;
    }
    await this.db.send(new PutCommand({
      TableName: PROJECTS_TABLE(),
      Item: item,
      ConditionExpression: 'attribute_not_exists(projectId)',
    }));
  }

  async updateProject(projectId: string, patch: ProjectPatch, opts: { touch?: boolean } = {}): Promise<string> {
    const sets: string[] = [];
    const removes: string[] = [];
    const names: Record<string, string> = {};
    const values: Record<string, any> = {};
    const set = (attr: string, value: any) => {
      names[`#${attr}`] = attr;
      values[`:${attr}`] = value;
      sets.push(`#${attr} = :${attr}`);
    };
    const remove = (attr: string) => {
      names[`#${attr}`] = attr;
      removes.push(`#${attr}`);
    };

    if (patch.name !== undefined) {
      set('name', patch.name);
      set('nameLower', patch.name.toLowerCase());
    }
    if (patch.description !== undefined) set('description', patch.description);
    if (patch.data !== undefined) set('data', patch.data);
    if (patch.nodeCount !== undefined) set('nodeCount', patch.nodeCount);
    if (patch.hasJS !== undefined) set('hasJS', patch.hasJS);
    if (patch.username !== undefined) {
      set('username', patch.username);
      set('usernameLower', patch.username.toLowerCase());
    }
    if (patch.publishedAt !== undefined) set('publishedAt', patch.publishedAt);
    if (patch.thumbKey === null) remove('thumbKey');
    else if (patch.thumbKey !== undefined) set('thumbKey', patch.thumbKey);
    if (patch.visibility !== undefined) {
      set('isPublic', patch.visibility !== 'private');
      if (patch.visibility === 'public') {
        set('visibility', 'public');
        // An UpdateExpression can't copy userId into publicOwner: the caller passes it
        if (!patch.ownerId) throw new Error('updateProject: ownerId is required to list a project');
        set('publicOwner', patch.ownerId);
      } else {
        remove('visibility');
        remove('publicOwner');
      }
    }
    const now = new Date().toISOString();
    if (opts.touch !== false) set('updatedAt', now);
    if (!sets.length && !removes.length) return now;

    const r = await this.db.send(new UpdateCommand({
      TableName: PROJECTS_TABLE(),
      Key: { projectId },
      UpdateExpression: [sets.length ? `SET ${sets.join(', ')}` : '', removes.length ? `REMOVE ${removes.join(', ')}` : ''].join(' ').trim(),
      ConditionExpression: 'attribute_exists(projectId)',
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: Object.keys(values).length ? values : undefined,
      ReturnValues: 'UPDATED_NEW',
    }));
    return (r.Attributes?.updatedAt as string) || now;
  }

  async deleteProject(projectId: string): Promise<void> {
    await this.db.send(new DeleteCommand({ TableName: PROJECTS_TABLE(), Key: { projectId } }));
  }

  /**
   * Run a query until `limit` items were collected, the index is exhausted or
   * `maxPages` pages were read (filtered queries can return short pages).
   * `keep` filters each page in memory, like a FilterExpression (same reads billed),
   * for matches DynamoDB can't express (case-insensitive author search).
   */
  private async collect(input: QueryCommandInput, limit: number, start: Record<string, any> | undefined, maxPages = 5, keep?: (item: any) => boolean) {
    const items: any[] = [];
    const filtered = !!input.FilterExpression || !!keep;
    let key = start;
    let pages = 0;
    do {
      const r = await this.db.send(new QueryCommand({
        ...input,
        Limit: Math.min(MAX_PAGE_ITEMS, filtered ? Math.max(limit, 50) : limit - items.length),
        ExclusiveStartKey: key,
      }));
      items.push(...(keep ? (r.Items || []).filter(keep) : (r.Items || [])));
      key = r.LastEvaluatedKey;
      pages++;
    } while (key && items.length < limit && pages < maxPages);
    return { items, lastKey: key };
  }

  async listUserProjects(userId: string, opts: UserProjectsOptions = {}): Promise<Page<ProjectSummary>> {
    const { ProjectionExpression, names } = projection();
    if (opts.publicOnly) return this.listUserPublicProjects(userId, opts, ProjectionExpression, names);

    // Own list (signed-in owner). NOTE: userId-updatedAt-index projects ALL attributes, so
    // reads are billed on full items; the per-user quota and OWN_LIST_CAP bound them.
    const limit = Math.min(opts.limit || OWN_LIST_CAP, OWN_LIST_CAP);
    names['#uid'] = 'userId';
    const input: QueryCommandInput = {
      TableName: PROJECTS_TABLE(),
      IndexName: 'userId-updatedAt-index',
      KeyConditionExpression: '#uid = :userId',
      ProjectionExpression,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: { ':userId': userId },
      ScanIndexForward: false,
    };
    const { items, lastKey } = await this.collect(input, limit, startKey(opts.cursor, 'user', { userId }), Math.ceil(limit / MAX_PAGE_ITEMS));
    return { items: items as ProjectSummary[], cursor: lastKey ? encodeCursor(lastKey) : null };
  }

  /**
   * Listed projects of one user (user page, unauthenticated). Never reads full items:
   * the user-public index when deployed, else the public index (card attributes)
   * filtered by author, a bounded number of pages.
   */
  private async listUserPublicProjects(userId: string, opts: UserProjectsOptions, ProjectionExpression: string, names: Record<string, string>) {
    const limit = Math.min(opts.limit || 48, 96);
    if (USER_PUBLIC_INDEX()) {
      names['#owner'] = 'publicOwner';
      const { items, lastKey } = await this.collect({
        TableName: PROJECTS_TABLE(),
        IndexName: USER_PUBLIC_INDEX(),
        KeyConditionExpression: '#owner = :userId',
        ProjectionExpression,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: { ':userId': userId },
        ScanIndexForward: false,
      }, limit, startKey(opts.cursor, 'userPublic', { publicOwner: userId }));
      return { items: items as ProjectSummary[], cursor: lastKey ? encodeCursor(lastKey) : null };
    }
    names['#vis'] = 'visibility';
    names['#uid'] = 'userId';
    const { items, lastKey } = await this.collect({
      TableName: PROJECTS_TABLE(),
      IndexName: PUBLIC_INDEX(),
      KeyConditionExpression: '#vis = :public',
      FilterExpression: '#uid = :userId',
      ProjectionExpression,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: { ':public': 'public', ':userId': userId },
      ScanIndexForward: false,
    }, limit, startKey(opts.cursor, 'public', { visibility: 'public' }), USER_PAGE_FALLBACK_PAGES);
    return { items: items as ProjectSummary[], cursor: lastKey ? encodeCursor(lastKey) : null };
  }

  async listPublicProjects(opts: PublicListOptions): Promise<Page<ProjectSummary>> {
    const { ProjectionExpression, names } = projection();
    names['#vis'] = 'visibility';
    const values: Record<string, any> = { ':public': 'public' };
    const base: QueryCommandInput = {
      TableName: PROJECTS_TABLE(),
      KeyConditionExpression: '#vis = :public',
      ProjectionExpression,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ScanIndexForward: false,
    };
    // Search (title or author, case-insensitive): matched in memory on the card attributes.
    // DynamoDB's contains() is case-sensitive, and `usernameLower` isn't projected into the
    // public indexes (a GSI's projection can't change without rebuilding it), so the
    // author is lowercased here; the reads billed are the same as with a FilterExpression.
    const q = opts.q;
    const keep = q ? (item: any) => matchesQuery(item, q) : undefined;

    if (opts.sort === 'popular' && POPULAR_INDEX()) {
      const { items, lastKey } = await this.collect({ ...base, IndexName: POPULAR_INDEX() }, opts.limit, startKey(opts.cursor, 'popular', { visibility: 'public' }), 5, keep);
      return { items: items as ProjectSummary[], cursor: lastKey ? encodeCursor(lastKey) : null };
    }

    if (opts.sort === 'popular') {
      // No views index yet: rank the newest POPULAR_SCAN_CAP public projects in memory
      const c = decodeCursor<{ o: number }>(opts.cursor);
      if (c && (typeof c.o !== 'number' || c.o < 0 || c.o > POPULAR_SCAN_CAP)) throw new InvalidCursorError();
      const offset = c ? c.o : 0;
      const { items } = await this.collect({ ...base, IndexName: PUBLIC_INDEX() }, POPULAR_SCAN_CAP, undefined, POPULAR_SCAN_PAGES, keep);
      const ranked = (items as ProjectSummary[]).sort(byPopularity);
      const page = ranked.slice(offset, offset + opts.limit);
      const next = offset + page.length;
      return { items: page, cursor: next < ranked.length ? encodeCursor({ o: next }) : null };
    }

    const { items, lastKey } = await this.collect({ ...base, IndexName: PUBLIC_INDEX() }, opts.limit, startKey(opts.cursor, 'public', { visibility: 'public' }), 5, keep);
    return { items: items as ProjectSummary[], cursor: lastKey ? encodeCursor(lastKey) : null };
  }

  async recordView(projectId: string, viewerKey: string, now: Date, windowMs: number): Promise<number | null> {
    try {
      const r = await this.db.send(new UpdateCommand({
        TableName: PROJECTS_TABLE(),
        Key: { projectId },
        UpdateExpression: 'ADD #views :one SET #lvk = :key, #lva = :now',
        ConditionExpression: '#isPublic = :true AND (attribute_not_exists(#lvk) OR #lvk <> :key OR #lva < :cutoff)',
        ExpressionAttributeNames: { '#views': 'views', '#lvk': 'lastViewKey', '#lva': 'lastViewAt', '#isPublic': 'isPublic' },
        ExpressionAttributeValues: {
          ':one': 1,
          ':key': viewerKey,
          ':now': now.toISOString(),
          ':cutoff': new Date(now.getTime() - windowMs).toISOString(),
          ':true': true,
        },
        ReturnValues: 'UPDATED_NEW',
      }));
      return Number(r.Attributes?.views ?? 0);
    } catch (err: any) {
      if (err?.name === 'ConditionalCheckFailedException') return null;
      throw err;
    }
  }

  async incrementForks(projectId: string): Promise<void> {
    try {
      await this.db.send(new UpdateCommand({
        TableName: PROJECTS_TABLE(),
        Key: { projectId },
        UpdateExpression: 'ADD #forks :one',
        ConditionExpression: 'attribute_exists(projectId)',
        ExpressionAttributeNames: { '#forks': 'forks' },
        ExpressionAttributeValues: { ':one': 1 },
      }));
    } catch (err: any) {
      if (err?.name !== 'ConditionalCheckFailedException') throw err;
    }
  }

  async renameUserProjects(userId: string, username: string): Promise<void> {
    let cursor: string | null = null;
    do {
      const page: Page<ProjectSummary> = await this.listUserProjects(userId, { limit: OWN_LIST_CAP, cursor });
      for (const p of page.items) {
        await this.updateProject(p.projectId, { username }, { touch: false });
      }
      cursor = page.cursor;
    } while (cursor);
  }

  // ---------------------------------------------------------------- users (counters)

  async incrementTokenVersion(userId: string): Promise<number> {
    const r = await this.db.send(new UpdateCommand({
      TableName: USERS_TABLE(),
      Key: { userId },
      UpdateExpression: 'ADD #tv :one',
      ConditionExpression: 'attribute_exists(userId)',
      ExpressionAttributeNames: { '#tv': 'tokenVersion' },
      ExpressionAttributeValues: { ':one': 1 },
      ReturnValues: 'UPDATED_NEW',
    }));
    return Number(r.Attributes?.tokenVersion ?? 0);
  }

  async reserveProjectSlot(userId: string, max: number): Promise<boolean> {
    try {
      await this.db.send(new UpdateCommand({
        TableName: USERS_TABLE(),
        Key: { userId },
        UpdateExpression: 'ADD #pc :one',
        ConditionExpression: 'attribute_exists(userId) AND (attribute_not_exists(#pc) OR #pc < :max)',
        ExpressionAttributeNames: { '#pc': 'projectCount' },
        ExpressionAttributeValues: { ':one': 1, ':max': max },
      }));
      return true;
    } catch (err: any) {
      if (conditionFailed(err)) return false;
      throw err;
    }
  }

  async releaseProjectSlot(userId: string): Promise<void> {
    try {
      await this.db.send(new UpdateCommand({
        TableName: USERS_TABLE(),
        Key: { userId },
        UpdateExpression: 'ADD #pc :minus',
        ConditionExpression: '#pc > :zero',
        ExpressionAttributeNames: { '#pc': 'projectCount' },
        ExpressionAttributeValues: { ':minus': -1, ':zero': 0 },
      }));
    } catch (err: any) {
      if (!conditionFailed(err)) throw err;
    }
  }

  // ------------------------------------------------------------- security table

  async rateHit(key: string, windowSec: number, now: Date): Promise<number> {
    const start = Math.floor(nowSec(now) / windowSec) * windowSec;
    const r = await this.db.send(new UpdateCommand({
      TableName: SECURITY_TABLE(),
      Key: { pk: `rl#${key}#${start}` },
      UpdateExpression: 'ADD #c :one SET #ttl = if_not_exists(#ttl, :ttl)',
      ExpressionAttributeNames: { '#c': 'count', '#ttl': 'ttl' },
      ExpressionAttributeValues: { ':one': 1, ':ttl': start + windowSec + 60 },
      ReturnValues: 'UPDATED_NEW',
    }));
    return Number(r.Attributes?.count ?? 1);
  }

  async claimOnce(key: string, ttlSec: number, now: Date): Promise<boolean> {
    const item: Record<string, any> = { pk: `once#${key}` };
    if (ttlSec) item.ttl = nowSec(now) + ttlSec;
    try {
      await this.db.send(new PutCommand({
        TableName: SECURITY_TABLE(),
        Item: item,
        // TTL deletion is lazy: an expired claim counts as free
        ConditionExpression: 'attribute_not_exists(pk) OR (attribute_exists(#ttl) AND #ttl < :now)',
        ExpressionAttributeNames: { '#ttl': 'ttl' },
        ExpressionAttributeValues: { ':now': nowSec(now) },
      }));
      return true;
    } catch (err: any) {
      if (conditionFailed(err)) return false;
      throw err;
    }
  }

  async getAuthFailures(key: string): Promise<AuthFailures | null> {
    const r = await this.db.send(new GetCommand({ TableName: SECURITY_TABLE(), Key: { pk: `af#${key}` } }));
    const it = r.Item;
    if (!it || (it.ttl && it.ttl < nowSec())) return null;
    return { count: Number(it.count || 0), lockedUntil: Number(it.lockedUntil || 0) };
  }

  async recordAuthFailure(key: string, now: Date, lockMs: (count: number) => number): Promise<AuthFailures> {
    const r = await this.db.send(new UpdateCommand({
      TableName: SECURITY_TABLE(),
      Key: { pk: `af#${key}` },
      UpdateExpression: 'ADD #c :one SET #ttl = :ttl',
      ExpressionAttributeNames: { '#c': 'count', '#ttl': 'ttl' },
      ExpressionAttributeValues: { ':one': 1, ':ttl': nowSec(now) + 24 * 3600 },
      ReturnValues: 'ALL_NEW',
    }));
    const count = Number(r.Attributes?.count ?? 1);
    let lockedUntil = Number(r.Attributes?.lockedUntil || 0);
    const lock = lockMs(count);
    if (lock > 0) {
      lockedUntil = now.getTime() + lock;
      await this.db.send(new UpdateCommand({
        TableName: SECURITY_TABLE(),
        Key: { pk: `af#${key}` },
        UpdateExpression: 'SET #lu = :lu',
        ExpressionAttributeNames: { '#lu': 'lockedUntil' },
        ExpressionAttributeValues: { ':lu': lockedUntil },
      }));
    }
    return { count, lockedUntil };
  }

  async clearAuthFailures(key: string): Promise<void> {
    await this.db.send(new DeleteCommand({ TableName: SECURITY_TABLE(), Key: { pk: `af#${key}` } }));
  }

  async putResetToken(tokenHash: string, record: ResetTokenRecord): Promise<void> {
    await this.db.send(new PutCommand({
      TableName: SECURITY_TABLE(),
      Item: { pk: `reset#${tokenHash}`, ...record, ttl: Math.ceil(record.expiresAt / 1000) + 3600 },
    }));
  }

  async getResetToken(tokenHash: string): Promise<ResetTokenRecord | null> {
    const r = await this.db.send(new GetCommand({ TableName: SECURITY_TABLE(), Key: { pk: `reset#${tokenHash}` } }));
    if (!r.Item) return null;
    return { userId: r.Item.userId, tv: Number(r.Item.tv || 0), expiresAt: Number(r.Item.expiresAt || 0) };
  }

  async consumeResetToken(tokenHash: string): Promise<ResetTokenRecord | null> {
    try {
      const r = await this.db.send(new DeleteCommand({
        TableName: SECURITY_TABLE(),
        Key: { pk: `reset#${tokenHash}` },
        ConditionExpression: 'attribute_exists(pk)',
        ReturnValues: 'ALL_OLD',
      }));
      const it = r.Attributes;
      return it ? { userId: it.userId, tv: Number(it.tv || 0), expiresAt: Number(it.expiresAt || 0) } : null;
    } catch (err: any) {
      if (conditionFailed(err)) return null;
      throw err;
    }
  }

  async putPendingSignup(key: string, record: PendingSignup): Promise<void> {
    await this.db.send(new PutCommand({
      TableName: SECURITY_TABLE(),
      Item: { pk: `signup#${key}`, ...record, ttl: Math.ceil(record.expiresAt / 1000) + 3600 },
    }));
  }

  async getPendingSignup(key: string): Promise<PendingSignup | null> {
    const r = await this.db.send(new GetCommand({ TableName: SECURITY_TABLE(), Key: { pk: `signup#${key}` }, ConsistentRead: true }));
    return r.Item ? pendingFrom(r.Item) : null;
  }

  async consumePendingSignup(key: string, tokenHash: string): Promise<PendingSignup | null> {
    try {
      const r = await this.db.send(new DeleteCommand({
        TableName: SECURITY_TABLE(),
        Key: { pk: `signup#${key}` },
        // Single use, and only the latest link of the address
        ConditionExpression: 'tokenHash = :h',
        ExpressionAttributeValues: { ':h': tokenHash },
        ReturnValues: 'ALL_OLD',
      }));
      return r.Attributes ? pendingFrom(r.Attributes) : null;
    } catch (err: any) {
      if (conditionFailed(err)) return null;
      throw err;
    }
  }
}

function pendingFrom(it: Record<string, any>): PendingSignup {
  return {
    email: it.email,
    username: it.username,
    passwordHash: it.passwordHash,
    tokenHash: it.tokenHash,
    createdAt: it.createdAt,
    expiresAt: Number(it.expiresAt || 0),
  };
}
