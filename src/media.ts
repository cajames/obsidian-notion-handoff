import { Client } from '@notionhq/client';

export function mediaBlock(placement: { id: string; kind: string; caption: string; name: string }) {
  const caption = placement.caption ? [{ type: 'text' as const, text: { content: placement.caption } }] : [];
  const content = { type: 'file_upload' as const, file_upload: { id: placement.id }, caption };
  switch (placement.kind) {
    case 'image': return { image: content };
    case 'pdf': return { pdf: content };
    case 'audio': return { audio: content };
    case 'video': return { video: content };
    default: return { file: { ...content, name: placement.name } };
  }
}

export function appendMediaPayload(placeholderId: string, placement: { id: string; kind: string; caption: string; name: string }) {
  return {
    children: [mediaBlock(placement)],
    position: { type: 'after_block' as const, after_block: { id: placeholderId } },
  };
}

export async function insertMedia(client: Client, pageId: string,
  placements: { marker: string; label: string; id: string; kind: string; caption: string; name: string; original?: string; source?: string; drawing?: boolean }[],
  onInserted?: (placement: (typeof placements)[number], blockId: string) => void) {
  const issues: string[] = [];
  if (!placements.length) return issues;
  const blocks: { text: string; id: string }[] = [];
  let cursor: string | undefined;
  const cursors = new Set<string>();
  try {
    do {
      const page = await client.blocks.children.list({ block_id: pageId, page_size: 100, start_cursor: cursor });
      if (!Array.isArray(page?.results) || typeof page.has_more !== 'boolean') throw new Error('Notion returned an invalid block list.');
      for (const block of page.results) {
        if (!('type' in block) || typeof block.id !== 'string') throw new Error('Notion returned incomplete blocks.');
        if (block.type !== 'paragraph') continue;
        if (!Array.isArray(block.paragraph?.rich_text)) throw new Error('Notion returned incomplete paragraph content.');
        const text = block.paragraph?.rich_text?.map((part) => part.plain_text ?? ('text' in part ? part.text.content : '')).join('');
        if (text) blocks.push({ text, id: block.id });
      }
      if (page.has_more && (typeof page.next_cursor !== 'string' || !page.next_cursor || cursors.has(page.next_cursor))) throw new Error('Notion pagination is incomplete or repeated.');
      cursor = page.has_more ? page.next_cursor! : undefined;
      if (cursor) cursors.add(cursor);
    } while (cursor);
  } catch (error) {
    return placements.map((place) => `Attachment ${place.label}: cannot locate position (${error instanceof Error ? error.message : String(error)})`);
  }

  for (const place of placements) {
    const placeholder = blocks.find((block) => block.text.includes(place.marker))?.id;
    if (!placeholder) {
      issues.push(`Attachment ${place.label}: position not found in Notion page.`);
      continue;
    }
    try {
      const response = await client.blocks.children.append({ block_id: pageId, ...appendMediaPayload(placeholder, place) });
      const id = response?.results?.[0]?.id;
      if (typeof id !== 'string' || !id) throw new Error('Notion did not return the inserted media block ID.');
      onInserted?.(place, id);
      await client.blocks.delete({ block_id: placeholder });
    } catch (error) {
      issues.push(`Attachment ${place.label}: could not embed (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  return issues;
}
