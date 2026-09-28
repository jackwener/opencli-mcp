// Real Chromium + chrome.debugger + production frame/page/action code, in a throwaway extension/profile.
// Only the native transport is replaced with a worker call; no installed browser or native host is touched.
// Run after npm run build. Set OPENCLI_TEST_CHROMIUM if the Playwright browser is installed elsewhere.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import { Tab } from '../dist/src/api/tab.js';
import { Runtime } from '../dist/src/runtime/runtime.js';
import { createExtensionPage } from '../dist/src/backends/extension-page.js';

const directory = await mkdtemp(join(tmpdir(), 'opencli-observation-'));
const longText = 'Business detail '.repeat(40) + 'END-OF-DETAIL';
const longUrl = 'https://example.test/details?q=' + 'x'.repeat(300) + '&end=complete';
let port;
const fixture = createServer((req, res) => {
  res.setHeader('content-type', 'text/html');
  if (req.url === '/child') return res.end(`<button onclick="this.textContent='Frame done'">Frame action</button><input id="field" placeholder="Cost center" value="initial"><iframe id="nested" src="http://127.0.0.1:${port}/nested"></iframe><script>document.querySelector('input').value='live-value'</script>`);
  if (req.url === '/nested') return res.end('<button onclick="this.textContent=\'Nested done\'">Nested action</button>');
  res.end(`<!doctype html><title>Observation fixture</title>
    <button title="${longText}">Main action</button><a href="${longUrl}">${longText}</a>
    <div id="custom" tabindex="0" title="Internal workflow" onclick="this.textContent='Custom done'">Custom control</div>
    <input type="checkbox" id="flag"><div id="shadow"></div>
    <iframe id="outer" name="billing" src="http://localhost:${port}/child"></iframe>
    <div style="height:1200px"></div><iframe id="offscreen" src="/nested"></iframe>
    <script>
      document.querySelector('#flag').checked=true;
      document.querySelector('#shadow').attachShadow({mode:'open'}).innerHTML=\`<p>Shadow article content</p><input placeholder="Shadow field" value="shadow-live"><button onclick="this.textContent=\'Shadow done\'">Shadow action</button><iframe id="shadow-frame" src="/nested"></iframe>\`;
    </script>`);
});
let context;
try {
  await new Promise(resolve => fixture.listen(0, resolve));
  port = fixture.address().port;
  await writeFile(join(directory, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Observation smoke', version: '1.0', permissions: ['debugger', 'tabs', 'webNavigation', 'downloads'], host_permissions: ['<all_urls>'], background: { service_worker: 'worker.js', type: 'module' } }));
  await copyFile('extension/dist/page.js', join(directory, 'page.js'));
  await build({ stdin: { resolveDir: resolve('.'), contents: `
    import * as cdp from './extension/src/cdp.ts';
    import { registerFrameTracking, evaluateInWorld, evaluateMain } from './extension/src/world.ts';
    import { routeFrames } from './extension/src/frames.ts';
    import { frameSteps } from './src/shared/engine.ts';
    import { performAct } from './extension/src/act.ts';
    cdp.registerListeners(); registerFrameTracking();
    globalThis.testFrames = cdp.listFrames;
    globalThis.runCommand = async ({action, params, tabId}) => {
      if (action === 'act') return {data: await performAct(tabId, params.act, {aggressive:false})};
      if (action !== 'exec') throw new Error('Unexpected command: ' + action);
      const route = params.world === 'engine' ? await routeFrames(tabId, frameSteps(params.frame), false) : null;
      const data = params.world === 'engine'
        ? await evaluateInWorld(tabId, route?.frameId ?? null, params.code, false, params.timeoutMs)
        : await evaluateMain(tabId, null, params.code, false, params.timeoutMs);
      return {data};
    };
  ` }, bundle: true, format: 'esm', platform: 'browser', target: 'chrome120', outfile: join(directory, 'worker.js') });
  context = await chromium.launchPersistentContext(join(directory, 'profile'), {
    ...(process.env.OPENCLI_TEST_CHROMIUM && { executablePath: process.env.OPENCLI_TEST_CHROMIUM }),
    headless: false, args: [`--disable-extensions-except=${directory}`, `--load-extension=${directory}`, '--site-per-process'], viewport: { width: 1200, height: 900 },
  });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForFunction(() => document.querySelector('#shadow')?.shadowRoot?.querySelector('button'));
  const tabId = await worker.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url).id, page.url());
  const bridge = { send: (action, params) => worker.evaluate(command => globalThis.runCommand(command), { action, params, tabId }) };
  const transport = await createExtensionPage(bridge, { session: 'observation-smoke', surface: 'browser', page: String(tabId) });
  const rt = new Runtime();
  const tab = new Tab(String(tabId), { rt, sessionId: 'observation-smoke', state: rt.session('observation-smoke') }, transport);

  const observed = await tab.observe();
  assert(observed.state.includes('END-OF-DETAIL'), 'ARIA must not irreversibly clip long names');
  assert(observed.state.includes('&end=complete'), 'ARIA must retain full URLs');
  assert(observed.framesComplete, JSON.stringify(observed.frames));
  const child = observed.frames.find(frame => frame.owner.id === 'outer');
  const nested = observed.frames.find(frame => frame.frame.length === 2 && frame.state?.includes('Nested action'));
  assert(child?.state.includes('Frame action') && nested, 'Cross-origin and nested frames must be observed');
  assert(observed.frames.some(frame => frame.owner.id === 'shadow-frame'), 'Frame owners in shadow roots must route');
  assert.equal(await page.evaluate(() => scrollY), 0, 'Observation must not scroll to offscreen frames');
  assert((await worker.evaluate(tabId => globalThis.testFrames(tabId), tabId)).some(f => f.oopif), 'Fixture must exercise a real OOPIF');
  console.log('Passed: full ARIA, same-origin/cross-origin/nested/shadow iframe observations, no observation scroll.');

  const dom = await tab.observe({ format: 'dom', includeFrames: false });
  const custom = dom.dom.entries.find(entry => entry.attrs.title === 'Internal workflow');
  const shadow = dom.dom.entries.find(entry => entry.attrs.placeholder === 'Shadow field');
  assert(custom && shadow, 'Independent DOM mode must discover custom and shadow controls');
  assert.equal(dom.dom.entries.find(entry => entry.attrs.id === 'flag').attrs.checked, 'true');
  const clipped = dom.dom.entries.find(entry => entry.tag === 'a');
  assert(clipped.truncated);
  const linkRef = observed.state.match(/link "[^\n]+" \[ref=(e\d+)\]/)?.[1];
  assert.equal(linkRef, clipped.ref, 'Cursor markers must not bypass stable ARIA ref mapping');
  const exact = await tab.read({ target: { ref: clipped.ref } });
  assert.equal(exact.text, longText);
  assert.equal(exact.attrs.href, longUrl);
  const branch = await tab.observe({ref:clipped.ref, includeFrames:false});
  assert(branch.state.includes('END-OF-DETAIL'), JSON.stringify({clipped, branch, state:observed.state}));
  await assert.rejects(tab.read({target:{selector:'button'}}), error => error.code === 'selector_ambiguous');
  const shadowContainer = (await tab.find({selector:'#shadow'})).entries[0];
  assert.equal((await tab.read({target:{within:shadowContainer.ref, ref:shadow.ref}})).attrs.value, 'shadow-live');
  const paged = await tab.observe({ format: 'dom', limit: 1, includeFrames: false });
  assert.equal(paged.dom.nextStart, 1);
  assert.equal((await tab.observe({ format: 'dom', start: paged.dom.nextStart, limit: 1, includeFrames: false })).dom.start, 1);
  assert((await tab.find({ query: 'Internal workflow' })).entries.some(entry => entry.ref === custom.ref));
  assert((await tab.find({ query: 'shadow-live' })).entries.length);
  assert((await tab.read({ maxChars: 20000 })).text.includes('Shadow article content'));
  console.log('Passed: independent DOM evidence, live state, shadow content, pagination, full exact read and DOM query.');

  const field = await tab.find({ frame: child.frame, label: 'Cost center' });
  assert.equal((await tab.read({ target: { frame: child.frame, ref: field.entries[0].ref } })).attrs.value, 'live-value');
  const buttonRef = child.state.match(/button "Frame action"[^\n]*\[ref=(e\d+)\]/)[1];
  await tab.act({ action: 'click', target: { frame: child.frame, ref: buttonRef }, settleMs: 0 });
  assert((await tab.observe({ frame: child.frame })).state.includes('Frame done'));
  await tab.act({ action: 'fill', target: { frame: child.frame, ref: field.entries[0].ref }, value: 'edited', settleMs: 0 });
  assert.equal((await tab.read({ target: { frame: child.frame, ref: field.entries[0].ref } })).attrs.value, 'edited');
  await tab.act({ action: 'click', target: { frame: nested.frame, role: 'button', name: 'Nested action' }, settleMs: 0 });
  assert((await tab.observe({ frame: nested.frame })).state.includes('Nested done'));
  const shadowButton = dom.dom.entries.find(entry => entry.text === 'Shadow action');
  await tab.act({ action: 'click', target: { ref: shadowButton.ref }, settleMs: 0 });
  assert.equal((await tab.read({ target: { ref: shadowButton.ref } })).text, 'Shadow done');
  const baseline = await tab.observe();
  const diff = await tab.observe({ since: baseline.snapshotId });
  assert(diff.diff && diff.frames.every(frame => frame.diff), 'Diff each frame in its own ref space');
  await page.evaluate(() => {
    const port = document.createElement('div');
    port.id = 'shadow-scroll';
    port.style.cssText = 'height:200px;overflow:auto';
    port.innerHTML = '<div style="height:4000px">Lazy report</div><p>Not loaded</p>';
    port.addEventListener('scroll', () => {
      if (port.scrollTop + port.clientHeight >= port.scrollHeight - 2) port.querySelector('p').textContent = 'Shadow report complete';
    });
    document.querySelector('#shadow').shadowRoot.append(port);
  });
  assert((await tab.read()).text.includes('Shadow report complete'), 'Read must scroll shadow-root lazy content');
  assert.equal(await page.evaluate(() => document.querySelector('#shadow').shadowRoot.querySelector('#shadow-scroll').scrollTop), 0, 'Read restores the shadow scrollport');
  console.log('Passed: shadow-root lazy document scan and scroll restoration.');
  const send = bridge.send;
  let removed = false;
  bridge.send = async (action, params) => {
    const result = await send(action, params);
    if (!removed && action === 'exec' && params.code.includes('.observeFrame(') && !params.frame?.length) {
      removed = true;
      await page.evaluate(() => document.querySelector('#outer').remove());
    }
    return result;
  };
  const partial = await tab.observe();
  assert.equal(partial.framesComplete, false);
  assert(partial.frames.find(frame => frame.owner.id === 'outer').unavailable);
  bridge.send = send;
  console.log('Passed: detached child reports unavailable without losing other observations.');
  await send('exec', {world:'engine', code:'(() => { globalThis.savedObserveFrame = globalThis.__opencliPage.observeFrame; delete globalThis.__opencliPage.observeFrame; })()'});
  // Simulate the old edge, which accepted exec but ignored the newly added frame field.
  bridge.send = (action, params) => send(action, {...params, frame:undefined});
  try {
    const legacy = await tab.observe();
    assert(legacy.state.includes('Main action') && legacy.warnings.length);
    assert.equal(legacy.framesComplete, false);
    await assert.rejects(tab.observe({format:'dom'}), /updated extension/);
    await assert.rejects(tab.find({frame:['#outer'], selector:'button'}), /updated extension/);
  } finally {
    bridge.send = send;
    await send('exec', {world:'engine', code:'(() => { globalThis.__opencliPage.observeFrame = globalThis.savedObserveFrame; delete globalThis.savedObserveFrame; })()'});
  }
  console.log('Passed: old-extension capability simulation keeps core ARIA usable and rejects wrong-frame reads.');
  console.log('Passed: observe → find → exact read → real click/fill → observe, including OOPIF/nested/shadow controls and scoped diffs.');
} finally {
  await context?.close();
  await new Promise(resolve => fixture.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
