export const timeline = (ids, nextCursor) => ({ data: { search_by_raw_query: { search_timeline: { timeline: { instructions: [{ type: 'TimelineAddEntries', entries: [
  ...ids.map(id => ({ entryId: `tweet-${id}`, content: { itemContent: { tweet_results: { result: {
    rest_id: id, legacy: { full_text: `post ${id}` }, core: { user_results: { result: { legacy: { screen_name: 'someone' } } } },
  } } } } })),
  ...(nextCursor ? [{ entryId: 'cursor-bottom-1', content: { value: nextCursor } }] : []),
] }] } } } } });

export function searchUrl(query = 'OpenAI', product = 'Latest', cursor) {
  const url = new URL('https://x.com/i/api/graphql/rotating-query-id/SearchTimeline');
  url.searchParams.set('variables', JSON.stringify({ rawQuery: query, product, ...(cursor && { cursor }) }));
  return url.toString();
}
