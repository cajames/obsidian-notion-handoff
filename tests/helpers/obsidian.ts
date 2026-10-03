import { vi } from 'vitest';

export class TFile {
  name;
  basename;
  extension;
  stat = { size: 10 };
  constructor(public path: string) {
    this.name = path.split('/').at(-1)!;
    this.extension = this.name.split('.').at(-1)!;
    this.basename = this.name.slice(0, -(this.extension.length + 1));
  }
}

export function createTestApp(source = '---\nnotion_id: page-id\n---\nLocal body') {
  const note = new TFile('Notes/Test.md');
  const files = new Map([[note.path, source]]);
  const binaries = new Map<string, ArrayBuffer>();
  const folders = new Set(['.obsidian/plugins/notion-handoff', 'Notes']);
  const writes: string[] = [];
  const adapter = {
    exists: vi.fn(async (path: string) => files.has(path) || binaries.has(path) || folders.has(path)),
    read: vi.fn(async (path: string) => {
      if (!files.has(path)) throw new Error('File missing');
      return files.get(path)!;
    }),
    write: vi.fn(async (path: string, contents: string) => { files.set(path, contents); writes.push(path); }),
    mkdir: vi.fn(async (path: string) => { folders.add(path); }),
  };
  const app = {
    workspace: { getActiveFile: vi.fn(() => note) },
    metadataCache: {
      getCache: vi.fn((_path: string) => null as { frontmatter: Record<string, unknown> } | null),
      getFirstLinkpathDest: vi.fn((link: string) => {
        const path = [...files.keys()].find((path) => path.endsWith(`/${link}`) || path.endsWith(`/${link}.md`));
        return path ? new TFile(path) : null;
      }),
    },
    plugins: { getPlugin: vi.fn(() => null) },
    vault: {
      configDir: '.obsidian', adapter,
      getConfig: vi.fn((_key: string) => 'Attachments'),
      read: vi.fn(async (file: { path: string }) => files.get(file.path)!),
      readBinary: vi.fn(async (file: { path: string }) => binaries.get(file.path) ?? new Uint8Array([1]).buffer),
      createFolder: vi.fn(async (path: string) => { folders.add(path); return { path }; }),
      createBinary: vi.fn(async (path: string, bytes: ArrayBuffer) => {
        binaries.set(path, bytes); writes.push(path); return new TFile(path);
      }),
      process: vi.fn(async (file: { path: string }, update: (source: string) => string) => {
        const next = update(files.get(file.path)!);
        files.set(file.path, next); writes.push(file.path); return next;
      }),
      getAbstractFileByPath: vi.fn((path: string) => files.has(path) || binaries.has(path) ? new TFile(path) : null),
      getMarkdownFiles: vi.fn(() => [...files.keys()].filter((path) => path.endsWith('.md')).map((path) => new TFile(path))),
    },
  };
  return { app, note, files, binaries, folders, writes };
}

export class Plugin {
  commands: { id: string; name: string; callback: () => void }[] = [];
  loadData = vi.fn(async () => ({ profiles: [{ name: 'Default', token: 'test-token', parentId: 'parent-id' }], binary: 'ntn' }));
  saveData = vi.fn(async (_data: unknown) => {});
  constructor(public app = createTestApp().app, public manifest = { id: 'notion-handoff', dir: '.obsidian/plugins/notion-handoff' }) {}
  addCommand(command: (typeof this.commands)[number]) { this.commands.push(command); }
  addSettingTab(_tab: unknown) {}
}

export class Component {
  load() {}
  unload() {}
  addChild(child: { load: () => void }) { child.load(); return child; }
}

export class Notice {
  static messages: string[] = [];
  constructor(message: string) { Notice.messages.push(message); }
}

export class PluginSettingTab {
  containerEl = document.createElement('div');
  constructor(public app: unknown, public plugin: unknown) {}
}

export class Modal {
  static opened: Modal[] = [];
  contentEl = document.createElement('div');
  modalEl = document.createElement('div');
  private opened = false;
  constructor(public app: unknown) {}
  onOpen() {}
  onClose() {}
  open() { this.opened = true; Modal.opened.push(this); document.body.append(this.contentEl); this.onOpen(); }
  close() { if (!this.opened) return; this.opened = false; this.onClose(); this.contentEl.remove(); }
}

class Button {
  buttonEl = document.createElement('button');
  constructor(container: HTMLElement) { container.append(this.buttonEl); }
  setButtonText(text: string) { this.buttonEl.textContent = text; return this; }
  setCta() { return this; }
  setWarning() { return this; }
  setDisabled(disabled: boolean) { this.buttonEl.disabled = disabled; return this; }
  onClick(callback: () => void) { this.buttonEl.addEventListener('click', callback); return this; }
}

export class Setting {
  constructor(private container: HTMLElement) {}
  addButton(callback: (button: Button) => void) { callback(new Button(this.container)); return this; }
}

export const requestUrl = vi.fn(async (_request: unknown) => ({
  status: 200, headers: { 'content-type': 'image/png' }, arrayBuffer: new Uint8Array([137, 80, 78, 71]).buffer, text: '',
}));

export function installDomHelpers() {
  Reflect.set(HTMLElement.prototype, 'createEl', function (this: HTMLElement, tag: string, options = { text: '' }) {
    const element = document.createElement(tag);
    element.textContent = typeof options === 'string' ? options : String(options.text ?? '');
    this.append(element);
    return element;
  });
  Reflect.set(HTMLElement.prototype, 'createDiv', function (this: HTMLElement) { return this.createEl('div'); });
  Reflect.set(HTMLElement.prototype, 'createSpan', function (this: HTMLElement, options = { text: '' }) { return this.createEl('span', options); });
  Reflect.set(HTMLElement.prototype, 'empty', function (this: HTMLElement) { this.replaceChildren(); });
  Reflect.set(HTMLElement.prototype, 'setText', function (this: HTMLElement, text: string) { this.textContent = text; });
}
