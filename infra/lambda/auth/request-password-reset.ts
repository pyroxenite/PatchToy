import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getUserByEmail } from '../shared/db';
import { signToken } from '../shared/jwt';
import { success, error } from '../shared/response';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';

const sesClient = new SESClient({});
const FROM_EMAIL = process.env.FROM_EMAIL || 'noreply@patchtoy.com';
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:8080';

export const handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  try {
    const body = JSON.parse(event.body || '{}');
    const { email } = body;

    if (!email) {
      return error('Email is required', 400);
    }

    // Find user by email
    const user = await getUserByEmail(email.toLowerCase());

    // Always return success to prevent email enumeration attacks
    // (Don't reveal whether the email exists in the database)
    if (!user) {
      return success({
        message: 'If that email exists, a password reset link has been sent',
      });
    }

    // Generate password reset token (expires in 1 minute for security)
    const resetToken = signToken(
      {
        userId: user.userId,
        email: user.email,
        type: 'password-reset',
      },
      '1m'
    );

    // Create reset URL
    const resetUrl = `${FRONTEND_URL}?reset=${resetToken}`;

    // Send email with reset link
    const emailParams = {
      Source: FROM_EMAIL,
      Destination: {
        ToAddresses: [user.email],
      },
      Message: {
        Subject: {
          Data: 'Reset Your PatchToy Password',
        },
        Body: {
          Html: {
            Data: `
              <!DOCTYPE html>
              <html>
              <head>
                <style>
                  body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
                  .container { max-width: 600px; margin: 0 auto; padding: 20px; }
                  .button {
                    display: inline-block;
                    padding: 12px 24px;
                    background: #007acc;
                    color: #ffffff !important;
                    text-decoration: none;
                    border-radius: 4px;
                    margin: 20px 0;
                  }
                  .footer { margin-top: 30px; font-size: 12px; color: #666; }
                  .warning { color: #f44336; font-weight: bold; }
                </style>
              </head>
              <body>
                <div class="container">
                  <h2>Reset Your Password</h2>
                  <p>Hi ${user.username},</p>
                  <p>You requested to reset your password for your PatchToy account.</p>
                  <p>Click the button below to reset your password:</p>
                  <a href="${resetUrl}" class="button">Reset Password</a>
                  <p>Or copy and paste this link into your browser:</p>
                  <p><a href="${resetUrl}">${resetUrl}</a></p>
                  <p class="warning">⚠️ This link will expire in 1 minute for security reasons.</p>
                  <p>If you didn't request this password reset, you can safely ignore this email.</p>
                  <div class="footer">
                    <p>— The PatchToy Team</p>
                  </div>
                </div>
              </body>
              </html>
            `,
          },
          Text: {
            Data: `
Hi ${user.username},

You requested to reset your password for your PatchToy account.

Click this link to reset your password:
${resetUrl}

⚠️ This link will expire in 1 minute for security reasons.

If you didn't request this password reset, you can safely ignore this email.

— The PatchToy Team
            `,
          },
        },
      },
    };

    try {
      await sesClient.send(new SendEmailCommand(emailParams));
    } catch (emailError) {
      console.error('Failed to send email:', emailError);
      // Still return success to user to avoid revealing email exists
      // but log the error for debugging
      return success({
        message: 'If that email exists, a password reset link has been sent',
      });
    }

    return success({
      message: 'If that email exists, a password reset link has been sent',
    });
  } catch (err) {
    console.error('Error in request-password-reset:', err);
    return error('Internal server error', 500);
  }
};
