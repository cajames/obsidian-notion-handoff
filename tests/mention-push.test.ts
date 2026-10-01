import { describe, expect, it, vi } from 'vitest';
import { mentionsImported, pushMarkdownWithMentions } from '../mention-push';

const id = '01234567-89ab-cdef-0123-456789abcdef';
const reference = { token: 'NTN_SYNC_NOTE_abc_0', id, label: 'Meeting', pending: 'Meeting (link pending)',
  mention: `<mention-page url="https://www.notion.so/${id.replace(/-/g, '')}">Meeting</mention-page>` };

describe('mention import and fallback', () => {
  it('confirms imported mentions via markdown readback', async () => {
    const run = vi.fn(async (args: string[]) => args.includes('PATCH') ? '{}' : JSON.stringify({ markdown: reference.mention, truncated: false }));
    expect(await pushMarkdownWithMentions(run, 'page', `See ${reference.token}`, [reference])).toEqual([]);
    expect(run).toHaveBeenCalledTimes(2);
    expect(mentionsImported(JSON.stringify({ markdown: reference.mention }), [reference])).toBe(true);
  });

  it('retries with pending text when the PATCH rejects the mention', async () => {
    let patches = 0;
    const run = vi.fn(async (args: string[], stdin?: string) => {
      if (args.includes('PATCH') && ++patches === 1) throw new Error('ntn exited with code 400: invalid mention');
      return '{}';
    });
    expect(await pushMarkdownWithMentions(run, 'page', reference.token, [reference])).toEqual(['Meeting']);
    expect(JSON.parse(run.mock.calls[1][1] || '').markdown).toBe('Meeting (link pending)');
    expect(run.mock.calls).toHaveLength(2);
  });

  it('demotes mentions if PATCH succeeds but GET shows mangled or truncated markup', async () => {
    const bodies: string[] = [];
    const run = vi.fn(async (args: string[], stdin?: string) => {
      if (args.includes('PATCH')) { bodies.push(JSON.parse(stdin || '').markdown); return '{}'; }
      return JSON.stringify({ markdown: 'Meeting', truncated: false });
    });
    expect(await pushMarkdownWithMentions(run, 'page', reference.token, [reference])).toEqual(['Meeting']);
    expect(bodies).toEqual([reference.mention, reference.pending]);
    expect(mentionsImported(JSON.stringify({ markdown: reference.mention, truncated: true }), [reference])).toBe(false);
  });

  it('propagates unrelated errors when no references exist', async () => {
    await expect(pushMarkdownWithMentions(async () => { throw new Error('ntn exited with code 403'); }, 'page', 'body', []))
      .rejects.toThrow('code 403');
  });
});
