import { EditorView, keymap } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, invertedEffects } from '@codemirror/commands';
import { getOriginalDoc, unifiedMergeView, updateOriginalDoc } from '@codemirror/merge';

export function reviewEditor(parent: HTMLElement, local: string, proposed: string, changed: () => void) {
  return new EditorView({
    parent,
    doc: proposed,
    extensions: [
      unifiedMergeView({
        original: local.replace(/\r\n/g, '\n'),
        allowInlineDiffs: true,
        syntaxHighlightDeletions: false,
        collapseUnchanged: { margin: 3, minSize: 8 },
        mergeControls: (type, action) => {
          const button = document.createElement('button');
          button.type = 'button';
          button.dataset.action = type;
          button.textContent = type === 'accept' ? 'Take Notion' : 'Keep Obsidian';
          button.setAttribute('aria-label', `${button.textContent} for this change`);
          button.addEventListener('click', action);
          return button;
        },
      }),
      history({ newGroupDelay: 0 }),
      // CodeMirror records document edits automatically. Accepting a chunk
      // changes its comparison baseline instead, so record that effect too.
      invertedEffects.of((transaction) => transaction.effects.filter((effect) => effect.is(updateOriginalDoc)).map((effect) => {
        const original = getOriginalDoc(transaction.startState);
        return updateOriginalDoc.of({ doc: original, changes: effect.value.changes.invert(original) });
      })),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      EditorView.lineWrapping,
      EditorView.contentAttributes.of({ 'aria-label': 'Merged result — saved to Obsidian' }),
      EditorView.updateListener.of(() => changed()),
      EditorView.theme({
        '&': { height: 'min(45vh, 520px)', minHeight: '260px', border: '1px solid var(--background-modifier-border)', borderRadius: '6px', backgroundColor: 'var(--background-primary)', color: 'var(--text-normal)' },
        '.cm-scroller': { overflow: 'auto', fontFamily: 'var(--font-monospace)', fontSize: 'var(--font-smaller)', lineHeight: '1.6' },
        '.cm-content': { padding: '12px 0', caretColor: 'var(--text-normal)' },
        '.cm-line': { padding: '0 16px' },
        '.cm-gutters': { backgroundColor: 'var(--background-secondary)', borderRight: '1px solid var(--background-modifier-border)' },
        '.cm-deletedChunk': { backgroundColor: 'rgba(var(--color-red-rgb), 0.08)', padding: '0 16px' },
        '.cm-deletedLine': { color: 'var(--text-error)' },
        '&.cm-merge-b .cm-changedLine, .cm-inlineChangedLine': { backgroundColor: 'rgba(var(--color-green-rgb), 0.08)' },
        '&.cm-merge-b .cm-line .cm-changedText': { background: 'rgba(var(--color-green-rgb), 0.22)', color: 'var(--text-success)' },
        '&.cm-merge-b .cm-deletedText, &.cm-merge-b .cm-deletedChunk .cm-deletedText': { background: 'rgba(var(--color-red-rgb), 0.22)', color: 'var(--text-error)' },
        '.cm-deletedChunk .cm-chunkButtons': { position: 'static', display: 'flex', flexWrap: 'wrap', gap: '6px', justifyContent: 'flex-end', padding: '8px 0', opacity: '1' },
        '.cm-deletedChunk .cm-chunkButtons button': { fontFamily: 'var(--font-interface)', fontSize: 'var(--font-smallest)', margin: '0', color: 'var(--text-normal)', backgroundColor: 'var(--interactive-normal)', border: '1px solid var(--background-modifier-border)' },
        '.cm-deletedChunk .cm-chunkButtons button[data-action=accept]': { color: 'var(--text-success)' },
        '.cm-deletedChunk .cm-chunkButtons button:focus-visible': { outline: '2px solid var(--interactive-accent)', outlineOffset: '2px' },
        '.cm-cursor': { borderLeftColor: 'var(--text-normal)' },
        '.cm-collapsedLines': { color: 'var(--text-muted)', backgroundColor: 'var(--background-secondary)' },
      }),
    ],
  });
}
