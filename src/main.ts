#!/usr/bin/env node
/**
 * opencli-mcp — entry point.
 *   opencli-mcp                 stdio MCP (proxies to the Chrome-spawned host)
 *   opencli-mcp host            the Native Messaging host (spawned by Chrome; do not run by hand)
 *   opencli-mcp setup           register browser + MCP clients, guide Web Store installation, verify connection
 *   opencli-mcp uninstall
 *   opencli-mcp doctor
 *   opencli-mcp extension-path  print the unpacked extension directory
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const here = path.dirname(fileURLToPath(import.meta.url));
function findVersion(): string {
  let dir = here;
  for (let i = 0; i < 6; i++) { const pkg = path.join(dir, 'package.json'); try { const j = JSON.parse(fs.readFileSync(pkg, 'utf8')) as { name?: string; version?: string }; if (j.name === 'opencli-mcp' && j.version) return j.version; } catch { /* walk */ } dir = path.dirname(dir); }
  return '0.0.0';
}
const VERSION = findVersion();

const argv = process.argv.slice(2);
const cmd = argv[0] ?? (process.stdin.isTTY ? 'help' : 'stdio');
const has = (name: string): boolean => argv.includes(name);

const HELP = `Usage: opencli-mcp <command>

  setup                 Connect Chrome and configure MCP clients
  doctor [--json]        Check the browser connection without changing settings
  version               Show the installed version

Setup options:
  --clients <ids>       Configure claude,codex,opencode,pi; manual prints config; none skips
  --no-open             Print the extension link without opening a browser
  --wait <seconds>      Connection timeout (default: 180; 0 checks once)
  --browsers <names>     Target browsers, e.g. chrome,edge
  --user-data-dir <dir> Register a custom browser profile (comma-separated)

Advanced:
  stdio                 Run the MCP server (default when launched by a client)
  extension-path        Print the unpacked extension directory for development
  uninstall             Remove browser host registration (keeps MCP client settings)
`;

async function main(): Promise<void> {
  if (has('--help') || has('-h')) { process.stdout.write(HELP); return; }
  switch (cmd) {
    case 'help': case '--help': case '-h': process.stdout.write(HELP); return;
    case 'stdio': {
      const { runStdio } = await import('./launcher/stdio.js');
      await runStdio({ version: VERSION });
      return;
    }
    case 'host': {
      const { runNativeHost } = await import('./host/host.js');
      await runNativeHost({ version: VERSION });
      return;
    }
    case 'setup': {
      const { values } = parseArgs({ args: argv.slice(1), options: {
        'no-open': { type: 'boolean' },
        clients: { type: 'string' },
        wait: { type: 'string' },
        browsers: { type: 'string' },
        'user-data-dir': { type: 'string' },
      } });
      const { setup } = await import('./host/setup.js');
      process.exitCode = (await setup({
        noOpen: values['no-open'],
        clients: values.clients?.split(','),
        waitMs: values.wait === undefined ? undefined : Number(values.wait) * 1000,
        browsers: values.browsers?.split(','),
        userDataDirs: values['user-data-dir']?.split(','),
      })) ? 0 : 1;
      return;
    }
    case 'uninstall': {
      const { unregisterHost } = await import('./host/registration.js');
      process.stdout.write(`${JSON.stringify({ removed: unregisterHost() }, null, 2)}\n`);
      return;
    }
    case 'doctor': {
      const { doctor } = await import('./host/doctor.js');
      const r = await doctor();
      if (has('--json')) process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
      else {
        const registered = r.manifests.some((m) => m.present && m.launcherExists && m.launcherMatches && m.authorized);
        process.stdout.write([
          r.ok ? 'Browser connection is ready.' : 'Browser connection needs attention.',
          `  Browser registration: ${registered ? 'ready' : 'missing or invalid'}`,
          `  Next startup: ${r.launch.ready ? 'ready' : 'needs repair'}`,
          `  Local host: ${r.host.running ? 'running' : 'not connected'}`,
          `  Chrome extension: ${r.host.extensionConnected ? 'connected' : 'not connected'}`,
          ...r.advice.map((line) => `  ${line}`),
        ].join('\n') + '\n');
      }
      process.exitCode = r.ok ? 0 : 1;
      return;
    }
    case 'extension-path': {
      const { extensionDir } = await import('./host/registration.js');
      process.stdout.write(`${extensionDir()}\n`);
      return;
    }
    case 'version': case '--version': case '-V': process.stdout.write(`${VERSION}\n`); return;
    default:
      process.stderr.write(`Unknown command: ${cmd}\n${HELP}`);
      process.exitCode = 2;
  }
}

main().catch((err) => { process.stderr.write(`[opencli-mcp] ${cmd === 'setup' || cmd === 'doctor' ? (err as Error).message : (err as Error).stack ?? err}\n`); process.exit(1); });
