import { Component, Notice, Plugin, PluginSettingTab, Setting, TFile, requestUrl } from 'obsidian';
import { posix } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createArgs, createPayload, runNtn, titleArgs, titleProperty } from './cli';
import { pushMarkdownWithMentions } from './mention-push';
import { resolveReferences } from './references';
import { isExcalidraw, parseEmbeds, parseUploadResult, prepareAttachments, uploadArgs } from './attachments';
import { insertMedia } from './media';
import { resolveAttachment } from './paths';
import { renderExcalidraw } from './excalidraw';
import { isTldraw, renderTldraw } from './tldraw';
import { parseNote, toNotionMarkdown, writeNotionId } from './note';
import { resolveProfile } from './profiles';
import { readRemote, fingerprint, canonicalReferences, remoteEmbeds, urlIdentity } from './sync-remote';
import { applyPull, makeCheckpoint, parseCheckpoints, restoreBindings } from './sync';
import { prepareRemote } from './pull-images';
import { confirmPush, reviewPull } from './sync-modals';
import { combineOrigins, makeOrigin, parseOrigins } from './media-origins';

const DEFAULT_PROFILE = { name: 'Default', token: '', parentId: '' };

export default class NtnSync extends Plugin {
  settings = { profiles: [{ ...DEFAULT_PROFILE }], binary: 'ntn' };
  private syncing = false;
  private checkpoints: Record<string, ReturnType<typeof makeCheckpoint>> = {};
  private origins: Record<string, ReturnType<typeof makeOrigin>[]> = {};
  private syncReady = true;

  async onload() {
    const saved = await this.loadData();
    this.settings = {
      profiles: Array.isArray(saved?.profiles) && saved.profiles.length ? saved.profiles : [{ ...DEFAULT_PROFILE }],
      binary: typeof saved?.binary === 'string' ? saved.binary : 'ntn',
    };
    try {
      const path = this.statePath();
      if (await this.app.vault.adapter.exists(path)) this.checkpoints = parseCheckpoints(await this.app.vault.adapter.read(path));
      const origins = this.originPath();
      if (await this.app.vault.adapter.exists(origins)) this.origins = parseOrigins(await this.app.vault.adapter.read(origins));
    } catch (error) {
      this.syncReady = false;
      new Notice(`Sync disabled: ${error instanceof Error ? error.message : String(error)}`, 12000);
    }
    this.addSettingTab(new NtnSettings(this));
    this.addCommand({
      id: 'push-to-notion',
      name: 'Push to Notion',
      callback: () => { void this.pushCurrentNote(); },
    });
    this.addCommand({
      id: 'pull-from-notion',
      name: 'Pull from Notion',
      callback: () => { void this.pullCurrentNote(); },
    });
  }

  private activeNote() {
    if (!this.syncReady) { new Notice('Repair sync-state.json / media-origins.json and reload Notion Sync before syncing.'); return null; }
    if (this.syncing) { new Notice('A Notion sync is already in progress.'); return null; }
    const file = this.app.workspace.getActiveFile();
    if (!(file instanceof TFile) || file.extension !== 'md') {
      new Notice('Open a Markdown note to sync with Notion.');
      return null;
    }
    if (isExcalidraw(file.path) || this.isTldraw(file)) {
      new Notice('Drawings cannot be synced as notes; embed one in a Markdown note instead.');
      return null;
    }
    return file;
  }

  private async pushCurrentNote() {
    const file = this.activeNote();
    if (!file) return;
    this.syncing = true;
    try {
      const result = await this.push(file);
      if (!result) { new Notice('Notion push cancelled.'); return; }
      const { issues, demoted } = result;
      const warnings = [...issues, ...(demoted.length ? [`Note links demoted to pending: ${demoted.join(', ')} (mention import failed or could not be confirmed).`] : [])];
      new Notice(`Pushed ${file.basename} to Notion${warnings.length ? ` with ${warnings.length} warning(s)` : ''}.`);
      if (warnings.length) new Notice(warnings.join('\n'), 12000);
    } catch (error) {
      new Notice(`Notion push failed: ${error instanceof Error ? error.message : String(error)}`, 10000);
    } finally {
      this.syncing = false;
    }
  }

  private statePath() {
    return `${this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`}/sync-state.json`;
  }

  private originPath() {
    return `${posix.dirname(this.statePath())}/media-origins.json`;
  }

  private async saveOrigins(key: string, added: ReturnType<typeof makeOrigin>[]) {
    const next = { ...this.origins, [key]: combineOrigins(this.origins[key] ?? [], added) };
    await this.app.vault.adapter.write(this.originPath(), JSON.stringify(next, null, 2));
    this.origins = next;
  }

  private resolveAsset(path: string, from: string) {
    return resolveAttachment(path, from, (candidate) => {
      const match = this.app.vault.getAbstractFileByPath(candidate);
      return match instanceof TFile ? match : null;
    }, (link, source) => this.app.metadataCache.getFirstLinkpathDest(link, source));
  }

  private drawingSource(original: string, from: string) {
    const embed = parseEmbeds(original)[0];
    const file = embed ? this.resolveAsset(embed.path, from) : null;
    return file && (isExcalidraw(file.path) || this.isTldraw(file)) ? file.path : null;
  }

  private syncKey(token: string, pageId: string) {
    return `${fingerprint(token).slice(0, 16)}:${pageId.replace(/-/g, '').toLowerCase()}`;
  }

  private async saveCheckpoint(key: string, checkpoint: ReturnType<typeof makeCheckpoint>) {
    const next = { ...this.checkpoints, [key]: checkpoint };
    await this.app.vault.adapter.write(this.statePath(), JSON.stringify(next, null, 2));
    this.checkpoints = next;
  }

  private async ensureFolder(path: string, vaultFolder = false) {
    if (!path || path === '.' || await this.app.vault.adapter.exists(path)) return;
    await this.ensureFolder(posix.dirname(path), vaultFolder);
    if (vaultFolder) await this.app.vault.createFolder(path);
    else await this.app.vault.adapter.mkdir(path);
  }

  private async pullCurrentNote() {
    const file = this.activeNote();
    if (!file) return;
    this.syncing = true;
    try {
      const source = await this.app.vault.read(file);
      const note = parseNote(source);
      if (!note.notionId) throw new Error('This note has no notion_id. Push it first, or add the target page ID.');
      const profile = resolveProfile(this.settings.profiles, note.notionWorkspace);
      const token = profile.token.trim();
      if (!token) throw new Error(`Add a Notion API token for "${profile.name}" in Notion Sync settings.`);
      const run = (args: string[]) => runNtn(this.settings.binary.trim() || 'ntn', token, args);
      await run(['--version']);
      const remote = await readRemote(run, note.notionId);
      const key = this.syncKey(token, note.notionId);
      const checkpoint = this.checkpoints[key] ?? null;
      const needsOrigins = checkpoint?.bindings.some((binding) => {
        const source = this.drawingSource(binding.local, file.path);
        return source && !(this.origins[key] ?? []).some((origin) => origin.drawing && origin.source === source);
      });
      if (checkpoint && remote.fingerprint === checkpoint.observed && !needsOrigins) {
        new Notice(`${file.basename} is up to date; local edits kept.`);
        return;
      }
      // Older pushes have no saved bindings. Restore provable note links too.
      const links = await resolveReferences(note.body, file.path, profile, {
        resolve: (path, from) => this.resolveAsset(path, from),
        markdownFiles: () => this.app.vault.getMarkdownFiles(),
        read: (asset) => this.app.vault.read(asset as TFile),
        profiles: this.settings.profiles,
        isTldraw: (asset) => this.isTldraw(asset),
      });
      const bindings = [...(checkpoint?.bindings ?? []), ...links.bindings.map((binding) => ({ ...binding, remote: canonicalReferences(binding.remote) }))];
      // Binding recovery must not fabricate a merge baseline on the first pull.
      const mapping = checkpoint ? { ...checkpoint, bindings } : makeCheckpoint('', '', '', bindings);
      const prepared = await prepareRemote(remote, note.notionId, mapping, {
        origins: this.origins[key] ?? [],
        drawingSource: (original) => this.drawingSource(original, file.path),
        exists: (path) => this.app.vault.adapter.exists(path),
        download: async (url) => {
          const response = await requestUrl({ url, method: 'GET', throw: false });
          if (response.status < 200 || response.status >= 300) throw new Error(`Notion image download failed (HTTP ${response.status}).`);
          return { bytes: new Uint8Array(response.arrayBuffer), mime: response.headers['content-type'] ?? response.headers['Content-Type'] ?? '' };
        },
      });
      const result = await applyPull(source, prepared.markdown, remote.fingerprint, checkpoint, prepared.bindings, prepared.files, {
        read: () => this.app.vault.read(file),
        review: (local, notion, merged, firstPull) => reviewPull(this.app, local, notion, merged, firstPull),
        backup: async (original) => {
          const folder = `${posix.dirname(this.statePath())}/backups`;
          await this.ensureFolder(folder);
          await this.app.vault.adapter.write(`${folder}/${Date.now()}-${randomUUID()}.md`, original);
        },
        writeFile: async (path, bytes) => {
          await this.ensureFolder(posix.dirname(path), true);
          // Never replace an existing vault attachment.
          if (!await this.app.vault.adapter.exists(path)) await this.app.vault.createBinary(path, Uint8Array.from(bytes).buffer);
        },
        write: async (expected, updated) => {
          await this.app.vault.process(file, (current) => {
            if (current !== expected) throw new Error('The note changed during pull. Pull again to merge the latest edits.');
            return updated;
          });
        },
        saveCheckpoint: async (next) => {
          await this.saveOrigins(key, prepared.origins);
          await this.saveCheckpoint(key, next);
        },
      });
      new Notice(result.cancelled ? 'Notion pull cancelled.' :
        result.changed ? `Pulled and merged ${file.basename}. Push remains separate.` : `${file.basename} is up to date; local edits kept.`);
    } catch (error) {
      new Notice(`Notion pull failed: ${error instanceof Error ? error.message : String(error)}`, 12000);
    } finally {
      this.syncing = false;
    }
  }

  private tldrawPlugin() {
    // Obsidian's plugin registry is not part of its public type declarations.
    return Reflect.get(this.app, 'plugins')?.getPlugin('tldraw');
  }

  private isTldraw(file: { path: string }) {
    return isTldraw(file.path, this.app.metadataCache.getCache(file.path)?.frontmatter ?? {},
      this.tldrawPlugin()?.settings?.file?.altFrontmatterKey);
  }

  private async renderDrawing(asset: { path: string }, from: string) {
    if (!this.isTldraw(asset)) {
      return renderExcalidraw(asset.path, (window as typeof window & {
        ExcalidrawAutomate?: { reset: () => void; createPNG: (path: string) => Promise<Blob> };
      }).ExcalidrawAutomate);
    }
    if (!this.tldrawPlugin()) throw new Error('Tldraw in Obsidian is unavailable');
    // Use TLDraw's registered embed factory for both .tldr and Markdown drawings.
    // The registry is internal; guard against missing/incompatible plugin versions.
    const registry = Reflect.get(this.app, 'embedRegistry');
    const createEmbed = registry?.embedByExtension?.tldr;
    if (typeof createEmbed !== 'function') throw new Error('TLDraw embed renderer is unavailable; update Tldraw in Obsidian');
    const drawing = this.app.vault.getAbstractFileByPath(asset.path);
    if (!(drawing instanceof TFile)) throw new Error('TLDraw drawing was not found');
    const component = new Component();
    component.load();
    try {
      return await renderTldraw(asset.path, async (container) => {
        container.classList.add('internal-embed');
        container.setAttribute('src', asset.path);
        const embed = createEmbed({
          app: this.app, containerEl: container, sourcePath: from,
          linktext: asset.path, depth: 0, displayMode: false, showInline: false,
        }, drawing, '');
        if (!embed || typeof embed.load !== 'function') throw new Error('TLDraw returned an invalid embed component');
        component.addChild(embed);
      });
    } finally {
      component.unload();
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
    let checkedFingerprint = '';
    if (note.notionId) {
      const remote = await readRemote(run, note.notionId);
      const checkpoint = this.checkpoints[this.syncKey(token, note.notionId)];
      const changed = checkpoint ? remote.fingerprint !== checkpoint.observed : !!remote.markdown.trim();
      if (changed && !await confirmPush(this.app, note.body, restoreBindings(remote.markdown, checkpoint?.bindings ?? []), !checkpoint)) return null;
      if (await this.app.vault.read(file) !== source) throw new Error('The note changed while checking Notion. Push again with the latest edits.');
      checkedFingerprint = remote.fingerprint;
    }
    const resolve = (path: string, from: string) => this.resolveAsset(path, from);
    const links = await resolveReferences(note.body, file.path, profile, {
      resolve,
      markdownFiles: () => this.app.vault.getMarkdownFiles(),
      read: (asset) => this.app.vault.read(asset as TFile),
      profiles: this.settings.profiles,
      isTldraw: (asset) => this.isTldraw(asset),
    });
    const prepared = await prepareAttachments(links.body, file.path, {
      resolve,
      read: async (asset) => new Uint8Array(await this.app.vault.readBinary(asset as TFile)),
      isTldraw: (asset) => this.isTldraw(asset),
      render: (asset) => this.renderDrawing(asset, file.path),
      upload: async (bytes, name, mime) => parseUploadResult(await run(uploadArgs(name, mime), Buffer.from(bytes))),
    });
    const markdown = toNotionMarkdown(prepared.markdown);
    // Attachment preparation may take time. Recheck immediately before page writes.
    if (note.notionId) {
      const latest = await readRemote(run, note.notionId);
      const checkpoint = this.checkpoints[this.syncKey(token, note.notionId)];
      if (latest.fingerprint !== checkedFingerprint &&
        !await confirmPush(this.app, note.body, restoreBindings(latest.markdown, checkpoint?.bindings ?? []), false)) return null;
    }
    if (await this.app.vault.read(file) !== source) throw new Error('The note changed while preparing the push. Push again with the latest edits.');
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
      pageId = newId;
    } else {
      await run(titleArgs(pageId), JSON.stringify({ properties: titleProperty(file.basename) }));
    }
    const demoted = await pushMarkdownWithMentions(run, pageId, markdown, links.references);
    const inserted: ReturnType<typeof makeOrigin>[] = [];
    const issues = [...prepared.issues, ...await insertMedia(run, pageId, prepared.placements, (placement, id) => {
      if (placement.original) inserted.push(makeOrigin(id, placement.original, placement.source ?? '', placement.drawing ?? false));
    })];
    try {
      // Save provenance before readback; even a later checkpoint failure must not
      // lose the relationship between a drawing and its uploaded PNG block.
      await this.saveOrigins(this.syncKey(token, pageId), inserted);
      const remote = await readRemote(run, pageId);
      const bindings = links.bindings.map((binding) => {
        const reference = links.references.find((reference) => reference.mention === binding.remote);
        return { local: binding.local, remote: canonicalReferences(reference && demoted.includes(reference.label) ? reference.pending : binding.remote) };
      });
      for (const embed of remoteEmbeds(remote.markdown)) {
        const asset = remote.media.find((asset) => asset.token === embed.url);
        const local = inserted.find((item) => item.id === asset?.id)?.original ??
          (asset ? remoteEmbeds(note.body).find((original) => urlIdentity(original.url) === urlIdentity(asset.url))?.original : undefined);
        if (local) bindings.push({ remote: embed.original, local });
      }
      await this.saveCheckpoint(this.syncKey(token, pageId), makeCheckpoint(note.body, restoreBindings(remote.markdown, bindings), remote.fingerprint, bindings));
    } catch (error) {
      issues.push(`Page pushed, but no new sync checkpoint was saved: ${error instanceof Error ? error.message : String(error)}. Pull may require review.`);
    }
    return { issues, demoted };
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
