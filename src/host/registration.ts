/** Register the local Native Messaging host Chrome uses to start the runtime. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { NATIVE_HOST_NAME } from '../protocol.js';
import { writeLauncher } from './launch.js';
import { EXTENSION_ID } from './extension.js';

export function projectRoot(): string {
  // walk up from this file to the nearest package.json that is ours (works from src/ under tsx and from dist/src/)
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const pkg = path.join(dir, 'package.json');
    try { if ((JSON.parse(fs.readFileSync(pkg, 'utf8')) as { name?: string }).name === 'opencli-mcp') return dir; } catch { /* keep walking */ }
    dir = path.dirname(dir);
  }
  throw new Error('opencli-mcp project root not found');
}
export function extensionDir(): string {
  const root = projectRoot();
  const dist = path.join(root, 'extension', 'dist');
  return fs.existsSync(path.join(dist, 'manifest.json')) ? dist : path.join(root, 'extension');
}

export function nativeHostDirs(): Array<{ browser: string; dir: string }> {
  const home = os.homedir();
  if (process.platform === 'darwin') {
    const base = path.join(home, 'Library', 'Application Support');
    return [
      { browser: 'chrome', dir: path.join(base, 'Google', 'Chrome', 'NativeMessagingHosts') },
      { browser: 'chrome-beta', dir: path.join(base, 'Google', 'Chrome Beta', 'NativeMessagingHosts') },
      { browser: 'chrome-canary', dir: path.join(base, 'Google', 'Chrome Canary', 'NativeMessagingHosts') },
      { browser: 'chrome-for-testing', dir: path.join(base, 'Google', 'Chrome for Testing', 'NativeMessagingHosts') },
      { browser: 'chromium', dir: path.join(base, 'Chromium', 'NativeMessagingHosts') },
      { browser: 'edge', dir: path.join(base, 'Microsoft Edge', 'NativeMessagingHosts') },
      { browser: 'brave', dir: path.join(base, 'BraveSoftware', 'Brave-Browser', 'NativeMessagingHosts') },
      { browser: 'arc', dir: path.join(base, 'Arc', 'User Data', 'NativeMessagingHosts') },
    ];
  }
  if (process.platform === 'linux') {
    const base = path.join(home, '.config');
    return [
      { browser: 'chrome', dir: path.join(base, 'google-chrome', 'NativeMessagingHosts') },
      { browser: 'chromium', dir: path.join(base, 'chromium', 'NativeMessagingHosts') },
      { browser: 'edge', dir: path.join(base, 'microsoft-edge', 'NativeMessagingHosts') },
      { browser: 'brave', dir: path.join(base, 'BraveSoftware', 'Brave-Browser', 'NativeMessagingHosts') },
    ];
  }
  return [{ browser: 'chrome', dir: path.join(process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), 'opencli-mcp') }];
}

/**
 * Profiles of Chromium browsers running right now with a custom --user-data-dir (Chrome for Testing, dev profiles,
 * test harnesses). Chrome resolves user-level Native Messaging hosts under that directory, so the manifest must be
 * written there too — the single most common reason initial setup "did nothing".
 */
export function runningProfileDirs(): string[] {
  if (process.platform === 'win32') return [];
  try {
    const out = execFileSync('ps', ['ax', '-o', 'command'], { encoding: 'utf8', stdio: 'pipe', maxBuffer: 16 * 1024 * 1024 });
    const dirs = new Set<string>();
    for (const line of out.split('\n')) {
      if (!/chrome|chromium|edge|brave/i.test(line)) continue;
      const m = /--user-data-dir=("([^"]+)"|(\S+))/.exec(line);
      const d = m?.[2] ?? m?.[3];
      if (d && fs.existsSync(d)) dirs.add(d);
    }
    return [...dirs];
  } catch { return []; }
}

export function registerHost(opts: { browsers?: string[]; userDataDirs?: string[] } = {}): { launcher: string; manifests: Array<{ browser: string; file: string; written: boolean }> } {
  const supported = nativeHostDirs();
  const unknown = opts.browsers?.filter((browser) => !supported.some((target) => target.browser === browser));
  if (unknown?.length) throw new Error(`Unknown browser(s): ${unknown.join(', ')}. Supported: ${supported.map((target) => target.browser).join(', ')}.`);
  const launcher = writeLauncher(path.join(projectRoot(), 'dist', 'src', 'main.js'));
  const manifest = { name: NATIVE_HOST_NAME, description: 'opencli-mcp browser runtime host', path: launcher, type: 'stdio', allowed_origins: [`chrome-extension://${EXTENSION_ID}/`] };
  const manifests: Array<{ browser: string; file: string; written: boolean }> = [];
  // Chrome resolves user-level hosts relative to its user data dir: custom --user-data-dir profiles get their own copy
  const profiles = new Set([...(opts.userDataDirs ?? []), ...runningProfileDirs()]);
  const targets = [...supported, ...[...profiles].map((d) => ({ browser: `profile:${d}`, dir: path.join(d, 'NativeMessagingHosts') }))];
  for (const { browser, dir } of targets) {
    if (opts.browsers && !browser.startsWith('profile:') && !opts.browsers.includes(browser)) continue;
    const parent = path.dirname(dir);
    // Always register Chrome, even before its first launch; register other detected or requested browsers too.
    if (!opts.browsers && browser !== 'chrome' && !browser.startsWith('profile:') && !fs.existsSync(parent)) { manifests.push({ browser, file: path.join(dir, `${NATIVE_HOST_NAME}.json`), written: false }); continue; }
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${NATIVE_HOST_NAME}.json`);
    fs.writeFileSync(file, JSON.stringify(manifest, null, 2));
    manifests.push({ browser, file, written: true });
    if (process.platform === 'win32') {
      execFileSync('reg', ['add', `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`, '/ve', '/t', 'REG_SZ', '/d', file, '/f'], { stdio: 'pipe' });
    }
  }
  return { launcher, manifests };
}

export function unregisterHost(): string[] {
  const removed: string[] = [];
  for (const { dir } of [...nativeHostDirs(), ...runningProfileDirs().map((d) => ({ dir: path.join(d, 'NativeMessagingHosts') }))]) {
    const file = path.join(dir, `${NATIVE_HOST_NAME}.json`);
    if (fs.existsSync(file)) { fs.rmSync(file); removed.push(file); }
  }
  return removed;
}
