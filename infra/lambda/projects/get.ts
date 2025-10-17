import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import * as response from '../shared/response';
import * as jwt from '../shared/jwt';
import * as db from '../shared/db';

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  try {
    // Get project ID from path
    const projectId = event.pathParameters?.id;
    if (!projectId) {
      return response.error('Project ID is required', 400);
    }

    // Get project
    const project = await db.getProject(projectId);
    if (!project) {
      return response.error('Project not found', 404);
    }

    // Try to get auth token (optional)
    const token = jwt.extractToken(event.headers.Authorization || event.headers.authorization);
    const payload = token ? jwt.verify(token) : null;

    // Check if user has access
    const isOwner = payload && project.userId === payload.userId;
    const isPublic = project.isPublic === true;

    if (!isOwner && !isPublic) {
      return response.error('Project not found', 404); // Don't reveal existence of private projects
    }

    return response.success({
      id: project.projectId,
      name: project.name,
      username: project.username,
      data: project.data,
      isPublic: project.isPublic,
      isOwner: isOwner,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
    });
  } catch (err: any) {
    console.error('Get project error:', err);
    return response.error('Internal server error', 500);
  }
}
