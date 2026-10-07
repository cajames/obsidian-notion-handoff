const SESSION_MS = 10 * 60 * 1000;
const HANDOFF_MS = 2 * 60 * 1000;
const HEX = /^[a-f0-9]{64}$/;

const headers = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Strict-Transport-Security': 'max-age=31536000',
};

function json(data, status = 200) {
  return Response.json(data, { status, headers });
}

function page(state, handoff = '', error = '') {
  const link = new URL('obsidian://notion-handoff-oauth');
  link.searchParams.set('state', state);
  if (handoff) link.searchParams.set('handoff', handoff);
  if (error) link.searchParams.set('error', error);
  const nonce = randomHex();
  const csp = `${headers['Content-Security-Policy']}; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src 'self'`;
  // Only locally generated hex values and fixed error strings enter this page.
  const message = error ? 'Return to Obsidian and start a new connection.' :
    'Notion has authorized access. Return to Obsidian to save your connection.';
  return new Response(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Obsidian Notion Handoff</title>
  <link rel="icon" href="/logo.webp" type="image/webp">
  <script nonce="${nonce}">history.replaceState(null, '', location.pathname);</script>
  <script nonce="${nonce}" src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4.3.3/dist/index.global.js" integrity="sha384-2ql948lIdLcGEE0/qxNiudyTjgauA3RDJERu5xW75kFCvSl5a9odyQYCb6tEjnmB" crossorigin="anonymous" referrerpolicy="no-referrer" defer></script>
  <style>body{margin:0;font-family:ui-sans-serif,system-ui,sans-serif;background:#f7f7f5;color:#37352f}main{max-width:30rem;margin:auto}</style>
</head>
<body class="flex min-h-screen items-center justify-center px-5 py-12 antialiased">
  <main class="w-full">
    <section aria-labelledby="page-title" class="rounded-xl border border-stone-200 bg-white p-7 shadow-sm sm:p-10">
      <img src="/logo.webp" alt="Obsidian Notion Handoff logo" width="192" height="199" class="mb-8 h-auto w-20">
      <p class="mb-3 text-xs font-medium tracking-wide text-stone-500">${error ? 'Connection not completed' : 'Authorization complete'}</p>
      <h1 id="page-title" class="text-3xl font-semibold tracking-tight text-stone-800">Obsidian Notion Handoff</h1>
      <p class="mt-4 text-sm leading-6 text-stone-600">${message}</p>
      ${error ? '' : '<p id="opening-status" role="status" aria-live="polite" class="mt-6 text-sm text-stone-500">Opening Obsidian in 3 seconds…</p>'}
      <a id="open-obsidian" href="${link.href.replaceAll('&', '&amp;')}" class="mt-6 flex w-full items-center justify-center gap-2 rounded-md bg-stone-800 px-4 py-3 text-sm font-medium text-white no-underline transition-colors hover:bg-stone-700 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-stone-800 motion-reduce:transition-none">
        Open Obsidian
        <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17 17 7M7 7h10v10"/></svg>
      </a>
      <div class="mt-8 border-t border-stone-100 pt-5 text-xs leading-5 text-stone-500">
        <p>Use the same device and vault where you started connecting.</p>
        ${error ? '' : '<p class="mt-2">Open within two minutes. If your browser asks, allow it to open Obsidian.</p>'}
      </div>
    </section>
    <p class="mt-5 text-center text-xs leading-5 text-stone-500">${error ? 'You can close this tab and try again in Obsidian.' : 'You can close this tab after saving your connection in Obsidian.'}</p>
  </main>
  ${error ? '' : `<script nonce="${nonce}">
    const button = document.getElementById('open-obsidian');
    const status = document.getElementById('opening-status');
    let seconds = 3;
    const finish = () => {
      clearInterval(timer);
      status.textContent = 'If Obsidian didn’t open, use Open Obsidian below.';
    };
    const timer = setInterval(() => {
      seconds -= 1;
      if (seconds > 0) {
        status.textContent = 'Opening Obsidian in ' + seconds + (seconds === 1 ? ' second…' : ' seconds…');
        return;
      }
      finish();
      window.location.assign(button.href);
    }, 1000);
    button.addEventListener('click', finish);
  </script>`}
</body>
</html>`, {
    headers: { ...headers, 'Content-Security-Policy': csp, 'Content-Type': 'text/html; charset=utf-8' },
  });
}

function randomHex() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function challengeFor(verifier) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function body(request) {
  if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return null;
  // Bound actual bytes, not just a caller-supplied Content-Length.
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 4096) { await reader.cancel(); return null; }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    const data = JSON.parse(new TextDecoder().decode(bytes));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
  } catch { return null; }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.origin !== env.AUTH_ORIGIN) return json({ error: 'Unknown host.' }, 400);
    if ((request.method === 'GET' || request.method === 'HEAD') && ['/logo.png', '/logo.webp'].includes(url.pathname)) {
      return env.ASSETS.fetch(request);
    }
    const start = url.pathname === '/notion/start' && request.method === 'POST';
    const redeem = url.pathname === '/notion/redeem' && request.method === 'POST';
    const callback = url.pathname === '/notion/callback' && request.method === 'GET';
    if (!start && !redeem && !callback) return json({ error: 'Not found.' }, 404);
    if (!env.NOTION_CLIENT_ID || !env.NOTION_CLIENT_SECRET) return json({ error: 'Notion sign-in is not configured yet.' }, 503);
    try {
      const limit = await env.AUTH_RATE_LIMIT.limit({ key: request.headers.get('CF-Connecting-IP') ?? 'unknown' });
      if (!limit.success) return json({ error: 'Too many attempts. Try again in a minute.' }, 429);
      const data = callback ? null : await body(request);
      const state = callback ? url.searchParams.get('state') : data?.state;
      if (typeof state !== 'string' || !HEX.test(state)) return json({ error: 'Invalid authorization state.' }, 400);
      if (callback && (url.searchParams.getAll('state').length !== 1 || url.searchParams.getAll('code').length > 1 || url.searchParams.getAll('error').length > 1)) {
        return json({ error: 'Invalid callback.' }, 400);
      }
      if (start && (typeof data.challenge !== 'string' || !HEX.test(data.challenge))) return json({ error: 'Invalid challenge.' }, 400);
      if (redeem && (typeof data.handoff !== 'string' || !HEX.test(data.handoff) || typeof data.verifier !== 'string' || !HEX.test(data.verifier))) {
        return json({ error: 'Invalid handoff.' }, 400);
      }
      const session = env.SESSIONS.get(env.SESSIONS.idFromName(state));
      const forwarded = callback ? request : new Request(request.url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
      });
      return await session.fetch(forwarded);
    } catch {
      // Never expose or log Notion responses, authorization codes, or tokens.
      return json({ error: 'Connection service unavailable. Start a new connection.' }, 503);
    }
  },
};

export class OAuthSession {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/notion/start') return this.start(await body(request));
    if (url.pathname === '/notion/callback') return this.callback(url);
    if (url.pathname === '/notion/redeem') return this.redeem(await body(request));
    return json({ error: 'Not found.' }, 404);
  }

  async start(data) {
    const session = { state: data.state, challenge: data.challenge, phase: 'pending', expires: Date.now() + SESSION_MS };
    const created = await this.ctx.storage.transaction(async (storage) => {
      if (await storage.get('session')) return false;
      await storage.put('session', session);
      await storage.setAlarm(session.expires);
      return true;
    });
    if (!created) return json({ error: 'Connection already started. Start a new connection.' }, 409);
    const authorize = new URL('https://api.notion.com/v1/oauth/authorize');
    authorize.search = new URLSearchParams({
      client_id: this.env.NOTION_CLIENT_ID, response_type: 'code', owner: 'user',
      redirect_uri: `${this.env.AUTH_ORIGIN}/notion/callback`, state: session.state,
    }).toString();
    return json({ authorizeUrl: authorize.href });
  }

  async callback(url) {
    // Claim the callback atomically before exchanging its one-use Notion code.
    const session = await this.ctx.storage.transaction(async (storage) => {
      const saved = await storage.get('session');
      if (!saved || saved.phase !== 'pending' || saved.expires <= Date.now()) return null;
      await storage.put('session', { ...saved, phase: 'exchanging' });
      return saved;
    });
    if (!session) return json({ error: 'Connection expired or already used. Start again in Obsidian.' }, 410);
    const code = url.searchParams.get('code');
    if (url.searchParams.has('error') || !code || code.length > 2048) {
      await this.fail(session);
      return page(session.state, '', url.searchParams.has('error') ? 'denied' : 'failed');
    }
    try {
      const response = await fetch('https://api.notion.com/v1/oauth/token', {
        method: 'POST',
        headers: {
          Authorization: `Basic ${btoa(`${this.env.NOTION_CLIENT_ID}:${this.env.NOTION_CLIENT_SECRET}`)}`,
          'Content-Type': 'application/json', 'Notion-Version': '2026-03-11',
        },
        body: JSON.stringify({ grant_type: 'authorization_code', code, redirect_uri: `${this.env.AUTH_ORIGIN}/notion/callback` }),
        signal: AbortSignal.timeout(30000),
        redirect: 'manual',
      });
      const token = response.ok ? await response.json() : null;
      if (!token || typeof token.access_token !== 'string' || !token.access_token.trim() ||
        typeof token.workspace_id !== 'string' || !/^(?:[a-f0-9]{32}|[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12})$/i.test(token.workspace_id) ||
        token.token_type !== 'bearer' || session.expires <= Date.now()) throw new Error('Invalid token response.');
      const handoff = randomHex();
      const expires = Math.min(session.expires, Date.now() + HANDOFF_MS);
      // No owner/email or refresh token retained. Normal sync talks directly to Notion.
      const ready = await this.ctx.storage.transaction(async (storage) => {
        const saved = await storage.get('session');
        if (!saved || saved.phase !== 'exchanging' || expires <= Date.now()) return false;
        await storage.put('session', {
          ...session, phase: 'ready', handoff, expires,
          token: { access_token: token.access_token, workspace_id: token.workspace_id, workspace_name: typeof token.workspace_name === 'string' ? token.workspace_name : '' },
        });
        await storage.setAlarm(expires);
        return true;
      });
      if (!ready) throw new Error('Session expired.');
      return page(session.state, handoff);
    } catch {
      await this.fail(session);
      return page(session.state, '', 'failed');
    }
  }

  async fail(session) {
    await this.ctx.storage.transaction(async (storage) => {
      const saved = await storage.get('session');
      if (saved?.phase === 'exchanging') await storage.put('session', { ...session, phase: 'failed' });
    });
  }

  async redeem(data) {
    const challenge = await challengeFor(data.verifier);
    const token = await this.ctx.storage.transaction(async (storage) => {
      const session = await storage.get('session');
      if (!session || session.phase !== 'ready' || session.expires <= Date.now() ||
        session.challenge !== challenge || session.handoff !== data.handoff) return null;
      // Concurrent requests cannot both retrieve the token. Keep a tombstone until expiry.
      await storage.put('session', { state: session.state, phase: 'consumed', expires: session.expires });
      return session.token;
    });
    return token ? json(token) : json({ error: 'Handoff expired or invalid. Start a new connection.' }, 410);
  }

  async alarm() {
    await this.ctx.storage.deleteAll();
  }
}
