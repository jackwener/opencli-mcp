import { defineAdapter, errors } from 'opencli-mcp/adapter-sdk';
import { walkTimeline } from './_shared.js';

const restart = () => errors.argument('Search cursor expired or does not match this search', 'Start without cursor. Continue with the same query and sort before navigating, refreshing, or starting another X search.');

function decodeCursor(value, query, sort) {
  if (!value) return null;
  try {
    const c = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (c.v === 1 && c.query === query && c.sort === sort && typeof c.tab === 'string' &&
        Number.isFinite(c.document) && Number.isSafeInteger(c.first) && c.first > 0 &&
        typeof c.request === 'string' && Number.isSafeInteger(c.offset) && c.offset >= 0) return c;
  } catch { /* Invalid or old server cursors must not silently start a new search. */ }
  throw restart();
}

async function documentState(tab, query, sort) {
  const state = await tab.evaluate(() => ({ url: location.href, document: performance.timeOrigin }));
  const url = new URL(state.url);
  const filter = url.searchParams.get('f');
  if (/\/(?:i\/flow\/login|login|account\/access)/.test(url.pathname)) throw errors.auth('X requires sign-in or account verification');
  if (url.hostname !== 'x.com' || url.pathname !== '/search' || url.searchParams.get('q') !== query ||
      (sort === 'latest' ? filter !== 'live' : filter && filter !== 'top')) throw restart();
  return state;
}

function requestPage(entry, query, sort, document) {
  // Adapter network.read may return Performance metadata while CDP is still
  // waiting for a response. Only captured requests can prove search results.
  if (typeof entry.requestId !== 'string' || !Number.isFinite(entry.timestamp) || entry.timestamp < document) return null;
  let url;
  try { url = new URL(entry.url); } catch { return null; }
  if (url.hostname !== 'x.com' || !/^\/i\/api\/graphql\/[^/]+\/SearchTimeline$/.test(url.pathname)) return null;
  let variables;
  try { variables = JSON.parse(url.searchParams.get('variables') || entry.requestBodyPreview || '{}'); }
  catch { throw errors.upstream('X sent an unreadable SearchTimeline request'); }
  if (!variables || typeof variables !== 'object') throw errors.upstream('X sent an unreadable SearchTimeline request');
  variables = variables.variables ?? variables;
  if (variables.rawQuery !== query || variables.product !== (sort === 'latest' ? 'Latest' : 'Top')) return null;
  return { entry, cursor: variables.cursor || null };
}

function readPage(entry, seen) {
  if (entry.responseStatus === 401 || entry.responseStatus === 403) throw errors.auth('X rejected the search request', 'Open X in the connected browser and complete sign-in or account verification.');
  if (entry.responseStatus !== 200) throw errors.upstream(`X search returned HTTP ${entry.responseStatus ?? 'unknown'}`, 'Check the search page in X; retry after any connection or rate-limit problem clears.');
  if (entry.responseBodyTruncated) throw errors.upstream('X search response exceeded the Network capture limit', 'Narrow the search query and start again.');
  let data;
  try { data = JSON.parse(entry.responsePreview); }
  catch { throw errors.upstream('X search response body is unavailable or is not JSON', 'Retry the search; no incomplete results have been treated as an empty page.'); }
  if (Array.isArray(data?.errors) && data.errors.length) {
    if (data.errors.some(e => [32, 89, 215].includes(e.code))) throw errors.auth('X search requires a valid signed-in session');
    throw errors.upstream('X returned GraphQL errors instead of a complete search result', 'Check the search page in X and retry.');
  }
  const instructions = data?.data?.search_by_raw_query?.search_timeline?.timeline?.instructions;
  if (!Array.isArray(instructions)) throw errors.upstream('X changed its search timeline response');
  const page = walkTimeline(instructions, seen);
  if (instructions.some(i => i.type === 'TimelineTerminateTimeline' && i.direction === 'Bottom')) page.nextCursor = null;
  return page;
}

// Reconstruct one cursor chain from retained evidence, not from a new live search.
// Keeping the anchor and row offset in the cursor avoids another adapter cache and
// preserves unreturned rows when limit falls in the middle of an upstream page.
function collect(pages, anchor) {
  const start = anchor ? pages.findIndex(p => p.entry.seq === anchor.first && p.entry.requestId === anchor.request) : pages.findIndex(p => p.cursor === null);
  if (start < 0) {
    if (anchor) throw restart();
    return null;
  }
  const first = pages[start].entry;
  if (pages.slice(start + 1).some(p => p.cursor === null)) throw restart();
  const rows = [];
  const seen = new Set();
  const visited = new Set();
  let cursor = null;
  let index = start;
  while (index >= 0) {
    const page = readPage(pages[index].entry, seen);
    rows.push(...page.tweets);
    visited.add(cursor);
    cursor = page.nextCursor;
    if (!cursor) return { first, rows, complete: true };
    // X can repeat the bottom cursor on its final empty page.
    if (visited.has(cursor)) {
      if (!page.tweets.length) return { first, rows, complete: true };
      throw errors.upstream('X search repeated a pagination cursor without reaching the end');
    }
    index = pages.findIndex((p, i) => i > index && p.cursor === cursor);
  }
  return { first, rows, complete: false };
}

export default defineAdapter({
  description: 'Search X/Twitter through its signed-in web UI. Continue nextCursor before navigating or starting another search. t.co links are expanded (see links).',
  access: 'read',
  domain: 'x.com',
  result: { kind: 'rows', paginated: true, description: 'Tweets in UI order, deduplicated by ID. nextCursor continues this live search from retained Network evidence; it expires on navigation, host restart, or evidence eviction. An empty rows array means a verified empty or exhausted timeline.' },
  args: [
    { name: 'query', type: 'string', required: true, help: 'Search text (X search operators allowed)' },
    { name: 'limit', type: 'int', default: 20, min: 1, max: 100, help: 'Maximum tweets to return in this call (1–100)' },
    { name: 'sort', type: 'string', default: 'top', choices: ['top', 'latest'], help: 'Ranking: top or latest' },
    { name: 'cursor', type: 'string', help: 'Opaque nextCursor from this live search with the same query and sort; omit to start a new search' },
  ],
  async run({ tab, args, signal }) {
    const query = String(args.query || '').trim();
    if (!query) throw errors.argument('`query` is required', 'Give search text, e.g. { query: "anthropic" }');
    const sort = args.sort ?? 'top';
    const limit = args.limit ?? 20;
    if (!['top', 'latest'].includes(sort) || !Number.isInteger(limit) || limit < 1 || limit > 100) throw errors.argument('Use sort top|latest and an integer limit from 1 to 100');
    let cursor = decodeCursor(args.cursor, query, sort);
    signal?.throwIfAborted();
    if (!cursor) {
      await tab.network.start('SearchTimeline');
      const url = new URL('https://x.com/search');
      url.searchParams.set('q', query);
      url.searchParams.set('src', 'typed_query');
      if (sort === 'latest') url.searchParams.set('f', 'live');
      // goto deliberately reuses an already-open URL; a fresh search must reload it.
      if (await tab.url() === url.toString()) await tab.reload();
      else await tab.goto(url.toString(), { waitUntil: 'load', settleMs: 0 });
    }
    const state = await documentState(tab, query, sort);
    if (cursor && (cursor.tab !== tab.id || cursor.document !== state.document)) throw restart();
    const offset = cursor?.offset ?? 0;
    const deadline = Date.now() + 60_000;
    let lastProgress = Date.now();
    let lastCount = -1;
    for (;;) {
      signal?.throwIfAborted();
      if ((await documentState(tab, query, sort)).document !== state.document) throw restart();
      const captured = await tab.network.read({ pattern: 'SearchTimeline', afterSequence: cursor ? cursor.first - 1 : 0, limit: 2000 });
      const pages = captured.entries.map(e => requestPage(e, query, sort, state.document)).filter(Boolean);
      const result = collect(pages, cursor);
      if (result) {
        cursor ??= { v: 1, query, sort, tab: tab.id, document: state.document, first: result.first.seq, request: result.first.requestId, offset: 0 };
        if (offset > result.rows.length) throw restart();
        if (result.rows.length !== lastCount) { lastProgress = Date.now(); lastCount = result.rows.length; }
        const rows = result.rows.slice(offset, offset + limit);
        const nextOffset = offset + rows.length;
        if (rows.length === limit || result.complete || Date.now() >= deadline && rows.length) {
          const more = nextOffset < result.rows.length || !result.complete;
          return { rows, ...(more && { nextCursor: Buffer.from(JSON.stringify({ ...cursor, offset: nextOffset })).toString('base64url') }) };
        }
      }
      if (Date.now() >= deadline || Date.now() - lastProgress >= 15_000) throw errors.upstream('Timed out waiting for the X search page to load more results', 'Check the search page in X and retry with the same cursor, or start a new search without cursor. A timeout does not mean there are no more results.');
      if (result) await tab.act({ action: 'scroll', direction: 'down', amount: 1600, settleMs: 0 });
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  },
});
