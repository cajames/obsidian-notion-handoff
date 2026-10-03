import { describe, expect, it, vi } from 'vitest';
import { isExcalidraw, MAX_UPLOAD_BYTES, mediaKind, parseEmbeds, prepareAttachments } from '../src/attachments';
import { resolveAttachment } from '../src/paths';

const image = { path: 'Assets/photo.png', name: 'photo.png', stat: { size: 12 } };
const drawing = { path: 'Drawings/plan.excalidraw.md', name: 'plan.excalidraw.md', stat: { size: 25 } };
const pdf = { path: 'Notes/manual.pdf', name: 'manual.pdf', stat: { size: 3 } };

function deps(files = [image, drawing, pdf]) {
  return {
    resolve: vi.fn((path: string) => files.find((file) => file.path === path || file.name === path) || null),
    read: vi.fn(async () => new Uint8Array([1, 2, 3])),
    render: vi.fn(async () => new Uint8Array([137, 80, 78, 71])),
    upload: vi.fn(async () => 'uploaded-id'),
  };
}

describe('attachment parsing', () => {
  it('parses wiki embeds, sizes, aliases, Markdown images and document embeds', () => {
    expect(parseEmbeds('![[photo.png]] ![[photo.png|My caption]] ![[photo.png|400x250]] ![Alt](Assets/photo.png) ![[manual.pdf]]'))
      .toMatchObject([
        { path: 'photo.png', caption: '' },
        { path: 'photo.png', caption: 'My caption' },
        { path: 'photo.png', caption: '' },
        { path: 'Assets/photo.png', caption: 'Alt' },
        { path: 'manual.pdf', caption: '' },
      ]);
    expect(mediaKind('x.mp3')).toBe('audio');
    expect(mediaKind('x.mp4')).toBe('video');
    expect(mediaKind('x.zip')).toBe('file');
    expect(mediaKind('x.pdf')).toBe('pdf');
  });

  it('ignores attachment syntax inside inline, fenced, and indented code', async () => {
    const body = [
      'Examples: `![[file.png]]` / `![](path)` and ``![[nested`name.png]]``.',
      '```markdown',
      '![[fenced.png]]',
      '```',
      '',
      '~~~',
      '![](tilde.png)',
      '~~~',
      '',
      '    ![[indented.png]]',
      '',
      '![[photo.png|Actual image]]',
    ].join('\n');
    expect(parseEmbeds(body)).toMatchObject([{ path: 'photo.png', start: body.lastIndexOf('![[photo.png') }]);
    const helpers = deps();
    const result = await prepareAttachments(body, 'Note.md', helpers);
    expect(helpers.resolve).toHaveBeenCalledExactlyOnceWith('photo.png', 'Note.md');
    expect(result.issues).toEqual([]);
    expect(result.markdown).toContain('`![[file.png]]` / `![](path)`');
    expect(result.markdown).toContain('![[fenced.png]]');
    expect(result.placements).toMatchObject([{ kind: 'image', caption: 'Actual image' }]);
  });

  it('resolves relative, vault-absolute, and attachment-folder links against mock vault', () => {
    const files = [image, drawing, pdf];
    const getFile = vi.fn((path: string) => files.find((file) => file.path === path) || null);
    const getLink = vi.fn((path: string) => path === 'photo.png' ? image : null);
    expect(resolveAttachment('manual.pdf', 'Notes/Note.md', getFile, getLink)).toBe(pdf);
    expect(resolveAttachment('/Assets/photo.png', 'Notes/Note.md', getFile, getLink)).toBe(image);
    expect(resolveAttachment('photo.png', 'Notes/Note.md', getFile, getLink)).toBe(image);
    expect(resolveAttachment('plan.excalidraw', 'Drawings/Note.md', getFile, getLink)).toBe(drawing);
    expect(resolveAttachment('../../escape.png', 'Notes/Note.md', getFile, getLink)).toBeNull();
    expect(resolveAttachment('missing.png', 'Notes/Note.md', getFile, getLink)).toBeNull();
  });

  it('keeps missing attachments readable and warns', async () => {
    const result = await prepareAttachments('Above ![[missing.pdf]] below', 'Notes/Note.md', deps());
    expect(result.markdown).toContain('Attachment: missing.pdf (not found)');
    expect(result.issues).toEqual(['Missing attachment: missing.pdf']);
    expect(result.placements).toEqual([]);
  });

  it('uploads once per file within a push but inserts at each occurrence', async () => {
    const helpers = deps();
    const result = await prepareAttachments('before ![[photo.png|Hi]] between ![[photo.png|300]] after', 'Notes/Note.md', helpers);
    expect(helpers.upload).toHaveBeenCalledTimes(1);
    expect(helpers.read).toHaveBeenCalledTimes(1);
    expect(result.placements).toMatchObject([
      { kind: 'image', caption: 'Hi', id: 'uploaded-id' },
      { kind: 'image', caption: '', id: 'uploaded-id' },
    ]);
    expect(result.markdown).toMatch(/before[\s\S]*NTN_SYNC_MEDIA_[a-f0-9]+_0[\s\S]*between[\s\S]*NTN_SYNC_MEDIA_[a-f0-9]+_1[\s\S]*after/);
    expect(result.issues).toEqual([]);
  });

  it('skips oversized files and preserves external images', async () => {
    const big = { path: 'Assets/big.png', name: 'big.png', stat: { size: MAX_UPLOAD_BYTES + 1 } };
    const helpers = deps([big]);
    const result = await prepareAttachments('![[big.png]] ![web](https://example.com/img.png)', 'Note.md', helpers);
    expect(result.markdown).toContain('Attachment: big.png (not embedded)');
    expect(result.markdown).toContain('![web](https://example.com/img.png)');
    expect(result.issues[0]).toContain('20 MiB');
    expect(helpers.upload).not.toHaveBeenCalled();
  });

  it('uploads PDFs and other files and degrades after an upload error', async () => {
    const archive = { path: 'Notes/data.zip', name: 'data.zip', stat: { size: 2 } };
    const helpers = deps([pdf, archive]);
    const result = await prepareAttachments('![[manual.pdf|Reference]] and ![[data.zip]]', 'Notes/Note.md', helpers);
    expect(result.placements).toMatchObject([
      { kind: 'pdf', caption: 'Reference', name: 'manual.pdf' },
      { kind: 'file', caption: '', name: 'data.zip' },
    ]);
    const broken = deps();
    broken.upload.mockRejectedValueOnce(new Error('ntn exited with code 413: too large'));
    const failure = await prepareAttachments('![[photo.png]]', 'Note.md', broken);
    expect(failure.markdown).toBe('Attachment: photo.png (not embedded)');
    expect(failure.issues[0]).toContain('code 413');
  });

  it('exports Excalidraw to PNG, and degrades if its API is missing', async () => {
    expect(isExcalidraw(drawing.path)).toBe(true);
    expect(isExcalidraw('plan.excalidraw')).toBe(true);
    const installed = deps();
    const success = await prepareAttachments('![[plan.excalidraw.md|Sketch]]', 'Note.md', installed);
    expect(installed.render).toHaveBeenCalledWith(drawing);
    expect(installed.read).not.toHaveBeenCalled();
    expect(installed.upload).toHaveBeenCalledWith(expect.any(Uint8Array), 'plan.png', 'image/png');
    expect(success.placements).toMatchObject([{ kind: 'image', caption: 'Sketch' }]);
    const absent = deps();
    absent.render.mockRejectedValueOnce(new Error('Excalidraw Automate is unavailable'));
    const failure = await prepareAttachments('![[plan.excalidraw.md]]', 'Note.md', absent);
    expect(failure.markdown).toBe('Attachment: plan.excalidraw.md (not embedded)');
    expect(failure.issues[0]).toContain('install or enable obsidian-excalidraw-plugin');
    expect(absent.upload).not.toHaveBeenCalled();
  });

  it('exports TLDraw-marked Markdown as PNG without uploading the raw drawing', async () => {
    const tldraw = { path: 'Drawings/Sketch.md', name: 'Sketch.md', stat: { size: MAX_UPLOAD_BYTES + 1 } };
    const helpers = { ...deps([tldraw]), isTldraw: () => true };
    const result = await prepareAttachments('![[Sketch.md|Plan]]', 'Note.md', helpers);
    expect(helpers.render).toHaveBeenCalledWith(tldraw);
    expect(helpers.read).not.toHaveBeenCalled();
    expect(helpers.upload).toHaveBeenCalledWith(expect.any(Uint8Array), 'Sketch.png', 'image/png');
    expect(result.placements).toMatchObject([{ kind: 'image', name: 'Sketch.png', caption: 'Plan' }]);
    expect(result.issues).toEqual([]);
  });

  it('keeps TLDraw embeds readable if the plugin is unavailable or the PNG is oversized', async () => {
    const tldraw = { path: 'Drawings/plan.tldr', name: 'plan.tldr', stat: { size: 25 } };
    const absent = deps([tldraw]);
    absent.render.mockRejectedValueOnce(new Error('Tldraw in Obsidian is unavailable'));
    const failure = await prepareAttachments('![[plan.tldr]]', 'Note.md', absent);
    expect(failure.markdown).toBe('Attachment: plan.tldr (not embedded)');
    expect(failure.issues[0]).toContain('install or enable Tldraw in Obsidian');
    expect(absent.read).not.toHaveBeenCalled();
    expect(absent.upload).not.toHaveBeenCalled();
    const oversized = deps([tldraw]);
    oversized.render.mockResolvedValueOnce(new Uint8Array(MAX_UPLOAD_BYTES + 1));
    const tooBig = await prepareAttachments('![[plan.tldr]]', 'Note.md', oversized);
    expect(tooBig.issues[0]).toContain('20 MiB');
    expect(tooBig.placements).toEqual([]);
    expect(oversized.upload).not.toHaveBeenCalled();
  });

});
