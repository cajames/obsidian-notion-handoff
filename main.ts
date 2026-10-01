import { Notice, Plugin, PluginSettingTab, Setting, TFile } from 'obsidian';
import { createArgs, createPayload, runNtn, titleArgs, titleProperty } from './cli';
import { pushMarkdownWithMentions } from './mention-push';
import { resolveReferences } from './references';
import { isExcalidraw, parseUploadResult, prepareAttachments, uploadArgs } from './attachments';
import { insertMedia } from './media';
import { resolveAttachment } from './paths';
import { renderExcalidraw } from './excalidraw';
import { parseNote, toNotionMarkdown, writeNotionId } from './note';
import { resolveProfile } from './profiles';

const DEFAULT_PROFILE = { name: 'Default', token: '', parentId: '' };

export default class NtnSync extends Plugin {
  settings = { profiles: [{ ...DEFAULT_PROFILE }], binary: 'ntn' };
  private pushing = false;

  async onload() {
    const saved = await this.loadData();
    this.settings = {
      profiles: Array.isArray(saved?.profiles) && saved.profiles.length ? saved.profiles : [{ ...DEFAULT_PROFILE }],
      binary: typeof saved?.binary === 'string' ? saved.binary : 'ntn',
    };
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
    if (isExcalidraw(file.path)) {
      new Notice('Excalidraw drawings cannot be pushed as notes; embed one in a Markdown note instead.');
      return;
    }
    this.pushing = true;
    try {
      const { issues, demoted } = await this.push(file);
      const warnings = [...issues, ...(demoted.length ? [`Note links demoted to pending: ${demoted.join(', ')} (mention import failed or could not be confirmed).`] : [])];
      new Notice(`Pushed ${file.basename} to Notion${warnings.length ? ` with ${warnings.length} warning(s)` : ''}.`);
      if (warnings.length) new Notice(warnings.join('\n'), 12000);
    } catch (error) {
      new Notice(`Notion push failed: ${error instanceof Error ? error.message : String(error)}`, 10000);
    } finally {
      this.pushing = false;
    }
  }

  private async push(file: TFile) {
    const source = await this.app.vault.read(file);
    const note = parseNote(source);
    const profile = resolveProfile(this.settings.profiles, note.notionWorkspace);
    const token = profile.token.trim();
    const parentId = profile.parentId.trim();
    if (!token) throw new Error(`Add a Notion API token for "${profile.name}" in Notion Sync settings.`);
    if (!note.notionId && !parentId) throw new Error(`Add a default parent page ID for "${profile.name}" in Notion Sync settings.`);
    const binary = this.settings.binary.trim() || 'ntn';
    const run = (args: string[], stdin?: string | Buffer) => runNtn(binary, token, args, stdin);
    // Preflight before any writes. ENOENT maps to an actionable install message.
    await run(['--version']);
    const resolve = (path: string, from: string) => resolveAttachment(path, from,
      (candidate) => {
        const match = this.app.vault.getAbstractFileByPath(candidate);
        return match instanceof TFile ? match : null;
      },
      (link, source) => this.app.metadataCache.getFirstLinkpathDest(link, source));
    const links = await resolveReferences(note.body, file.path, profile, {
      resolve,
      markdownFiles: () => this.app.vault.getMarkdownFiles(),
      read: (asset) => this.app.vault.read(asset as TFile),
      profiles: this.settings.profiles,
    });
    const prepared = await prepareAttachments(links.body, file.path, {
      resolve,
      read: async (asset) => new Uint8Array(await this.app.vault.readBinary(asset as TFile)),
      render: (asset) => renderExcalidraw(asset.path, (window as typeof window & {
        ExcalidrawAutomate?: { reset: () => void; createPNG: (path: string) => Promise<Blob> };
      }).ExcalidrawAutomate),
      upload: async (bytes, name, mime) => parseUploadResult(await run(uploadArgs(name, mime), Buffer.from(bytes))),
    });
    const markdown = toNotionMarkdown(prepared.markdown);
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
      const demoted = await pushMarkdownWithMentions(run, newId, markdown, links.references);
      return { issues: [...prepared.issues, ...await insertMedia(run, newId, prepared.placements)], demoted };
    }
    await run(titleArgs(pageId), JSON.stringify({ properties: titleProperty(file.basename) }));
    const demoted = await pushMarkdownWithMentions(run, pageId, markdown, links.references);
    return { issues: [...prepared.issues, ...await insertMedia(run, pageId, prepared.placements)], demoted };
  }
}

class NtnSettings extends PluginSettingTab {
  constructor(private plugin: NtnSync) { super(plugin.app, plugin); }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h3', { text: 'Workspace profiles' });
    containerEl.createEl('p', { text: 'The first profile is the default. Each token belongs to one Notion workspace.' });
    this.plugin.settings.profiles.forEach((profile, index) => {
      containerEl.createEl('h4', { text: `Profile ${index + 1}${index === 0 ? ' (default)' : ''}` });
      new Setting(containerEl).setName('Name')
        .addText((input) => input.setValue(profile.name).onChange(async (value) => {
          profile.name = value;
          await this.plugin.saveData(this.plugin.settings);
        }));
      new Setting(containerEl).setName('Notion API token')
        .setDesc('Stored in Obsidian plugin data. Share target pages with this integration.')
        .addText((input) => {
          input.inputEl.type = 'password';
          input.setPlaceholder('secret_…').setValue(profile.token).onChange(async (value) => {
            profile.token = value;
            await this.plugin.saveData(this.plugin.settings);
          });
        });
      new Setting(containerEl).setName('Default parent page ID')
        .setDesc('New pages in this workspace are created under this page.')
        .addText((input) => input.setValue(profile.parentId).onChange(async (value) => {
          profile.parentId = value;
          await this.plugin.saveData(this.plugin.settings);
        }));
      new Setting(containerEl).addButton((button) => button.setButtonText('Remove profile')
        .setDisabled(this.plugin.settings.profiles.length === 1).onClick(async () => {
          this.plugin.settings.profiles.splice(index, 1);
          await this.plugin.saveData(this.plugin.settings);
          this.display();
        }));
    });
    new Setting(containerEl).setName('Add workspace profile')
      .addButton((button) => button.setButtonText('Add profile').onClick(async () => {
        this.plugin.settings.profiles.push({ name: `Workspace ${this.plugin.settings.profiles.length + 1}`, token: '', parentId: '' });
        await this.plugin.saveData(this.plugin.settings);
        this.display();
      }));
    new Setting(containerEl).setName('Path to ntn binary')
      .setDesc('Optional. Leave blank to resolve ntn from PATH.')
      .addText((input) => input.setPlaceholder('ntn').setValue(this.plugin.settings.binary).onChange(async (value) => {
        this.plugin.settings.binary = value;
        await this.plugin.saveData(this.plugin.settings);
      }));
  }
}
