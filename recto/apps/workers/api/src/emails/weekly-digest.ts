import { shell } from './_common';

export function renderWeeklyDigest(data: Record<string, unknown>): { subject: string; text: string; html: string } {
  const newOrphans = Number(data.newOrphans ?? 0);
  const verifiedPushes = Number(data.verifiedPushes ?? 0);
  const topOrphans = Array.isArray(data.topOrphans) ? (data.topOrphans as Array<{ slug: string; impressions28d: number }>) : [];
  const lines = [
    'This week on the sites recto reads for you:',
    '',
    `${newOrphans} new orphans. ${verifiedPushes} links verified live.`,
    '',
  ];
  if (topOrphans.length > 0) {
    lines.push('Top three orphans by impressions:');
    for (const o of topOrphans.slice(0, 3)) {
      lines.push(`  ${o.slug} — ${o.impressions28d} impressions, no inbound links`);
    }
    lines.push('');
  }
  lines.push('Open the workbench to fix them.');
  lines.push('');
  lines.push('https://rectoapp.com/app');
  return shell('Your recto digest', lines.join('\n'));
}
