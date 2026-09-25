// Isolated CLI E2E: real registration, native host, health and MCP; simulated Chrome hello and client CLIs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const exec = promisify(execFile);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opencli-setup-e2e-'));
const home = path.join(root, 'home');
const preload = path.join(root, 'environment.mjs');
const clientState = path.join(root, 'clients.json');
const entry = path.resolve('dist/src/main.js');
const storeId = 'lnaoghmfcdnbhgcihkakfobckmfhllkg';
const env = { ...process.env, OPENCLI_SETUP_TEST_ROOT: root };
let host;
let mcp;
let stderr = '';

fs.mkdirSync(home);
fs.writeFileSync(clientState, '{}');
fs.writeFileSync(preload, `
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import child from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const root = process.env.OPENCLI_SETUP_TEST_ROOT;
os.homedir = () => path.join(root, 'home');
if (process.env.OPENCLI_SETUP_TEST_TTY) {
  Object.defineProperty(process.stdin, 'isTTY', { value: true });
  Object.defineProperty(process.stdout, 'isTTY', { value: true });
}
// Model macOS paths without touching the real user's profiles or Windows registry.
Object.defineProperty(process, 'platform', { value: 'darwin' });
child.execFileSync = (file, args) => {
  if (file === 'ps') return '';
  if (file === 'pgrep') return '123 Google Chrome';
  if (file === 'which') {
    if (['codex', 'claude'].includes(args[0])) return '/fake/' + args[0] + '\\n';
    throw new Error('not installed');
  }
  if (file.startsWith('/fake/')) {
    const statePath = path.join(root, 'clients.json');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (args[1] === 'get') {
      if (state[file]) return JSON.stringify(state[file]);
      throw new Error('not registered');
    }
    if (args[1] === 'add') {
      if (state[file]) throw new Error('existing entry must not be overwritten');
      state[file] = args;
      fs.writeFileSync(statePath, JSON.stringify(state));
      return '';
    }
  }
  throw new Error('Unexpected external command: ' + file);
};
// This test always passes --no-open. Fail if setup tries to open a browser anyway.
child.execFile = () => { throw new Error('Unexpected browser launch'); };
syncBuiltinESMExports();
`);

async function cli(args, expectedCode = 0) {
  let result;
  try { result = await exec(process.execPath, ['--import', preload, entry, ...args], { env, timeout: 15_000 }); }
  catch (error) {
    if (error.code !== expectedCode) throw error;
    result = error;
  }
  assert.equal(result.code ?? 0, expectedCode, result.stdout + result.stderr);
  return result.stdout;
}

async function interactive(answer) {
  const child = spawn(process.execPath, ['--import', preload, entry, 'setup', '--no-open', '--wait', '0'], {
    env: { ...env, OPENCLI_SETUP_TEST_TTY: '1' }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '';
  let errors = '';
  let answered = false;
  child.stdout.on('data', (chunk) => {
    output += chunk;
    if (!answered && output.includes('Client IDs, separated by commas')) {
      answered = true;
      child.stdin.write(answer);
    }
  });
  child.stderr.on('data', (chunk) => { errors += chunk; });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 10_000);
  try {
    const [code] = await once(child, 'exit');
    assert.equal(code, 1, output + errors);
    assert(answered, 'CLI never prompted for selection');
    return output + errors;
  } finally { clearTimeout(timeout); }
}

try {
  // doctor must be read-only and must not depend on an unpacked extension.
  const initial = JSON.parse(await cli(['doctor', '--json'], 1));
  assert.equal(initial.ok, false);
  assert.deepEqual(fs.readdirSync(home), []);
  assert(!JSON.stringify(initial).match(/Load unpacked|Developer mode|npm run build/));

  assert((await cli(['setup', '--help'])).includes('Connect Chrome'));
  await cli(['setup', '--unknown-option'], 1);
  await cli(['setup', '--browsers'], 1);
  await cli(['setup', '--no-open', '--wait=-1'], 1);
  assert.deepEqual(fs.readdirSync(home), []);
  await cli(['setup', '--no-open', '--browsers', 'unknown'], 1);
  assert.deepEqual(fs.readdirSync(home), []);

  const first = await cli(['setup', '--no-open', '--wait', '0'], 1);
  assert(first.includes('registration has been saved'));
  assert(first.includes('chromewebstore.google.com'));
  assert(!first.match(/Load unpacked|Developer mode|clipboard|Setup complete/));
  const nativeDir = path.join(home, 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts');
  const manifestFile = path.join(nativeDir, 'com.opencli.mcp.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  assert.deepEqual(manifest.allowed_origins, ['chrome-extension://' + storeId + '/']);
  assert(fs.existsSync(manifest.path));
  assert.equal(fs.readFileSync(clientState, 'utf8'), '{}', 'non-interactive setup must not configure detected clients implicitly');
  assert(first.includes('--clients'));
  const cancelled = await interactive('\x03');
  assert(cancelled.includes('cancelled'));
  assert.equal(fs.readFileSync(clientState, 'utf8'), '{}');
  await interactive('codex\n');
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(clientState, 'utf8'))), ['/fake/codex']);
  await cli(['setup', '--clients', 'claude', '--no-open', '--wait', '0'], 1);
  const clients = fs.readFileSync(clientState, 'utf8');
  const entries = JSON.parse(clients);
  assert.equal(Object.keys(entries).length, 2);
  for (const args of Object.values(entries)) assert.deepEqual(args.slice(args.indexOf('--') + 1), [process.execPath, entry]);
  console.log('PASS client choice: no implicit registration, interactive selection, cancellation, and explicit client selection');

  const stateDir = path.join(home, '.opencli-mcp');
  fs.writeFileSync(path.join(stateDir, 'config.json'), '{"port":0}');
  // Execute the actual generated launcher; preload only isolates its home and process discovery.
  const launcherEnv = { ...env, NODE_OPTIONS: `--import=${JSON.stringify(preload)}` };
  host = spawn(manifest.path, [], { env: launcherEnv, stdio: ['pipe', 'pipe', 'pipe'] });
  host.stderr.on('data', (chunk) => { stderr += chunk; });
  host.stdout.resume();
  const { encodeFrame } = await import('../dist/src/host/native-messaging.js');
  const { PROTOCOL_REVISION } = await import('../dist/src/protocol.js');
  host.stdin.write(encodeFrame({ type: 'hello', extensionVersion: 'test', protocolRevision: PROTOCOL_REVISION + 1, features: [] }));
  const stateFile = path.join(stateDir, 'run', 'host.json');
  const deadline = Date.now() + 10_000;
  while (!fs.existsSync(stateFile) && Date.now() < deadline && host.exitCode === null) await new Promise((resolve) => setTimeout(resolve, 50));
  assert(fs.existsSync(stateFile), stderr);

  const connected = JSON.parse(await cli(['doctor', '--json']));
  assert.equal(connected.host.extensionConnected, true);
  assert.equal(connected.ok, true);
  assert.equal(connected.host.backend, 'extension');
  assert.match(connected.host.protocolWarning, /Browser commands remain available/);
  assert(connected.advice.some((line) => line.startsWith('Warning: Extension protocol')));
  assert(!('built' in connected.extension));
  const repeated = await cli(['setup', '--clients', 'claude,codex', '--no-open', '--wait', '0']);
  assert(repeated.includes('Setup complete'));
  assert(!repeated.includes('chromewebstore.google.com'));
  assert.equal(fs.readFileSync(clientState, 'utf8'), clients);
  console.log('PASS connected rerun: existing client settings preserved, live native host detected');

  // The client command setup registered must actually negotiate MCP and expose browser tools.
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', preload, entry], env, stderr: 'pipe' });
  mcp = new Client({ name: 'setup-e2e', version: '0.0.0' });
  await mcp.connect(transport);
  const tools = await mcp.listTools();
  assert(tools.tools.some((tool) => tool.name === 'tab_open'));
  assert(tools.tools.some((tool) => tool.name === 'doctor'));
  await mcp.close();
  mcp = null;
  console.log('PASS MCP: registered command connects through the launcher to the native host');

  // A live connection must not hide a broken on-disk registration; setup repairs it.
  manifest.allowed_origins = [];
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  const broken = JSON.parse(await cli(['doctor', '--json'], 1));
  assert.equal(broken.host.extensionConnected, true);
  assert.equal(broken.ok, false);
  assert(broken.advice.some((line) => line.includes('setup')));
  await cli(['setup', '--no-open', '--wait', '0']);
  assert.deepEqual(JSON.parse(fs.readFileSync(manifestFile, 'utf8')).allowed_origins, ['chrome-extension://' + storeId + '/']);
  console.log('PASS repair: doctor identifies invalid registration and setup restores it');

  assert((await cli(['doctor'])).includes('Browser connection is ready.'));
  const help = await cli(['--help']);
  assert(help.includes('setup'));
  assert(!/^\s+install\s/m.test(help));
  await cli(['install'], 2);
  console.log('setup smoke passed');
} catch (error) {
  if (stderr) process.stderr.write(`Native host stderr:\n${stderr}`);
  throw error;
} finally {
  await mcp?.close().catch(() => {});
  if (host && host.exitCode === null) {
    const closed = once(host, 'exit');
    host.kill('SIGTERM');
    const timer = setTimeout(() => host.kill('SIGKILL'), 3000);
    await closed;
    clearTimeout(timer);
  }
  fs.rmSync(root, { recursive: true, force: true });
}
