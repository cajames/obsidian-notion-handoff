// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prepareAttachments } from '../src/attachments';
import { insertMedia } from '../src/media';
import { isTldraw, renderTldraw } from '../src/tldraw';

const png = new Uint8Array([137, 80, 78, 71]);
const drawing = { path: 'Drawings/plan.tldr', name: 'plan.tldr', stat: { size: 25 } };
const drawImage = vi.fn();

async function renderPreview(container: HTMLElement) {
  container.innerHTML = '<div class="ptl-tldraw-image"><div class="tl-container"><img src="data:image/svg+xml,preview"></div></div>';
  const image = container.querySelector('img')!;
  Object.defineProperties(image, { naturalWidth: { value: 640 }, naturalHeight: { value: 480 } });
}

beforeEach(() => {
  drawImage.mockClear();
  vi.spyOn(HTMLImageElement.prototype, 'decode').mockResolvedValue();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage } as never);
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (this: HTMLCanvasElement, callback, mime) {
    expect(this.width).toBe(640);
    expect(this.height).toBe(480);
    expect(mime).toBe('image/png');
    callback(new Blob([png], { type: 'image/png' }));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  expect(document.body.childElementCount).toBe(0);
});

describe('TLDraw image export', () => {
  it('recognizes .tldr and Markdown frontmatter, including alternate keys', () => {
    expect(isTldraw('plan.TLDR')).toBe(true);
    expect(isTldraw('plan.tldraw.md')).toBe(true);
    expect(isTldraw('plan.md', { 'tldraw-file': true })).toBe(true);
    expect(isTldraw('plan.md', { drawing: true }, 'drawing')).toBe(true);
    expect(isTldraw('note.md')).toBe(false);
    expect(isTldraw('photo.png', { 'tldraw-file': true })).toBe(false);
    // The plugin treats .tldraw as an unsupported offline format.
    expect(isTldraw('plan.tldraw')).toBe(false);
  });

  it('renders, uploads once, and inserts PNG image blocks for repeated TLDraw embeds', async () => {
    const upload = vi.fn(async () => 'upload-id');
    const read = vi.fn(async () => new Uint8Array());
    const render = vi.fn((file: { path: string }) => renderTldraw(file.path, renderPreview));
    const prepared = await prepareAttachments('Before ![[plan.tldr|Sketch]] then ![[plan.tldr]] after', 'Note.md', {
      resolve: () => drawing, read, render, upload,
    });
    expect(prepared.issues).toEqual([]);
    expect(upload).toHaveBeenCalledExactlyOnceWith(png, 'plan.png', 'image/png');
    expect(render).toHaveBeenCalledExactlyOnceWith(drawing);
    expect(read).not.toHaveBeenCalled();
    expect(drawImage).toHaveBeenCalledWith(expect.any(HTMLImageElement), 0, 0);
    const run = vi.fn(async (_args: string[], _stdin?: string) => '{}');
    run.mockResolvedValueOnce(JSON.stringify({ results: prepared.placements.map((place, index) => ({
      id: `placeholder-${index}`, type: 'paragraph', paragraph: { rich_text: [{ plain_text: place.marker }] },
    })) }));
    expect(await insertMedia(run, 'page-id', prepared.placements)).toEqual([]);
    expect(JSON.parse(run.mock.calls[1][1]!).children[0]).toMatchObject({
      type: 'image', image: { type: 'file_upload', file_upload: { id: 'upload-id' }, caption: [{ text: { content: 'Sketch' } }] },
    });
    expect(JSON.parse(run.mock.calls[3][1]!).children[0].type).toBe('image');
  });

  it('reloads blob-backed SVG previews as data URLs before drawing to avoid tainted canvases', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div xmlns="http://www.w3.org/1999/xhtml">Sketch</div></foreignObject></svg>';
    const fetchPreview = vi.fn(async () => ({ ok: true, blob: async () => new Blob([svg], { type: 'image/svg+xml' }) }));
    vi.stubGlobal('fetch', fetchPreview);
    vi.mocked(HTMLImageElement.prototype.decode).mockImplementationOnce(async function (this: HTMLImageElement) {
      expect(this.src).toMatch(/^data:image\/svg\+xml;base64,/);
      expect(this.crossOrigin).toBe('anonymous');
      Object.defineProperties(this, { naturalWidth: { value: 640 }, naturalHeight: { value: 480 } });
    });
    expect(await renderTldraw(drawing.path, async (container) => {
      await renderPreview(container);
      container.querySelector('img')!.src = 'blob:app://obsidian/preview';
    })).toEqual(png);
    expect(fetchPreview).toHaveBeenCalledExactlyOnceWith('blob:app://obsidian/preview');
    expect(drawImage.mock.calls[0][0].src).toMatch(/^data:image\/svg\+xml;base64,/);
  });

  it('reports a failed blob fetch without attempting to encode a PNG', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })));
    await expect(renderTldraw(drawing.path, async (container) => {
      await renderPreview(container);
      container.querySelector('img')!.src = 'blob:app://obsidian/preview';
    })).rejects.toThrow('Could not read the TLDraw preview');
    expect(drawImage).not.toHaveBeenCalled();
  });

  it('waits for asynchronously mounted previews', async () => {
    expect(await renderTldraw(drawing.path, async (container) => {
      setTimeout(() => { void renderPreview(container); }, 0);
    })).toEqual(png);
  });

  it('propagates render, decode, and PNG encoding failures and cleans up', async () => {
    await expect(renderTldraw(drawing.path, async () => { throw new Error('plugin failed'); })).rejects.toThrow('plugin failed');
    vi.mocked(HTMLImageElement.prototype.decode).mockRejectedValueOnce(new Error('invalid preview'));
    await expect(renderTldraw(drawing.path, renderPreview)).rejects.toThrow('invalid preview');
    vi.mocked(HTMLCanvasElement.prototype.toBlob).mockImplementationOnce((callback) => callback(null));
    await expect(renderTldraw(drawing.path, renderPreview)).rejects.toThrow('PNG export failed');
  });

  it('times out missing previews, stalled renderers, and stalled decoding', async () => {
    vi.useFakeTimers();
    for (const render of [async () => {}, async () => new Promise<void>(() => {}), renderPreview]) {
      vi.mocked(HTMLImageElement.prototype.decode).mockImplementation(() => new Promise<void>(() => {}));
      const result = expect(renderTldraw(drawing.path, render, document, 100)).rejects.toThrow('timed out');
      await vi.advanceTimersByTimeAsync(100);
      await result;
      expect(document.body.childElementCount).toBe(0);
    }
  });
});
