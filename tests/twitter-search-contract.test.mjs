import { describe, expect, it, vi } from 'vitest';
import search from '../adapters/twitter/search.js';

const tweet = (id) => ({ entryId: `tweet-${id}`, content: { itemContent: { tweet_results: { result: { rest_id: id, legacy: { full_text: `post ${id}` }, core: { user_results: { result: { legacy: { screen_name: 'someone' } } } } } } } } });
const response = (ids, nextCursor) => JSON.stringify({ data: { search_by_raw_query: { search_timeline: { timeline: { instructions: [{ entries: [
  ...ids.map(tweet),
  ...(nextCursor ? [{ entryId: 'cursor-bottom-1', content: { value: nextCursor } }] : []),
] }] } } } } });
const entry = (body, cursor) => {
  const url = new URL('https://x.com/i/api/graphql/current-id/SearchTimeline');
  url.searchParams.set('variables', JSON.stringify({ rawQuery: 'OpenAI', product: 'Latest', ...(cursor && { cursor }) }));
  return { url: url.toString(), responseStatus: 200, responsePreview: body, responseBodyTruncated: false };
};
const tabWith = (...pages) => {
  const read = vi.fn().mockResolvedValueOnce({ cursor: 0, entries: [] });
  pages.forEach((page, i) => read.mockResolvedValueOnce({ cursor: i + 1, entries: [page] }));
  return { network: { start: vi.fn(async () => true), read }, goto: vi.fn(async () => {}), act: vi.fn(async () => {}) };
};

describe('X search uses the browser UI response', () => {
  it('returns every result across calls without replaying the GraphQL endpoint', async () => {
    const firstTab = tabWith(entry(response(['1', '2'], 'next-page')));
    const first = await search.run({ tab: firstTab, args: { query: 'OpenAI', limit: 1, sort: 'latest' } });
    expect(first.rows.map((row) => row.id)).toEqual(['1']);
    expect(first.nextCursor).toBeTruthy();
    expect(firstTab.goto).toHaveBeenCalledWith(expect.stringContaining('f=live'), expect.anything());

    const secondTab = tabWith(entry(response(['1', '2'], 'next-page')));
    const second = await search.run({ tab: secondTab, args: { query: 'OpenAI', limit: 1, sort: 'latest', cursor: first.nextCursor } });
    expect(second.rows.map((row) => row.id)).toEqual(['2']);
    expect(second.nextCursor).toBeTruthy();
    await expect(search.run({ tab: secondTab, args: { query: 'other', limit: 1, sort: 'latest', cursor: first.nextCursor } })).rejects.toMatchObject({ code: 'invalid_args' });
  });

  it('scrolls to the next UI page when the current page is exhausted', async () => {
    const tab = tabWith(entry(response(['1'], 'next-page')), entry(response(['2']), 'next-page'));
    const result = await search.run({ tab, args: { query: 'OpenAI', limit: 2, sort: 'latest' } });
    expect(result.rows.map((row) => row.id)).toEqual(['1', '2']);
    expect(tab.act).toHaveBeenCalledWith({ action: 'scroll', direction: 'down', amount: 1900 });
  });
});
