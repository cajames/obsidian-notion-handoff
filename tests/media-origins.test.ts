import { describe, expect, it, vi } from 'vitest';
import { makeOrigin, parseOrigins } from '../src/media-origins';
import { makeCheckpoint } from '../src/sync';
import { prepareRemote } from '../src/pull-images';
import { mediaToken } from '../src/sync-remote';

function snapshot(caption = 'Changed caption', version = 'v2', id = 'block') {
  const media = { id, url: 'https://example.com/image.png', kind: 'image', version };
  const token = mediaToken(media);
  return { markdown: `![${caption}](${token})`, media: [{ ...media, token }], fingerprint: 'current' };
}

function deps() {
  return { download: vi.fn(async () => ({ bytes: new Uint8Array([137, 80, 78, 71]), mime: 'image/png' })), exists: vi.fn(async () => false) };
}

describe('drawing provenance', () => {
  it('keeps original TLDraw and Excalidraw embeds despite caption and image-version changes', async () => {
    for (const original of ['![[Drawings/plan.tldr|300]]', '![[Drawing.excalidraw]]']) {
      const helpers = { ...deps(), origins: [makeOrigin('block', original, 'source', true)] };
      const result = await prepareRemote(snapshot(), 'page', null, helpers);
      expect(result.markdown).toBe(original);
      expect(result.files).toEqual([]);
      expect(helpers.download).not.toHaveBeenCalled();
    }
  });

  it('uses existing saved block-ID bindings rather than their old captions or tokens', async () => {
    const old = snapshot('Old caption', 'v1');
    const current = snapshot('New caption', 'v2');
    const original = '![[attachments/Sketch.md]]';
    const helpers = { ...deps(), drawingSource: (embed: string) => embed === original ? 'attachments/Sketch.md' : null };
    const checkpoint = makeCheckpoint(original, original, 'old', [{ remote: old.markdown, local: original }]);
    const result = await prepareRemote(current, 'page', checkpoint, helpers);
    expect(result.markdown).toBe(original);
    expect(result.origins).toContainEqual(makeOrigin('block', original, 'attachments/Sketch.md', true));
    expect(helpers.download).not.toHaveBeenCalled();
  });

  it('imports untracked older exports normally without inferring their source from image content', async () => {
    const helpers = { ...deps(), origins: [makeOrigin('different-block', '![[plan.tldr]]', 'plan.tldr', true)] };
    const result = await prepareRemote(snapshot(), 'page', null, helpers);
    expect(result.markdown).toContain('![[notion-sync-assets/');
    expect(result.files).toHaveLength(1);
    expect(result.origins).toEqual(helpers.origins);
    expect(helpers.download).toHaveBeenCalledTimes(1);
  });

  it('validates saved provenance and accepts previously saved records with unused hash metadata', () => {
    const origin = makeOrigin('id', '![[plan.tldr]]', 'plan.tldr', true);
    expect(parseOrigins(JSON.stringify({ page: [origin] }))).toEqual({ page: [origin] });
    expect(parseOrigins(JSON.stringify({ page: [{ ...origin, hash: 'old-hash' }] })).page[0]).toMatchObject(origin);
    expect(() => parseOrigins('{"page":[{"id":"bad"}]}')).toThrow('Invalid media-origins');
  });
});
