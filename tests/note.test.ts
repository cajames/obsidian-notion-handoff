import { describe, expect, it } from 'vitest';
import { parseNote, toNotionMarkdown, writeNotionId } from '../src/note';

describe('frontmatter and body', () => {
  it('extracts body and notion_id without leaking frontmatter', () => {
    expect(parseNote('---\ntags: [work]\nnotion_id: "abc-123"\n---\n# Hello\n'))
      .toMatchObject({ notionId: 'abc-123', body: '# Hello\n' });
  });

  it('handles notes without frontmatter and creates it on write-back', () => {
    expect(parseNote('# Hello').body).toBe('# Hello');
    expect(writeNotionId('# Hello', 'abc-123')).toBe('---\nnotion_id: abc-123\n---\n# Hello');
  });

  it('preserves BOM, CRLF, other YAML fields, comments and body exactly', () => {
    const source = '\uFEFF---\r\ntitle: "Keep this" # comment\r\ntags:\r\n  - one\r\n---\r\n# Body\r\n';
    const updated = writeNotionId(source, 'abc-123');
    expect(updated).toBe('\uFEFF---\r\ntitle: "Keep this" # comment\r\ntags:\r\n  - one\r\nnotion_id: abc-123\r\n---\r\n# Body\r\n');
    expect(parseNote(updated)).toMatchObject({ notionId: 'abc-123', body: '# Body\r\n' });
  });

  it('preserves notion_workspace verbatim when writing notion_id', () => {
    const source = '---\r\nnotion_workspace: "Work" # keep this\r\ntags: [work]\r\n---\r\nbody';
    const updated = writeNotionId(source, 'abc-123');
    expect(updated).toBe('---\r\nnotion_workspace: "Work" # keep this\r\ntags: [work]\r\nnotion_id: abc-123\r\n---\r\nbody');
    expect(parseNote(updated)).toMatchObject({ notionWorkspace: 'Work', notionId: 'abc-123', body: 'body' });
  });

  it('distinguishes absent workspace from invalid value', () => {
    expect(parseNote('body').notionWorkspace).toBeNull();
    expect(() => parseNote('---\nnotion_workspace: []\n---\nbody')).toThrow('notion_workspace must be a non-empty string');
    expect(() => parseNote('---\nnotion_workspace: \n---\nbody')).toThrow('notion_workspace must be a non-empty string');
  });

  it('fills an empty notion_id without disturbing other fields', () => {
    expect(writeNotionId('---\ntags: a\nnotion_id: # pending\n---\nbody', 'abc-123'))
      .toBe('---\ntags: a\nnotion_id: abc-123 # pending\n---\nbody');
  });

  it('refuses to overwrite existing IDs or malformed YAML', () => {
    expect(() => writeNotionId('---\nnotion_id: old\n---\nbody', 'new')).toThrow('already has');
    expect(() => parseNote('---\nnotion_id: [')).toThrow('Unclosed');
    expect(() => parseNote('---\ninvalid: [\n---\nbody')).toThrow('Invalid YAML');
  });

  it('preserves code examples while converting ordinary wiki links', () => {
    const code = '`![[file.png]]` / `![](path)`\n\n```md\n[[Note|Label]]\n![[fenced.png]]\n```\n\n';
    expect(toNotionMarkdown(`${code}See [[Note|Label]]`)).toBe(`${code}See Label`);
  });

  it('degrades wiki links and embeds to readable text', () => {
    expect(toNotionMarkdown('See [[Target|Label]] and ![[image.png]] and [[Other]]'))
      .toBe('See Label and image.png and Other');
  });
});
