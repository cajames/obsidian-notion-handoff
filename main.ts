import { Notice, Plugin, PluginSettingTab, Setting, TFile } from 'obsidian';
import { createArgs, createPayload, markdownArgs, pushPage, runNtn } from './cli';
import { parseNote, toNotionMarkdown, writeNotionId } from './note';

const DEFAULT_SETTINGS = { token: '', parentId: '', binary: 'ntn' };

export default class NtnSync extends Plugin {
  settings = { ...DEFAULT_SETTINGS };
  private pushing = false;

  async onload() {
    this.settings = { ...DEFAULT_SETTINGS, ...await this.loadData() };
    this.addSettingTab(new NtnSettings(this));
    this.addCommand({
      id: 'push-to-notion',
      name: 'Push to Notion',
      callback: () => { void this.pushCurrentNote(); },
    });
  }

  private async pushCurrentNote() {
    if (this.pushing) { new Notice('A Notion push is already in progress.'); return; }
    const file = this.app.workspace.getActiveFile();
    if (!(file instanceof TFile) || file.extension !== 'md') {
      new Notice('Open a Markdown note to push to Notion.');
      return;
    }
    this.pushing = true;
    try {
      await this.push(file);
      new Notice(`Pushed ${file.basename} to Notion.`);
    } catch (error) {
      new Notice(`Notion push failed: ${error instanceof Error ? error.message : String(error)}`, 10000);
    } finally {
      this.pushing = false;
    }
  }

  private async push(file: TFile) {
    const source = await this.app.vault.read(file);
    const note = parseNote(source);
    const token = this.settings.token.trim();
    const parentId = this.settings.parentId.trim();
    if (!token) throw new Error('Add a Notion API token in Notion Sync settings.');
    if (!note.notionId && !parentId) throw new Error('Add a default parent page ID in Notion Sync settings.');
    const binary = this.settings.binary.trim() || 'ntn';
    const run = (args: string[], stdin?: string) => runNtn(binary, token, args, stdin);
    // Preflight before any writes. ENOENT maps to an actionable install message.
    await run(['--version']);

    let pageId = note.notionId;
    if (!pageId) {
      const result = await run(createArgs(), JSON.stringify(createPayload(parentId, file.basename)));
      let response;
      try { response = JSON.parse(result); }
      catch { throw new Error('ntn returned an invalid page creation response.'); }
      if (typeof response?.id !== 'string' || !response.id) throw new Error('ntn did not return a page ID.');
      const newId = String(response.id);
      // Persist first: if markdown upload fails, retry will update rather than create a duplicate.
      await this.app.vault.process(file, (current) => writeNotionId(current, newId));
      await run(markdownArgs(newId), JSON.stringify({ markdown: toNotionMarkdown(note.body) }));
      return;
    }
    await pushPage(run, pageId, file.basename, toNotionMarkdown(note.body));
  }
}

class NtnSettings extends PluginSettingTab {
  constructor(private plugin: NtnSync) { super(plugin.app, plugin); }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    new Setting(containerEl).setName('Notion API token')
      .setDesc('Integration token, stored in Obsidian plugin data. Share the target pages with your integration.')
      .addText((input) => {
        input.inputEl.type = 'password';
        input.setPlaceholder('secret_…').setValue(this.plugin.settings.token).onChange(async (value) => {
          this.plugin.settings.token = value;
          await this.plugin.saveData(this.plugin.settings);
        });
      });
    new Setting(containerEl).setName('Default parent page ID')
      .setDesc('New pages are created under this Notion page.')
      .addText((input) => input.setValue(this.plugin.settings.parentId).onChange(async (value) => {
        this.plugin.settings.parentId = value;
        await this.plugin.saveData(this.plugin.settings);
      }));
    new Setting(containerEl).setName('Path to ntn binary')
      .setDesc('Optional. Leave blank to resolve ntn from PATH.')
      .addText((input) => input.setPlaceholder('ntn').setValue(this.plugin.settings.binary).onChange(async (value) => {
        this.plugin.settings.binary = value;
        await this.plugin.saveData(this.plugin.settings);
      }));
  }
}
