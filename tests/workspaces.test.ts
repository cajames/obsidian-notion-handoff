// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import NotionHandoff from '../src/main';
import { parseNote, writeNotionBinding } from '../src/note';
import { createTestApp, installDomHelpers, Modal, Notice, requestUrl, TFile } from './helpers/obsidian';
import { api, mockNotion, workspace } from './helpers/notion';

const linksPath = '.obsidian/plugins/notion-handoff/note-links.json';
const profiles = [
  { name: 'First', token: 'token-one', parentId: 'parent-one' },
  { name: 'Second', token: 'token-two', parentId: 'parent-two' },
];

async function setup(source = 'Body', configured = profiles) {
  const store = createTestApp(source);
  const plugin = new NotionHandoff(store.app as never, { id: 'notion-handoff', name: 'Notion Handoff', version: '0.1.0', minAppVersion: '1.5.0', author: 'Test', description: 'Test', dir: '.obsidian/plugins/notion-handoff' });
  vi.mocked(plugin.loadData).mockResolvedValue({ profiles: configured.map((profile) => ({ ...profile })), binary: 'ntn' });
  await plugin.onload();
  return { ...store, plugin };
}

function command(plugin: NotionHandoff, operation = 'pushCurrentNote') {
  return Reflect.get(plugin, operation).call(plugin) as Promise<void>;
}

function choose(name: string) {
  const picker = Modal.opened.at(-1)!;
  const select = picker.contentEl.querySelector('select')!;
  select.value = name;
  select.dispatchEvent(new Event('change'));
  Array.from(picker.contentEl.querySelectorAll('button')).find((button) => button.textContent === 'Use workspace')!.click();
}

beforeEach(() => {
  vi.clearAllMocks();
  installDomHelpers();
  Modal.opened = [];
  Notice.messages = [];
  document.body.replaceChildren();
  mockNotion();
  workspace.mockImplementation(async (token) => ({ type: 'bot', bot: { workspace_id: token === 'token-one' ? 'workspace-one' : 'workspace-two' } }));
  let remote = '';
  api.mockImplementation(async ({ path, method, body }) => {
    if (path === '/v1/pages' && method === 'POST') return { id: 'created-page' };
    if (path.includes('/markdown')) {
      if (method === 'PATCH') remote = body.replace_content.new_str;
      return { markdown: remote, truncated: false, unknown_block_ids: [] };
    }
    return { results: [], has_more: false };
  });
});

describe('workspace selection and durable note identity', () => {
  it('requires a picker for multiple workspaces, then saves the actual identity before uploading content', async () => {
    const store = await setup();
    const run = api.getMockImplementation()!;
    api.mockImplementation(async (request) => {
      if (request.path.includes('/markdown') && request.method === 'PATCH') {
        expect(parseNote(store.files.get(store.note.path)!)).toMatchObject({ notionWorkspace: 'Second', notionWorkspaceId: 'workspace-two', notionId: 'created-page' });
        expect(JSON.parse(store.files.get(linksPath)!)[store.note.path]).toEqual({ notePath: store.note.path, workspaceName: 'Second', workspaceId: 'workspace-two', pageId: 'created-page' });
      }
      return run(request);
    });
    const push = command(store.plugin);
    await vi.waitFor(() => expect(Modal.opened).toHaveLength(1));
    const picker = Modal.opened[0];
    expect(picker.modalEl.classList.contains('notion-handoff-workspace-picker')).toBe(true);
    expect(picker.contentEl.querySelector('select')!.value).toBe('First');
    expect(Array.from(picker.contentEl.querySelectorAll('button')).find((button) => button.textContent === 'Use workspace')!.disabled).toBe(false);
    expect(requestUrl).not.toHaveBeenCalled();
    choose('Second');
    await push;
    expect(workspace).toHaveBeenCalledExactlyOnceWith('token-two');
    expect(api.mock.calls.every(([request]) => request.token === 'token-two')).toBe(true);
    expect(api.mock.calls.find(([request]) => request.path === '/v1/pages')![0].body.parent.page_id).toBe('parent-two');
    expect(store.plugin.saveData).not.toHaveBeenCalled();
    const linked = store.files.get(store.note.path)!;
    store.plugin.settings.profiles.reverse();
    vi.mocked(store.plugin.loadData).mockResolvedValue({ profiles: store.plugin.settings.profiles, binary: 'ntn' });
    await store.plugin.onload();
    await command(store.plugin);
    expect(Modal.opened).toHaveLength(1);
    expect(store.files.get(store.note.path)).toBe(linked);
    expect(api.mock.calls.filter(([request]) => request.path === '/v1/pages')).toHaveLength(1);
    expect(api.mock.calls.every(([request]) => request.token === 'token-two')).toBe(true);
  });

  it('preselects the first workspace but does not sync until explicitly confirmed', async () => {
    const store = await setup('Body', [...profiles].reverse());
    const push = command(store.plugin);
    await vi.waitFor(() => expect(Modal.opened).toHaveLength(1));
    const picker = Modal.opened[0];
    expect(picker.contentEl.querySelector('select')!.value).toBe('Second');
    expect(requestUrl).not.toHaveBeenCalled();
    expect(store.writes).toEqual([]);
    Array.from(picker.contentEl.querySelectorAll('button')).find((button) => button.textContent === 'Use workspace')!.click();
    await push;
    expect(workspace).toHaveBeenCalledExactlyOnceWith('token-two');
    expect(parseNote(store.files.get(store.note.path)!).notionWorkspace).toBe('Second');
  });

  it.each(['pushCurrentNote', 'pullCurrentNote'])('cancels the %s workspace picker without reads or writes', async (operation) => {
    const source = '---\nnotion_id: page-id\n---\nBody';
    const store = await setup(source);
    const sync = command(store.plugin, operation);
    await vi.waitFor(() => expect(Modal.opened).toHaveLength(1));
    Modal.opened[0].close();
    await sync;
    expect(requestUrl).not.toHaveBeenCalled();
    expect(store.writes).toEqual([]);
    expect(store.files.get(store.note.path)).toBe(source);
  });

  it('saves a selected workspace only after pull review is confirmed, with a backup', async () => {
    const source = '---\nnotion_id: page-id\n---\nLocal';
    const store = await setup(source);
    const pull = command(store.plugin, 'pullCurrentNote');
    await vi.waitFor(() => expect(Modal.opened).toHaveLength(1));
    choose('Second');
    await vi.waitFor(() => expect(Modal.opened).toHaveLength(2));
    expect(store.files.get(store.note.path)).toBe(source);
    expect(store.writes).toEqual([]);
    const modal = Modal.opened[1];
    Array.from(modal.contentEl.querySelectorAll('button')).find((button) => button.textContent === 'Keep all Obsidian')!.click();
    Array.from(modal.contentEl.querySelectorAll('button')).find((button) => button.textContent === 'Save merged note')!.click();
    await pull;
    expect(parseNote(store.files.get(store.note.path)!)).toMatchObject({ body: 'Local', notionWorkspace: 'Second', notionWorkspaceId: 'workspace-two', notionId: 'page-id' });
    expect(JSON.parse(store.files.get(linksPath)!)[store.note.path]).toMatchObject({ workspaceId: 'workspace-two', pageId: 'page-id' });
    const backup = Array.from(store.files.keys()).find((path) => path.includes('/backups/'))!;
    expect(store.files.get(backup)).toBe(source);
    expect(api.mock.calls.every(([request]) => request.method === 'GET')).toBe(true);
  });

  it('auto-selects and pins the only workspace without opening a picker', async () => {
    const store = await setup('Body', [profiles[1]]);
    await command(store.plugin);
    expect(Modal.opened).toEqual([]);
    expect(parseNote(store.files.get(store.note.path)!)).toMatchObject({ notionWorkspace: 'Second', notionWorkspaceId: 'workspace-two', notionId: 'created-page' });
    expect(JSON.parse(store.files.get(linksPath)!)[store.note.path].workspaceId).toBe('workspace-two');
  });

  it.each(['pushCurrentNote', 'pullCurrentNote'])('blocks mismatched token identity before %s touches page or attachment content', async (operation) => {
    const source = writeNotionBinding('![[photo.png]]', 'First', 'workspace-two', 'page-id');
    const store = await setup(source);
    store.files.set('photo.png', 'Image');
    await command(store.plugin, operation);
    expect(Notice.messages.at(-1)).toContain('different Notion workspace');
    expect(api).not.toHaveBeenCalled();
    expect(store.writes).toEqual([]);
    expect(store.files.get(store.note.path)).toBe(source);
  });

  it('never rebinds a pinned note when a user picks a different workspace', async () => {
    const source = '---\nnotion_id: page-id\nnotion_workspace_id: workspace-one\n---\nBody';
    const store = await setup(source);
    const sync = command(store.plugin);
    await vi.waitFor(() => expect(Modal.opened).toHaveLength(1));
    choose('Second');
    await sync;
    expect(Notice.messages.at(-1)).toContain('different Notion workspace');
    expect(api).not.toHaveBeenCalled();
    expect(store.writes).toEqual([]);
    expect(store.files.get(store.note.path)).toBe(source);
  });

  it.each([
    ['title: "Client proposal"', 'Client proposal'],
    ['title: "  Client proposal  "', 'Client proposal'],
    ['title: >-\n  Client proposal', 'Client proposal'],
    ['title: ""', 'Test'],
    ['title: "   "', 'Test'],
    ['title: null', 'Test'],
    ['title: 123', 'Test'],
    ['title: [one, two]', 'Test'],
    ['', 'Test'],
  ])('uses %j to set a new page title to %j', async (frontmatter, expected) => {
    const source = frontmatter ? `---\n${frontmatter}\n---\nBody` : 'Body';
    const store = await setup(source, [profiles[0]]);
    await command(store.plugin);
    const creation = api.mock.calls.find(([request]) => request.path === '/v1/pages')![0];
    expect(creation.body.properties.title.title[0].text.content).toBe(expected);
    expect(api.mock.calls.filter(([request]) => request.path.endsWith('/markdown') && request.method === 'PATCH')[0][0].body.replace_content.new_str).toBe('Body');
    expect(parseNote(store.files.get(store.note.path)!).body).toBe('Body');
  });

  it('preserves Notion’s title after creation despite local title, filename and content changes', async () => {
    let notionTitle = '';
    const run = api.getMockImplementation()!;
    api.mockImplementation(async (request) => {
      if (request.path === '/v1/pages' && request.method === 'POST') notionTitle = request.body.properties.title.title[0].text.content;
      if (request.path === '/v1/pages/created-page' && request.method === 'PATCH') notionTitle = request.body.properties.title.title[0].text.content;
      return run(request);
    });
    const store = await setup('---\ntitle: Original local title\n---\nBody', [profiles[0]]);
    await command(store.plugin);
    expect(notionTitle).toBe('Original local title');
    notionTitle = 'Edited in Notion';
    const renamed = new TFile('Notes/Renamed.md');
    const updated = store.files.get(store.note.path)!.replace('title: Original local title', 'title: Changed local title').replace('\nBody', '\nUpdated body');
    store.files.set(renamed.path, updated);
    store.files.delete(store.note.path);
    store.app.workspace.getActiveFile.mockReturnValue(renamed);
    await command(store.plugin);
    expect(notionTitle).toBe('Edited in Notion');
    expect(api.mock.calls.filter(([request]) => request.path === '/v1/pages')).toHaveLength(1);
    expect(api.mock.calls.filter(([request]) => request.path === '/v1/pages/created-page' && request.method === 'PATCH')).toEqual([]);
    expect(api.mock.calls.filter(([request]) => request.path.endsWith('/markdown') && request.method === 'PATCH').at(-1)![0].body.replace_content.new_str).toBe('Updated body');
    await command(store.plugin, 'pullCurrentNote');
    expect(store.files.get(renamed.path)).toBe(updated);
    expect(renamed.basename).toBe('Renamed');
    expect(parseNote(store.files.get(renamed.path)!).title).toBe('Changed local title');
    expect(notionTitle).toBe('Edited in Notion');
  });

  it('leaves an existing page’s title alone even on the first push to that page', async () => {
    const store = await setup('---\ntitle: Local title\nnotion_workspace: First\nnotion_id: existing-page\n---\nBody');
    await command(store.plugin);
    expect(api.mock.calls.filter(([request]) => request.path === '/v1/pages')).toEqual([]);
    expect(api.mock.calls.filter(([request]) => request.path === '/v1/pages/existing-page' && request.method === 'PATCH')).toEqual([]);
    expect(api.mock.calls.some(([request]) => request.path === '/v1/pages/existing-page/markdown' && request.method === 'PATCH')).toBe(true);
  });

  it('uses the durable mapping to catch removed or manually changed identity fields', async () => {
    const store = await setup('Body', [profiles[0]]);
    await command(store.plugin);
    const linked = store.files.get(store.note.path)!;
    store.plugin.settings.profiles = profiles.map((profile) => ({ ...profile }));
    store.files.set(store.note.path, linked.replace('notion_workspace: "First"', 'notion_workspace: "Second"').replace('notion_workspace_id: "workspace-one"\n', ''));
    api.mockClear();
    const before = store.files.get(store.note.path);
    const writes = store.writes.length;
    await command(store.plugin);
    expect(Notice.messages.at(-1)).toContain('saved workspace/page binding');
    expect(api).not.toHaveBeenCalled();
    expect(store.writes).toHaveLength(writes);
    expect(store.files.get(store.note.path)).toBe(before);
  });

  it('fails closed when Notion omits the workspace identity', async () => {
    workspace.mockResolvedValue({ type: 'bot', bot: { workspace_id: '' } });
    const store = await setup('Body', [profiles[0]]);
    await command(store.plugin);
    expect(Notice.messages.at(-1)).toContain('did not return a workspace ID');
    expect(api).not.toHaveBeenCalled();
    expect(store.writes).toEqual([]);
  });

  it('retains the created binding when concurrent edits arrive during page creation', async () => {
    const store = await setup('Original', [profiles[0]]);
    const run = api.getMockImplementation()!;
    api.mockImplementation(async (request) => {
      if (request.path === '/v1/pages' && request.method === 'POST') store.files.set(store.note.path, 'Edited while creating');
      return run(request);
    });
    await command(store.plugin);
    expect(parseNote(store.files.get(store.note.path)!)).toMatchObject({ body: 'Edited while creating', notionWorkspaceId: 'workspace-one', notionId: 'created-page' });
    expect(Notice.messages.at(-1)).toContain('note changed during page creation');
    expect(api.mock.calls.filter(([request]) => request.method === 'PATCH')).toEqual([]);
    await command(store.plugin);
    expect(api.mock.calls.filter(([request]) => request.path === '/v1/pages')).toHaveLength(1);
    expect(api.mock.calls.find(([request]) => request.path.includes('/markdown') && request.method === 'PATCH')![0].body.replace_content.new_str).toBe('Edited while creating');
  });

  it('stores a recovery mapping if a created page cannot be written back to the note', async () => {
    const store = await setup('Body', [profiles[0]]);
    store.app.vault.process.mockRejectedValueOnce(new Error('Read-only note'));
    await command(store.plugin);
    expect(store.files.get(store.note.path)).toBe('Body');
    expect(JSON.parse(store.files.get(linksPath)!)[store.note.path]).toMatchObject({ workspaceId: 'workspace-one', pageId: 'created-page' });
    expect(Notice.messages.at(-1)).toContain('Page created-page was created');
    await command(store.plugin);
    expect(Notice.messages.at(-1)).toContain('Restore its original workspace and page IDs');
    expect(api.mock.calls.filter(([request]) => request.path === '/v1/pages')).toHaveLength(1);
  });

  it('blocks publishing if the local association cannot be saved', async () => {
    const source = '---\nnotion_workspace: First\nnotion_id: page-id\n---\nBody';
    const store = await setup(source);
    store.app.vault.adapter.write.mockRejectedValueOnce(new Error('Binding storage unavailable'));
    await command(store.plugin);
    expect(Notice.messages.at(-1)).toContain('Binding storage unavailable');
    expect(api.mock.calls.filter(([request]) => request.method !== 'GET')).toEqual([]);
    expect(parseNote(store.files.get(store.note.path)!).notionWorkspaceId).toBe('workspace-one');
  });

  it('permits token rotation within the same workspace without changing the page binding', async () => {
    const store = await setup('Body', [profiles[0]]);
    await command(store.plugin);
    store.plugin.settings.profiles[0].token = 'rotated-token';
    workspace.mockResolvedValue({ type: 'bot', bot: { workspace_id: 'workspace-one' } });
    const push = command(store.plugin);
    await vi.waitFor(() => expect(Modal.opened).toHaveLength(1));
    Array.from(Modal.opened[0].contentEl.querySelectorAll('button')).find((button) => button.textContent === 'Push anyway')!.click();
    await push;
    expect(api.mock.calls.filter(([request]) => request.path === '/v1/pages')).toHaveLength(1);
    expect(workspace.mock.calls.at(-1)?.[0]).toBe('rotated-token');
    expect(JSON.parse(store.files.get(linksPath)!)[store.note.path]).toMatchObject({ workspaceId: 'workspace-one', pageId: 'created-page' });
  });

  it('keeps pinned identity when a note moves to a new path', async () => {
    const store = await setup('Body', [profiles[0]]);
    await command(store.plugin);
    const moved = new TFile('Archive/Moved.md');
    store.files.set(moved.path, store.files.get(store.note.path)!);
    store.files.delete(store.note.path);
    store.app.workspace.getActiveFile.mockReturnValue(moved);
    await command(store.plugin);
    expect(JSON.parse(store.files.get(linksPath)!)[moved.path]).toMatchObject({ notePath: moved.path, workspaceId: 'workspace-one', pageId: 'created-page' });
    expect(api.mock.calls.filter(([request]) => request.path === '/v1/pages')).toHaveLength(1);
  });

  it('rejects corrupt association state instead of silently forgetting note identities', async () => {
    const store = await setup('Body', [profiles[0]]);
    store.files.set(linksPath, '{broken');
    await store.plugin.onload();
    await command(store.plugin);
    expect(Notice.messages.at(-1)).toContain('note-links.json');
    expect(requestUrl).not.toHaveBeenCalled();
    expect(store.writes).toEqual([]);
  });
});
