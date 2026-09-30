/** Diagnose the installed host and live browser connection. */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { inspectLaunch, LAUNCHER_PATH, type LaunchHealth } from './launch.js';
import { NATIVE_HOST_NAME } from '../protocol.js';
import { nativeHostDirs, runningProfileDirs } from './registration.js';
import { EXTENSION_ID, EXTENSION_STORE_URL } from './extension.js';
import { hostHealth, readHostState, HOST_STATE_FILE } from './state.js';

export interface DoctorResult {
  ok: boolean;
  node: string;
  launch: LaunchHealth;
  extension: { id: string; storeUrl: string };
  manifests: Array<{ browser: string; file: string; present: boolean; launcherExists: boolean; launcherMatches: boolean; authorized: boolean }>;
  host: { stateFile: string; running: boolean; port?: number; backend?: string; extensionConnected?: boolean; protocolWarning?: string | null; error?: string };
  chromeRunning: boolean | null;
  advice: string[];
}

export async function doctor(): Promise<DoctorResult> {
  const launch = inspectLaunch();
  const running = runningProfileDirs();
  const manifests = [...nativeHostDirs(), ...running.map((d) => ({ browser: `profile:${d}`, dir: path.join(d, 'NativeMessagingHosts') }))].map(({ browser, dir }) => {
    const file = path.join(dir, `${NATIVE_HOST_NAME}.json`);
    let launcherExists = false;
    let authorized = false;
    let launcherMatches = false;
    try {
      const m = JSON.parse(fs.readFileSync(file, 'utf8')) as { path: string; allowed_origins?: string[] };
      launcherExists = fs.existsSync(m.path);
      launcherMatches = m.path === LAUNCHER_PATH;
      authorized = Boolean(m.allowed_origins?.includes(`chrome-extension://${EXTENSION_ID}/`));
    } catch { /* absent or invalid */ }
    return { browser, file, present: fs.existsSync(file), launcherExists, launcherMatches, authorized };
  });
  const state = readHostState();
  const health = await hostHealth(state);
  let chromeRunning: boolean | null = null;
  if (process.platform !== 'win32') {
    try { const out = execFileSync('pgrep', ['-fl', 'Google Chrome|Chromium|Microsoft Edge|Brave Browser'], { encoding: 'utf8', stdio: 'pipe' }); chromeRunning = out.trim().length > 0; } catch { chromeRunning = false; }
  }
  const advice: string[] = [];
  const registered = manifests.some((m) => m.present && m.launcherExists && m.launcherMatches && m.authorized);
  if (!registered) advice.push('Run `opencli-mcp setup` to register or repair the browser connection.');
  for (const d of running) if (!manifests.find((m) => m.browser === `profile:${d}`)?.present) advice.push(`Chrome is running with --user-data-dir=${d} but that profile has no host manifest: run \`opencli-mcp setup\` (it writes to running profiles automatically) and reload the extension there.`);
  if (!launch.ready) advice.push(...launch.errors, 'Run `opencli-mcp setup` from a working Node installation to repair startup. If the package is missing, reinstall opencli-mcp first.');
  if (launch.ready && !health.ok) advice.push(`Host not reachable (${health.error ?? 'unknown'}). Open Chrome and install or enable the extension: ${EXTENSION_STORE_URL}. It reconnects automatically; if it stays disconnected, disable and re-enable it in chrome://extensions.`);
  else if (health.ok && !health.extensionConnected) advice.push('Host is running but the browser is not connected. Enable the extension in Chrome; if it stays disconnected, disable and re-enable it in chrome://extensions.');
  else if (health.protocolWarning) advice.push(`Warning: ${health.protocolWarning}`);
  if (chromeRunning === false) advice.push('No Chromium-based browser process found; start Chrome.');
  return {
    ok: registered && launch.ready && health.ok && Boolean(health.extensionConnected),
    node: process.version,
    launch,
    extension: { id: EXTENSION_ID, storeUrl: EXTENSION_STORE_URL },
    manifests,
    host: { stateFile: HOST_STATE_FILE, running: health.ok, port: state?.port, backend: health.backend, extensionConnected: health.extensionConnected, protocolWarning: health.protocolWarning, error: health.error },
    chromeRunning,
    advice,
  };
}
