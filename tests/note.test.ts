import { describe, expect, it } from 'vitest';
import { parseNote, toNotionMarkdown, writeNotionId } from '../note';

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

  it('fills an empty notion_id without disturbing other fields', () => {
    expect(writeNotionId('---\ntags: a\nnotion_id: # pending\n---\nbody', 'abc-123'))
      .toBe('---\ntags: a\nnotion_id: abc-123 # pending\n---\nbody');
  });

  it('refuses to overwrite existing IDs or malformed YAML', () => {
    expect(() => writeNotionId('---\nnotion_id: old\n---\nbody', 'new')).toThrow('already has');
    expect(() => parseNote('---\nnotion_id: [')).toThrow('Unclosed');
    expect(() => parseNote('---\ninvalid: [\n---\nbody')).toThrow('Invalid YAML');
  });

  it('degrades wiki links and embeds to readable text', () => {
    expect(toNotionMarkdown('See [[Target|Label]] and ![[image.png]] and [[Other]]'))
      .toBe('See Label and image.png and Other');
  });
});
