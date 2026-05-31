import { shell } from './_common';

export function renderByokThreshold(data: Record<string, unknown>): { subject: string; text: string; html: string } {
  const remaining = Number(data.creditsRemaining ?? 0);
  const text = [
    `${remaining} anchor credits left in your pool.`,
    '',
    'Two paths from here:',
    '  1. Add an OpenAI or Anthropic key (BYOK). Anchor generation continues with no cap; you pay the model provider directly.',
    '  2. Wait for next month. The pool refills.',
    '',
    'BYOK keys live encrypted in your account and never leave Cloudflare.',
    '',
    'https://rectoapp.com/app/settings-byok.html',
  ].join('\n');
  return shell(`recto: ${remaining} anchor credits remaining`, text);
}
