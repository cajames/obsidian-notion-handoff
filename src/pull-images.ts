import { extension } from 'mime-types';
import { posix } from 'path-browserify';
import { MAX_UPLOAD_BYTES, isExcalidraw, parseEmbeds } from './attachments';
import { isTldraw } from './tldraw';
import { readRemote, remoteEmbeds, fingerprint } from './sync-remote';
import { makeCheckpoint, restoreBindings } from './sync';
import { codeRanges } from './markdown';
import { makeOrigin } from './media-origins';

export async function prepareRemote(remote: Awaited<ReturnType<typeof readRemote>>, pageId: string,
  checkpoint: ReturnType<typeof makeCheckpoint> | null, deps: {
    download: (url: string) => Promise<{ bytes: Uint8Array; mime: string }>;
    exists: (path: string) => Promise<boolean>;
    imageFolder: string;
    origins?: ReturnType<typeof makeOrigin>[];
    drawingSource?: (original: string) => string | null;
  }) {
  const bindings = (checkpoint?.bindings ?? []).filter((binding) => remote.markdown.includes(binding.remote));
  const origins = [...(deps.origins ?? [])];
  // Migrate existing exact-Markdown bindings to stable block IDs, even if captions
  // or the exported image's URL/version have since changed.
  for (const binding of checkpoint?.bindings ?? []) {
    const path = parseEmbeds(binding.local)[0]?.path ?? '';
    const source = deps.drawingSource?.(binding.local) ?? (isExcalidraw(path) || isTldraw(path) ? path : null);
    if (!source) continue;
    for (const embed of remoteEmbeds(binding.remote)) {
      const asset = remote.media.find((media) => embed.url.startsWith(`notion-media://${media.id}/`));
      if (asset && !origins.some((origin) => origin.id === asset.id)) {
        origins.push(makeOrigin(asset.id, binding.local, source, true));
      }
    }
  }
  const restored = restoreBindings(remote.markdown, bindings);
  const files: { path: string; bytes: Uint8Array }[] = [];
  let markdown = '';
  let previous = 0;
  for (const embed of remoteEmbeds(restored)) {
    const asset = remote.media.find((media) => media.token === embed.url);
    const url = asset?.url ?? embed.url;
    const tracked = origins.find((origin) => origin.id === asset?.id && origin.drawing);
    let replacement = embed.original;
    if (tracked) {
      replacement = tracked.original;
      bindings.push({ remote: embed.original, local: replacement });
    } else if (bindings.some((binding) => binding.local === embed.original)) {
      replacement = embed.original;
    } else if (embed.kind !== 'image') {
      if (asset) replacement = `[Notion ${embed.kind}](https://www.notion.so/${pageId.replace(/-/g, '')}#${asset.id.replace(/-/g, '')})`;
    } else {
      if (!/^https:\/\//i.test(url)) throw new Error('Notion images must use HTTPS download URLs.');
      const downloaded = await deps.download(url);
      if (downloaded.bytes.byteLength > MAX_UPLOAD_BYTES) throw new Error('Notion image exceeds the 20 MiB import limit.');
      const mime = downloaded.mime.split(';')[0].trim().toLowerCase();
      const ext = /^image\//.test(mime) ? extension(mime) : false;
      if (!ext || !/^[a-z0-9]+$/.test(ext)) throw new Error('Notion image download did not return a supported image.');
      const id = asset?.id.replace(/[^a-z0-9]/gi, '') ?? fingerprint(url).slice(0, 32);
      const version = fingerprint(asset?.token ?? url).slice(0, 16);
      const filename = `notion-${pageId.replace(/[^a-z0-9]/gi, '')}-${id}-${version}.${ext}`;
      const path = posix.join(deps.imageFolder, filename);
      if (!await deps.exists(path) && !files.some((file) => file.path === path)) files.push({ path, bytes: downloaded.bytes });
      const caption = embed.caption.replace(/[\]|\r\n]/g, ' ').trim();
      replacement = `![[${path}${caption ? `|${caption}` : ''}]]`;
      bindings.push({ remote: embed.original, local: replacement });
    }
    markdown += restored.slice(previous, embed.start) + replacement;
    previous = embed.end;
  }
  const body = markdown + restored.slice(previous);
  const ranges = codeRanges(body);
  const readable = body.replace(/<mention-page id="([a-f\d]{32})">([\s\S]*?)<\/mention-page>/g,
    (match, id: string, label: string, offset: number) => {
      if (ranges.some((range) => offset >= range.start && offset < range.end)) return match;
      const title = label.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/[\[\]\r\n]/g, ' ');
      return `[${title}](https://www.notion.so/${id})`;
    });
  return { markdown: readable, files, bindings, origins };
}
