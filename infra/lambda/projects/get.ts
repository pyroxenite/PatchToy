import { APIGatewayProxyEvent } from 'aws-lambda';
import * as response from '../shared/response';
import { getStore } from '../shared/store';
import { handle, optionalAuth, publicSummary } from '../shared/http';
import { isProjectId } from '../shared/validate';

/**
 * GET /api/projects/{id} - full project. Unlisted and public projects are readable
 * without auth; private ones only by their owner (anyone else gets the same 404 as
 * for a missing project, so private projects don't leak their existence).
 */
export const handler = handle('Get project', async (event: APIGatewayProxyEvent) => {
  const projectId = event.pathParameters?.id;
  if (!isProjectId(projectId)) return response.error('Project not found', 404, { code: 'not_found' });

  const project = await getStore().getProject(projectId);
  const auth = await optionalAuth(event);
  const isOwner = !!(project && auth && project.userId === auth.userId);

  if (!project || (!isOwner && project.isPublic !== true)) {
    return response.error('This project is private or does not exist', 404, { code: 'not_found' });
  }

  return response.success(
    {
      ...publicSummary(project),
      userId: project.userId,
      data: project.data,
      isOwner,
    },
    200,
    { 'Cache-Control': isOwner || !project.isPublic ? 'private, no-store' : 'public, max-age=30' },
  );
});
