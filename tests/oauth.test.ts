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

async function setup(boundWorkspaceId = '') {
  const store = createTestApp();
  if (boundWorkspaceId) store.files.set('.obsidian/plugins/notion-handoff/note-links.json', JSON.stringify({
    [store.note.path]: { notePath: store.note.path, workspaceName: 'Default', workspaceId: boundWorkspaceId, pageId: 'page-id' },
  }));
  const plugin = new NotionHandoff(store.app as never, { id: 'notion-handoff', name: 'Notion Handoff', version: '0.1.0', minAppVersion: '1.5.0', author: 'Test', description: 'Test' });
  await plugin.onload();
  const profile = plugin.settings.profiles[0];
  const callback = Reflect.get(plugin, 'protocolHandlers').get('notion-handoff-oauth');
  return { ...store, plugin, profile, callback, saved: vi.mocked(plugin.saveData) };
}

beforeEach(() => {
  vi.clearAllMocks();
  installDomHelpers();
  Notice.messages = [];
  state = '';
  redeem.mockReset().mockResolvedValue({ access_token: 'ntn_oauth', workspace_id: workspaceId, workspace_name: 'Client Notion' });
  vi.spyOn(window, 'open').mockReturnValue(null);
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
  });
});
