import { isFullPage, type PageObjectResponse } from '@notionhq/client';
import type { notionClient } from './notion';
import { notionPageUrl, sameId } from './note-links';

function pageInfo(page: PageObjectResponse) {
  notionPageUrl(page.id);
  const title = page.properties && Object.values(page.properties).find((property) => property?.type === 'title');
  if (!title || !Array.isArray(title.title) || title.title.some((text) => typeof text.plain_text !== 'string')) {
    throw new Error('Notion did not return a readable page title. Check this token’s page access.');
  }
  return { id: page.id, title: title.title.map((text) => text.plain_text).join('').trim() || 'Untitled' };
}

function activePage(page: PageObjectResponse) {
  if (typeof page.in_trash !== 'boolean' || (typeof page.archived !== 'boolean' && typeof page.is_archived !== 'boolean')) {
    throw new Error('Notion did not return this page’s availability. Try searching again.');
  }
  return !page.in_trash && !page.archived && !page.is_archived;
}

export async function readParentPage(client: ReturnType<typeof notionClient>, id: string) {
  notionPageUrl(id);
  const page = await client.pages.retrieve({ page_id: id });
  if (!page || !isFullPage(page) || !activePage(page) || !sameId(page.id, id)) {
    throw new Error('This parent page is unavailable. Choose an accessible, active Notion page.');
  }
  return pageInfo(page);
}

export async function searchParentPages(client: ReturnType<typeof notionClient>, query: string, active = () => true) {
  const pages = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let batch = 0; batch < 100; batch++) {
    if (!active()) return [];
    const response = await client.search({ query: query.trim(), filter: { property: 'object', value: 'page', in_trash: false }, page_size: 100, start_cursor: cursor });
    if (!active()) return [];
    if (!response || !Array.isArray(response.results) || typeof response.has_more !== 'boolean') {
      throw new Error('Notion returned incomplete page results. Try searching again.');
    }
    if (response.request_status && response.request_status.type !== 'complete') throw new Error('More pages matched than Notion could return. Type a more specific title.');
    for (const page of response.results) {
      if (!page || page.object !== 'page' || !isFullPage(page)) throw new Error('Notion returned an unreadable page. Check this token’s page access.');
      if (!activePage(page)) continue;
      pages.push(pageInfo(page));
    }
    if (!response.has_more) {
      if (response.next_cursor !== null) throw new Error('Notion returned incomplete page pagination. Try searching again.');
      return [...new Map(pages.map((page) => [notionPageUrl(page.id), page])).values()];
    }
    if (typeof response.next_cursor !== 'string' || !response.next_cursor || seen.has(response.next_cursor)) {
      throw new Error('Notion returned incomplete page pagination. Try searching again.');
    }
    cursor = response.next_cursor;
    seen.add(cursor);
  }
  throw new Error('Too many pages matched. Type a more specific title.');
}
