// Excalidraw Automate is provided by the optional Excalidraw Obsidian plugin.
// createPNG(templatePath) renders the drawing at that path and returns a Blob.
export async function renderExcalidraw(path: string, ea?: { reset: () => void; createPNG: (path: string) => Promise<Blob> }) {
  if (!ea) throw new Error('Excalidraw Automate is unavailable');
  ea.reset();
  const blob = await ea.createPNG(path);
  if (!blob || typeof blob.arrayBuffer !== 'function') throw new Error('Excalidraw did not return a PNG blob');
  return new Uint8Array(await blob.arrayBuffer());
}
