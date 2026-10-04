// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import NotionHandoff from '../src/main';
import { createTestApp, installDomHelpers, Notice, requestUrl, TFile } from './helpers/obsidian';

const id = '12345678-1234-4234-8234-123456789abc';
const folder = '.obsidian/plugins/notion-handoff';

async function setup(source = `---\nnotion_id: ${id}\n---\nBody`) {
  const store = createTestApp(source);
  const plugin = new NotionHandoff(store.app as never, { id: 'notion-handoff', name: 'Notion Handoff', version: '0.1.0', minAppVersion: '1.5.0', author: 'Test', description: 'Test', dir: folder });
  await plugin.onload();
  const open = () => Reflect.get(plugin, 'openInNotion').call(plugin) as Promise<void>;
  return { ...store, plugin, open };
}

function saved(store: Awaited<ReturnType<typeof setup>>, pageId = id, workspaceId = 'workspace-default') {
  store.files.set(`${folder}/note-links.json`, JSON.stringify({ [store.note.path]: { notePath: store.note.path, workspaceName: 'Default', workspaceId, pageId } }));
}

beforeEach(() => {
  vi.clearAllMocks();
  installDomHelpers();
  Notice.messages = [];
  document.body.replaceChildren();
  vi.spyOn(window, 'open').mockReturnValue(null);
});
afterEach(() => vi.restoreAllMocks());

describe('Open in Notion command', () => {
  it('registers the command and opens the normalized official page URL without requests or edits', async () => {
    const source = `---\nnotion_id: ${id.toUpperCase()}\n---\nBody`;
    const store = await setup(source);
    expect(Reflect.get(store.plugin, 'commands')).toContainEqual(expect.objectContaining({ id: 'open-in-notion', name: 'Open in Notion' }));
    store.plugin.settings.profiles[0].token = '';
    await store.open();
    expect(window.open).toHaveBeenCalledExactlyOnceWith('https://www.notion.so/12345678123442348234123456789abc', '_blank', 'noopener,noreferrer');
    expect(requestUrl).not.toHaveBeenCalled();
    expect(store.writes).toEqual([]);
    expect(store.files.get(store.note.path)).toBe(source);
    expect(store.plugin.saveData).not.toHaveBeenCalled();
  });

  it('opens a persisted recovery link when page creation succeeded but frontmatter write-back failed', async () => {
    const store = await setup('Body');
    saved(store);
    await store.plugin.onload();
    await store.open();
    expect(window.open).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('12345678123442348234123456789abc'), '_blank', 'noopener,noreferrer');
    expect(store.files.get(store.note.path)).toBe('Body');
    expect(store.writes).toEqual([]);
  });

  it('explains how to link a note that has not been published', async () => {
    const store = await setup('Body');
    await store.open();
    expect(Notice.messages.at(-1)).toContain('Push this note first');
    expect(window.open).not.toHaveBeenCalled();
  });

  it.each(['https://evil.example/page', 'javascript:alert(1)', 'page-id'])('rejects invalid notion_id %j', async (value) => {
    const store = await setup(`---\nnotion_id: "${value}"\n---\nBody`);
    await store.open();
    expect(Notice.messages.at(-1)).toContain('valid Notion page ID');
    expect(window.open).not.toHaveBeenCalled();
    expect(requestUrl).not.toHaveBeenCalled();
  });

  it.each(['page', 'workspace'])('blocks a conflicting saved %s binding', async (kind) => {
    const store = await setup(`---\nnotion_id: ${id}\nnotion_workspace_id: workspace-default\n---\nBody`);
    saved(store, kind === 'page' ? 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' : id, kind === 'workspace' ? 'different-workspace' : 'workspace-default');
    await store.plugin.onload();
    await store.open();
    expect(Notice.messages.at(-1)).toContain('conflicts with its saved workspace/page binding');
    expect(window.open).not.toHaveBeenCalled();
    expect(store.writes).toEqual([]);
  });

  it('works independently of broken sync checkpoints', async () => {
    const store = await setup();
    store.files.set(`${folder}/sync-state.json`, '{broken');
    await store.plugin.onload();
    await store.open();
    expect(window.open).toHaveBeenCalledTimes(1);
    expect(store.writes).toEqual([]);
    expect(requestUrl).not.toHaveBeenCalled();
  });

  it('handles a non-Markdown active file', async () => {
    const store = await setup();
    store.app.workspace.getActiveFile.mockReturnValue(new TFile('image.png'));
    await store.open();
    expect(Notice.messages.at(-1)).toContain('Open a Markdown note first');
    expect(window.open).not.toHaveBeenCalled();
  });

  it('reports malformed frontmatter without opening a page', async () => {
    const store = await setup('---\nnotion_id: [invalid]\n---\nBody');
    await store.open();
    expect(Notice.messages.at(-1)).toContain('notion_id must be a string');
    expect(window.open).not.toHaveBeenCalled();
  });
});
