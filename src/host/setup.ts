/** Set up both connections: Chrome → local host, MCP client → local host. */
import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { registerHost } from './registration.js';
import { doctor } from './doctor.js';
import { EXTENSION_STORE_URL } from './extension.js';
import { registerOpenCode } from './opencode.js';
import { registerPi } from './pi.js';
import { createInterface } from 'node:readline/promises';

const say = (line: string): void => { process.stdout.write(`${line}\n`); };
const exec = promisify(execFile);
type StdioCommand = { command: string; args: string[] };
type ClientRegistration = { name: string; status: 'existing' | 'registered' | 'failed' };

function which(cmd: string): string | null {
  try { return execFileSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).split(/\r?\n/)[0].trim() || null; } catch { return null; }
}

const CLIENTS = [
  { name: 'Claude Code', bin: 'claude', scope: ['-s', 'user'] },
  { name: 'Codex', bin: 'codex', scope: [] },
  { name: 'OpenCode', bin: 'opencode', scope: [] },
  { name: 'Pi (pi-mcp-adapter required)', bin: 'pi', scope: [] },
];
async function selectClients(requested?: string[]): Promise<string[]> {
  const validate = (values: string[]): string[] => {
    const ids = [...new Set(values.map((value) => value.trim()))];
    if (!ids.length || ids.some((id) => !['claude', 'codex', 'opencode', 'pi', 'manual', 'none'].includes(id))) {
      throw new Error('Choose claude, codex, opencode, pi, manual, or none with --clients (comma-separated).');
    }
    if (ids.length > 1 && ids.some((id) => id === 'manual' || id === 'none')) {
      throw new Error('Choose manual or none on its own.');
    }
    for (const id of ids) {
      if (['claude', 'codex', 'opencode', 'pi'].includes(id) && !which(id)) throw new Error(`${id} CLI was not found on PATH. Install it first or choose manual.`);
    }
    return ids;
  };
  if (requested !== undefined) return validate(requested);
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    say('Non-interactive terminal: no MCP client settings will be changed. Use --clients claude,codex,opencode,pi to select clients, or --clients none to skip.');
    return ['manual'];
  }
  say('Choose which MCP clients to configure (only selected clients will be changed):');
  for (const client of CLIENTS) say(`  ${client.bin} — ${client.name}${which(client.bin) ? '' : ' (CLI not found; use manual)'}`);
  say('  manual — show configuration for Cursor, Claude Desktop, or another client');
  say('  none   — configure only the browser connection');
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  const controller = new AbortController();
  const cancel = (): void => controller.abort();
  prompt.on('SIGINT', cancel);
  prompt.on('close', cancel);
  try {
    while (true) {
      const answer = await prompt.question('Client IDs, separated by commas [manual]: ', { signal: controller.signal });
      try { return validate((answer.trim() || 'manual').split(',')); }
      catch (error) { say((error as Error).message); }
    }
  } catch { throw new Error('Setup cancelled; no configuration was changed.'); }
  finally { prompt.close(); }
}

function registerClients(c: StdioCommand, selected: string[]): ClientRegistration[] {
  const results: ClientRegistration[] = [];
  if (selected.includes('opencode')) {
    try { results.push({ name: 'OpenCode', status: registerOpenCode(c) }); }
    catch { results.push({ name: 'OpenCode', status: 'failed' }); }
  }
  if (selected.includes('pi')) {
    try { results.push({ name: 'Pi', status: registerPi(c) }); }
    catch { results.push({ name: 'Pi', status: 'failed' }); }
  }
  for (const client of CLIENTS.filter((client) => client.bin !== 'opencode' && client.bin !== 'pi' && selected.includes(client.bin))) {
    const bin = which(client.bin);
    if (!bin) { results.push({ name: client.name, status: 'failed' }); continue; }
    const options = { stdio: 'ignore' as const, timeout: 15_000 };
    let exists = false;
    try {
      execFileSync(bin, ['mcp', 'get', 'opencli-mcp'], options);
      exists = true;
    } catch { /* No readable registration; let add report any configuration error. */ }
    try {
      if (exists) execFileSync(bin, ['mcp', 'remove', ...client.scope, 'opencli-mcp'], options);
      execFileSync(bin, ['mcp', 'add', ...client.scope, 'opencli-mcp', '--', c.command, ...c.args], options);
      results.push({ name: client.name, status: 'registered' });
    } catch { results.push({ name: client.name, status: 'failed' }); }
  }
  return results;
}

async function openStorePage(): Promise<boolean> {
  try {
    if (process.platform === 'darwin') await exec('open', ['-a', 'Google Chrome', EXTENSION_STORE_URL], { timeout: 10_000 });
    else if (process.platform === 'win32') await exec('rundll32', ['url.dll,FileProtocolHandler', EXTENSION_STORE_URL], { timeout: 10_000 });
    else {
      // Browser processes may stay alive for the whole session; do not time out and kill them.
      return await new Promise<boolean>((resolve) => {
        const child = spawn(which('google-chrome') ?? which('chromium') ?? 'xdg-open', [EXTENSION_STORE_URL], { detached: true, stdio: 'ignore' });
        child.once('error', () => resolve(false));
        child.once('spawn', () => { child.unref(); resolve(true); });
      });
    }
    return true;
  } catch { return false; }
}

export async function setup(opts: { waitMs?: number; noOpen?: boolean; browsers?: string[]; userDataDirs?: string[]; clients?: string[] } = {}): Promise<boolean> {
  const waitMs = opts.waitMs ?? 180_000;
  if (!Number.isFinite(waitMs) || waitMs < 0) throw new Error('--wait must be a non-negative number of seconds.');

  const selected = await selectClients(opts.clients);
  const registration = registerHost({ browsers: opts.browsers, userDataDirs: opts.userDataDirs });
  const written = registration.manifests.filter((m) => m.written);
  if (!written.length) {
    say('No browser connection was registered. Check --browsers or --user-data-dir and run setup again.');
    return false;
  }
  say(`1/3  Browser connection registered: ${written.map((m) => m.browser).join(', ')}.`);

  // Absolute paths work in desktop clients even when their PATH differs from the terminal's.
  const command = { command: registration.launcher, args: ['stdio'] };
  const clients = registerClients(command, selected);
  say('2/3  MCP clients:');
  for (const client of clients) {
    const status = client.status === 'existing' ? 'already configured with this launcher' : client.status === 'registered' ? 'registered' : 'registration failed — use the configuration below';
    say(`     ${client.name}: ${status}.`);
  }
  if (selected.includes('none')) say('     Skipped; no MCP client settings were changed.');
  if (selected.includes('manual') || clients.some((client) => client.status === 'failed')) say(`     Manual configuration (Cursor, Claude Desktop, or other clients):\n${JSON.stringify({ mcpServers: { 'opencli-mcp': command } }, null, 2)}`);

  say('3/3  Checking the Chrome extension connection…');
  let status = await doctor();
  if (!status.ok) {
    const opened = !opts.noOpen && await openStorePage();
    say(`     ${opened ? 'Opened the Chrome Web Store. Install or enable opencli-mcp in Chrome:' : 'Install or enable opencli-mcp in Chrome:'} ${EXTENSION_STORE_URL}`);
    say('     Already installed? Keep Chrome open; the extension reconnects automatically.');
    if (waitMs > 0) say(`     Waiting up to ${waitMs / 1000} seconds for the browser connection…`);
    const until = Date.now() + waitMs;
    while (!status.ok && Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(2000, Math.max(0, until - Date.now()))));
      status = await doctor();
    }
  }
  if (!status.ok) {
    say('Browser is not connected yet. Your registration has been saved.');
    for (const advice of status.advice) say(`     ${advice}`);
    say('If the extension is already enabled, disable and re-enable it in chrome://extensions. Then run `opencli-mcp setup` again.');
    return false;
  }
  say('Browser connected.');
  if (clients.some((client) => client.status === 'failed')) {
    say('MCP client setup is incomplete. Apply the configuration above or fix the client CLI and rerun setup.');
    return false;
  }
  if (selected.includes('none')) say('Browser setup complete. MCP client settings were not changed.');
  else if (!clients.length) say('Next: add the configuration above to your MCP client, then reconnect it.');
  else say('Setup complete for the clients listed above. Restart or reconnect your MCP client to load the tools.');
  return true;
}
