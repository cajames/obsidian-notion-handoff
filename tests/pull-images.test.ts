import { describe, expect, it, vi } from 'vitest';
import { readRemote, mediaToken, canonicalReferences } from '../src/sync-remote';
import { prepareRemote } from '../src/pull-images';
import { makeCheckpoint } from '../src/sync';
import { MAX_UPLOAD_BYTES } from '../src/attachments';

const pageId = '01234567-89ab-cdef-0123-456789abcdef';
const image = { id: 'image-id', kind: 'image', url: 'https://prod-files.s3.us-west-2.amazonaws.com/file.png?signature=one', version: 'v1' };
const block = { id: image.id, type: 'image', last_edited_time: image.version, image: { file: { url: image.url } } };

function api(markdown = `Before\n\n![Caption](${image.url})\n\nAfter`, blocks = [block]) {
  return vi.fn(async (args: string[]) => JSON.stringify(args[1].endsWith('/markdown')
    ? { markdown, truncated: false, unknown_block_ids: [] }
    : { results: blocks, has_more: false }));
}

function downloads() {
  return { download: vi.fn(async () => ({ bytes: new Uint8Array([137, 80, 78, 71]), mime: 'image/png' })), exists: vi.fn(async () => false) };
}

describe('Notion read and image import', () => {
  it('reads Markdown and nested paginated blocks with GET-only requests', async () => {
    const run = vi.fn(async (args: string[]) => {
      if (args[1].endsWith('/markdown')) return JSON.stringify({ markdown: `![Caption](${image.url})`, truncated: false });
      if (args[1].includes('/nested/')) return JSON.stringify({ results: [block], has_more: false });
      if (args.some((arg) => arg.startsWith('start_cursor'))) return JSON.stringify({ results: [], has_more: false });
      return JSON.stringify({ results: [{ id: 'nested', type: 'bulleted_list_item', has_children: true }], has_more: true, next_cursor: 'cursor' });
    });
    const remote = await readRemote(run, pageId);
    expect(remote.markdown).toBe(`![Caption](${mediaToken(image)})`);
    expect(remote.media).toHaveLength(1);
    expect(run.mock.calls.some(([args]) => args.includes('start_cursor==cursor'))).toBe(true);
    expect(run.mock.calls.every(([args]) => !args.includes('PATCH') && !args.includes('POST'))).toBe(true);
  });

  it('stages a new image as a vault embed without writing anything during preparation', async () => {
    const remote = await readRemote(api(), pageId);
    const helpers = downloads();
    const result = await prepareRemote(remote, pageId, null, helpers);
    expect(helpers.download).toHaveBeenCalledExactlyOnceWith(image.url);
    expect(result.files).toHaveLength(1);
    expect(result.files[0].path).toMatch(/^notion-sync-assets\/0123456789abcdef0123456789abcdef\/imageid-[a-f0-9]+\.png$/);
    expect(result.markdown).toContain(`![[${result.files[0].path}|Caption]]`);
    expect(result.bindings).toEqual([{ remote: `![Caption](${mediaToken(image)})`, local: `![[${result.files[0].path}|Caption]]` }]);
  });

  it('ignores signed URL rotation but notices actual asset changes', async () => {
    const first = await readRemote(api(), pageId);
    const rotated = image.url.replace('one', 'two');
    const second = await readRemote(api(`Before\n\n![Caption](${rotated})\n\nAfter`), pageId);
    expect(second.fingerprint).toBe(first.fingerprint);
    const changedBlock = { ...block, last_edited_time: 'v2' };
    const third = await readRemote(api(undefined, [changedBlock]), pageId);
    expect(third.fingerprint).not.toBe(first.fingerprint);
  });

  it('preserves known drawing embeds instead of replacing them with imported PNGs', async () => {
    const remote = await readRemote(api(), pageId);
    const helpers = downloads();
    const checkpoint = makeCheckpoint('Local', 'Remote', remote.fingerprint, [{ remote: `![Caption](${mediaToken(image)})`, local: '![[Drawings/plan.tldr|Sketch]]' }]);
    const result = await prepareRemote(remote, pageId, checkpoint, helpers);
    expect(result.markdown).toContain('![[Drawings/plan.tldr|Sketch]]');
    expect(result.files).toEqual([]);
    expect(helpers.download).not.toHaveBeenCalled();
  });

  it('preserves known external image syntax and turns unknown page mentions into usable links', async () => {
    const remote = await readRemote(api(), pageId);
    const helpers = downloads();
    const original = `![Caption](${image.url})`;
    const checkpoint = makeCheckpoint(original, original, remote.fingerprint, [{ remote: `![Caption](${mediaToken(image)})`, local: original }]);
    expect((await prepareRemote(remote, pageId, checkpoint, helpers)).markdown).toContain(original);
    expect(helpers.download).not.toHaveBeenCalled();
    const mention = `<mention-page id="${pageId.replace(/-/g, '')}">New page</mention-page>`;
    const result = await prepareRemote({ markdown: mention, media: [], fingerprint: 'hash' }, pageId, null, helpers);
    expect(result.markdown).toBe(`[New page](https://www.notion.so/${pageId.replace(/-/g, '')})`);
  });

  it('keeps new non-image files as stable Notion links rather than expiring signed URLs', async () => {
    const token = mediaToken(image);
    const remote = { markdown: `<pdf src="${token}">Manual</pdf>`, media: [{ ...image, kind: 'pdf', token }], fingerprint: 'hash' };
    const result = await prepareRemote(remote, pageId, null, downloads());
    expect(result.markdown).toBe(`[Notion pdf](https://www.notion.so/${pageId.replace(/-/g, '')}#imageid)`);
    expect(result.files).toEqual([]);
  });

  it('does not overwrite existing imported images and skips code examples', async () => {
    const remote = await readRemote(api(`\`![Example](https://example.com/example.png)\`\n\n![Caption](${image.url})`), pageId);
    const helpers = downloads();
    helpers.exists.mockResolvedValue(true);
    const result = await prepareRemote(remote, pageId, null, helpers);
    expect(result.files).toEqual([]);
    expect(result.markdown).toContain('`![Example](https://example.com/example.png)`');
    expect(helpers.download).toHaveBeenCalledTimes(1);
  });

  it('refuses truncated, unknown, or invalid content rather than silently losing data', async () => {
    for (const response of [{ markdown: 'Partial', truncated: true }, { markdown: 'Partial', unknown_block_ids: ['unknown'] }, { markdown: null }]) {
      await expect(readRemote(async () => JSON.stringify(response), pageId)).rejects.toThrow();
    }
  });

  it('refuses broken downloads, oversized files, non-images, and non-HTTPS URLs', async () => {
    const remote = await readRemote(api(), pageId);
    const broken = downloads();
    broken.download.mockRejectedValueOnce(new Error('Download failed'));
    await expect(prepareRemote(remote, pageId, null, broken)).rejects.toThrow('Download failed');
    const large = downloads();
    large.download.mockResolvedValueOnce({ bytes: new Uint8Array(MAX_UPLOAD_BYTES + 1), mime: 'image/png' });
    await expect(prepareRemote(remote, pageId, null, large)).rejects.toThrow('20 MiB');
    const invalid = downloads();
    invalid.download.mockResolvedValueOnce({ bytes: new Uint8Array([1]), mime: 'text/html' });
    await expect(prepareRemote(remote, pageId, null, invalid)).rejects.toThrow('supported image');
    await expect(prepareRemote({ markdown: '![Image](http://example.com/file.png)', media: [], fingerprint: 'hash' }, pageId, null, downloads())).rejects.toThrow('HTTPS');
  });

  it('canonicalizes page mentions while leaving code examples untouched', () => {
    const mention = `<mention-page url="https://www.notion.so/${pageId.replace(/-/g, '')}">Note</mention-page>`;
    expect(canonicalReferences(`${mention} \`${mention}\``)).toBe(`<mention-page id="${pageId.replace(/-/g, '')}">Note</mention-page> \`${mention}\``);
  });
});
