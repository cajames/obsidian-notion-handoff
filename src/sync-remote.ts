import { createHash } from 'node:crypto';
import { parseEmbeds } from './attachments';
import { codeRanges } from './markdown';
import { comparisonBody } from './sync-text';

export function normalizeBody(body: string) {
  return comparisonBody(body);
}

export function fingerprint(body: string) {
  return createHash('sha256').update(normalizeBody(body)).digest('hex');
}

export function urlIdentity(url: string) {
  const parsed = new URL(url.replace(/&amp;/g, '&'));
  // Only discard expiring signature parameters on Notion-hosted files.
  if (/(?:^|\.)(?:amazonaws\.com|notion\.so|notion-static\.com)$/.test(parsed.hostname)) parsed.search = '';
  parsed.hash = '';
  return parsed.href;
}

export function mediaToken(media: { id: string; url: string; version: string }) {
  return `notion-media://${media.id}/${fingerprint(`${urlIdentity(media.url)}:${media.version}`).slice(0, 16)}`;
}

export function remoteEmbeds(body: string) {
  const images = parseEmbeds(body).filter((embed) => /^(?:https?:|notion-media:)/i.test(embed.path))
    .map((embed) => ({ ...embed, url: embed.path, kind: 'image' }));
  const ranges = codeRanges(body);
  const tags = [...body.matchAll(/<(file|pdf|audio|video)\b[^>]*src="([^"]+)"[^>]*>[\s\S]*?<\/\1>/g)]
    .filter((match) => !ranges.some((range) => match.index >= range.start && match.index < range.end))
    .map((match) => ({ start: match.index, end: match.index + match[0].length, original: match[0],
      url: match[2], path: match[2], kind: match[1], caption: '' }));
  return [...images, ...tags].sort((a, b) => a.start - b.start);
}

export function canonicalReferences(body: string) {
  const ranges = codeRanges(body);
  return body.replace(/<mention-page\b[^>]*url="([^"]+)"[^>]*>([\s\S]*?)<\/mention-page>/g,
    (match, url: string, label: string, offset: number) => {
      if (ranges.some((range) => offset >= range.start && offset < range.end)) return match;
      const id = url.match(/[a-f\d]{32}|[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}/i)?.[0];
      return id ? `<mention-page id="${id.replace(/-/g, '').toLowerCase()}">${label}</mention-page>` : match;
    });
}

export async function readRemote(run: (args: string[]) => Promise<string>, pageId: string) {
  const data = JSON.parse(await run(['api', `v1/pages/${encodeURIComponent(pageId)}/markdown`]));
  if (typeof data?.markdown !== 'string') throw new Error('Notion returned invalid Markdown.');
  if (data.truncated || data.unknown_block_ids?.length) {
    throw new Error('Notion returned truncated or inaccessible content; refusing an incomplete sync.');
  }
  const media: { id: string; kind: string; url: string; version: string; token: string }[] = [];
  const visited = new Set<string>();
  const walk = async (id: string, depth = 0) => {
    if (depth > 25 || visited.size > 1000 || visited.has(id)) throw new Error('Notion page nesting is too large or invalid.');
    visited.add(id);
    let cursor = '';
    const cursors = new Set<string>();
    do {
      const args = ['api', `v1/blocks/${encodeURIComponent(id)}/children`, 'page_size==100'];
      if (cursor) args.push(`start_cursor==${encodeURIComponent(cursor)}`);
      const page = JSON.parse(await run(args));
      if (!Array.isArray(page?.results)) throw new Error('Notion returned invalid blocks.');
      for (const block of page.results) {
        if (typeof block.id !== 'string') throw new Error('Notion returned a block without an ID.');
        if (['image', 'file', 'pdf', 'audio', 'video'].includes(block.type)) {
          const value = block[block.type];
          const url = value?.file?.url ?? value?.external?.url;
          if (typeof url !== 'string') throw new Error('Notion media is missing its download URL.');
          const asset = { id: String(block.id), kind: String(block.type), url, version: String(block.last_edited_time ?? '') };
          media.push({ ...asset, token: mediaToken(asset) });
        }
        if (block.has_children && !['child_page', 'child_database'].includes(block.type)) await walk(block.id, depth + 1);
      }
      if (page.has_more && typeof page.next_cursor !== 'string') throw new Error('Notion pagination is incomplete.');
      cursor = page.has_more ? page.next_cursor : '';
      if (cursor && cursors.has(cursor)) throw new Error('Notion pagination repeated a cursor.');
      cursors.add(cursor);
    } while (cursor);
  };
  await walk(pageId);
  let markdown = '';
  let previous = 0;
  const used = new Set<string>();
  for (const embed of remoteEmbeds(data.markdown)) {
    const candidates = media.filter((asset) => urlIdentity(asset.url) === urlIdentity(embed.url));
    const asset = candidates.find((candidate) => !used.has(candidate.id)) ?? candidates[0];
    if (asset) used.add(asset.id);
    markdown += data.markdown.slice(previous, embed.start) +
      (asset ? embed.original.replace(embed.url, asset.token) : embed.original);
    previous = embed.end;
  }
  markdown = canonicalReferences(markdown + data.markdown.slice(previous));
  return { markdown, media, fingerprint: fingerprint(markdown) };
}
