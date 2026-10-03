import { describe, expect, it, vi } from 'vitest';
import { applyPull, makeCheckpoint, parseCheckpoints, planPull, replaceNoteBody, restoreBindings } from '../src/sync';

function vault(source: string) {
  let current = source;
  const backups: string[] = [];
  const events: string[] = [];
  let checkpoint = makeCheckpoint('', '', '');
  const deps = {
    read: vi.fn(async () => current),
    review: vi.fn(async (_local: string, remote: string) => remote as string | null),
    backup: vi.fn(async (body: string) => { backups.push(body); events.push('backup'); }),
    writeFile: vi.fn(async () => { events.push('image'); }),
    write: vi.fn(async (expected: string, updated: string) => {
      if (current !== expected) throw new Error('Concurrent edit');
      current = updated; events.push('note');
    }),
    saveCheckpoint: vi.fn(async (next: ReturnType<typeof makeCheckpoint>) => { checkpoint = next; events.push('checkpoint'); }),
  };
  return { deps, backups, events, read: () => current, edit: (body: string) => { current = body; }, checkpoint: () => checkpoint };
}

describe('three-way pull', () => {
  it('autosaves independent local and remote changes, with backup and frontmatter intact', async () => {
    const base = '# Title\n\nIntroduction\n\nEnding';
    const local = base.replace('Introduction', 'Local introduction');
    const remote = base.replace('Ending', 'Notion ending');
    const source = `---\r\nnotion_id: page\r\nnotion_workspace: Work # keep\r\ntags: [project]\r\n---\r\n${local.replace(/\n/g, '\r\n')}\r\n`;
    const store = vault(source);
    expect(await applyPull(source, remote, 'observed', makeCheckpoint(base, base, 'previous'), [],
      [{ path: 'new.png', bytes: new Uint8Array([1]) }], store.deps)).toEqual({ cancelled: false, changed: true });
    expect(store.deps.review).not.toHaveBeenCalled();
    expect(store.backups).toEqual([source]);
    expect(store.events).toEqual(['backup', 'image', 'note', 'checkpoint']);
    expect(store.read()).toBe(source.replace('Ending', 'Notion ending'));
    // Pending local changes are NOT absorbed into the new baseline.
    expect(store.checkpoint().local).toBe(remote);
  });

  it('preserves outstanding local edits across repeated pulls', async () => {
    const base = 'Title\n\nLocal section\n\nRemote section\n\nFooter';
    const local = base.replace('Local section', 'Local work');
    const store = vault(local);
    const first = base.replace('Remote section', 'Remote work');
    await applyPull(local, first, 'v1', makeCheckpoint(base, base, 'v0'), [], [], store.deps);
    const second = first.replace('Footer', 'Remote footer');
    await applyPull(store.read(), second, 'v2', store.checkpoint(), [], [], store.deps);
    expect(store.read()).toBe(second.replace('Local section', 'Local work'));
    expect(store.deps.review).not.toHaveBeenCalled();
    expect(store.checkpoint().local).toBe(second);
  });

  it('keeps local changes when Notion is unchanged, without writing a backup or note', async () => {
    const store = vault('Local edits');
    await applyPull('Local edits', 'Base', 'same', makeCheckpoint('Base', 'Base', 'same'), [], [], store.deps);
    expect(store.read()).toBe('Local edits');
    expect(store.events).toEqual(['checkpoint']);
    expect(store.checkpoint().local).toBe('Base');
  });

  it('requires review on a first pull and leaves everything untouched on cancel', async () => {
    const store = vault('Local');
    store.deps.review.mockResolvedValueOnce(null);
    expect(await applyPull('Local', 'Notion', 'v1', null, [], [{ path: 'new.png', bytes: new Uint8Array([1]) }], store.deps))
      .toEqual({ cancelled: true, changed: false });
    expect(store.deps.review).toHaveBeenCalledWith('Local', 'Notion', 'Notion', true);
    expect(store.events).toEqual([]);
    expect(store.read()).toBe('Local');
  });

  it('requires conflict review, accepts a resolution, and retains local choices as pending changes', async () => {
    const store = vault('Local edit');
    store.deps.review.mockResolvedValueOnce('Combined resolution');
    await applyPull('Local edit', 'Notion edit', 'v1', makeCheckpoint('Original', 'Original', 'v0'), [], [], store.deps);
    expect(store.deps.review).toHaveBeenCalledWith('Local edit', 'Notion edit', 'Notion edit', false);
    expect(store.read()).toBe('Combined resolution');
    expect(store.checkpoint().local).toBe('Notion edit');
  });

  it('handles identical edits and remote deletions without false conflicts', () => {
    const checkpoint = makeCheckpoint('A\n\nB\n\nC', 'A\n\nB\n\nC', 'base');
    expect(planPull('A\n\nUpdated\n\nC', 'A\n\nUpdated\n\nC', checkpoint).review).toBe(false);
    expect(planPull('Local A\n\nB\n\nC', 'A\n\nC', checkpoint)).toMatchObject({ review: false, body: 'Local A\n\nC' });
  });

  it('uses separate serialization baselines without losing local syntax', () => {
    const localBase = '- Item\n\nParagraph\n\nFooter';
    const remoteBase = '* Item\n\nParagraph\n\nFooter';
    const result = planPull(localBase.replace('Item', 'Local item'), remoteBase.replace('Footer', 'Remote footer'),
      makeCheckpoint(localBase, remoteBase, 'base'));
    expect(result).toMatchObject({ review: false, body: '- Local item\n\nParagraph\n\nRemote footer' });
  });

  it('refuses to save unresolved markers or overwrite a note edited during review', async () => {
    const store = vault('Local');
    store.deps.review.mockResolvedValueOnce('<<<<<<< Obsidian\nLocal\n=======\nNotion\n>>>>>>> Notion');
    await expect(applyPull('Local', 'Notion', 'v1', null, [], [], store.deps)).rejects.toThrow('Resolve all merge markers');
    store.deps.review.mockImplementationOnce(async () => { store.edit('New local edit'); return 'Resolved'; });
    await expect(applyPull('Local', 'Notion', 'v1', null, [], [], store.deps)).rejects.toThrow('note changed');
    expect(store.events).toEqual([]);
    expect(store.read()).toBe('New local edit');
  });

  it('handles edits racing the atomic save and does not advance the checkpoint', async () => {
    const store = vault('Base');
    store.deps.backup.mockImplementationOnce(async () => { store.edit('Concurrent edit'); });
    await expect(applyPull('Base', 'Remote', 'v1', makeCheckpoint('Base', 'Base', 'v0'), [], [], store.deps)).rejects.toThrow('Concurrent edit');
    expect(store.read()).toBe('Concurrent edit');
    expect(store.deps.saveCheckpoint).not.toHaveBeenCalled();
  });

  it('reports checkpoint persistence failures after a saved pull', async () => {
    const store = vault('Base');
    store.deps.saveCheckpoint.mockRejectedValueOnce(new Error('Disk full'));
    await expect(applyPull('Base', 'Remote', 'v1', makeCheckpoint('Base', 'Base', 'v0'), [], [], store.deps)).rejects.toThrow('content was saved');
    expect(store.read()).toBe('Remote');
    expect(store.backups).toEqual(['Base']);
  });
});

describe('sync representations', () => {
  it('preserves frontmatter and BOM verbatim when replacing only the body', () => {
    const source = '\uFEFF---\nnotion_id: id\nnotion_workspace: "Work" # keep\ntags: [one]\n---\nOld\n';
    expect(replaceNoteBody(source, 'New')).toBe(source.replace('Old', 'New'));
  });

  it('restores known embeds and links without rewriting code or chaining replacements', () => {
    expect(restoreBindings('image mention `image`', [{ remote: 'image', local: '![[plan.tldr]]' }, { remote: 'mention', local: 'image' }]))
      .toBe('![[plan.tldr]] image `image`');
    expect(restoreBindings('ambiguous', [{ remote: 'ambiguous', local: 'One' }, { remote: 'ambiguous', local: 'Two' }])).toBe('ambiguous');
  });

  it('validates checkpoints rather than trusting corrupt persisted state', () => {
    const checkpoint = makeCheckpoint('Local', 'Remote', 'hash', [{ local: '[[Note]]', remote: 'mention' }]);
    expect(parseCheckpoints(JSON.stringify({ key: checkpoint }))).toEqual({ key: checkpoint });
    expect(() => parseCheckpoints('{')).toThrow();
    expect(() => parseCheckpoints('{"key":{"local":"bad"}}')).toThrow('Invalid sync checkpoint');
  });
});
