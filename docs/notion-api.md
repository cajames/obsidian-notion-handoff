# Notion transport

The plugin bundles `@notionhq/client` and explicitly sends `Notion-Version: 2026-03-11`. Each command creates a client using only the selected workspace profile's token. No CLI or global installation is used or removed.

SDK fetch uses Obsidian `requestUrl` with `throw: false`, preserving status, response text, and case-insensitive headers for SDK error handling. JSON is sent as serialized JSON. Native `Request` encodes SDK `FormData` into an ArrayBuffer with its matching multipart boundary, filename, MIME type, and raw bytes. Image downloads use separate requests without authorization headers.

Uploads use the single-part File Uploads flow: create with filename and content type, send multipart `file`, retrieve to verify `uploaded`, then append a media block. Both send and verification must confirm the same upload ID. The 20 MiB limit applies before creating an upload. Media placeholders are deleted only after an inserted block ID is confirmed.

## Workspace identity and note bindings

There is no default workspace. A note’s `notion_workspace` selects a configured profile. Missing or blank names auto-select only when one profile exists; otherwise Push and Pull open a cancellable picker with the first named workspace preselected. Confirmation is still required before any API calls. Reordering profiles never changes a note’s destination. Named profiles must resolve uniquely; unassigned legacy wiki-links remain pending rather than guessing from list order.

Before page reads or uploads, `users.me` must return a bot workspace ID. It is checked against `notion_workspace_id` and any saved local association. Missing IDs or mismatches stop sync. The **Notion access token** setting accepts integration tokens and OAuth access tokens as opaque bearer credentials. Token replacement is allowed only within the pinned workspace. Checkpoints and drawing provenance use stable workspace/page keys, preserving history when credentials change.

Legacy token-hash entries remain intact. On a successful sync, history matching the current token is adopted into the verified workspace/page key. A previously bound note can also recover one unambiguous legacy history for its page after a token replacement. Multiple candidates stop sync rather than guessing; unbound notes cannot adopt another token’s history. Cancellation saves no migration. Partial migrations can resume independently for checkpoints and drawing provenance.

Each bound note keeps its workspace name, actual workspace ID and page ID in frontmatter. `note-links.json` separately records its vault path, workspace name, workspace ID and page ID. New page bindings are saved immediately after creation, before content replacement. If note write-back fails, the local mapping provides recovery without replaying page creation. A binding storage failure stops content writes. Pull saves bindings only after review succeeds, with a backup for frontmatter changes; cancellation saves nothing. Moving a note preserves its frontmatter identity and records its new path on the next sync. Conflicting associations must be repaired explicitly, not silently rebound.

New pages use a non-empty string `title` frontmatter property, otherwise the current filename without its extension. Existing pages receive content updates only; Push never updates page-title properties, and Pull never renames files or rewrites their local titles.

## Setup and navigation

**Test connection** reads `users.me` and, when configured, retrieves the parent page to confirm read access. Existing note associations for that workspace name must match the token’s workspace. Insert/update capabilities are configured in Notion; testing does not publish content.

**Choose parent page** opens a keyboard-friendly title search. Debounced `/search` POST requests are read-only, scoped to pages accessible to the selected token, and exclude trash. Pagination is checked; incomplete queries, unreadable pages and cursor loops require a refined search or retry. The selected page is retrieved again before saving its ID. Stale settings, removed/rerendered profiles and cancelled prompts never save a selection. These actions are user-triggered and do not modify notes or sync state.

**Open in Notion** builds an official HTTPS page URL from a validated page ID, using frontmatter or its saved recovery association. Conflicting associations are rejected. Opening a page needs no token or API request and does not change local data.

## Bounded retries

The SDK makes at most three attempts per API call (two retries):

- HTTP 429 and 529 can retry all methods, as Notion explicitly rejects them for rate limiting or overload.
- HTTP 500 and 503 retry only GET and DELETE.
- POST/PATCH server errors, network failures, timeouts, permission errors, and malformed responses are not retried.
- `Retry-After` is honored up to 60 seconds, including HTTP-date values. Longer waits stop the command instead of retrying earlier than requested. Restricted API access (`public_api_request_blocked`) also stops without retrying.
- Without that header, the SDK uses bounded exponential backoff with jitter, starting at 1 second and capped at 60 seconds.

Each request attempt has a 60-second SDK timeout. Obsidian cannot abort an in-flight `requestUrl` request; a timed-out write may still finish remotely. Check Notion before manually retrying a failed page creation or media insertion. There is no automatic replay of ambiguous creation/append writes, and placeholders remain if append confirmation fails.

Mention fallback only follows a validation rejection or a complete readback showing missing mentions. Permission errors, network failures, ambiguous writes, and incomplete readbacks stop instead of triggering another write.

## Runtime utilities

Random placeholder and backup IDs use Nano ID's secure browser implementation with 32 hexadecimal characters (128 random bits). Content, workspace, and media fingerprints remain SHA-256 hexadecimal strings via `@noble/hashes`, preserving the previous checkpoint format. Vault paths use the POSIX implementation in `path-browserify`, including the internal path dependency of `mime-types`.

The build selects browser dependencies and mobile installation is enabled. Browser-isolated utility tests pass, but end-to-end sync on physical iOS and Android devices has not yet been verified. The Notion SDK retains an unused Node crypto fallback for webhook verification; sync does not call it.

## Official references

- [SDK](https://github.com/makenotion/notion-sdk-js)
- [2026-03-11 upgrade guide](https://developers.notion.com/guides/get-started/upgrade-guide-2026-03-11)
- [Page Markdown updates](https://developers.notion.com/reference/update-page-markdown)
- [Small file uploads](https://developers.notion.com/guides/data-apis/uploading-small-files)
- [Request limits and ambiguous writes](https://developers.notion.com/reference/request-limits)
