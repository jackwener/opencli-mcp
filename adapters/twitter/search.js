import { defineAdapter, errors } from 'opencli-mcp/adapter-sdk';
import { authHeaders, walkTimeline } from './_shared.js';

function searchRequest(entries) {
  for (const entry of [...entries].reverse()) {
    const raw = String(entry.url || entry.name || '');
    try {
      const url = new URL(raw);
      if (url.hostname !== 'x.com' || !/^\/i\/api\/graphql\/[^/]+\/SearchTimeline$/.test(url.pathname)) continue;
      return url;
    } catch { /* ignore incomplete network rows */ }
  }
  return null;
}

export default defineAdapter({
  description: 'Search X/Twitter for tweets. t.co links are expanded (see `links`).',
  access: 'read',
  domain: 'x.com',
  args: [
    { name: 'query', type: 'string', required: true, help: 'Search text (X search operators allowed)' },
    { name: 'limit', type: 'int', default: 20, help: 'How many tweets to return' },
    { name: 'sort', type: 'string', default: 'top', choices: ['top', 'latest'], help: 'Ranking: top or latest' },
    { name: 'cursor', type: 'string', help: 'nextCursor from a previous call, to page further' },
  ],
  async run({ tab, args }) {
    const query = String(args.query || '').trim();
    if (!query) throw errors.argument('`query` is required', 'Give search text, e.g. { query: "anthropic" }');
    const limit = Math.max(1, Number(args.limit) || 20);
    const product = args.sort === 'latest' ? 'Latest' : 'Top';
    // X rotates GraphQL operation IDs and feature flags. The signed-in web UI
    // supplies the current request contract; capture it before replaying pages.
    const before = await tab.network.read({ limit: 2000 }).catch(() => ({ cursor: 0 }));
    await tab.network.start('SearchTimeline');
    const uiUrl = new URL('https://x.com/search');
    uiUrl.searchParams.set('q', query);
    uiUrl.searchParams.set('src', 'typed_query');
    if (product === 'Latest') uiUrl.searchParams.set('f', 'live');
    await tab.goto(uiUrl.toString(), { waitUntil: 'load', settleMs: 2500 });
    let request = null;
    for (let attempt = 0; attempt < 4 && !request; attempt++) {
      const captured = await tab.network.read({ pattern: 'SearchTimeline', afterSequence: before.cursor, limit: 100 });
      request = searchRequest(captured.entries);
      if (!request) await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (!request) throw errors.upstream('Could not observe SearchTimeline from the X web UI; check that search results loaded and the browser extension supports Network capture.');
    const template = JSON.parse(request.searchParams.get('variables') || '{}');
    const headers = await authHeaders(tab);
    const seen = new Set();
    const rows = [];
    let cursor = args.cursor || undefined;
    for (let guard = 0; rows.length < limit && guard < 20; guard++) {
      const variables = { ...template, rawQuery: query, count: Math.min(limit - rows.length + 5, 100), querySource: 'typed_query', product, ...(cursor ? { cursor } : { cursor: undefined }) };
      const pageRequest = new URL(request);
      pageRequest.searchParams.set('variables', JSON.stringify(variables));
      const data = await tab.fetchJson(pageRequest.toString(), { headers });
      const instructions = data?.data?.search_by_raw_query?.search_timeline?.timeline?.instructions || [];
      const { tweets, nextCursor } = walkTimeline(instructions, seen);
      for (const t of tweets) if (rows.length < limit) rows.push(t);
      cursor = nextCursor || undefined;
      if (!tweets.length || !cursor) break;
    }
    if (!rows.length) throw errors.empty(`No tweets found for "${query}"`);
    return { rows, ...(cursor && { nextCursor: cursor }) };
  },
});
