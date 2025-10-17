import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { v4 as uuidv4 } from 'uuid';
import * as response from '../shared/response';
import * as jwt from '../shared/jwt';
import * as password from '../shared/password';
import * as db from '../shared/db';

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  try {
    // Parse request body
    const body = JSON.parse(event.body || '{}');
    const { email, username, password: plainPassword } = body;

    // Validate input
    if (!email || !username || !plainPassword) {
      return response.error('Email, username, and password are required', 400);
    }

    if (!password.validateEmail(email)) {
      return response.error('Invalid email format', 400);
    }

    // Validate username (alphanumeric, underscore, hyphen, 3-20 chars)
    if (!/^[a-zA-Z0-9_-]{3,20}$/.test(username)) {
      return response.error('Username must be 3-20 characters (letters, numbers, _, -)', 400);
    }

    const passwordError = password.validatePassword(plainPassword);
    if (passwordError) {
      return response.error(passwordError, 400);
    }

    // Check if user already exists (email or username)
    const existingEmail = await db.getUserByEmail(email.toLowerCase());
    if (existingEmail) {
      return response.error('Email already in use', 409);
    }

    const existingUsername = await db.getUserByUsername(username.toLowerCase());
    if (existingUsername) {
      return response.error('Username already taken', 409);
    }

    // Create user
    const userId = uuidv4();
    const passwordHash = await password.hash(plainPassword);

    await db.createUser({
      userId,
      email: email.toLowerCase(),
      username: username.toLowerCase(),
      passwordHash,
      createdAt: new Date().toISOString(),
    });

    // Generate token
    const token = jwt.sign({ userId, email: email.toLowerCase(), username: username.toLowerCase() });

    return response.success({
      token,
      userId,
      email: email.toLowerCase(),
      username: username.toLowerCase(),
    }, 201);
  } catch (err: any) {
    console.error('Register error:', err);
    return response.error('Internal server error', 500);
  }
}
