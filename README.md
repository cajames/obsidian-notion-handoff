<p align="center">
  <img src="assets/logo.png" alt="Obsidian Notion Handoff logo" width="160">
</p>

# Obsidian Notion Handoff

**Publish polished notes to your work or clients' Notion workspaces.**

Keep background research local. Share the notes you choose. You decide when to push and pull. Every sync is manual.

[Installation](#installation) · [Notion setup](#notion-setup)

## Base features

- **Push notes:** publish an Obsidian note to Notion, then push updates when you're ready.
- **Pull edits:** bring Notion changes back into Obsidian.
- **Open in Notion:** jump to the note's linked page from the command palette.
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

Install the [latest GitHub release](https://github.com/cajames/obsidian-notion-handoff/releases/latest) through BRAT.

1. Install and enable [BRAT](https://github.com/TfTHacker/obsidian42-brat) through **Settings → Community plugins**.
2. In BRAT settings, choose **Add a beta plugin** and enter `cajames/obsidian-notion-handoff`.
3. Select the latest release, then enable **Notion Handoff**.

BRAT handles installation and updates. Desktop and experimental mobile support are enabled.

## Notion setup

1. In Notion Handoff settings, name a workspace and click **Connect to Notion**.
2. In your browser, choose the Notion workspace and grant access to your target pages, including a parent page for new notes. No personal integration or token is needed.
3. The callback page tries to open Obsidian after three seconds. Click **Open Obsidian** if your browser blocks it; use the same device and vault that started sign-in.
4. Click **Choose parent page** to find the page for new notes by title. Add a separate connection for each workspace.

Choose a workspace when prompted; your note saves the choice. A single workspace is selected automatically.

New pages use the note's `title` frontmatter property, or its filename. After creation, manage the page title in Notion.

### Manual access tokens (optional)

Manual tokens remain supported. [Create a Notion integration](https://www.notion.so/profile/integrations) with read, update, and insert content capabilities, grant access to your target pages, and paste its token into **Notion access token** in the workspace settings. Click **Test connection**, then **Choose parent page**.

[OAuth deployment guide](docs/oauth-deployment.md) · [Technical details](docs/notion-api.md)

## No warranty; limitation of liability

Notion Handoff and its hosted services are provided **“AS IS” and “AS AVAILABLE”**, without warranty of any kind, express or implied, including warranties of merchantability, fitness for a particular purpose, and non-infringement. Use them at your own risk. You are responsible for maintaining independent backups and reviewing changes before syncing.

**To the fullest extent permitted by applicable law**, the author, contributors, and service operators shall not be liable for any claims, damages, or other liability, including data loss, corruption, unintended disclosure, lost profits, or service interruption, whether in contract, tort, or otherwise, arising from the software or services, their use, or inability to use them, even if advised of the possibility of such damages. Nothing in this disclaimer excludes liability that cannot legally be excluded.
