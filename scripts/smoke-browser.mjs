// Live MCP → persistent REPL → browser extension → deterministic local page.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const fixture = createServer((_req, res) => {
  res.setHeader('content-type', 'text/html');
  res.end('<!doctype html><title>REPL smoke</title><button onclick="document.querySelector(\'h1\').textContent=\'Done\'">Continue</button><h1>Ready</h1>');
});
await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${fixture.address().port}/`;
const transport = new StdioClientTransport({ command: 'node', args: ['dist/src/main.js', 'stdio'], stderr: 'pipe' });
transport.stderr?.on('data', data => process.stderr.write(data));
const client = new Client({ name: 'smoke-browser', version: '1' }, { capabilities: {} });
const call = async (name, args = {}) => {
  const result = await client.callTool({ name, arguments: args });
  const first = result.content.find(c => c.type === 'text')?.text;
  let body;
  try { body = JSON.parse(first); } catch { body = first; }
  assert(!result.isError, `${name}: ${first}`);
  return { body, images: result.content.filter(c => c.type === 'image') };
};
const js = code => call('js', { code });
let connected = false;
try {
  await client.connect(transport);
  connected = true;
  const names = (await client.listTools()).tools.map(t => t.name);
  assert(names.includes('js') && !names.includes('tab_open'), 'The running host has the old tool surface. Reconnect the extension to the newly built host before this smoke.');
  await call('docs_get', { name: 'api-reference', member: 'Tab.act' });
  await js(`await browser.nameSession('🔎 REPL smoke'); let tab = await browser.tabs.new(${JSON.stringify(url)}); function ready() { return tab.expect({text:'Done'}); }`);
  const observed = await js('await tab.observe()');
  const ref = observed.body.value.state.match(/button "Continue"[^\n]*\[ref=([^\]]+)\]/)?.[1];
  assert(ref, `Expected observed button ref: ${observed.body.value.state}`);
  await js(`await tab.act({action:'click',target:{ref:${JSON.stringify(ref)}}}); await ready()`);
  const both = await js("await tab.observe({mode:'both'})");
  assert.equal(both.images.length, 1, 'observe both must return an MCP image');
  assert(both.body.value.state.includes('Done'));
  await call('js_reset');
  assert.equal((await js('typeof tab')).body.value, 'undefined');
  assert.equal((await js('await browser.tabs.list()')).body.value.length, 1, 'reset must keep the browser tab');
  console.log('Passed: discovery, persistent declarations/handles, observe, real click, expectation, image output and reset.');
} finally {
  try {
    if (connected) {
      const finalized = await call('session_finalize');
      assert.deepEqual(finalized.body.failed, []);
      console.log('Passed: session cleanup.');
    }
  } finally {
    await client.close();
    await new Promise(resolve => fixture.close(resolve));
  }
}
