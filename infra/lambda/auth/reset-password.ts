import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getUser } from '../shared/db';
import { verifyToken } from '../shared/jwt';
import { hashPassword } from '../shared/password';
import { success, error } from '../shared/response';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const USERS_TABLE = process.env.USERS_TABLE || 'PatchToy-Users';

export const handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  try {
    const body = JSON.parse(event.body || '{}');
    const { token, newPassword } = body;

    if (!token || !newPassword) {
      return error('Token and new password are required', 400);
    }

    if (newPassword.length < 8) {
      return error('Password must be at least 8 characters', 400);
    }

    // Verify the reset token
    let payload;
    try {
      payload = verifyToken(token);
    } catch (err) {
      return error('Invalid or expired reset token', 401);
    }

    // Verify token type
    if (payload.type !== 'password-reset') {
      return error('Invalid token type', 401);
    }

    // Verify user still exists
    const user = await getUser(payload.userId);
    if (!user) {
      return error('User not found', 404);
    }

    // Hash the new password
    const passwordHash = await hashPassword(newPassword);

    // Update user's password in database
    await docClient.send(
      new UpdateCommand({
        TableName: USERS_TABLE,
        Key: { userId: user.userId },
        UpdateExpression: 'SET passwordHash = :passwordHash',
        ExpressionAttributeValues: {
          ':passwordHash': passwordHash,
        },
      })
    );

    return success({
      message: 'Password successfully reset',
    });
  } catch (err) {
    console.error('Error in reset-password:', err);
    return error('Internal server error', 500);
  }
};
