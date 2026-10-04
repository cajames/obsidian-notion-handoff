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
  private disposers: (() => void)[] = [];
  register(callback: () => void) { this.disposers.push(callback); }
  unload() { for (const dispose of this.disposers.splice(0)) dispose(); }
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

export function debounce<T extends unknown[], V>(callback: (...args: T) => V, timeout = 0, resetTimer = false) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: T | undefined;
  const run = () => {
    clearTimeout(timer);
    timer = undefined;
    const args = pending;
    pending = undefined;
    if (args) return callback(...args);
  };
  const debounced = (...args: T) => {
    pending = args;
    if (!timer || resetTimer) { clearTimeout(timer); timer = setTimeout(run, timeout); }
    return debounced;
  };
  debounced.cancel = () => { clearTimeout(timer); timer = undefined; pending = undefined; return debounced; };
  debounced.run = run;
  return debounced;
}

export class FuzzySuggestModal<T> extends Modal {
  inputEl = document.createElement('input');
  resultContainerEl = document.createElement('div');
  emptyStateText = '';
  setPlaceholder(value: string) { this.inputEl.placeholder = value; }
  setInstructions(_instructions: { command: string; purpose: string }[]) {}
  getItems(): T[] { return []; }
  getItemText(item: T) { return String(item); }
  onChooseItem(_item: T, _event: MouseEvent | KeyboardEvent) {}
  getSuggestions(query: string) {
    return this.getItems().filter((item) => this.getItemText(item).toLowerCase().includes(query.toLowerCase())).map((item) => ({ item }));
  }
  selectSuggestion(value: { item: T }, event: MouseEvent | KeyboardEvent) {
    this.close();
    this.onChooseItem(value.item, event);
  }
  onOpen() {
    this.contentEl.append(this.inputEl, this.resultContainerEl);
    const render = () => {
      const suggestions = this.getSuggestions(this.inputEl.value);
      this.resultContainerEl.replaceChildren();
      if (!suggestions.length) { this.resultContainerEl.textContent = this.emptyStateText; return; }
      for (const suggestion of suggestions) {
        const button = document.createElement('button');
        button.textContent = this.getItemText(suggestion.item);
        button.addEventListener('click', (event) => this.selectSuggestion(suggestion, event));
        this.resultContainerEl.append(button);
      }
    };
    this.inputEl.addEventListener('input', render);
    this.inputEl.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') this.close();
      const selected = this.getSuggestions(this.inputEl.value)[0];
      if (event.key === 'Enter' && selected) this.selectSuggestion(selected, event);
    });
    render();
    this.inputEl.focus();
  }
}

export class ButtonComponent {
  buttonEl = document.createElement('button');
  constructor(container: HTMLElement) { this.buttonEl.type = 'button'; container.append(this.buttonEl); }
  setButtonText(text: string) { this.buttonEl.textContent = text; return this; }
  setCta() { this.buttonEl.classList.add('mod-cta'); return this; }
  setWarning() { this.buttonEl.classList.add('mod-warning'); return this; }
  setDisabled(disabled: boolean) { this.buttonEl.disabled = disabled; return this; }
  setIcon(name: string) { this.buttonEl.dataset.icon = name; this.buttonEl.textContent = name === 'arrow-up' ? '↑' : '↓'; return this; }
  setTooltip(text: string) { this.buttonEl.title = text; return this; }
  onClick(callback: (event: MouseEvent) => void) { this.buttonEl.addEventListener('click', callback); return this; }
}

class TextComponent {
  inputEl = document.createElement('input');
  constructor(container: HTMLElement) { this.inputEl.type = 'text'; container.append(this.inputEl); }
  setPlaceholder(value: string) { this.inputEl.placeholder = value; return this; }
  setValue(value: string) { this.inputEl.value = value; return this; }
  onChange(callback: (value: string) => void) { this.inputEl.addEventListener('input', () => callback(this.inputEl.value)); return this; }
}

class DropdownComponent {
  selectEl = document.createElement('select');
  constructor(container: HTMLElement) { container.append(this.selectEl); }
  addOption(value: string, label: string) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    this.selectEl.append(option);
    return this;
  }
  setValue(value: string) { this.selectEl.value = value; return this; }
  onChange(callback: (value: string) => void) { this.selectEl.addEventListener('change', () => callback(this.selectEl.value)); return this; }
}

export class Setting {
  settingEl = document.createElement('div');
  nameEl = document.createElement('div');
  descEl = document.createElement('div');
  controlEl = document.createElement('div');
  constructor(container: HTMLElement) {
    this.settingEl.className = 'setting-item';
    const info = document.createElement('div');
    info.className = 'setting-item-info';
    this.nameEl.className = 'setting-item-name';
    this.descEl.className = 'setting-item-description';
    this.controlEl.className = 'setting-item-control';
    info.append(this.nameEl, this.descEl);
    this.settingEl.append(info, this.controlEl);
    container.append(this.settingEl);
  }
  setName(text: string) { this.nameEl.textContent = text; return this; }
  setDesc(text: string) { this.descEl.textContent = text; return this; }
  setClass(name: string) { this.settingEl.classList.add(name); return this; }
  addButton(callback: (button: ButtonComponent) => void) { callback(new ButtonComponent(this.controlEl)); return this; }
  addText(callback: (input: TextComponent) => void) { callback(new TextComponent(this.controlEl)); return this; }
  addDropdown(callback: (dropdown: DropdownComponent) => void) { callback(new DropdownComponent(this.controlEl)); return this; }
}

export function setIcon(container: HTMLElement, name: string) { container.setAttribute('data-icon', name); }

export const requestUrl = vi.fn(async (_request: unknown) => ({
  status: 200, headers: { 'content-type': 'image/png' }, arrayBuffer: new Uint8Array([137, 80, 78, 71]).buffer, text: '',
}));

export function installDomHelpers() {
  Reflect.set(HTMLElement.prototype, 'createEl', function (this: HTMLElement, tag: string, options = { text: '' }) {
    const element = document.createElement(tag);
    element.textContent = typeof options === 'string' ? '' : String(options.text ?? '');
    const cls = typeof options === 'string' ? options : Reflect.get(options, 'cls');
    if (cls) element.className = Array.isArray(cls) ? cls.join(' ') : cls;
    const attributes = typeof options === 'string' ? {} : Reflect.get(options, 'attr') ?? {};
    for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, String(value));
    this.append(element);
    return element;
  });
  Reflect.set(HTMLElement.prototype, 'createDiv', function (this: HTMLElement, options = {}) { return this.createEl('div', options); });
  Reflect.set(HTMLElement.prototype, 'createSpan', function (this: HTMLElement, options = { text: '' }) { return this.createEl('span', options); });
  Reflect.set(HTMLElement.prototype, 'empty', function (this: HTMLElement) { this.replaceChildren(); });
  Reflect.set(HTMLElement.prototype, 'setText', function (this: HTMLElement, text: string) { this.textContent = text; });
}
