import { Client, isNotionClientError } from '@notionhq/client';
import { markdownPayload } from './notion';
import { renderReferences } from './references';

export function mentionsImported(data: { markdown?: string; truncated?: boolean; unknown_block_ids?: string[] }, references: { id: string }[]) {
  if (data.truncated || data.unknown_block_ids?.length || typeof data.markdown !== 'string') return false;
  const found = [...data.markdown.matchAll(/<mention-page\b[^>]*url="([^"]+)"[^>]*>/g)]
    .map((match) => match[1].match(/[a-f\d]{32}|[a-f\d-]{36}/i)?.[0].replace(/-/g, '').toLowerCase());
  for (const reference of references) {
    const index = found.indexOf(reference.id.replace(/-/g, '').toLowerCase());
    if (index < 0) return false;
    found.splice(index, 1);
  }
  return true;
}

export async function pushMarkdownWithMentions(client: Client, pageId: string,
  body: string, references: { token: string; mention: string; pending: string; label: string; id: string }[]) {
  const patch = (markdown: string) => client.pages.updateMarkdown({ page_id: pageId, ...markdownPayload(markdown) });
  let demote = false;
  try {
    await patch(renderReferences(body, references));
  } catch (error) {
    // Only a rejected validation request can safely take the mention fallback.
    // Permissions, timeouts and ambiguous server writes must stop the push.
    if (!references.length || !isNotionClientError(error) || error.code !== 'validation_error') throw error;
    demote = true;
  }
  if (references.length && !demote) {
    const response = await client.pages.retrieveMarkdown({ page_id: pageId });
    if (response?.truncated !== false || !Array.isArray(response.unknown_block_ids) || response.unknown_block_ids.length || typeof response.markdown !== 'string') {
      throw new Error('Notion returned incomplete mention readback; refusing another write.');
    }
    demote = !mentionsImported(response, references);
  }
  if (!demote) return [];
  // Notion cannot identify the failed mention. Preserve content, demote all.
  await patch(renderReferences(body, references, true));
  return references.map((reference) => reference.label);
}
