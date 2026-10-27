#!/usr/bin/env node
/**
 * One-off backfill for the 2.0 community release. Run AFTER the backend deploy
 * that created `public-updatedAt-index` (see RELEASE.md). Dry run by default.
 *
 *   AWS_PROFILE=... AWS_REGION=eu-west-3 node infra/scripts/backfill-community.mjs           # report only
 *   AWS_PROFILE=... AWS_REGION=eu-west-3 node infra/scripts/backfill-community.mjs --apply   # write
 *
 * Projects (PatchToy-Projects):
 *   - 1.x "share link" projects (`isPublic: true`) stay UNLISTED: link access only. They
 *     are NOT added to the Community feed or user pages (no `visibility` is set). Owners
 *     can list them with "Publish to Community". See backfill-plan.cjs.
 *   - every project gets `nameLower` (search), `views`/`forks` (0 if missing),
 *     `nodeCount` and `hasJS` (cards) when missing
 * Users (PatchToy-Users):
 *   - every username gets a reservation item (`userId = "username#<name>"`) so
 *     uniqueness is enforced from now on; users without a username are listed
 *     (they get one derived from their email on their next login)
 *   - `projectCount` (per-user quota) is set from the projects scan when missing.
 *     `tokenVersion` is not written: a missing value means 0.
 *
 * Idempotent: running it twice changes nothing the second time.
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, '../lambda/package.json'));
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, ScanCommand, UpdateCommand, PutCommand } = require('@aws-sdk/lib-dynamodb');
const { planProjectUpdate, countProjects } = createRequire(import.meta.url)('./backfill-plan.cjs');

const APPLY = process.argv.includes('--apply');
const PROJECTS_TABLE = process.env.PROJECTS_TABLE || 'PatchToy-Projects';
const USERS_TABLE = process.env.USERS_TABLE || 'PatchToy-Users';

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });

async function* scan(TableName, ProjectionExpression, ExpressionAttributeNames) {
  let ExclusiveStartKey;
  do {
    const r = await db.send(new ScanCommand({ TableName, ExclusiveStartKey, ProjectionExpression, ExpressionAttributeNames }));
    for (const item of r.Items || []) yield item;
    ExclusiveStartKey = r.LastEvaluatedKey;
  } while (ExclusiveStartKey);
}

const owners = [];

async function backfillProjects() {
  let seen = 0, changed = 0, unlisted = 0;
  for await (const p of scan(PROJECTS_TABLE)) {
    seen++;
    owners.push({ userId: p.userId });
    if (p.isPublic === true && p.visibility !== 'public') unlisted++;
    const { set, remove } = planProjectUpdate(p);
    if (!Object.keys(set).length && !remove.length) continue;
    changed++;
    console.log(`${APPLY ? 'update' : 'would update'} project ${p.projectId} (${JSON.stringify(p.name)}): ${[...Object.keys(set), ...remove.map(r => `-${r}`)].join(', ')}`);
    if (!APPLY) continue;
    const names = {}, values = {};
    const sets = Object.entries(set).map(([k, v]) => { names[`#${k}`] = k; values[`:${k}`] = v; return `#${k} = :${k}`; });
    remove.forEach(k => { names[`#${k}`] = k; });
    await db.send(new UpdateCommand({
      TableName: PROJECTS_TABLE,
      Key: { projectId: p.projectId },
      UpdateExpression: [sets.length ? `SET ${sets.join(', ')}` : '', remove.length ? `REMOVE ${remove.map(k => `#${k}`).join(', ')}` : ''].join(' ').trim(),
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: Object.keys(values).length ? values : undefined,
      ConditionExpression: 'attribute_exists(projectId)',
    }));
  }
  console.log(`projects: ${seen} scanned, ${changed} ${APPLY ? 'updated' : 'to update'}; ${unlisted} link-shared (unlisted) projects stay out of the community feed`);
}

async function backfillUsers() {
  let users = 0, reserved = 0, missing = 0, counted = 0;
  const holders = new Map();
  const reservations = new Map();
  const withCount = new Set();
  for await (const u of scan(USERS_TABLE, '#id, username, handleOwner, projectCount', { '#id': 'userId' })) {
    if (String(u.userId).startsWith('username#')) reservations.set(u.userId.slice(9), u.handleOwner);
    else {
      users++;
      if (typeof u.projectCount === 'number') withCount.add(u.userId);
      if (u.username) holders.set(u.username, u.userId); else { missing++; console.log(`user ${u.userId} has no username (one is derived on next login)`); }
    }
  }
  for (const [name, userId] of holders) {
    if (reservations.get(name) === userId) continue;
    if (reservations.has(name)) { console.warn(`! username ${name} is reserved by another user (${reservations.get(name)}), check manually`); continue; }
    reserved++;
    console.log(`${APPLY ? 'reserve' : 'would reserve'} username ${name} for ${userId}`);
    if (APPLY) {
      await db.send(new PutCommand({
        TableName: USERS_TABLE,
        Item: { userId: `username#${name}`, handleOwner: userId, createdAt: new Date().toISOString() },
        ConditionExpression: 'attribute_not_exists(userId)',
      }));
    }
  }
  for (const [userId, count] of countProjects(owners)) {
    if (withCount.has(userId)) continue;
    counted++;
    console.log(`${APPLY ? 'set' : 'would set'} projectCount=${count} for ${userId}`);
    if (APPLY) {
      await db.send(new UpdateCommand({
        TableName: USERS_TABLE,
        Key: { userId },
        UpdateExpression: 'SET #pc = if_not_exists(#pc, :pc)',
        ConditionExpression: 'attribute_exists(userId)',
        ExpressionAttributeNames: { '#pc': 'projectCount' },
        ExpressionAttributeValues: { ':pc': count },
      })).catch((err) => console.warn(`! projectCount for ${userId}: ${err.name}`));
    }
  }
  console.log(`users: ${users} scanned, ${reserved} reservations ${APPLY ? 'written' : 'to write'}, ${counted} project counts, ${missing} without username`);
}

console.log(`PatchToy community backfill (${APPLY ? 'APPLY' : 'dry run, pass --apply to write'})`);
await backfillProjects();
await backfillUsers();
