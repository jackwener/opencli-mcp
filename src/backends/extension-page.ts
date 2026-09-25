/** The page transport over the extension bridge; interactions use the shared act engine. */
import type { ExtensionBridge } from '../host/bridge.js';
import { BrowserCommandError } from '../host/bridge.js';
import { wrapForEval, waitForDomStableJs, networkRequestsJs } from './browser-helpers.js';
import type { RuntimePage } from './page-types.js';
import type { Command, ActSpec, ActResult, DialogInfo, ConsoleEntry, CloseUserTabsResult, DownloadWaitResult } from '../protocol.js';
import { pageCallJs, ActError } from '../shared/engine.js';
import type { Expectation, CheckResult } from '../shared/page-contract.js';

export interface ExtensionPageOptions {
  session: string;
  surface: 'browser' | 'adapter';
  /** bind this page object to one tab identity for its whole life (per-Tab pages); omitted = session-scope page with no tab */
  page?: string;
}

export interface UserTabInfo { tabId: number; title?: string; url?: string; windowId: number; active: boolean; groupId?: number; lastAccessed?: number }

/** Extra methods available on extension-backed pages. */
export interface ExtensionPageExtras {
  nameSession(name: string): Promise<void>;
  userTabs(options?: { query?: string; limit?: number }): Promise<UserTabInfo[]>;
  claim(tab: { tabId?: number; active?: boolean; title?: string; url?: string; expectedUrl?: string; expectedTitle?: string }): Promise<{ page: string; tabId: number; url?: string; title?: string }>;
  closeUserTabs(tabIds: number[]): Promise<CloseUserTabsResult>;
  mark(page: string, mark: 'deliverable' | 'handoff' | null): Promise<void>;
  finalize(keep: Array<{ page: string; status: 'deliverable' | 'handoff' }>): Promise<{ closed: string[]; kept: string[]; failed: Array<{ page: string; reason: string }> }>;
  cursor(x: number, y: number, opts?: { waitForArrival?: boolean }): Promise<void>;
  setVisibility(visible: boolean): Promise<void>;
  getVisibility(): Promise<boolean>;
}

export type ExtensionRuntimePage = RuntimePage & ExtensionPageExtras;

/** Only retry errors indicating the execution target changed during navigation. */
function isNavigationError(err: unknown): boolean {
  const code = err instanceof BrowserCommandError ? err.code : undefined;
  if (code === 'target_navigated') return true;
  if (code && ['attach_failed', 'tab_gone', 'detached_mid_command', 'cdp_timeout'].includes(code)) return false;
  const message = err instanceof Error ? err.message : String(err);
  return message.includes('Inspected target navigated or closed') || (message.includes('-32000') && /target|context/i.test(message));
}

class ExtensionPage implements ExtensionRuntimePage {
  readonly session: string;
  readonly surface: 'browser' | 'adapter';
  private readonly bridge: ExtensionBridge;
  private readonly opts: ExtensionPageOptions;
  private _page: string | undefined;
  private _lastUrl: string | null = null;
  /** A page bound to one tab never adopts another, including after a lazy adapter tab is created. */
  private bound: boolean;
  private closed = false;

  constructor(bridge: ExtensionBridge, opts: ExtensionPageOptions) {
    this.bridge = bridge;
    this.opts = opts;
    this.session = opts.session;
    this.surface = opts.surface;
    this._page = opts.page;
    this.bound = opts.page !== undefined;
  }
  private assertOpen(): void {
    if (this.closed) throw new BrowserCommandError(`tab ${this._page} was closed`, 'stale_page', 'The tab this object was bound to no longer exists; open or claim another tab.');
  }

  private sessionOpts(): Partial<Command> {
    const o = this.opts;
    return { session: o.session, surface: o.surface };
  }
  private cmdOpts(): Partial<Command> { return { ...this.sessionOpts(), ...((this.bound || this.surface === 'adapter') && this._page !== undefined && { page: this._page }) }; }

  private async send(action: Command['action'], params: Partial<Command> = {}): Promise<{ data: unknown; page?: string }> {
    this.assertOpen();
    const result = await this.bridge.send(action, { ...this.cmdOpts(), ...params });
    if (result.page && !this.bound) {
      this._page = result.page;
      if (this.surface === 'adapter') this.bound = true;
    }
    return result;
  }

  async goto(url: string, options?: { waitUntil?: 'load' | 'none'; settleMs?: number }): Promise<void> {
    const result = await this.send('navigate', { url });
    this._lastUrl = url;
    if (options?.waitUntil !== 'none') {
      // We drive the user's real Chrome via the extension — no anti-detection stealth needed; just wait for the DOM to settle.
      const maxMs = options?.settleMs ?? 1000;
      const code = waitForDomStableJs(maxMs, Math.min(500, maxMs));
      try { await this.send('exec', { code }); } catch (err) {
        if (!isNavigationError(err)) throw err;
        await new Promise((r) => setTimeout(r, 200));
        try { await this.send('exec', { code }); } catch (retryErr) { if (!isNavigationError(retryErr)) throw retryErr; }
      }
    }
  }
  getActivePage(): string | undefined { return this._page; }

  async evaluate<T = unknown>(input: string): Promise<T> {
    const code = wrapForEval(input);
    try { return (await this.send('exec', { code })).data as T; } catch (err) {
      if (!isNavigationError(err)) throw err;
      await new Promise((r) => setTimeout(r, 200));
      return (await this.send('exec', { code })).data as T;
    }
  }
  /** Evaluate `js` with named args injected as `const` declarations. */
  async evaluateWithArgs(js: string, args: Record<string, unknown>): Promise<unknown> {
    const declarations = Object.entries(args).map(([key, value]) => {
      if (!/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(key)) throw new Error(`evaluateWithArgs: invalid key "${key}"`);
      return `const ${key} = ${JSON.stringify(value)};`;
    }).join('\n');
    // Wrap in an async IIFE (not a bare `{…}` block): the page evaluates this string via CDP Runtime.evaluate as a
    // script, where a top-level `return` (which `js` uses) is illegal. An IIFE makes the return legal and is passed
    // through unchanged by wrapForEval.
    return this.evaluate(`(async () => {\n${declarations}\n${js}\n})()`);
  }
  /** Fetch JSON through the page with its cookies and origin. */
  async fetchJson(url: string, opts: { method?: string; headers?: Record<string, string>; body?: unknown; timeoutMs?: number } = {}): Promise<unknown> {
    const request = { url, method: opts.method ?? 'GET', headers: opts.headers ?? {}, body: opts.body, hasBody: opts.body !== undefined, timeoutMs: opts.timeoutMs ?? 15_000 };
    const result = await this.evaluateWithArgs(`
      return (async () => {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), request.timeoutMs);
        try {
          const headers = { Accept: 'application/json', ...request.headers };
          const init = { method: request.method, credentials: 'include', headers, signal: ctrl.signal };
          if (request.hasBody) {
            if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json';
            init.body = JSON.stringify(request.body);
          }
          const resp = await fetch(request.url, init);
          const text = await resp.text();
          return { ok: resp.ok, status: resp.status, statusText: resp.statusText, url: resp.url, contentType: resp.headers.get('content-type') || '', text };
        } catch (error) {
          return { ok: false, status: 0, statusText: '', url: request.url, contentType: '', text: '', error: error instanceof Error ? error.message : String(error) };
        } finally { clearTimeout(timer); }
      })()
    `, { request }) as { ok: boolean; status: number; statusText: string; url: string; contentType: string; text: string; error?: string };
    const targetUrl = result.url || url;
    if (result.error) throw new ActError('fetch_error', `Browser fetch failed for ${targetUrl}: ${result.error}`, 'Check that the page is reachable and the current browser profile has access.');
    if (!result.ok) throw new ActError('fetch_error', `HTTP ${result.status ?? 0}${result.statusText ? ` ${result.statusText}` : ''} from ${targetUrl}`, result.text.slice(0, 200));
    const text = result.text ?? '';
    if (!text.trim()) return null;
    try { return JSON.parse(text); } catch { throw new ActError('fetch_error', `Expected JSON from ${targetUrl}${result.contentType ? ` (${result.contentType})` : ''}`, text.slice(0, 200)); }
  }
  async getCookies(opts: { domain?: string; url?: string } = {}): Promise<unknown[]> {
    const r = await this.bridge.send('cookies', { ...this.sessionOpts(), ...opts });
    return Array.isArray(r.data) ? r.data : [];
  }
  async closeWindow(): Promise<void> {
    try { await this.bridge.send('session-finalize', { ...this.sessionOpts(), keep: [] }); } catch { /* ignore */ }
    if (this.bound) this.closed = true; else this._page = undefined;
    this._lastUrl = null;
  }
  async tabs(): Promise<unknown[]> { const r = await this.bridge.send('tabs', { op: 'list', ...this.sessionOpts() }); return Array.isArray(r.data) ? r.data : []; }
  async newTab(url?: string): Promise<string | undefined> {
    const r = await this.bridge.send('tabs', { op: 'new', ...(url !== undefined && { url }), ...this.sessionOpts() });
    this._lastUrl = null;
    return r.page;
  }
  private async endTab(op: 'close' | 'release', target?: string): Promise<void> {
    const params: Partial<Command> = { op, ...this.sessionOpts() };
    if (typeof target === 'string') params.page = target; else if (this._page !== undefined) params.page = this._page;
    await this.bridge.send('tabs', params);
    if (target === undefined || target === this._page) { if (this.bound) this.closed = true; else this._page = undefined; this._lastUrl = null; }
  }
  async closeTab(target?: string): Promise<void> { await this.endTab('close', target); }
  async releaseTab(target?: string): Promise<void> { await this.endTab('release', target); }
  async screenshot(options: { format?: 'png' | 'jpeg'; quality?: number; fullPage?: boolean; width?: number; height?: number } = {}): Promise<string> {
    const r = await this.send('screenshot', { format: options.format, quality: options.quality, fullPage: options.fullPage, width: options.width, height: options.height });
    const b64 = r.data as string;
    return b64;
  }
  async startNetworkCapture(pattern = ''): Promise<boolean> { await this.send('network-capture-start', { pattern }); return true; }
  async readNetworkCapture(): Promise<unknown[]> { const r = await this.send('network-capture-read'); return Array.isArray(r.data) ? r.data : []; }
  /** Page-side performance entries (fallback when CDP capture is unavailable) — a pure helper script, not a locator. */
  async networkRequests(includeStatic = false): Promise<unknown[]> { const r = await this.evaluate(networkRequestsJs(includeStatic)); return Array.isArray(r) ? r : []; }
  async waitForDownload(afterSequence: number, timeoutMs = 30_000): Promise<DownloadWaitResult> { return (await this.send('wait-download', { afterSequence, timeoutMs })).data as DownloadWaitResult; }
  async frames(): Promise<Array<{ index: number; frameId: string; url: string; name: string }>> { const r = await this.send('frames'); return Array.isArray(r.data) ? r.data as Array<{ index: number; frameId: string; url: string; name: string }> : []; }
  async evaluateInFrame(js: string, frameIndex: number): Promise<unknown> { return (await this.send('exec', { code: wrapForEval(js), frameIndex })).data; }
  async cdp(method: string, params?: Record<string, unknown>): Promise<unknown> { return (await this.send('cdp', { cdpMethod: method, cdpParams: params })).data; }

  // ── opencli-mcp extras ──
  async nameSession(name: string): Promise<void> { await this.bridge.send('session-name', { ...this.sessionOpts(), name }); }
  async userTabs(options: { query?: string; limit?: number } = {}): Promise<UserTabInfo[]> { const r = await this.bridge.send('user-tabs', { ...this.sessionOpts(), ...options }); return Array.isArray(r.data) ? r.data as UserTabInfo[] : []; }
  async claim(tab: { tabId?: number; active?: boolean; title?: string; url?: string; expectedUrl?: string; expectedTitle?: string }): Promise<{ page: string; tabId: number; url?: string; title?: string }> {
    const r = await this.bridge.send('claim', { ...this.sessionOpts(), claim: tab });
    const d = (r.data ?? {}) as { tabId?: number; url?: string; title?: string };
    if (!r.page || !Number.isSafeInteger(d.tabId) || d.tabId! <= 0) throw new BrowserCommandError('claim returned no tab identity', 'invalid_response');
    if (!this.bound) this._page = r.page;
    return { page: r.page, tabId: d.tabId!, url: d.url, title: d.title };
  }
  async closeUserTabs(tabIds: number[]): Promise<CloseUserTabsResult> {
    const r = await this.bridge.send('close-user-tabs', { ...this.sessionOpts(), tabIds });
    const result = r.data as CloseUserTabsResult | undefined;
    if (!result || typeof result.complete !== 'boolean' || !Array.isArray(result.closed) || !Array.isArray(result.failed)
      || result.closed.some((id) => !Number.isSafeInteger(id))
      || result.failed.some((failure) => !Number.isSafeInteger(failure?.tabId) || typeof failure.reason !== 'string')) {
      throw new BrowserCommandError('close-user-tabs returned no valid outcome', 'invalid_response');
    }
    return result;
  }
  async mark(page: string, mark: 'deliverable' | 'handoff' | null): Promise<void> { await this.bridge.send('mark', { ...this.sessionOpts(), page, mark }); }
  async finalize(keep: Array<{ page: string; status: 'deliverable' | 'handoff' }>): Promise<{ closed: string[]; kept: string[]; failed: Array<{ page: string; reason: string }> }> {
    const r = await this.bridge.send('session-finalize', { ...this.sessionOpts(), keep });
    if (this.bound) this.closed = true; else this._page = undefined;
    return (r.data ?? { closed: [], kept: [], failed: [] }) as { closed: string[]; kept: string[]; failed: Array<{ page: string; reason: string }> };
  }
  async cursor(x: number, y: number, opts: { waitForArrival?: boolean } = {}): Promise<void> {
    try { await this.send('cursor', { x, y, waitForArrival: opts.waitForArrival ?? true, timeoutMs: 1500 }); } catch (err) {
      if (!(err instanceof BrowserCommandError)) throw err; /* overlay is best-effort */
    }
  }
  async pageCall(fn: string, args?: unknown, timeoutMs?: number): Promise<unknown> { return (await this.send('exec', { code: pageCallJs(fn, args), world: 'engine', ...(timeoutMs && { timeoutMs }) })).data; }
  /** Live URL first; the sticky cache is only the fallback while a navigation is in flight. */
  async getCurrentUrl(): Promise<string | null> {
    try { const u = await this.evaluate('location.href') as unknown; if (typeof u === 'string' && u) { this._lastUrl = u; return u; } }
    catch (err) { if (!isNavigationError(err)) throw err; }
    return this._lastUrl ?? null;
  }
  async consoleLogs(opts: { afterSequence?: number; limit?: number; levels?: string[]; filter?: string } = {}): Promise<{ cursor: number; entries: ConsoleEntry[]; hasMore: boolean }> { return (await this.send('console', { afterSequence: opts.afterSequence, limit: opts.limit, levels: opts.levels, filter: opts.filter })).data as { cursor: number; entries: ConsoleEntry[]; hasMore: boolean }; }
  async history(op: 'reload' | 'back' | 'forward'): Promise<{ url?: string; title?: string; timedOut?: boolean }> { const r = (await this.send('history', { historyOp: op, timeoutMs: 20_000 })).data as { url?: string; title?: string; timedOut?: boolean }; this._lastUrl = r.url ?? null; return r; }
  async dialog(op: 'get' | 'accept' | 'dismiss', text?: string): Promise<{ dialog: DialogInfo | null; handled?: string }> { return (await this.send('dialog', { dialogOp: op, ...(text !== undefined && { text }), timeoutMs: 10_000 })).data as { dialog: DialogInfo | null; handled?: string }; }
  async act(spec: ActSpec): Promise<ActResult> {
    const budget = spec.timeoutMs ?? 3000;
    const r = (await this.send('act', { act: { ...spec, timeoutMs: budget }, timeoutMs: budget + 8000 })).data as ActResult;
    // an action may navigate (link click, Enter in a form): the cached URL from goto is no longer trustworthy
    if (r.navigated) this._lastUrl = r.url ?? null; else if (spec.kind === 'click' || spec.kind === 'dblclick' || spec.kind === 'press') this._lastUrl = null;
    return r;
  }
  async setVisibility(visible: boolean): Promise<void> { await this.bridge.send('visibility', { ...this.sessionOpts(), visible }); }

  // ── Interactions and observations ──
  /** Accessibility snapshot text for browser sessions and adapters. */
  async aria(opts: { viewport?: boolean } = {}): Promise<string> { return String(await this.pageCall('aria', { viewport: Boolean(opts.viewport) })); }
  async expect(what: Expectation, opts: { timeoutMs?: number } = {}): Promise<CheckResult> {
    const deadline = Date.now() + (opts.timeoutMs ?? 5000);
    let last: CheckResult | null = null;
    for (;;) {
      try { last = await this.pageCall('check', what, 3000) as CheckResult; if (last.ok) return last; } catch { /* navigation in flight: retry */ }
      if (Date.now() >= deadline) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    const state = await this.aria({ viewport: true }).catch(() => '');
    throw new ActError('expectation_failed', last ? last.failed.join('; ') : 'page not reachable', 'Observe the page; the flow may need a different step or a wait.', { expect: what as Record<string, unknown>, failed: last?.failed ?? [], url: last?.url, title: last?.title, state: state.slice(0, 4000) });
  }
  async getVisibility(): Promise<boolean> { const r = await this.bridge.send('visibility', { ...this.sessionOpts() }); return Boolean((r.data as { visible?: boolean } | undefined)?.visible); }
}

export async function createExtensionPage(bridge: ExtensionBridge, opts: ExtensionPageOptions): Promise<ExtensionRuntimePage> {
  return new ExtensionPage(bridge, opts);
}
