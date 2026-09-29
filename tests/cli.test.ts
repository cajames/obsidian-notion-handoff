import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createArgs, createPayload, formatCliError, markdownArgs, missingCli, pushPage, runNtn, titleArgs } from '../cli';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

function fakeChild(code: number | null, stderr = '', spawnError = false) {
  const child = new EventEmitter();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const errors = new PassThrough();
  Object.assign(child, { stdin, stdout, stderr: errors });
  process.nextTick(() => {
    if (spawnError) child.emit('error', Object.assign(new Error('not found'), { code: 'ENOENT' }));
    errors.end(stderr);
    stdout.end('{"id":"created"}');
    child.emit('close', code);
  });
  return child;
}

describe('ntn requests', () => {
  beforeEach(() => vi.clearAllMocks());

  it('builds page creation and update arguments and payloads', () => {
    expect(createArgs()).toEqual(['api', 'v1/pages', '-X', 'POST', '-d', '@-']);
    expect(createPayload('parent', 'My note')).toEqual({
      parent: { type: 'page_id', page_id: 'parent' },
      properties: { title: { type: 'title', title: [{ type: 'text', text: { content: 'My note' } }] } },
    });
    expect(titleArgs('a/b')).toEqual(['api', 'v1/pages/a%2Fb', '-X', 'PATCH', '-d', '@-']);
    expect(markdownArgs('abc')).toEqual(['api', 'v1/pages/abc/markdown', '-X', 'PATCH', '-d', '@-']);
  });

  it('updates title then markdown sequentially, using JSON stdin', async () => {
    const calls: string[][] = [];
    const run = vi.fn(async (args: string[], stdin?: string) => {
      calls.push([args[1], stdin || '']);
      return '';
    });
    await pushPage(run, 'abc', 'Renamed', 'body');
    expect(calls[0][0]).toBe('v1/pages/abc');
    expect(JSON.parse(calls[0][1]).properties.title.title[0].text.content).toBe('Renamed');
    expect(calls[1]).toEqual(['v1/pages/abc/markdown', '{"markdown":"body"}']);
  });

  it('maps exit errors with stderr and code', async () => {
    vi.mocked(spawn).mockReturnValue(fakeChild(403, 'Access denied') as never);
    await expect(runNtn('ntn', 'secret', ['api'], '{}')).rejects.toThrow('ntn exited with code 403: Access denied');
    expect(formatCliError(1, '')).toContain('No error details provided');
  });

  it('passes token in environment, not arguments; no shell', async () => {
    vi.mocked(spawn).mockReturnValue(fakeChild(0) as never);
    await expect(runNtn('ntn', 'secret', ['--version'])).resolves.toContain('created');
    expect(spawn).toHaveBeenCalledWith('ntn', ['--version'], expect.objectContaining({
      env: expect.objectContaining({ NOTION_API_TOKEN: 'secret', NOTION_KEYRING: '0' }),
      stdio: ['pipe', 'pipe', 'pipe'],
    }));
  });

  it('maps missing binary to install instructions', async () => {
    vi.mocked(spawn).mockReturnValue(fakeChild(null, '', true) as never);
    await expect(runNtn('ntn', 'secret', ['--version'])).rejects.toThrow(missingCli);
  });
});
