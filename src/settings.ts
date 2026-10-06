import { ButtonComponent, PluginSettingTab, Setting } from 'obsidian';
import type NotionHandoff from './main';
import { imageImportFolder } from './paths';
import { notionClient } from './notion';
import { readWorkspace } from './note-links';
import { readParentPage } from './notion-pages';
import { pickParentPage } from './page-picker';

export default class HandoffSettings extends PluginSettingTab {
  constructor(private plugin: NotionHandoff) { super(plugin.app, plugin); }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.classList.add('notion-handoff-settings');
    const workspaces = containerEl.createDiv({ cls: 'nh-section' });
    const heading = workspaces.createDiv({ cls: 'nh-section-heading' });
    heading.createEl('h2', { text: 'Workspaces' });
    new ButtonComponent(heading).setButtonText('Add workspace').onClick(async () => {
      this.plugin.settings.profiles.push({ name: `Workspace ${this.plugin.settings.profiles.length + 1}`, token: '', parentId: '' });
      await this.plugin.saveData(this.plugin.settings);
      this.display();
      const input = this.containerEl.querySelector('.nh-profiles > :last-child input');
      if (input instanceof HTMLElement) input.focus();
    });
    workspaces.createEl('p', { cls: 'nh-section-description', text: 'Separate connections for work and clients.' });
    const profiles = workspaces.createDiv({ cls: 'nh-profiles' });
    this.plugin.settings.profiles.forEach((profile, index) => {
      const card = profiles.createEl('details', { cls: 'nh-profile' });
      card.open = index === 0 || !profile.token.trim();
      const summary = card.createEl('summary', { cls: 'nh-profile-heading' });
      const title = summary.createSpan({ cls: 'nh-profile-name', text: profile.name.trim() || 'Unnamed workspace' });
      const order = summary.createSpan({ cls: 'nh-profile-order' });
      for (const action of [{ label: 'Move up', icon: 'arrow-up', step: -1 }, { label: 'Move down', icon: 'arrow-down', step: 1 }]) {
        const move = new ButtonComponent(order).setIcon(action.icon).setTooltip(action.label)
          .setDisabled(index + action.step < 0 || index + action.step >= this.plugin.settings.profiles.length)
          .onClick(async (event) => {
            event.preventDefault();
            event.stopPropagation();
            const list = this.plugin.settings.profiles;
            const from = list.indexOf(profile);
            const to = from + action.step;
            if (from < 0 || to < 0 || to >= list.length) return;
            [list[from], list[to]] = [list[to], list[from]];
            await this.plugin.saveData(this.plugin.settings);
            this.display();
            const heading = this.containerEl.querySelector(`.nh-profile:nth-child(${to + 1}) > summary`);
            if (heading instanceof HTMLElement) heading.focus();
          });
        move.buttonEl.classList.add(action.step < 0 ? 'nh-move-up' : 'nh-move-down');
      }
      const fields = card.createDiv({ cls: 'nh-profile-fields' });
      const status = fields.createEl('p', { cls: 'nh-connection-status', attr: { id: `notion-handoff-connection-${index}`, role: 'status', 'aria-live': 'polite' } });
      const clearStatus = () => { status.hidden = true; };
      clearStatus();
      const refreshName = () => {
        title.setText(profile.name.trim() || 'Unnamed workspace');
        const name = profile.name.trim() || 'unnamed workspace';
        card.querySelector('.nh-remove-profile')?.setAttribute('aria-label', `Remove ${name} profile`);
        card.querySelector('.nh-move-up')?.setAttribute('aria-label', `Move ${name} up`);
        card.querySelector('.nh-move-down')?.setAttribute('aria-label', `Move ${name} down`);
        card.querySelector('.nh-connect-notion')?.setAttribute('aria-label', `Connect ${name} to Notion`);
        card.querySelector('.nh-test-connection')?.setAttribute('aria-label', `Test connection for ${name}`);
        card.querySelector('.nh-choose-parent')?.setAttribute('aria-label', `Choose parent page for ${name}`);
      };
      refreshName();
      new Setting(fields).setName('Workspace name')
        .addText((input) => {
          input.inputEl.setAttribute('aria-label', 'Workspace name');
          input.inputEl.required = true;
          input.setPlaceholder('Client or workspace name').setValue(profile.name).onChange(async (value) => {
            profile.name = value;
            clearStatus();
            refreshName();
            await this.plugin.saveData(this.plugin.settings);
          });
        });
      new Setting(fields).setName('Connect to Notion').setDesc('Authorize this workspace in your browser. Select the pages you want to share.')
        .addButton((button) => {
          button.setButtonText('Connect to Notion').setCta();
          button.buttonEl.classList.add('nh-connect-notion');
          button.onClick(async () => {
            button.setDisabled(true);
            status.setText('Starting Notion authorization…');
            status.hidden = false;
            try {
              await this.plugin.connectNotion(profile);
              if (!card.isConnected) return;
              status.setText('Complete authorization in your browser, then choose Open Obsidian.');
              status.dataset.state = 'success';
            } catch (error) {
              if (!card.isConnected) return;
              status.setText(error instanceof Error ? error.message : 'Notion connection failed.');
              status.dataset.state = 'error';
            } finally { button.setDisabled(false); }
          });
        });
      new Setting(fields).setName('Notion access token').setDesc('Integration token or OAuth access token.')
        .addText((input) => {
          input.inputEl.type = 'password';
          input.inputEl.autocomplete = 'off';
          input.inputEl.spellcheck = false;
          input.inputEl.setAttribute('aria-label', 'Notion access token');
          input.inputEl.setAttribute('aria-describedby', status.id);
          input.setPlaceholder('ntn_…').setValue(profile.token).onChange(async (value) => {
            profile.token = value;
            clearStatus();
            await this.plugin.saveData(this.plugin.settings);
          });
        });
      const parent = new Setting(fields).setClass('nh-parent-setting').setName('Parent page').setDesc('For new notes.');
      const actions = parent.controlEl;
      actions.classList.add('nh-connection-actions');
      const choose = new ButtonComponent(actions).setButtonText('Choose parent page').setCta().onClick(() => { void check(true); });
      const test = new ButtonComponent(actions).setButtonText('Test connection').onClick(() => { void check(false); });
      test.buttonEl.classList.add('nh-test-connection');
      choose.buttonEl.classList.add('nh-choose-parent');
      const advanced = fields.createEl('details', { cls: 'nh-advanced' });
      advanced.createEl('summary', { text: 'Advanced' });
      let updateParent = (_id: string) => {};
      new Setting(advanced).setName('Parent page ID')
        .addText((input) => {
          input.inputEl.spellcheck = false;
          input.inputEl.setAttribute('aria-label', 'Parent page ID');
          input.inputEl.setAttribute('aria-describedby', status.id);
          updateParent = (id) => { input.setValue(id); };
          input.setPlaceholder('Notion page ID').setValue(profile.parentId).onChange(async (value) => {
            profile.parentId = value;
            parent.setDesc('For new notes.');
            clearStatus();
            await this.plugin.saveData(this.plugin.settings);
          });
        });
      fields.append(status);
      let busy = false;
      const check = async (picking: boolean) => {
        if (busy) return;
        const token = profile.token.trim();
        const name = profile.name;
        let parentId = profile.parentId;
        const sameSettings = () => this.plugin.settings.profiles.includes(profile) &&
          profile.token.trim() === token && profile.name === name && profile.parentId === parentId;
        const current = () => card.isConnected && this.containerEl.contains(card) && sameSettings();
        const show = (text: string, error = false) => {
          if (!current()) return;
          status.setText(text);
          status.dataset.state = error ? 'error' : 'success';
          status.hidden = false;
        };
        busy = true;
        test.setDisabled(true);
        choose.setDisabled(true);
        actions.setAttribute('aria-busy', 'true');
        show('Checking connection…');
        try {
          if (!token) throw new Error('Paste a Notion access token first.');
          const client = notionClient(token);
          const workspace = await readWorkspace(client);
          if (!current()) return;
          this.plugin.assertProfileWorkspace(name, workspace.id);
          const workspaceName = workspace.name ?? workspace.id;
          if (!picking) {
            const page = parentId.trim() ? await readParentPage(client, parentId.trim()) : null;
            if (!current()) return;
            if (page) parent.setDesc(page.title);
            show(`Connected to ${workspaceName}.${page ? ` Parent: ${page.title}.` : ' Choose a parent page for new notes.'}`);
            return;
          }
          show(`Choose a parent page in ${workspaceName}.`);
          const selected = await pickParentPage(this.app, client, workspaceName);
          if (!current()) return;
          if (!selected) { clearStatus(); return; }
          const page = await readParentPage(client, selected.id);
          if (!current()) return;
          const previous = profile.parentId;
          profile.parentId = parentId = page.id;
          updateParent(page.id);
          try { await this.plugin.saveData(this.plugin.settings); }
          catch (error) {
            if (sameSettings()) { profile.parentId = parentId = previous; updateParent(previous); }
            throw error;
          }
          if (!current()) return;
          parent.setDesc(page.title);
          show(`Connected to ${workspaceName}. Parent: ${page.title}.`);
        } catch (error) {
          show(error instanceof Error ? error.message : String(error), true);
        } finally {
          busy = false;
          test.setDisabled(false);
          choose.setDisabled(false);
          actions.setAttribute('aria-busy', 'false');
        }
      };
      const footer = card.createDiv({ cls: 'nh-profile-footer' });
      const remove = new ButtonComponent(footer).setButtonText('Remove profile')
        .setDisabled(this.plugin.settings.profiles.length === 1).onClick(async () => {
          const position = this.plugin.settings.profiles.indexOf(profile);
          if (position < 0) return;
          this.plugin.settings.profiles.splice(position, 1);
          await this.plugin.saveData(this.plugin.settings);
          this.display();
        });
      remove.buttonEl.classList.add('nh-remove-profile');
      refreshName();
    });
    workspaces.createEl('p', { cls: 'nh-footnote', text: 'Tokens are stored in plain plugin settings. Protect your vault.' });

    const images = containerEl.createDiv({ cls: 'nh-section' });
    images.createEl('h2', { text: 'Imported images' });
    images.createEl('p', { cls: 'nh-section-description', text: 'Choose where new images are saved when you pull from Notion.' });
    const imageCard = images.createDiv({ cls: 'nh-image-settings' });
    const saved = this.plugin.settings.imageImportFolder;
    let customFolder = saved !== '/' ? saved : '';
    const location = new Setting(imageCard).setName('Save images to');
    const custom = new Setting(imageCard).setName('Folder path').setDesc('Vault-relative, for example Assets/Notion. Blank uses Obsidian’s location.');
    const error = imageCard.createEl('p', { cls: 'nh-field-error', attr: { id: 'notion-handoff-folder-error', role: 'status', 'aria-live': 'polite' } });
    error.hidden = true;
    const mode = saved === '/' ? 'root' : saved.trim() ? 'custom' : 'obsidian';
    custom.settingEl.hidden = mode !== 'custom';
    custom.addText((input) => {
      input.inputEl.setAttribute('aria-label', 'Imported images folder');
      input.inputEl.setAttribute('aria-describedby', error.id);
      input.inputEl.spellcheck = false;
      input.setPlaceholder('Assets/Notion').setValue(customFolder);
      const validate = () => {
        try {
          imageImportFolder(customFolder, '', '');
          error.hidden = true;
          input.inputEl.removeAttribute('aria-invalid');
          return true;
        } catch (cause) {
          error.setText(cause instanceof Error ? cause.message : String(cause));
          error.hidden = false;
          input.inputEl.setAttribute('aria-invalid', 'true');
          return false;
        }
      };
      if (mode === 'custom') validate();
      input.onChange(async (value) => {
        customFolder = value;
        if (!validate()) return;
        this.plugin.settings.imageImportFolder = value;
        await this.plugin.saveData(this.plugin.settings);
      });
      location.addDropdown((dropdown) => {
        dropdown.selectEl.setAttribute('aria-label', 'Save imported images to');
        dropdown.addOption('obsidian', 'Obsidian attachment location')
          .addOption('custom', 'Custom folder')
          .addOption('root', 'Vault root')
          .setValue(mode).onChange(async (value) => {
            custom.settingEl.hidden = value !== 'custom';
            error.hidden = true;
            input.inputEl.removeAttribute('aria-invalid');
            if (value === 'custom' && !validate()) return;
            this.plugin.settings.imageImportFolder = value === 'root' ? '/' : value === 'custom' ? customFolder : '';
            await this.plugin.saveData(this.plugin.settings);
            if (value === 'custom') input.inputEl.focus();
          });
      });
    });
    images.createEl('p', { cls: 'nh-footnote', text: 'Obsidian’s attachment location can be relative to each note. Existing imported images are never moved.' });
  }
}
