/**
 * The Chrome-spawned native host: Native Messaging on stdio ⇄ extension, MCP over loopback HTTP.
 * Lives exactly as long as the extension keeps its port open (Chrome's contract) — so the bridge,
 * the port and the debugger attach stay warm together.
 */
import { Writable } from 'node:stream';
import { NativeChannel } from './native-messaging.js';
import { ExtensionBridge } from './bridge.js';
import { Runtime } from '../runtime/runtime.js';
import { startHttpServer } from './http.js';
import { DEFAULT_PORT, clearHostState, loadOrCreateToken, readConfig, writeHostState } from './state.js';

export async function runNativeHost(opts: { version: string }): Promise<void> {
  const log = (m: string): void => { process.stderr.write(`[opencli-mcp host] ${m}\n`); };
  // stdout belongs to Native Messaging: route every other stdout write (console.log, library logs) to stderr
  const rawWrite = process.stdout.write.bind(process.stdout);
  const frames = new Writable({ write(chunk, _enc, cb) { rawWrite(chunk as Buffer, cb); } });
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => (process.stderr.write as (...a: unknown[]) => boolean)(chunk, ...rest)) as typeof process.stdout.write;
  const channel = new NativeChannel(process.stdin, frames);
  const bridge = new ExtensionBridge(channel);
  const config = readConfig();
  const rt = new Runtime({ bridge, cursor: config.cursor ?? true, sites: config.sites, sitesWrite: config.sitesWrite, log });
  await rt.init();
  const token = loadOrCreateToken();
  let http;
  try { http = await startHttpServer(rt, { port: config.port ?? DEFAULT_PORT, token, version: opts.version }); }
  catch (err) { log(`port ${config.port ?? DEFAULT_PORT} busy (${(err as Error).message}); using a random port`); http = await startHttpServer(rt, { port: 0, token, version: opts.version }); }
  bridge.ready = { version: opts.version, port: http.port };
  const state = () => ({ pid: process.pid, port: http.port, host: http.host, token });
  bridge.on('hello', (h) => { log(`extension ${h.extensionVersion} connected`); if (bridge.protocolWarning) log(`warning: ${bridge.protocolWarning}`); writeHostState(state()); });
  if (bridge.connected) { bridge.sendReady(); writeHostState(state()); log(`extension ${bridge.extensionVersion} connected before startup finished`); if (bridge.protocolWarning) log(`warning: ${bridge.protocolWarning}`); }
  rt.on('browser-event', (e) => log(`event ${e.kind}`));
  log(`listening on http://${http.host}:${http.port}/mcp`);

  let closing = false;
  const shutdown = async (reason: string): Promise<void> => {
    if (closing) return; closing = true;
    log(`shutting down (${reason})`);
    await rt.shutdown().catch(() => {});
    await http.close().catch(() => {});
    clearHostState(process.pid);
    process.exit(0);
  };
  channel.on('error', (err) => log(`channel error: ${err.message}`));
  channel.on('close', () => void shutdown('extension port closed'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('uncaughtException', (err) => { log(`uncaught: ${err.stack ?? err}`); void shutdown('uncaught exception'); });
  process.on('unhandledRejection', (err) => log(`unhandled: ${(err as Error)?.stack ?? err}`));
}
