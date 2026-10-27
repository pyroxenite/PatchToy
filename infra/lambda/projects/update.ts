import { APIGatewayProxyEvent } from 'aws-lambda';
import * as response from '../shared/response';
import { getStore, ProjectPatch, visibilityOf } from '../shared/store';
import { handle, requireAuth, parseBody, dropThumbnail } from '../shared/http';
import { validateProjectName, validateDescription, validateProjectData, isProjectId, parseVisibility } from '../shared/validate';

/** PUT /api/projects/{id} { name?, data?, description?, visibility? } (owner only) */
export const handler = handle('Update project', async (event: APIGatewayProxyEvent) => {
  const auth = await requireAuth(event);
  const projectId = event.pathParameters?.id;
  if (!isProjectId(projectId)) return response.error('Project not found', 404);

  const db = getStore();
  const project = await db.getProject(projectId);
  if (!project) return response.error('Project not found', 404);
  if (project.userId !== auth.userId) return response.error('Unauthorized', 403);

  const body = parseBody(event);
  const patch: ProjectPatch = {};
  if (body.name !== undefined) patch.name = validateProjectName(body.name);
  if (body.description !== undefined) patch.description = validateDescription(body.description);
  if (body.data !== undefined) {
    const stats = validateProjectData(body.data);
    patch.data = body.data;
    patch.nodeCount = stats.nodeCount;
    patch.hasJS = stats.hasJS;
  }
  const before = visibilityOf(project);
  const visibility = parseVisibility(body);
  if (visibility !== undefined) {
    patch.visibility = visibility;
    patch.ownerId = project.userId;
    if (visibility === 'public' && !project.publishedAt) patch.publishedAt = new Date().toISOString();
  }
  if (!Object.keys(patch).length) {
    return response.error('At least one of name, data, description or visibility is required', 400);
  }

  const updatedAt = await db.updateProject(projectId, patch);
  if (visibility === 'private' && before !== 'private') await dropThumbnail(project);
  const after = visibility ?? before;
  return response.success({
    id: projectId,
    name: patch.name ?? project.name,
    visibility: after,
    isPublic: after !== 'private',
    updatedAt,
  });
});
