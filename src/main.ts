import { Component, Notice, Plugin, TFile, requestUrl } from 'obsidian';
import { posix } from 'path-browserify';
import { randomId } from './ids';
import { createPayload, notionClient, uploadFile } from './notion';
import { pushMarkdownWithMentions } from './mention-push';
import { resolveReferences } from './references';
import { isExcalidraw, parseEmbeds, prepareAttachments } from './attachments';
import { insertMedia } from './media';
import { imageImportFolder, resolveAttachment } from './paths';
import { renderExcalidraw } from './excalidraw';
import { isTldraw, renderTldraw } from './tldraw';
import { parseNote, toNotionMarkdown, writeNotionBinding } from './note';
import { resolveProfile } from './profiles';
import { readRemote, fingerprint, canonicalReferences, remoteEmbeds, urlIdentity } from './sync-remote';
import { applyPull, makeCheckpoint, parseCheckpoints, restoreBindings } from './sync';
import { prepareRemote } from './pull-images';
import { confirmPush, pickWorkspace, reviewPull } from './sync-modals';
import { combineOrigins, makeOrigin, parseOrigins } from './media-origins';
import HandoffSettings from './settings';
import { uiStyles } from './ui-styles';
import { notionPageUrl, parseNoteLinks, readWorkspace, sameId, verifiedWorkspace } from './note-links';
import { authorizationUrl, oauthChallenge, oauthRequest } from './oauth';

const EMPTY_PROFILE = { name: 'Workspace 1', token: '', parentId: '' };

export default class NotionHandoff extends Plugin {
  settings = { profiles: [{ ...EMPTY_PROFILE }], imageImportFolder: '' };
  private syncing = false;
  private checkpoints: Record<string, ReturnType<typeof makeCheckpoint>> = {};
  private origins: Record<string, ReturnType<typeof makeOrigin>[]> = {};
  private syncReady = true;
  private noteLinks = parseNoteLinks('{}');
  private oauthAttempt = {
    profile: EMPTY_PROFILE, name: '', token: '', parentId: '',
    state: '', verifier: '', expires: 0, busy: false,
  };

  async onload() {
    const style = document.createElement('style');
    style.dataset.notionHandoff = '';
    style.textContent = uiStyles;
    document.head.append(style);
    this.register(() => style.remove());
    const saved = await this.loadData();
    this.settings = {
      profiles: Array.isArray(saved?.profiles) && saved.profiles.length ? saved.profiles : [{ ...EMPTY_PROFILE }],
      imageImportFolder: typeof saved?.imageImportFolder === 'string' ? saved.imageImportFolder : '',
    };
    try {
      const path = this.statePath();
      if (await this.app.vault.adapter.exists(path)) this.checkpoints = parseCheckpoints(await this.app.vault.adapter.read(path));
      const origins = this.originPath();
      if (await this.app.vault.adapter.exists(origins)) this.origins = parseOrigins(await this.app.vault.adapter.read(origins));
      const links = this.noteLinkPath();
      if (await this.app.vault.adapter.exists(links)) this.noteLinks = parseNoteLinks(await this.app.vault.adapter.read(links));
    } catch (error) {
      this.syncReady = false;
      new Notice(`Sync disabled: ${error instanceof Error ? error.message : String(error)}`, 12000);
    }
    const settingsTab = new HandoffSettings(this);
    this.addSettingTab(settingsTab);
    this.registerObsidianProtocolHandler('notion-handoff-oauth', (params) => {
      void this.finishNotionConnection({ state: params.state ?? '', handoff: params.handoff ?? '', error: params.error ?? '' })
        .then((connected) => { if (connected) settingsTab.display(); });
    });
    this.register(() => { this.oauthAttempt.state = ''; this.oauthAttempt.verifier = ''; });
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
    this.addCommand({
      id: 'open-in-notion',
      name: 'Open in Notion',
      callback: () => { void this.openInNotion(); },
    });
  }

  async connectNotion(profile = this.settings.profiles[0]) {
    if (!this.settings.profiles.includes(profile)) throw new Error('Workspace profile was removed.');
    if (!profile.name.trim()) throw new Error('Give this workspace a name first.');
    const state = randomId() + randomId();
    const verifier = randomId() + randomId();
    const attempt = {
      profile, name: profile.name, token: profile.token, parentId: profile.parentId,
      state, verifier, expires: Date.now() + 10 * 60 * 1000, busy: false,
    };
    this.oauthAttempt = attempt;
    try {
      const result = await oauthRequest('start', { state, challenge: oauthChallenge(verifier) });
      if (!this.currentOAuthAttempt(attempt)) throw new Error('Workspace settings changed. Start a new connection.');
      if (typeof result?.authorizeUrl !== 'string') throw new Error('Connection service returned no authorization URL.');
      window.open(authorizationUrl(result.authorizeUrl, state), '_blank', 'noopener,noreferrer');
    } catch (error) {
      if (this.oauthAttempt === attempt) { attempt.state = ''; attempt.verifier = ''; }
      throw error;
    }
  }

  private currentOAuthAttempt(attempt = this.oauthAttempt) {
    return this.oauthAttempt === attempt && !!attempt.state && attempt.expires > Date.now() &&
      this.settings.profiles.includes(attempt.profile) && attempt.profile.name === attempt.name &&
      attempt.profile.token === attempt.token && attempt.profile.parentId === attempt.parentId;
  }

  private async finishNotionConnection(params = { state: '', handoff: '', error: '' }) {
    const attempt = this.oauthAttempt;
    if (!params.state || params.state !== attempt.state || attempt.busy) return false;
    if (!this.currentOAuthAttempt(attempt)) {
      attempt.state = ''; attempt.verifier = '';
      new Notice('Notion connection expired or workspace settings changed. Connect again.');
      return false;
    }
    attempt.busy = true;
    try {
      if (params.error) throw new Error(params.error === 'denied' ? 'Notion authorization cancelled.' : 'Notion authorization failed. Connect again.');
      if (!/^[a-f0-9]{64}$/.test(params.handoff ?? '')) throw new Error('Invalid Notion handoff. Connect again.');
      const token = await oauthRequest('redeem', { state: attempt.state, handoff: params.handoff, verifier: attempt.verifier });
      if (typeof token?.access_token !== 'string' || !token.access_token.trim() ||
        typeof token.workspace_id !== 'string' || !/^(?:[a-f0-9]{32}|[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12})$/i.test(token.workspace_id)) {
        throw new Error('Connection service returned an invalid token. Connect again.');
      }
      if (!this.currentOAuthAttempt(attempt)) throw new Error('Workspace settings changed. Connect again.');
      const workspace = await readWorkspace(notionClient(token.access_token));
      if (!this.currentOAuthAttempt(attempt)) throw new Error('Workspace settings changed. Connect again.');
      if (!sameId(workspace.id, token.workspace_id)) throw new Error('Notion workspace identity does not match.');
      const pinned = Reflect.get(attempt.profile, 'oauthWorkspaceId');
      if (typeof pinned === 'string' && !sameId(pinned, workspace.id)) throw new Error('Choose the same Notion workspace, or add a separate profile.');
      this.assertProfileWorkspace(attempt.name, workspace.id);
      const connected = { ...attempt.profile, token: token.access_token, oauthWorkspaceId: workspace.id };
      const settings = { ...this.settings, profiles: this.settings.profiles.map((profile) => profile === attempt.profile ? connected : profile) };
      await this.saveData(settings);
      if (!this.currentOAuthAttempt(attempt)) {
        await this.saveData(this.settings);
        throw new Error('Workspace settings changed. Connect again.');
      }
      Object.assign(attempt.profile, connected);
      new Notice(`Connected to ${workspace.name ?? workspace.id}. Choose a parent page for new notes.`);
      return true;
    } catch (error) {
      new Notice(`Connect to Notion: ${error instanceof Error ? error.message : 'Connection failed.'}`, 10000);
      return false;
    } finally {
      attempt.state = ''; attempt.verifier = ''; attempt.busy = false;
    }
  }

  assertProfileWorkspace(name: string, workspaceId: string) {
    const assigned = Object.values(this.noteLinks).filter((link) => link.workspaceName.trim().toLowerCase() === name.trim().toLowerCase());
    if (assigned.some((link) => !sameId(link.workspaceId, workspaceId))) {
      throw new Error(`This token belongs to a different workspace than the notes assigned to "${name}". Add a separate workspace profile.`);
    }
  }

  private async openInNotion() {
    try {
      const file = this.app.workspace.getActiveFile();
      if (!(file instanceof TFile) || file.extension !== 'md') throw new Error('Open a Markdown note first.');
      const note = parseNote(await this.app.vault.read(file));
      const saved = this.noteLinks[file.path];
      if (saved && ((note.notionId && !sameId(note.notionId, saved.pageId)) ||
        (note.notionWorkspaceId && !sameId(note.notionWorkspaceId, saved.workspaceId)))) {
        throw new Error('This note conflicts with its saved workspace/page binding. Restore its original IDs before opening.');
      }
      const pageId = note.notionId ?? saved?.pageId;
      if (!pageId) throw new Error('Push this note first to create its Notion page.');
      window.open(notionPageUrl(pageId), '_blank', 'noopener,noreferrer');
    } catch (error) {
      new Notice(`Open in Notion: ${error instanceof Error ? error.message : String(error)}`, 10000);
    }
  }

  private activeNote() {
    if (!this.syncReady) { new Notice('Repair sync-state.json / media-origins.json / note-links.json and reload Notion Handoff before syncing.'); return null; }
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

  private noteLinkPath() {
    return `${posix.dirname(this.statePath())}/note-links.json`;
  }

  private async chooseProfile(note: ReturnType<typeof parseNote>, noteName: string) {
    let workspace = note.notionWorkspace;
    if (!workspace && this.settings.profiles.length > 1) {
      workspace = await pickWorkspace(this.app, this.settings.profiles.map((profile) => profile.name.trim()), noteName);
      if (!workspace) return null;
    }
    return resolveProfile(this.settings.profiles, workspace);
  }

  private async saveNoteLink(file: TFile, workspaceName: string, workspaceId: string, pageId: string) {
    const next = { ...this.noteLinks, [file.path]: { notePath: file.path, workspaceName, workspaceId, pageId } };
    await this.app.vault.adapter.write(this.noteLinkPath(), JSON.stringify(next, null, 2));
    this.noteLinks = next;
  }

  private async bindPushedNote(file: TFile, source: string, workspaceName: string, workspaceId: string, pageId: string, created = false) {
    let changed = false;
    let bound = writeNotionBinding(source, workspaceName, workspaceId, pageId);
    try {
      if (bound !== source) await this.app.vault.process(file, (current) => {
        changed = current !== source;
        if (changed && !created) throw new Error('The note changed while binding its workspace. Push again with the latest edits.');
        bound = writeNotionBinding(current, workspaceName, workspaceId, pageId);
        return bound;
      });
    } catch (error) {
      // A created page must remain recoverable even if the note cannot be edited.
      if (created) {
        await this.saveNoteLink(file, workspaceName, workspaceId, pageId);
        throw new Error(`Page ${pageId} was created, but could not be linked in the note. Its binding was saved; restore its IDs before retrying. ${error instanceof Error ? error.message : String(error)}`);
      }
      throw error;
    }
    await this.saveNoteLink(file, workspaceName, workspaceId, pageId);
    if (changed) throw new Error('The note changed during page creation. Its page and workspace IDs were saved; push again with the latest edits.');
    return bound;
  }

  private async saveOrigins(key: string, added: ReturnType<typeof makeOrigin>[], previous = this.origins[key] ?? []) {
    const next = { ...this.origins, [key]: combineOrigins(previous, added) };
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

  private syncKey(workspaceId: string, pageId: string) {
    return `workspace:${workspaceId.replace(/-/g, '').toLowerCase()}:${pageId.replace(/-/g, '').toLowerCase()}`;
  }

  // Called only after workspace verification. Adopt legacy state on successful
  // sync, keeping the original entries intact and cancellation write-free.
  private history(workspaceId: string, pageId: string, token: string, bound: boolean) {
    const key = this.syncKey(workspaceId, pageId);
    const page = pageId.replace(/-/g, '').toLowerCase();
    const legacy = `${fingerprint(token).slice(0, 16)}:${page}`;
    const previous = (keys: string[]) => {
      if (!bound || keys.includes(legacy)) return legacy;
      const candidates = keys.filter((candidate) => /^[a-f0-9]{16}:/.test(candidate) && candidate.slice(17) === page);
      if (candidates.length > 1) throw new Error('Multiple legacy histories exist for this page. Restore the previous access token or repair sync-state.json / media-origins.json before syncing.');
      return candidates[0] ?? legacy;
    };
    return {
      key,
      checkpoint: this.checkpoints[key] ?? this.checkpoints[previous(Object.keys(this.checkpoints))] ?? null,
      origins: this.origins[key] ?? this.origins[previous(Object.keys(this.origins))] ?? [],
    };
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

  private async backupNote(key: string, source: string) {
    const folder = `${posix.dirname(this.statePath())}/backups`;
    await this.ensureFolder(folder);
    const path = `${folder}/${fingerprint(key)}-${Date.now()}-${randomId()}.md`;
    await this.app.vault.adapter.write(path, source);
    return path;
  }

  private async pruneBackups(latest: string) {
    const folder = posix.dirname(latest);
    const prefix = posix.basename(latest).slice(0, 64);
    const pattern = new RegExp(`^${prefix}-(\\d+)-[a-f0-9]{32}\\.md$`);
    const { files } = await this.app.vault.adapter.list(folder);
    const backups = [...new Set(files)].filter((path) => {
      if (posix.dirname(path) !== folder) return false;
      const match = pattern.exec(posix.basename(path));
      return match !== null && Number.isSafeInteger(Number(match[1]));
    }).sort((left, right) => {
      if (left === latest) return -1;
      if (right === latest) return 1;
      return Number(posix.basename(right).split('-')[1]) - Number(posix.basename(left).split('-')[1]) || left.localeCompare(right);
    });
    if (!backups.includes(latest)) throw new Error('Newest backup is missing; older backups were kept.');
    for (const path of backups.slice(5).reverse()) await this.app.vault.adapter.remove(path);
  }

  private async pullCurrentNote() {
    const file = this.activeNote();
    if (!file) return;
    this.syncing = true;
    try {
      const source = await this.app.vault.read(file);
      const note = parseNote(source);
      if (!note.notionId) throw new Error('This note has no notion_id. Push it first, or add the target page ID.');
      const profile = await this.chooseProfile(note, file.basename);
      if (!profile) { new Notice('Notion pull cancelled.'); return; }
      const workspaceName = profile.name.trim();
      const token = profile.token.trim();
      if (!token) throw new Error(`Add a Notion access token for "${profile.name}" in Notion Handoff settings.`);
      const client = notionClient(token);
      const workspaceId = await verifiedWorkspace(client, note, this.noteLinks[file.path]);
      const boundSource = writeNotionBinding(source, workspaceName, workspaceId, note.notionId);
      const remote = await readRemote(client, note.notionId);
      const history = this.history(workspaceId, note.notionId, token, !!(note.notionWorkspaceId || this.noteLinks[file.path]));
      const { key, checkpoint } = history;
      const needsOrigins = checkpoint?.bindings.some((binding) => {
        const source = this.drawingSource(binding.local, file.path);
        return source && !history.origins.some((origin) => origin.drawing && origin.source === source);
      });
      const needsMigration = !this.checkpoints[key] || !this.origins[key];
      if (checkpoint && !needsMigration && remote.fingerprint === checkpoint.observed && !needsOrigins && boundSource === source && this.noteLinks[file.path]) {
        new Notice(`${file.basename} is up to date; local edits kept.`);
        return;
      }
      // Older pushes have no saved bindings. Restore provable note links too.
      const links = await resolveReferences(note.body, file.path, profile, {
        resolve: (path, from) => this.resolveAsset(path, from),
        markdownFiles: () => this.app.vault.getMarkdownFiles(),
        read: (asset) => this.app.vault.read(asset as TFile),
        profiles: this.settings.profiles,
        workspaceId,
        isTldraw: (asset) => this.isTldraw(asset),
      });
      const bindings = [...(checkpoint?.bindings ?? []), ...links.bindings.map((binding) => ({ ...binding, remote: canonicalReferences(binding.remote) }))];
      // Binding recovery must not fabricate a merge baseline on the first pull.
      const mapping = checkpoint ? { ...checkpoint, bindings } : makeCheckpoint('', '', '', bindings);
      // Reading the attachment setting avoids creating folders before review.
      // Obsidian's vault configuration accessor is not in its public types.
      const getConfig = Reflect.get(this.app.vault, 'getConfig');
      const attachments = typeof getConfig === 'function' ? getConfig.call(this.app.vault, 'attachmentFolderPath') : '';
      const prepared = await prepareRemote(remote, note.notionId, mapping, {
        imageFolder: imageImportFolder(this.settings.imageImportFolder, typeof attachments === 'string' ? attachments : '', file.path),
        origins: history.origins,
        drawingSource: (original) => this.drawingSource(original, file.path),
        exists: (path) => this.app.vault.adapter.exists(path),
        download: async (url) => {
          const response = await requestUrl({ url, method: 'GET', throw: false });
          if (response.status < 200 || response.status >= 300) throw new Error(`Notion image download failed (HTTP ${response.status}).`);
          return { bytes: new Uint8Array(response.arrayBuffer), mime: response.headers['content-type'] ?? response.headers['Content-Type'] ?? '' };
        },
      });
      let latestBackup = '';
      const result = await applyPull(source, prepared.markdown, remote.fingerprint, checkpoint, prepared.bindings, prepared.files, {
        read: () => this.app.vault.read(file),
        prepareNote: (updated) => writeNotionBinding(updated, workspaceName, workspaceId, note.notionId!),
        review: (local, notion, merged, firstPull) => reviewPull(this.app, local, notion, merged, firstPull),
        backup: async (original) => { latestBackup = await this.backupNote(key, original); },
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
          await this.saveNoteLink(file, workspaceName, workspaceId, note.notionId!);
          await this.saveOrigins(key, prepared.origins);
          await this.saveCheckpoint(key, next);
        },
      });
      if (latestBackup && result.changed) {
        try { await this.pruneBackups(latestBackup); }
        catch (error) { new Notice(`Pull saved, but backup cleanup failed: ${error instanceof Error ? error.message : String(error)}`, 12000); }
      }
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
    const profile = await this.chooseProfile(note, file.basename);
    if (!profile) return null;
    const workspaceName = profile.name.trim();
    const token = profile.token.trim();
    const parentId = profile.parentId.trim();
    if (!token) throw new Error(`Add a Notion access token for "${profile.name}" in Notion Handoff settings.`);
    if (!note.notionId && !parentId) throw new Error(`Add a default parent page ID for "${profile.name}" in Notion Handoff settings.`);
    const client = notionClient(token);
    const workspaceId = await verifiedWorkspace(client, note, this.noteLinks[file.path]);
    const history = note.notionId ? this.history(workspaceId, note.notionId, token, !!(note.notionWorkspaceId || this.noteLinks[file.path])) : null;
    let checkedFingerprint = '';
    if (note.notionId) {
      const remote = await readRemote(client, note.notionId);
      const checkpoint = history?.checkpoint;
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
      workspaceId,
      isTldraw: (asset) => this.isTldraw(asset),
    });
    const prepared = await prepareAttachments(links.body, file.path, {
      resolve,
      read: async (asset) => new Uint8Array(await this.app.vault.readBinary(asset as TFile)),
      isTldraw: (asset) => this.isTldraw(asset),
      render: (asset) => this.renderDrawing(asset, file.path),
      upload: (bytes, name, mime) => uploadFile(client, bytes, name, mime),
    });
    const markdown = toNotionMarkdown(prepared.markdown);
    // Attachment preparation may take time. Recheck immediately before page writes.
    if (note.notionId) {
      const latest = await readRemote(client, note.notionId);
      const checkpoint = history?.checkpoint;
      if (latest.fingerprint !== checkedFingerprint &&
        !await confirmPush(this.app, note.body, restoreBindings(latest.markdown, checkpoint?.bindings ?? []), false)) return null;
    }
    if (await this.app.vault.read(file) !== source) throw new Error('The note changed while preparing the push. Push again with the latest edits.');
    let pageId = note.notionId;
    let boundSource = source;
    if (!pageId) {
      const response = await client.pages.create(createPayload(parentId, note.title ?? file.basename));
      if (typeof response?.id !== 'string' || !response.id) throw new Error('Notion did not return a page ID. Check Notion before retrying creation.');
      const newId = String(response.id);
      // Persist both IDs before content writes so failed pushes never duplicate pages.
      boundSource = await this.bindPushedNote(file, source, workspaceName, workspaceId, newId, true);
      pageId = newId;
    } else {
      boundSource = await this.bindPushedNote(file, source, workspaceName, workspaceId, pageId);
    }
    if (await this.app.vault.read(file) !== boundSource) throw new Error('The note changed before publishing. Push again with the latest edits.');
    const demoted = await pushMarkdownWithMentions(client, pageId, markdown, links.references);
    const inserted: ReturnType<typeof makeOrigin>[] = [];
    const issues = [...prepared.issues, ...await insertMedia(client, pageId, prepared.placements, (placement, id) => {
      if (placement.original) inserted.push(makeOrigin(id, placement.original, placement.source ?? '', placement.drawing ?? false));
    })];
    try {
      // Save provenance before readback; even a later checkpoint failure must not
      // lose the relationship between a drawing and its uploaded PNG block.
      await this.saveOrigins(this.syncKey(workspaceId, pageId), inserted, history?.origins ?? []);
      const remote = await readRemote(client, pageId);
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
      await this.saveCheckpoint(this.syncKey(workspaceId, pageId), makeCheckpoint(note.body, restoreBindings(remote.markdown, bindings), remote.fingerprint, bindings));
    } catch (error) {
      issues.push(`Page pushed, but no new sync checkpoint was saved: ${error instanceof Error ? error.message : String(error)}. Pull may require review.`);
    }
    return { issues, demoted };
  }
}
