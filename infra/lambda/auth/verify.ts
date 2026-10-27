import { APIGatewayProxyEvent } from 'aws-lambda';
import * as response from '../shared/response';
import { handle, requireAuth } from '../shared/http';

/** GET /api/auth/verify - the current session (401 once it was revoked). Values come from the users table. */
export const handler = handle('Verify', async (event: APIGatewayProxyEvent) => {
  const auth = await requireAuth(event);
  return response.success(
    {
      valid: true,
      userId: auth.userId,
      email: auth.email,
      username: auth.username,
    },
    200,
    { 'Cache-Control': 'private, no-store' },
  );
});
