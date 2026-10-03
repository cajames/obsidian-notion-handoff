import { beforeEach, describe, expect, it, vi } from 'vitest';
import { appendMediaPayload, insertMedia, mediaBlock } from '../src/media';
import { api, testClient } from './helpers/notion';

const image = { marker: 'NTN_SYNC_MEDIA_one', label: 'photo.png', id: 'upload-1', kind: 'image', caption: 'A caption', name: 'photo.png' };
const file = { marker: 'NTN_SYNC_MEDIA_two', label: 'data.zip', id: 'upload-2', kind: 'file', caption: '', name: 'data.zip' };
beforeEach(() => vi.clearAllMocks());

describe('media blocks', () => {
  it('attaches uploaded IDs and captions using file_upload blocks', () => {
    expect(mediaBlock(image)).toEqual({ image: { type: 'file_upload', file_upload: { id: 'upload-1' }, caption: [{ type: 'text', text: { content: 'A caption' } }] } });
    expect(mediaBlock(file).file).toMatchObject({ name: 'data.zip', file_upload: { id: 'upload-2' } });
    expect(appendMediaPayload('placeholder', image).position).toEqual({ type: 'after_block', after_block: { id: 'placeholder' } });
  });

  it('finds placeholders across pages, inserts blocks in place, then deletes placeholders', async () => {
    const client = testClient();
    api.mockImplementation(async ({ method, path, body }) => {
      if (method === 'GET') return path.includes('start_cursor=')
        ? { results: [{ id: 'b2', type: 'paragraph', paragraph: { rich_text: [{ plain_text: file.marker }] } }], has_more: false }
        : { results: [{ id: 'b1', type: 'paragraph', paragraph: { rich_text: [{ plain_text: image.marker }] } }], has_more: true, next_cursor: 'next' };
      if (method === 'PATCH') expect(body.position.after_block.id).toMatch(/^b[12]$/);
      return { results: [{ id: 'inserted' }] };
    });
    expect(await insertMedia(client, 'page', [image, file])).toEqual([]);
    expect(api).toHaveBeenCalledTimes(6);
    expect(api.mock.calls.filter(([request]) => request.method === 'DELETE')).toHaveLength(2);
  });

  it('records inserted block IDs for restoring local embeds on pull', async () => {
    const client = testClient();
    api.mockImplementation(async ({ method }) => method === 'GET'
      ? { results: [{ id: 'placeholder', type: 'paragraph', paragraph: { rich_text: [{ plain_text: image.marker }] } }], has_more: false }
      : { results: [{ id: 'image-block-id' }] });
    const inserted = vi.fn();
    expect(await insertMedia(client, 'page', [image], inserted)).toEqual([]);
    expect(inserted).toHaveBeenCalledExactlyOnceWith(image, 'image-block-id');
  });

  it('warns without aborting when a placeholder is missing or the blocks API fails', async () => {
    const client = testClient();
    api.mockImplementation(async ({ method }) => {
      if (method === 'GET') return { results: [{ id: 'b1', type: 'paragraph', paragraph: { rich_text: [{ plain_text: image.marker }] } }], has_more: false };
      throw new Error('Forbidden HTTP 403');
    });
    expect(await insertMedia(client, 'page', [image, file])).toEqual([expect.stringContaining('HTTP 403'), expect.stringContaining('position not found')]);
  });

  it.each([{ has_more: true }, { has_more: true, next_cursor: '' }, {}, { has_more: true, next_cursor: 'same' }])('rejects incomplete/repeating pagination before inserting media: %j', async (pagination) => {
    const client = testClient();
    api.mockResolvedValue({ results: [], ...pagination });
    expect(await insertMedia(client, 'page', [image])).toEqual([expect.stringContaining('cannot locate position')]);
    expect(api.mock.calls.every(([request]) => request.method === 'GET')).toBe(true);
    expect(api.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it('keeps the placeholder when append does not confirm an inserted block', async () => {
    const client = testClient();
    api.mockImplementation(async ({ method }) => method === 'GET'
      ? { results: [{ id: 'placeholder', type: 'paragraph', paragraph: { rich_text: [{ plain_text: image.marker }] } }], has_more: false }
      : { results: [] });
    expect(await insertMedia(client, 'page', [image])).toEqual([expect.stringContaining('inserted media block ID')]);
    expect(api.mock.calls.some(([request]) => request.method === 'DELETE')).toBe(false);
  });
});
