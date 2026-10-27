import { Store, User } from './store';
import { usernameKey } from './validate';

/**
 * Make sure a user's handle is held by its case-insensitive reservation item
 * (`username#<key>`), without ever changing the stored spelling.
 *
 * Accounts from 1.x have no reservation, or (first community backfill) one spelled as
 * typed ("username#SirKitBoi"): any-case lookups and the duplicate checks only see the
 * key item. Called on sign-in and on a case-only profile change. When the key item is
 * ours, a mixed-case item of the same user is released. Never throws: a failure only
 * means the next sign-in tries again. Resolves false when another user holds the key
 * (a collision to settle by hand; the backfill reports it).
 */
export async function ensureUsernameReservation(db: Store, user: Pick<User, 'userId' | 'username'>): Promise<boolean> {
  const raw = String(user.username || '').trim();
  const key = usernameKey(raw);
  if (!key) return true;
  try {
    let owner = await db.getHandleOwner(key);
    if (!owner && await db.reserveUsername(key, user.userId)) owner = user.userId;
    if (owner && owner !== user.userId) {
      console.warn('Username reservation: the key is held by another user', user.userId);
      return false;
    }
    if (owner !== user.userId) return false;
    if (raw !== key && (await db.getHandleOwner(raw)) === user.userId) await db.releaseHandle(raw, user.userId);
    return true;
  } catch (err: any) {
    console.warn('Username reservation failed', err?.name || err);
    return false;
  }
}
