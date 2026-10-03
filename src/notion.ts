import { Client } from '@notionhq/client';
import { requestUrl } from 'obsidian';
import { MAX_UPLOAD_BYTES } from './attachments';

export const NOTION_VERSION = '2026-03-11';

export function notionClient(token: string, timeoutMs = 60_000) {
  return new Client({
    auth: token,
    notionVersion: NOTION_VERSION,
    // Tokens stay in the local plugin, not a public web page.
    dangerouslyAllowBrowser: true,
    timeoutMs,
    logger: () => {},
    // SDK retries 429/529 for all methods, 500/503 only for GET/DELETE.
    // No network/timeout retries or ambiguous POST/PATCH replays.
    retry: { maxRetries: 2, initialRetryDelayMs: 1000, maxRetryDelayMs: 60_000 },
    fetch: async (url, init) => {
      if (new URL(url).origin !== 'https://api.notion.com') throw new Error('Refusing to send Notion credentials outside api.notion.com.');
      const headers = new Headers(init?.headers);
      const body = init?.body;
      const outgoing = { ...init?.headers };
      if (body instanceof FormData) {
        // Native Request encodes boundaries, escaped filenames, MIME and raw
        // bytes. requestUrl cannot accept FormData directly.
        headers.delete('content-type');
        const encoded = new Request(url, { method: init?.method, headers, body });
        outgoing['content-type'] = encoded.headers.get('content-type')!;
        const bytes = await encoded.arrayBuffer();
        const response = await requestUrl({ url, method: init?.method, headers: outgoing, body: bytes, throw: false });
        return sdkResponse(response);
      }
      const response = await requestUrl({ url, method: init?.method, headers: outgoing, body, throw: false });
      return sdkResponse(response);
    },
  });
}

function sdkResponse(response: Awaited<ReturnType<typeof requestUrl>>) {
  const headers = new Headers(response.headers);
  // Do not let the SDK cap a server's longer wait and retry too early.
  const retryAfter = headers.get('retry-after');
  const delay = retryAfter === null ? 0 : /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now();
  if ([429, 529].includes(response.status)) {
    if (delay > 60_000) throw new Error(`Notion is rate limited. Retry after ${retryAfter}.`);
    let data;
    try { data = JSON.parse(response.text); } catch { /* Let SDK report non-JSON HTTP errors. */ }
    if (data?.additional_data?.rate_limit_reason === 'public_api_request_blocked') throw new Error('Notion API access is restricted. Contact Notion support.');
  }
  return { ok: response.status >= 200 && response.status < 300, status: response.status, headers, text: async () => response.text };
}

export function markdownPayload(markdown: string) {
  return { type: 'replace_content' as const, replace_content: { new_str: markdown } };
}

export function titleProperty(title: string) {
  return { title: { type: 'title' as const, title: [{ type: 'text' as const, text: { content: title } }] } };
}

export function createPayload(parentId: string, title: string) {
  return { parent: { type: 'page_id' as const, page_id: parentId }, properties: titleProperty(title) };
}

export async function uploadFile(client: ReturnType<typeof notionClient>, bytes: Uint8Array, filename: string, mime: string) {
  if (bytes.byteLength > MAX_UPLOAD_BYTES) throw new Error('exceeds 20 MiB single-file upload limit');
  const upload = await client.fileUploads.create({ mode: 'single_part', filename, content_type: mime });
  if (typeof upload?.id !== 'string' || !upload.id || upload.status !== 'pending') throw new Error('Notion returned an invalid file upload.');
  const sent = await client.fileUploads.send({ file_upload_id: upload.id, file: { filename, data: new Blob([Uint8Array.from(bytes).buffer], { type: mime }) } });
  if (sent?.id !== upload.id || sent.status !== 'uploaded') throw new Error('Notion did not confirm an uploaded file.');
  const verified = await client.fileUploads.retrieve({ file_upload_id: upload.id });
  if (verified?.id !== upload.id || verified.status !== 'uploaded') throw new Error('Notion file upload is not uploaded.');
  return upload.id;
}
