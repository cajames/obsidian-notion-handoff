# Notion Handoff

**Publish polished notes across your clients' Notion workspaces. Keep background research local. Share only the notes you choose.**

For desktop and mobile Obsidian. Mobile support is experimental. Push and Pull are separate manual commands, with no startup, background, or on-save sync. Connects directly to Notion; no CLI, Node, or npm needed.

## Base features

- **Push to Notion:** create a page on first push, then update it using the saved `notion_id`. The filename becomes its title. Frontmatter stays local.
- **Pull from Notion:** bring page edits back without publishing your pending local edits.
- Upload images and files at their embed positions. Import new Notion images into Obsidian’s attachment location, or choose an **Imported images folder** in plugin settings. Existing imports stay where they are.
- Restore tracked wiki-links and embeds. Same-workspace note links become page mentions when possible, otherwise readable pending text.

## What makes it different

- **Workspace profiles:** separate tokens and parent pages for each client. Select a profile per note with `notion_workspace`; the first profile is the default.
- **Granular merges:** three-way merging preserves independent edits. Conflicts and first-time differences without a baseline open an inline review with per-block **Take Notion**, **Keep Obsidian**, **Undo**, manual editing, and cancellation. Formatting-only whitespace changes are ignored; meaningful code whitespace stays intact.
- **Drawing support:** push Excalidraw and TLDraw embeds as PNG previews. Pull restores tracked editable source embeds, not replacement PNGs. Enable Excalidraw or [Tldraw in Obsidian](https://github.com/tldraw/obsidian-plugin) to export. TLDraw `.tldr` and Markdown drawings are supported; offline `.tldraw` files are not.

## Install with BRAT

Use [BRAT](https://github.com/TfTHacker/obsidian42-brat) on desktop or mobile:

1. Open **Settings → Community plugins**, then install and enable **BRAT**.
2. In BRAT settings, choose **Add a beta plugin**, enter `cajames/obsidian-notion-handoff`, and select the latest release.
3. Enable **Notion Handoff** in Community Plugins.

BRAT handles installation and updates. No manual file copying or GitHub token is needed for the public repository.

**Release availability:** this requires a public repository with a published GitHub release. The first release is still pending. Notion Handoff is not yet listed directly in Community Plugins.

## Notion setup

1. Create a Notion integration with read, update, and insert content capabilities. Grant it access to target pages and a parent page for new notes.
2. Add its API token and default parent page ID in plugin settings. Add more profiles for other workspaces.

Optional note frontmatter:

```yaml
---
notion_workspace: Client
notion_id: 01234567-89ab-cdef-0123-456789abcdef
---
```

A first push needs neither field. Pull requires `notion_id`.

The plugin ID is `notion-handoff`. Earlier development installs using `ntn-sync` are separate plugins; their settings and sync state are not migrated automatically.

## Manual workflow

Open a Markdown note and run **Push to Notion** from the command palette. Changed remote content requires confirmation. Cancel and pull first to merge, or choose **Push anyway** to replace the page.

![Push confirmation with the Notion diff and cancellation options](docs/screenshots/push-confirmation.png)

Run **Pull from Notion** to merge remote edits. Independent changes save automatically. In review, resolve each change and click **Save merged note**, or **Cancel** to leave the note untouched. Pull never writes to Notion.

![Inline review with per-block choices, Undo, and Save merged note](docs/screenshots/pull-review.png)

*Screenshots use example notes.*

## Safety and limits

- Mobile installation is enabled, but physical iOS and Android devices have not yet been verified. Drawing exports require a compatible renderer plugin on your device.
- Pull preserves frontmatter, backs up the full note, and stops if the note changes during review. Backups and sync state stay in `.obsidian/plugins/notion-handoff/`.
- Incomplete or inaccessible remote content is rejected. Push rechecks Notion before writing, but cannot eliminate a final racing edit.
- Files are limited to **20 MiB each**; your Notion plan may impose a lower limit. Some Markdown and Notion blocks do not round-trip exactly.
- Drawings remain editable locally. Notion receives previews; edits to those PNGs are not merged into drawing sources. Untracked older exports import as images.
- Tokens are stored in plain plugin settings. Protect your vault. [Transport and retry policy](docs/notion-api.md).

## Development

`npm ci`, `npm test`, `npx tsc --noEmit`, `npm run build`. Source: `src/`. Tests: `tests/`.

For local testing only, place the built `main.js` and `manifest.json` in `<vault>/.obsidian/plugins/notion-handoff/` and reload Obsidian.
