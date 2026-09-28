// Bundle the extension with esbuild: background service worker + content script; copy static assets.
import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const ext = resolve(root, 'extension');
const out = resolve(ext, 'dist');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

await build({
  entryPoints: [resolve(ext, 'src/background.ts')],
  bundle: true, format: 'esm', target: 'chrome120', platform: 'browser',
  outfile: resolve(out, 'background.js'), sourcemap: false, logLevel: 'warning',
});
await build({
  entryPoints: [resolve(ext, 'src/content/cursor.ts')],
  bundle: true, format: 'iife', target: 'chrome120', platform: 'browser',
  outfile: resolve(out, 'content/cursor.js'), sourcemap: false, logLevel: 'warning',
});
// page-side engine module: installed by the service worker into the isolated world of every frame (see extension/src/world.ts)
await build({
  entryPoints: [resolve(ext, 'src/page/index.ts')],
  bundle: true, format: 'iife', target: 'chrome120', platform: 'browser',
  outfile: resolve(out, 'page.js'), sourcemap: false, logLevel: 'warning',
});
// The extension carries its OWN version (extension/manifest.json), decoupled from the host/npm package version — it is
// bumped and re-released only when the extension itself changes. The build copies it through unchanged.
const manifest = JSON.parse(readFileSync(resolve(ext, 'manifest.json'), 'utf8'));
writeFileSync(resolve(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
cpSync(resolve(ext, 'icons'), resolve(out, 'icons'), { recursive: true });
cpSync(resolve(ext, 'cursor.svg'), resolve(out, 'cursor.svg'));
cpSync(resolve(ext, 'chrome-reference.LICENSE.txt'), resolve(out, 'chrome-reference.LICENSE.txt'));
console.log('extension built →', out);
