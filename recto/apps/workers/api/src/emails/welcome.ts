import { shell } from './_common';

// Flat-$39 pricing model (locked 2026-05-29):
//   data.codes          — total non-refunded codes the user holds.
//   data.monthlyCredits — codes * 100. The pool that resets on the 1st.
// First redemption → codes=1. Stacked redemption goes through tier-upgrade.ts.
export function renderWelcome(data: Record<string, unknown>): { subject: string; text: string; html: string } {
  const codes = Number(data.codes ?? 1);
  const monthlyCredits = Number(data.monthlyCredits ?? codes * 100);
  const codeLabel = codes === 1 ? '1 code' : `${codes} codes`;
  const siteLabel = codes === 1 ? '1 site' : `${codes} sites`;
  const text = [
    'recto is ready.',
    '',
    `Your code is redeemed. ${codeLabel}, ${siteLabel}, ${monthlyCredits} anchor credits per month.`,
    'Credits reset on the 1st. They do not carry over.',
    '',
    'Open the dashboard, connect your first site, and run the first crawl.',
    'The crawl returns within an hour for most sites. We email you when it lands.',
    '',
    'https://rectoapp.com/app',
  ].join('\n');
  return shell('recto is ready.', text);
}
