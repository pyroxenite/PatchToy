import { APIGatewayProxyEvent } from 'aws-lambda';
import * as response from '../shared/response';
import { getStore, ProjectPatch, visibilityOf } from '../shared/store';
import { handle, requireAuth, parseBody, dropThumbnail } from '../shared/http';
import { isProjectId, parseVisibility } from '../shared/validate';

/**
 * PUT /api/projects/{id}/visibility { visibility: 'private' | 'unlisted' | 'public' }
 * (or the 1.x { isPublic }: true = unlisted, i.e. anyone with the link, not listed).
 * Only 'public' lists the project in Community and on the user page.
 */
export const handler = handle('Toggle visibility', async (event: APIGatewayProxyEvent) => {
  const auth = await requireAuth(event);
  const projectId = event.pathParameters?.id;
  if (!isProjectId(projectId)) return response.error('Project not found', 404);

  const db = getStore();
  const project = await db.getProject(projectId);
  if (!project) return response.error('Project not found', 404);
  if (project.userId !== auth.userId) return response.error('Unauthorized', 403);

  const visibility = parseVisibility(parseBody(event));
  if (!visibility) return response.error("visibility ('private' | 'unlisted' | 'public') is required", 400);
  const before = visibilityOf(project);

  const patch: ProjectPatch = { visibility, ownerId: project.userId };
  if (visibility === 'public' && !project.publishedAt) patch.publishedAt = new Date().toISOString();
  // Publishing bumps updatedAt so the project shows up first in "Newest"
  const touch = visibility === 'public' && before !== 'public';
  const updatedAt = await db.updateProject(projectId, patch, { touch });
  if (visibility === 'private' && before !== 'private') await dropThumbnail(project);

  return response.success({ id: projectId, visibility, isPublic: visibility !== 'private', updatedAt: touch ? updatedAt : project.updatedAt });
});
