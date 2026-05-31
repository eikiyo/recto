import { shell } from './_common';

export function renderMagicLink(data: Record<string, unknown>): { subject: string; text: string; html: string } {
  const link = String(data.link ?? '');
  const text = [
    'Sign in to recto.',
    '',
    'Use this link within 15 minutes:',
    link,
    '',
    "If you didn't request this, ignore the email. The link expires on its own.",
  ].join('\n');
  return shell('Sign in to recto', text);
}
