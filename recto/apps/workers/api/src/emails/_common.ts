// Shared email shell. Plain-text + a minimal HTML version that preserves
// linebreaks and a single hairline divider. No images, no tracking pixels.
export function shell(subject: string, text: string): { subject: string; text: string; html: string } {
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const html = `<!doctype html><html><body style="font:14px/1.6 -apple-system,system-ui,sans-serif;color:#111;max-width:560px;margin:0 auto;padding:32px 24px">
${escaped.split(/\n/).map((line) => line === '' ? '<br>' : `<div>${line}</div>`).join('\n')}
<hr style="margin-top:32px;border:0;border-top:1px solid #e5e5e5">
<div style="font-size:12px;color:#666;margin-top:16px">recto — surface orphan pages on the sites you own.</div>
</body></html>`;
  return { subject, text, html };
}
