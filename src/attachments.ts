import { randomUUID } from 'node:crypto';
import { lookup } from 'mime-types';
import { codeRanges } from './markdown';
import { isTldraw } from './tldraw';

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

export function isExcalidraw(path: string) {
  return /\.excalidraw(?:\.md)?$/i.test(path);
}

export function mediaKind(name: string) {
  if (/\.pdf$/i.test(name)) return 'pdf';
  const mime = lookup(name);
  if (mime && /^(image|audio|video)\//.test(mime)) return mime.split('/')[0];
  return 'file';
}

export function uploadArgs(name: string, mime: string) {
  return ['files', 'create', '--json', '--filename', name, '--content-type', mime];
}

export function parseUploadResult(output: string) {
  let result;
  try { result = JSON.parse(output); }
  catch { throw new Error('ntn files create returned invalid JSON.'); }
  if (typeof result?.id !== 'string' || !result.id || result.status !== 'uploaded') {
    throw new Error('ntn files create did not return an uploaded file ID.');
  }
  return result.id as string;
}

export function parseEmbeds(body: string) {
  const ranges = codeRanges(body);
  const regex = /!\[\[([^\]\n]+)\]\]|!\[([^\]\n]*)\]\((<[^>\n]+>|[^)\n]+)\)/g;
  return [...body.matchAll(regex)]
    .filter((match) => !ranges.some((range) => match.index >= range.start && match.index < range.end))
    .map((match) => {
      const wiki = match[1] !== undefined;
      const [link, alias] = wiki ? match[1].split('|', 2) : [match[3].replace(/^<|>$/g, ''), match[2]];
      const label = alias?.trim() || '';
      return {
        start: match.index,
        end: match.index + match[0].length,
        path: link.trim().split('#')[0],
        caption: /^(?:\d+|\d+x\d+)$/i.test(label) ? '' : label,
        original: match[0],
      };
    });
}

export async function prepareAttachments(body: string, from: string, deps: {
  resolve: (path: string, from: string) => { path: string; name: string; stat: { size: number } } | null;
  read: (file: { path: string }) => Promise<Uint8Array>;
  render: (file: { path: string }) => Promise<Uint8Array>;
  isTldraw?: (file: { path: string }) => boolean;
  upload: (bytes: Uint8Array, filename: string, mime: string) => Promise<string>;
}) {
  const issues: string[] = [];
  const placements: { marker: string; label: string; id: string; kind: string; caption: string; name: string }[] = [];
  const uploads = new Map<string, string>();
  const embeds = parseEmbeds(body);
  let markdown = '';
  let previous = 0;
  const pushId = randomUUID();
  for (const [index, embed] of embeds.entries()) {
    markdown += body.slice(previous, embed.start);
    previous = embed.end;
    const label = embed.path || embed.original;
    if (/^(?:https?:|data:)/i.test(embed.path)) {
      markdown += embed.original;
      continue;
    }
    const file = deps.resolve(embed.path, from);
    if (!file) {
      issues.push(`Missing attachment: ${label}`);
      markdown += `Attachment: ${label} (not found)`;
      continue;
    }
    const tldraw = isTldraw(file.path) || deps.isTldraw?.(file) === true;
    const drawing = isExcalidraw(file.path) || tldraw;
    const kind = drawing ? 'image' : mediaKind(file.name);
    const name = drawing ? `${file.name.replace(/\.(?:excalidraw|tldraw)(?:\.md)?$|\.tldr$|\.md$/i, '')}.png` : file.name;
    try {
      if (!drawing && file.stat.size > MAX_UPLOAD_BYTES) throw new Error('exceeds 20 MiB single-file upload limit');
      let id = uploads.get(file.path);
      if (!id) {
        const bytes = drawing ? await deps.render(file) : await deps.read(file);
        if (bytes.byteLength > MAX_UPLOAD_BYTES) throw new Error('exceeds 20 MiB single-file upload limit');
        const mime = drawing ? 'image/png' : lookup(file.name) || 'application/octet-stream';
        id = await deps.upload(bytes, name, mime);
        uploads.set(file.path, id);
      }
      const marker = `NTN_SYNC_MEDIA_${pushId.replace(/-/g, '')}_${index}`;
      // Keep a readable fallback if the blocks API cannot replace this paragraph.
      markdown += `\n\nAttachment: ${label} (not embedded) [${marker}]\n\n`;
      placements.push({ marker, label, id, kind, caption: embed.caption, name });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const hint = tldraw ? ' (install or enable Tldraw in Obsidian for drawings)' :
        drawing ? ' (install or enable obsidian-excalidraw-plugin for drawings)' : '';
      issues.push(`Attachment ${label}: ${reason}${hint}`);
      markdown += `Attachment: ${label} (not embedded)`;
    }
  }
  markdown += body.slice(previous);
  return { markdown, placements, issues };
}
