// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorView } from '@codemirror/view';
import { getChunks } from '@codemirror/merge';
import { confirmPush, reviewPull } from '../src/sync-modals';
import { makeCheckpoint, planPull } from '../src/sync';
import { createTestApp, installDomHelpers, Modal } from './helpers/obsidian';

function open(local: string, remote: string, base?: string) {
  const plan = planPull(local, remote, base === undefined ? null : makeCheckpoint(base, base, 'base'));
  const result = reviewPull(createTestApp().app as never, local, remote, plan.proposal, plan.firstPull);
  const modal = Modal.opened.at(-1)!;
  const editor = EditorView.findFromDOM(modal.contentEl.querySelector<HTMLElement>('.cm-editor')!)!;
  const button = (label: string) => Array.from(modal.contentEl.querySelectorAll('button')).find((button) => button.textContent === label)!;
  const click = (label: string) => { expect(button(label).disabled).toBe(false); button(label).click(); };
  return { modal, editor, result, button, click, remaining: () => getChunks(editor.state)!.chunks.length };
}

beforeEach(() => {
  installDomHelpers();
  Modal.opened = [];
  document.body.replaceChildren();
});
afterEach(() => { for (const modal of Modal.opened) modal.close(); });

describe('push confirmation', () => {
  it('shows the actual outbound diff and keeps cancellation separate from pushing', async () => {
    const result = confirmPush(createTestApp().app as never, 'Shared\nLocal addition', 'Shared\nNotion edit', false);
    const modal = Modal.opened.at(-1)!;
    expect(modal.modalEl.classList.contains('notion-handoff-push-modal')).toBe(true);
    expect(modal.contentEl.textContent).toContain('Notion edits will be replaced.');
    const details = modal.contentEl.querySelector('details')!;
    expect(details.open).toBe(false);
    details.open = true;
    expect(details.querySelector('.nh-diff-count')?.textContent).toBe('1 removed · 1 added');
    expect(details.querySelector('pre .nh-diff-removed')?.textContent).toBe('− Notion edit\n');
    expect(details.querySelector('pre .nh-diff-added')?.textContent).toBe('+ Local addition\n');
    const buttons = Array.from(modal.contentEl.querySelectorAll('button'));
    expect(buttons.map((button) => button.textContent)).toEqual(['Cancel — pull first', 'Push anyway']);
    expect(buttons[1].classList.contains('mod-warning')).toBe(true);
    buttons[0].click();
    expect(await result).toBe(false);
  });

  it('requires explicit confirmation and treats dismissal as cancellation', async () => {
    const result = confirmPush(createTestApp().app as never, 'Local', 'Remote', true);
    const modal = Modal.opened.at(-1)!;
    expect(modal.contentEl.querySelector('h2')?.textContent).toBe('Replace existing Notion content?');
    Array.from(modal.contentEl.querySelectorAll('button')).find((button) => button.textContent === 'Push anyway')!.click();
    expect(await result).toBe(true);
    const dismissed = confirmPush(createTestApp().app as never, 'Local', 'Remote', false);
    Modal.opened.at(-1)!.close();
    expect(await dismissed).toBe(false);
  });

  it('does not count formatting-only whitespace as changed lines', async () => {
    const result = confirmPush(createTestApp().app as never, 'Text  with spaces\n\nFooter', 'Text with spaces\nFooter', false);
    const modal = Modal.opened.at(-1)!;
    expect(modal.contentEl.querySelector('.nh-diff-count')?.textContent).toBe('0 removed · 0 added');
    modal.close();
    expect(await result).toBe(false);
  });
});

describe('inline pull review', () => {
  it('shows inline word colours and per-change actions instead of textareas or merge markers', async () => {
    const review = open('The sky is blue today.', 'The sky is green today.');
    expect(review.modal.contentEl.querySelector('textarea')).toBeNull();
    expect(review.modal.contentEl.textContent).not.toContain('<<<<<<<');
    expect(review.modal.contentEl.querySelector('.cm-deletedText')?.textContent).toBe('blue');
    expect(review.modal.contentEl.querySelector('.cm-changedText')?.textContent).toBe('green');
    expect(review.button('Take Notion').getAttribute('aria-label')).toContain('for this change');
    expect(review.button('Keep Obsidian')).toBeDefined();
    expect(review.button('Save merged note').disabled).toBe(true);
    const destroy = vi.spyOn(review.editor, 'destroy');
    review.click('Take Notion');
    expect(review.remaining()).toBe(0);
    expect(review.modal.contentEl.querySelector('[role=status]')?.textContent).toContain('All changes reviewed');
    review.click('Save merged note');
    expect(await review.result).toBe('The sky is green today.');
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('takes one change and keeps another without modifying shared context', async () => {
    const local = '# Note\n\nOriginal intro\n\nShared middle one\nShared middle two\n\nOriginal ending';
    const remote = local.replace('Original intro', 'Notion intro').replace('Original ending', 'Notion ending');
    const review = open(local, remote);
    expect(review.remaining()).toBe(2);
    review.click('Take Notion');
    expect(review.remaining()).toBe(1);
    expect(review.button('Save merged note').disabled).toBe(true);
    review.click('Keep Obsidian');
    review.click('Save merged note');
    expect(await review.result).toBe(local.replace('Original intro', 'Notion intro'));
  });

  it.each(['Take Notion', 'Keep Obsidian'])('handles deletions with %s', async (action) => {
    const local = 'Intro\n\nObsolete paragraph\n\nFooter';
    const remote = 'Intro\n\nFooter';
    const review = open(local, remote);
    review.click(action);
    review.click('Save merged note');
    expect(await review.result).toBe(action === 'Take Notion' ? remote : local);
  });

  it.each(['Take Notion', 'Keep Obsidian'])('handles an empty proposed document with %s', async (action) => {
    const review = open('Local note', '');
    review.click(action);
    review.click('Save merged note');
    expect(await review.result).toBe(action === 'Take Notion' ? '' : 'Local note');
  });

  it('undoes both accepted and rejected decisions, restoring their controls', async () => {
    const review = open('Local', 'Notion');
    review.click('Take Notion');
    expect(review.remaining()).toBe(0);
    review.click('Undo');
    expect(review.remaining()).toBe(1);
    expect(review.button('Save merged note').disabled).toBe(true);
    review.click('Keep Obsidian');
    expect(review.editor.state.doc.toString()).toBe('Local');
    review.click('Undo');
    expect(review.remaining()).toBe(1);
    expect(review.editor.state.doc.toString()).toBe('Notion');
    review.click('Take Notion');
    review.click('Save merged note');
    expect(await review.result).toBe('Notion');
  });

  it('allows manual combinations but requires accepting their edited result', async () => {
    const review = open('Local', 'Notion');
    review.editor.dispatch({ changes: { from: 0, to: review.editor.state.doc.length, insert: 'Combined result' } });
    expect(review.button('Save merged note').disabled).toBe(true);
    review.click('Take Notion');
    review.click('Save merged note');
    expect(await review.result).toBe('Combined result');
  });

  it('does not display serialization-only whitespace or URL-wrapper changes', async () => {
    const local = '# Note\n\nText  with spaces\n\nhttps://example.com\n';
    const remote = '# Note\nText with spaces\n[https://example.com](https://example.com)';
    const review = open(local, remote);
    expect(review.remaining()).toBe(0);
    expect(review.button('Take Notion')).toBeUndefined();
    review.click('Save merged note');
    expect(await review.result).toBe(local);
  });

  it('keeps meaningful code indentation selectable', async () => {
    const local = '# Note\n\n```ts\nconst x = 1;\n```\n';
    const remote = '# Note\n```ts\n  const x = 1;\n```';
    const review = open(local, remote);
    expect(review.remaining()).toBe(1);
    review.click('Take Notion');
    review.click('Save merged note');
    expect(await review.result).toBe(local.replace('const x', '  const x'));
  });

  it('preserves independent local edits when taking all incoming changes during a conflict', async () => {
    const base = 'Title\n\nIntro\n\nArea\n\nFooter';
    const local = base.replace('Intro', 'Local intro').replace('Area', 'Local area');
    const remote = base.replace('Area', 'Notion area').replace('Footer', 'Notion footer');
    const review = open(local, remote, base);
    expect(review.editor.state.doc.toString()).toContain('Local intro');
    expect(review.editor.state.doc.toString()).not.toContain('<<<<<<<');
    review.click('Take all changes');
    review.click('Save merged note');
    expect(await review.result).toBe(remote.replace('Intro', 'Local intro'));
  });

  it('can reject all changes or cancel without returning a modified note', async () => {
    const local = 'Intro\n\nMiddle\n\nFooter';
    const remote = 'Notion intro\n\nMiddle\n\nNotion footer';
    const review = open(local, remote);
    review.click('Keep all Obsidian');
    review.click('Save merged note');
    expect(await review.result).toBe(local);
    const cancelled = open(local, remote);
    const destroy = vi.spyOn(cancelled.editor, 'destroy');
    cancelled.click('Cancel');
    expect(await cancelled.result).toBeNull();
    expect(destroy).toHaveBeenCalledTimes(1);
  });
});
