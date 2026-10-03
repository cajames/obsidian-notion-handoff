export function isTldraw(path: string, frontmatter = {}, alternateKey = '') {
  return /\.(?:tldr|tldraw\.md)$/i.test(path) ||
    (/\.md$/i.test(path) && (Object.hasOwn(frontmatter, 'tldraw-file') ||
      (!!alternateKey && Object.hasOwn(frontmatter, alternateKey))));
}

// TLDraw's Obsidian plugin exposes an image preview through its embed renderer,
// not a standalone export API. Rasterize that preview at its natural resolution.
export async function renderTldraw(
  path: string,
  render: (container: HTMLElement) => Promise<void>,
  doc = document,
  timeout = 10000,
) {
  const container = doc.createElement('div');
  container.style.cssText = 'position: fixed; left: -10000px; top: 0; width: 1000px; height: 1000px; pointer-events: none;';
  doc.body.appendChild(container);
  let check = () => {};
  const observer = new MutationObserver(() => check());
  observer.observe(container, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
  let timer;
  const timedOut = new Promise<Uint8Array>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`TLDraw preview timed out: ${path}`)), timeout);
  });
  const exportPng = async () => {
    let image = await new Promise<HTMLImageElement>((resolve, reject) => {
      check = () => {
        const preview = container.querySelector<HTMLImageElement>('.ptl-tldraw-image img[src]');
        if (preview) resolve(preview);
      };
      render(container).then(check, reject);
    });
    if (image.src.startsWith('blob:')) {
      // Chromium taints canvases drawn from blob-backed SVGs with foreignObject.
      // TLDraw's own PNG exporter avoids this by loading a data URL instead.
      const response = await fetch(image.src);
      if (!response.ok) throw new Error('Could not read the TLDraw preview');
      const source = await response.blob();
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error ?? new Error('Could not read the TLDraw preview'));
        reader.readAsDataURL(source);
      });
      image = doc.createElement('img');
      image.crossOrigin = 'anonymous';
      image.src = dataUrl;
    }
    await image.decode();
    if (!container.isConnected) throw new Error('TLDraw export was cancelled');
    if (!image.naturalWidth || !image.naturalHeight) throw new Error('TLDraw returned an empty image preview');
    const canvas = doc.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('PNG canvas is unavailable');
    context.drawImage(image, 0, 0);
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('TLDraw PNG export failed')), 'image/png');
    });
    return new Uint8Array(await blob.arrayBuffer());
  };
  try {
    return await Promise.race([exportPng(), timedOut]);
  } finally {
    clearTimeout(timer);
    observer.disconnect();
    container.remove();
  }
}
