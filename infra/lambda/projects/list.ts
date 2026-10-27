import { APIGatewayProxyEvent } from 'aws-lambda';
import * as response from '../shared/response';
import { getStore } from '../shared/store';
import { handle, requireAuth, publicSummary, queryParam } from '../shared/http';

/** GET /api/projects?cursor= - the signed-in user's projects (any visibility), newest first. */
export const handler = handle('List projects', async (event: APIGatewayProxyEvent) => {
  const auth = await requireAuth(event);
  const page = await getStore().listUserProjects(auth.userId, { cursor: queryParam(event, 'cursor') || null });
  return response.success(
    { projects: page.items.map(publicSummary), cursor: page.cursor },
    200,
    { 'Cache-Control': 'private, no-store' },
  );
});
