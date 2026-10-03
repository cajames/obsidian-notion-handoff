import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { notionClient, createPayload, markdownPayload, NOTION_VERSION, uploadFile } from '../src/notion';
import { MAX_UPLOAD_BYTES } from '../src/attachments';
import { requestUrl } from './helpers/obsidian';
import { jsonResponse } from './helpers/notion';

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.useRealTimers());

function respond(data: unknown, status = 200, headers = {}) {
  vi.mocked(requestUrl).mockResolvedValue(jsonResponse(data, status, headers));
}

function failure(status: number, code: string, headers = {}) {
  return jsonResponse({ object: 'error', status, code, message: `Notion HTTP ${status}` }, status, headers);
}

describe('Notion SDK via Obsidian requestUrl', () => {
  it('preserves page creation and full-page replacement payloads', async () => {
    respond({ id: 'created' });
    await notionClient('secret').pages.create(createPayload('parent', 'My note'));
    const request = vi.mocked(requestUrl).mock.calls[0][0] as any;
    expect(JSON.parse(request.body)).toEqual({ parent: { type: 'page_id', page_id: 'parent' },
      properties: { title: { type: 'title', title: [{ type: 'text', text: { content: 'My note' } }] } } });
    for (const body of ['', '# Title\n\nBody']) {
      await notionClient('secret').pages.updateMarkdown({ page_id: 'abc', ...markdownPayload(body) });
      expect(JSON.parse((vi.mocked(requestUrl).mock.calls.at(-1)![0] as any).body)).toEqual({ type: 'replace_content', replace_content: { new_str: body } });
    }
  });

  it('isolates profiles and explicitly versions every operation', async () => {
    respond({ markdown: '', truncated: false });
    const work = notionClient('work-token');
    const personal = notionClient('personal-token');
    await work.pages.retrieveMarkdown({ page_id: 'work' });
    await personal.pages.retrieveMarkdown({ page_id: 'personal' });
    await work.blocks.children.list({ block_id: 'work', page_size: 100, start_cursor: 'cursor +/=' });
    const requests = vi.mocked(requestUrl).mock.calls.map(([request]) => request as any);
    expect(requests.map((request) => request.headers.authorization)).toEqual(['Bearer work-token', 'Bearer personal-token', 'Bearer work-token']);
    expect(requests.every((request) => new Headers(request.headers).get('notion-version') === NOTION_VERSION && request.throw === false)).toBe(true);
    expect(new URL(requests[2].url).searchParams.get('start_cursor')).toBe('cursor +/=');
  });

  it('encodes multipart filenames, MIME and exact binary slices, then verifies status', async () => {
    vi.mocked(requestUrl)
      .mockResolvedValueOnce(jsonResponse({ id: 'upload', status: 'pending' }))
      .mockResolvedValueOnce(jsonResponse({ id: 'upload', status: 'uploaded' }))
      .mockResolvedValueOnce(jsonResponse({ id: 'upload', status: 'uploaded' }));
    const bytes = new Uint8Array([100, 0, 255, 13, 10, 101]).subarray(1, 5);
    const name = 'Résumé "draft"\n1.png';
    expect(await uploadFile(notionClient('work'), bytes, name, 'image/png')).toBe('upload');
    const requests = vi.mocked(requestUrl).mock.calls.map(([request]) => request as any);
    expect(JSON.parse(requests[0].body)).toEqual({ mode: 'single_part', filename: name, content_type: 'image/png' });
    expect(requests[1].headers['content-type']).toMatch(/^multipart\/form-data; boundary=/);
    expect(requests[1].body).toBeInstanceOf(ArrayBuffer);
    const form = await new Response(requests[1].body, { headers: { 'content-type': requests[1].headers['content-type'] } }).formData();
    const file = form.get('file') as File;
    expect(file.name).toBe(name);
    expect(new TextDecoder().decode(requests[1].body)).toContain('filename="Résumé %22draft%22%0A1.png"');
    expect(file.type).toBe('image/png');
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes);
    expect(requests.every((request) => request.headers.authorization === 'Bearer work')).toBe(true);
    expect(requests[2].url).toBe('https://api.notion.com/v1/file_uploads/upload');
  });

  it.each(['create', 'send', 'verify'])('stops on %s upload failure', async (stage) => {
    vi.mocked(requestUrl).mockResolvedValue(jsonResponse({ id: 'upload', status: 'uploaded' }));
    if (stage !== 'create') vi.mocked(requestUrl).mockResolvedValueOnce(jsonResponse({ id: 'upload', status: 'pending' }));
    if (stage === 'verify') vi.mocked(requestUrl).mockResolvedValueOnce(jsonResponse({ id: 'upload', status: 'uploaded' }));
    vi.mocked(requestUrl).mockResolvedValueOnce(failure(403, 'restricted_resource'));
    await expect(uploadFile(notionClient('work'), new Uint8Array([1]), 'x.png', 'image/png')).rejects.toThrow('403');
    expect(requestUrl).toHaveBeenCalledTimes(stage === 'create' ? 1 : stage === 'send' ? 2 : 3);
  });

  it('rejects pending, expired, mismatched, malformed uploads and oversized files', async () => {
    for (const result of [{ id: 'upload', status: 'pending' }, { id: 'upload', status: 'expired' }, { id: 'other', status: 'uploaded' }, {}]) {
      vi.mocked(requestUrl).mockResolvedValueOnce(jsonResponse({ id: 'upload', status: 'pending' })).mockResolvedValueOnce(jsonResponse(result));
      await expect(uploadFile(notionClient('work'), new Uint8Array([1]), 'x.png', 'image/png')).rejects.toThrow('confirm');
    }
    vi.clearAllMocks();
    await expect(uploadFile(notionClient('work'), new Uint8Array(MAX_UPLOAD_BYTES + 1), 'x.png', 'image/png')).rejects.toThrow('20 MiB');
    expect(requestUrl).not.toHaveBeenCalled();
  });

  it.each([401, 403, 404])('surfaces HTTP %s without retries', async (status) => {
    respond({ object: 'error', status, code: status === 401 ? 'unauthorized' : status === 403 ? 'restricted_resource' : 'object_not_found', message: `Permission error ${status}` }, status);
    await expect(notionClient('secret').pages.retrieveMarkdown({ page_id: 'page' })).rejects.toThrow(`Permission error ${status}`);
    expect(requestUrl).toHaveBeenCalledTimes(1);
  });

  it.each([429, 529])('respects Retry-After headers and bounds HTTP %s retries', async (status) => {
    vi.useFakeTimers();
    vi.mocked(requestUrl).mockResolvedValue(failure(status, status === 429 ? 'rate_limited' : 'service_overload', { 'Retry-After': '2' }));
    const operation = notionClient('secret').pages.create(createPayload('parent', 'Title'));
    const rejected = expect(operation).rejects.toThrow(`HTTP ${status}`);
    await vi.advanceTimersByTimeAsync(1999);
    expect(requestUrl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(requestUrl).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2000);
    await rejected;
    expect(requestUrl).toHaveBeenCalledTimes(3);
  });

  it('does not retry earlier than a long Retry-After or restricted API access', async () => {
    vi.mocked(requestUrl).mockResolvedValueOnce(failure(429, 'rate_limited', { 'retry-after': '120' }));
    await expect(notionClient('secret').pages.create(createPayload('parent', 'Title'))).rejects.toThrow('Retry after 120');
    respond({ object: 'error', status: 429, code: 'rate_limited', additional_data: { rate_limit_reason: 'public_api_request_blocked' } }, 429);
    await expect(notionClient('secret').pages.retrieveMarkdown({ page_id: 'page' })).rejects.toThrow('restricted');
    expect(requestUrl).toHaveBeenCalledTimes(2);
  });

  it('retries safe reads on 503 but never replays ambiguous creation or append writes', async () => {
    vi.useFakeTimers();
    vi.mocked(requestUrl).mockResolvedValueOnce(failure(503, 'service_unavailable', { 'retry-after': '1' })).mockResolvedValueOnce(jsonResponse({ markdown: 'Done' }));
    const read = notionClient('secret').pages.retrieveMarkdown({ page_id: 'page' });
    await vi.advanceTimersByTimeAsync(1000);
    await expect(read).resolves.toMatchObject({ markdown: 'Done' });
    vi.clearAllMocks();
    vi.mocked(requestUrl).mockResolvedValue(failure(503, 'service_unavailable'));
    const client = notionClient('secret');
    await expect(client.pages.create(createPayload('parent', 'Title'))).rejects.toThrow('503');
    await expect(client.blocks.children.append({ block_id: 'page', children: [{ paragraph: { rich_text: [] } }] })).rejects.toThrow('503');
    expect(requestUrl).toHaveBeenCalledTimes(2);
  });

  it('times out without retrying or processing a late response', async () => {
    vi.useFakeTimers();
    vi.mocked(requestUrl).mockImplementationOnce(() => new Promise(() => {}));
    const client = notionClient('secret', 100);
    const rejected = expect(client.pages.create(createPayload('parent', 'Title'))).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    await vi.advanceTimersByTimeAsync(100_000);
    expect(requestUrl).toHaveBeenCalledTimes(1);
  });

  it('rejects non-JSON successes and retains HTTP errors with non-JSON bodies', async () => {
    vi.mocked(requestUrl).mockResolvedValue({ ...jsonResponse({}), text: '<html>Unavailable</html>', status: 502 });
    await expect(notionClient('secret').pages.retrieveMarkdown({ page_id: 'page' })).rejects.toMatchObject({ status: 502 });
    vi.mocked(requestUrl).mockResolvedValue({ ...jsonResponse({}), text: 'not json' });
    await expect(notionClient('secret').pages.retrieveMarkdown({ page_id: 'page' })).rejects.toThrow();
    expect(requestUrl).toHaveBeenCalledTimes(2);
  });

  it('uses the upload ID, never a third-party upload_url with credentials', async () => {
    vi.mocked(requestUrl)
      .mockResolvedValueOnce(jsonResponse({ id: 'upload', status: 'pending', upload_url: 'https://example.com/steal-token' }))
      .mockResolvedValueOnce(jsonResponse({ id: 'upload', status: 'uploaded' }))
      .mockResolvedValueOnce(jsonResponse({ id: 'upload', status: 'uploaded' }));
    await uploadFile(notionClient('secret'), new Uint8Array([1]), 'x.png', 'image/png');
    expect(vi.mocked(requestUrl).mock.calls.every(([request]) => new URL((request as any).url).origin === 'https://api.notion.com')).toBe(true);
  });
});
