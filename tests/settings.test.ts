// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import NotionHandoff from '../src/main';
import HandoffSettings from '../src/settings';
import { createTestApp, installDomHelpers, requestUrl } from './helpers/obsidian';

function setup(folder = '', profiles = [{ name: 'Client', token: 'test-token', parentId: 'parent-id' }]) {
  const store = createTestApp();
  const plugin = new NotionHandoff(store.app as never, { id: 'notion-handoff', name: 'Notion Handoff', version: '0.1.0', minAppVersion: '1.5.0', author: 'Test', description: 'Test' });
  plugin.settings = { profiles, imageImportFolder: folder };
  const tab = new HandoffSettings(plugin);
  document.body.append(tab.containerEl);
  tab.display();
  const input = (label: string) => tab.containerEl.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  const location = () => tab.containerEl.querySelector('select')!;
  const changeLocation = (value: string) => {
    location().value = value;
    location().dispatchEvent(new Event('change'));
  };
  const changeInput = (label: string, value: string) => {
    input(label).value = value;
    input(label).dispatchEvent(new Event('input'));
  };
  const button = (text: string) => Array.from(tab.containerEl.querySelectorAll('button')).find((button) => button.textContent === text)!;
  const saved = vi.mocked(Reflect.get(plugin, 'saveData'));
  return { ...store, plugin, tab, input, location, changeLocation, changeInput, button, saved };
}

beforeEach(() => {
  vi.clearAllMocks();
  installDomHelpers();
  document.body.replaceChildren();
});
afterEach(() => { document.head.querySelectorAll('style[data-notion-handoff]').forEach((style) => style.remove()); });

describe('workspace and image settings', () => {
  it('groups workspaces, masks tokens, and renders without rewriting credentials or sync state', () => {
    const profiles = [
      { name: 'Client', token: 'private-token-one', parentId: 'parent-one' },
      { name: 'Other client', token: 'private-token-two', parentId: 'parent-two' },
    ];
    const store = setup('', profiles);
    const cards = Array.from(store.tab.containerEl.querySelectorAll<HTMLDetailsElement>('.nh-profile'));
    expect(cards.map((card) => card.open)).toEqual([true, false]);
    expect(cards[0].querySelector('.nh-profile-name')?.textContent).toBe('Client');
    expect(store.tab.containerEl.querySelectorAll('.nh-badge')).toHaveLength(0);
    expect(store.input('Notion access token').type).toBe('password');
    expect(store.input('Notion access token').placeholder).toBe('ntn_…');
    expect(store.tab.containerEl.textContent).toContain('Integration token or OAuth access token');
    expect(store.tab.containerEl.textContent).not.toContain('private-token');
    expect(store.plugin.settings.profiles).toEqual(profiles);
    expect(store.saved).not.toHaveBeenCalled();
    expect(store.writes).toEqual([]);
    expect(requestUrl).not.toHaveBeenCalled();
  });

  it('updates the workspace heading without replacing the focused input', async () => {
    const store = setup();
    const input = store.input('Workspace name');
    input.focus();
    store.changeInput('Workspace name', 'Client "A"');
    await vi.waitFor(() => expect(store.saved).toHaveBeenCalledTimes(1));
    expect(store.tab.containerEl.querySelector('.nh-profile-name')?.textContent).toBe('Client "A"');
    expect(store.tab.containerEl.querySelector('code')).toBeNull();
    expect(store.input('Workspace name')).toBe(input);
    expect(document.activeElement).toBe(input);
    expect(store.plugin.settings.profiles[0].token).toBe('test-token');
  });

  it('adds an expanded workspace and focuses its name without assigning a default', async () => {
    const store = setup();
    expect(store.button('Remove profile').disabled).toBe(true);
    store.button('Add workspace').click();
    await vi.waitFor(() => expect(store.tab.containerEl.querySelectorAll('.nh-profile')).toHaveLength(2));
    const cards = Array.from(store.tab.containerEl.querySelectorAll<HTMLDetailsElement>('.nh-profile'));
    expect(cards[1].open).toBe(true);
    expect(document.activeElement).toBe(cards[1].querySelector('input'));
    expect(store.plugin.settings.profiles.map((profile) => profile.name)).toEqual(['Client', 'Workspace 2']);
    expect(store.tab.containerEl.querySelectorAll('.nh-badge')).toHaveLength(0);
    store.button('Remove profile').click();
    await vi.waitFor(() => expect(store.tab.containerEl.querySelectorAll('.nh-profile')).toHaveLength(1));
    expect(store.plugin.settings.profiles[0].name).toBe('Workspace 2');
    expect(store.button('Remove profile').disabled).toBe(true);
    expect(store.files.get(store.note.path)).toContain('Local body');
    expect(store.writes).toEqual([]);
  });

  it('reorders workspaces using adjacent swaps without changing credentials or notes', async () => {
    const profiles = [
      { name: 'First', token: 'one', parentId: 'parent-one' },
      { name: 'Second', token: 'two', parentId: 'parent-two' },
      { name: 'Third', token: 'three', parentId: 'parent-three' },
    ];
    const originals = profiles.map((profile) => ({ ...profile }));
    const store = setup('', profiles);
    const up = store.tab.containerEl.querySelector<HTMLButtonElement>('[aria-label="Move First up"]')!;
    const down = store.tab.containerEl.querySelector<HTMLButtonElement>('[aria-label="Move Third down"]')!;
    expect(up.disabled).toBe(true);
    expect(down.disabled).toBe(true);
    store.tab.containerEl.querySelector<HTMLButtonElement>('[aria-label="Move Third up"]')!.click();
    await vi.waitFor(() => expect(store.saved).toHaveBeenCalledTimes(1));
    expect(store.plugin.settings.profiles).toEqual([originals[0], originals[2], originals[1]]);
    expect(Array.from(store.tab.containerEl.querySelectorAll('.nh-profile-name')).map((el) => el.textContent)).toEqual(['First', 'Third', 'Second']);
    store.tab.containerEl.querySelector<HTMLButtonElement>('[aria-label="Move First down"]')!.click();
    await vi.waitFor(() => expect(store.saved).toHaveBeenCalledTimes(2));
    expect(store.plugin.settings.profiles).toEqual([originals[2], originals[0], originals[1]]);
    expect(store.writes).toEqual([]);
    expect(requestUrl).not.toHaveBeenCalled();
    expect(store.tab.containerEl.textContent).not.toContain('Default');
  });

  it.each([['', 'obsidian', true], ['Assets/Notion', 'custom', false], ['/', 'root', true]])(
    'presents saved folder %j as %s without changing it', (folder, mode, hidden) => {
      const store = setup(folder);
      expect(store.location().value).toBe(mode);
      expect(store.input('Imported images folder').closest<HTMLElement>('.setting-item')!.hidden).toBe(hidden);
      expect(store.plugin.settings.imageImportFolder).toBe(folder);
      expect(store.saved).not.toHaveBeenCalled();
    },
  );

  it('switches between attachment defaults, custom folders and vault root while retaining the draft', async () => {
    const store = setup('Assets/Notion');
    store.changeLocation('root');
    await vi.waitFor(() => expect(store.saved).toHaveBeenCalledTimes(1));
    expect(store.plugin.settings.imageImportFolder).toBe('/');
    expect(store.input('Imported images folder').closest<HTMLElement>('.setting-item')!.hidden).toBe(true);
    store.changeLocation('obsidian');
    await vi.waitFor(() => expect(store.saved).toHaveBeenCalledTimes(2));
    expect(store.plugin.settings.imageImportFolder).toBe('');
    store.changeLocation('custom');
    await vi.waitFor(() => expect(store.saved).toHaveBeenCalledTimes(3));
    expect(store.plugin.settings.imageImportFolder).toBe('Assets/Notion');
    expect(document.activeElement).toBe(store.input('Imported images folder'));
    expect(store.folders.has('Assets')).toBe(false);
    expect(store.writes).toEqual([]);
  });

  it('shows invalid paths inline without saving them and clears the error when corrected', async () => {
    const store = setup('Assets/Notion');
    store.changeInput('Imported images folder', '../outside');
    expect(store.input('Imported images folder').getAttribute('aria-invalid')).toBe('true');
    expect(store.tab.containerEl.querySelector<HTMLElement>('#notion-handoff-folder-error')!.hidden).toBe(false);
    expect(store.plugin.settings.imageImportFolder).toBe('Assets/Notion');
    expect(store.saved).not.toHaveBeenCalled();
    store.changeInput('Imported images folder', 'Client assets');
    await vi.waitFor(() => expect(store.saved).toHaveBeenCalledTimes(1));
    expect(store.input('Imported images folder').hasAttribute('aria-invalid')).toBe(false);
    expect(store.tab.containerEl.querySelector<HTMLElement>('#notion-handoff-folder-error')!.hidden).toBe(true);
    expect(store.plugin.settings.imageImportFolder).toBe('Client assets');
  });

  it('keeps manual parent IDs under Advanced and makes the picker primary without saving settings', () => {
    const store = setup();
    const advanced = store.tab.containerEl.querySelector<HTMLDetailsElement>('.nh-advanced')!;
    expect(advanced.open).toBe(false);
    expect(advanced.contains(store.input('Parent page ID'))).toBe(true);
    expect(store.button('Choose parent page').classList.contains('mod-cta')).toBe(true);
    expect(store.tab.containerEl.querySelector('code')).toBeNull();
    expect(store.tab.containerEl.querySelector('.nh-profile-footer')?.textContent).not.toContain('notion_workspace');
    expect(store.plugin.settings.profiles[0].parentId).toBe('parent-id');
    expect(store.saved).not.toHaveBeenCalled();
    expect(requestUrl).not.toHaveBeenCalled();
    advanced.open = true;
    store.changeInput('Parent page ID', 'replacement-page');
    expect(store.plugin.settings.profiles[0].parentId).toBe('replacement-page');
    expect(store.saved).toHaveBeenCalledTimes(1);
  });

  it('loads bundled scoped styles and removes them when the plugin unloads', async () => {
    const store = setup();
    await store.plugin.onload();
    const style = document.head.querySelector('style[data-notion-handoff]');
    expect(style?.textContent).toContain('.notion-handoff-settings');
    expect(style?.textContent).toContain('.notion-handoff-push');
    store.plugin.unload();
    expect(style?.isConnected).toBe(false);
  });
});
