import { parseDocument, isMap, isScalar } from 'yaml';
import { codeRanges } from './markdown';
import { sameId } from './note-links';

// Keep the original YAML text: a YAML serializer would reformat unrelated fields.
export function parseNote(source: string) {
  const bom = source.startsWith('\uFEFF') ? '\uFEFF' : '';
  const text = source.slice(bom.length);
  const opening = /^---[ \t]*\r?\n/.exec(text);
  if (!opening) return { body: text, title: null, notionId: null, notionWorkspace: null, notionWorkspaceId: null, frontmatter: null, bom };

  const remainder = text.slice(opening[0].length);
  const closing = /^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/gm.exec(remainder);
  if (!closing) throw new Error('Unclosed YAML frontmatter in note.');

  const raw = remainder.slice(0, closing.index);
  const document = parseDocument(raw, { uniqueKeys: true });
  if (document.errors.length || (document.contents && !isMap(document.contents))) {
    throw new Error('Invalid YAML frontmatter in note.');
  }
  const titleValue = document.get('title', true);
  const title = isScalar(titleValue) && typeof titleValue.value === 'string' ? titleValue.value.trim() || null : null;
  const value = document.get('notion_id', true);
  if (value != null && (!isScalar(value) || (value.value !== null && typeof value.value !== 'string'))) {
    throw new Error('notion_id must be a string in YAML frontmatter.');
  }
  const notionId = value && isScalar(value) && typeof value.value === 'string' ? value.value.trim() || null : null;
  const workspace = document.get('notion_workspace', true);
  if (workspace != null && (!isScalar(workspace) || (workspace.value !== null && typeof workspace.value !== 'string'))) {
    throw new Error('notion_workspace must be a non-empty string in YAML frontmatter.');
  }
  const notionWorkspace = workspace && isScalar(workspace) && typeof workspace.value === 'string' ? workspace.value.trim() || null : null;
  const workspaceId = document.get('notion_workspace_id', true);
  if (workspaceId != null && (!isScalar(workspaceId) || (workspaceId.value !== null && typeof workspaceId.value !== 'string'))) {
    throw new Error('notion_workspace_id must be a string in YAML frontmatter.');
  }
  const notionWorkspaceId = workspaceId && isScalar(workspaceId) && typeof workspaceId.value === 'string' ? workspaceId.value.trim() || null : null;
  const end = opening[0].length + closing.index + closing[0].length;
  return { body: text.slice(end), title, notionId, notionWorkspace, notionWorkspaceId, frontmatter: { raw, start: opening[0], end: closing[0], bodyOffset: end }, bom };
}

export function writeNotionId(source: string, id: string) {
  const note = parseNote(source);
  if (note.notionId) throw new Error('Note already has a notion_id; not overwriting it.');
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  if (!note.frontmatter) return `${note.bom}---${newline}notion_id: ${id}${newline}---${newline}${note.body}`;

  const { raw, start, end, bodyOffset } = note.frontmatter;
  // A blank notion_id key may already exist: replace just its scalar, not the rest of the YAML.
  const existing = /^([ \t]*notion_id[ \t]*:[ \t]*)(?:(?:["']{2}|null|~)[ \t]*)?(#.*)?$/m.exec(raw);
  if (existing) {
    const updated = raw.replace(existing[0], `${existing[1]}${id}${existing[2] ? ` ${existing[2]}` : ''}`);
    return `${note.bom}${start}${updated}${end}${source.slice(note.bom.length + bodyOffset)}`;
  }
  if (/^[ \t]*notion_id[ \t]*:/m.test(raw)) throw new Error('Cannot safely replace notion_id in frontmatter.');
  if (note.frontmatter.raw && !raw.endsWith('\n')) throw new Error('Cannot safely edit frontmatter without a final newline.');
  return `${note.bom}${start}${raw}notion_id: ${id}${newline}${end}${source.slice(note.bom.length + bodyOffset)}`;
}

// Edit only reserved scalar ranges. Keep unrelated YAML, comments and body verbatim.
function setBindingValue(source: string, key: string, value: string) {
  const note = parseNote(source);
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const encoded = JSON.stringify(value);
  if (!note.frontmatter) return `${note.bom}---${newline}${key}: ${encoded}${newline}---${newline}${note.body}`;
  const { raw, start, end, bodyOffset } = note.frontmatter;
  const document = parseDocument(raw);
  const scalar = document.get(key, true);
  let updated = raw;
  if (document.has(key)) {
    if (!isScalar(scalar) || !scalar.range) throw new Error(`Cannot safely edit ${key} in frontmatter.`);
    const [from, to] = scalar.range;
    const before = raw.slice(0, from);
    const after = raw.slice(to);
    updated = `${before}${before.endsWith(':') ? ' ' : ''}${encoded}${after.startsWith('#') ? ' ' : ''}${after}`;
  } else {
    if (raw && !raw.endsWith('\n')) throw new Error('Cannot safely edit frontmatter without a final newline.');
    updated = `${raw}${key}: ${encoded}${newline}`;
  }
  return `${note.bom}${start}${updated}${end}${source.slice(note.bom.length + bodyOffset)}`;
}

export function writeNotionBinding(source: string, workspace: string, workspaceId: string, pageId: string) {
  const note = parseNote(source);
  if (!workspace.trim() || !workspaceId.trim() || !pageId.trim()) throw new Error('A note binding requires a workspace name, workspace ID and page ID.');
  if (note.notionWorkspace && note.notionWorkspace.toLowerCase() !== workspace.trim().toLowerCase()) throw new Error('The note’s workspace changed; refusing to replace it.');
  if (note.notionWorkspaceId && !sameId(note.notionWorkspaceId, workspaceId)) throw new Error('Refusing to replace the note’s saved workspace ID.');
  if (note.notionId && !sameId(note.notionId, pageId)) throw new Error('Refusing to replace the note’s saved page ID.');
  let updated = source;
  if (!note.notionId) updated = setBindingValue(updated, 'notion_id', pageId);
  if (!note.notionWorkspace) updated = setBindingValue(updated, 'notion_workspace', workspace.trim());
  if (!note.notionWorkspaceId) updated = setBindingValue(updated, 'notion_workspace_id', workspaceId);
  return updated;
}

export function toNotionMarkdown(body: string) {
  // Markdown import does not understand Obsidian wiki syntax; leave readable text.
  const ranges = codeRanges(body);
  return body.replace(/!?\[\[([^\]\n]+)\]\]/g, (match, target: string, offset: number) => {
    if (ranges.some((range) => offset >= range.start && offset < range.end)) return match;
    const [path, label] = target.split('|');
    return label?.trim() || path.trim();
  });
}
