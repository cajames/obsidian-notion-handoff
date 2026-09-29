# Obsidian Notion Sync (ntn)

Desktop-only Obsidian plugin: **Push to Notion** sends the active Markdown note to Notion using Notion's official `ntn` CLI. This is a manual, one-way push; nothing runs on save.

## Install

1. Install the CLI: `npm install -g ntn`. Ensure `ntn --version` works in the environment that launches Obsidian (or configure the absolute binary path in settings).
2. Create a Notion integration token and grant that integration access to the pages you want to update and to the default parent page.
3. Copy `manifest.json` and `main.js` into `<vault>/.obsidian/plugins/ntn-sync/`. Enable **Notion Sync (ntn)** in Obsidian's Community Plugins settings. Desktop Obsidian only.
4. In the plugin settings, enter the **Notion API token**, **default parent page ID** (for new pages), and optionally the **path to ntn binary**. The token is stored in Obsidian's plugin data; protect your vault/plugin data accordingly. It is passed to the CLI as `NOTION_API_TOKEN` with `NOTION_KEYRING=0` (no `ntn login` needed).

## Use

Open a Markdown note and run **Push to Notion** from the command palette.

- With `notion_id` in the YAML frontmatter, the command updates that exact Notion page, including the title (from the note's filename) and Markdown body. The default parent setting is not needed.
- Without `notion_id`, it creates a page under the configured parent, writes the returned ID into the note's frontmatter, then uploads the Markdown body. Later pushes update that page. Existing frontmatter text is preserved where possible; frontmatter is excluded from the uploaded body.
- If upload fails after creation, the ID has already been saved: retrying updates the existing page. If writing the ID to the vault fails after creation, the new page may need manual cleanup in Notion.

Example:

```markdown
---
tags: [work]
notion_id: 01234567-89ab-cdef-0123-456789abcdef
---
# Notes
```

The plugin checks for `ntn` before making API requests. Errors from the CLI appear in an Obsidian notice, including its exit code.

## Limitations

- Text-only Markdown MVP: `[[wiki links]]` and `![[embeds]]` become readable plain text, not linked pages or uploaded attachments. Images are not uploaded. **Phase 2**: upload files with `ntn files create`, then link resulting uploads to Notion blocks.
- The Notion Markdown endpoint may not support every Markdown construct or Notion block type. Unsupported content might be simplified by Notion; verify important notes after pushing.
- API calls for a note are sequential (Notion rate limit is roughly 3 requests/second). No batch, auto-sync, pull, or mobile support.
- The token is stored in plain plugin settings data, not an OS keychain. Payloads go over stdin; the token never appears in arguments. On Windows, npm's `.cmd` shim is handled by `cross-spawn`.

## Development

```sh
npm install
npm test
npx tsc --noEmit
npm run build     # emits main.js; manifest.json is checked in
npm run dev       # rebuild on change
```

Copy `manifest.json` and built `main.js` to the plugin directory in a test vault. Tests mock `child_process`; a live CLI or Notion account is not required.
