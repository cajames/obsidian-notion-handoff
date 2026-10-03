import { App, Modal, Setting, setIcon } from 'obsidian';
import { diffLines } from 'diff';
import { hasMergeMarkers } from './sync';
import { comparisonBody } from './sync-text';
import { acceptChunk, getChunks, rejectChunk } from '@codemirror/merge';
import { undo, undoDepth } from '@codemirror/commands';
import { reviewEditor } from './sync-review';

function showDiff(container: HTMLElement, local: string, remote: string) {
  // Preview the actual push: replace the remote content with the local note.
  const parts = diffLines(comparisonBody(remote), comparisonBody(local));
  const added = parts.reduce((count, part) => count + (part.added ? part.count ?? 0 : 0), 0);
  const removed = parts.reduce((count, part) => count + (part.removed ? part.count ?? 0 : 0), 0);
  const details = container.createEl('details', { cls: 'nh-push-diff' });
  const summary = details.createEl('summary', { cls: 'nh-diff-summary' });
  summary.createSpan({ text: 'Review what will change' });
  summary.createSpan({ cls: 'nh-diff-count', text: `${removed} removed · ${added} added` });
  const legend = details.createDiv({ cls: 'nh-diff-legend' });
  legend.createSpan({ cls: 'nh-diff-removed', text: '− Removed from Notion' });
  legend.createSpan({ cls: 'nh-diff-added', text: '+ Added from Obsidian' });
  legend.createSpan({ cls: 'nh-diff-note', text: 'Formatting-only whitespace changes are ignored.' });
  const pre = details.createEl('pre', { cls: 'nh-diff-content' });
  for (const part of parts) {
    const prefix = part.added ? '+ ' : part.removed ? '− ' : '  ';
    const text = part.value.replace(/\n$/, '').split('\n').map((line) => prefix + line).join('\n') + '\n';
    pre.createSpan({ text, cls: part.added ? 'nh-diff-added' : part.removed ? 'nh-diff-removed' : 'nh-diff-unchanged' });
  }
}

class PullReview extends Modal {
  private result: string | null = null;
  private destroyEditor = () => {};
  constructor(app: App, private local: string, private proposed: string,
    private firstPull: boolean, private finish: (body: string | null) => void) { super(app); }

  onOpen() {
    this.modalEl.style.width = 'min(1000px, 95vw)';
    this.contentEl.createEl('h2', { text: this.firstPull ? 'Review first pull' : 'Review sync changes' });
    this.contentEl.createEl('p', { text: this.firstPull
      ? 'No sync baseline yet. Choose Take Notion or Keep Obsidian for each change. Nothing is saved until you confirm.'
      : 'Local edits are preserved outside conflicts. Choose Take Notion or Keep Obsidian for each change.' });
    const legend = this.contentEl.createDiv();
    legend.style.cssText = 'display: flex; flex-wrap: wrap; gap: 16px; margin-bottom: 12px; font-size: var(--font-small);';
    legend.createSpan({ text: '− Obsidian' }).style.color = 'var(--text-error)';
    legend.createSpan({ text: '+ Proposed result' }).style.color = 'var(--text-success)';
    legend.createSpan({ text: 'Edit inline if needed · formatting-only changes ignored' }).style.color = 'var(--text-muted)';
    let refresh = () => {};
    const editor = reviewEditor(this.contentEl.createDiv(), this.local, this.proposed, () => refresh());
    this.destroyEditor = () => editor.destroy();
    const status = this.contentEl.createEl('p');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    const decideAll = (takeNotion: boolean) => {
      for (let chunk = getChunks(editor.state)?.chunks[0]; chunk; chunk = getChunks(editor.state)?.chunks[0]) {
        if (!(takeNotion ? acceptChunk : rejectChunk)(editor, chunk.fromB)) break;
      }
    };
    const toolbar = this.contentEl.createDiv();
    toolbar.style.cssText = 'display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 16px;';
    const action = (label: string, click: () => void) => {
      const button = toolbar.createEl('button', { text: label });
      button.type = 'button';
      button.addEventListener('click', click);
      return button;
    };
    action('Take all changes', () => decideAll(true));
    action('Keep all Obsidian', () => decideAll(false));
    const undoButton = action('Undo', () => undo(editor));
    new Setting(this.contentEl)
      .addButton((button) => button.setButtonText('Cancel').onClick(() => this.close()))
      .addButton((button) => {
        button.setButtonText('Save merged note').setCta().onClick(() => {
          if (getChunks(editor.state)?.chunks.length || hasMergeMarkers(editor.state.doc.toString())) return;
          this.result = editor.state.doc.toString();
          this.close();
        });
        refresh = () => {
          const remaining = getChunks(editor.state)?.chunks.length ?? 0;
          const markers = hasMergeMarkers(editor.state.doc.toString());
          button.setDisabled(remaining > 0 || markers);
          status.setText(markers ? 'Remove existing conflict markers before saving.' : remaining
            ? `${remaining} ${remaining === 1 ? 'change needs' : 'changes need'} a decision. Nothing saved yet.`
            : 'All changes reviewed. Save creates a backup before changing your note; push remains separate.');
          undoButton.disabled = !undoDepth(editor.state);
        };
      });
    refresh();
  }

  onClose() { this.destroyEditor(); this.finish(this.result); this.contentEl.empty(); }
}

export function reviewPull(app: App, local: string, _remote: string, proposed: string, firstPull: boolean) {
  return new Promise<string | null>((resolve) => new PullReview(app, local, proposed, firstPull, resolve).open());
}

class PushConfirmation extends Modal {
  private confirmed = false;
  constructor(app: App, private local: string, private remote: string, private firstPush: boolean,
    private finish: (confirmed: boolean) => void) { super(app); }

  onOpen() {
    this.modalEl.classList.add('notion-handoff-push-modal');
    this.contentEl.classList.add('notion-handoff-push');
    const header = this.contentEl.createDiv({ cls: 'nh-push-header' });
    header.createSpan({ text: 'Notion Handoff · Push' });
    const direction = header.createSpan({ cls: 'nh-direction' });
    direction.createSpan({ text: 'Obsidian' });
    const arrow = direction.createSpan({ attr: { 'aria-hidden': 'true' } });
    setIcon(arrow, 'arrow-right');
    direction.createSpan({ text: 'Notion' });
    this.contentEl.createEl('h2', { text: this.firstPush ? 'Replace existing Notion content?' : 'Notion changed since your last sync' });
    const warning = this.contentEl.createDiv({ cls: 'nh-push-warning' });
    const icon = warning.createSpan({ cls: 'nh-warning-icon', attr: { 'aria-hidden': 'true' } });
    setIcon(icon, 'triangle-alert');
    const message = warning.createDiv();
    message.createEl('strong', { text: 'Notion edits will be replaced.' });
    message.createEl('p', { text: 'Your local note will replace the page’s content. Cancel and pull first to keep both sets of edits.' });
    showDiff(this.contentEl, this.local, this.remote);
    new Setting(this.contentEl).setClass('nh-push-actions')
      .addButton((button) => button.setButtonText('Cancel — pull first').onClick(() => this.close()))
      .addButton((button) => button.setButtonText('Push anyway').setWarning().onClick(() => {
        this.confirmed = true;
        this.close();
      }));
  }

  onClose() { this.finish(this.confirmed); this.contentEl.empty(); }
}

export function confirmPush(app: App, local: string, remote: string, firstPush: boolean) {
  return new Promise<boolean>((resolve) => new PushConfirmation(app, local, remote, firstPush, resolve).open());
}

class WorkspacePicker extends Modal {
  private selection: string | null = null;
  constructor(app: App, private names: string[], private noteName: string, private finish: (name: string | null) => void) { super(app); }

  onOpen() {
    this.modalEl.classList.add('notion-handoff-workspace-picker');
    this.contentEl.classList.add('notion-handoff-push');
    this.contentEl.createEl('h2', { text: 'Choose a workspace' });
    this.contentEl.createEl('p', { cls: 'nh-picker-description', text: `Select the Notion workspace for “${this.noteName}”. This choice will be saved with the note; reordering workspaces won’t change it.` });
    let selected = this.names.find((name) => name.trim()) ?? '';
    const choice = new Setting(this.contentEl).setClass('nh-workspace-choice');
    new Setting(this.contentEl).setClass('nh-push-actions')
      .addButton((button) => button.setButtonText('Cancel').onClick(() => this.close()))
      .addButton((button) => {
        button.setButtonText('Use workspace').setCta().setDisabled(!selected).onClick(() => {
          if (!selected || !this.names.includes(selected)) return;
          this.selection = selected;
          this.close();
        });
        choice.addDropdown((dropdown) => {
          dropdown.selectEl.setAttribute('aria-label', 'Notion workspace');
          for (const name of this.names) if (name.trim()) dropdown.addOption(name, name);
          dropdown.setValue(selected).onChange((value) => {
            selected = value;
            button.setDisabled(!selected);
          });
        });
      });
  }

  onClose() { this.finish(this.selection); this.contentEl.empty(); }
}

export function pickWorkspace(app: App, names: string[], noteName: string) {
  return new Promise<string | null>((resolve) => new WorkspacePicker(app, names, noteName, resolve).open());
}
