import type { notionClient } from './notion';
import type { parseNote } from './note';

export function sameId(left: string, right: string) {
  return left.replace(/-/g, '').toLowerCase() === right.replace(/-/g, '').toLowerCase();
}

export function parseNoteLinks(raw: string) {
  const data = JSON.parse(raw);
  if (!data || Array.isArray(data) || typeof data !== 'object') throw new Error('Invalid note-links.json.');
  return Object.fromEntries(Object.entries(data).map(([path, value]) => {
    if (!path || !value || typeof value !== 'object') throw new Error('Invalid note binding; repair note-links.json before syncing.');
    const notePath = Reflect.get(value, 'notePath');
    const workspaceName = Reflect.get(value, 'workspaceName');
    const workspaceId = Reflect.get(value, 'workspaceId');
    const pageId = Reflect.get(value, 'pageId');
    if (notePath !== path || typeof workspaceName !== 'string' || !workspaceName.trim() ||
      typeof workspaceId !== 'string' || !workspaceId.trim() || typeof pageId !== 'string' || !pageId.trim()) {
      throw new Error('Invalid note binding; repair note-links.json before syncing.');
    }
    return [path, { notePath: path, workspaceName, workspaceId, pageId }];
  }));
}

export function notionPageUrl(id: string) {
  const compact = id.trim().replace(/-/g, '').toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(compact)) throw new Error('Use a valid Notion page ID.');
  return `https://www.notion.so/${compact}`;
}

export async function readWorkspace(client: ReturnType<typeof notionClient>) {
  const user = await client.users.me({});
  const bot = user?.type === 'bot' ? user.bot : null;
  const workspaceId = bot && typeof bot === 'object' && 'workspace_id' in bot ? bot.workspace_id : null;
  if (typeof workspaceId !== 'string' || !workspaceId.trim()) throw new Error('Notion did not return a workspace ID; refusing to sync.');
  const name = bot && 'workspace_name' in bot && typeof bot.workspace_name === 'string' ? bot.workspace_name.trim() || null : null;
  return { id: workspaceId, name };
}

export async function verifiedWorkspace(client: ReturnType<typeof notionClient>, note: ReturnType<typeof parseNote>, saved?: ReturnType<typeof parseNoteLinks>[string]) {
  const { id: workspaceId } = await readWorkspace(client);
  if (note.notionWorkspaceId && !sameId(note.notionWorkspaceId, workspaceId)) {
    throw new Error('This token belongs to a different Notion workspace than the note’s saved workspace ID. Nothing was uploaded.');
  }
  if (saved && (!sameId(saved.workspaceId, workspaceId) || !note.notionId || !sameId(saved.pageId, note.notionId))) {
    throw new Error('This note no longer matches its saved workspace/page binding. Restore its original workspace and page IDs before syncing.');
  }
  return workspaceId;
}
