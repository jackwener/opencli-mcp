/** One stable entrypoint shared by Native Messaging and MCP clients. */
import fs from 'node:fs';
import path from 'node:path';
import { OPENCLI_MCP_DIR } from './state.js';

type Installation = { node: string; entry: string };
export const LAUNCHER_PATH = path.join(OPENCLI_MCP_DIR, 'bin', `opencli-mcp-launcher${process.platform === 'win32' ? '.cmd' : ''}`);
const INSTALLATION_FILE = path.join(OPENCLI_MCP_DIR, 'installation.json');

/** Keep Homebrew's formula alias, but only when it names the file actually being installed. */
function stablePath(file: string): string {
  const match = /^(.*)\/Cellar\/([^/]+)\/[^/]+\/(.+)$/.exec(file);
  if (match) {
    const candidate = `${match[1]}/opt/${match[2]}/${match[3]}`;
    try { if (fs.realpathSync(candidate) === fs.realpathSync(file)) return candidate; } catch { /* use the known path */ }
  }
  return file;
}

function renderLauncher({ node, entry }: Installation): string {
  if (process.platform === 'win32') {
    const quote = (value: string): string => `"${value.replaceAll('%', '%%')}"`;
    // Chrome supplies its extension origin (and sometimes a window handle), not a mode.
    return ['@echo off', 'setlocal DisableDelayedExpansion',
      `if not exist ${quote(node)} (`, '  echo [opencli-mcp] Node runtime missing. Reinstall Node and run opencli-mcp setup. 1>&2', '  exit /b 1', ')',
      `if not exist ${quote(entry)} (`, '  echo [opencli-mcp] Program entry missing. Reinstall opencli-mcp and run opencli-mcp setup. 1>&2', '  exit /b 1', ')',
      'if "%~1"=="stdio" goto stdio',
      `${quote(node)} ${quote(entry)} host %*`, 'exit /b %errorlevel%',
      ':stdio', `${quote(node)} ${quote(entry)} %*`, 'exit /b %errorlevel%', ''].join('\r\n');
  }
  const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
  return `#!/bin/sh
node=${quote(node)}
entry=${quote(entry)}
if [ ! -x "$node" ]; then
  printf '%s\\n' "[opencli-mcp] Node runtime missing or not executable: $node. Reinstall Node and run opencli-mcp setup." >&2
  exit 1
fi
if [ ! -r "$entry" ]; then
  printf '%s\\n' "[opencli-mcp] Program entry missing or unreadable: $entry. Reinstall opencli-mcp and run opencli-mcp setup." >&2
  exit 1
fi
if [ "\${1-}" = stdio ]; then
  exec "$node" "$entry" "$@"
fi
exec "$node" "$entry" host "$@"
`;
}

function readableFile(file: string, executable = false): void {
  if (!fs.statSync(file).isFile()) throw new Error('not a file');
  fs.accessSync(file, executable && process.platform !== 'win32' ? fs.constants.R_OK | fs.constants.X_OK : fs.constants.R_OK);
}

export function writeLauncher(main: string): string {
  const installation = { node: stablePath(process.execPath), entry: stablePath(main) };
  readableFile(installation.node, true);
  readableFile(installation.entry);
  fs.mkdirSync(path.dirname(LAUNCHER_PATH), { recursive: true });
  const temporary = `${LAUNCHER_PATH}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, renderLauncher(installation), { mode: 0o755 });
    fs.renameSync(temporary, LAUNCHER_PATH);
  } finally { fs.rmSync(temporary, { force: true }); }
  fs.writeFileSync(INSTALLATION_FILE, JSON.stringify(installation, null, 2) + '\n');
  return LAUNCHER_PATH;
}

export type LaunchHealth = { ready: boolean; launcher: string; node?: string; entry?: string; errors: string[] };

/** Inspect next-start dependencies even while a previous host process is still healthy. */
export function inspectLaunch(): LaunchHealth {
  const result: LaunchHealth = { ready: false, launcher: LAUNCHER_PATH, errors: [] };
  let installation: Installation;
  try {
    installation = JSON.parse(fs.readFileSync(INSTALLATION_FILE, 'utf8')) as Installation;
    if (typeof installation.node !== 'string' || !path.isAbsolute(installation.node) || typeof installation.entry !== 'string' || !path.isAbsolute(installation.entry)) throw new Error('invalid paths');
  } catch {
    result.errors.push(`Installation record missing or invalid: ${INSTALLATION_FILE}`);
    return result;
  }
  result.node = installation.node;
  result.entry = installation.entry;
  for (const [label, file, executable] of [
    ['Node runtime', installation.node, true], ['Program entry', installation.entry, false], ['Launcher', LAUNCHER_PATH, true],
  ] as const) {
    try { readableFile(file, executable); }
    catch { result.errors.push(`${label} missing or inaccessible: ${file}`); }
  }
  try {
    if (fs.readFileSync(LAUNCHER_PATH, 'utf8') !== renderLauncher(installation)) result.errors.push('Launcher does not match the installation record.');
  } catch { /* reported above */ }
  result.ready = result.errors.length === 0;
  return result;
}
