import { describe, expect, it, vi } from 'vitest';
import { EventBuffer } from '../extension/src/event-buffer.js';
import { callChrome } from '../extension/src/chrome-api.js';
import { JsSession } from '../src/mcp/js-session.js';
vi.mock('../src/shared/chrome-reference.json', () => ({ default: { source: 'callback fixture', methods: { 'legacy.perform': { callback: true } } } }));

describe('native capability boundaries', () => {
  it('reports buffer overflow, filtered progress and a new stream generation independently', () => {
    const buffer = new EventBuffer(2);
    const start = buffer.cursor();
    buffer.push({ level: 'info', message: 'a' });
    buffer.push({ level: 'warn', message: 'b' });
    buffer.push({ level: 'error', message: 'c' });
    const first = buffer.read({ cursor: start, limit: 1 });
    expect(first).toMatchObject({ dropped: 1, hasMore: true, reset: false, entries: [{ message: 'b' }] });
    const empty = buffer.read({ cursor: first.cursor, levels: ['debug'] });
    expect(empty).toMatchObject({ dropped: 0, entries: [], hasMore: false });
    expect(buffer.read({ cursor: empty.cursor }).entries).toEqual([]);
    const restarted = new EventBuffer();
    restarted.push({ message: 'after restart' });
    expect(restarted.read({ cursor: empty.cursor })).toMatchObject({ reset: true, dropped: 0, entries: [{ message: 'after restart' }] });
    buffer.push({ message: 'x'.repeat(30_000) });
    expect(buffer.read({ cursor: empty.cursor }).entries[0].truncated).toBe(true);
  });

  it('invokes a callback-shaped native method once with its receiver and preserves native errors', async () => {
    const perform = vi.fn(function(callback) { expect(this).toBe(legacy); callback(); });
    const legacy = { perform };
    vi.stubGlobal('chrome', { legacy, runtime: {} });
    try {
      expect(await callChrome('legacy.perform', [], {}, {})).toBeNull();
      expect(perform).toHaveBeenCalledTimes(1);
      Object.assign(globalThis.chrome.runtime, { lastError: { message: 'native failure' } });
      await expect(callChrome('legacy.perform', [], {}, {})).rejects.toMatchObject({ code: 'chrome_api_error', message: expect.stringContaining('native failure') });
      expect(perform).toHaveBeenCalledTimes(2);
    } finally { vi.unstubAllGlobals(); }
  });

  it('drains late subscription creation before reset cleanup and blocks a new REPL until cleanup finishes', async () => {
    let release, clean;
    let entered;
    const started = new Promise(r => { entered = r; });
    const order = [];
    const repl = new JsSession({ create: async () => { entered(); await new Promise(r => { release = r; }); order.push('created'); } }, async () => {
      order.push('cleanup'); await new Promise(r => { clean = r; });
    });
    try {
      const running = repl.run('await create()'); await started;
      repl.reset(); await running;
      expect(order).toEqual([]);
      expect((await repl.run('1')).error?.code).toBe('js_busy');
      release();
      await vi.waitFor(() => expect(order).toEqual(['created', 'cleanup']));
      expect(repl.status().state).toBe('draining');
      clean();
      await vi.waitFor(() => expect(repl.status().state).toBe('idle'));
      expect((await repl.run('2')).value).toBe(2);
    } finally {
      // Disposal is another reset; allow its independent cleanup to finish.
      const done = repl.dispose(); await Promise.resolve(); clean(); await done;
    }
  });
});
