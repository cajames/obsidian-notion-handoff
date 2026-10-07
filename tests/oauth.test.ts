// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import NotionHandoff from '../src/main';
import HandoffSettings from '../src/settings';
import { AUTH_ORIGIN, oauthChallenge } from '../src/oauth';
import { jsonResponse } from './helpers/notion';
import { createTestApp, installDomHelpers, Notice, requestUrl } from './helpers/obsidian';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const handoff = 'a'.repeat(64);
let state = '';
const redeem = vi.fn(async () => ({ access_token: 'ntn_oauth', workspace_id: workspaceId, workspace_name: 'Client Notion' }));
const copyLink = vi.fn(async (_url = '') => {});
const unloadPlugins = [() => {}];

async function setup(boundWorkspaceId = '') {
  const store = createTestApp();
  if (boundWorkspaceId) store.files.set('.obsidian/plugins/notion-handoff/note-links.json', JSON.stringify({
    [store.note.path]: { notePath: store.note.path, workspaceName: 'Default', workspaceId: boundWorkspaceId, pageId: 'page-id' },
  }));
  const plugin = new NotionHandoff(store.app as never, { id: 'notion-handoff', name: 'Notion Handoff', version: '0.1.0', minAppVersion: '1.5.0', author: 'Test', description: 'Test' });
  await plugin.onload();
  unloadPlugins.push(() => plugin.unload());
  const profile = plugin.settings.profiles[0];
  const callback = Reflect.get(plugin, 'protocolHandlers').get('notion-handoff-oauth');
  const showSettings = () => {
    const tab = new HandoffSettings(plugin);
    document.body.append(tab.containerEl);
    tab.display();
    const button = (name = '') => Array.from(tab.containerEl.querySelectorAll('button')).find((button) => button.textContent === name)!;
    return { tab, button };
  };
  return { ...store, plugin, profile, callback, showSettings, saved: vi.mocked(plugin.saveData) };
}

beforeEach(() => {
  vi.clearAllMocks();
  installDomHelpers();
  Notice.messages = [];
  state = '';
  redeem.mockReset().mockResolvedValue({ access_token: 'ntn_oauth', workspace_id: workspaceId, workspace_name: 'Client Notion' });
  vi.spyOn(window, 'open').mockReturnValue(null);
  copyLink.mockReset().mockResolvedValue(undefined);
  vi.spyOn(navigator.clipboard, 'writeText').mockImplementation(copyLink);
  vi.mocked(requestUrl).mockImplementation(async (input) => {
    const request = Object(input);
    if (request.url === `${AUTH_ORIGIN}/notion/start`) {
      const data = JSON.parse(request.body);
      state = data.state;
      const url = new URL('https://api.notion.com/v1/oauth/authorize');
      url.search = new URLSearchParams({ state, redirect_uri: `${AUTH_ORIGIN}/notion/callback`, response_type: 'code', owner: 'user', client_id: 'test-client' }).toString();
      return jsonResponse({ authorizeUrl: url.href });
    }
    if (request.url === `${AUTH_ORIGIN}/notion/redeem`) return jsonResponse(await redeem());
    if (request.url === 'https://api.notion.com/v1/users/me') {
      return jsonResponse({ type: 'bot', bot: { workspace_id: workspaceId, workspace_name: 'Client Notion' } });
    }
    throw new Error('Unexpected request');
  });
});
afterEach(() => {
  for (const unload of unloadPlugins.splice(0)) unload();
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.head.querySelectorAll('style[data-notion-handoff]').forEach((style) => style.remove());
  document.body.replaceChildren();
});

describe('Notion OAuth connection', () => {
  it('opens Notion with random state, keeps proof local, and does not save until completion', async () => {
    const store = await setup();
    await store.plugin.connectNotion(store.profile);
    const start = Object(vi.mocked(requestUrl).mock.calls[0][0]);
    const data = JSON.parse(start.body);
    expect(data.state).toMatch(/^[a-f0-9]{64}$/);
    expect(data.challenge).toMatch(/^[a-f0-9]{64}$/);
    expect(data.verifier).toBeUndefined();
    expect(window.open).toHaveBeenCalledWith(expect.stringContaining('https://api.notion.com/v1/oauth/authorize?'), '_blank', 'noopener,noreferrer');
    expect(store.saved).not.toHaveBeenCalled();
    expect(store.writes).toEqual([]);
    store.callback({ state, handoff });
    await vi.waitFor(() => expect(store.saved).toHaveBeenCalledTimes(1));
    const redemption = Object(vi.mocked(requestUrl).mock.calls[1][0]);
    expect(oauthChallenge(JSON.parse(redemption.body).verifier)).toBe(data.challenge);
    expect(store.profile.token).toBe('ntn_oauth');
    expect(store.profile.name).toBe('Default');
    expect(store.profile.parentId).toBe('parent-id');
    expect(Reflect.get(store.profile, 'oauthWorkspaceId')).toBe(workspaceId);
    expect(store.writes).toEqual([]);
    expect(Notice.messages.join(' ')).toContain('Connected to Client Notion');
    expect(JSON.stringify(vi.mocked(window.open).mock.calls)).not.toContain('ntn_oauth');
  });

  it('ignores unsolicited, wrong-state, concurrent and replayed callbacks', async () => {
    const store = await setup();
    store.callback({ state: 'unknown', handoff });
    expect(requestUrl).not.toHaveBeenCalled();
    await store.plugin.connectNotion(store.profile);
    store.callback({ state: 'b'.repeat(64), handoff });
    expect(redeem).not.toHaveBeenCalled();
    store.callback({ state, handoff });
    store.callback({ state, handoff });
    await vi.waitFor(() => expect(store.saved).toHaveBeenCalledTimes(1));
    store.callback({ state, handoff });
    expect(redeem).toHaveBeenCalledTimes(1);
  });

  it('handles denied authorization without changing credentials or making a redemption request', async () => {
    const store = await setup();
    await store.plugin.connectNotion(store.profile);
    store.callback({ state, error: 'denied' });
    await vi.waitFor(() => expect(Notice.messages.join(' ')).toContain('cancelled'));
    expect(redeem).not.toHaveBeenCalled();
    expect(store.saved).not.toHaveBeenCalled();
    expect(store.profile.token).toBe('test-token');
  });

  it.each(['name', 'token', 'parentId'])('rejects a callback after %s changed', async (field) => {
    const store = await setup();
    await store.plugin.connectNotion(store.profile);
    Reflect.set(store.profile, field, 'edited');
    store.callback({ state, handoff });
    await vi.waitFor(() => expect(Notice.messages.join(' ')).toContain('settings changed'));
    expect(redeem).not.toHaveBeenCalled();
    expect(store.saved).not.toHaveBeenCalled();
  });

  it('rejects a removed profile and invalidates an older attempt', async () => {
    const store = await setup();
    await store.plugin.connectNotion(store.profile);
    const oldState = state;
    await store.plugin.connectNotion(store.profile);
    store.callback({ state: oldState, handoff });
    expect(redeem).not.toHaveBeenCalled();
    store.plugin.settings.profiles = [];
    store.callback({ state, handoff });
    expect(store.saved).not.toHaveBeenCalled();
  });

  it('does not apply a token if settings change while redeeming', async () => {
    const store = await setup();
    let resolve = () => {};
    redeem.mockImplementationOnce(() => new Promise((done) => { resolve = () => done({ access_token: 'ntn_oauth', workspace_id: workspaceId, workspace_name: 'Client Notion' }); }));
    await store.plugin.connectNotion(store.profile);
    store.callback({ state, handoff });
    await vi.waitFor(() => expect(redeem).toHaveBeenCalledTimes(1));
    store.profile.parentId = 'changed';
    resolve();
    await vi.waitFor(() => expect(Notice.messages.join(' ')).toContain('settings changed'));
    expect(store.saved).not.toHaveBeenCalled();
    expect(store.profile.token).toBe('test-token');
  });

  it('refuses OAuth workspace changes for an already pinned profile', async () => {
    const store = await setup();
    Reflect.set(store.profile, 'oauthWorkspaceId', '22222222-2222-4222-8222-222222222222');
    await store.plugin.connectNotion(store.profile);
    store.callback({ state, handoff });
    await vi.waitFor(() => expect(Notice.messages.join(' ')).toContain('separate profile'));
    expect(store.saved).not.toHaveBeenCalled();
    expect(store.profile.token).toBe('test-token');
  });

  it('preserves existing note bindings when authorization returns a different workspace', async () => {
    const store = await setup('22222222-2222-4222-8222-222222222222');
    await store.plugin.connectNotion(store.profile);
    store.callback({ state, handoff });
    await vi.waitFor(() => expect(Notice.messages.join(' ')).toContain('different workspace'));
    expect(store.saved).not.toHaveBeenCalled();
    expect(store.profile.token).toBe('test-token');
    expect(store.writes).toEqual([]);
  });

  it('rejects expired attempts and unsafe authorization URLs', async () => {
    const store = await setup();
    await store.plugin.connectNotion(store.profile);
    Reflect.get(store.plugin, 'oauthAttempt').expires = Date.now() - 1;
    store.callback({ state, handoff });
    expect(redeem).not.toHaveBeenCalled();
    expect(store.saved).not.toHaveBeenCalled();
    vi.mocked(requestUrl).mockResolvedValueOnce(jsonResponse({ authorizeUrl: 'https://evil.example/oauth' }));
    await expect(store.plugin.connectNotion(store.profile)).rejects.toThrow('invalid authorization URL');
    expect(window.open).toHaveBeenCalledTimes(1);
  });

  it('retains old credentials on save failure and clears the pending attempt on unload', async () => {
    const store = await setup();
    store.saved.mockRejectedValueOnce(new Error('Disk unavailable'));
    await store.plugin.connectNotion(store.profile);
    store.callback({ state, handoff });
    await vi.waitFor(() => expect(Notice.messages.join(' ')).toContain('Disk unavailable'));
    expect(store.profile.token).toBe('test-token');
    await store.plugin.connectNotion(store.profile);
    store.plugin.unload();
    store.callback({ state, handoff });
    expect(redeem).toHaveBeenCalledTimes(1);
  });

  it('shows Copy link only after Connect and copies the same authorization without new requests or persistence', async () => {
    vi.useFakeTimers();
    const store = await setup();
    const { tab, button } = store.showSettings();
    const copy = button('Copy link');
    expect(copy.hidden).toBe(true);
    expect(copy.parentElement).toBe(button('Connect to Notion').parentElement);
    button('Connect to Notion').click();
    await vi.waitFor(() => expect(copy.hidden).toBe(false));
    const url = vi.mocked(window.open).mock.calls[0][0];
    expect(store.plugin.notionConnectionUrl(store.profile)).toBe(url);
    expect(copy.getAttribute('aria-label')).toBe('Copy Notion authorization link for Default');
    copy.click();
    await vi.waitFor(() => expect(copy.textContent).toBe('Copied'));
    expect(copyLink).toHaveBeenCalledExactlyOnceWith(url);
    expect(requestUrl).toHaveBeenCalledTimes(1);
    expect(window.open).toHaveBeenCalledTimes(1);
    expect(store.saved).not.toHaveBeenCalled();
    expect(store.writes).toEqual([]);
    await vi.advanceTimersByTimeAsync(2000);
    expect(copy.textContent).toBe('Copy link');
    tab.display();
    expect(button('Copy link').hidden).toBe(false);
  });

  it('hides Copy link on expiry without another browser or network request', async () => {
    vi.useFakeTimers();
    const store = await setup();
    const { button } = store.showSettings();
    await store.plugin.connectNotion(store.profile);
    const copy = button('Copy link');
    expect(copy.hidden).toBe(false);
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(copy.hidden).toBe(true);
    expect(store.plugin.notionConnectionUrl(store.profile)).toBe('');
    expect(Reflect.get(store.plugin, 'oauthAttempt').authorizeUrl).toBe('');
    copy.click();
    expect(copyLink).not.toHaveBeenCalled();
    expect(requestUrl).toHaveBeenCalledTimes(1);
  });

  it.each(['Workspace name', 'Notion access token', 'Parent page ID'])('hides Copy link when %s changes', async (label) => {
    const store = await setup();
    const { tab, button } = store.showSettings();
    await store.plugin.connectNotion(store.profile);
    const copy = button('Copy link');
    const input = Array.from(tab.containerEl.querySelectorAll('input')).find((input) => input.getAttribute('aria-label') === label)!;
    input.value = 'changed';
    input.dispatchEvent(new Event('input'));
    expect(copy.hidden).toBe(true);
    expect(store.plugin.notionConnectionUrl(store.profile)).toBe('');
    copy.click();
    expect(copyLink).not.toHaveBeenCalled();
  });

  it('replaces the copied link on reconnect and only shows it for the originating profile', async () => {
    const store = await setup();
    const other = { name: 'Other', token: '', parentId: '' };
    store.plugin.settings.profiles.push(other);
    const { tab } = store.showSettings();
    const copies = Array.from(tab.containerEl.querySelectorAll('button')).filter((button) => button.textContent === 'Copy link');
    await store.plugin.connectNotion(store.profile);
    expect(copies.map((button) => button.hidden)).toEqual([false, true]);
    const oldUrl = store.plugin.notionConnectionUrl(store.profile);
    await store.plugin.connectNotion(store.profile);
    copies[0].click();
    await vi.waitFor(() => expect(copyLink).toHaveBeenCalledTimes(1));
    expect(copyLink.mock.calls[0][0]).not.toBe(oldUrl);
    await store.plugin.connectNotion(other);
    expect(copies.map((button) => button.hidden)).toEqual([true, false]);
    copies[1].click();
    await vi.waitFor(() => expect(copyLink).toHaveBeenCalledTimes(2));
    expect(copyLink.mock.calls[1][0]).toBe(store.plugin.notionConnectionUrl(other));
  });

  it.each(['completed', 'denied', 'unloaded', 'removed'])('hides Copy link for a %s attempt', async (outcome) => {
    const store = await setup();
    const { tab, button } = store.showSettings();
    await store.plugin.connectNotion(store.profile);
    const copy = button('Copy link');
    expect(copy.hidden).toBe(false);
    if (outcome === 'completed') store.callback({ state, handoff });
    if (outcome === 'denied') store.callback({ state, error: 'denied' });
    if (outcome === 'unloaded') store.plugin.unload();
    if (outcome === 'removed') {
      store.plugin.settings.profiles = [];
      tab.display();
      expect(copy.isConnected).toBe(false);
    } else {
      await vi.waitFor(() => expect(copy.hidden).toBe(true));
    }
    expect(store.plugin.notionConnectionUrl(store.profile)).toBe('');
    copy.click();
    expect(copyLink).not.toHaveBeenCalled();
    if (outcome === 'completed') await vi.waitFor(() => expect(store.saved).toHaveBeenCalledTimes(1));
  });

  it('reports clipboard failure without losing the active link or starting another connection', async () => {
    const store = await setup();
    const { tab, button } = store.showSettings();
    await store.plugin.connectNotion(store.profile);
    copyLink.mockRejectedValueOnce(new Error('Permission denied'));
    button('Copy link').click();
    await vi.waitFor(() => expect(tab.containerEl.textContent).toContain('Check clipboard permissions'));
    expect(button('Copy link').hidden).toBe(false);
    expect(requestUrl).toHaveBeenCalledTimes(1);
    expect(store.saved).not.toHaveBeenCalled();
  });

  it('hiding settings cancels copied feedback and restores the active link on reopening', async () => {
    vi.useFakeTimers();
    const store = await setup();
    const { tab, button } = store.showSettings();
    await store.plugin.connectNotion(store.profile);
    const copy = button('Copy link');
    copy.click();
    await vi.waitFor(() => expect(copy.textContent).toBe('Copied'));
    tab.hide();
    await vi.advanceTimersByTimeAsync(2000);
    expect(copy.hidden).toBe(true);
    tab.display();
    expect(button('Copy link').hidden).toBe(false);
  });

  it('shows an undeployed service error inline, without opening a browser or rewriting settings', async () => {
    const store = await setup();
    vi.mocked(requestUrl).mockResolvedValueOnce(jsonResponse({ error: 'Notion sign-in is not configured yet.' }, 503));
    const tab = new HandoffSettings(store.plugin);
    document.body.append(tab.containerEl);
    tab.display();
    const button = Array.from(tab.containerEl.querySelectorAll('button')).find((button) => button.textContent === 'Connect to Notion')!;
    button.click();
    await vi.waitFor(() => expect(tab.containerEl.textContent).toContain('Notion sign-in is not configured yet.'));
    expect(window.open).not.toHaveBeenCalled();
    expect(store.saved).not.toHaveBeenCalled();
    expect(button.disabled).toBe(false);
    expect(Array.from(tab.containerEl.querySelectorAll('button')).find((button) => button.textContent === 'Copy link')?.hidden).toBe(true);
    expect(store.plugin.notionConnectionUrl(store.profile)).toBe('');
  });
});
