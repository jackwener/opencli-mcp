/** Persistent Node REPL with a per-session worker and a bridge to the existing object model. */
import { Worker } from 'node:worker_threads';
import { Tab } from '../api/tab.js';
import { Browser } from '../api/browser.js';

export interface JsRunResult { value: unknown; writes: string[]; images: Array<{ mimeType: string; base64: string }>; error?: { name: string; message: string; stack?: string; code?: string; hint?: string; data?: Record<string, unknown> } }
export interface JsImage { mimeType?: string; base64?: string; bytes?: Uint8Array | ArrayBuffer }
type ActiveRun = { id: number; output: JsRunResult; finish: (result: JsRunResult) => void };

export class JsSession {
  private worker?: Worker;
  private active?: ActiveRun;
  private tail: Promise<unknown> = Promise.resolve();
  private generation = 0;
  private disposed = false;
  private cleanup?: Promise<void>;
  private cleanupError?: string;
  private references = new Map<number, any>();
  private identities = new WeakMap<object, number>();
  private pendingCalls = 0;
  private drainWaiters = new Set<() => void>();
  runs = 0;

  constructor(private readonly globals: Record<string, unknown>, private readonly onReset?: () => Promise<void>) {}

  status(): { state: 'idle' | 'running' | 'draining'; generation: number; pendingCalls: number; cleanupError?: string } {
    return { state: this.active ? 'running' : (this.pendingCalls || this.cleanup) ? 'draining' : 'idle', generation: this.generation, pendingCalls: this.pendingCalls + (this.cleanup ? 1 : 0), ...(this.cleanupError && { cleanupError: this.cleanupError }) };
  }

  reset(): { reset: true; pendingCalls: number } {
    this.stop('js_reset', 'JavaScript execution was reset.');
    return { reset: true, pendingCalls: this.pendingCalls + (this.cleanup ? 1 : 0) };
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.stop('js_closed', 'JavaScript session was closed.');
    // A dispatched tab creation may finish after the worker exits. Drain it before browser cleanup.
    if (this.pendingCalls) await new Promise<void>(resolve => { this.drainWaiters.add(resolve); });
    await this.cleanup;
  }

  run(code: string, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<JsRunResult> {
    const generation = this.generation;
    const next = this.tail.then(() => {
      if (opts.signal?.aborted) return this.failure('js_cancelled', 'This call was cancelled before execution.');
      if (this.disposed || generation !== this.generation) return this.failure('js_reset', 'The session changed before this queued call could start.', 'Inspect the session and resubmit only the code you still need.');
      if (this.pendingCalls || this.cleanup) return this.failure('js_busy', 'An earlier browser/API operation is still completing.', 'Call doctor to inspect javascript.pendingCalls before submitting more code.');
      return this.execute(code, opts.timeoutMs ?? 300_000, opts.signal);
    });
    this.tail = next.catch(() => {});
    return next;
  }

  private failure(code: string, message: string, hint?: string): JsRunResult {
    return { value: undefined, writes: [], images: [], error: { name: 'Error', code, message, hint } };
  }

  private stop(code: string, message: string): void {
    const worker = this.worker;
    this.worker = undefined;
    this.generation++;
    if (worker) void worker.terminate().catch(() => {});
    const active = this.active;
    if (active) active.finish({ ...active.output, error: { name: 'Error', code, message,
      hint: 'JavaScript bindings were cleared. Already dispatched API operations may still complete; inspect the page before retrying.',
      data: { bindingsCleared: true, pendingCalls: this.pendingCalls } } });
    this.references.clear();
    this.identities = new WeakMap();
    if (this.onReset && !this.cleanup) {
      this.cleanupError = undefined;
      this.cleanup = (async () => {
        if (this.pendingCalls) await new Promise<void>(resolve => this.drainWaiters.add(resolve));
        await this.onReset!();
      })().catch(error => { this.cleanupError = `Subscription cleanup failed: ${String(error)}. Retry js_reset.`; }).finally(() => { this.cleanup = undefined; });
    }
  }

  private reference(value: object): unknown {
    let id = this.identities.get(value);
    if (id === undefined) { id = this.references.size + 1; this.identities.set(value, id); this.references.set(id, value); }
    const summary = value instanceof Tab || value instanceof Browser ? value.toJSON() : { type: 'API' };
    const props = value instanceof Browser ? { id: value.id, type: value.type } : value instanceof Tab ? { ...summary, tabId: value.tabId } : summary;
    return { $remote: id, callable: typeof value === 'function', props, summary };
  }

  private encode(value: any): any {
    if (value instanceof Tab || value instanceof Browser || typeof value === 'function') return this.reference(value);
    if (!value || typeof value !== 'object') return value;
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return value;
    return Array.isArray(value) ? value.map(v => this.encode(v)) : Object.fromEntries(Object.entries(value).map(([k, v]) => [k, this.encode(v)]));
  }

  private decode(value: any): any {
    if (!value || typeof value !== 'object') return value;
    if (value.$remote !== undefined) {
      let result = this.references.get(value.$remote);
      for (const key of value.path ?? []) result = result?.[key];
      return result;
    }
    if (value.$function !== undefined) return value.$function;
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return value;
    return Array.isArray(value) ? value.map(v => this.decode(v)) : Object.fromEntries(Object.entries(value).map(([k, v]) => [k, this.decode(v)]));
  }

  private appendWrite(output: JsRunResult, entry: string): void {
    const remaining = 24_000 - output.writes.join('\n').length;
    const hint = '[output truncated; keep large data in a variable and return a summary]';
    if (remaining > 0) output.writes.push(entry.length <= remaining ? entry : `${entry.slice(0, remaining)}\n${hint}`);
    else if (!output.writes.at(-1)?.endsWith(hint)) output.writes.push(hint);
  }

  private startWorker(): Worker {
    if (this.worker) return this.worker;
    const globals = Object.fromEntries(Object.entries(this.globals).map(([name, value]) => [name, name === 'sites' ? this.reference(value as object) : this.encode(value)]));
    const worker = new Worker(new URL('./js-worker.mjs', import.meta.url), { workerData: { globals }, execArgv: [], stdout: true, stderr: true });
    this.worker = worker;
    // Node modules may print outside the injected console. Never let that corrupt Native Messaging/stdio.
    for (const stream of [worker.stdout, worker.stderr]) stream.on('data', data => {
      if (worker === this.worker && this.active) this.appendWrite(this.active.output, String(data));
    });
    worker.on('message', (message) => {
      if (worker !== this.worker) return;
      if (message.kind === 'call') { void this.call(worker, message); return; }
      const active = this.active;
      if (!active || active.id !== message.run) return;
      try {
        const value = this.decode(message.value);
        if (message.kind === 'write' || message.kind === 'log') {
          const fmt = (v: unknown) => typeof v === 'string' ? v : safeStringify(v, 24_000);
          const entry = message.kind === 'log' ? value.values.map(fmt).join(' ') : fmt(value);
          this.appendWrite(active.output, entry);
        } else if (message.kind === 'image') active.output.images.push(normalizeImage(value));
        else if (message.kind === 'done') {
          if (this.pendingCalls) { this.stop('command_outcome_unknown', 'The snippet returned with API work still in flight. Await every API call.'); return; }
          active.output.value = extractImages(value, active.output.images);
          active.output.error = message.error;
          active.finish(active.output);
        }
      } catch (error) { active.finish({ ...active.output, error: { name: 'Error', message: String(error) } }); }
    });
    worker.on('error', error => { if (worker === this.worker) this.stop('js_worker_failed', error.message); });
    worker.on('exit', () => { if (worker === this.worker) this.stop('js_worker_exited', 'The JavaScript worker exited.'); });
    worker.unref();
    return worker;
  }

  private async call(worker: Worker, message: any): Promise<void> {
    if (this.active?.id !== message.run) {
      worker.postMessage({ kind: 'reply', id: message.id, error: { code: 'js_inactive', message: 'This js call has finished. Await all API operations before returning.' } });
      return;
    }
    this.pendingCalls++;
    try {
      let target = this.references.get(message.target);
      let receiver: any;
      for (const key of message.path) { receiver = target; target = target?.[key]; }
      if (typeof target !== 'function') throw Object.assign(new Error(`Unknown API method ${message.path.join('.')}`), { code: 'unknown_method', hint: 'Read docs_get for the relevant API topic.' });
      const args = this.decode(message.args);
      // Page functions cross as source, never execute in the host or capture host closures.
      if (message.path.at(-1) === 'evaluate' && message.args[0]?.$function) args[0] = message.args[0];
      const value = await Reflect.apply(target, receiver, args);
      if (worker === this.worker) worker.postMessage({ kind: 'reply', id: message.id, value: this.encode(value) });
    } catch (error) {
      const e = error as Error & { code?: string; hint?: string; data?: unknown };
      if (worker === this.worker) worker.postMessage({ kind: 'reply', id: message.id, error: { name: e.name, message: e.message, code: e.code, hint: e.hint, data: e.data } });
    } finally {
      this.pendingCalls--;
      if (!this.pendingCalls) { for (const resolve of this.drainWaiters) resolve(); this.drainWaiters.clear(); }
    }
  }

  private execute(code: string, timeoutMs: number, signal?: AbortSignal): Promise<JsRunResult> {
    return new Promise(resolve => {
      const worker = this.startWorker();
      worker.ref();
      const id = ++this.runs;
      const timer = setTimeout(() => this.stop(this.pendingCalls ? 'command_outcome_unknown' : 'js_timeout', `JavaScript exceeded ${timeoutMs} ms and was stopped.`), timeoutMs);
      const cancel = () => this.stop(this.pendingCalls ? 'command_outcome_unknown' : 'js_cancelled', 'JavaScript execution was cancelled.');
      this.active = { id, output: { value: undefined, writes: [], images: [] }, finish: result => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
        this.active = undefined;
        worker.unref();
        resolve(result);
      } };
      signal?.addEventListener('abort', cancel, { once: true });
      worker.postMessage({ kind: 'run', run: id, code });
    });
  }
}

function extractImages(value: any, images: JsRunResult['images']): unknown {
  if (isImageValue(value)) { images.push(normalizeImage(value)); return { image: value.mimeType }; }
  if (value instanceof Tab || value instanceof Browser) return value.toJSON();
  if (!value || typeof value !== 'object' || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return value;
  return Array.isArray(value) ? value.map(v => extractImages(v, images)) : Object.fromEntries(Object.entries(value).map(([key, v]) => [key, extractImages(v, images)]));
}

function isImageValue(v: unknown): v is { __image: true; mimeType: string; base64: string } {
  return Boolean(v && typeof v === 'object' && (v as { __image?: boolean }).__image === true && typeof (v as { base64?: unknown }).base64 === 'string');
}

function normalizeImage(img: JsImage): { mimeType: string; base64: string } {
  const mimeType = img.mimeType ?? 'image/png';
  if (img.base64) return { mimeType, base64: img.base64 };
  if (img.bytes) return { mimeType, base64: Buffer.from(img.bytes instanceof ArrayBuffer ? new Uint8Array(img.bytes) : img.bytes).toString('base64') };
  throw new Error('emitImage expects { base64 } or { bytes }');
}

export function safeStringify(v: unknown, limit = 200_000): string {
  const seen = new WeakSet<object>();
  let s: string;
  try {
    s = JSON.stringify(v, (_k, val) => {
      if (typeof val === 'bigint') return val.toString();
      if (typeof val === 'function') return `[function ${val.name || 'anonymous'}]`;
      if (val && typeof val === 'object') { if (seen.has(val)) return '[circular]'; seen.add(val); }
      return val;
    }) ?? String(v);
  } catch { s = String(v); }
  if (s.length <= limit) return s;
  // A cut JSON string is not JSON. Return a valid envelope; preview is the start of the original text.
  const previewBudget = Math.max(0, limit - 80);
  const body = { truncated: true, chars: s.length, limit, preview: s.slice(0, previewBudget) };
  let out = JSON.stringify(body);
  if (out.length > limit && previewBudget > 0) {
    body.preview = s.slice(0, Math.max(0, previewBudget - (out.length - limit)));
    out = JSON.stringify(body);
  }
  return out;
}
