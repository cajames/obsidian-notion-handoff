import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mentionsImported, pushMarkdownWithMentions } from '../src/mention-push';
import { api, jsonResponse, testClient } from './helpers/notion';
import { requestUrl } from './helpers/obsidian';

const id = '01234567-89ab-cdef-0123-456789abcdef';
const reference = { token: 'NTN_SYNC_NOTE_abc_0', id, label: 'Meeting', pending: 'Meeting (link pending)',
  mention: `<mention-page url="https://www.notion.so/${id.replace(/-/g, '')}">Meeting</mention-page>` };
beforeEach(() => vi.clearAllMocks());

describe('mention import and fallback', () => {
  it('confirms imported mentions via markdown readback', async () => {
    const client = testClient();
    api.mockImplementation(async ({ method }) => method === 'PATCH' ? {} : { markdown: reference.mention, truncated: false, unknown_block_ids: [] });
    expect(await pushMarkdownWithMentions(client, 'page', `See ${reference.token}`, [reference])).toEqual([]);
    expect(api).toHaveBeenCalledTimes(2);
    expect(mentionsImported({ markdown: reference.mention }, [reference])).toBe(true);
  });

  it('retries with pending text when PATCH rejects the mention validation', async () => {
    const client = testClient();
    vi.mocked(requestUrl).mockResolvedValueOnce(jsonResponse({ object: 'error', code: 'validation_error', message: 'invalid mention' }, 400));
    api.mockResolvedValue({});
    expect(await pushMarkdownWithMentions(client, 'page', reference.token, [reference])).toEqual(['Meeting']);
    const bodies = vi.mocked(requestUrl).mock.calls.map(([request]) => JSON.parse((request as any).body));
    expect(bodies).toEqual([
      { type: 'replace_content', replace_content: { new_str: reference.mention } },
      { type: 'replace_content', replace_content: { new_str: reference.pending } },
    ]);
  });

  it('demotes mentions if PATCH succeeds but GET shows mangled markup', async () => {
    const client = testClient();
    api.mockImplementation(async ({ method }) => method === 'PATCH' ? {} : { markdown: 'Meeting', truncated: false, unknown_block_ids: [] });
    expect(await pushMarkdownWithMentions(client, 'page', reference.token, [reference])).toEqual(['Meeting']);
    expect(api.mock.calls.filter(([request]) => request.method === 'PATCH').map(([request]) => request.body.replace_content.new_str)).toEqual([reference.mention, reference.pending]);
    expect(mentionsImported({ markdown: reference.mention, truncated: true }, [reference])).toBe(false);
  });

  it('replaces Markdown without references using the required command type', async () => {
    const client = testClient();
    api.mockResolvedValue({});
    expect(await pushMarkdownWithMentions(client, 'page', '# Title\n\nBody', [])).toEqual([]);
    expect(api).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ method: 'PATCH', path: '/v1/pages/page/markdown', body: { type: 'replace_content', replace_content: { new_str: '# Title\n\nBody' } } }));
  });

  it.each([403, 503])('never demotes or replays on HTTP %s, even with references', async (status) => {
    const client = testClient();
    vi.mocked(requestUrl).mockResolvedValue(jsonResponse({ object: 'error', code: status === 403 ? 'restricted_resource' : 'service_unavailable', message: `HTTP ${status}` }, status));
    await expect(pushMarkdownWithMentions(client, 'page', reference.token, [reference])).rejects.toThrow(`${status}`);
    expect(requestUrl).toHaveBeenCalledTimes(1);
  });

  it.each([{ markdown: 'Partial', truncated: true }, { markdown: 'Partial', unknown_block_ids: ['unknown'] }, {}])('rejects incomplete readback without another write: %j', async (data) => {
    const client = testClient();
    api.mockImplementation(async ({ method }) => method === 'PATCH' ? {} : data);
    await expect(pushMarkdownWithMentions(client, 'page', reference.token, [reference])).rejects.toThrow('incomplete');
    expect(api).toHaveBeenCalledTimes(2);
  });

  it('propagates unrelated errors when no references exist', async () => {
    const client = testClient();
    api.mockRejectedValue(new Error('HTTP 403'));
    await expect(pushMarkdownWithMentions(client, 'page', 'body', [])).rejects.toThrow('403');
  });
});
