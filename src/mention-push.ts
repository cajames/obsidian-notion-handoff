import { markdownArgs, markdownPayload } from './cli';
import { renderReferences } from './references';

export function mentionsImported(response: string, references: { id: string }[]) {
  let data;
  try { data = JSON.parse(response); } catch { return false; }
  if (data.truncated || typeof data.markdown !== 'string') return false;
  const found = [...data.markdown.matchAll(/<mention-page\b[^>]*url="([^"]+)"[^>]*>/g)]
    .map((match: RegExpMatchArray) => match[1].match(/[a-f\d]{32}|[a-f\d-]{36}/i)?.[0].replace(/-/g, '').toLowerCase());
  for (const reference of references) {
    const index = found.indexOf(reference.id.replace(/-/g, '').toLowerCase());
    if (index < 0) return false;
    found.splice(index, 1);
  }
  return true;
}

export async function pushMarkdownWithMentions(run: (args: string[], stdin?: string) => Promise<string>, pageId: string,
  body: string, references: { token: string; mention: string; pending: string; label: string; id: string }[]) {
  const path = `v1/pages/${encodeURIComponent(pageId)}/markdown`;
  const patch = (markdown: string) => run(markdownArgs(pageId), JSON.stringify(markdownPayload(markdown)));
  try {
    await patch(renderReferences(body, references));
    if (references.length) {
      const response = await run(['api', path]);
      if (!mentionsImported(response, references)) throw new Error('Notion did not return the page mentions after import.');
    }
    return [];
  } catch (error) {
    if (!references.length) throw error;
    // The API does not identify which mention failed: demote them all, preserving other page content.
    await patch(renderReferences(body, references, true));
    return references.map((reference) => reference.label);
  }
}
