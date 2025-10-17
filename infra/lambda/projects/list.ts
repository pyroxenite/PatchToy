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

    // Get projects for user
    const projects = await db.listProjects(payload.userId);

    // Return lightweight list (don't send full data for all projects)
    const projectList = projects.map(p => ({
      id: p.projectId,
      name: p.name,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    }));

    return response.success({ projects: projectList });
  } catch (err: any) {
    console.error('List projects error:', err);
    return response.error('Internal server error', 500);
  }
}
