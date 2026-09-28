/**
 * NativeHost — the extension's end of the Native Messaging port. Chrome spawns the host when we
 * connect; while the port is open Chrome keeps this service worker alive and the host keeps the
 * runtime warm. Reconnect immediately on disconnect (backoff) with an alarm as the safety net.
 */
import type { Command, ExtToHost, HostToExt, Result, BrowserEvent, BrowserFeature } from '../../src/protocol.js';
import { NATIVE_HOST_NAME, PROTOCOL_REVISION } from '../../src/protocol.js';

const RECONNECT_ALARM = 'opencli-mcp-reconnect';

export class NativeHost {
  private port: chrome.runtime.Port | null = null;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  status: 'disconnected' | 'connecting' | 'connected' | 'reconnecting' = 'disconnected';
  lastError: string | null = null;

  constructor(private readonly onCommand: (cmd: Command) => Promise<Result>, private readonly application = NATIVE_HOST_NAME) {
    chrome.alarms.onAlarm.addListener((a) => { if (a.name === RECONNECT_ALARM && !this.port) this.connect(); });
  }

  get connected(): boolean { return this.port !== null && this.status === 'connected'; }

  connect(): boolean {
    if (this.port) return true;
    this.status = this.attempt > 0 ? 'reconnecting' : 'connecting';
    let port: chrome.runtime.Port;
    try {
      port = chrome.runtime.connectNative(this.application);
    } catch (err) {
      this.lastError = (err as Error).message;
      this.status = 'disconnected';
      this.scheduleReconnect();
      return false;
    }
    this.port = port;
    const openedAt = Date.now();
    port.onMessage.addListener((msg: HostToExt) => {
      // any frame from the host proves the link is real → reset backoff
      this.attempt = 0; void chrome.alarms.clear(RECONNECT_ALARM);
      void this.handle(msg);
    });
    port.onDisconnect.addListener(() => {
      const err = chrome.runtime.lastError?.message ?? null;
      this.lastError = err;
      this.port = null;
      this.status = 'disconnected';
      const lived = Date.now() - openedAt;
      this.attempt++; // any disconnect without a host frame in between counts as a failure (reset happens on messages)
      if (this.attempt <= 1 || this.attempt % 10 === 0) console.warn(`[opencli-mcp] native host disconnected after ${lived}ms (attempt ${this.attempt})`, err ?? '');
      this.scheduleReconnect();
    });
    this.status = 'connected';
    const features: BrowserFeature[] = ['chrome-api', 'streams', 'extension-logs', 'page-evaluate', 'frames', 'dialogs', 'console', 'downloads', 'visibility', 'webmcp'];
    if (chrome.debugger) features.push('cdp', 'viewport', 'network');
    this.send({ type: 'hello', extensionVersion: chrome.runtime.getManifest().version, protocolRevision: PROTOCOL_REVISION, features });
    return true;
  }

  private scheduleReconnect(): void {
    if (this.timer) return;
    // 1s, 2s, 4s … 30s; after that only the 30s alarm keeps trying (survives SW restarts)
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.attempt, 5));
    if (this.attempt < 6) this.timer = setTimeout(() => { this.timer = null; this.connect(); }, delay);
    chrome.alarms.create(RECONNECT_ALARM, { periodInMinutes: 0.5 });
  }

  send(msg: ExtToHost): void {
    if (!this.port) return;
    try { this.port.postMessage(msg); } catch (err) { console.warn('[opencli-mcp] postMessage failed', err); }
  }
  event(event: BrowserEvent): void { this.send({ type: 'event', event }); }

  private async handle(msg: HostToExt): Promise<void> {
    if (!msg) return;
    if (msg.type === 'ready') { console.log(`[opencli-mcp] host ${msg.version} ready on port ${msg.port}`); return; }
    if (msg.type !== 'command') return;
    const cmd = msg.command;
    let result: Result;
    try { result = await this.onCommand(cmd); }
    catch (err) { result = { id: cmd.id, ok: false, error: (err as Error).message ?? String(err), errorCode: (err as { code?: string }).code ?? 'internal_error' }; }
    this.send({ type: 'result', result });
  }
}
