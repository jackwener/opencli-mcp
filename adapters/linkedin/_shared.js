import { errors } from 'opencli-mcp/adapter-sdk';

export const ORIGIN = 'https://www.linkedin.com';
export const compact = (value) => String(value ?? '').replace(/[\u00a0\u202f\s]+/g, ' ').trim();

export function integer(value, label, fallback, min, max) {
  const number = value === undefined || value === null || value === '' ? fallback : Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw errors.argument(`${label} must be an integer between ${min} and ${max}`);
  }
  return number;
}

export async function ensureLinkedIn(tab) {
  await tab.url().catch(() => null);
  await tab.goto(`${ORIGIN}/feed/`, { waitUntil: 'load' });
}

export async function csrf(tab) {
  const cookie = (await tab.cookie('JSESSIONID', { domain: 'linkedin.com' }))
    || (await tab.cookie('JSESSIONID', { domain: '.linkedin.com' }));
  if (!cookie) throw errors.auth('LinkedIn session is missing JSESSIONID', 'Open linkedin.com and sign in, then retry.');
  return cookie.replace(/^"|"$/g, '');
}

export async function linkedinApi(tab, path, { headers = {}, ...opts } = {}) {
  if (!path.startsWith('/') || path.startsWith('//')) throw errors.argument('LinkedIn API path must be relative to linkedin.com');
  const token = await csrf(tab);
  const request = {
    ...opts,
    headers: {
      'csrf-token': token,
      'x-restli-protocol-version': '2.0.0',
      accept: 'application/json',
      ...headers,
    },
  };
  try {
    return await tab.fetchJson(`${ORIGIN}${path}`, request);
  } catch (cause) {
    const message = String(cause?.message ?? cause);
    if (/HTTP (401|403)\b/.test(message)) throw errors.auth('LinkedIn API rejected this session', 'Sign in to LinkedIn and check that this account has access to the feature.');
    throw errors.upstream(`LinkedIn API request failed: ${message}`);
  }
}

export function requireElements(json, operation) {
  if (!json || !Array.isArray(json.elements)) throw errors.upstream(`${operation} returned no elements array`);
  return json.elements;
}
