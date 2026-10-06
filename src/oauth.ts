import { requestUrl } from 'obsidian';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

export const AUTH_ORIGIN = 'https://obsidian-notion-handoff.caj.ms';

export function oauthChallenge(verifier = '') {
  return bytesToHex(sha256(utf8ToBytes(verifier)));
}

export async function oauthRequest(path = '', data = {}) {
  const response = await requestUrl({
    url: `${AUTH_ORIGIN}/notion/${path}`, method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data), throw: false,
  });
  let result;
  try { result = JSON.parse(response.text); }
  catch { throw new Error('Connection service unavailable. Start a new connection.'); }
  if (response.status !== 200) {
    // Service errors are fixed messages; never show token or upstream response bodies.
    const message = typeof result?.error === 'string' && result.error.length < 200 ? result.error : 'Notion connection failed.';
    throw new Error(message);
  }
  return result;
}

export function authorizationUrl(value = '', state = '') {
  const url = new URL(value);
  if (url.origin !== 'https://api.notion.com' || url.pathname !== '/v1/oauth/authorize' ||
    url.username || url.password || url.hash || url.searchParams.get('state') !== state ||
    url.searchParams.get('redirect_uri') !== `${AUTH_ORIGIN}/notion/callback` ||
    url.searchParams.get('response_type') !== 'code' || url.searchParams.get('owner') !== 'user') {
    throw new Error('Connection service returned an invalid authorization URL.');
  }
  return url.href;
}
