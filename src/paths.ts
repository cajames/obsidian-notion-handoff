import { posix } from 'path-browserify';

export function imageImportFolder(custom: string, attachments: string, notePath: string) {
  let folder = (custom.trim() || attachments).replace(/\\/g, '/');
  if (folder === '/' || folder === '.') return '';
  if (!custom.trim() && folder.startsWith('./')) folder = posix.join(posix.dirname(notePath), folder.slice(2));
  if (folder.startsWith('/') || /[:\[\]|#\r\n]/.test(folder) || folder.split('/').includes('..')) {
    throw new Error('Imported images folder must be a vault-relative path without .. or special link characters.');
  }
  const normalized = posix.normalize(folder || '.');
  return normalized === '.' ? '' : normalized;
}

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
