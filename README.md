# Obsidian ↔ Notion Sync

**Push your Obsidian notes to Notion—including Excalidraw, TLDraw, images, and file embeds. Pull changes back and choose what to keep with a coloured inline diff.**

Desktop Obsidian only. Push and pull are separate, manual commands—nothing syncs automatically on save.

## Push a note to Notion

1. Open a Markdown note in Obsidian.
2. Open the command palette and run **Notion Sync (ntn): Push to Notion**.
3. On the first push, the plugin creates a Notion page and adds `notion_id` to your note. Later pushes update that page. To target an existing page, set its ID in `notion_id` first.

Your note's filename becomes the page title. Its body and supported embeds are uploaded; YAML frontmatter stays in Obsidian.

If Notion has changed since your last sync, choose **Cancel — pull first** to merge those edits, or **Push anyway** to overwrite the page.

![Push confirmation with the Notion diff, Cancel — pull first, and Push anyway options](docs/screenshots/push-confirmation.png)

## Pull changes back

Run **Notion Sync (ntn): Pull from Notion** on a note with `notion_id`.

- Independent local and Notion edits merge automatically and save to Obsidian.
- Conflicts—or a first pull without a baseline—open an inline review.
- Choose **Take Notion** or **Keep Obsidian** for each changed block. You can also edit inline, undo a decision, or use the bulk actions.
- Click **Save merged note** once every change is reviewed. **Cancel** leaves the note unchanged.

Formatting-only whitespace changes are ignored; meaningful code whitespace is preserved. Pull never writes to Notion—run **Push to Notion** separately when you're ready.

![Inline diff with coloured additions and deletions, per-change Take Notion and Keep Obsidian buttons, Undo, and Save merged note](docs/screenshots/pull-review.png)

*Interface previews use example notes.*

## Drawings, images, and embeds

| Content | Push to Notion | Pull to Obsidian |
| --- | --- | --- |
| **Excalidraw** — `![[Design.excalidraw]]` | Render and upload as a PNG. | Restore the tracked original drawing embed—not a replacement PNG. |
| **TLDraw** — `![[Sketch.tldr]]` or a TLDraw Markdown embed | Render and upload as a PNG. | Restore the tracked original drawing embed. |
| **Images** — `![[photo.png]]` or `![Photo](photo.png)` | Upload at the embed's position. | Restore known embeds; download new images into `notion-sync-assets/`. |
| **Files and note embeds** — `![[document.pdf]]`, `![[Other Note]]` | Upload as file attachments. | Restore known embeds; new non-image attachments remain Notion links. |
| **Wiki-links** — `[[Other Note]]` | Link to its Notion page when it has an ID in the same workspace. | Restore known wiki-links; unknown page mentions become Notion links. |

Excalidraw and **[Tldraw in Obsidian](https://github.com/tldraw/obsidian-plugin)** must be installed and enabled to export drawings. TLDraw Markdown files with `tldraw-file` frontmatter are supported; offline `.tldraw` files are not.

**Drawing files stay editable in Obsidian.** Notion receives PNG previews, not editable drawing data. Pull preserves tracked source embeds; it does not merge drawing edits made to those PNGs. Older exports without saved mappings import as ordinary images.

## Setup

1. Install Notion's CLI:
   ```sh
   npm install -g ntn
   ```
2. Create a Notion integration and grant it access to your target pages and a parent page for new notes.
3. Copy [`main.js`](main.js) and [`manifest.json`](manifest.json) into `<vault>/.obsidian/plugins/ntn-sync/`, then enable **Notion Sync (ntn)** in Community Plugins.
4. In plugin settings, add a workspace profile with its **Notion API token** and **default parent page ID**. If Obsidian cannot find `ntn`, set its absolute binary path.

The first workspace profile is the default. To use another, add `notion_workspace` to the note:

```yaml
---
notion_workspace: Work
notion_id: 01234567-89ab-cdef-0123-456789abcdef
---
```

Both fields are optional for a first push. Pull requires `notion_id`. No `ntn login` is needed.

## Safety and limits

- Pull preserves frontmatter and backs up the full note before changing it. Backups and sync mappings live in `.obsidian/plugins/ntn-sync/`; backups are not automatically pruned.
- Your chosen local edits remain pending across pulls. If the note changes during review, saving stops rather than overwriting those edits.
- Attachments are limited to **20 MiB each**; your Notion plan may impose a lower limit.
- Not every Markdown construct or Notion block round-trips exactly. Complex inline embeds may lose placement; check important pages after pushing.
- Tokens are stored in plain plugin settings. Protect your vault and plugin data. A push confirmation cannot prevent edits racing the final Notion write.

## Development

```sh
npm ci
npm test
npx tsc --noEmit
npm run build
```

Source is in `src/`; tests are in `tests/`. Build emits `main.js`. Copy the plugin files into a test vault and reload to try changes.
