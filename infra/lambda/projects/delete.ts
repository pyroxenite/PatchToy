import { APIGatewayProxyEvent } from 'aws-lambda';
import * as response from '../shared/response';
import { getStore } from '../shared/store';
import { getBlobStore } from '../shared/blobs';
import { handle, requireAuth } from '../shared/http';
import { isProjectId } from '../shared/validate';

export const handler = handle('Delete project', async (event: APIGatewayProxyEvent) => {
  const auth = await requireAuth(event);
  const projectId = event.pathParameters?.id;
  if (!isProjectId(projectId)) return response.error('Project not found', 404);

  const db = getStore();
  const project = await db.getProject(projectId);
  if (!project) return response.error('Project not found', 404);
  if (project.userId !== auth.userId) return response.error('Unauthorized', 403);

  await db.deleteProject(projectId);
  await db.releaseProjectSlot(auth.userId);
  if (project.thumbKey) {
    try {
      await getBlobStore().delete(project.thumbKey);
    } catch (err: any) {
      console.warn('Could not delete thumbnail', project.thumbKey, err?.name || err);
    }
  }
  return response.success({ success: true });
});
