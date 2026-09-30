# Obsidian Notion Sync (ntn)

Desktop-only Obsidian plugin: **Push to Notion** sends the active Markdown note to Notion using Notion's official `ntn` CLI. This is a manual, one-way push; nothing runs on save.

## Install

1. Install the CLI: `npm install -g ntn`. Ensure `ntn --version` works in the environment that launches Obsidian (or configure the absolute binary path in settings).
2. Create a Notion integration token for each workspace and grant each integration access to its target pages and default parent page.
3. Copy `manifest.json` and `main.js` into `<vault>/.obsidian/plugins/ntn-sync/`. Enable **Notion Sync (ntn)** in Obsidian's Community Plugins settings. Desktop Obsidian only.
4. In plugin settings, add a named **workspace profile** for each workspace, with its **Notion API token** and **default parent page ID** for new pages. The first profile is the default; removing it makes the next profile the default. The optional **path to ntn binary** is global. Tokens are stored in Obsidian's plugin data; protect your vault/plugin data accordingly. The selected token is passed to the CLI as `NOTION_API_TOKEN` with `NOTION_KEYRING=0` (no `ntn login` needed). Notion tokens are scoped to exactly one workspace, so use one profile per workspace.

## Use

Open a Markdown note and run **Push to Notion** from the command palette.

- Optional `notion_workspace: Work` in YAML frontmatter selects the named profile (case-insensitive). Without it, the first profile is used. An unknown workspace fails instead of falling back; choose a profile with access to the target page.
- With `notion_id` in the YAML frontmatter, the command updates that exact Notion page, including the title (from the note's filename) and Markdown body. A parent page ID is not needed for updates.
- Without `notion_id`, it creates a page under the selected profile's default parent, writes the returned ID into the note's frontmatter, then uploads the Markdown body. Later pushes update that page. Existing frontmatter text, including `notion_workspace`, is preserved where possible; frontmatter is excluded from the uploaded body.
- If upload fails after creation, the ID has already been saved: retrying updates the existing page. If writing the ID to the vault fails after creation, the new page may need manual cleanup in Notion.

Example:

```markdown
---
tags: [work]
notion_workspace: Work
notion_id: 01234567-89ab-cdef-0123-456789abcdef
---
# Notes
```

The plugin checks for `ntn` before making API requests. Errors from the CLI appear in an Obsidian notice, including its exit code.

## Attachments and Excalidraw

- `![[photo.png]]`, `![[photo.png|Caption]]`, `![[document.pdf]]`, and `![Caption](relative/path.png)` upload vault files with `ntn files create --json`. Images, PDFs, audio, video, and other files (such as ZIP/DOCX) appear as Notion media/file blocks at the embed position. Numeric aliases like `|400x300` are display sizes, not captions. File references resolve relative to the note, from the vault root (`/Assets/file.png`), or via Obsidian's link resolver (including attachment folders). External `https://` images remain external links.
- Single-file uploads are limited to **20 MiB** here; free Notion workspaces may reject uploads over **5 MiB**. Missing, too-large, or failed attachments become readable text in the page and produce a warning Notice. Files are uploaded once per push, even if embedded multiple times; no cross-push upload cache.
- Excalidraw embeds (`![[drawing.excalidraw]]` or `![[drawing.excalidraw.md|Caption]]`) need **obsidian-excalidraw-plugin** installed and enabled. Its Excalidraw Automate API renders PNG for upload. If unavailable or export fails, the embed becomes plain text with a warning suggesting installation. Pushing a drawing file itself as a note is not supported.
- Notion's enhanced Markdown format does not document a file-upload ID reference. The plugin uploads files, patches the page Markdown with standalone readable placeholders, then uses the blocks API to insert each media block immediately after its placeholder and delete the placeholder. If block insertion fails, the readable placeholder remains and a warning appears. Inline embeds inside complex Markdown (tables, nested lists) may lose surrounding formatting or fail placement; check the Notion page.

## Limitations

- Non-embed `[[wiki links]]` become readable plain text, not linked pages.
- The Notion Markdown endpoint may not support every Markdown construct or Notion block type. Unsupported content might be simplified by Notion; verify important notes after pushing.
- API calls for a note are sequential (Notion rate limit is roughly 3 requests/second). No batch, auto-sync, pull, or mobile support.
- Tokens are stored in plain plugin settings data, not an OS keychain. Payloads go over stdin; the token never appears in arguments. On Windows, npm's `.cmd` shim is handled by `cross-spawn`.

## Development

```sh
npm install
npm test
npx tsc --noEmit
npm run build     # emits main.js; manifest.json is checked in
npm run dev       # rebuild on change
```

Copy `manifest.json` and built `main.js` to the plugin directory in a test vault. Tests mock `child_process`; a live CLI or Notion account is not required.
