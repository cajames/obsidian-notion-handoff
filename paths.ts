import { posix } from 'node:path';

export function resolveAttachment(path: string, from: string,
  getFile: (path: string) => { path: string; name: string; stat: { size: number } } | null,
  getLink: (path: string, from: string) => { path: string; name: string; stat: { size: number } } | null) {
  let decoded = path.replace(/\\/g, '/').trim();
  try { decoded = decodeURIComponent(decoded); } catch { /* keep literal filename */ }
  if (!decoded || /^(?:[a-z]+:|\/\/)/i.test(decoded)) return null;
  const root = decoded.replace(/^\//, '');
  const candidates = [posix.normalize(posix.join(posix.dirname(from), root)), posix.normalize(root)];
  if (decoded.startsWith('/')) candidates.reverse();
  for (const candidate of candidates) {
    if (candidate === '..' || candidate.startsWith('../')) continue;
    const file = getFile(candidate) || (/\.excalidraw$/i.test(candidate) ? getFile(`${candidate}.md`) : null);
    if (file) return file;
  }
  return getLink(root, from) || (/\.excalidraw$/i.test(root) ? getLink(`${root}.md`, from) : null);
}
