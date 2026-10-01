import { describe, expect, it, vi } from 'vitest';
import { prepareAttachments } from '../attachments';
import { resolveReferences, renderReferences } from '../references';

const id = '01234567-89ab-cdef-0123-456789abcdef';
const profiles = [
  { name: 'Personal', token: 'one', parentId: 'p1' },
  { name: 'Work', token: 'two', parentId: 'p2' },
];
const file = { path: 'Notes/Meeting Notes.md', name: 'Meeting Notes.md', basename: 'Meeting Notes' };

function vault(source = `---\nnotion_id: ${id}\n---\nBody`, files = [file]) {
  return {
    resolve: vi.fn((path: string) => files.find((entry) => entry.basename === path.replace(/\.md$/i, '') || entry.path === path || entry.path === `${path}.md`) || null),
    markdownFiles: vi.fn(() => files),
    read: vi.fn(async () => source),
    profiles,
  };
}

async function convert(body: string, profile = profiles[0], deps = vault()) {
  const result = await resolveReferences(body, 'Notes/Source.md', profile, deps);
  return { ...result, markdown: renderReferences(result.body, result.references) };
}

describe('note wiki-links', () => {
  it('mentions a pushed note when both notes use the default workspace', async () => {
    const result = await convert('See [[Meeting Notes]].');
    expect(result.markdown).toBe(`See <mention-page url="https://www.notion.so/${id.replace(/-/g, '')}">Meeting Notes</mention-page>.`);
    expect(result.references).toHaveLength(1);
  });

  it('mentions a note explicitly in the same workspace and escapes its alias', async () => {
    const work = vault(`---\nnotion_id: ${id}\nnotion_workspace: work\n---\nBody`);
    const result = await convert('[[Meeting Notes|A & B <review>]]', profiles[1], work);
    expect(result.markdown).toContain('>A &amp; B &lt;review&gt;</mention-page>');
  });

  it('leaves a different-workspace link pending', async () => {
    expect((await convert('[[Meeting Notes]]', profiles[1])).markdown).toBe('Meeting Notes (link pending)');
  });

  it('leaves unpushed, unreadable, missing, and ambiguous notes pending', async () => {
    expect((await convert('[[Meeting Notes|Alias]]', profiles[0], vault('---\ntags: a\n---\nBody'))).markdown)
      .toBe('Alias (link pending)');
    const unreadable = vault();
    unreadable.read.mockRejectedValueOnce(new Error('unreadable'));
    expect((await convert('[[Meeting Notes]]', profiles[0], unreadable)).markdown).toBe('Meeting Notes (link pending)');
    expect((await convert('[[Missing Note]]')).markdown).toBe('Missing Note (link pending)');
    const ambiguous = vault(undefined, [file, { ...file, path: 'Archive/Meeting Notes.md' }]);
    const result = await convert('[[Meeting Notes]]', profiles[0], ambiguous);
    expect(result.markdown).toBe('Meeting Notes (link pending)');
    expect(ambiguous.resolve).not.toHaveBeenCalled();
    expect((await convert('[[Notes/Meeting Notes]]', profiles[0], ambiguous)).markdown).toContain('<mention-page');
  });

  it('keeps wiki-links to non-notes as plain text', async () => {
    expect((await convert('[[image.png|picture]] and [[Drawings/plan.excalidraw.md]]')).markdown)
      .toBe('picture and Drawings/plan.excalidraw.md');
  });

  it('keeps .md embeds in the existing file-upload pipeline', async () => {
    const result = await convert('![[Meeting Notes]] ![[Meeting Notes.md|Read]] and [[Meeting Notes]]');
    expect(result.body).toContain('![[Meeting Notes]]');
    expect(result.body).toContain('![[Meeting Notes.md|Read]]');
    const upload = vi.fn(async () => 'upload-id');
    const prepared = await prepareAttachments(result.body, 'Notes/Source.md', {
      resolve: () => ({ ...file, stat: { size: 30 } }),
      read: async () => new Uint8Array([1, 2, 3]),
      render: async () => { throw new Error('not a drawing'); },
      upload,
    });
    expect(upload).toHaveBeenCalledTimes(1);
    expect(upload).toHaveBeenCalledWith(expect.any(Uint8Array), 'Meeting Notes.md', expect.any(String));
    expect(prepared.placements).toMatchObject([{ kind: 'file', name: 'Meeting Notes.md' }, { kind: 'file', name: 'Meeting Notes.md' }]);
    expect(renderReferences(prepared.markdown, result.references)).toContain('<mention-page');
  });
});
