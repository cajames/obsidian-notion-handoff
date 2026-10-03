// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorView } from '@codemirror/view';
import { getChunks } from '@codemirror/merge';
import NtnSync from '../src/main';
import { runNtn } from '../src/cli';
import { makeCheckpoint } from '../src/sync';
import { fingerprint } from '../src/sync-remote';
import { createTestApp, installDomHelpers, Modal, Notice, requestUrl } from './helpers/obsidian';

vi.mock('../src/cli', async (importOriginal) => ({ ...await importOriginal<typeof import('../src/cli')>(), runNtn: vi.fn() }));

const statePath = '.obsidian/plugins/ntn-sync/sync-state.json';
const key = `${fingerprint('test-token').slice(0, 16)}:pageid`;

function server(initial: string, blocks: unknown[] = []) {
  let remote = initial;
  vi.mocked(runNtn).mockImplementation(async (_binary, _token, args, stdin) => {
    if (args[0] === '--version') return 'ntn 0.23.16';
    if (args[1].endsWith('/markdown')) {
      if (args.includes('PATCH')) {
        const payload = JSON.parse(String(stdin));
        expect(payload.type).toBe('replace_content');
        remote = payload.replace_content.new_str;
      }
      return JSON.stringify({ markdown: remote, truncated: false, unknown_block_ids: [] });
    }
    if (args[1].endsWith('/children')) return JSON.stringify({ results: blocks, has_more: false });
    return '{}';
  });
  return { read: () => remote, edit: (value: string) => { remote = value; } };
}

async function setup(source: string, checkpoint: ReturnType<typeof makeCheckpoint> | null = null) {
  const store = createTestApp(source);
  if (checkpoint) store.files.set(statePath, JSON.stringify({ [key]: checkpoint }));
  const plugin = new NtnSync(store.app as never, { id: 'ntn-sync', name: 'Sync', version: '0.1.0', minAppVersion: '1.5.0', author: 'Test', description: 'Test', dir: '.obsidian/plugins/ntn-sync' });
  await plugin.onload();
  return { ...store, plugin };
}

function command(plugin: NtnSync, operation: 'pullCurrentNote' | 'pushCurrentNote') {
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
  vi.mocked(requestUrl).mockResolvedValue({ status: 200, headers: { 'content-type': 'image/png' }, arrayBuffer: new Uint8Array([137, 80, 78, 71]).buffer });
});

describe('plugin pull/push integration', () => {
  it('registers separate commands and autosaves a clean merge with a persisted backup/checkpoint', async () => {
    const base = 'Intro\n\nMiddle\n\nEnding';
    server(base.replace('Ending', 'Notion ending'));
    const source = `---\nnotion_id: page-id\ntags: [project]\n---\n${base.replace('Intro', 'Local intro')}`;
    const store = await setup(source, makeCheckpoint(base, base, fingerprint(base)));
    expect(Reflect.get(store.plugin, 'commands').map((cmd: { id: string }) => cmd.id)).toEqual(['push-to-notion', 'pull-from-notion']);
    await command(store.plugin, 'pullCurrentNote');
    expect(store.files.get(store.note.path)).toBe(source.replace('Ending', 'Notion ending'));
    expect(Modal.opened).toEqual([]);
    expect([...store.files.keys()].filter((path) => path.includes('/backups/'))).toHaveLength(1);
    expect(JSON.parse(store.files.get(statePath)!)[key].local).toBe(base.replace('Ending', 'Notion ending'));
    expect(Notice.messages.at(-1)).toContain('Push remains separate');
    expect(vi.mocked(runNtn).mock.calls.every((call) => !call[2].includes('PATCH') && !call[2].includes('POST'))).toBe(true);
  });

  it('imports new images on first pull only after review, preserving frontmatter and credentials', async () => {
    const url = 'https://example.com/image.png';
    server(`Notion text\n\n![Screenshot](${url})`, [{ id: 'image-id', type: 'image', image: { external: { url } }, last_edited_time: 'v1' }]);
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
    expect(store.files.get(store.note.path)).toMatch(/^---\nnotion_id: page-id\ntags: \[keep\]\n---\nNotion text/);
    expect(store.files.get(store.note.path)).toContain('![[notion-sync-assets/');
    expect(requestUrl).toHaveBeenCalledExactlyOnceWith({ url, method: 'GET', throw: false });
    expect(JSON.parse(store.files.get(statePath)!)[key].bindings).toHaveLength(1);
    expect(Reflect.get(store.plugin, 'saveData')).not.toHaveBeenCalled();
    // Reloading the plugin restores the baseline and asset mappings.
    await store.plugin.onload();
    await command(store.plugin, 'pullCurrentNote');
    expect(Modal.opened).toHaveLength(1);
    expect(requestUrl).toHaveBeenCalledTimes(1);
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
    expect(store.files.get(store.note.path)).toBe(prefix + chosen);
    expect(JSON.parse(store.files.get(statePath)!)[key].local).toBe(remote);
    expect([...store.files.keys()].filter((path) => path.includes('/backups/'))).toHaveLength(1);
    notion.edit(remote.replace('Last line', 'Notion last line'));
    await command(store.plugin, 'pullCurrentNote');
    expect(store.files.get(store.note.path)).toBe(prefix + chosen.replace('Last line', 'Notion last line'));
    expect(Modal.opened).toHaveLength(1);
    expect(vi.mocked(runNtn).mock.calls.every((call) => !call[2].includes('PATCH') && !call[2].includes('POST'))).toBe(true);
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
    expect(vi.mocked(runNtn).mock.calls.some((call) => call[2].includes('PATCH'))).toBe(false);
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
    expect(store.files.get(store.note.path)).toBe(source.replace('Local edits', 'Notion change after push'));
    expect(Modal.opened).toHaveLength(1);
  });

  it('rechecks Notion after preparation and asks about changes that arrived during the push', async () => {
    const notion = server('Base');
    const run = vi.mocked(runNtn).getMockImplementation()!;
    let changed = false;
    vi.mocked(runNtn).mockImplementation(async (...args) => {
      const result = await run(...args);
      if (!changed && args[2][1]?.endsWith('/children')) { changed = true; notion.edit('Late edit'); }
      return result;
    });
    const store = await setup('---\nnotion_id: page-id\n---\nLocal', makeCheckpoint('Base', 'Base', fingerprint('Base')));
    const push = command(store.plugin, 'pushCurrentNote');
    await vi.waitFor(() => expect(Modal.opened).toHaveLength(1));
    expect(Modal.opened[0].contentEl.textContent).toContain('Notion changed');
    click('Cancel — pull first'); await push;
    expect(notion.read()).toBe('Late edit');
    expect(vi.mocked(runNtn).mock.calls.some((call) => call[2].includes('PATCH'))).toBe(false);
  });

  it('restores a pushed drawing embed on pull instead of importing its rendered PNG', async () => {
    let remote = 'Base';
    let inserted = false;
    const url = 'https://prod-files.s3.amazonaws.com/sketch.png?signature=one';
    vi.mocked(runNtn).mockImplementation(async (_binary, _token, args, stdin) => {
      if (args[0] === '--version') return 'ntn';
      if (args[0] === 'files') return JSON.stringify({ id: 'upload-id', status: 'uploaded' });
      if (args[1].endsWith('/markdown')) {
        if (args.includes('PATCH')) remote = JSON.parse(String(stdin)).replace_content.new_str;
        return JSON.stringify({ markdown: remote, truncated: false, unknown_block_ids: [] });
      }
      if (args[1].endsWith('/children')) {
        if (args.includes('PATCH')) {
          inserted = true;
          remote = remote.replace(/Attachment:[^\n]+\[NTN_SYNC_MEDIA_[^\]]+\]/, `![Sketch](${url})`);
          return JSON.stringify({ results: [{ id: 'drawing-block' }] });
        }
        const marker = remote.match(/NTN_SYNC_MEDIA_[^\]]+/)?.[0];
        return JSON.stringify({ results: inserted
          ? [{ id: 'drawing-block', type: 'image', last_edited_time: 'v1', image: { file: { url } } }]
          : marker ? [{ id: 'placeholder', type: 'paragraph', paragraph: { rich_text: [{ plain_text: marker }] } }] : [], has_more: false });
      }
      return '{}';
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
    expect(requestUrl).not.toHaveBeenCalled();
    expect(Modal.opened).toEqual([]);
  });

  it('retains drawing provenance even when final Notion readback fails', async () => {
    let markdown = 'Base';
    let inserted = false;
    vi.mocked(runNtn).mockImplementation(async (_binary, _token, args, stdin) => {
      if (args[0] === '--version') return 'ntn';
      if (args[0] === 'files') return JSON.stringify({ id: 'upload', status: 'uploaded' });
      if (args[1].endsWith('/markdown')) {
        if (args.includes('PATCH')) markdown = JSON.parse(String(stdin)).replace_content.new_str;
        else if (inserted) throw new Error('Readback unavailable');
        return JSON.stringify({ markdown, truncated: false });
      }
      if (args[1].endsWith('/children')) {
        if (args.includes('PATCH')) { inserted = true; return JSON.stringify({ results: [{ id: 'drawing-block' }] }); }
        const marker = markdown.match(/NTN_SYNC_MEDIA_[^\]]+/)?.[0];
        return JSON.stringify({ results: marker ? [{ id: 'placeholder', type: 'paragraph', paragraph: { rich_text: [{ plain_text: marker }] } }] : [] });
      }
      return '{}';
    });
    const original = '![[plan.tldr]]';
    const store = await setup(`---\nnotion_id: page-id\n---\n${original}`, makeCheckpoint('Base', 'Base', fingerprint('Base')));
    store.files.set('plan.tldr', '{}');
    Reflect.set(store.plugin, 'renderDrawing', vi.fn(async () => new Uint8Array([1, 2, 3])));
    await command(store.plugin, 'pushCurrentNote');
    expect(JSON.parse(store.files.get('.obsidian/plugins/ntn-sync/media-origins.json')!)[key][0]).toMatchObject({
      id: 'drawing-block', original, source: 'plan.tldr', drawing: true,
    });
    expect(Notice.messages.at(-1)).toContain('Readback unavailable');
  });

  it('preserves tracked drawing exports across caption/version changes without rendering or downloading', async () => {
    const tldraw = '![[attachments/Sketch.md]]';
    const excalidraw = '![[Drawing.excalidraw]]';
    const urls = ['https://example.com/tldraw.png', 'https://example.com/excalidraw.png'];
    const blocks = urls.map((url, index) => ({ id: `image-${index}`, type: 'image', image: { external: { url } }, last_edited_time: 'v1' }));
    const notion = server(`# Note\nRemote test\n![TLDraw](${urls[0]})\n![Excalidraw](${urls[1]})`, blocks);
    const body = `# Note\n\nLocal test\n\n${tldraw}\n\n${excalidraw}`;
    const source = `---\nnotion_id: page-id\n---\n${body}`;
    const store = await setup(source);
    store.files.set('attachments/Sketch.md', '---\ntldraw-file: true\n---\nDrawing');
    store.files.set('Drawing.excalidraw.md', 'Drawing');
    vi.mocked(store.app.metadataCache.getCache).mockImplementation((path) => path === 'attachments/Sketch.md' ? { frontmatter: { 'tldraw-file': true } } : null);
    store.files.set('.obsidian/plugins/ntn-sync/media-origins.json', JSON.stringify({ [key]: [
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
    expect(store.files.get(store.note.path)).toBe(source);
    expect(store.binaries.size).toBe(0);
    const origins = JSON.parse(store.files.get('.obsidian/plugins/ntn-sync/media-origins.json')!)[key];
    expect(origins.map((origin: { original: string }) => origin.original)).toEqual([tldraw, excalidraw]);
    expect(requestUrl).not.toHaveBeenCalled();
    expect(render).not.toHaveBeenCalled();
    await store.plugin.onload();
    blocks[0].last_edited_time = 'v2';
    notion.edit(`# Note\nRemote test\n![Changed caption](${urls[0]})\n![Excalidraw](${urls[1]})`);
    await command(store.plugin, 'pullCurrentNote');
    expect(store.files.get(store.note.path)).toBe(source);
    expect(Modal.opened).toHaveLength(1);
    expect(requestUrl).not.toHaveBeenCalled();
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
    const run = vi.mocked(runNtn).getMockImplementation()!;
    vi.mocked(runNtn).mockImplementation(async (...args) => {
      if (args[2][1] === 'v1/pages' && args[2].includes('POST')) return JSON.stringify({ id: 'created-page' });
      return run(...args);
    });
    const store = await setup('New note');
    await command(store.plugin, 'pushCurrentNote');
    expect(store.files.get(store.note.path)).toBe('---\nnotion_id: created-page\n---\nNew note');
    expect(notion.read()).toBe('New note');
    notion.edit('Added in Notion');
    await command(store.plugin, 'pullCurrentNote');
    expect(store.files.get(store.note.path)).toBe('---\nnotion_id: created-page\n---\nAdded in Notion');
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
    expect(vi.mocked(runNtn).mock.calls.every((call) => call[1] === 'work-token')).toBe(true);
    expect(store.files.get(store.note.path)).toBe(source);
  });

  it('does not sync notes without notion_id or with corrupt checkpoints', async () => {
    const store = await setup('No frontmatter');
    await command(store.plugin, 'pullCurrentNote');
    expect(Notice.messages.at(-1)).toContain('no notion_id');
    expect(runNtn).not.toHaveBeenCalled();
    store.files.set(statePath, '{broken');
    await store.plugin.onload();
    await command(store.plugin, 'pullCurrentNote');
    expect(Notice.messages.at(-1)).toContain('Repair sync-state.json');
    expect(runNtn).not.toHaveBeenCalled();
  });

  it('leaves the note untouched when an image download fails', async () => {
    const url = 'https://example.com/image.png';
    server(`![Image](${url})`, [{ id: 'image', type: 'image', image: { external: { url } } }]);
    vi.mocked(requestUrl).mockRejectedValueOnce(new Error('Network error'));
    const source = '---\nnotion_id: page-id\n---\nLocal';
    const store = await setup(source);
    await command(store.plugin, 'pullCurrentNote');
    expect(store.files.get(store.note.path)).toBe(source);
    expect(store.writes).toEqual([]);
    expect(Notice.messages.at(-1)).toContain('Network error');
  });
});
