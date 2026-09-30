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
const root = fs.mkdtempSync(path.join(os.tmpdir(), "opencli setup ' $ e2e-"));
const home = path.join(root, 'home');
const preload = path.join(root, 'environment.mjs');
const clientState = path.join(root, 'clients.json');
const entry = path.resolve('dist/src/main.js');
const storeId = 'lnaoghmfcdnbhgcihkakfobckmfhllkg';
const brew = path.join(root, 'custom brew');
const keg = version => path.join(brew, 'Cellar', 'node@22', version);
const opt = path.join(brew, 'opt', 'node@22');
function installNode(version) {
  fs.mkdirSync(path.join(keg(version), 'bin'), { recursive: true });
  fs.symlinkSync(process.execPath, path.join(keg(version), 'bin', 'node'));
  fs.mkdirSync(path.dirname(opt), { recursive: true });
  fs.rmSync(opt, { force: true });
  fs.symlinkSync(keg(version), opt);
}
installNode('22.0.0');
const env = { ...process.env, OPENCLI_SETUP_TEST_ROOT: root, OPENCLI_SETUP_TEST_NODE: path.join(keg('22.0.0'), 'bin', 'node') };
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
if (process.env.OPENCLI_SETUP_TEST_NODE) Object.defineProperty(process, 'execPath', { value: process.env.OPENCLI_SETUP_TEST_NODE });
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
    if (args[1] === 'remove') {
      delete state[file];
      fs.writeFileSync(statePath, JSON.stringify(state));
      return '';
    }
    if (args[1] === 'add') {
      if (state[file]) throw new Error('remove the existing entry before adding');
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
  for (const args of Object.values(entries)) assert.deepEqual(args.slice(args.indexOf('--') + 1), [manifest.path, 'stdio']);
  console.log('PASS client choice: no implicit registration, interactive selection, cancellation, and explicit client selection');

  // Simulate brew upgrade and cleanup: the old runtime path disappears, opt follows the new keg.
  installNode('22.1.0');
  fs.rmSync(keg('22.0.0'), { recursive: true });
  env.OPENCLI_SETUP_TEST_NODE = path.join(keg('22.1.0'), 'bin', 'node');
  const stateDir = path.join(home, '.opencli-mcp');
  const installationFile = path.join(stateDir, 'installation.json');
  assert.equal(JSON.parse(fs.readFileSync(installationFile, 'utf8')).node, path.join(opt, 'bin', 'node'));
  assert.equal(JSON.parse(await cli(['doctor', '--json'], 1)).launch.ready, true);
  fs.writeFileSync(path.join(stateDir, 'config.json'), '{"port":0}');
  // Execute the actual generated launcher; preload only isolates its home and process discovery.
  const launcherEnv = { ...env, OPENCLI_SETUP_TEST_NODE: '', NODE_OPTIONS: `--import=${JSON.stringify(preload)}` };
  host = spawn(manifest.path, ['chrome-extension://' + storeId + '/'], { env: launcherEnv, stdio: ['pipe', 'pipe', 'pipe'] });
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
  // Replace stale selected commands; do not confuse entry existence with correctness.
  fs.writeFileSync(clientState, JSON.stringify({ '/fake/codex': ['stale'], '/fake/claude': ['stale'] }));
  const repeated = await cli(['setup', '--clients', 'claude,codex', '--no-open', '--wait', '0']);
  assert(repeated.includes('Setup complete'));
  assert(!repeated.includes('chromewebstore.google.com'));
  assert.deepEqual(JSON.parse(fs.readFileSync(clientState, 'utf8')), entries);
  console.log('PASS upgrade and repair: old Node removed, native host starts, selected client commands repaired');

  // The client command setup registered must actually negotiate MCP and expose browser tools.
  const transport = new StdioClientTransport({ command: manifest.path, args: ['stdio'], env: launcherEnv, stderr: 'pipe' });
  mcp = new Client({ name: 'setup-e2e', version: '0.0.0' });
  await mcp.connect(transport);
  const tools = await mcp.listTools();
  assert(tools.tools.some((tool) => tool.name === 'js'));
  assert(tools.tools.some((tool) => tool.name === 'doctor'));
  const js = async code => {
    const result = await mcp.callTool({ name: 'js', arguments: { code } });
    return JSON.parse(result.content.find(item => item.type === 'text').text);
  };
  assert.equal((await js('let counter = await Promise.resolve(1); counter + 1')).value, 2);
  assert.equal((await js('throw null')).ok, false);
  assert.equal((await js('counter += 1; counter')).value, 2);
  await mcp.close();
  mcp = null;
  console.log('PASS MCP: registered command executes persistent JavaScript and recovers after errors through the native host');

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

  // Running processes must not conceal broken next-start dependencies.
  fs.rmSync(opt);
  const missingNode = JSON.parse(await cli(['doctor', '--json'], 1));
  assert.equal(missingNode.host.extensionConnected, true);
  assert.equal(missingNode.launch.ready, false);
  assert(missingNode.launch.errors.some(line => line.includes('Node runtime')));
  await assert.rejects(exec(manifest.path, ['stdio'], { env: launcherEnv, timeout: 5000 }), error => {
    assert.equal(error.stdout, '');
    assert.match(error.stderr, /Node runtime missing.*setup/);
    return true;
  });
  // With no stable alias available, setup uses the new known runtime; clients stay unchanged.
  await cli(['setup', '--clients', 'none', '--no-open', '--wait', '0']);
  assert.equal(JSON.parse(fs.readFileSync(installationFile, 'utf8')).node, env.OPENCLI_SETUP_TEST_NODE);
  assert.deepEqual(JSON.parse(fs.readFileSync(clientState, 'utf8')), entries);

  // Exercise package relocation using a real entry symlink and the same installation writer.
  const launchModule = new URL('../dist/src/host/launch.js', import.meta.url).href;
  const stagedEntry = path.join(root, 'moved package.js');
  fs.symlinkSync(entry, stagedEntry);
  await exec(process.execPath, ['--import', preload, '--input-type=module', '-e',
    `import { writeLauncher } from ${JSON.stringify(launchModule)}; writeLauncher(${JSON.stringify(stagedEntry)});`], { env });
  const forwarded = await exec(manifest.path, ['stdio', '--help'], { env: launcherEnv, timeout: 5000 });
  assert.match(forwarded.stdout, /Usage: opencli-mcp/);
  fs.rmSync(stagedEntry);
  const missingEntry = JSON.parse(await cli(['doctor', '--json'], 1));
  assert.equal(missingEntry.host.extensionConnected, true);
  assert(missingEntry.launch.errors.some(line => line.includes('Program entry')));
  await assert.rejects(exec(manifest.path, ['stdio'], { env: launcherEnv, timeout: 5000 }), error => {
    assert.equal(error.stdout, '');
    assert.match(error.stderr, /Program entry missing.*setup/);
    return true;
  });
  await cli(['setup', '--clients', 'none', '--no-open', '--wait', '0']);
  assert.deepEqual(JSON.parse(fs.readFileSync(clientState, 'utf8')), entries);
  const recovered = new Client({ name: 'setup-recovered', version: '0.0.0' });
  mcp = recovered;
  await recovered.connect(new StdioClientTransport({ command: manifest.path, args: ['stdio'], env: launcherEnv }));
  assert((await recovered.listTools()).tools.some(tool => tool.name === 'js'));
  await recovered.close();
  mcp = null;
  console.log('PASS startup health: live host cannot hide missing Node/package; setup repairs both without changing client commands');

  // JSONC clients use the same canonical command while retaining unrelated settings.
  const { registerOpenCode } = await import('../dist/src/host/opencode.js');
  const { registerPi } = await import('../dist/src/host/pi.js');
  const { parse } = await import('jsonc-parser');
  const configHome = path.join(root, 'config');
  const piHome = path.join(root, 'pi');
  const openCodeFile = path.join(configHome, 'opencode', 'opencode.jsonc');
  const piFile = path.join(piHome, 'mcp.json');
  const command = { command: manifest.path, args: ['stdio'] };
  fs.mkdirSync(path.dirname(openCodeFile), { recursive: true });
  fs.mkdirSync(piHome);
  for (const [file, section] of [[openCodeFile, 'mcp'], [piFile, 'mcpServers']]) {
    fs.writeFileSync(file, `{// keep my settings\n"theme":"dark","${section}":{"other":{"command":"other"},"opencli-mcp":{"command":"stale"}}}`);
  }
  registerOpenCode(command, configHome);
  registerPi(command, piHome);
  for (const [file, section] of [[openCodeFile, 'mcp'], [piFile, 'mcpServers']]) {
    const text = fs.readFileSync(file, 'utf8');
    const config = parse(text);
    assert(text.includes('// keep my settings'));
    assert.equal(config.theme, 'dark');
    assert.equal(config[section].other.command, 'other');
    const own = config[section]['opencli-mcp'];
    assert.deepEqual(section === 'mcp' ? own.command : [own.command, ...own.args], [manifest.path, 'stdio']);
  }
  assert.equal(registerOpenCode(command, configHome), 'existing');
  assert.equal(registerPi(command, piHome), 'existing');
  console.log('PASS JSONC clients: canonical launcher replaces stale entries and preserves unrelated settings');

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
