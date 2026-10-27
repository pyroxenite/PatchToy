import { APIGatewayProxyEvent } from 'aws-lambda';
import * as response from '../shared/response';
import { getStore } from '../shared/store';
import { handle, optionalAuth, viewerKey, limitKey } from '../shared/http';
import { isProjectId } from '../shared/validate';
import { LIMITS } from '../shared/limits';

/** The same viewer is counted at most once per project per window. */
export const VIEW_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * POST /api/projects/{id}/view - count an open of a public or unlisted project
 * ("popular" sort). Owners opening their own project are not counted. A viewer
 * (HMAC of the user id, or of the IP when signed out; the User-Agent is ignored)
 * counts once per project per day, and at most LIMITS.viewsPerViewerDaily views a day.
 */
export const handler = handle('Record view', async (event: APIGatewayProxyEvent) => {
  const projectId = event.pathParameters?.id;
  if (!isProjectId(projectId)) return response.error('Project not found', 404);

  const db = getStore();
  const project = await db.getProject(projectId);
  if (!project || !project.isPublic) return response.error('Project not found', 404);

  const auth = await optionalAuth(event);
  if (auth && auth.userId === project.userId) {
    return response.success({ counted: false, views: project.views || 0 });
  }

  const now = new Date();
  const key = await viewerKey(event, auth?.userId);
  const notCounted = () => response.success({ counted: false, views: project.views || 0 });
  if (!(await db.claimOnce(`view#${projectId}#${key}`, VIEW_WINDOW_MS / 1000, now))) return notCounted();
  const { limit, windowSec } = LIMITS.viewsPerViewerDaily;
  if ((await db.rateHit(await limitKey('views', key), windowSec, now)) > limit) return notCounted();

  const views = await db.recordView(projectId, key, now, VIEW_WINDOW_MS);
  return response.success({ counted: views !== null, views: views ?? (project.views || 0) });
});
