import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import { DynamoStore } from '../shared/dynamo-store';
import { encodeCursor, InvalidCursorError } from '../shared/store';

/** Records the commands DynamoStore sends; answers each with `reply(command)`. */
function recorder(reply: (cmd: any) => any = () => ({})) {
  const sent: { name: string; input: any }[] = [];
  return {
    sent,
    client: {
      async send(cmd: any) {
        sent.push({ name: cmd.constructor.name, input: cmd.input });
        return reply(cmd);
      },
    },
  };
}

describe('DynamoStore', () => {
  test('making a project private or unlisted removes it from the sparse public indexes', async () => {
    const r = recorder(() => ({ Attributes: { updatedAt: 'T' } }));
    const s = new DynamoStore(r.client);
    await s.updateProject('p1', { visibility: 'private', name: 'Hello' });
    const { input } = r.sent[0];
    assert.equal(r.sent[0].name, 'UpdateCommand');
    assert.match(input.UpdateExpression, /^SET .*#isPublic = :isPublic.* REMOVE #visibility, #publicOwner$/);
    assert.equal(input.ExpressionAttributeValues[':isPublic'], false);
    assert.equal(input.ExpressionAttributeValues[':nameLower'], 'hello');
    assert.equal(input.ConditionExpression, 'attribute_exists(projectId)');

    // Unlisted: readable by link (isPublic) but not in the GSIs
    await s.updateProject('p1', { visibility: 'unlisted' });
    assert.equal(r.sent[1].input.ExpressionAttributeValues[':isPublic'], true);
    assert.match(r.sent[1].input.UpdateExpression, /REMOVE #visibility, #publicOwner$/);

    await s.updateProject('p1', { visibility: 'public', ownerId: 'u1' });
    assert.equal(r.sent[2].input.ExpressionAttributeValues[':visibility'], 'public');
    assert.equal(r.sent[2].input.ExpressionAttributeValues[':publicOwner'], 'u1');
    await assert.rejects(s.updateProject('p1', { visibility: 'public' }), /ownerId/);
  });

  test('createProject sets the GSI attributes', async () => {
    const r = recorder();
    const s = new DynamoStore(r.client);
    await s.createProject({
      projectId: 'p', userId: 'u', username: 'a', name: 'Big Name', data: {}, isPublic: true, visibility: 'public',
      createdAt: 'c', updatedAt: 'u',
    });
    const item = r.sent[0].input.Item;
    assert.equal(item.visibility, 'public');
    assert.equal(item.publicOwner, 'u');
    assert.equal(item.nameLower, 'big name');
    assert.equal(item.views, 0);

    // isPublic without visibility = unlisted: not in the public indexes
    await s.createProject({ projectId: 'q', userId: 'u', username: 'a', name: 'n', data: {}, isPublic: true, createdAt: 'c', updatedAt: 'u' });
    assert.equal(r.sent[1].input.Item.visibility, undefined);
    assert.equal(r.sent[1].input.Item.publicOwner, undefined);
  });

  test('user page reads card attributes only: user-public index, or the public index filtered by author', async () => {
    const r = recorder(() => ({ Items: [] }));
    const s = new DynamoStore(r.client);
    await s.listUserProjects('u1', { publicOnly: true, limit: 10 });
    let { input } = r.sent[0];
    assert.equal(input.IndexName, 'public-updatedAt-index');
    assert.equal(input.FilterExpression, '#uid = :userId');
    assert.ok(!Object.values(input.ExpressionAttributeNames).includes('data'));
    assert.ok(r.sent.length <= 2, 'bounded pages');

    process.env.USER_PUBLIC_INDEX = 'user-public-index';
    try {
      await s.listUserProjects('u1', { publicOnly: true, limit: 10 });
      ({ input } = r.sent[r.sent.length - 1]);
      assert.equal(input.IndexName, 'user-public-index');
      assert.equal(input.KeyConditionExpression, '#owner = :userId');
      assert.equal(input.FilterExpression, undefined);
    } finally {
      delete process.env.USER_PUBLIC_INDEX;
    }
  });

  test('own list and popular fallback are capped', async () => {
    const r = recorder(() => ({ Items: [{ projectId: 'a' }], LastEvaluatedKey: { projectId: 'a', userId: 'u1', updatedAt: 'T' } }));
    const s = new DynamoStore(r.client);
    await s.listUserProjects('u1', { limit: 100000 });
    assert.ok(r.sent.every(c => c.input.Limit <= 100));
    assert.ok(r.sent.length <= 5, `own list read ${r.sent.length} pages`);
    r.sent.length = 0;
    await s.listPublicProjects({ sort: 'popular', limit: 24, q: 'x' });
    assert.ok(r.sent.length <= 3, `popular fallback read ${r.sent.length} pages`);
  });

  test('security table: rate counters, single-use reset tokens, claims', async () => {
    const r = recorder((cmd) => {
      if (cmd.constructor.name === 'DeleteCommand') {
        const err: any = new Error('gone');
        err.name = 'ConditionalCheckFailedException';
        throw err;
      }
      return { Attributes: { count: 3 } };
    });
    const s = new DynamoStore(r.client);
    assert.equal(await s.rateHit('login-ip#x', 900, new Date(0)), 3);
    assert.equal(r.sent[0].input.TableName, 'PatchToy-Security');
    assert.match(r.sent[0].input.Key.pk, /^rl#login-ip#x#0$/);
    assert.equal(await s.consumeResetToken('h'), null);
    assert.equal(r.sent[1].input.ConditionExpression, 'attribute_exists(pk)');
    assert.equal(r.sent[1].input.ReturnValues, 'ALL_OLD');
  });

  test('pending sign-ups: one item per address with TTL; consumed only with the current token hash', async () => {
    const r = recorder((cmd) => {
      if (cmd.constructor.name === 'DeleteCommand') {
        const err: any = new Error('cond');
        err.name = 'ConditionalCheckFailedException';
        throw err;
      }
      return {};
    });
    const s = new DynamoStore(r.client);
    const expiresAt = Date.now() + 1000;
    await s.putPendingSignup('k1', { email: 'a@b.c', username: 'a', passwordHash: 'h', tokenHash: 'th', createdAt: 'c', expiresAt });
    assert.equal(r.sent[0].input.Item.pk, 'signup#k1');
    assert.equal(r.sent[0].input.Item.ttl, Math.ceil(expiresAt / 1000) + 3600);
    assert.equal(await s.getPendingSignup('k1'), null);
    assert.equal(r.sent[1].input.ConsistentRead, true);
    assert.equal(await s.consumePendingSignup('k1', 'th'), null, 'condition failed = already used / replaced');
    assert.equal(r.sent[2].input.ConditionExpression, 'tokenHash = :h');
    assert.equal(r.sent[2].input.ExpressionAttributeValues[':h'], 'th');
  });

  test('public feed queries the public index newest first, without the graph data', async () => {
    const r = recorder(() => ({ Items: [{ projectId: 'a' }], LastEvaluatedKey: { projectId: 'a', visibility: 'public', updatedAt: 'T' } }));
    const s = new DynamoStore(r.client);
    const page = await s.listPublicProjects({ sort: 'new', limit: 1 });
    const { input } = r.sent[0];
    assert.equal(input.IndexName, 'public-updatedAt-index');
    assert.equal(input.ScanIndexForward, false);
    assert.equal(input.Limit, 1);
    assert.ok(!Object.values(input.ExpressionAttributeNames).includes('data'));
    assert.ok(page.cursor);

    // The cursor round-trips into ExclusiveStartKey
    await s.listPublicProjects({ sort: 'new', limit: 1, cursor: page.cursor });
    assert.deepEqual(r.sent[1].input.ExclusiveStartKey, { projectId: 'a', visibility: 'public', updatedAt: 'T' });
  });

  test('cursors with foreign keys are rejected', async () => {
    const s = new DynamoStore(recorder().client);
    const evil = encodeCursor({ projectId: 'a', userId: 'victim', updatedAt: 'T' });
    await assert.rejects(s.listPublicProjects({ sort: 'new', limit: 5, cursor: evil }), InvalidCursorError);
    await assert.rejects(s.listUserProjects('me', { cursor: encodeCursor({ projectId: 'a', userId: 'other', updatedAt: 'T' }) }), InvalidCursorError);
  });

  test('search matches title or author case-insensitively (in memory, on card attributes)', async () => {
    const r = recorder(() => ({
      Items: [
        { projectId: 'a', name: 'Orbit', nameLower: 'orbit', username: 'x' },
        { projectId: 'b', name: 'Glow', nameLower: 'glow', username: 'SirKitBoi' },
        { projectId: 'c', name: 'Other', nameLower: 'other', username: 'zed' },
      ],
    }));
    const s = new DynamoStore(r.client);
    const byTitle = await s.listPublicProjects({ sort: 'new', limit: 10, q: 'orbit' });
    assert.deepEqual(byTitle.items.map(p => p.projectId), ['a']);
    const { input } = r.sent[0];
    assert.equal(input.FilterExpression, undefined, 'contains() is case-sensitive: not used');
    assert.ok(input.Limit >= 50, 'filtered pages read like a FilterExpression');
    const byAuthor = await s.listPublicProjects({ sort: 'new', limit: 10, q: 'sirkit' });
    assert.deepEqual(byAuthor.items.map(p => p.projectId), ['b']);
    const popular = await s.listPublicProjects({ sort: 'popular', limit: 10, q: 'kitboi' });
    assert.deepEqual(popular.items.map(p => p.projectId), ['b']);
  });

  test('usernames: reservations under the lowercase key; lookups in any case, legacy rows through the index', async () => {
    const users: Record<string, any> = { u1: { userId: 'u1', username: 'SirKitBoi' }, u2: { userId: 'u2', username: 'Legacy' } };
    const handles: Record<string, string> = { 'username#sirkitboi': 'u1' };
    const r = recorder((cmd) => {
      const n = cmd.constructor.name;
      const inp = cmd.input;
      if (n === 'GetCommand') {
        const id = inp.Key.userId;
        if (handles[id]) return { Item: { userId: id, handleOwner: handles[id] } };
        return { Item: users[id] };
      }
      if (n === 'QueryCommand' && inp.IndexName === 'username-index') {
        const v = inp.ExpressionAttributeValues[':username'];
        return { Items: Object.values(users).filter(u => u.username === v) };
      }
      return {};
    });
    const s = new DynamoStore(r.client);
    assert.equal((await s.getUserByUsername('SIRKITBOI'))?.userId, 'u1');
    assert.equal((await s.getUserByUsername('sirkitboi'))?.username, 'SirKitBoi');
    assert.ok(!r.sent.some(c => c.input.IndexName === 'username-index'), 'the reservation answers, no index query');
    // No reservation: exact spelling through the username index
    assert.equal((await s.getUserByUsername('Legacy'))?.userId, 'u2');
    assert.equal(await s.getUserByUsername('nobody'), null);

    r.sent.length = 0;
    await s.reserveUsername('SirKitBoi', 'u1');
    assert.equal(r.sent[0].input.Item.userId, 'username#sirkitboi');
    r.sent.length = 0;
    await s.releaseUsername('SirKitBoi', 'u1');
    assert.deepEqual(r.sent.map(c => c.input.Key.userId), ['username#sirkitboi', 'username#SirKitBoi']);
    assert.ok(r.sent.every(c => c.input.ConditionExpression === 'handleOwner = :owner'));
  });

  test('projects carry usernameLower (display spelling kept in username)', async () => {
    const r = recorder(() => ({ Attributes: { updatedAt: 'T' } }));
    const s = new DynamoStore(r.client);
    await s.createProject({ projectId: 'p', userId: 'u', username: 'SirKitBoi', name: 'N', data: {}, isPublic: false, createdAt: 'c', updatedAt: 'u' });
    assert.equal(r.sent[0].input.Item.username, 'SirKitBoi');
    assert.equal(r.sent[0].input.Item.usernameLower, 'sirkitboi');
    await s.updateProject('p', { username: 'sirKitBoi' }, { touch: false });
    assert.equal(r.sent[1].input.ExpressionAttributeValues[':username'], 'sirKitBoi');
    assert.equal(r.sent[1].input.ExpressionAttributeValues[':usernameLower'], 'sirkitboi');
  });

  test('popular without the views index ranks the newest public projects in memory', async () => {
    const r = recorder(() => ({
      Items: [
        { projectId: 'a', views: 1, updatedAt: '2' },
        { projectId: 'b', views: 9, updatedAt: '1' },
        { projectId: 'c', views: 3, updatedAt: '3' },
      ],
    }));
    const s = new DynamoStore(r.client);
    const page = await s.listPublicProjects({ sort: 'popular', limit: 2 });
    assert.deepEqual(page.items.map(p => p.projectId), ['b', 'c']);
    const next = await s.listPublicProjects({ sort: 'popular', limit: 2, cursor: page.cursor });
    assert.deepEqual(next.items.map(p => p.projectId), ['a']);
    assert.equal(next.cursor, null);
  });

  test('popular uses the views index when it is configured', async () => {
    process.env.POPULAR_INDEX = 'public-views-index';
    try {
      const r = recorder(() => ({ Items: [] }));
      await new DynamoStore(r.client).listPublicProjects({ sort: 'popular', limit: 5 });
      assert.equal(r.sent[0].input.IndexName, 'public-views-index');
    } finally {
      delete process.env.POPULAR_INDEX;
    }
  });

  test('view counting is conditional and returns null when rate limited', async () => {
    const r = recorder(() => {
      const err: any = new Error('nope');
      err.name = 'ConditionalCheckFailedException';
      throw err;
    });
    const s = new DynamoStore(r.client);
    assert.equal(await s.recordView('p', 'k', new Date(), 1000), null);
    assert.match(r.sent[0].input.ConditionExpression, /#isPublic = :true/);
    assert.match(r.sent[0].input.UpdateExpression, /ADD #views :one/);
  });

  test('usernames are reserved with a conditional put', async () => {
    let fail = false;
    const r = recorder(() => {
      if (fail) {
        const err: any = new Error('taken');
        err.name = 'ConditionalCheckFailedException';
        throw err;
      }
      return {};
    });
    const s = new DynamoStore(r.client);
    assert.equal(await s.reserveUsername('alice', 'u1'), true);
    assert.equal(r.sent[0].input.Item.userId, 'username#alice');
    fail = true;
    assert.equal(await s.reserveUsername('alice', 'u2'), false);
  });
});
