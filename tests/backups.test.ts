// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import NotionHandoff from '../src/main';
import { writeNotionBinding, parseNote } from '../src/note';
import { makeCheckpoint } from '../src/sync';
import { fingerprint } from '../src/sync-remote';
import { api, mockNotion } from './helpers/notion';
import { createTestApp, installDomHelpers, Modal, Notice } from './helpers/obsidian';

const folder = '.obsidian/plugins/notion-handoff';
const backupsFolder = `${folder}/backups`;
const statePath = `${folder}/sync-state.json`;
const key = 'workspace:workspacedefault:pageid';
const prefix = `${backupsFolder}/${fingerprint(key)}-`;
const backupPath = (time: number, binding = key) => `${backupsFolder}/${fingerprint(binding)}-${time}-${'a'.repeat(32)}.md`;

async function setup(local = 'Base', initialRemote = 'Notion edits') {
  const source = writeNotionBinding(`---\nnotion_id: page-id\n---\n${local}`, 'Default', 'workspace-default', 'page-id');
  const store = createTestApp(source);
  store.files.set(statePath, JSON.stringify({ [key]: makeCheckpoint('Base', 'Base', fingerprint('Base')) }));
  store.files.set(`${folder}/media-origins.json`, JSON.stringify({ [key]: [] }));
  store.files.set(`${folder}/note-links.json`, JSON.stringify({ [store.note.path]: { notePath: store.note.path, workspaceName: 'Default', workspaceId: 'workspace-default', pageId: 'page-id' } }));
  let remote = initialRemote;
  api.mockImplementation(async ({ path }) => path.endsWith('/markdown')
    ? { markdown: remote, truncated: false, unknown_block_ids: [] }
    : { results: [], has_more: false });
  const plugin = new NotionHandoff(store.app as never, { id: 'notion-handoff', name: 'Notion Handoff', version: '0.1.0', minAppVersion: '1.5.0', author: 'Test', description: 'Test', dir: folder });
  await plugin.onload();
  return {
    ...store, source, plugin,
    pull: () => Reflect.get(plugin, 'pullCurrentNote').call(plugin) as Promise<void>,
    editRemote: (body: string) => { remote = body; },
    backups: () => [...store.files.entries()].filter(([path]) => path.startsWith(prefix)),
    seedBackups: (binding = key) => {
      store.folders.add(backupsFolder);
      for (let index = 1; index <= 8; index++) store.files.set(backupPath(index, binding), `Backup ${index}`);
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  installDomHelpers();
  document.body.replaceChildren();
  Modal.opened = [];
  Notice.messages = [];
  mockNotion();
});

describe('Pull backup retention', () => {
  it('keeps five per binding only after note and checkpoint saves, preserving anonymous and unrelated files', async () => {
    const store = await setup();
    store.seedBackups();
    store.seedBackups('workspace:other:otherpage');
    const anonymous = `${backupsFolder}/123-${'b'.repeat(32)}.md`;
    const unrelated = `${backupsFolder}/manual.md`;
    const outside = `Notes/${fingerprint(key)}-1-${'a'.repeat(32)}.md`;
    for (const path of [anonymous, unrelated, outside]) store.files.set(path, 'Keep this');
    // Even duplicated/out-of-directory adapter results must not expand deletion scope.
    store.app.vault.adapter.list.mockImplementation(async () => ({ files: [...store.files.keys(), ...store.files.keys()], folders: [] }));
    store.app.vault.adapter.remove.mockImplementation(async (path) => {
      expect(parseNote(store.files.get(store.note.path)!).body).toBe('Notion edits');
      expect(JSON.parse(store.files.get(statePath)!)[key].observed).toBe(fingerprint('Notion edits'));
      store.files.delete(path);
    });
    expect(store.app.vault.adapter.list).not.toHaveBeenCalled();
    await store.pull();
    expect(store.backups().map(([, body]) => body)).toEqual(['Backup 5', 'Backup 6', 'Backup 7', 'Backup 8', store.source]);
    expect(store.app.vault.adapter.remove.mock.calls.map(([path]) => path)).toEqual([1, 2, 3, 4].map((index) => backupPath(index)));
    for (const path of [anonymous, unrelated, outside]) expect(store.files.get(path)).toBe('Keep this');
    for (let index = 1; index <= 8; index++) expect(store.files.get(backupPath(index, 'workspace:other:otherpage'))).toBe(`Backup ${index}`);
    expect(Notice.messages.at(-1)).toContain('Pulled and merged');
  });

  it('retains exactly the latest five original versions across repeated Pulls', async () => {
    const store = await setup();
    const clock = vi.spyOn(Date, 'now');
    try {
      for (let index = 1; index <= 8; index++) {
        clock.mockReturnValue(1000 + index);
        store.editRemote(`Version ${index}`);
        await store.pull();
        expect(store.backups()).toHaveLength(Math.min(index, 5));
      }
      expect(store.backups().map(([, body]) => parseNote(body).body)).toEqual([3, 4, 5, 6, 7].map((index) => `Version ${index}`));
    } finally { clock.mockRestore(); }
  });

  it('keeps the newest backup when the clock moves backward', async () => {
    const store = await setup();
    const future = Date.now() + 100000;
    for (let index = 1; index <= 8; index++) store.files.set(backupPath(future + index), `Backup ${index}`);
    await store.pull();
    expect(store.backups()).toHaveLength(5);
    expect(store.backups().map(([, body]) => body)).toEqual(['Backup 5', 'Backup 6', 'Backup 7', 'Backup 8', store.source]);
  });

  it('keeps the same backup group after a note rename and token replacement', async () => {
    const store = await setup();
    store.seedBackups();
    const oldPath = store.note.path;
    store.note.path = 'Notes/Renamed.md';
    store.files.set(store.note.path, store.source);
    store.files.delete(oldPath);
    store.plugin.settings.profiles[0].token = 'replacement-token';
    await store.pull();
    expect(store.backups()).toHaveLength(5);
    expect(store.backups().some(([, body]) => body === store.source)).toBe(true);
    expect(parseNote(store.files.get(store.note.path)!).body).toBe('Notion edits');
  });

  it('does not create or prune backups on unchanged Pulls', async () => {
    const store = await setup('Base', 'Base');
    store.seedBackups();
    await store.pull();
    expect(store.backups()).toHaveLength(8);
    expect(store.app.vault.adapter.list).not.toHaveBeenCalled();
    expect(store.app.vault.adapter.remove).not.toHaveBeenCalled();
  });

  it('does not create or prune backups when review is cancelled', async () => {
    const store = await setup('Local edits');
    store.seedBackups();
    const pull = store.pull();
    await vi.waitFor(() => expect(Modal.opened).toHaveLength(1));
    Modal.opened[0].close();
    await pull;
    expect(store.files.get(store.note.path)).toBe(store.source);
    expect(store.backups()).toHaveLength(8);
    expect(store.app.vault.adapter.list).not.toHaveBeenCalled();
    expect(store.app.vault.adapter.remove).not.toHaveBeenCalled();
  });

  it.each(['backup', 'note', 'checkpoint'])('does not prune after a failed %s save', async (failure) => {
    const store = await setup();
    store.seedBackups();
    if (failure === 'note') store.app.vault.process.mockRejectedValueOnce(new Error('Storage unavailable'));
    else {
      const write = store.app.vault.adapter.write.getMockImplementation()!;
      store.app.vault.adapter.write.mockImplementation(async (path, contents) => {
        if (failure === 'backup' ? path.startsWith(prefix) : path === statePath) throw new Error('Storage unavailable');
        await write(path, contents);
      });
    }
    await store.pull();
    expect(store.backups()).toHaveLength(failure === 'backup' ? 8 : 9);
    expect(store.app.vault.adapter.list).not.toHaveBeenCalled();
    expect(store.app.vault.adapter.remove).not.toHaveBeenCalled();
    expect(Notice.messages.at(-1)).toContain('Notion pull failed');
    if (failure === 'checkpoint') expect(parseNote(store.files.get(store.note.path)!).body).toBe('Notion edits');
    else expect(store.files.get(store.note.path)).toBe(store.source);
  });

  it.each(['list', 'remove'] as const)('reports %s cleanup failures without failing the saved Pull', async (operation) => {
    const store = await setup();
    store.seedBackups();
    store.app.vault.adapter[operation].mockRejectedValueOnce(new Error('Storage unavailable'));
    await store.pull();
    expect(parseNote(store.files.get(store.note.path)!).body).toBe('Notion edits');
    expect(JSON.parse(store.files.get(statePath)!)[key].observed).toBe(fingerprint('Notion edits'));
    expect(store.backups()).toHaveLength(9);
    expect(Notice.messages).toContain('Pull saved, but backup cleanup failed: Storage unavailable');
    expect(Notice.messages.at(-1)).toContain('Pulled and merged');
  });

  it('keeps older backups if the new backup is absent from the directory listing', async () => {
    const store = await setup();
    store.seedBackups();
    store.app.vault.adapter.list.mockResolvedValueOnce({ files: Array.from({ length: 8 }, (_, index) => backupPath(index + 1)), folders: [] });
    await store.pull();
    expect(store.backups()).toHaveLength(9);
    expect(store.app.vault.adapter.remove).not.toHaveBeenCalled();
    expect(Notice.messages).toContain('Pull saved, but backup cleanup failed: Newest backup is missing; older backups were kept.');
    expect(Notice.messages.at(-1)).toContain('Pulled and merged');
  });
});
