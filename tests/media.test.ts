import { describe, expect, it, vi } from 'vitest';
import { appendMediaArgs, appendMediaPayload, insertMedia, mediaBlock } from '../src/media';

const image = { marker: 'NTN_SYNC_MEDIA_one', label: 'photo.png', id: 'upload-1', kind: 'image', caption: 'A caption', name: 'photo.png' };
const file = { marker: 'NTN_SYNC_MEDIA_two', label: 'data.zip', id: 'upload-2', kind: 'file', caption: '', name: 'data.zip' };

describe('media blocks', () => {
  it('attaches uploaded IDs and captions using file_upload blocks', () => {
    expect(mediaBlock(image)).toEqual({
      object: 'block', type: 'image',
      image: { type: 'file_upload', file_upload: { id: 'upload-1' }, caption: [{ type: 'text', text: { content: 'A caption' } }] },
    });
    expect(mediaBlock(file).file).toMatchObject({ name: 'data.zip', file_upload: { id: 'upload-2' } });
    expect(appendMediaArgs('abc')).toEqual(['api', 'v1/blocks/abc/children', '-X', 'PATCH', '-d', '@-']);
    expect(appendMediaPayload('placeholder', image).position).toEqual({ type: 'after_block', after_block: { id: 'placeholder' } });
  });

  it('finds placeholders across pages, inserts blocks in place, then deletes placeholders', async () => {
    const run = vi.fn(async (args: string[], stdin?: string) => {
      if (args.includes('page_size==100')) return JSON.stringify(args.some((item) => item.startsWith('start_cursor=='))
        ? { results: [{ id: 'b2', type: 'paragraph', paragraph: { rich_text: [{ plain_text: file.marker }] } }], has_more: false }
        : { results: [{ id: 'b1', type: 'paragraph', paragraph: { rich_text: [{ plain_text: image.marker }] } }], has_more: true, next_cursor: 'next' });
      if (args.includes('PATCH')) expect(JSON.parse(stdin || '').position.after_block.id).toMatch(/^b[12]$/);
      return '{}';
    });
    expect(await insertMedia(run, 'page', [image, file])).toEqual([]);
    expect(run).toHaveBeenCalledTimes(6);
    expect(run.mock.calls.map(([args]) => args.includes('DELETE')).filter(Boolean)).toHaveLength(2);
  });

  it('warns without aborting when a placeholder is missing or the blocks API fails', async () => {
    const run = vi.fn(async (args: string[]) => {
      if (args.includes('page_size==100')) return JSON.stringify({ results: [{ id: 'b1', type: 'paragraph', paragraph: { rich_text: [{ plain_text: image.marker }] } }], has_more: false });
      throw new Error('ntn exited with code 403: Forbidden');
    });
    expect(await insertMedia(run, 'page', [image, file])).toEqual([
      expect.stringContaining('ntn exited with code 403'),
      expect.stringContaining('position not found'),
    ]);
  });
});
