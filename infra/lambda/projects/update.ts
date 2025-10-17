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
    const { name, data, isPublic } = body;

    if (!name && !data && isPublic === undefined) {
      return response.error('At least one of name, data, or isPublic is required', 400);
    }

    // Update project
    const updates: { name?: string; data?: any; isPublic?: boolean } = {};
    if (name !== undefined) updates.name = name;
    if (data !== undefined) updates.data = data;
    if (isPublic !== undefined) updates.isPublic = Boolean(isPublic);

    await db.updateProject(projectId, updates);

    return response.success({
      id: projectId,
      name: name || project.name,
      updatedAt: new Date().toISOString(),
    });
  } catch (err: any) {
    console.error('Update project error:', err);
    return response.error('Internal server error', 500);
  }
}
