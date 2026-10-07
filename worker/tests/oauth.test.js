import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const origin = 'https://obsidian-notion-handoff.caj.ms';
const workspace = '11111111-1111-1111-1111-111111111111';
const randomHex = () => randomBytes(32).toString('hex');
const challenge = (value) => createHash('sha256').update(value).digest('hex');
const notionResponses = [];
const notionRequests = [];
const source = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
// A test-only subclass exposes storage/alarm checks; never bundled or deployed.
const probe = `export class TestSession extends OAuthSession {
  async fetch(request) {
    if (new URL(request.url).pathname === '/_test/expire') {
      const saved = await this.ctx.storage.get('session');
      await this.ctx.storage.put('session', { ...saved, expires: Date.now() - 1 });
      return new Response('ok');
    }
    if (new URL(request.url).pathname === '/_test/short-expiry') {
      const saved = await this.ctx.storage.get('session');
      const expires = Date.now() + 1000;
      await this.ctx.storage.put('session', { ...saved, expires });
      return Response.json({ expires });
    }
    if (new URL(request.url).pathname === '/_test/storage') {
      return Response.json(await this.ctx.storage.get('session') ?? null);
    }
    if (new URL(request.url).pathname === '/_test/alarm') {
      await this.alarm();
      return Response.json(await this.ctx.storage.get('session') ?? null);
    }
    return super.fetch(request);
  }
}`;
const options = {
  modules: true,
  script: source + '\n' + probe,
  compatibilityDate: '2026-03-01',
  durableObjects: { SESSIONS: { className: 'TestSession', useSQLite: true } },
  ratelimits: { AUTH_RATE_LIMIT: { namespace_id: '1001', simple: { limit: 1000, period: 60 } } },
  bindings: { AUTH_ORIGIN: origin, NOTION_CLIENT_ID: 'test-client', NOTION_CLIENT_SECRET: 'server-secret' },
  outboundService: async (request) => {
    notionRequests.push(request.url);
    assert.equal(request.url, 'https://api.notion.com/v1/oauth/token');
    assert.equal(request.headers.get('Authorization'), `Basic ${Buffer.from('test-client:server-secret').toString('base64')}`);
    const data = await request.json();
    assert.equal(data.grant_type, 'authorization_code');
    assert.equal(data.redirect_uri, `${origin}/notion/callback`);
    const response = notionResponses.shift();
    assert.ok(response, 'Unexpected Notion request (no replay allowed)');
    if (response.respond) return response.respond(request);
    return Response.json(response.token, { status: response.status });
  },
};
const mf = new Miniflare(convertV4MiniflareOptions(options));

before(() => mf.ready);
after(async () => {
  assert.equal(notionResponses.length, 0, 'All expected Notion requests must have been made');
  assert.ok(notionRequests.every((url) => url === 'https://api.notion.com/v1/oauth/token'), 'Token exchange must never follow upstream redirects');
  await mf.dispose();
});

function post(path, data) {
  return mf.dispatchFetch(`${origin}/notion/${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
  });
}

async function start() {
  const state = randomHex();
  const verifier = randomHex();
  const response = await post('start', { state, challenge: challenge(verifier) });
  assert.equal(response.status, 200);
  const data = await response.json();
  const url = new URL(data.authorizeUrl);
  assert.equal(url.origin, 'https://api.notion.com');
  assert.equal(url.searchParams.get('redirect_uri'), `${origin}/notion/callback`);
  assert.equal(url.searchParams.get('state'), state);
  assert.equal(url.searchParams.get('owner'), 'user');
  assert.equal(JSON.stringify(data).includes('server-secret'), false);
  return { state, verifier };
}

function notion(status = 200, token = { access_token: 'ntn_private', token_type: 'bearer', workspace_id: workspace, workspace_name: 'Client', refresh_token: 'nrt_private', owner: { email: 'private@example.com' } }) {
  notionResponses.push({ status, token });
}

async function callback(state, suffix = 'code=test-code') {
  const response = await mf.dispatchFetch(`${origin}/notion/callback?state=${state}&${suffix}`);
  const html = await response.text();
  const href = html.match(/href="([^"]+)"/)?.[1];
  return { response, html, link: href ? new URL(href.replaceAll('&amp;', '&')) : null };
}

test('complete authorization: token never in browser, proof-bound single-use redemption', async () => {
  const { state, verifier } = await start();
  notion();
  const { response, html, link } = await callback(state);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(response.headers.get('Referrer-Policy'), 'no-referrer');
  assert.ok(response.headers.get('Content-Security-Policy').includes("frame-ancestors 'none'"));
  assert.equal(html.includes('ntn_private'), false);
  assert.equal(html.includes('nrt_private'), false);
  assert.equal(html.includes('private@example.com'), false);
  assert.equal(link.protocol, 'obsidian:');
  assert.equal(link.hostname, 'notion-handoff-oauth');
  assert.equal(link.searchParams.get('state'), state);
  const handoff = link.searchParams.get('handoff');
  assert.match(handoff, /^[a-f0-9]{64}$/);
  assert.equal((await post('redeem', { state, verifier: randomHex(), handoff })).status, 410);
  assert.equal((await post('redeem', { state, verifier, handoff: randomHex() })).status, 410);
  const results = await Promise.all([post('redeem', { state, verifier, handoff }), post('redeem', { state, verifier, handoff })]);
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 410]);
  assert.deepEqual(await results.find((result) => result.status === 200).json(), {
    access_token: 'ntn_private', workspace_id: workspace, workspace_name: 'Client',
  });
  assert.equal((await callback(state)).response.status, 410);
  assert.equal((await post('start', { state, challenge: challenge(verifier) })).status, 409);
});

function callbackBrowser(html, link) {
  const navigations = [];
  const historyChanges = [];
  const status = { textContent: html.match(/id="opening-status"[^>]*>([^<]*)</)?.[1] };
  let tick;
  let click;
  let stopped = false;
  const button = { href: link.href, addEventListener: (event, handler) => { assert.equal(event, 'click'); click = handler; } };
  const browser = {
    document: { getElementById: (id) => id === 'open-obsidian' ? button : status },
    history: { replaceState: (...args) => historyChanges.push(args) },
    location: { pathname: '/notion/callback', assign: (href) => navigations.push(href) },
    setInterval: (handler, delay) => { assert.equal(delay, 1000); tick = handler; return 1; },
    clearInterval: (id) => { assert.equal(id, 1); stopped = true; },
  };
  browser.window = browser;
  for (const [, script] of html.matchAll(/<script nonce="[^"]+"[^>]*>([\s\S]*?)<\/script>/g)) {
    // Execute only the served inline scripts; never fetch third-party code in tests.
    runInNewContext(script, browser);
  }
  return { navigations, historyChanges, status, tick: () => { if (!stopped) tick?.(); }, click: () => click?.() };
}

test('callback page pins CDN integrity and limits scripts to fresh CSP nonces', async () => {
  const { state } = await start();
  notion();
  const { response, html } = await callback(state);
  const csp = response.headers.get('Content-Security-Policy');
  const nonce = csp.match(/script-src 'nonce-([a-f0-9]{64})'/)?.[1];
  assert.ok(nonce);
  assert.equal(csp.includes('unsafe-eval'), false);
  assert.equal(csp.includes("script-src 'unsafe-inline'"), false);
  assert.equal([...html.matchAll(/<script nonce="([^"]+)"/g)].length, 3);
  for (const [, value] of html.matchAll(/<script nonce="([^"]+)"/g)) assert.equal(value, nonce);
  assert.ok(html.includes('<title>Obsidian Notion Handoff</title>'));
  assert.ok(html.includes('src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4.3.3/dist/index.global.js" integrity="sha384-2ql948lIdLcGEE0/qxNiudyTjgauA3RDJERu5xW75kFCvSl5a9odyQYCb6tEjnmB" crossorigin="anonymous" referrerpolicy="no-referrer"'));
  assert.ok(html.indexOf('history.replaceState') < html.indexOf('cdn.jsdelivr.net'));
  const next = await start();
  const denied = await callback(next.state, 'error=access_denied');
  assert.notEqual(denied.response.headers.get('Content-Security-Policy'), csp);
});

test('successful callback counts down and tries to open Obsidian once after three seconds', async () => {
  const { state } = await start();
  notion();
  const { html, link } = await callback(state);
  const browser = callbackBrowser(html, link);
  assert.deepEqual(browser.historyChanges, [[null, '', '/notion/callback']]);
  assert.equal(browser.status.textContent, 'Opening Obsidian in 3 seconds…');
  assert.deepEqual(browser.navigations, []);
  browser.tick();
  assert.equal(browser.status.textContent, 'Opening Obsidian in 2 seconds…');
  browser.tick();
  assert.equal(browser.status.textContent, 'Opening Obsidian in 1 second…');
  browser.tick();
  assert.deepEqual(browser.navigations, [link.href]);
  assert.ok(browser.status.textContent.includes('use Open Obsidian below'));
  browser.tick();
  assert.deepEqual(browser.navigations, [link.href]);
});

test('manual Open Obsidian cancels the pending automatic attempt', async () => {
  const { state } = await start();
  notion();
  const { html, link } = await callback(state);
  const browser = callbackBrowser(html, link);
  browser.tick();
  browser.click();
  browser.tick();
  browser.tick();
  assert.deepEqual(browser.navigations, []);
  assert.ok(browser.status.textContent.includes('use Open Obsidian below'));
  assert.equal(link.protocol, 'obsidian:');
});

test('failed and denied callbacks retain a manual return link without automatic navigation', async () => {
  for (const suffix of ['error=access_denied', 'code=']) {
    const { state } = await start();
    const { html, link } = await callback(state, suffix);
    assert.equal(html.includes('id="opening-status"'), false);
    const browser = callbackBrowser(html, link);
    browser.tick();
    assert.deepEqual(browser.navigations, []);
    assert.deepEqual(browser.historyChanges, [[null, '', '/notion/callback']]);
    assert.equal(link.protocol, 'obsidian:');
    assert.ok(link.searchParams.get('error'));
  }
});

test('denial consumes callback without exchanging a code or disclosing upstream error text', async () => {
  const { state } = await start();
  const { html, link } = await callback(state, 'error=access_denied&error_description=%3Cscript%3E');
  assert.equal(link.searchParams.get('error'), 'denied');
  assert.equal(html.includes('<script>'), false);
  assert.equal((await callback(state)).response.status, 410);
});

test('failed token exchange is not replayed and does not expose Notion response', async () => {
  const { state } = await start();
  notion(500, { error: 'server-secret upstream body' });
  const { html, link } = await callback(state);
  assert.equal(link.searchParams.get('error'), 'failed');
  assert.equal(html.includes('server-secret'), false);
  assert.equal((await callback(state)).response.status, 410);
});

test('unknown state and malformed or oversized requests are rejected', async () => {
  assert.equal((await callback(randomHex())).response.status, 410);
  assert.equal((await post('start', { state: '<script>', challenge: randomHex() })).status, 400);
  assert.equal((await post('start', { state: randomHex(), challenge: randomHex(), extra: 'x'.repeat(5000) })).status, 400);
  assert.equal((await post('redeem', { state: randomHex(), verifier: 'invalid', handoff: randomHex() })).status, 400);
  const { state } = await start();
  assert.equal((await callback(state, `state=${state}&code=test`)).response.status, 400);
  assert.equal((await mf.dispatchFetch('https://evil.example/notion/callback?state=' + state)).status, 400);
});

test('handoff expiry blocks redemption and cleanup removes the token', async () => {
  const { state, verifier } = await start();
  notion();
  const { link } = await callback(state);
  const namespace = (await mf.getBindings()).SESSIONS;
  const session = namespace.get(namespace.idFromName(state));
  await session.fetch('https://test/_test/expire');
  assert.equal((await post('redeem', { state, verifier, handoff: link.searchParams.get('handoff') })).status, 410);
  assert.equal(await (await session.fetch('https://test/_test/alarm')).json(), null);
});

test('bad Notion token responses cannot complete authorization', async () => {
  const { state } = await start();
  notion(200, { access_token: 'ntn_private', token_type: 'bearer', workspace_id: 'not-a-workspace' });
  const { html, link } = await callback(state);
  assert.equal(link.searchParams.get('error'), 'failed');
  assert.equal(html.includes('ntn_private'), false);
});

test('service refuses missing credentials and enforces rate limits', async () => {
  const unconfigured = new Miniflare(convertV4MiniflareOptions({ ...options, bindings: { AUTH_ORIGIN: origin } }));
  const limited = new Miniflare(convertV4MiniflareOptions({
    ...options, ratelimits: { AUTH_RATE_LIMIT: { namespace_id: '1002', simple: { limit: 1, period: 60 } } },
  }));
  const request = () => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state: randomHex(), challenge: randomHex() }) });
  try {
    assert.equal((await unconfigured.dispatchFetch(`${origin}/notion/start`, request())).status, 503);
    assert.equal((await limited.dispatchFetch(`${origin}/notion/start`, request())).status, 200);
    assert.equal((await limited.dispatchFetch(`${origin}/notion/start`, request())).status, 429);
  } finally { await Promise.all([unconfigured.dispose(), limited.dispose()]); }
});

test('session expiry rejects callbacks, alarms clear temporary storage', async () => {
  const { state } = await start();
  const namespace = (await mf.getBindings()).SESSIONS;
  const session = namespace.get(namespace.idFromName(state));
  await session.fetch('https://test/_test/expire');
  assert.equal((await callback(state)).response.status, 410);
  const cleared = await session.fetch('https://test/_test/alarm');
  assert.equal(await cleared.json(), null);
});

async function sessionFor(state) {
  const namespace = (await mf.getBindings()).SESSIONS;
  return namespace.get(namespace.idFromName(state));
}

function delayedNotion() {
  const entered = Promise.withResolvers();
  const released = Promise.withResolvers();
  notion();
  const response = notionResponses.pop();
  notionResponses.push({ respond: async () => {
    entered.resolve();
    await released.promise;
    return Response.json(response.token, { status: response.status });
  } });
  return { entered: entered.promise, release: released.resolve };
}

test('concurrent starts cannot replace the winning proof binding', async () => {
  const state = randomHex();
  const challenges = [randomHex(), randomHex()];
  const results = await Promise.all(challenges.map((value) => post('start', { state, challenge: value })));
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
  const session = await sessionFor(state);
  const saved = await (await session.fetch('https://test/_test/storage')).json();
  assert.equal(saved.challenge, challenges[results.findIndex((result) => result.status === 200)]);
});

test('concurrent callbacks exchange once; redemption removes stored token and unnecessary data is never retained', { timeout: 5000 }, async () => {
  const { state, verifier } = await start();
  const requestsBefore = notionRequests.length;
  const delayed = delayedNotion();
  const first = callback(state);
  try {
    await delayed.entered;
    assert.equal((await callback(state)).response.status, 410);
  } finally {
    delayed.release();
  }
  const { response, html, link } = await first;
  assert.equal(response.status, 200);
  assert.equal(notionRequests.length - requestsBefore, 1);
  assert.equal(html.includes('ntn_private'), false);
  const session = await sessionFor(state);
  const saved = await (await session.fetch('https://test/_test/storage')).json();
  assert.equal(saved.phase, 'ready');
  assert.deepEqual(saved.token, { access_token: 'ntn_private', workspace_id: workspace, workspace_name: 'Client' });
  assert.equal(JSON.stringify(saved).includes('nrt_private'), false);
  assert.equal(JSON.stringify(saved).includes('private@example.com'), false);
  assert.equal((await post('redeem', { state, verifier, handoff: link.searchParams.get('handoff') })).status, 200);
  const consumed = await (await session.fetch('https://test/_test/storage')).json();
  assert.deepEqual(consumed, { state, phase: 'consumed', expires: saved.expires });
});

test('duplicate callback codes are rejected without consuming the pending session', async () => {
  const { state } = await start();
  const requestsBefore = notionRequests.length;
  assert.equal((await callback(state, 'code=one&code=two')).response.status, 400);
  assert.equal(notionRequests.length, requestsBefore);
  notion();
  assert.equal((await callback(state)).response.status, 200);
  assert.equal(notionRequests.length - requestsBefore, 1);
});

test('network failure consumes callback without exposing upstream messages or allowing replay', async () => {
  const { state } = await start();
  const requestsBefore = notionRequests.length;
  notionResponses.push({ respond: () => { throw new Error('server-secret sensitive-upstream-message'); } });
  const { html, link } = await callback(state);
  assert.equal(link.searchParams.get('error'), 'failed');
  assert.equal(html.includes('server-secret'), false);
  assert.equal(html.includes('sensitive-upstream-message'), false);
  assert.equal((await callback(state)).response.status, 410);
  assert.equal(notionRequests.length - requestsBefore, 1);
});

test('upstream redirects are not followed and cannot complete authorization', async () => {
  const { state } = await start();
  const requestsBefore = notionRequests.length;
  notionResponses.push({ respond: () => new Response(null, {
    status: 302, headers: { Location: 'https://attacker.invalid/token' },
  }) });
  const { link } = await callback(state);
  assert.equal(link.searchParams.get('error'), 'failed');
  assert.equal((await callback(state)).response.status, 410);
  assert.equal(notionRequests.length - requestsBefore, 1);
});

test('expiration during token exchange cannot retain or deliver the token', { timeout: 5000 }, async () => {
  const { state } = await start();
  const session = await sessionFor(state);
  const { expires } = await (await session.fetch('https://test/_test/short-expiry')).json();
  const delayed = delayedNotion();
  const pending = callback(state);
  try {
    await delayed.entered;
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, expires - Date.now()) + 25));
  } finally {
    delayed.release();
  }
  const { html, link } = await pending;
  assert.equal(link.searchParams.get('error'), 'failed');
  assert.equal(html.includes('ntn_private'), false);
  const saved = await (await session.fetch('https://test/_test/storage')).json();
  assert.equal(saved.phase, 'failed');
  assert.equal(JSON.stringify(saved).includes('ntn_private'), false);
  assert.equal((await session.fetch('https://test/_test/alarm')).status, 200);
  assert.equal(await (await session.fetch('https://test/_test/storage')).json(), null);
});
