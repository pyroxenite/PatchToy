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

module.exports = { planProjectUpdate, countProjects, stats };
