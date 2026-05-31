import { shell } from './_common';

// Flat-$39 stacking model: each upgrade = +1 site, +100 credits/month.
// data.codes / data.monthlyCredits reflect the user's new totals after stacking.
// Filename is legacy ("tier-upgrade") — kept to avoid touching queue producer
// keys. Copy no longer mentions tiers.
export function renderTierUpgrade(data: Record<string, unknown>): { subject: string; text: string; html: string } {
  const codes = Number(data.codes ?? 1);
  const monthlyCredits = Number(data.monthlyCredits ?? codes * 100);
  const siteLabel = codes === 1 ? '1 site' : `${codes} sites`;
  const text = [
    'Code stacked.',
    '',
    `You now have ${codes} codes. That is ${siteLabel} and ${monthlyCredits} anchor credits per month.`,
    'Your existing sites and pushes carry forward unchanged.',
    'The extra credits show up in this month\'s pool immediately, then reset to the new ceiling on the 1st.',
    '',
    'https://rectoapp.com/app',
  ].join('\n');
  return shell(`Another code on your recto account`, text);
}
