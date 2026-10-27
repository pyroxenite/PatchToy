import { APIGatewayProxyEvent } from 'aws-lambda';
import * as response from '../shared/response';
import { getStore } from '../shared/store';
import { getBlobStore, thumbKeyFor } from '../shared/blobs';
import { handle, requireAuth } from '../shared/http';
import { isProjectId } from '../shared/validate';

/**
 * POST /api/projects/{id}/thumbnail (owner only)
 * Returns a presigned S3 POST for a small JPEG (size-capped by the policy) and
 * points the project at the new key (random part, unguessable). The previous
 * thumbnail is deleted.
 */
export const handler = handle('Thumbnail upload', async (event: APIGatewayProxyEvent) => {
  const auth = await requireAuth(event);
  const projectId = event.pathParameters?.id;
  if (!isProjectId(projectId)) return response.error('Project not found', 404);

  const db = getStore();
  const project = await db.getProject(projectId);
  if (!project) return response.error('Project not found', 404);
  if (project.userId !== auth.userId) return response.error('Unauthorized', 403);

  const blobs = getBlobStore();
  const key = thumbKeyFor(projectId);
  const upload = await blobs.presignUpload(key);
  await db.updateProject(projectId, { thumbKey: key }, { touch: false });

  if (project.thumbKey && project.thumbKey !== key) {
    try {
      await blobs.delete(project.thumbKey);
    } catch (err: any) {
      console.warn('Could not delete previous thumbnail', project.thumbKey, err?.name || err);
    }
  }
  return response.success({ upload, thumbUrl: blobs.publicUrl(key) });
});
