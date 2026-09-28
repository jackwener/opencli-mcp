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
  it('keeps declarations and handles real JavaScript syntax and exceptions across calls', async () => {
    const s = repl();
    expect((await s.run('let {n} = await Promise.resolve({n: 3}); function add(x) { return n + x }; class Item { value = add(2) }; /[;{}]/.test("{")')).value).toBe(true);
    expect((await s.run('new Item().value')).value).toBe(5);
    expect((await s.run('const fixed = 4; fixed = 7')).error?.message).toMatch(/constant/);
    expect((await s.run('nodeRepl.write("before"); throw new Error("stop")')).writes).toEqual(['before']);
    expect((await s.run('n += 2; add(1)')).value).toBe(6);
    expect((await s.run('let n = 9')).error?.message).toMatch(/already been declared/);
    expect((await s.run('function unfinished(')).error).toBeDefined();
    expect((await s.run('add(0)')).value).toBe(5);
    expect((await s.run('({date:new Date("2026-01-01"), map:new Map([["x",2]]), set:new Set([3])})')).value).toEqual({ date: '2026-01-01T00:00:00.000Z', map: [['x', 2]], set: [3] });
    expect((await s.run('await new Promise(resolve => process.stdout.write("module output", resolve))')).writes.join('')).toContain('module output');
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
    const unawaited = repl({ slow: () => new Promise(resolve => setTimeout(resolve, 50)) });
    expect((await unawaited.run('slow(); 1')).error?.code).toBe('command_outcome_unknown');
    await unawaited.dispose();
    expect(unawaited.status().pendingCalls).toBe(0);
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
    expect((await call('docs_get')).text).toContain('browser.tabs.new');
    expect((await call('docs_get', { name: 'api-reference', member: 'Tab.act' })).text).toContain('ActionOutcome');
    const observeDoc = (await call('docs_get', { name: 'api-reference', member: 'Tab.observe' })).text;
    expect(observeDoc).toContain('interface ObserveOptions');
    expect(observeDoc).not.toContain('  screenshot(');
    const readDoc = (await call('docs_get', { name: 'api-reference', member: 'Tab.read' })).text;
    expect(readDoc).toContain('read(opts: ReadElementOptions)');
    expect(readDoc).toContain('read(opts?: ReadOptions)');
    const opened = await call('js', { code: 'let tab = await browser.tabs.new("https://example.com/"); tab' });
    expect(opened.body, opened.text).toEqual({ ok: true, value: { type: 'Tab', id: 'page-one' } });
    expect((await call('js', { code: 'typeof tab' })).body.value).toBe('object');
    expect((await call('js', { code: 'await tab.observe()' })).body.value.state).toContain('[ref=e1]');
    const invalid = await call('js', { code: 'await tab.act({action:"press", target:{ref:"e1"}})' });
    expect(invalid.body.error.code).toBe('invalid_args');
    for (const code of ['await tab.act({action:"fill",target:{ref:"e1"},value:12})', 'await tab.act({action:"constructor"})', 'await tab.expect({})']) {
      expect((await call('js', { code })).body.error.code).toBe('invalid_args');
    }
    expect(clicked).toBe(false);
    const acted = await call('js', { code: 'await tab.act({action:"click", target:{ref:"e1"}}); await tab.expect({text:"Done"})' });
    expect(acted.body.value.ok).toBe(true);
    const observed = await call('js', { code: 'await tab.observe({mode:"both"})' });
    expect(observed.result.content).toContainEqual({ type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' });
    expect(observed.body.value.image).toEqual({ image: 'image/png' });
    const big = await call('js', { code: 'let rows = Array.from({length:2000}, (_, i) => ({id:i, text:"example"})); rows', maxChars: 1000 });
    expect(big.body.truncated).toBe(true);
    expect((await call('js', { code: 'rows.length' })).body.value).toBe(2000);
    await call('session_finalize');
    expect(finalized).toBe(true);
  } finally { await client.close(); await session.close(); await rt.shutdown(); }
});
