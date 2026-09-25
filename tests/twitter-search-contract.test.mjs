import { describe, expect, it, vi } from 'vitest';
import search from '../adapters/twitter/search.js';

describe('X search request contract', () => {
  it('uses the current UI operation and features for API pagination', async () => {
    const request = new URL('https://x.com/i/api/graphql/current-id/SearchTimeline');
    request.searchParams.set('variables', JSON.stringify({ count: 20, customFlag: true, cursor: 'old' }));
    request.searchParams.set('features', JSON.stringify({ liveFeature: true }));
    request.searchParams.set('fieldToggles', JSON.stringify({ withArticleRichContentState: true }));
    const tab = {
      network: {
        start: vi.fn(async () => true),
        read: vi.fn().mockResolvedValueOnce({ cursor: 8, entries: [] }).mockResolvedValueOnce({ entries: [{ url: request.toString() }] }),
      },
      goto: vi.fn(async () => {}),
      cookie: vi.fn(async () => 'csrf'),
      fetchJson: vi.fn(async () => ({ data: { search_by_raw_query: { search_timeline: { timeline: { instructions: [{ entries: [{ entryId: 'tweet-1', content: { itemContent: { tweet_results: { result: { rest_id: '1', legacy: { full_text: 'hello' }, core: { user_results: { result: { legacy: { screen_name: 'someone' } } } } } } } } }] }] } } } } })),
    };
    const result = await search.run({ tab, args: { query: 'OpenAI', limit: 1, sort: 'latest' } });
    expect(result.rows).toHaveLength(1);
    expect(tab.goto).toHaveBeenCalledWith(expect.stringContaining('f=live'), expect.anything());
    const api = new URL(tab.fetchJson.mock.calls[0][0], 'https://x.com');
    expect(api.pathname).toContain('/current-id/SearchTimeline');
    expect(JSON.parse(api.searchParams.get('features'))).toEqual({ liveFeature: true });
    expect(JSON.parse(api.searchParams.get('fieldToggles'))).toEqual({ withArticleRichContentState: true });
    expect(JSON.parse(api.searchParams.get('variables'))).toMatchObject({ rawQuery: 'OpenAI', customFlag: true, product: 'Latest' });
    expect(api.searchParams.get('variables')).not.toContain('old');
  });
});
