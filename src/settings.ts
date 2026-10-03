import { ButtonComponent, PluginSettingTab, Setting } from 'obsidian';
import type NotionHandoff from './main';
import { imageImportFolder } from './paths';

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
    workspaces.createEl('p', { cls: 'nh-section-description', text: 'Each note keeps its own workspace. Reordering this list never changes where notes are published.' });
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
      const hint = fields.createEl('p', { cls: 'nh-profile-hint' });
      const frontmatter = hint.createEl('code');
      const refreshName = () => {
        title.setText(profile.name.trim() || 'Unnamed workspace');
        frontmatter.setText(`notion_workspace: ${JSON.stringify(profile.name.trim())}`);
        const name = profile.name.trim() || 'unnamed workspace';
        card.querySelector('.nh-remove-profile')?.setAttribute('aria-label', `Remove ${name} profile`);
        card.querySelector('.nh-move-up')?.setAttribute('aria-label', `Move ${name} up`);
        card.querySelector('.nh-move-down')?.setAttribute('aria-label', `Move ${name} down`);
      };
      refreshName();
      new Setting(fields).setName('Workspace name').setDesc('Required. Match this name in your note’s frontmatter.')
        .addText((input) => {
          input.inputEl.setAttribute('aria-label', 'Workspace name');
          input.inputEl.required = true;
          input.setPlaceholder('Client or workspace name').setValue(profile.name).onChange(async (value) => {
            profile.name = value;
            refreshName();
            await this.plugin.saveData(this.plugin.settings);
          });
        });
      new Setting(fields).setName('Notion API token').setDesc('Share your target pages with this integration.')
        .addText((input) => {
          input.inputEl.type = 'password';
          input.inputEl.autocomplete = 'off';
          input.inputEl.spellcheck = false;
          input.inputEl.setAttribute('aria-label', 'Notion API token');
          input.setPlaceholder('Paste integration token').setValue(profile.token).onChange(async (value) => {
            profile.token = value;
            await this.plugin.saveData(this.plugin.settings);
          });
        });
      new Setting(fields).setName('Parent page ID').setDesc('New notes become pages inside this Notion page.')
        .addText((input) => {
          input.inputEl.spellcheck = false;
          input.inputEl.setAttribute('aria-label', 'Parent page ID');
          input.setPlaceholder('Notion page ID').setValue(profile.parentId).onChange(async (value) => {
            profile.parentId = value;
            await this.plugin.saveData(this.plugin.settings);
          });
        });
      const footer = card.createDiv({ cls: 'nh-profile-footer' });
      footer.createSpan({ text: 'Selected by notion_workspace in your note.' });
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
