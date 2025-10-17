import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import * as response from '../shared/response';
import * as jwt from '../shared/jwt';
import * as password from '../shared/password';
import * as db from '../shared/db';

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  try {
    // Parse request body
    const body = JSON.parse(event.body || '{}');
    const { login, password: plainPassword } = body;

    // Validate input
    if (!login || !plainPassword) {
      return response.error('Login (email or username) and password are required', 400);
    }

    // Find user by email or username
    const loginLower = login.toLowerCase();
    let user = await db.getUserByEmail(loginLower);
    if (!user) {
      user = await db.getUserByUsername(loginLower);
    }

    if (!user) {
      return response.error('Invalid credentials', 401);
    }

    // Verify password
    const isValid = await password.verify(plainPassword, user.passwordHash);
    if (!isValid) {
      return response.error('Invalid credentials', 401);
    }

    // Generate token
    const token = jwt.sign({ userId: user.userId, email: user.email, username: user.username });

    return response.success({
      token,
      userId: user.userId,
      email: user.email,
      username: user.username,
    });
  } catch (err: any) {
    console.error('Login error:', err);
    return response.error('Internal server error', 500);
  }
}
