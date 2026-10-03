export function mediaBlock(placement: { id: string; kind: string; caption: string; name: string }) {
  const caption = placement.caption ? [{ type: 'text', text: { content: placement.caption } }] : [];
  const content = {
    type: 'file_upload', file_upload: { id: placement.id }, caption,
    ...(placement.kind === 'file' ? { name: placement.name } : {}),
  };
  return { object: 'block', type: placement.kind, [placement.kind]: content };
}

export function appendMediaArgs(pageId: string) {
  return ['api', `v1/blocks/${encodeURIComponent(pageId)}/children`, '-X', 'PATCH', '-d', '@-'];
}

export function appendMediaPayload(placeholderId: string, placement: { id: string; kind: string; caption: string; name: string }) {
  return {
    children: [mediaBlock(placement)],
    position: { type: 'after_block', after_block: { id: placeholderId } },
  };
}

function parseResponse(raw: string) {
  try { return JSON.parse(raw); }
  catch { throw new Error('ntn returned invalid block data.'); }
}

export async function insertMedia(run: (args: string[], stdin?: string) => Promise<string>, pageId: string,
  placements: { marker: string; label: string; id: string; kind: string; caption: string; name: string; original?: string; source?: string; drawing?: boolean }[],
  onInserted?: (placement: (typeof placements)[number], blockId: string) => void) {
  const issues: string[] = [];
  if (!placements.length) return issues;
  const blocks: { text: string; id: string }[] = [];
  let cursor: string | null = null;
  try {
    do {
      const args = ['api', `v1/blocks/${encodeURIComponent(pageId)}/children`, 'page_size==100'];
      if (cursor) args.push(`start_cursor==${encodeURIComponent(cursor)}`);
      const page = parseResponse(await run(args));
      if (!Array.isArray(page.results)) throw new Error('ntn returned an invalid block list.');
      for (const block of page.results) {
        if (block.type !== 'paragraph' || typeof block.id !== 'string') continue;
        const text = block.paragraph?.rich_text?.map((part: { plain_text?: string; text?: { content?: string } }) => part.plain_text ?? part.text?.content ?? '').join('');
        if (text) blocks.push({ text, id: block.id });
      }
      cursor = page.has_more && typeof page.next_cursor === 'string' ? page.next_cursor : null;
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
      const response = parseResponse(await run(appendMediaArgs(pageId), JSON.stringify(appendMediaPayload(placeholder, place))));
      if (onInserted) {
        const id = response.results?.[0]?.id;
        if (typeof id !== 'string') throw new Error('Notion did not return the inserted media block ID.');
        onInserted(place, id);
      }
      await run(['api', `v1/blocks/${encodeURIComponent(placeholder)}`, '-X', 'DELETE']);
    } catch (error) {
      issues.push(`Attachment ${place.label}: could not embed (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  return issues;
}
