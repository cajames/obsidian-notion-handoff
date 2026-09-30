import { describe, expect, it, vi } from 'vitest';
import { renderExcalidraw } from '../excalidraw';

describe('Excalidraw Automate adapter', () => {
  it('renders the selected drawing via the optional Automate API as PNG bytes', async () => {
    const ea = { reset: vi.fn(), createPNG: vi.fn(async () => new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' })) };
    expect(await renderExcalidraw('Drawings/plan.excalidraw.md', ea)).toEqual(new Uint8Array([137, 80, 78, 71]));
    expect(ea.reset).toHaveBeenCalledOnce();
    expect(ea.createPNG).toHaveBeenCalledWith('Drawings/plan.excalidraw.md');
  });

  it('reports missing or invalid API without reading the raw drawing', async () => {
    await expect(renderExcalidraw('drawing.excalidraw')).rejects.toThrow('unavailable');
    await expect(renderExcalidraw('drawing.excalidraw', { reset: vi.fn(), createPNG: vi.fn(async () => null as never) }))
      .rejects.toThrow('did not return a PNG blob');
  });
});
