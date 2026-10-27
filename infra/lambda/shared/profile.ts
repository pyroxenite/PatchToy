import { User } from './store';

/**
 * Public profile of a user. Emails are never part of it; `self` adds the
 * fields only the account owner sees.
 */
export function profileOf(user: User, { self = false } = {}) {
  const profile: Record<string, any> = {
    username: user.username,
    displayName: user.displayName || '',
    createdAt: user.createdAt,
  };
  if (self) {
    profile.userId = user.userId;
    profile.usernameGenerated = user.usernameGenerated === true;
  }
  return profile;
}
