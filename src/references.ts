import { randomId } from './ids';
import { posix } from 'path-browserify';
import { isExcalidraw } from './attachments';
import { isTldraw } from './tldraw';
import { parseNote } from './note';
import { codeRanges } from './markdown';
import { resolveProfile } from './profiles';

const NOTE_ID = /^(?:[a-f\d]{32}|[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12})$/i;

function noteName(path: string) {
  return posix.basename(path.replace(/\\/g, '/')).replace(/\.md$/i, '');
}

function escapeHtml(value: string) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function renderReferences(body: string, references: { token: string; mention: string; pending: string }[], pending = false) {
  for (const reference of references) body = body.replaceAll(reference.token, pending ? reference.pending : reference.mention);
  return body;
}

export async function resolveReferences(body: string, from: string, currentProfile: { name: string; token: string; parentId: string }, deps: {
  resolve: (path: string, from: string) => { path: string; name: string } | null;
  markdownFiles: () => { path: string; basename: string }[];
  read: (file: { path: string }) => Promise<string>;
  isTldraw?: (file: { path: string }) => boolean;
  profiles: { name: string; token: string; parentId: string }[];
}) {
  const references: { token: string; mention: string; pending: string; label: string; id: string }[] = [];
  const bindings: { remote: string; local: string }[] = [];
  const ranges = codeRanges(body);
  const regex = /(!?)\[\[([^\]\n]+)\]\]/g;
  let output = '';
  let previous = 0;
  const nonce = randomId();
  for (const [index, match] of [...body.matchAll(regex)].entries()) {
    output += body.slice(previous, match.index);
    previous = match.index + match[0].length;
    if (match[1] === '!' || ranges.some((range) => match.index >= range.start && match.index < range.end)) {
      output += match[0]; // Preserve embeds and literal code examples.
      continue;
    }
    const [rawPath, alias] = match[2].split('|', 2);
    const path = rawPath.trim().split('#')[0];
    const plain = alias?.trim() || rawPath.trim();
    const title = alias?.trim() || noteName(path || rawPath.trim());
    if (isExcalidraw(path) || isTldraw(path)) {
      output += plain;
      bindings.push({ remote: plain, local: match[0] });
      continue;
    }
    // A bare basename with multiple Markdown matches is ambiguous even if Obsidian picks one.
    const ambiguous = !path.includes('/') && !path.includes('\\') &&
      deps.markdownFiles().filter((file) => file.basename.toLowerCase() === noteName(path).toLowerCase()).length > 1;
    const target = ambiguous ? null : deps.resolve(path, from);
    const isNote = target ? target.path.toLowerCase().endsWith('.md') && !isExcalidraw(target.path) &&
      !isTldraw(target.path) && !deps.isTldraw?.(target)
      : !posix.extname(path) || /\.md$/i.test(path);
    if (!isNote) {
      output += plain; // Non-note wiki-links retain the original plain-text behavior.
      bindings.push({ remote: plain, local: match[0] });
      continue;
    }
    let id: string | null = null;
    if (target) {
      try {
        const note = parseNote(await deps.read(target));
        if (note.notionId && NOTE_ID.test(note.notionId) &&
          resolveProfile(deps.profiles, note.notionWorkspace) === currentProfile) id = note.notionId;
      } catch { /* Unreadable or invalid frontmatter: link pending. */ }
    }
    const pending = `${title} (link pending)`;
    if (!id) {
      output += pending;
      bindings.push({ remote: pending, local: match[0] });
      continue;
    }
    const token = `NTN_SYNC_NOTE_${nonce}_${index}`;
    // Enhanced markdown uses mention-page for inline rich-text mentions; page is a child-page block.
    const mention = `<mention-page url="https://www.notion.so/${id.replace(/-/g, '')}">${escapeHtml(title)}</mention-page>`;
    references.push({ token, mention, pending, label: title, id });
    bindings.push({ remote: mention, local: match[0] });
    output += token;
  }
  return { body: output + body.slice(previous), references, bindings };
}
