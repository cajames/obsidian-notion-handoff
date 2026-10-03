// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorView } from '@codemirror/view';
import { getChunks } from '@codemirror/merge';
import NotionHandoff from '../src/main';
import { api, mockNotion, workspace } from './helpers/notion';
import { parseNote, writeNotionBinding } from '../src/note';
import { makeCheckpoint } from '../src/sync';
import { fingerprint } from '../src/sync-remote';
import { createTestApp, installDomHelpers, Modal, Notice, requestUrl } from './helpers/obsidian';

const statePath = '.obsidian/plugins/notion-handoff/sync-state.json';
const legacyKey = `${fingerprint('test-token').slice(0, 16)}:pageid`;
const key = 'workspace:workspacedefault:pageid';
const linksPath = '.obsidian/plugins/notion-handoff/note-links.json';
const bound = (source: string, pageId = parseNote(source).notionId!) => writeNotionBinding(source, 'Default', 'workspace-default', pageId);

function server(initial: string, blocks: unknown[] = []) {
  let remote = initial;
  api.mockImplementation(async ({ path, method, body }) => {
    if (path.includes('/markdown')) {
      if (method === 'PATCH') {
        expect(body.type).toBe('replace_content');
        remote = body.replace_content.new_str;
      }
      return { markdown: remote, truncated: false, unknown_block_ids: [] };
    }
    if (path.includes('/children')) return { results: blocks, has_more: false };
    return {};
  });
  return { read: () => remote, edit: (value: string) => { remote = value; } };
}

async function setup(source: string, checkpoint: ReturnType<typeof makeCheckpoint> | null = null) {
  const store = createTestApp(source);
  if (checkpoint) store.files.set(statePath, JSON.stringify({ [legacyKey]: checkpoint }));
  const plugin = new NotionHandoff(store.app as never, { id: 'notion-handoff', name: 'Notion Handoff', version: '0.1.0', minAppVersion: '1.5.0', author: 'Test', description: 'Test', dir: '.obsidian/plugins/notion-handoff' });
  await plugin.onload();
  return { ...store, plugin };
}

function command(plugin: NotionHandoff, operation: 'pullCurrentNote' | 'pushCurrentNote') {
  return Reflect.get(plugin, operation).call(plugin) as Promise<void>;
}

function click(label: string) {
  const modal = Modal.opened.at(-1)!;
  const button = Array.from(modal.contentEl.querySelectorAll('button')).find((button) => button.textContent === label);
  expect(button, label).toBeDefined();
  expect(button!.disabled).toBe(false);
  button!.click();
}

beforeEach(() => {
  vi.clearAllMocks();
  installDomHelpers();
  Modal.opened = [];
  Notice.messages = [];
  document.body.replaceChildren();
  mockNotion();
});

describe('plugin pull/push integration', () => {
  it('registers separate commands and autosaves a clean merge with a persisted backup/checkpoint', async () => {
    const base = 'Intro\n\nMiddle\n\nEnding';
    server(base.replace('Ending', 'Notion ending'));
    const source = `---\nnotion_id: page-id\ntags: [project]\n---\n${base.replace('Intro', 'Local intro')}`;
    const store = await setup(source, makeCheckpoint(base, base, fingerprint(base)));
    expect(Reflect.get(store.plugin, 'commands').map((cmd: { id: string }) => cmd.id)).toEqual(['push-to-notion', 'pull-from-notion']);
    expect(requestUrl).not.toHaveBeenCalled();
    expect(Reflect.get(store.plugin, 'saveData')).not.toHaveBeenCalled();
    expect(store.plugin.settings).not.toHaveProperty('binary');
    await command(store.plugin, 'pullCurrentNote');
    expect(store.files.get(store.note.path)).toBe(bound(source.replace('Ending', 'Notion ending')));
    expect(Modal.opened).toEqual([]);
    expect([...store.files.keys()].filter((path) => path.includes('/backups/'))).toHaveLength(1);
    expect(JSON.parse(store.files.get(statePath)!)[key].local).toBe(base.replace('Ending', 'Notion ending'));
    expect(Notice.messages.at(-1)).toContain('Push remains separate');
    expect(api.mock.calls.every(([request]) => request.method === 'GET')).toBe(true);
  });

  it('keeps legacy plugin state separate from the new plugin ID', async () => {
    server('Base');
    const source = '---\nnotion_id: page-id\n---\nBase';
    const store = await setup(source);
    const legacyState = '.obsidian/plugins/ntn-sync/sync-state.json';
    const legacyOrigins = '.obsidian/plugins/ntn-sync/media-origins.json';
    store.files.set(legacyState, 'Legacy checkpoint left untouched');
    store.files.set(legacyOrigins, 'Legacy provenance left untouched');
    await store.plugin.onload();
    await command(store.plugin, 'pullCurrentNote');
    expect(store.files.get(legacyState)).toBe('Legacy checkpoint left untouched');
    expect(store.files.get(legacyOrigins)).toBe('Legacy provenance left untouched');
    expect(store.files.get(store.note.path)).toBe(bound(source));
    expect(store.files.has(statePath)).toBe(true);
    expect(store.app.vault.adapter.read).not.toHaveBeenCalledWith(legacyState);
    expect(store.app.vault.adapter.read).not.toHaveBeenCalledWith(legacyOrigins);
    expect(store.writes.every((path) => !path.includes('/ntn-sync/'))).toBe(true);
  });

  it('imports new images on first pull only after review, preserving frontmatter and credentials', async () => {
    const url = 'https://example.com/image.png';
    server(`Notion text\n\n![Screenshot](${url})`, [{ id: 'image-id', type: 'image', has_children: false, image: { external: { url } }, last_edited_time: 'v1' }]);
    const source = '---\nnotion_id: page-id\ntags: [keep]\n---\nLocal text';
    const store = await setup(source);
    const pull = command(store.plugin, 'pullCurrentNote');
    await vi.waitFor(() => expect(Modal.opened).toHaveLength(1));
    expect(store.files.get(store.note.path)).toBe(source);
    expect(store.binaries.size).toBe(0);
    click('Take Notion');
    click('Save merged note');
    await pull;
    expect(store.binaries.size).toBe(1);
    expect(parseNote(store.files.get(store.note.path)!)).toMatchObject({ notionId: 'page-id', notionWorkspace: 'Default', notionWorkspaceId: 'workspace-default' });
    expect(store.files.get(store.note.path)).toContain('tags: [keep]');
    expect(parseNote(store.files.get(store.note.path)!).body).toMatch(/^Notion text/);
    expect(store.files.get(store.note.path)).toContain('![[Attachments/notion-pageid-');
    expect(requestUrl).toHaveBeenCalledWith({ url, method: 'GET', throw: false });
    expect(JSON.parse(store.files.get(statePath)!)[key].bindings).toHaveLength(1);
    expect(Reflect.get(store.plugin, 'saveData')).not.toHaveBeenCalled();
    // Reloading the plugin restores the baseline and asset mappings.
    await store.plugin.onload();
    await command(store.plugin, 'pullCurrentNote');
    expect(Modal.opened).toHaveLength(1);
    expect(vi.mocked(requestUrl).mock.calls.filter(([request]) => (request as any).url === url)).toHaveLength(1);
  });

  it.each([
    ['', 'Attachments', 'Attachments/'],
    ['', './Images', 'Notes/Images/'],
    ['', './', 'Notes/'],
    ['', '/', ''],
    ['Client assets/Notion', 'Attachments', 'Client assets/Notion/'],
    ['/', 'Attachments', ''],
  ])('imports images using custom %j or Obsidian %j folder', async (custom, attachments, expected) => {
    const url = 'https://example.com/image.png';
    server(`![Image](${url})`, [{ id: 'image', type: 'image', has_children: false, image: { external: { url } } }]);
    const store = await setup('---\nnotion_id: page-id\n---\nLocal');
    store.plugin.settings.imageImportFolder = custom;
    store.app.vault.getConfig.mockReturnValue(attachments);
    const pull = command(store.plugin, 'pullCurrentNote');
    await vi.waitFor(() => expect(Modal.opened).toHaveLength(1));
    expect(store.binaries.size).toBe(0);
    expect(store.app.vault.createFolder).not.toHaveBeenCalled();
    click('Take Notion'); click('Save merged note'); await pull;
    const path = [...store.binaries.keys()][0];
    expect(path).toMatch(new RegExp(`^${expected}notion-pageid-image-[a-f0-9]+\\.png$`));
    expect(store.files.get(store.note.path)).toContain(`![[${path}|Image]]`);
    expect([...store.binaries.keys()]).toHaveLength(1);
  });

  it('loads a saved import folder without rewriting settings or credentials', async () => {
    const store = await setup('Local');
    expect(store.plugin.settings.imageImportFolder).toBe('');
    const saved = { ...await store.plugin.loadData(), imageImportFolder: 'Client assets/Notion' };
    vi.mocked(store.plugin.loadData).mockResolvedValue(saved);
    await store.plugin.onload();
    expect(store.plugin.settings.imageImportFolder).toBe('Client assets/Notion');
    expect(store.plugin.settings.profiles).toEqual(saved.profiles);
    expect(store.plugin.saveData).not.toHaveBeenCalled();
    expect(requestUrl).not.toHaveBeenCalled();
  });

  it.each(['../outside', '/absolute/folder', 'C:\\outside', 'Folder/../../outside', 'Folder|caption', 'Folder#heading'])('rejects unsafe import folder %j without writing', async (folder) => {
    server('Remote');
    const store = await setup('---\nnotion_id: page-id\n---\nLocal');
    store.plugin.settings.imageImportFolder = folder;
    await command(store.plugin, 'pullCurrentNote');
    expect(Notice.messages.at(-1)).toContain('vault-relative path');
    expect(store.writes).toEqual([]);
    expect(Modal.opened).toEqual([]);
  });

  it('cancels an image import without creating the configured folder or files', async () => {
    const url = 'https://example.com/image.png';
    server(`![Image](${url})`, [{ id: 'image', type: 'image', has_children: false, image: { external: { url } } }]);
    const store = await setup('---\nnotion_id: page-id\n---\nLocal');
    store.plugin.settings.imageImportFolder = 'New folder/Notion';
    const pull = command(store.plugin, 'pullCurrentNote');
    await vi.waitFor(() => expect(Modal.opened).toHaveLength(1));
    click('Cancel'); await pull;
    expect(store.writes).toEqual([]);
    expect(store.app.vault.createFolder).not.toHaveBeenCalled();
    expect(store.binaries.size).toBe(0);
  });

  it('persists individual review decisions while keeping independent local edits pending across pulls', async () => {
    const base = '# Note\n\nIntro\n\nArea\n\nBetween one\nBetween two\n\nFooter\n\nLast line';
    const local = base.replace('Intro', 'Local intro').replace('Area', 'Local area');
    const remote = base.replace('Area', 'Notion area').replace('Footer', 'Notion footer');
    const notion = server(remote);
    const prefix = '---\nnotion_id: page-id\ntags: [keep]\n---\n';
    const store = await setup(prefix + local, makeCheckpoint(base, base, fingerprint(base)));
    const pull = command(store.plugin, 'pullCurrentNote');
    await vi.waitFor(() => expect(Modal.opened).toHaveLength(1));
    click('Take Notion'); click('Keep Obsidian'); click('Save merged note');
    await pull;
    const chosen = base.replace('Intro', 'Local intro').replace('Area', 'Notion area');
    expect(store.files.get(store.note.path)).toBe(bound(prefix + chosen));
    expect(JSON.parse(store.files.get(statePath)!)[key].local).toBe(remote);
    expect([...store.files.keys()].filter((path) => path.includes('/backups/'))).toHaveLength(1);
    notion.edit(remote.replace('Last line', 'Notion last line'));
    await command(store.plugin, 'pullCurrentNote');
    expect(store.files.get(store.note.path)).toBe(bound(prefix + chosen.replace('Last line', 'Notion last line')));
    expect(Modal.opened).toHaveLength(1);
    expect(api.mock.calls.every(([request]) => request.method === 'GET')).toBe(true);
  });

  it('cancels first pull or conflict review without saving notes, images, or checkpoints', async () => {
    server('Notion edit');
    for (const checkpoint of [null, makeCheckpoint('Base', 'Base', fingerprint('Base'))]) {
      const store = await setup('---\nnotion_id: page-id\n---\nLocal edit', checkpoint);
      const count = Modal.opened.length;
      const pull = command(store.plugin, 'pullCurrentNote');
      await vi.waitFor(() => expect(Modal.opened).toHaveLength(count + 1));
      // The unresolved merged result cannot be saved.
      const save = Array.from(Modal.opened.at(-1)!.contentEl.querySelectorAll('button')).find((button) => button.textContent === 'Save merged note')!;
      expect(save.disabled).toBe(true);
      click('Cancel');
      await pull;
      expect(store.writes).toEqual([]);
      expect(Notice.messages.at(-1)).toBe('Notion pull cancelled.');
    }
  });

  it('rejects local edits made while review is open and prevents simultaneous sync commands', async () => {
    server('Remote');
    const source = '---\nnotion_id: page-id\n---\nLocal';
    const store = await setup(source);
    const pull = command(store.plugin, 'pullCurrentNote');
    await vi.waitFor(() => expect(Modal.opened).toHaveLength(1));
    await command(store.plugin, 'pushCurrentNote');
    expect(Notice.messages.at(-1)).toContain('already in progress');
    store.files.set(store.note.path, source + '\nNew edit');
    click('Take Notion'); click('Save merged note');
    await pull;
    expect(store.files.get(store.note.path)).toBe(source + '\nNew edit');
    expect(store.writes).toEqual([]);
    expect(Notice.messages.at(-1)).toContain('note changed');
  });

  it('asks before overwriting changed Notion content, and cancellation makes no API writes', async () => {
    server('Remote edits');
    const source = '---\nnotion_id: page-id\n---\nLocal edits';
    const store = await setup(source, makeCheckpoint('Base', 'Base', fingerprint('Base')));
    const push = command(store.plugin, 'pushCurrentNote');
    await vi.waitFor(() => expect(Modal.opened).toHaveLength(1));
    expect(Modal.opened[0].contentEl.textContent).toContain('Notion changed');
    expect(api.mock.calls.some(([request]) => request.method === 'PATCH')).toBe(false);
    click('Cancel — pull first');
    await push;
    expect(store.writes).toEqual([]);
    expect(Notice.messages.at(-1)).toBe('Notion push cancelled.');
  });

  it('allows a confirmed push and saves a verified baseline for subsequent pulls', async () => {
    const notion = server('Remote edits');
    const source = '---\nnotion_id: page-id\n---\nLocal edits';
    const store = await setup(source, makeCheckpoint('Base', 'Base', fingerprint('Base')));
    const push = command(store.plugin, 'pushCurrentNote');
    await vi.waitFor(() => expect(Modal.opened).toHaveLength(1));
    click('Push anyway');
    await push;
    expect(notion.read()).toBe('Local edits');
    expect(JSON.parse(store.files.get(statePath)!)[key]).toMatchObject({ local: 'Local edits', remote: 'Local edits', observed: fingerprint('Local edits') });
    await command(store.plugin, 'pushCurrentNote');
    expect(Modal.opened).toHaveLength(1);
    notion.edit('Notion change after push');
    await command(store.plugin, 'pullCurrentNote');
    expect(store.files.get(store.note.path)).toBe(bound(source.replace('Local edits', 'Notion change after push')));
    expect(Modal.opened).toHaveLength(1);
  });

  it('rechecks Notion after preparation and asks about changes that arrived during the push', async () => {
    const notion = server('Base');
    const run = api.getMockImplementation()!;
    let changed = false;
    api.mockImplementation(async (request) => {
      const result = await run(request);
      if (!changed && request.path.includes('/children')) { changed = true; notion.edit('Late edit'); }
      return result;
    });
    const store = await setup('---\nnotion_id: page-id\n---\nLocal', makeCheckpoint('Base', 'Base', fingerprint('Base')));
    const push = command(store.plugin, 'pushCurrentNote');
    await vi.waitFor(() => expect(Modal.opened).toHaveLength(1));
    expect(Modal.opened[0].contentEl.textContent).toContain('Notion changed');
    click('Cancel — pull first'); await push;
    expect(notion.read()).toBe('Late edit');
    expect(api.mock.calls.some(([request]) => request.method === 'PATCH')).toBe(false);
  });

  it('restores a pushed drawing embed on pull instead of importing its rendered PNG', async () => {
    let remote = 'Base';
    let inserted = false;
    const url = 'https://prod-files.s3.amazonaws.com/sketch.png?signature=one';
    api.mockImplementation(async ({ path, method, body }) => {
      if (path.includes('/file_uploads')) return { id: 'upload-id', status: path === '/v1/file_uploads' ? 'pending' : 'uploaded' };
      if (path.includes('/markdown')) {
        if (method === 'PATCH') remote = body.replace_content.new_str;
        return { markdown: remote, truncated: false, unknown_block_ids: [] };
      }
      if (path.includes('/children')) {
        if (method === 'PATCH') {
          inserted = true;
          remote = remote.replace(/Attachment:[^\n]+\[NTN_SYNC_MEDIA_[^\]]+\]/, `![Sketch](${url})`);
          return { results: [{ id: 'drawing-block' }] };
        }
        const marker = remote.match(/NTN_SYNC_MEDIA_[^\]]+/)?.[0];
        return { results: inserted
          ? [{ id: 'drawing-block', type: 'image', has_children: false, last_edited_time: 'v1', image: { file: { url } } }]
          : marker ? [{ id: 'placeholder', type: 'paragraph', has_children: false, paragraph: { rich_text: [{ plain_text: marker }] } }] : [], has_more: false };
      }
      return {};
    });
    const original = '![[Drawings/plan.tldr|Sketch]]';
    const source = `---\nnotion_id: page-id\n---\n# Note\n\n${original}`;
    const store = await setup(source, makeCheckpoint('Base', 'Base', fingerprint('Base')));
    store.files.set('Drawings/plan.tldr', '{}');
    Reflect.set(store.plugin, 'renderDrawing', vi.fn(async () => new Uint8Array([137, 80, 78, 71])));
    await command(store.plugin, 'pushCurrentNote');
    const checkpoint = JSON.parse(store.files.get(statePath)!)[key];
    expect(checkpoint.bindings.some((binding: { local: string }) => binding.local === original)).toBe(true);
    remote += '\n\nAdded in Notion';
    await command(store.plugin, 'pullCurrentNote');
    expect(store.files.get(store.note.path)).toContain(original);
    expect(store.files.get(store.note.path)).toContain('Added in Notion');
    expect(vi.mocked(requestUrl).mock.calls.every(([request]) => (request as any).url.startsWith('https://api.notion.com/'))).toBe(true);
    expect(Modal.opened).toEqual([]);
  });

  it('retains drawing provenance even when final Notion readback fails', async () => {
    let markdown = 'Base';
    let inserted = false;
    api.mockImplementation(async ({ path, method, body }) => {
      if (path.includes('/file_uploads')) return { id: 'upload', status: path === '/v1/file_uploads' ? 'pending' : 'uploaded' };
      if (path.includes('/markdown')) {
        if (method === 'PATCH') markdown = body.replace_content.new_str;
        else if (inserted) throw new Error('Readback unavailable');
        return { markdown, truncated: false, unknown_block_ids: [] };
      }
      if (path.includes('/children')) {
        if (method === 'PATCH') { inserted = true; return { results: [{ id: 'drawing-block' }] }; }
        const marker = markdown.match(/NTN_SYNC_MEDIA_[^\]]+/)?.[0];
        return { results: marker ? [{ id: 'placeholder', type: 'paragraph', has_children: false, paragraph: { rich_text: [{ plain_text: marker }] } }] : [], has_more: false };
      }
      return {};
    });
    const original = '![[plan.tldr]]';
    const store = await setup(`---\nnotion_id: page-id\n---\n${original}`, makeCheckpoint('Base', 'Base', fingerprint('Base')));
    store.files.set('plan.tldr', '{}');
    Reflect.set(store.plugin, 'renderDrawing', vi.fn(async () => new Uint8Array([1, 2, 3])));
    await command(store.plugin, 'pushCurrentNote');
    expect(JSON.parse(store.files.get('.obsidian/plugins/notion-handoff/media-origins.json')!)[key][0]).toMatchObject({
      id: 'drawing-block', original, source: 'plan.tldr', drawing: true,
    });
    expect(Notice.messages.at(-1)).toContain('Readback unavailable');
  });

  it('preserves tracked drawing exports across caption/version changes without rendering or downloading', async () => {
    const tldraw = '![[attachments/Sketch.md]]';
    const excalidraw = '![[Drawing.excalidraw]]';
    const urls = ['https://example.com/tldraw.png', 'https://example.com/excalidraw.png'];
    const blocks = urls.map((url, index) => ({ id: `image-${index}`, type: 'image', has_children: false, image: { external: { url } }, last_edited_time: 'v1' }));
    const notion = server(`# Note\nRemote test\n![TLDraw](${urls[0]})\n![Excalidraw](${urls[1]})`, blocks);
    const body = `# Note\n\nLocal test\n\n${tldraw}\n\n${excalidraw}`;
    const source = `---\nnotion_id: page-id\n---\n${body}`;
    const store = await setup(source);
    store.files.set('attachments/Sketch.md', '---\ntldraw-file: true\n---\nDrawing');
    store.files.set('Drawing.excalidraw.md', 'Drawing');
    vi.mocked(store.app.metadataCache.getCache).mockImplementation((path) => path === 'attachments/Sketch.md' ? { frontmatter: { 'tldraw-file': true } } : null);
    store.files.set('.obsidian/plugins/notion-handoff/media-origins.json', JSON.stringify({ [legacyKey]: [
      { id: 'image-0', original: tldraw, source: 'attachments/Sketch.md', drawing: true },
      { id: 'image-1', original: excalidraw, source: 'Drawing.excalidraw.md', drawing: true },
    ] }));
    await store.plugin.onload();
    const render = vi.fn();
    Reflect.set(store.plugin, 'renderDrawing', render);
    const pull = command(store.plugin, 'pullCurrentNote');
    await vi.waitFor(() => expect(Modal.opened).toHaveLength(1));
    const editor = EditorView.findFromDOM(Modal.opened[0].contentEl.querySelector<HTMLElement>('.cm-editor')!)!;
    const proposed = editor.state.doc.toString();
    expect(proposed).toContain(tldraw);
    expect(proposed).toContain(excalidraw);
    expect(proposed).not.toContain('notion-sync-assets');
    const changed = getChunks(editor.state)!.chunks.map((chunk) => editor.state.sliceDoc(chunk.fromB, chunk.endB)).join('');
    expect(changed).not.toContain('# Note');
    expect(changed).not.toContain('![[attachments/');
    click('Keep Obsidian'); click('Save merged note'); await pull;
    expect(store.files.get(store.note.path)).toBe(bound(source));
    expect(store.binaries.size).toBe(0);
    const origins = JSON.parse(store.files.get('.obsidian/plugins/notion-handoff/media-origins.json')!)[key];
    expect(origins.map((origin: { original: string }) => origin.original)).toEqual([tldraw, excalidraw]);
    expect(vi.mocked(requestUrl).mock.calls.every(([request]) => (request as any).url.startsWith('https://api.notion.com/'))).toBe(true);
    expect(render).not.toHaveBeenCalled();
    await store.plugin.onload();
    blocks[0].last_edited_time = 'v2';
    notion.edit(`# Note\nRemote test\n![Changed caption](${urls[0]})\n![Excalidraw](${urls[1]})`);
    await command(store.plugin, 'pullCurrentNote');
    expect(store.files.get(store.note.path)).toBe(bound(source));
    expect(Modal.opened).toHaveLength(1);
    expect(vi.mocked(requestUrl).mock.calls.every(([request]) => (request as any).url.startsWith('https://api.notion.com/'))).toBe(true);
    expect(render).not.toHaveBeenCalled();
  });

  it('asks for confirmation before the first push to a nonempty existing page', async () => {
    server('Existing Notion content');
    const store = await setup('---\nnotion_id: page-id\n---\nLocal');
    const push = command(store.plugin, 'pushCurrentNote');
    await vi.waitFor(() => expect(Modal.opened).toHaveLength(1));
    expect(Modal.opened[0].contentEl.textContent).toContain('Replace existing Notion content');
    click('Cancel — pull first'); await push;
  });

  it('creates a page on push, then pulls its edits using the newly persisted ID and baseline', async () => {
    const notion = server('');
    const run = api.getMockImplementation()!;
    api.mockImplementation(async (request) => {
      if (request.path === '/v1/pages' && request.method === 'POST') return { id: 'created-page' };
      return run(request);
    });
    const store = await setup('New note');
    await command(store.plugin, 'pushCurrentNote');
    expect(store.files.get(store.note.path)).toBe(bound('New note', 'created-page'));
    expect(notion.read()).toBe('New note');
    notion.edit('Added in Notion');
    await command(store.plugin, 'pullCurrentNote');
    expect(store.files.get(store.note.path)).toBe(bound('Added in Notion', 'created-page'));
    expect(Modal.opened).toEqual([]);
  });

  it('uses the selected workspace profile for pull without requiring a parent page', async () => {
    server('Remote');
    const source = '---\nnotion_id: page-id\nnotion_workspace: Work\n---\nLocal';
    const store = await setup(source);
    store.plugin.settings.profiles = [
      { name: 'Default', token: 'default-token', parentId: '' },
      { name: 'Work', token: 'work-token', parentId: '' },
    ];
    const pull = command(store.plugin, 'pullCurrentNote');
    await vi.waitFor(() => expect(Modal.opened).toHaveLength(1));
    click('Cancel'); await pull;
    expect(api.mock.calls.every(([request]) => request.token === 'work-token')).toBe(true);
    expect(store.files.get(store.note.path)).toBe(source);
  });

  it('isolates every push operation, including uploads and creation, to the selected profile', async () => {
    let remote = '';
    api.mockImplementation(async ({ path, method, body }) => {
      if (path.includes('/file_uploads')) return { id: 'upload', status: path === '/v1/file_uploads' ? 'pending' : 'uploaded' };
      if (path === '/v1/pages' && method === 'POST') return { id: 'work-page' };
      if (path.includes('/markdown')) {
        if (method === 'PATCH') remote = body.replace_content.new_str;
        return { markdown: remote, truncated: false, unknown_block_ids: [] };
      }
      return { results: [], has_more: false };
    });
    const store = await setup('---\nnotion_workspace: Work\n---\n![[photo.png]]');
    store.files.set('photo.png', 'fixture');
    store.plugin.settings.profiles = [
      { name: 'Default', token: 'default-token', parentId: 'default-parent' },
      { name: 'Work', token: 'work-token', parentId: 'work-parent' },
    ];
    await command(store.plugin, 'pushCurrentNote');
    await command(store.plugin, 'pushCurrentNote');
    expect(api.mock.calls.every(([request]) => request.token === 'work-token')).toBe(true);
    const creations = api.mock.calls.filter(([request]) => request.path === '/v1/pages');
    expect(creations).toHaveLength(1);
    expect(creations[0][0].body.parent.page_id).toBe('work-parent');
    expect(api.mock.calls.some(([request]) => request.path.includes('/file_uploads/') && request.path.endsWith('/send'))).toBe(true);
    expect(api.mock.calls.some(([request]) => request.path === '/v1/pages/work-page' && request.method === 'PATCH')).toBe(false);
    expect(api.mock.calls.some(([request]) => request.path === '/v1/pages/work-page/markdown' && request.method === 'PATCH')).toBe(true);
    expect(parseNote(store.files.get(store.note.path)!).notionId).toBe('work-page');
    expect(workspace.mock.calls.every(([token]) => token === 'work-token')).toBe(true);
  });

  it('persists a created ID before Markdown failure so retry does not duplicate the page', async () => {
    const notion = server('');
    const run = api.getMockImplementation()!;
    let fail = true;
    api.mockImplementation(async (request) => {
      if (request.path === '/v1/pages' && request.method === 'POST') return { id: 'created-page' };
      if (request.path.includes('/markdown') && request.method === 'PATCH' && fail) {
        fail = false;
        throw new Error('Network failure');
      }
      return run(request);
    });
    const store = await setup('New note');
    await command(store.plugin, 'pushCurrentNote');
    expect(parseNote(store.files.get(store.note.path)!)).toMatchObject({ notionId: 'created-page', notionWorkspace: 'Default', notionWorkspaceId: 'workspace-default' });
    expect(JSON.parse(store.files.get(linksPath)!)[store.note.path]).toMatchObject({ workspaceId: 'workspace-default', pageId: 'created-page' });
    expect(Notice.messages.at(-1)).toContain('Network failure');
    await command(store.plugin, 'pushCurrentNote');
    expect(notion.read()).toBe('New note');
    expect(api.mock.calls.filter(([request]) => request.path === '/v1/pages')).toHaveLength(1);
  });

  it.each([
    { markdown: 'Partial', truncated: true, unknown_block_ids: [] },
    { markdown: 'Partial', truncated: false, unknown_block_ids: ['hidden'] },
    { markdown: 'Missing completeness flags' },
  ])('refuses incomplete remote content on push and pull without writes: %j', async (response) => {
    api.mockResolvedValue(response);
    const source = '---\nnotion_id: page-id\n---\nLocal';
    const store = await setup(source);
    await command(store.plugin, 'pushCurrentNote');
    await command(store.plugin, 'pullCurrentNote');
    expect(store.files.get(store.note.path)).toBe(source);
    expect(store.writes).toEqual([]);
    expect(api.mock.calls.every(([request]) => request.method === 'GET')).toBe(true);
    expect(Modal.opened).toEqual([]);
  });

  it('does not sync notes without notion_id or with corrupt checkpoints', async () => {
    const store = await setup('No frontmatter');
    await command(store.plugin, 'pullCurrentNote');
    expect(Notice.messages.at(-1)).toContain('no notion_id');
    expect(api).not.toHaveBeenCalled();
    store.files.set(statePath, '{broken');
    await store.plugin.onload();
    await command(store.plugin, 'pullCurrentNote');
    expect(Notice.messages.at(-1)).toContain('Repair sync-state.json');
    expect(api).not.toHaveBeenCalled();
  });

  it('leaves the note untouched when an image download fails', async () => {
    const url = 'https://example.com/image.png';
    server(`![Image](${url})`, [{ id: 'image', type: 'image', has_children: false, image: { external: { url } } }]);
    const transport = vi.mocked(requestUrl).getMockImplementation()!;
    vi.mocked(requestUrl).mockImplementation(async (request) => {
      if ((request as any).url === url) throw new Error('Network error');
      return Reflect.apply(transport, undefined, [request]);
    });
    const source = '---\nnotion_id: page-id\n---\nLocal';
    const store = await setup(source);
    await command(store.plugin, 'pullCurrentNote');
    expect(store.files.get(store.note.path)).toBe(source);
    expect(store.writes).toEqual([]);
    expect(Notice.messages.at(-1)).toContain('Network error');
  });
});
