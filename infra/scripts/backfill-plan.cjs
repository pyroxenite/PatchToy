/**
 * Pure planning logic of backfill-community.mjs (no AWS access), shared with the
 * lambda unit tests (infra/lambda/test/security.test.ts).
 *
 * Visibility model (2.0):
 *   private   isPublic false, no `visibility`
 *   unlisted  isPublic true,  no `visibility`   anyone with the link (1.x "Share link")
 *   public    isPublic true,  visibility "public", publicOwner = userId   listed in Community
 *
 * 1.x had no public listing: its `isPublic` meant "anyone with the link". Those projects
 * stay UNLISTED. Nothing here ever sets `visibility`; owners opt in with
 * "Publish to Community".
 */
'use strict';

function stats(data) {
  const graph = data && (data.graph !== undefined ? data.graph : data);
  const nodes = Array.isArray(graph && graph.nodes) ? graph.nodes : [];
  return { nodeCount: nodes.length, hasJS: nodes.some(n => n && n.type === 'JS') };
}

/**
 * What to change on one project item: { set: {...}, remove: [...] } (both empty: nothing).
 * `listed` is true only for items that are already listed with the 2.0 model
 * (visibility "public"), so re-running after users published keeps them listed.
 */
function planProjectUpdate(p) {
  const set = {};
  const remove = [];
  if (typeof p.name === 'string' && p.nameLower !== p.name.toLowerCase()) set.nameLower = p.name.toLowerCase();
  // Case-insensitive author search; `username` keeps the display spelling
  if (typeof p.username === 'string' && p.username && p.usernameLower !== p.username.toLowerCase()) set.usernameLower = p.username.toLowerCase();
  if (typeof p.views !== 'number') set.views = 0;
  if (typeof p.forks !== 'number') set.forks = 0;
  if (typeof p.nodeCount !== 'number' || typeof p.hasJS !== 'boolean') Object.assign(set, stats(p.data));
  if (p.visibility === 'public') {
    // Listed through 2.0 ("Publish to Community"): keep, and make sure the owner key is there
    if (p.isPublic !== true) set.isPublic = true;
    if (p.publicOwner !== p.userId && p.userId) set.publicOwner = p.userId;
  } else {
    if (p.visibility !== undefined) remove.push('visibility');
    if (p.publicOwner !== undefined) remove.push('publicOwner');
  }
  return { set, remove };
}

/** Owned project counts per user (quota), from scanned project items. */
function countProjects(projects) {
  const counts = new Map();
  for (const p of projects) if (p.userId) counts.set(p.userId, (counts.get(p.userId) || 0) + 1);
  return counts;
}

/**
 * Username reservations (users table items `username#<name>`, `handleOwner`).
 *
 * Usernames keep their spelling ("SirKitBoi") but are unique case-insensitively: every
 * user must hold the item named after the lowercase key ("username#sirkitboi"). Earlier
 * runs reserved the spelling as typed ("username#SirKitBoi"): once the key item is the
 * same user's, that item is deleted. Two users whose names only differ in case can't both
 * have the key: they are reported as conflicts and nothing is written for that key.
 *
 * users: [{ userId, username }], reservations: Map(name as stored -> handleOwner).
 * Returns { reserve: [{ key, userId, username }], release: [{ name, userId }],
 *           conflicts: [string], ok: number } (ok = users already holding their key).
 */
function planReservations(users, reservations) {
  const reserve = [];
  const release = [];
  const conflicts = [];
  let ok = 0;
  const byKey = new Map();
  for (const u of users) {
    if (!u || typeof u.username !== 'string' || !u.username.trim()) continue;
    const key = u.username.trim().toLowerCase();
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(u);
  }
  /** userId -> key that user holds (or will hold) after this run. */
  const holds = new Map();
  for (const [key, group] of byKey) {
    const holder = reservations.get(key);
    if (group.length > 1) {
      const names = group.map(u => `${u.username} (${u.userId})`).join(', ');
      if (holder && group.some(u => u.userId === holder)) {
        holds.set(holder, key);
        ok++;
        conflicts.push(`username key "${key}" is shared by ${names}; reserved by ${holder}, the others must be renamed`);
      } else {
        conflicts.push(`username key "${key}" is shared by ${names}; nothing reserved, rename all but one`);
      }
      continue;
    }
    const u = group[0];
    if (holder === u.userId) {
      holds.set(u.userId, key);
      ok++;
    } else if (holder) {
      conflicts.push(`username key "${key}" of ${u.username} (${u.userId}) is reserved by another user (${holder}), check manually`);
    } else {
      reserve.push({ key, userId: u.userId, username: u.username });
      holds.set(u.userId, key);
    }
  }
  // Mixed-case items (spelled as typed): drop the ones whose owner holds the key item
  for (const [name, owner] of reservations) {
    const key = name.toLowerCase();
    if (name === key) continue;
    if (holds.get(owner) === key) release.push({ name, userId: owner });
    else conflicts.push(`mixed-case reservation "${name}" (owner ${owner}) left in place: its owner doesn't hold "${key}"`);
  }
  return { reserve, release, conflicts, ok };
}

module.exports = { planProjectUpdate, countProjects, planReservations, stats };
