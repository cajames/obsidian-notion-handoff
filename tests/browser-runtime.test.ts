import { beforeAll, describe, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { Window } from 'happy-dom';
import { createHash, webcrypto } from 'node:crypto';
import { posix } from 'node:path';
import { runInNewContext } from 'node:vm';
import { readFile } from 'node:fs/promises';
import { normalizeBody } from '../src/sync-remote';

const getRandomValues = vi.fn(webcrypto.getRandomValues.bind(webcrypto));
const sandbox = { TextEncoder, URL, document: new Window().document, crypto: { getRandomValues } };

beforeAll(async () => {
  const bundle = await build({
    stdin: {
      contents: `
        export { randomId } from './src/ids';
        export { fingerprint, mediaToken } from './src/sync-remote';
        export { imageImportFolder, resolveAttachment } from './src/paths';
        export { prepareAttachments } from './src/attachments';
        export { prepareRemote } from './src/pull-images';
        export { resolveReferences, renderReferences } from './src/references';
        export { posix } from 'path-browserify';
      `,
      resolveDir: process.cwd(),
    },
    bundle: true,
    platform: 'browser',
    alias: { path: 'path-browserify' },
    format: 'iife',
    globalName: 'sync',
    write: false,
  });
  runInNewContext(bundle.outputFiles[0].text, sandbox);
});

describe('browser utilities without Node globals', () => {
  it('enables mobile installation under the Notion Handoff plugin ID', async () => {
    const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
    expect(manifest).toMatchObject({ id: 'notion-handoff', name: 'Notion Handoff', isDesktopOnly: false });
  });

  it('retains the exact historical SHA-256 fingerprints and profile keys', () => {
    const browser = Reflect.get(sandbox, 'sync');
    expect(Reflect.get(sandbox, 'Buffer')).toBeUndefined();
    expect(Reflect.get(sandbox, 'process')).toBeUndefined();
    expect(Reflect.get(sandbox, 'require')).toBeUndefined();
    for (const body of ['', 'test-token', 'work-token', '# Note\n\nLocal edits', 'Résumé 🖊️ 汉字', 'Body\r\n\r\nText  ', 'Broken surrogate \ud800', '```\n  code\n```']) {
      const previous = createHash('sha256').update(normalizeBody(body)).digest('hex');
      expect(browser.fingerprint(body)).toBe(previous);
      expect(browser.fingerprint(body)).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(browser.fingerprint('test-token')).not.toBe(browser.fingerprint('work-token'));
  });

  it('uses Web Crypto for 128-bit hexadecimal Nano IDs', () => {
    const browser = Reflect.get(sandbox, 'sync');
    getRandomValues.mockClear();
    const ids = Array.from({ length: 100 }, () => browser.randomId());
    expect(ids.every((id) => /^[a-f0-9]{32}$/.test(id))).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    expect(getRandomValues).toHaveBeenCalled();
  });

  it('preserves the Node POSIX semantics used by vault paths', () => {
    const browser = Reflect.get(sandbox, 'sync');
    for (const path of ['', '.', '/', 'Notes/../Attachments/', 'Notes//Résumé.md', '../file.png', '.obsidian/plugins/notion-handoff/backups', 'C:\\Notes\\image.png']) {
      expect(browser.posix.normalize(path)).toBe(posix.normalize(path));
      expect(browser.posix.dirname(path)).toBe(posix.dirname(path));
      expect(browser.posix.basename(path)).toBe(posix.basename(path));
      expect(browser.posix.extname(path)).toBe(posix.extname(path));
      expect(browser.posix.join('Notes', path)).toBe(posix.join('Notes', path));
    }
    expect(browser.imageImportFolder('', './Images', 'Notes/Test.md')).toBe('Notes/Images');
    expect(browser.imageImportFolder('Client\\Images', 'Attachments', 'Notes/Test.md')).toBe('Client/Images');
    expect(() => browser.imageImportFolder('../outside', '', 'Notes/Test.md')).toThrow('vault-relative');
  });

  it('prepares uploads, note mentions and image imports using only browser APIs', async () => {
    const browser = Reflect.get(sandbox, 'sync');
    const file = { path: 'Attachments/photo.png', name: 'photo.png', stat: { size: 4 } };
    const profile = { name: 'Client', token: 'work-token', parentId: 'parent' };
    const bytes = new Uint8Array([137, 80, 78, 71]);
    const upload = vi.fn(async () => 'upload-id');
    const prepared = await browser.prepareAttachments('![[photo.png]] ![[photo.png]]', 'Notes/Test.md', {
      resolve: (path: string, from: string) => browser.resolveAttachment(path, from,
        (candidate: string) => candidate === file.path ? file : null, () => file),
      read: async () => bytes,
      render: vi.fn(),
      upload,
    });
    expect(prepared.issues).toEqual([]);
    expect(upload).toHaveBeenCalledExactlyOnceWith(bytes, 'photo.png', 'image/png');
    expect(prepared.placements.map((place: { marker: string }) => place.marker)).toEqual([
      expect.stringMatching(/^NTN_SYNC_MEDIA_[a-f0-9]{32}_0$/),
      expect.stringMatching(/^NTN_SYNC_MEDIA_[a-f0-9]{32}_1$/),
    ]);
    const id = '0123456789abcdef0123456789abcdef';
    const references = await browser.resolveReferences('See [[Other note]]', 'Notes/Test.md', profile, {
      resolve: () => ({ path: 'Notes/Other note.md', name: 'Other note.md' }),
      markdownFiles: () => [],
      read: async () => `---\nnotion_id: ${id}\n---\nOther note`,
      profiles: [profile],
    });
    expect(references.references[0].token).toMatch(/^NTN_SYNC_NOTE_[a-f0-9]{32}_0$/);
    expect(browser.renderReferences(references.body, references.references)).toContain(`<mention-page url="https://www.notion.so/${id}">Other note</mention-page>`);
    const media = { id: 'image-id', kind: 'image', url: 'https://example.com/photo.png', version: 'v1' };
    const token = browser.mediaToken(media);
    const imported = await browser.prepareRemote({ markdown: `![Photo](${token})`, media: [{ ...media, token }], fingerprint: 'observed' }, id, null, {
      imageFolder: browser.imageImportFolder('', './Images', 'Notes/Test.md'),
      download: async () => ({ bytes, mime: 'image/png' }),
      exists: async () => false,
    });
    expect(imported.files[0].path).toMatch(/^Notes\/Images\/notion-[a-f0-9]+-imageid-[a-f0-9]+\.png$/);
    expect(imported.markdown).toBe(`![[${imported.files[0].path}|Photo]]`);
    expect(imported.files[0].bytes).toEqual(bytes);
  });
});
