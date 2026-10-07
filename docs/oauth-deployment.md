# Hosted Notion OAuth

The source includes **Connect to Notion** and a Cloudflare Worker shared by all users. These changes are not in the published v0.1.0 release. The service must be configured and deployed before browser sign-in works; manual access tokens remain supported.

## Notion integration

Create a **public** integration in the [Notion developer portal](https://www.notion.so/profile/integrations). Configure read, update, and insert content capabilities.

Register this exact redirect URI:

```text
https://obsidian-notion-handoff.caj.ms/notion/callback
```

Complete Notion's required public integration metadata, including appropriate website, support, privacy-policy and terms links. Review its distribution requirements before opening sign-in to all users. Workspace administrators can still restrict integrations; OAuth does not bypass their policies.

Keep the integration's client ID and client secret available locally for deployment. **Never put the client secret in the plugin, Git, or chat.** Users do not need these credentials or their own integration.

## Cloudflare deployment

### 1. Add the domain to Cloudflare

1. Sign in to the [Cloudflare dashboard](https://dash.cloudflare.com/) and add **`caj.ms`** as a domain/site. The Free DNS plan is sufficient. Skip this step if the zone is already active in your account.
2. Review the imported DNS records, including website and email records, before switching nameservers.
3. At the domain registrar, replace the current nameservers with the two Cloudflare assigns. Follow Cloudflare's DNSSEC migration instructions if DNSSEC is enabled. Wait until Cloudflare shows the zone as **Active**.
4. Ensure `obsidian-notion-handoff.caj.ms` is not already used by another service. Do not create a manual A or CNAME record for it; the Worker custom-domain configuration creates its DNS record and manages HTTPS certificates at deployment. The root website remains unchanged.

### 2. Deploy the Worker

Install Node.js 22+ and use the Cloudflare account owning the active `caj.ms` zone. SQLite-backed Durable Objects are supported on Workers Free; review current quotas before choosing Free or Paid.

From the repository:

```sh
cd worker
npm ci
npx wrangler login
npx wrangler whoami
npm test
npx wrangler deploy --dry-run
npm run deploy
npx wrangler secret put NOTION_CLIENT_ID
npx wrangler secret put NOTION_CLIENT_SECRET
```

Verify `wrangler whoami` lists the account owning `caj.ms`. If you have multiple accounts, select the correct one when prompted or set its `account_id` in `worker/wrangler.jsonc` before deployment.

Enter each Notion credential at Wrangler's prompt; do not paste secrets into shell commands or Git. The initial deployment intentionally returns a configuration error until both secrets are set.

### 3. Verify Cloudflare configuration

In **Workers & Pages → notion-handoff-auth → Settings**, confirm:

- **Domains & Routes:** `obsidian-notion-handoff.caj.ms` is attached as a custom domain. Allow time for the HTTPS certificate to become active.
- **Variables and Secrets:** `NOTION_CLIENT_ID` and `NOTION_CLIENT_SECRET` exist as secrets. You can also add or replace them here using the Secret type.
- **Bindings:** `SESSIONS` is the Durable Object binding, `AUTH_RATE_LIMIT` is the rate-limit binding, and `ASSETS` serves the project logo. Deployment creates these; do not create a separate KV database.

The service exposes `/notion/start`, `/notion/callback`, and `/notion/redeem`; the domain root intentionally returns 404. Project logos are public at `/logo.png` and `/logo.webp`. Test sign-in through the plugin rather than expecting a homepage.

`worker/wrangler.jsonc` configures:

- Custom domain `obsidian-notion-handoff.caj.ms`, with `workers.dev` disabled.
- Same-origin logo assets from the repository's `assets/` directory. The Worker runs before asset serving and only allows GET/HEAD for the two logo paths. The callback page permits same-origin images through CSP; no third-party image host is used.
- `manifest.json` references `assets/logo.png` in a custom `logo` metadata field. Obsidian does not support displaying plugin logos from the manifest.
- An SQLite-backed Durable Object per authorization attempt. No KV namespace or external database is required.
- A per-IP rate-limit binding: 20 requests per minute across start, callback, and redemption. Cloudflare rate limits are approximate and location-scoped, not a global spending cap.
- Worker observability disabled to avoid recording callback URLs containing authorization codes.

Set Cloudflare usage/billing alerts and review abuse protection before broad distribution. Do not enable request/body logging on OAuth endpoints; Cloudflare can still process network metadata under its own policies. Publish a privacy policy accurately describing this service and its providers.

## User flow

1. Add or expand a workspace in Notion Handoff settings, give it a name, and click **Connect to Notion**.
2. In the browser, choose the workspace and grant access to the relevant pages, including a parent page for new notes.
3. The callback page tries to open Obsidian after a three-second countdown. If the browser blocks it, click **Open Obsidian**. Use the same device and vault that started sign-in.
4. The plugin verifies the token's workspace, saves the connection, and prompts you to **Choose parent page**.

Use a separate profile for each workspace. Existing bound notes and OAuth workspace pins prevent reauthorizing a profile into a different workspace. Names and parent-page settings are preserved; ensure an existing parent page is accessible to the newly authorized integration.

Authorization expires after ten minutes; the completed browser handoff expires after two minutes. Changing profile settings, removing the profile, restarting/unloading the plugin, or starting another connection invalidates the local attempt. Start again if needed. Sign-in can be retried; ambiguous redemption is not automatically replayed.

## Security and data handling

The Worker alone holds the shared Notion client secret and exchanges authorization codes over HTTPS. It makes no note/page requests. Normal sync continues directly between Obsidian and Notion.

The plugin keeps a random verifier in memory and sends only its SHA-256 challenge during initiation. The browser receives a separate random, single-use handoff code, never an access token. Redemption requires both that code and the verifier from the originating plugin instance. This proof binding is for our handoff; it is not a claim that Notion supports native PKCE.

Callback claims and redemption are atomic. Concurrent callbacks cannot exchange the same session twice; concurrent redemptions cannot both retrieve its token. Failed exchanges are not retried automatically. Callback pages send no-store, no-referrer and restrictive content-security headers. Inline scripts use per-response CSP nonces; Tailwind's browser compiler loads from jsDelivr at a pinned version with subresource integrity verification. OAuth query parameters are removed from the address bar before the CDN script loads, and no referrer is sent. The CDN still receives network metadata such as IP addresses. Like any page script, the compiler can read the handoff link; redemption still requires the originating plugin's verifier. No access token is rendered in the page. Include jsDelivr in the service's privacy disclosures.

The Worker temporarily stores an access token, workspace ID and workspace name only until redemption or the handoff deadline. Redemption removes the token immediately; Durable Object alarms clean up expired sessions. Notion owner/email data and refresh tokens are not retained. Refresh-token rotation is not implemented; use **Connect to Notion** again when reauthorization is needed.

The plugin stores access tokens in plain plugin settings, as with manually supplied tokens. Protect your vault and any copies/sync of those settings. Revoke the integration's access in Notion to disconnect it remotely; removing a local profile does not revoke access.

## Verification before rollout

```sh
npm ci
npm test
npx tsc --noEmit
npm run build
npm ci --prefix worker
npm test --prefix worker
```

Worker tests run the real Cloudflare local runtime with mocked Notion token exchange. They cover successful sign-in, proof-bound single-use redemption, concurrency, callback replay, denial, malformed/oversized requests, token-exchange failure, expiration and cleanup. Plugin tests cover matching state, credential persistence, workspace pinning, stale/removed profiles, save failure and unload.

Before a new plugin release, smoke-test real authorization and subsequent Push/Pull on desktop and physical iOS/Android devices. Also verify denial and expiry, same-workspace reconnection, cross-workspace rejection, and a vault with multiple profiles. Local tests do not replace those checks.

Official references: [Notion authorization](https://developers.notion.com/docs/authorization), [token exchange](https://developers.notion.com/reference/create-a-token), [Cloudflare Durable Objects](https://developers.cloudflare.com/durable-objects/), [Worker custom domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/).
