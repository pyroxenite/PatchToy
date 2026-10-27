import { APIGatewayProxyEvent } from 'aws-lambda';
import * as response from '../shared/response';
import { getStore } from '../shared/store';
import { handle, publicSummary, queryParam, clampLimit } from '../shared/http';

/**
 * GET /api/projects/public?sort=new|popular&q=&cursor=&limit=
 * Public projects of every user, paginated (cursor is opaque).
 */
export const handler = handle('Public projects', async (event: APIGatewayProxyEvent) => {
  const sort = queryParam(event, 'sort') === 'popular' ? 'popular' : 'new';
  const q = (queryParam(event, 'q') || '').trim().toLowerCase().slice(0, 60);
  const limit = clampLimit(queryParam(event, 'limit'));
  const cursor = queryParam(event, 'cursor') || null;

  const page = await getStore().listPublicProjects({ sort, q: q || undefined, limit, cursor });
  return response.success(
    { projects: page.items.map(publicSummary), cursor: page.cursor, sort, q },
    200,
    { 'Cache-Control': 'public, max-age=15' },
  );
});
