// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import NotionHandoff from '../src/main';
import HandoffSettings from '../src/settings';
import { notionPageUrl } from '../src/note-links';
import { api, mockNotion, workspace } from './helpers/notion';
import { createTestApp, installDomHelpers, Modal, requestUrl } from './helpers/obsidian';

const first = '11111111-1111-4111-8111-111111111111';
const second = '22222222-2222-4222-8222-222222222222';
const folder = '.obsidian/plugins/notion-handoff';

function page(id = first, title = 'Project handoffs') {
  return { object: 'page', id, url: notionPageUrl(id), in_trash: false, archived: false, is_archived: false,
    properties: { Name: { type: 'title', title: [{ plain_text: title }] } } };
}

function results(pages = [page(second)], next: string | null = null) {
  return { results: pages, has_more: next !== null, next_cursor: next };
}

async function setup(token = 'work-token', parentId = first) {
  const store = createTestApp('Local note stays untouched');
  const plugin = new NotionHandoff(store.app as never, { id: 'notion-handoff', name: 'Notion Handoff', version: '0.1.0', minAppVersion: '1.5.0', author: 'Test', description: 'Test', dir: folder });
  vi.mocked(plugin.loadData).mockResolvedValue({ profiles: [{ name: 'Client', token, parentId }], binary: 'ntn' });
  await plugin.onload();
  const tab = new HandoffSettings(plugin);
  document.body.append(tab.containerEl);
  tab.display();
  const button = (text: string) => Array.from(tab.containerEl.querySelectorAll('button')).find((button) => button.textContent === text)!;
  const status = () => tab.containerEl.querySelector<HTMLElement>('.nh-connection-status')!;
  const input = (label: string) => tab.containerEl.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  return { ...store, plugin, tab, button, status, input, saved: vi.mocked(plugin.saveData) };
}

async function picker(store: Awaited<ReturnType<typeof setup>>) {
  store.button('Choose parent page').click();
  await vi.waitFor(() => expect(Modal.opened).toHaveLength(1));
  return Modal.opened[0];
}

async function choose(modal: Modal, label = 'Project handoffs') {
  await vi.waitFor(() => expect(modal.contentEl.querySelectorAll('button').length).toBeGreaterThan(0));
  Array.from(modal.contentEl.querySelectorAll('button')).find((button) => button.textContent?.startsWith(label))!.click();
}

beforeEach(() => {
  vi.clearAllMocks();
  installDomHelpers();
  Modal.opened = [];
  document.body.replaceChildren();
  mockNotion();
  workspace.mockImplementation(async () => ({ type: 'bot', bot: { workspace_id: 'workspace-default', workspace_name: 'Acme workspace' } }));
  api.mockImplementation(async ({ path }) => path === '/v1/search' ? results() : page(path.split('/').at(-1)!));
});

describe('workspace connection testing and parent-page selection', () => {
  it('makes no requests on display, then tests the actual workspace and configured parent without writes', async () => {
    const store = await setup();
    expect(requestUrl).not.toHaveBeenCalled();
    store.button('Test connection').click();
    expect(store.button('Test connection').disabled).toBe(true);
    await vi.waitFor(() => expect(store.status().textContent).toBe('Connected to Acme workspace. Parent: Project handoffs.'));
    expect(store.status().hidden).toBe(false);
    expect(store.tab.containerEl.querySelector('.nh-parent-setting .setting-item-description')?.textContent).toBe('Project handoffs');
    expect(store.button('Test connection').disabled).toBe(false);
    expect(workspace).toHaveBeenCalledExactlyOnceWith('work-token');
    expect(api).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ path: `/v1/pages/${first}`, method: 'GET', token: 'work-token' }));
    expect(store.saved).not.toHaveBeenCalled();
    expect(store.writes).toEqual([]);
    expect(store.tab.containerEl.textContent).not.toContain('work-token');
  });

  it('tests a token before a parent has been configured', async () => {
    const store = await setup('work-token', '');
    store.button('Test connection').click();
    await vi.waitFor(() => expect(store.status().textContent).toContain('Choose a parent page for new notes'));
    expect(api).not.toHaveBeenCalled();
    expect(store.saved).not.toHaveBeenCalled();
  });

  it('explains a missing token inline without making requests', async () => {
    const store = await setup('');
    store.button('Test connection').click();
    await vi.waitFor(() => expect(store.status().textContent).toBe('Paste a Notion access token first.'));
    expect(store.status().dataset.state).toBe('error');
    expect(requestUrl).not.toHaveBeenCalled();
    expect(store.button('Choose parent page').disabled).toBe(false);
  });

  it('shows token failures inline and clears them when credentials change', async () => {
    workspace.mockRejectedValueOnce(new Error('Invalid access token'));
    const store = await setup();
    store.button('Test connection').click();
    await vi.waitFor(() => expect(store.status().textContent).toContain('Invalid access token'));
    expect(store.status().dataset.state).toBe('error');
    store.input('Notion access token').value = 'replacement';
    store.input('Notion access token').dispatchEvent(new Event('input'));
    expect(store.status().hidden).toBe(true);
    expect(store.saved).toHaveBeenCalledTimes(1);
    expect(store.writes).toEqual([]);
  });

  it('blocks connections inconsistent with notes already bound to the named workspace', async () => {
    const store = await setup();
    store.files.set(`${folder}/note-links.json`, JSON.stringify({ [store.note.path]: { notePath: store.note.path, workspaceName: 'Client', workspaceId: 'other-workspace', pageId: first } }));
    await store.plugin.onload();
    store.tab.display();
    store.button('Choose parent page').click();
    await vi.waitFor(() => expect(store.status().textContent).toContain('different workspace'));
    expect(api).not.toHaveBeenCalled();
    expect(Modal.opened).toEqual([]);
    expect(store.saved).not.toHaveBeenCalled();
    expect(store.writes).toEqual([]);
  });

  it('searches by title, verifies the chosen page, and saves only the parent setting', async () => {
    const store = await setup();
    const modal = await picker(store);
    expect(modal.modalEl.classList.contains('notion-handoff-page-picker')).toBe(true);
    const search = modal.contentEl.querySelector('input')!;
    expect(search.placeholder).toBe('Search pages in Acme workspace');
    expect(store.button('Test connection').disabled).toBe(true);
    search.value = 'Project';
    search.dispatchEvent(new Event('input'));
    await choose(modal);
    await vi.waitFor(() => expect(store.saved).toHaveBeenCalledTimes(1));
    expect(store.plugin.settings.profiles[0]).toEqual({ name: 'Client', token: 'work-token', parentId: second });
    expect(store.input('Parent page ID').value).toBe(second);
    expect(store.tab.containerEl.querySelector('.nh-parent-setting .setting-item-description')?.textContent).toBe('Project handoffs');
    expect(store.status().textContent).toBe('Connected to Acme workspace. Parent: Project handoffs.');
    expect(api.mock.calls.find(([request]) => request.path === '/v1/search')![0].body).toMatchObject({ query: 'Project', page_size: 100, filter: { property: 'object', value: 'page', in_trash: false } });
    expect(api.mock.calls.every(([request]) => request.path === '/v1/search' || request.method === 'GET')).toBe(true);
    expect(store.writes).toEqual([]);
    expect(store.files.get(store.note.path)).toBe('Local note stays untouched');
  });

  it('paginates results, deduplicates pages, and skips inactive pages', async () => {
    api.mockImplementation(async ({ path, body }) => {
      if (path !== '/v1/search') return page(second);
      if (body.start_cursor) return results([page(first), page(second), { ...page('33333333-3333-4333-8333-333333333333'), in_trash: true }]);
      return results([page(first)], 'next-cursor');
    });
    const store = await setup();
    const modal = await picker(store);
    await vi.waitFor(() => expect(modal.contentEl.querySelectorAll('button')).toHaveLength(2));
    expect(api.mock.calls.filter(([request]) => request.path === '/v1/search').map(([request]) => request.body.start_cursor)).toEqual([undefined, 'next-cursor']);
    modal.close();
    await vi.waitFor(() => expect(store.button('Test connection').disabled).toBe(false));
    expect(store.saved).not.toHaveBeenCalled();
  });

  it('supports keyboard selection even when the native prompt closes before its selection callback', async () => {
    const store = await setup();
    const modal = await picker(store);
    await vi.waitFor(() => expect(modal.contentEl.querySelectorAll('button')).toHaveLength(1));
    modal.contentEl.querySelector('input')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await vi.waitFor(() => expect(store.saved).toHaveBeenCalledTimes(1));
    expect(store.plugin.settings.profiles[0].parentId).toBe(second);
  });

  it('cancels before the debounce fires without searching or changing settings', async () => {
    const store = await setup();
    const modal = await picker(store);
    modal.contentEl.querySelector('input')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await vi.waitFor(() => expect(store.button('Choose parent page').disabled).toBe(false));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(api).not.toHaveBeenCalled();
    expect(store.saved).not.toHaveBeenCalled();
    expect(store.plugin.settings.profiles[0].parentId).toBe(first);
  });

  it('offers guidance for an empty result set and lets the user refine an incomplete search', async () => {
    api.mockImplementation(async ({ path, body }) => {
      if (path !== '/v1/search') return page(second);
      if (body.query === 'Empty') return results([]);
      if (!body.query) return { ...results(), request_status: { type: 'incomplete', incomplete_reason: 'query_result_limit_reached' } };
      return results();
    });
    const store = await setup();
    const modal = await picker(store);
    await vi.waitFor(() => expect(modal.contentEl.textContent).toContain('more specific title'));
    const input = modal.contentEl.querySelector('input')!;
    input.value = 'Empty'; input.dispatchEvent(new Event('input'));
    await vi.waitFor(() => expect(modal.contentEl.textContent).toContain('No pages found'));
    input.value = 'Project'; input.dispatchEvent(new Event('input'));
    await choose(modal);
    await vi.waitFor(() => expect(store.saved).toHaveBeenCalledTimes(1));
  });

  it('rejects broken pagination without offering partial results', async () => {
    api.mockResolvedValue({ ...results(), has_more: true, next_cursor: null });
    const store = await setup();
    const modal = await picker(store);
    await vi.waitFor(() => expect(modal.contentEl.textContent).toContain('incomplete page pagination'));
    expect(modal.contentEl.querySelectorAll('button')).toHaveLength(0);
    modal.close();
    expect(store.saved).not.toHaveBeenCalled();
  });

  it('stops pagination and discards a response after the picker closes', async () => {
    let finish = (_response: unknown) => {};
    const response = new Promise((resolve) => { finish = resolve; });
    api.mockImplementation(async () => response);
    const store = await setup();
    const modal = await picker(store);
    await vi.waitFor(() => expect(api).toHaveBeenCalledTimes(1));
    modal.close();
    finish(results([page(second)], 'next-cursor'));
    await vi.waitFor(() => expect(store.button('Choose parent page').disabled).toBe(false));
    expect(api).toHaveBeenCalledTimes(1);
    expect(store.saved).not.toHaveBeenCalled();
  });

  it('ignores stale results after a credential edit', async () => {
    const store = await setup();
    const modal = await picker(store);
    await vi.waitFor(() => expect(modal.contentEl.querySelectorAll('button')).toHaveLength(1));
    store.input('Notion access token').value = 'replacement-token';
    store.input('Notion access token').dispatchEvent(new Event('input'));
    await choose(modal);
    await vi.waitFor(() => expect(store.button('Choose parent page').disabled).toBe(false));
    expect(store.saved).toHaveBeenCalledTimes(1); // The credential edit, not the picker.
    expect(store.plugin.settings.profiles[0].parentId).toBe(first);
    expect(api.mock.calls.some(([request]) => request.path.startsWith('/v1/pages/'))).toBe(false);
  });

  it('ignores a picker whose settings card was rerendered', async () => {
    const store = await setup();
    const modal = await picker(store);
    await vi.waitFor(() => expect(modal.contentEl.querySelectorAll('button')).toHaveLength(1));
    store.tab.display();
    await choose(modal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.saved).not.toHaveBeenCalled();
    expect(store.plugin.settings.profiles[0].parentId).toBe(first);
  });

  it('rechecks page availability before saving a selection', async () => {
    api.mockImplementation(async ({ path }) => path === '/v1/search' ? results() : { ...page(second), in_trash: true });
    const store = await setup();
    const modal = await picker(store);
    await choose(modal);
    await vi.waitFor(() => expect(store.status().textContent).toContain('parent page is unavailable'));
    expect(store.saved).not.toHaveBeenCalled();
    expect(store.plugin.settings.profiles[0].parentId).toBe(first);
  });

  it('ignores older search responses and stops their pagination when the query changes', async () => {
    let finish = (_response: unknown) => {};
    const oldSearch = new Promise((resolve) => { finish = resolve; });
    api.mockImplementation(async ({ path, body }) => path !== '/v1/search' ? page(second) : body.query ? results() : oldSearch);
    const store = await setup();
    const modal = await picker(store);
    await vi.waitFor(() => expect(api).toHaveBeenCalledTimes(1));
    const input = modal.contentEl.querySelector('input')!;
    input.value = 'Project'; input.dispatchEvent(new Event('input'));
    await vi.waitFor(() => expect(modal.contentEl.querySelectorAll('button')).toHaveLength(1));
    finish(results([page(first, 'Old results')], 'old-next-cursor'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(modal.contentEl.textContent).not.toContain('Old results');
    await choose(modal);
    await vi.waitFor(() => expect(store.saved).toHaveBeenCalledTimes(1));
    expect(api.mock.calls.filter(([request]) => request.path === '/v1/search')).toHaveLength(2);
    expect(store.plugin.settings.profiles[0].parentId).toBe(second);
  });

  it('discards a selected page if credentials change during its final verification', async () => {
    let finish = (_response: unknown) => {};
    const verification = new Promise((resolve) => { finish = resolve; });
    api.mockImplementation(async ({ path }) => path === '/v1/search' ? results() : verification);
    const store = await setup();
    const modal = await picker(store);
    await choose(modal);
    await vi.waitFor(() => expect(api.mock.calls.some(([request]) => request.path.startsWith('/v1/pages/'))).toBe(true));
    store.input('Notion access token').value = 'replacement-token';
    store.input('Notion access token').dispatchEvent(new Event('input'));
    finish(page(second));
    await vi.waitFor(() => expect(store.button('Choose parent page').disabled).toBe(false));
    expect(store.saved).toHaveBeenCalledTimes(1);
    expect(store.plugin.settings.profiles[0].parentId).toBe(first);
    expect(store.input('Parent page ID').value).toBe(first);
    expect(store.status().hidden).toBe(true);
  });

  it.each(['partial', 'wrong id', 'unreadable title'])('rejects %s parent metadata before saving', async (kind) => {
    api.mockImplementation(async ({ path }) => {
      if (path === '/v1/search') return results();
      if (kind === 'partial') return { object: 'page', id: second };
      if (kind === 'wrong id') return page(first);
      return { ...page(second), properties: {} };
    });
    const store = await setup();
    const modal = await picker(store);
    await choose(modal);
    await vi.waitFor(() => expect(store.status().dataset.state).toBe('error'));
    expect(store.saved).not.toHaveBeenCalled();
    expect(store.plugin.settings.profiles[0].parentId).toBe(first);
    expect(store.writes).toEqual([]);
  });

  it('rolls back the selected parent when settings cannot be saved', async () => {
    const store = await setup();
    store.saved.mockRejectedValueOnce(new Error('Settings unavailable'));
    const modal = await picker(store);
    await choose(modal);
    await vi.waitFor(() => expect(store.status().textContent).toBe('Settings unavailable'));
    expect(store.status().dataset.state).toBe('error');
    expect(store.plugin.settings.profiles[0].parentId).toBe(first);
    expect(store.input('Parent page ID').value).toBe(first);
    expect(store.writes).toEqual([]);
  });
});
