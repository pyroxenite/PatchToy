import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import * as response from '../shared/response';
import * as jwt from '../shared/jwt';
import * as db from '../shared/db';

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  try {
    // Verify auth
    const token = jwt.extractToken(event.headers.Authorization || event.headers.authorization);
    if (!token) {
      return response.error('Missing authorization token', 401);
    }

    const payload = jwt.verify(token);
    if (!payload) {
      return response.error('Invalid token', 401);
    }

    // Get project ID from path
    const projectId = event.pathParameters?.id;
    if (!projectId) {
      return response.error('Project ID is required', 400);
    }

    // Check ownership
    const project = await db.getProject(projectId);
    if (!project) {
      return response.error('Project not found', 404);
    }

    if (project.userId !== payload.userId) {
      return response.error('Unauthorized', 403);
    }

    // Parse request body
    const body = JSON.parse(event.body || '{}');
    const { isPublic } = body;

    if (isPublic === undefined) {
      return response.error('isPublic field is required', 400);
    }

    // Update visibility
    await db.updateProject(projectId, { isPublic: Boolean(isPublic) });

    return response.success({
      id: projectId,
      isPublic: Boolean(isPublic),
      updatedAt: new Date().toISOString(),
    });
  } catch (err: any) {
    console.error('Toggle visibility error:', err);
    return response.error('Internal server error', 500);
  }
}
