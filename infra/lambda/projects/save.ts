import { APIGatewayProxyEvent } from 'aws-lambda';
import { v4 as uuidv4 } from 'uuid';
import * as response from '../shared/response';
import { getStore, ForkRef, Project } from '../shared/store';
import { handle, requireAuth, parseBody, publicSummary } from '../shared/http';
import {
  validateProjectName, validateDescription, validateProjectData, isProjectId, parseVisibility, MAX_PROJECTS_PER_USER,
} from '../shared/validate';

/**
 * POST /api/projects { name, data, description?, visibility?, forkedFrom? }
 * visibility: 'private' (default) | 'unlisted' | 'public' (the 1.x `isPublic: true` = unlisted).
 * forkedFrom: id of the project this one was copied from. It must be readable by the
 * caller; the author and name recorded come from the server, not the client.
 * The author's username comes from the users table, never from the token.
 */
export const handler = handle('Save project', async (event: APIGatewayProxyEvent) => {
  const auth = await requireAuth(event);
  const db = getStore();
  const body = parseBody(event);

  if (body.name === undefined || body.data === undefined) {
    return response.error('Name and data are required', 400);
  }
  const name = validateProjectName(body.name);
  const description = validateDescription(body.description);
  const stats = validateProjectData(body.data);
  const visibility = parseVisibility(body) || 'private';

  let forkedFrom: ForkRef | undefined;
  let forkSource: Project | null = null;
  const forkId = body.forkedFrom && typeof body.forkedFrom === 'object' ? body.forkedFrom.id : body.forkedFrom;
  if (forkId !== undefined && forkId !== null) {
    if (!isProjectId(forkId)) return response.error('Invalid forkedFrom', 400);
    forkSource = await db.getProject(forkId);
    if (!forkSource || (!forkSource.isPublic && forkSource.userId !== auth.userId)) {
      return response.error('The original project is private or does not exist', 404);
    }
    forkedFrom = { id: forkSource.projectId, username: forkSource.username, name: forkSource.name };
  }

  if (!(await db.reserveProjectSlot(auth.userId, MAX_PROJECTS_PER_USER))) {
    return response.error(`You have reached the limit of ${MAX_PROJECTS_PER_USER} cloud projects. Delete some to save new ones.`, 403, { code: 'project_quota' });
  }

  const projectId = uuidv4();
  const now = new Date();
  const stamp = now.toISOString();
  const project: Project = {
    projectId,
    userId: auth.userId,
    username: auth.username, // Denormalized for fast reads (current handle from the users table)
    name,
    description,
    data: body.data,
    isPublic: visibility !== 'private',
    visibility: visibility === 'public' ? 'public' : undefined,
    nodeCount: stats.nodeCount,
    hasJS: stats.hasJS,
    forkedFrom,
    createdAt: stamp,
    updatedAt: stamp,
    publishedAt: visibility === 'public' ? stamp : undefined,
  };
  try {
    await db.createProject(project);
  } catch (err) {
    await db.releaseProjectSlot(auth.userId);
    throw err;
  }

  // A fork counts once per (user, source)
  if (forkSource && forkSource.userId !== auth.userId && await db.claimOnce(`fork#${forkSource.projectId}#${auth.userId}`, 0, now)) {
    await db.incrementForks(forkSource.projectId);
  }

  return response.success(publicSummary(project), 201);
});
