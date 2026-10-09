import { afterEach, describe, expect, it } from 'vitest';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { JsSession } from '../src/mcp/js-session.js';
import { createMcpServer } from '../src/mcp/server.js';
import { Runtime } from '../src/runtime/runtime.js';
import type { RuntimePage } from '../src/backends/page-types.js';

const sessions: JsSession[] = [];
const repl = (globals = {}) => { const s = new JsSession(globals); sessions.push(s); return s; };
afterEach(async () => { await Promise.all(sessions.splice(0).map(s => s.dispose())); });

describe('persistent Node REPL', () => {
  it('keeps bindings across calls and remains usable after an exception', async () => {
    const s = repl();
    expect((await s.run('let n = await Promise.resolve(3); function add(x) { return n + x }; add(2)')).value).toBe(5);
    expect((await s.run('throw new Error("stop")')).error?.message).toBe('stop');
    expect((await s.run('n += 2; add(1)')).value).toBe(6);
  });

  it('serializes calls and interrupts an infinite loop without blocking the host', async () => {
    const s = repl();
    const first = s.run('let value = await new Promise(r => setTimeout(() => r(1), 30)); value');
    const second = s.run('value += 1; value');
    expect((await first).value).toBe(1);
    expect((await second).value).toBe(2);
    expect((await s.run('while (true) {}', { timeoutMs: 80 })).error).toMatchObject({ code: 'js_timeout', data: { bindingsCleared: true } });
    expect((await s.run('typeof value')).value).toBe('undefined');
    const controller = new AbortController();
    const cancelled = s.run('while (true) {}', { signal: controller.signal });
    setTimeout(() => controller.abort(), 80);
    expect((await cancelled).error?.code).toBe('js_cancelled');
  });

  it('stops later API effects on reset and reports a dispatched operation until it settles', async () => {
    let release!: () => void;
    let started!: () => void;
    let effects = 0;
    const entered = new Promise<void>(r => { started = r; });
    const pending = new Promise<void>(r => { release = r; });
    const s = repl({ browser: { slow: async () => { started(); await pending; effects++; }, later: async () => { effects++; } } });
    const active = s.run('await browser.slow(); await browser.later()');
    await entered;
    const queued = s.run('await browser.later()');
    expect(s.reset()).toEqual({ reset: true, pendingCalls: 1 });
    expect((await active).error?.code).toBe('js_reset');
    expect((await queued).error?.code).toBe('js_reset');
    expect((await s.run('1')).error?.code).toBe('js_busy');
    release();
    await new Promise(r => setTimeout(r, 30));
    expect(s.status()).toMatchObject({ state: 'idle', pendingCalls: 0 });
    expect(effects).toBe(1);
    expect((await s.run('1')).value).toBe(1);
  });

});

it('runs discovery → observe → act → verify → cleanup through MCP and the REPL worker', async () => {
  const rt = new Runtime();
  let clicked = false;
  let finalized = false;
  const page = {
    getActivePage: () => 'page-one',
    newTab: async () => 'page-one', getCurrentUrl: async () => 'https://example.com/', evaluate: async () => 'Example',
    screenshot: async () => 'aW1hZ2U=',
    tabs: async () => [{ page: 'page-one', tabId: 1, state: 'active' }],
    pageCall: async (method: string) => method === 'observeFrame' ? { state: clicked ? '- heading "Done"' : '- button "Continue" [ref=e1]', children: [] } : null,
    act: async () => { clicked = true; return { ok: true, kind: 'click', matches_n: 1, method: 'cdp', ref: 'e1' }; },
    expect: async () => ({ ok: clicked, failed: clicked ? [] : ['not clicked'] }),
    finalize: async () => { finalized = true; return { closed: ['page-one'], kept: [], failed: [] }; },
  } as unknown as RuntimePage;
  rt.backend = () => 'extension';
  rt.getBrowserPage = async () => page;
  rt.pageFor = async () => page;
  rt.isExtensionPage = (() => true) as unknown as typeof rt.isExtensionPage;
  const session = createMcpServer(rt, 'repl-e2e');
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'repl-e2e', version: '1' }, { capabilities: {} });
  await session.server.connect(serverTransport);
  await client.connect(clientTransport);
  const call = async (name: string, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const text = (r.content as Array<{ type: string; text?: string }>).find(c => c.type === 'text')!.text!;
    return { result: r, text, body: (() => { try { return JSON.parse(text); } catch { return null; } })() };
  };
  try {
    expect((await client.listTools()).tools.map(t => t.name).sort()).toEqual(['docs_get', 'doctor', 'js', 'js_reset', 'session_finalize', 'site_run', 'sites_search']);
    expect((await call('docs_get', { name: 'api-reference', member: 'Tab.act' })).text).toContain('ActionOutcome');
    const opened = await call('js', { code: 'let tab = await browser.tabs.new("https://example.com/"); tab' });
    expect(opened.body, opened.text).toEqual({ ok: true, value: { type: 'Tab', id: 'page-one' } });
    expect((await call('js', { code: 'typeof tab' })).body.value).toBe('object');
    expect((await call('js', { code: 'await tab.observe()' })).body.value.state).toContain('[ref=e1]');
    const invalid = await call('js', { code: 'await tab.act({action:"press", target:{ref:"e1"}})' });
    expect(invalid.body.error.code).toBe('invalid_args');
    expect(clicked).toBe(false);
    const acted = await call('js', { code: 'tab.act({action:"click", target:{ref:"e1"}}); "dispatched"' });
    expect(acted.body.value).toBe('dispatched');
    expect(clicked).toBe(true);
    expect((await call('js', { code: 'await tab.expect({text:"Done"})' })).body.value.ok).toBe(true);
    const observed = await call('js', { code: 'await tab.observe({mode:"both"})' });
    expect(observed.result.content).toContainEqual({ type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' });
    expect(observed.body.value.image).toEqual({ image: 'image/png' });
    await call('session_finalize');
    expect(finalized).toBe(true);
  } finally { await client.close(); await session.close(); await rt.shutdown(); }
});
