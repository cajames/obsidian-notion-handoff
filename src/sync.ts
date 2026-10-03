import { mergeText, firstPullDiff } from './sync-text';
import { normalizeBody } from './sync-remote';
import { codeRanges } from './markdown';
import { parseNote } from './note';

export function makeCheckpoint(local: string, remote: string, observed: string, bindings: { remote: string; local: string }[] = []) {
  return { local, remote, observed, bindings };
}

export function parseCheckpoints(raw: string) {
  const data = JSON.parse(raw);
  if (!data || Array.isArray(data) || typeof data !== 'object') throw new Error('Invalid sync checkpoint file.');
  for (const value of Object.values(data)) {
    const entry = value as ReturnType<typeof makeCheckpoint>;
    if (!entry || typeof entry.local !== 'string' || typeof entry.remote !== 'string' ||
      typeof entry.observed !== 'string' || !Array.isArray(entry.bindings) ||
      entry.bindings.some((binding) => !binding || typeof binding.local !== 'string' || typeof binding.remote !== 'string')) {
      throw new Error('Invalid sync checkpoint; repair or remove sync-state.json before syncing.');
    }
  }
  return data as Record<string, ReturnType<typeof makeCheckpoint>>;
}

export function restoreBindings(body: string, bindings: ReturnType<typeof makeCheckpoint>['bindings']) {
  const replacements = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const binding of bindings) {
    if (!binding.remote) continue;
    if (replacements.has(binding.remote) && replacements.get(binding.remote) !== binding.local) ambiguous.add(binding.remote);
    replacements.set(binding.remote, binding.local);
  }
  for (const remote of ambiguous) replacements.delete(remote);
  if (!replacements.size) return body;
  const pattern = [...replacements.keys()].sort((a, b) => b.length - a.length)
    .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const ranges = codeRanges(body);
  return body.replace(new RegExp(pattern, 'g'), (match, offset: number) =>
    ranges.some((range) => offset >= range.start && offset < range.end) ? match : replacements.get(match)!);
}

export function hasMergeMarkers(body: string) {
  return /^(?:<<<<<<< Obsidian|\|{7} Last synced|>>>>>>> Notion)$/m.test(body);
}

function merge(local: string, base: string, remote: string) {
  return mergeText(local, base, remote);
}

export function planPull(local: string, remote: string, checkpoint: ReturnType<typeof makeCheckpoint> | null) {
  if (!checkpoint) {
    const equal = normalizeBody(local) === normalizeBody(remote);
    return { body: equal ? local : firstPullDiff(local, remote),
      proposal: equal ? local : mergeText(local, local, remote).body,
      review: !equal, firstPull: true, baseLocal: remote, baseRemote: remote };
  }
  if (normalizeBody(remote) === normalizeBody(checkpoint.remote)) {
    return { body: local, proposal: local, review: false, firstPull: false, baseLocal: checkpoint.local, baseRemote: checkpoint.remote };
  }
  // Separate local and remote baselines account for Notion's serialization changes.
  // Project remote edits onto the old local baseline before merging local edits.
  const projected = merge(checkpoint.local, checkpoint.remote, remote);
  const result = projected.conflicts ? merge(local, checkpoint.remote, remote) : merge(local, checkpoint.local, projected.body);
  const proposal = projected.conflicts
    ? mergeText(local, checkpoint.remote, remote, true).body
    : mergeText(local, checkpoint.local, projected.body, true).body;
  return { body: result.body, proposal, review: projected.conflicts || result.conflicts, firstPull: false,
    baseLocal: projected.conflicts ? remote : projected.body, baseRemote: remote };
}

export function replaceNoteBody(source: string, body: string) {
  const note = parseNote(source);
  const prefix = source.slice(0, source.length - note.body.length);
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const ending = note.body.endsWith('\n') && !body.endsWith('\n') ? newline : '';
  return prefix + body.replace(/\r\n/g, '\n').replace(/\n/g, newline) + ending;
}

export async function applyPull(source: string, remote: string, observed: string,
  checkpoint: ReturnType<typeof makeCheckpoint> | null,
  bindings: ReturnType<typeof makeCheckpoint>['bindings'],
  files: { path: string; bytes: Uint8Array }[], deps: {
    read: () => Promise<string>;
    prepareNote?: (source: string) => string;
    review: (local: string, remote: string, merged: string, firstPull: boolean) => Promise<string | null>;
    backup: (source: string) => Promise<void>;
    writeFile: (path: string, bytes: Uint8Array) => Promise<void>;
    write: (expected: string, updated: string) => Promise<void>;
    saveCheckpoint: (checkpoint: ReturnType<typeof makeCheckpoint>) => Promise<void>;
  }) {
  const local = parseNote(source).body;
  const plan = planPull(local, remote, checkpoint);
  const body = plan.review ? await deps.review(local, remote, plan.proposal, plan.firstPull) : plan.body;
  if (body === null) return { cancelled: true, changed: false };
  if (hasMergeMarkers(body)) throw new Error('Resolve all merge markers before saving.');
  if (await deps.read() !== source) throw new Error('The note changed during pull. Pull again to merge the latest edits.');
  const merged = body === local ? source : replaceNoteBody(source, body);
  const updated = deps.prepareNote ? deps.prepareNote(merged) : merged;
  if (updated !== source) await deps.backup(source);
  for (const file of files) await deps.writeFile(file.path, file.bytes);
  // write must compare and update atomically (Obsidian vault.process).
  if (updated !== source) await deps.write(source, updated);
  const next = makeCheckpoint(plan.baseLocal, plan.baseRemote, observed, bindings);
  try { await deps.saveCheckpoint(next); }
  catch {
    throw new Error(`${updated !== source ? 'Pull content was saved and its original backup is available' : 'The note is unchanged'}, but its checkpoint could not be saved. Retry before pushing.`);
  }
  return { cancelled: false, changed: updated !== source };
}
