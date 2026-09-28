// MCP → REPL worker → real framed bridge → extension dispatcher → isolated Chromium.
// Only the native port bootstrap is replaced; no user profile or host registration is changed.
import assert from 'node:assert/strict';
import { mkdtemp, cp, rm, readdir } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { createServer } from 'node:http';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { ExtensionBridge } from '../dist/src/host/bridge.js';
import { NativeChannel, FrameDecoder, encodeFrame } from '../dist/src/host/native-messaging.js';
import { Runtime } from '../dist/src/runtime/runtime.js';
import { createMcpServer } from '../dist/src/mcp/server.js';

const scratch = await mkdtemp(join(tmpdir(), 'opencli-native-smoke-'));
const ext = join(scratch, 'extension');
await cp('extension/dist', ext, { recursive: true });
await build({ entryPoints: ['extension/src/background.ts'], bundle: true, format: 'esm', platform: 'browser', target: 'chrome120', outfile: join(ext, 'background.js'),
  plugins: [{ name: 'isolated-native-port', setup(b) {
    b.onLoad({ filter: /extension\/src\/native\.ts$/ }, () => ({ contents: `
      export class NativeHost {
        constructor(handler) { globalThis.__command = handler; globalThis.__events = []; }
        connect() { return true; }
        event(event) { globalThis.__events.push(event); }
      }`, loader: 'js' }));
  } }],
});
const fixture = createServer((req, res) => {
  if (req.url === '/file') { res.setHeader('content-disposition', 'attachment; filename="opencli-smoke.txt"'); res.end('download fixture'); return; }
  res.setHeader('content-type', 'text/html');
  res.end(`<!doctype html><title>Native smoke</title><h1>Ready</h1><button onclick="document.querySelector('h1').textContent='Done'">Continue</button><script>window.mainWorldMarker=42</script>`);
});
await new Promise(r => fixture.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${fixture.address().port}/`;
let context, client, session, channel;
try {
  let executablePath = process.env.OPENCLI_SMOKE_CHROME;
  if (!executablePath && process.platform === 'darwin') {
    const cache = join(homedir(), 'Library/Caches/ms-playwright');
    const revisions = (await readdir(cache)).filter(p => /^chromium-\d+$/.test(p)).sort().reverse();
    executablePath = join(cache, revisions[0], 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
  }
  context = await chromium.launchPersistentContext(join(scratch, 'profile'), { executablePath, headless: true,
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`], acceptDownloads: true });
  await context.pages()[0].goto(url);
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  await worker.evaluate(() => { if (!globalThis.__command) throw new Error('Extension dispatcher not initialized'); });
  const incoming = new PassThrough(), outgoing = new PassThrough();
  channel = new NativeChannel(incoming, outgoing);
  const decoder = new FrameDecoder();
  const streamIds = [];
  outgoing.on('data', bytes => { for (const message of decoder.push(bytes)) {
    if (message.type !== 'command') continue;
    void worker.evaluate(async command => {
      const result = await globalThis.__command(command);
      return { result, events: globalThis.__events.splice(0) };
    }, message.command).then(({ result, events }) => {
      if (message.command.action === 'stream-watch' && result.ok) streamIds.push(result.data.id);
      for (const event of events) incoming.write(encodeFrame({ type: 'event', event }));
      incoming.write(encodeFrame({ type: 'result', result }));
    }).catch(error => incoming.write(encodeFrame({ type: 'result', result: { id: message.command.id, ok: false, error: String(error) } })));
  } });
  const bridge = new ExtensionBridge(channel);
  incoming.write(encodeFrame({ type: 'hello', extensionVersion: 'smoke', protocolRevision: 2,
    features: ['chrome-api', 'streams', 'extension-logs', 'page-evaluate', 'cdp', 'console', 'frames', 'network', 'dialogs'] }));
  const runtime = new Runtime({ bridge });
  session = createMcpServer(runtime, 'native-smoke');
  const [ct, st] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'native-smoke', version: '1' }, { capabilities: {} });
  await session.server.connect(st); await client.connect(ct);
  const call = async (name, args = {}, failure = false) => {
    const r = await client.callTool({ name, arguments: args });
    const raw = r.content.find(v => v.type === 'text')?.text;
    let parsed; try { parsed = JSON.parse(raw); } catch { parsed = raw; }
    assert.equal(Boolean(r.isError), failure, `${name}: ${raw}`);
    return parsed;
  };
  const js = async (code, failure = false) => { const r = await call('js', { code }, failure); return failure ? r.error : r.value; };
  const before = await worker.evaluate(() => chrome.tabs.query({}));
  const attachedBefore = await worker.evaluate(() => chrome.debugger.getTargets().then(ts => ts.filter(t => t.attached).map(t => t.id).sort()));
  assert.equal((await js('let nativeTabs = await browser.chrome.call("tabs.query", [{}]); nativeTabs.length')), before.length);
  assert.deepEqual(await worker.evaluate(() => chrome.debugger.getTargets().then(ts => ts.filter(t => t.attached).map(t => t.id).sort())), attachedBefore);
  assert.equal((await worker.evaluate(() => chrome.tabs.query({}))).length, before.length);
  assert.equal((await js('await browser.tabs.list()')).length, 0);
  assert((await call('docs_get', { name: 'api-reference', member: 'browser.chrome' })).includes('StreamOptions'));
  assert.equal((await js('await browser.chrome.describe("tabs.query")')).available, true);
  assert.equal((await js('await browser.chrome.describe("bookmarks.getTree")')).available, false);
  await js(`let tabEvents = await browser.chrome.watch('tabs.onCreated'); let created = await browser.chrome.call('tabs.create', [{url:${JSON.stringify(url)},active:false}]); let tab = await browser.tabs.get(String(created.id));`);
  assert((await js('await tabEvents.read()')).entries.some(e => e.args[0].id));
  assert.equal((await js('await browser.tabs.list()'))[0].origin, 'agent');
  await js("await tab.expect({text:'Ready'})");
  assert.equal(await js('await tab.evaluate(({add}) => window.mainWorldMarker + add, {arg:{add:8}})'), 50);
  await js("await tab.evaluate(() => { document.querySelector('h1').textContent = 'Changed'; }); await tab.expect({text:'Changed'})");
  assert.equal(await js('await tab.evaluate("window.statementValue = 9; window.statementValue")'), 9);
  assert.equal((await js('await tab.evaluate(() => 1n)', true)).code, 'result_not_serializable');
  const tree = await js('await tab.cdp.send("DOM.getDocument", {})');
  assert(tree.root.nodeId);
  const evaluated = await js('await tab.cdp.send("Runtime.evaluate", {expression:"6*7",returnByValue:true})');
  assert.equal(evaluated.result.value, 42);
  assert.equal((await js('await tab.cdp.send("Runtime.disable", {})', true)).code, 'runtime_state_conflict');
  await js('let consoleEvents = await tab.console.watch({capacity:2}); let protocolEvents = await tab.cdp.watch("Runtime.consoleAPICalled");');
  await js('await tab.evaluate(() => { console.warn("one"); console.warn("two"); console.error("three"); });');
  const logs = await js('await consoleEvents.read()');
  assert.equal(logs.dropped, 1); assert.equal(logs.entries.length, 2);
  assert((await js('await protocolEvents.read()')).entries.length >= 3);
  assert((await js('await tab.console.read({levels:["error"]})')).entries.some(e => e.message === 'three'));
  assert.equal((await js('await consoleEvents.read()')).entries.length, 0);
  await js('let extensionEvents = await browser.logs.watch();');
  await worker.evaluate(() => console.warn('extension-smoke-log'));
  assert((await js('await extensionEvents.read()')).entries.some(e=>e.message==='extension-smoke-log'));
  await js('await extensionEvents.close(); await extensionEvents.close();');
  assert((await js('await browser.logs.read({filter:"extension-smoke-log"})')).entries.length);
  // Target parameters named sessionId/targetUrl must not be silently removed from native CDP calls.
  const invalid = await js('await tab.cdp.send("DoesNotExist.test", {sessionId:"native",targetUrl:"keep"})', true);
  assert(invalid.message.includes('DoesNotExist'));
  // A script which starts then outlives its timeout executes once, and is not cancelled.
  await js('await tab.evaluate(() => { window.executions = 0; })');
  assert.equal((await js('await tab.evaluate(async () => { window.executions++; await new Promise(r=>setTimeout(r,250)); window.completed=true; }, {timeoutMs:30})', true)).code, 'command_outcome_unknown');
  await new Promise(r => setTimeout(r, 350));
  assert.deepEqual(await js('await tab.evaluate(() => ({n:window.executions,done:window.completed}))'), {n:1,done:true});
  // Existing user tabs keep their origin even when moved by a native API call.
  const userId = before[0].id;
  await js(`let borrowed = await browser.user.claimTab({tabId:${userId}}); await browser.chrome.call('windows.create',[{tabId:${userId},focused:false}]);`);
  assert.equal((await js('await browser.tabs.list()')).find(t => t.tabId === userId).origin, 'user');
  await call('js_reset');
  for (let i = 0; i < 100; i++) { if ((await call('doctor')).javascript.state === 'idle') break; await new Promise(r => setTimeout(r, 20)); }
  assert.equal(await js('typeof consoleEvents'), 'undefined');
  for (const streamId of streamIds) {
    const read = await bridge.send('stream-read', {session:'mcp:native-smoke', streamId});
    assert.equal(read.data.closed, true);
    assert.equal(read.data.reset, true);
  }
  assert.equal((await js('await browser.tabs.list()')).length, 2);
  await js(`let win = await browser.chrome.call('windows.create',[{url:[${JSON.stringify(url)},${JSON.stringify(url)}],focused:false}]);
    let duplicate = await browser.chrome.call('tabs.duplicate',[win.tabs[0].id]);
    let closing = await browser.tabs.get(String(duplicate.id));
    await browser.chrome.call('tabs.remove',[[duplicate.id]]);`);
  assert.equal((await js('await closing.evaluate("1")', true)).code, 'stale_page');
  assert.equal((await js('await browser.tabs.list()')).length, 4);
  const kept = await js(`let kept = await browser.chrome.call('tabs.create',[{url:${JSON.stringify(url)},active:false}]);
    await browser.chrome.call('tabs.update',[kept.id,{muted:true}]);
    let group = await browser.chrome.call('tabs.group',[{tabIds:[kept.id]}]);
    ({id:kept.id,group})`);
  const finalized = await call('session_finalize', {keep:[{tab:String(kept.id),status:'deliverable'}]});
  assert.deepEqual(finalized.failed, []);
  assert.equal(finalized.closed.length, 3);
  const keptNative = await worker.evaluate(id => chrome.tabs.get(id), kept.id);
  assert.equal(keptNative.groupId, kept.group);
  assert.equal(keptNative.mutedInfo.muted, true);
  assert(await worker.evaluate(id => chrome.tabs.get(id), userId));
  console.log('Passed: real Chrome query/create/ownership, MCP docs, REPL function evaluation, CDP, event capture/loss, page/extension logs, timeout without replay, reset and finalize.');
} finally {
  await session?.close(); await client?.close(); channel?.close();
  await context?.close(); await new Promise(r => fixture.close(r));
  await rm(scratch, { recursive: true, force: true });
}
