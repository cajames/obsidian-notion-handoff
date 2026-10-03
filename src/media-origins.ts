export function makeOrigin(id: string, original: string, source: string, drawing: boolean) {
  return { id, original, source, drawing };
}

export function parseOrigins(raw: string) {
  const data = JSON.parse(raw);
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid media origin file.');
  for (const value of Object.values(data)) {
    if (!Array.isArray(value) || value.some((item) => !item || typeof item.id !== 'string' ||
      typeof item.original !== 'string' || typeof item.source !== 'string' || typeof item.drawing !== 'boolean')) {
      throw new Error('Invalid media-origins.json; restore it before syncing drawings.');
    }
  }
  return data as Record<string, ReturnType<typeof makeOrigin>[]>;
}

export function combineOrigins(existing: ReturnType<typeof makeOrigin>[], added: ReturnType<typeof makeOrigin>[]) {
  const result = new Map(existing.map((item) => [item.id, item]));
  for (const item of added) result.set(item.id, item);
  return [...result.values()];
}
