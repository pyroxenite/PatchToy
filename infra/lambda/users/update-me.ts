import { APIGatewayProxyEvent } from 'aws-lambda';
import * as response from '../shared/response';
import * as jwt from '../shared/jwt';
import { getStore, UserPatch } from '../shared/store';
import { handle, requireAuth, parseBody } from '../shared/http';
import { normalizeUsername, usernameError, usernameKey, validateDisplayName } from '../shared/validate';
import { profileOf } from '../shared/profile';
import { ensureUsernameReservation } from '../shared/usernames';

/**
 * PUT /api/users/me { username?, displayName? }
 * Changing the username re-labels the user's projects, bumps tokenVersion (every
 * other session of the account ends, so no device keeps publishing under the old
 * handle), releases the old handle and returns a new token. Sending the current
 * username confirms an auto-generated one (clears usernameGenerated).
 *
 * Usernames are case-insensitive: a change of case only (SirKitBoi -> sirKitBoi) is the
 * same handle. It updates the spelling on the user and their projects, but reserves and
 * releases nothing and keeps the other sessions.
 */
export const handler = handle('Update profile', async (event: APIGatewayProxyEvent) => {
  const auth = await requireAuth(event);
  const db = getStore();
  const user = auth.user;

  const body = parseBody(event);
  const patch: UserPatch = {};

  if (body.displayName !== undefined) {
    const displayName = validateDisplayName(body.displayName);
    patch.displayName = displayName || null;
  }

  let renamed = false; // a different handle
  let respelled = false; // same handle, other case
  if (body.username !== undefined) {
    const username = normalizeUsername(body.username);
    if (username !== user.username) {
      const bad = usernameError(username);
      if (bad) return response.error(bad, 400);
      if (user.username && usernameKey(username) === usernameKey(user.username)) {
        respelled = true;
      } else {
        const holder = await db.getUserByUsername(username);
        if (holder && holder.userId !== user.userId) return response.error('Username already taken', 409);
        if (!(await db.reserveUsername(username, user.userId))) return response.error('Username already taken', 409);
        patch.usernameChangedAt = new Date().toISOString();
        renamed = true;
      }
      patch.username = username;
    }
    if (user.usernameGenerated) patch.usernameGenerated = false;
  }

  if (!Object.keys(patch).length) return response.error('Nothing to update', 400);

  await db.updateUser(user.userId, patch);
  const updated = { ...user, ...patch, displayName: patch.displayName === null ? undefined : (patch.displayName ?? user.displayName) } as typeof user;

  if (renamed || respelled) await db.renameUserProjects(user.userId, updated.username);
  if (renamed && user.username) await db.releaseUsername(user.username, user.userId);
  // Same handle: make sure it is held by its key item (1.x accounts), drop a mixed-case one
  if (respelled && await ensureUsernameReservation(db, updated) && user.username !== usernameKey(user.username)) {
    await db.releaseHandle(user.username, user.userId);
  }

  let tv = user.tokenVersion || 0;
  if (renamed) tv = await db.incrementTokenVersion(user.userId);

  const token = await jwt.sign({ userId: user.userId, email: user.email, username: updated.username, tv });
  return response.success({ token, username: updated.username, user: profileOf(updated, { self: true }) });
});
