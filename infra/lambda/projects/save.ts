import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { v4 as uuidv4 } from 'uuid';
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

    // Parse request body
    const body = JSON.parse(event.body || '{}');
    const { name, data, isPublic = false } = body;

    if (!name || !data) {
      return response.error('Name and data are required', 400);
    }

    // Create project
    const projectId = uuidv4();
    const now = new Date().toISOString();

    await db.createProject({
      projectId,
      userId: payload.userId,
      username: payload.username, // Denormalized for fast reads
      name,
      data,
      isPublic: Boolean(isPublic),
      createdAt: now,
      updatedAt: now,
    });

    return response.success({
      id: projectId,
      name,
      username: payload.username,
      createdAt: now,
      updatedAt: now,
    }, 201);
  } catch (err: any) {
    console.error('Save project error:', err);
    return response.error('Internal server error', 500);
  }
}
