import { spawn } from 'node:child_process';
import crossSpawn = require('cross-spawn');

export const missingCli = 'ntn CLI not found — install with npm install -g ntn (or set its path in settings).';

export function createArgs() {
  return ['api', 'v1/pages', '-X', 'POST', '-d', '@-'];
}

export function titleArgs(pageId: string) {
  return ['api', `v1/pages/${encodeURIComponent(pageId)}`, '-X', 'PATCH', '-d', '@-'];
}

export function markdownArgs(pageId: string) {
  return ['api', `v1/pages/${encodeURIComponent(pageId)}/markdown`, '-X', 'PATCH', '-d', '@-'];
}

export function markdownPayload(markdown: string) {
  return { type: 'replace_content', replace_content: { new_str: markdown } };
}

export function titleProperty(title: string) {
  return { title: { type: 'title', title: [{ type: 'text', text: { content: title } }] } };
}

export function createPayload(parentId: string, title: string) {
  return { parent: { type: 'page_id', page_id: parentId }, properties: titleProperty(title) };
}

export function formatCliError(code: number | null, stderr: string) {
  return `ntn exited with code ${code ?? 'unknown'}: ${stderr.trim() || 'No error details provided.'}`;
}

// Credentials go only in the environment; JSON goes only on stdin, not argv.
export function runNtn(binary: string, token: string, args: string[], stdin?: string | Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    // npm installs ntn as a .cmd shim on Windows; cross-spawn handles the shim.
    const launch = process.platform === 'win32' ? crossSpawn : spawn;
    const child = launch(binary, args, {
      env: { ...process.env, NOTION_API_TOKEN: token, NOTION_KEYRING: '0' },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    // ntn can reject the request before reading stdin; EPIPE must not crash Obsidian.
    child.stdin?.on('error', () => {});
    child.stdin?.end(stdin);
    child.on('error', (error: NodeJS.ErrnoException) => {
      reject(error.code === 'ENOENT' ? new Error(missingCli) : new Error(`Could not run ntn: ${error.message}`));
    });
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(formatCliError(code, stderr)));
      else resolve(stdout);
    });
  });
}

export async function pushPage(run: (args: string[], stdin?: string | Buffer) => Promise<string>, pageId: string, title: string, body: string) {
  await run(titleArgs(pageId), JSON.stringify({ properties: titleProperty(title) }));
  await run(markdownArgs(pageId), JSON.stringify(markdownPayload(body)));
}
