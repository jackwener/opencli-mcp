import { afterEach, describe, expect, it, vi } from 'vitest';
import search from '../adapters/twitter/search.js';
import { timeline, searchUrl } from './fixtures/twitter-search.mjs';

const args = { query: 'OpenAI', sort: 'latest', limit: 1 };
function fixture() {
  let seq = 0;
  const entries = [];
  const state = { url: 'https://x.com/search?q=OpenAI&src=typed_query&f=live', document: 100 };
  const add = (ids, next, cursor, extra = {}) => {
    const entry = { seq: ++seq, requestId: `request-${seq}`, timestamp: 101, url: searchUrl('OpenAI', 'Latest', cursor), responseStatus: 200, responseBodyTruncated: false, responsePreview: JSON.stringify(timeline(ids, next)), ...extra };
    entries.push(entry);
    return entry;
  };
  const tab = {
    id: '1',
    evaluate: vi.fn(async () => ({ ...state })),
    url: vi.fn(async () => 'https://x.com/home'),
    reload: vi.fn(async () => {}),
    goto: vi.fn(async () => {}),
    act: vi.fn(async () => {}),
    network: { start: vi.fn(async () => true), read: vi.fn(async () => ({ entries: [...entries], cursor: seq, hasMore: false })) },
  };
  return { tab, entries, state, add, run: (overrides = {}, signal) => search.run({ tab, args: { ...args, ...overrides }, signal }) };
}
afterEach(() => vi.useRealTimers());

describe('X search from UI Network evidence', () => {
  it('keeps page remainders, deduplicates across pages and retries a cursor without searching again', async () => {
    const f = fixture();
    f.add(['performance'], null, null, { requestId: undefined, timestamp: undefined, responseStatus: undefined });
    f.add(['stale'], null, null, { timestamp: 99 });
    f.add(['other'], null, null, { url: searchUrl('other') });
    f.add(['top'], null, null, { url: searchUrl('OpenAI', 'Top') });
    f.add(['1', '2'], 'next');
    const first = await f.run();
    expect(first.rows.map(t => t.id)).toEqual(['1']);
    const second = await f.run({ cursor: first.nextCursor });
    expect(second.rows.map(t => t.id)).toEqual(['2']);
    expect(await f.run({ cursor: first.nextCursor })).toEqual(second);
    f.add(['2', '3'], null, 'next');
    const third = await f.run({ cursor: second.nextCursor });
    expect(third.rows.map(t => t.id)).toEqual(['3']);
    expect(third.nextCursor).toBeUndefined();
    expect(f.tab.goto).toHaveBeenCalledTimes(1);
    expect(f.tab.network.start).toHaveBeenCalledTimes(1);
  });

  it('rejects mismatched, refreshed, closed or evicted cursors rather than replaying a changing search', async () => {
    const f = fixture(); f.add(['1', '2']);
    const { nextCursor: cursor } = await f.run();
    for (const overrides of [{ query: 'other' }, { sort: 'top' }, { cursor: 'old-server-cursor' }]) {
      await expect(f.run({ cursor, ...overrides })).rejects.toMatchObject({ code: 'invalid_args' });
    }
    f.state.document++;
    await expect(f.run({ cursor })).rejects.toMatchObject({ code: 'invalid_args' });
    f.state.document--; f.tab.id = '2';
    await expect(f.run({ cursor })).rejects.toMatchObject({ code: 'invalid_args' });
    f.tab.id = '1'; f.add(['new-search']);
    await expect(f.run({ cursor })).rejects.toMatchObject({ code: 'invalid_args' });
    f.entries.length = 0;
    await expect(f.run({ cursor })).rejects.toMatchObject({ code: 'invalid_args' });
    expect(f.tab.goto).toHaveBeenCalledTimes(1);
  });

  it('distinguishes empty timelines from authentication, HTTP, capture and schema failures', async () => {
    const f = fixture(); const entry = f.add([]);
    expect(await f.run()).toEqual({ rows: [] });
    const good = { ...entry };
    for (const [patch, code] of [
      [{ responseStatus: 401 }, 'auth_required'],
      [{ responseStatus: 429 }, 'upstream_error'],
      [{ responseBodyTruncated: true }, 'upstream_error'],
      [{ responsePreview: undefined }, 'upstream_error'],
      [{ responsePreview: '{}' }, 'upstream_error'],
      [{ responsePreview: 'null' }, 'upstream_error'],
      [{ responsePreview: JSON.stringify({ errors: [{ code: 89 }] }) }, 'auth_required'],
    ]) {
      Object.assign(entry, good, patch);
      await expect(f.run()).rejects.toMatchObject({ code });
    }
    f.state.url = 'https://x.com/i/flow/login';
    await expect(f.run()).rejects.toMatchObject({ code: 'auth_required' });
  });

  it('waits for scroll-triggered responses and never turns a timeout or cancellation into end-of-results', async () => {
    vi.useFakeTimers();
    const f = fixture(); f.add(['1'], 'next');
    f.tab.act.mockImplementationOnce(async () => { f.add(['2'], null, 'next'); });
    const result = f.run({ limit: 2 });
    await vi.runAllTimersAsync();
    expect((await result).rows.map(t => t.id)).toEqual(['1', '2']);
    expect(f.tab.act).toHaveBeenCalled();
    const stalled = fixture(); stalled.add(['1'], 'next');
    const pending = expect(stalled.run({ limit: 2 })).rejects.toMatchObject({ code: 'upstream_error', message: expect.stringContaining('Timed out') });
    await vi.runAllTimersAsync(); await pending;
    const aborted = fixture(); const controller = new AbortController();
    const cancelled = expect(aborted.run({}, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(500); controller.abort();
    await vi.runAllTimersAsync(); await cancelled;
  });
});
