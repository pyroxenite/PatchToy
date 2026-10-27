/**
 * Outgoing email. In AWS: SES. Tests and the mock API install their own mailer
 * (setMailer) that records messages instead of sending them.
 */
export interface Mail {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export type Mailer = (mail: Mail) => Promise<void>;

let current: Mailer | null = null;

const sesMailer: Mailer = async (mail) => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { SESClient, SendEmailCommand } = require('@aws-sdk/client-ses');
  const client = new SESClient({});
  await client.send(new SendEmailCommand({
    Source: process.env.FROM_EMAIL || 'noreply@patchtoy.com',
    Destination: { ToAddresses: [mail.to] },
    Message: {
      Subject: { Data: mail.subject },
      Body: { Html: { Data: mail.html }, Text: { Data: mail.text } },
    },
  }));
};

export function getMailer(): Mailer {
  return current || sesMailer;
}

export function setMailer(mailer: Mailer | null): void {
  current = mailer;
}
