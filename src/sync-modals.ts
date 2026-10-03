import { App, Modal, Setting } from 'obsidian';
import { diffLines } from 'diff';
import { hasMergeMarkers } from './sync';
import { comparisonBody } from './sync-text';
import { acceptChunk, getChunks, rejectChunk } from '@codemirror/merge';
import { undo, undoDepth } from '@codemirror/commands';
import { reviewEditor } from './sync-review';

function showDiff(container: HTMLElement, local: string, remote: string) {
  const details = container.createEl('details');
  details.createEl('summary', { text: 'Show changes: Obsidian → Notion (formatting whitespace ignored)' });
  const pre = details.createEl('pre');
  pre.style.cssText = 'max-height: 280px; overflow: auto; white-space: pre-wrap;';
  for (const part of diffLines(comparisonBody(local), comparisonBody(remote))) {
    const prefix = part.added ? '+ ' : part.removed ? '− ' : '  ';
    const text = part.value.replace(/\n$/, '').split('\n').map((line) => prefix + line).join('\n') + (part.value.endsWith('\n') ? '\n' : '');
    const span = pre.createSpan({ text });
    if (part.added) span.style.color = 'var(--text-success)';
    if (part.removed) span.style.color = 'var(--text-error)';
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
    this.contentEl.createEl('h2', { text: this.firstPush ? 'Replace existing Notion content?' : 'Notion changed since your last sync' });
    this.contentEl.createEl('p', { text: 'Pushing replaces the Notion page with your local note. Pull first to merge its changes, or confirm to overwrite them.' });
    showDiff(this.contentEl, this.local, this.remote);
    new Setting(this.contentEl)
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
