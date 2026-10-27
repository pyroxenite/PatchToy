import { APIGatewayProxyEvent } from 'aws-lambda';
import * as response from '../shared/response';
import { getStore } from '../shared/store';
import { handle, publicSummary, queryParam, clampLimit } from '../shared/http';
import { normalizeUsername, USERNAME_RE } from '../shared/validate';
import { profileOf } from '../shared/profile';

/** GET /api/users/{username}?cursor= - public profile and listed projects (no emails). */
export const handler = handle('Get user', async (event: APIGatewayProxyEvent) => {
  let raw: string;
  try {
    raw = decodeURIComponent(event.pathParameters?.username || '');
  } catch (e) {
    return response.error('Invalid username', 400, { code: 'bad_request' });
  }
  const username = normalizeUsername(raw);
  if (!USERNAME_RE.test(username)) return response.error('User not found', 404, { code: 'not_found' });

  const db = getStore();
  const user = await db.getUserByUsername(username);
  if (!user) return response.error('User not found', 404, { code: 'not_found' });

  const page = await db.listUserProjects(user.userId, {
    publicOnly: true,
    limit: clampLimit(queryParam(event, 'limit'), 48, 96),
    cursor: queryParam(event, 'cursor') || null,
  });
  return response.success(
    { user: profileOf(user), projects: page.items.map(publicSummary), cursor: page.cursor },
    200,
    { 'Cache-Control': 'public, max-age=15' },
  );
});
