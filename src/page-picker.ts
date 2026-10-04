import { debounce, FuzzySuggestModal, type App } from 'obsidian';
import type { notionClient } from './notion';
import { searchParentPages } from './notion-pages';

class ParentPagePicker extends FuzzySuggestModal<Awaited<ReturnType<typeof searchParentPages>>[number]> {
  private pages: Awaited<ReturnType<typeof searchParentPages>> = [];
  private lastQuery: string | null = null;
  private queryRevision = 0;
  private pickerClosed = false;
  private fetchPages = debounce(async (query: string, revision: number) => {
    const active = () => !this.pickerClosed && revision === this.queryRevision;
    try {
      const pages = await searchParentPages(this.client, query, active);
      if (!active()) return;
      this.pages = pages;
      this.emptyStateText = 'No pages found. Give this connection page access, then try another title.';
    } catch (error) {
      if (!active()) return;
      this.pages = [];
      this.emptyStateText = error instanceof Error ? error.message : String(error);
    }
    this.inputEl.dispatchEvent(new Event('input'));
  }, 250, true);

  constructor(app: App, private client: ReturnType<typeof notionClient>, workspace: string,
    private finish: (page: Awaited<ReturnType<typeof searchParentPages>>[number] | null) => void) {
    super(app);
    this.modalEl.classList.add('notion-handoff-page-picker');
    this.inputEl.setAttribute('aria-label', 'Parent page title');
    this.setPlaceholder(`Search pages in ${workspace}`);
    this.setInstructions([{ command: '↑↓', purpose: 'navigate' }, { command: '↵', purpose: 'choose page' }, { command: 'esc', purpose: 'cancel' }]);
  }

  getItems() { return this.pages; }
  getItemText(page: (typeof this.pages)[number]) { return `${page.title} · ${page.id.slice(-8)}`; }

  getSuggestions(query: string) {
    if (this.pickerClosed) return [];
    if (query !== this.lastQuery) {
      this.lastQuery = query;
      this.pages = [];
      this.emptyStateText = 'Searching pages…';
      this.fetchPages(query, ++this.queryRevision);
    }
    return super.getSuggestions(query);
  }

  onChooseItem(page: (typeof this.pages)[number]) { this.finish(this.pages.includes(page) ? page : null); }

  onClose() {
    this.pickerClosed = true;
    this.fetchPages.cancel();
    super.onClose();
    // Obsidian may close the prompt before invoking onChooseItem.
    queueMicrotask(() => this.finish(null));
  }
}

export function pickParentPage(app: App, client: ReturnType<typeof notionClient>, workspace: string) {
  return new Promise<Awaited<ReturnType<typeof searchParentPages>>[number] | null>((resolve) => new ParentPagePicker(app, client, workspace, resolve).open());
}
