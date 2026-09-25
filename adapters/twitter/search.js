import { defineAdapter, errors } from 'opencli-mcp/adapter-sdk';
import { walkTimeline } from './_shared.js';

function requestUrl(entry) {
  try {
    const url = new URL(String(entry.url || entry.name || ''));
    return url.hostname === 'x.com' && /^\/i\/api\/graphql\/[^/]+\/SearchTimeline$/.test(url.pathname) ? url : null;
  } catch { return null; }
}

function pageCursor(url) {
  try { return JSON.parse(url.searchParams.get('variables') || '{}').cursor || null; }
  catch { throw errors.upstream('X sent an unreadable SearchTimeline request'); }
}

function decodeCursor(value, query, sort) {
  if (!value) return { page: null, offset: 0 };
  try {
    const decoded = JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'));
    if (decoded.v === 1 && decoded.query === query && decoded.sort === sort && (decoded.page === null || typeof decoded.page === 'string') && Number.isSafeInteger(decoded.offset) && decoded.offset >= 0) return decoded;
  } catch { /* invalid cursor */ }
  throw errors.argument('Invalid search cursor', 'Pass nextCursor from a previous search with the same query and sort.');
}

function encodeCursor(page, offset, query, sort) {
  return Buffer.from(JSON.stringify({ v: 1, page, offset, query, sort })).toString('base64url');
}

async function nextUiPage(tab, afterSequence, scroll) {
  let after = afterSequence;
  for (let attempt = 0; attempt < 12; attempt++) {
    if (scroll && attempt % 2 === 0) await tab.act({ action: 'scroll', direction: 'down', amount: 1900 });
    const captured = await tab.network.read({ pattern: 'SearchTimeline', afterSequence: after, limit: 1 });
    after = captured.cursor;
    const entry = captured.entries[0];
    const url = entry && requestUrl(entry);
    if (url) {
      if (entry.responseStatus !== 200) throw errors.upstream(`X search UI returned HTTP ${entry.responseStatus ?? 'unknown'}`);
      if (entry.responseBodyTruncated) throw errors.upstream('X search response exceeded the Network capture limit');
      try {
        const data = JSON.parse(String(entry.responsePreview || ''));
        return { after, page: pageCursor(url), data };
      } catch { throw errors.upstream('Could not read the X search response captured from the browser'); }
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return { after, page: null, data: null };
}

export default defineAdapter({
  description: 'Search X/Twitter for tweets through its signed-in web UI. t.co links are expanded (see `links`).',
  access: 'read',
  domain: 'x.com',
  args: [
    { name: 'query', type: 'string', required: true, help: 'Search text (X search operators allowed)' },
    { name: 'limit', type: 'int', default: 20, help: 'How many tweets to return' },
    { name: 'sort', type: 'string', default: 'top', choices: ['top', 'latest'], help: 'Ranking: top or latest' },
    { name: 'cursor', type: 'string', help: 'nextCursor from a previous call with the same query and sort' },
  ],
  async run({ tab, args }) {
    const query = String(args.query || '').trim();
    if (!query) throw errors.argument('`query` is required', 'Give search text, e.g. { query: "anthropic" }');
    const limit = Math.max(1, Number(args.limit) || 20);
    const sort = args.sort === 'latest' ? 'latest' : 'top';
    const target = decodeCursor(args.cursor, query, sort);
    // The web UI is the source of truth: replaying even its exact GraphQL URL
    // returns 404 in Chrome, while the UI request succeeds. Capture its response.
    const before = await tab.network.read({ limit: 2000 }).catch(() => ({ cursor: 0 }));
    await tab.network.start('SearchTimeline');
    const uiUrl = new URL('https://x.com/search');
    uiUrl.searchParams.set('q', query);
    uiUrl.searchParams.set('src', 'typed_query');
    if (sort === 'latest') uiUrl.searchParams.set('f', 'live');
    await tab.goto(uiUrl.toString(), { waitUntil: 'load', settleMs: 3000 });

    const seen = new Set();
    const rows = [];
    let after = before.cursor;
    let foundTarget = false;
    for (let guard = 0; guard < 30; guard++) {
      const captured = await nextUiPage(tab, after, guard > 0);
      after = captured.after;
      if (!captured.data) break;
      const instructions = captured.data?.data?.search_by_raw_query?.search_timeline?.timeline?.instructions;
      if (!Array.isArray(instructions)) throw errors.upstream('X changed its search timeline response');
      const { tweets, nextCursor } = walkTimeline(instructions, seen);
      if (captured.page === target.page) {
        foundTarget = true;
        for (let index = target.offset; index < tweets.length; index++) {
          rows.push(tweets[index]);
          if (rows.length >= limit) {
            const next = index + 1 < tweets.length ? encodeCursor(captured.page, index + 1, query, sort) : nextCursor ? encodeCursor(nextCursor, 0, query, sort) : undefined;
            return { rows, ...(next && { nextCursor: next }) };
          }
        }
        target.page = nextCursor || null;
        target.offset = 0;
      }
      if (!nextCursor) break;
    }
    if (!foundTarget && args.cursor) throw errors.argument('Search cursor no longer matches the current results', 'Start a new search without cursor.');
    if (!rows.length) throw errors.empty(`No tweets found for "${query}"`);
    return { rows };
  },
});
