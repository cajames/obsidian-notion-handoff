import { vi } from 'vitest';
import { notionClient } from '../../src/notion';
import { requestUrl } from './obsidian';

export const api = vi.fn(async (_request: { path: string; method: string; body?: any; token: string; headers: Record<string, string>; raw?: string | ArrayBuffer }) => ({} as any));

export const workspace = vi.fn(async (_token: string) => ({ type: 'bot', bot: { workspace_id: 'workspace-default' } }));

export function mockNotion() {
  workspace.mockReset().mockResolvedValue({ type: 'bot', bot: { workspace_id: 'workspace-default' } });
  vi.mocked(requestUrl).mockImplementation(async (input) => {
    const request = input as { url: string; method?: string; headers?: Record<string, string>; body?: string | ArrayBuffer };
    if (!request.url.startsWith('https://api.notion.com/')) {
      return { status: 200, headers: { 'content-type': 'image/png' }, arrayBuffer: new Uint8Array([137, 80, 78, 71]).buffer, text: '' };
    }
    const url = new URL(request.url);
    if (url.pathname === '/v1/users/me') return jsonResponse(await workspace(request.headers?.authorization?.replace('Bearer ', '') ?? ''));
    const data = await api({ path: url.pathname + url.search, method: request.method ?? 'GET',
      body: typeof request.body === 'string' ? JSON.parse(request.body) : undefined,
      token: request.headers?.authorization?.replace('Bearer ', '') ?? '', headers: request.headers ?? {}, raw: request.body });
    return jsonResponse(data);
  });
}

export function jsonResponse(data: unknown, status = 200, headers = {}) {
  const text = JSON.stringify(data);
  return { status, headers: { 'content-type': 'application/json', ...headers }, text,
    arrayBuffer: new TextEncoder().encode(text).buffer };
}

export function testClient() {
  mockNotion();
  return notionClient('test-token');
}
