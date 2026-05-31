import { shell } from './_common';

export function renderCrawlComplete(data: Record<string, unknown>): { subject: string; text: string; html: string } {
  const siteUrl = String(data.siteUrl ?? '');
  const pages = Number(data.pages ?? 0);
  const text = [
    `Crawl complete: ${siteUrl}`,
    '',
    `${pages} pages read. The workbench shows the orphans ranked by impressions.`,
    '',
    'https://rectoapp.com/app',
  ].join('\n');
  return shell(`Crawl complete: ${siteUrl}`, text);
}
