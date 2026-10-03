# Notion Handoff

**Publish polished notes to your work or clients' Notion workspaces.**

Keep background research local. Share the notes you choose. You decide when to push and pull. Every sync is manual.

[Installation](#installation) · [Notion setup](#notion-setup)

## Base features

- **Push notes:** publish an Obsidian note to Notion, then push updates when you're ready.
- **Pull edits:** bring Notion changes back into Obsidian.
- **Upload images and files:** include attachments where they're embedded in your note. Pull new images into your chosen attachment folder.

## What makes it different

- **Workspaces for work and clients:** keep separate connections for each workspace. Every note remembers where it belongs.
- **Review changes:** merge independent edits and resolve conflicts one change at a time, with inline editing and Undo.
- **Editable drawings:** publish [Excalidraw](https://github.com/zsviczian/obsidian-excalidraw-plugin) and [TLDraw](https://github.com/tldraw/obsidian-plugin) embeds as PNG previews. Their source drawings stay editable in Obsidian. Enable the drawing's plugin to export it.

## See it in action

### Push with a diff

Run **Push to Notion** from the command palette. Review changed Notion content before replacing it. Pull first to merge those edits, or choose **Push anyway**.

![Push confirmation with a diff and options to pull first or push](docs/screenshots/push-confirmation.png)

### Review a pull

Run **Pull from Notion**. Independent edits merge automatically. For changes needing review, choose **Take Notion** or **Keep Obsidian**, edit inline, and use **Undo** as needed. **Save merged note** backs up your original and saves the result.

![Inline pull review with per-change decisions, Undo, and Save merged note](docs/screenshots/pull-review.png)

## Installation

BRAT installation will be available with the first public GitHub release.

1. Install and enable [BRAT](https://github.com/TfTHacker/obsidian42-brat) through **Settings → Community plugins**.
2. In BRAT settings, choose **Add a beta plugin** and enter `cajames/obsidian-notion-handoff`.
3. Select the latest release, then enable **Notion Handoff**.

BRAT handles installation and updates. Desktop and experimental mobile support are enabled.

## Notion setup

1. [Create a Notion integration](https://www.notion.so/profile/integrations) with read, update, and insert content capabilities. Give it access to your target pages and a parent page for new notes.
2. In Notion Handoff settings, add a workspace name, integration token, and parent page ID. Add a connection for each workspace you use.

Choose a workspace when prompted; your note saves the choice. A single workspace is selected automatically.

New pages use the note's `title` frontmatter property, or its filename. After creation, manage the page title in Notion.

[Technical details](docs/notion-api.md)
