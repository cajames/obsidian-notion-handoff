# Notion transport

The plugin bundles `@notionhq/client` and explicitly sends `Notion-Version: 2026-03-11`. Each command creates a client using only the selected workspace profile's token. No CLI or global installation is used or removed.

SDK fetch uses Obsidian `requestUrl` with `throw: false`, preserving status, response text, and case-insensitive headers for SDK error handling. JSON is sent as serialized JSON. Native `Request` encodes SDK `FormData` into an ArrayBuffer with its matching multipart boundary, filename, MIME type, and raw bytes. Image downloads use separate requests without authorization headers.

Uploads use the single-part File Uploads flow: create with filename and content type, send multipart `file`, retrieve to verify `uploaded`, then append a media block. Both send and verification must confirm the same upload ID. The 20 MiB limit applies before creating an upload. Media placeholders are deleted only after an inserted block ID is confirmed.

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
