// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import NotionHandoff from '../src/main';
import { writeNotionBinding } from '../src/note';
import { makeCheckpoint } from '../src/sync';
import { fingerprint } from '../src/sync-remote';
import { makeOrigin } from '../src/media-origins';
import { api, mockNotion, workspace } from './helpers/notion';
import { createTestApp, installDomHelpers, Modal, Notice, requestUrl } from './helpers/obsidian';

const folder = '.obsidian/plugins/notion-handoff';
const statePath = `${folder}/sync-state.json`;
const originPath = `${folder}/media-origins.json`;
const key = 'workspace:workspacedefault:pageid';
const legacyKey = `${fingerprint('previous-token').slice(0, 16)}:pageid`;
const base = 'Intro\n\nMiddle\n\nEnding';
const baseline = makeCheckpoint(base, base, fingerprint(base));
const bound = (body: string) => writeNotionBinding(body, 'Default', 'workspace-default', 'page-id');

async function setup(source = bound(base.replace('Intro', 'Local intro')), state = { [legacyKey]: baseline }, origins = {}) {
  const store = createTestApp(source);
  store.files.set(statePath, JSON.stringify(state));
  store.files.set(originPath, JSON.stringify(origins));
  const plugin = new NotionHandoff(store.app as never, { id: 'notion-handoff', name: 'Notion Handoff', version: '0.1.0', minAppVersion: '1.5.0', author: 'Test', description: 'Test', dir: folder });
  const credentials = (token: string) => ({ profiles: [{ name: 'Default', token, parentId: 'parent-id' }] });
  vi.mocked(plugin.loadData).mockResolvedValue(credentials('replacement-token'));
  await plugin.onload();
  const replaceToken = async (token: string) => {
    vi.mocked(plugin.loadData).mockResolvedValue(credentials(token));
    await plugin.onload();
  };
  return { ...store, plugin, replaceToken };
}

function command(plugin: NotionHandoff, operation = 'pullCurrentNote') {
  return Reflect.get(plugin, operation).call(plugin) as Promise<void>;
}

function server(initial: string, blocks: unknown[] = []) {
  let remote = initial;
  api.mockImplementation(async ({ path, method, body }) => {
    if (path.includes('/markdown')) {
      if (method === 'PATCH') remote = body.replace_content.new_str;
      return { markdown: remote, truncated: false, unknown_block_ids: [] };
    }
    return { results: blocks, has_more: false };
  });
  return { edit: (value: string) => { remote = value; } };
}

function cancel(label = 'Cancel') {
  Array.from(Modal.opened.at(-1)!.contentEl.querySelectorAll('button')).find((button) => button.textContent === label)!.click();
}

beforeEach(() => {
  vi.clearAllMocks();
  installDomHelpers();
  Modal.opened = [];
  Notice.messages = [];
  document.body.replaceChildren();
  mockNotion();
});

describe('access-token replacement and history adoption', () => {
  it('recovers a bound note’s old-token baseline and keeps merging after another replacement and reload', async () => {
    const remote = server(base.replace('Ending', 'Notion ending'));
    const store = await setup();
    await command(store.plugin);
    expect(Modal.opened).toEqual([]);
    expect(store.files.get(store.note.path)).toBe(bound(base.replace('Intro', 'Local intro').replace('Ending', 'Notion ending')));
    const state = JSON.parse(store.files.get(statePath)!);
    expect(state[legacyKey]).toEqual(baseline);
    expect(state[key].local).toBe(base.replace('Ending', 'Notion ending'));
    await store.replaceToken('another-token');
    store.files.set(store.note.path, store.files.get(store.note.path)!.replace('Middle', 'Local middle'));
    remote.edit(base.replace('Ending', 'Another Notion ending'));
    await command(store.plugin);
    expect(store.files.get(store.note.path)).toBe(bound(base.replace('Intro', 'Local intro').replace('Middle', 'Local middle').replace('Ending', 'Another Notion ending')));
    expect(Modal.opened).toEqual([]);
    expect(api.mock.calls.every(([request]) => request.method === 'GET')).toBe(true);
    expect(workspace.mock.calls.at(-1)?.[0]).toBe('another-token');
  });

  it('restores editable drawings from old-token provenance even without a checkpoint', async () => {
    const original = '![[Drawings/plan.tldr|Sketch]]';
    const origin = makeOrigin('drawing-block', original, 'Drawings/plan.tldr', true);
    const url = 'https://example.com/sketch.png';
    server(`Intro\n\n![Changed caption](${url})`, [{ id: origin.id, type: 'image', has_children: false, last_edited_time: 'v2', image: { external: { url } } }]);
    const source = bound(`Intro\n\n${original}`);
    const store = await setup(source, {}, { [legacyKey]: [origin] });
    store.files.set(origin.source, '{}');
    const render = vi.fn();
    Reflect.set(store.plugin, 'renderDrawing', render);
    await command(store.plugin);
    expect(store.files.get(store.note.path)).toBe(source);
    expect(Modal.opened).toEqual([]);
    expect(store.binaries.size).toBe(0);
    expect(render).not.toHaveBeenCalled();
    expect(vi.mocked(requestUrl).mock.calls.every(([request]) => (request as { url: string }).url.startsWith('https://api.notion.com/'))).toBe(true);
    const origins = JSON.parse(store.files.get(originPath)!);
    expect(origins[legacyKey]).toEqual([origin]);
    expect(origins[key]).toEqual([origin]);
    await store.replaceToken('another-token');
    await command(store.plugin);
    expect(store.files.get(store.note.path)).toBe(source);
    expect(store.binaries.size).toBe(0);
  });

  it('preserves old drawing provenance when a replacement-token push has no new attachments', async () => {
    server(base);
    const origin = makeOrigin('drawing-block', '![[plan.tldr]]', 'plan.tldr', true);
    const store = await setup(bound(base), { [legacyKey]: baseline }, { [legacyKey]: [origin] });
    await command(store.plugin, 'pushCurrentNote');
    expect(Modal.opened).toEqual([]);
    const origins = JSON.parse(store.files.get(originPath)!);
    expect(origins[legacyKey]).toEqual([origin]);
    expect(origins[key]).toEqual([origin]);
    expect(JSON.parse(store.files.get(statePath)!)[key]).toEqual(baseline);
  });

  it('adopts unchanged history on pull instead of leaving it under the old token forever', async () => {
    server(base);
    const store = await setup(bound(base));
    store.files.set(`${folder}/note-links.json`, JSON.stringify({ [store.note.path]: { notePath: store.note.path, workspaceName: 'Default', workspaceId: 'workspace-default', pageId: 'page-id' } }));
    await store.plugin.onload();
    await command(store.plugin);
    expect(store.files.get(store.note.path)).toBe(bound(base));
    expect(JSON.parse(store.files.get(statePath)!)[key]).toEqual(baseline);
    expect(JSON.parse(store.files.get(originPath)!)[key]).toEqual([]);
    const writes = store.writes.length;
    await store.replaceToken('another-token');
    await command(store.plugin);
    expect(store.writes).toHaveLength(writes);
  });

  it.each(['checkpoint', 'origins'])('resumes a partial migration with canonical %s already saved', async (saved) => {
    server(base.replace('Ending', 'Notion ending'));
    const origin = makeOrigin('drawing-block', '![[plan.tldr]]', 'plan.tldr', true);
    const other = `${fingerprint('another-previous-token').slice(0, 16)}:pageid`;
    const stale = makeCheckpoint('Stale', 'Stale', fingerprint('Stale'));
    const state = saved === 'checkpoint' ? { [legacyKey]: stale, [other]: stale, [key]: baseline } : { [legacyKey]: baseline };
    const origins = saved === 'origins' ? { [legacyKey]: [], [other]: [], [key]: [origin] } : { [legacyKey]: [origin] };
    const store = await setup(undefined, state, origins);
    await command(store.plugin);
    expect(Modal.opened).toEqual([]);
    expect(store.files.get(store.note.path)).toBe(bound(base.replace('Intro', 'Local intro').replace('Ending', 'Notion ending')));
    expect(JSON.parse(store.files.get(originPath)!)[key]).toEqual([origin]);
    expect(JSON.parse(store.files.get(statePath)!)[legacyKey]).toEqual(state[legacyKey]);
  });

  it('uses the current token’s known baseline for an unbound note even when other old histories exist', async () => {
    server(base.replace('Ending', 'Notion ending'));
    const current = `${fingerprint('replacement-token').slice(0, 16)}:pageid`;
    const source = `---\nnotion_id: page-id\n---\n${base.replace('Intro', 'Local intro')}`;
    const store = await setup(source, { [legacyKey]: makeCheckpoint('Stale', 'Stale', fingerprint('Stale')), [current]: baseline });
    await command(store.plugin);
    expect(Modal.opened).toEqual([]);
    expect(store.files.get(store.note.path)).toBe(writeNotionBinding(source.replace('Ending', 'Notion ending'), 'Default', 'workspace-default', 'page-id'));
    expect(JSON.parse(store.files.get(statePath)!)[current]).toEqual(baseline);
  });

  it('rejects ambiguous drawing provenance even when a canonical checkpoint exists', async () => {
    server(base);
    const other = `${fingerprint('another-previous-token').slice(0, 16)}:pageid`;
    const origin = makeOrigin('drawing-block', '![[plan.tldr]]', 'plan.tldr', true);
    const store = await setup(bound(base), { [key]: baseline }, { [legacyKey]: [origin], [other]: [origin] });
    const before = new Map(store.files);
    await command(store.plugin);
    expect(Notice.messages.at(-1)).toContain('Multiple legacy histories');
    expect(store.writes).toEqual([]);
    expect(store.files).toEqual(before);
  });

  it.each(['pushCurrentNote', 'pullCurrentNote'])('blocks wrong-workspace %s before accessing or migrating history', async (operation) => {
    server(base);
    workspace.mockResolvedValue({ type: 'bot', bot: { workspace_id: 'another-workspace' } });
    const store = await setup();
    const before = new Map(store.files);
    await command(store.plugin, operation);
    expect(Notice.messages.at(-1)).toContain('different Notion workspace');
    expect(api).not.toHaveBeenCalled();
    expect(store.writes).toEqual([]);
    expect(store.files).toEqual(before);
  });

  it.each(['pushCurrentNote', 'pullCurrentNote'])('rejects ambiguous legacy histories during %s without changes', async (operation) => {
    server(base);
    const other = `${fingerprint('another-previous-token').slice(0, 16)}:pageid`;
    const store = await setup(undefined, { [legacyKey]: baseline, [other]: baseline });
    const before = new Map(store.files);
    await command(store.plugin, operation);
    expect(Notice.messages.at(-1)).toContain('Multiple legacy histories');
    expect(Modal.opened).toEqual([]);
    expect(api.mock.calls.every(([request]) => request.method === 'GET')).toBe(true);
    expect(store.writes).toEqual([]);
    expect(store.files).toEqual(before);
  });

  it('does not infer a missing workspace binding from another token’s history', async () => {
    server(base.replace('Ending', 'Notion ending'));
    const source = `---\nnotion_id: page-id\n---\n${base.replace('Intro', 'Local intro')}`;
    const store = await setup(source);
    const pull = command(store.plugin);
    await vi.waitFor(() => expect(Modal.opened).toHaveLength(1));
    cancel();
    await pull;
    expect(store.files.get(store.note.path)).toBe(source);
    expect(store.writes).toEqual([]);
    expect(JSON.parse(store.files.get(statePath)!)).toEqual({ [legacyKey]: baseline });
  });

  it.each(['pushCurrentNote', 'pullCurrentNote'])('leaves recoverable legacy state untouched when %s is cancelled', async (operation) => {
    server('Conflicting Notion edits');
    const store = await setup(bound('Conflicting local edits'));
    const before = new Map(store.files);
    const sync = command(store.plugin, operation);
    await vi.waitFor(() => expect(Modal.opened).toHaveLength(1));
    cancel(operation === 'pushCurrentNote' ? 'Cancel — pull first' : 'Cancel');
    await sync;
    expect(store.writes).toEqual([]);
    expect(store.files).toEqual(before);
    expect(api.mock.calls.every(([request]) => request.method === 'GET')).toBe(true);
  });

  it('keeps legacy checkpoints intact and resumes after a migration storage failure', async () => {
    server(base.replace('Ending', 'Notion ending'));
    const store = await setup();
    const write = store.app.vault.adapter.write.getMockImplementation()!;
    let fail = true;
    store.app.vault.adapter.write.mockImplementation(async (path, value) => {
      if (path === statePath && fail) { fail = false; throw new Error('Storage unavailable'); }
      return write(path, value);
    });
    await command(store.plugin);
    expect(Notice.messages.at(-1)).toContain('checkpoint could not be saved');
    expect(JSON.parse(store.files.get(statePath)!)).toEqual({ [legacyKey]: baseline });
    await store.replaceToken('another-token');
    await command(store.plugin);
    expect(Modal.opened).toEqual([]);
    expect(JSON.parse(store.files.get(statePath)!)[key].local).toBe(base.replace('Ending', 'Notion ending'));
    expect(JSON.parse(store.files.get(statePath)!)[legacyKey]).toEqual(baseline);
  });
});
