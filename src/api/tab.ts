/**
 * Tab — one browser tab of a session: observe (aria snapshot + semantic diff), find, act, expect, evaluate, screenshot,
 * network/console/dialog/webmcp/frames. A Tab owns the page object bound to its identity; operations are serialized per tab.
 */
import type { RuntimePage } from '../backends/page-types.js';
import { ActionError } from './errors.js';
import { ariaDiff } from './diff.js';
import { networkDetail, networkSummary } from './network.js';
import { ARIA_BUDGET, collapseAria } from '../shared/aria-collapse.js';
import { targetToSelector, fallbackSelector } from '../shared/engine.js';
import type { FindEntry, FindResult, QueryFindResult, ElementAtResult, Expectation, CheckResult, ReadTextResult } from '../shared/page-contract.js';
import type { DialogInfo, DownloadWaitResult, FrameStep } from '../protocol.js';
import type { SessionContext } from './context.js';

export type Target = ({ frame?: FrameStep | FrameStep[]; /** container (css/selector/eN) to resolve inside */ within?: string }) & (
  | { ref: number | string }
  | { selector: string; nth?: number }
  | { role?: string; name?: string; label?: string; text?: string; testid?: string; nth?: number }
  | { x: number; y: number });

export type ActAction = 'click' | 'dblclick' | 'hover' | 'focus' | 'fill' | 'type' | 'press' | 'select' | 'check' | 'uncheck' | 'upload' | 'drag' | 'scroll' | 'back' | 'forward' | 'reload';

export interface ActOptions { target?: Target; action: ActAction; value?: string; files?: string[]; to?: Target; direction?: 'up' | 'down' | 'left' | 'right'; amount?: number; timeoutMs?: number; settleMs?: number; /** click only. `dom` runs HTMLElement.click() and sends no mouse event. Default is a real mouse event. */ method?: 'cdp' | 'dom' }

export interface ObserveOptions { mode?: 'state' | 'screenshot' | 'both'; /** Return a diff only against this exact snapshot id; otherwise return the full state. */ since?: string; /** only the subtree on screen right now (what a screenshot shows). Not a page of the full tree. */ viewport?: boolean; /** open one branch of the action map (`eN` from a collapsed line). Ignores viewport. */ ref?: string; /** overlay eN labels on the screenshot */ annotate?: boolean; fullPage?: boolean }

export interface ReadOptions { /** stop after this many characters. Default 60000. */ maxChars?: number; /** character offset returned as nextStart by a previous read */ start?: number; /** capture id returned by that same read */ readId?: string }

export interface ImageValue { __image: true; mimeType: string; base64: string }



const WRITE_EVAL_RE = /(\.click\s*\(|\.submit\s*\(|\blocation\s*(=|\.href\s*=|\.assign\s*\(|\.replace\s*\()|document\.write|\.remove\s*\(\)|localStorage\.(setItem|removeItem|clear)|\.value\s*=[^=])/;

export class Tab {
  /** A Tab owns the page object bound to its identity; `bound` lets an adapter pass an existing page. */
  /** `id` is the Chrome tab id as a string; `tabId` is the numeric id when claimed from a user tab. */
  readonly tabId?: number;
  constructor(private readonly initialId: string, private readonly ctx: SessionContext, private readonly bound?: RuntimePage, tabId?: number) { this.tabId = tabId; }
  get id(): string { return this.bound?.getActivePage() ?? this.initialId; }
  private closed = false;

  /** Run `fn` on this tab's own page object. Operations are serialized per tab, never across tabs. */
  async use<T>(fn: (page: RuntimePage) => Promise<T>): Promise<T> {
    const state = this.ctx.state;
    const prev = state.tabLocks.get(this.id) ?? Promise.resolve();
    let release!: () => void;
    state.tabLocks.set(this.id, new Promise<void>((r) => { release = r; }));
    try {
      await prev;
      if (this.closed) throw new ActionError('stale_page', `tab ${this.id} was closed`, 'This Tab object is dead; open or claim another tab.');
      if (state.finalized && !state.pages.has(this.id)) throw new ActionError('page_released', `tab ${this.id} was released by finalize`, 'finalize ends the session\'s control of its tabs; open a new tab or claim the tab again (browser.user.claimTab).');
      const page = this.bound ?? await this.ctx.rt.pageFor(this.ctx.sessionId, this.id);
      return await fn(page);
    } finally { release(); }
  }

  async goto(url: string, opts: { waitUntil?: 'load' | 'none'; settleMs?: number } = {}): Promise<{ url: string | null; title: string | null }> {
    if (!/^(https?:\/\/|data:text\/html)/i.test(url)) throw new ActionError('invalid_url', 'Only http(s) (or data:text/html) URLs can be opened', 'Pass an absolute http:// or https:// URL');
    return this.use(async (page) => {
      await page.goto(url, opts);
      await this.harvest(page);
      return this.info(page);
    });
  }

  /**
   * Pull captured requests into the session's bounded network log. Best effort — never fails a step.
   */
  private async harvest(page: RuntimePage): Promise<Array<Record<string, unknown> & { seq: number }>> {
    // best effort: harvesting must never fail the step that just succeeded
    try { const captured = await page.readNetworkCapture().catch(() => [] as unknown[]) as Array<Record<string, unknown>>; return this.logNetwork(captured); } catch { return []; }
  }
  private logNetwork(entries: Array<Record<string, unknown>>): Array<Record<string, unknown> & { seq: number }> {
    let log = this.ctx.state.netLog.get(this.id);
    if (!log) { log = { seq: 0, entries: [], seen: new Set(), bodyChars: 0 }; this.ctx.state.netLog.set(this.id, log); }
    const fresh: Array<Record<string, unknown> & { seq: number }> = [];
    for (const e of entries) {
      const key = String(e.requestId ?? `${e.method ?? 'GET'} ${e.url ?? e.name ?? ''} ${e.timestamp ?? e.startTime ?? e.ts ?? ''}`);
      if (log.seen.has(key)) continue;
      log.seen.add(key);
      const entry: Record<string, unknown> & { seq: number } = { ...e, seq: ++log.seq }; log.entries.push(entry); fresh.push(entry);
      log.bodyChars += String(entry.requestBodyPreview ?? '').length + String(entry.responsePreview ?? '').length;
    }
    while (log.entries.length > 2000 || log.bodyChars > 32_000_000 && log.entries.length > 1) {
      const oldest = log.entries.shift()! as Record<string, unknown>;
      log.bodyChars -= String(oldest.requestBodyPreview ?? '').length + String(oldest.responsePreview ?? '').length;
    }
    if (log.seen.size > 8000) log.seen.clear(); // bounded: the extension drains captured entries, so re-dup is rare
    return fresh;
  }
  private async info(page: RuntimePage): Promise<{ url: string | null; title: string | null }> {
    const url = await page.getCurrentUrl().catch(() => null);
    const title = await page.evaluate<string>('document.title').catch(() => null);
    return { url, title };
  }
  async url(): Promise<string | null> { return this.use((p) => p.getCurrentUrl()); }
  async title(): Promise<string | null> { return this.use((p) => p.evaluate<string>('document.title')); }
  async back(): Promise<void> { await this.use((p) => p.history('back')); }
  async forward(): Promise<void> { await this.use((p) => p.history('forward')); }
  async reload(): Promise<void> { await this.use((p) => p.history('reload')); }
  /** Close this tab, whether it was opened or claimed by this session. */
  async close(): Promise<void> { await this.use((p) => p.closeTab(this.id)); this.closed = true; this.ctx.rt.forgetPage(this.ctx.sessionId, this.id); }
  /** Keep this tab open and give up this session's control of it. */
  async release(): Promise<void> { await this.use((p) => p.releaseTab(this.id)); this.closed = true; this.ctx.rt.forgetPage(this.ctx.sessionId, this.id); }

  async observe(opts: ObserveOptions = {}): Promise<{ url: string | null; title: string | null; state?: string; snapshotId?: string; diff?: boolean; changed?: { added: number; removed: number; changed?: number }; image?: ImageValue }> {
    const mode = opts.mode ?? 'state';
    return this.use(async (page) => {
      const meta = await this.info(page);
      const out: { url: string | null; title: string | null; state?: string; snapshotId?: string; diff?: boolean; changed?: { added: number; removed: number; changed?: number }; image?: ImageValue } = { ...meta };
      if (mode === 'state' || mode === 'both') {
        // one state source: Playwright's aria snapshot (credential values redacted); its [ref=eN] are the act targets
        let text = String(await page.pageCall('aria', { viewport: Boolean(opts.viewport) && !opts.ref, ...(opts.ref ? { ref: opts.ref } : {}) }));
        const key = `${this.id}:${opts.viewport && !opts.ref ? 'vp' : 'all'}:${opts.ref ?? ''}`;
        const prev = this.ctx.state.lastObserve.get(key);
        const snapshotId = `${++this.ctx.state.observationSeq}`;
        this.ctx.state.lastObserve.set(key, { id: snapshotId, text });
        out.snapshotId = snapshotId;
        const diffOn = Boolean(opts.since && prev?.id === opts.since);
        // the tail line ("Focused: …") is state, not structure: diff the tree, then re-append the current focus
        const split = (t: string) => { const i = t.lastIndexOf('\nFocused: '); return i >= 0 ? [t.slice(0, i), t.slice(i + 1)] : [t, '']; };
        const [tree, focus] = split(text); const [prevTree] = prev ? split(prev.text) : [''];
        if (diffOn && prev && prevTree !== tree) {
          const d = ariaDiff(prevTree, tree);
          if (d.changedRatio < 0.6) { out.diff = true; out.changed = { added: d.added, removed: d.removed, changed: d.changed }; text = `${d.text || '(no visible change)'}${focus ? `\n${focus}` : ''}`; }
        } else if (diffOn && prev && prevTree === tree) { out.diff = true; out.changed = { added: 0, removed: 0, changed: 0 }; text = `There has been no change since the last observe.${focus ? `\n${focus}` : ''}`; }
        // Diff compared the whole tree. Collapse only the copy the model sees, so a change inside a folded branch is not "no change".
        const unchanged = out.diff === true && out.changed?.added === 0 && out.changed?.removed === 0 && (out.changed?.changed ?? 0) === 0;
        out.state = unchanged ? text : collapseAria(text, ARIA_BUDGET).text;
      }
      if (mode === 'screenshot' || mode === 'both') out.image = await this.screenshotOn(page, { annotate: opts.annotate, fullPage: opts.fullPage });
      return out;
    });
  }

  async screenshot(opts: { fullPage?: boolean; annotate?: boolean; format?: 'png' | 'jpeg'; quality?: number } = {}): Promise<ImageValue> {
    return this.use((page) => this.screenshotOn(page, opts));
  }
  private async screenshotOn(page: RuntimePage, opts: { fullPage?: boolean; annotate?: boolean; format?: 'png' | 'jpeg'; quality?: number }): Promise<ImageValue> {
    // annotate = eN labels of the last aria snapshot drawn by the page module for the capture only
    if (opts.annotate) await page.pageCall('annotate');
    try {
      const b64 = await page.screenshot({ fullPage: opts.fullPage, format: opts.format, quality: opts.quality });
      return { __image: true, mimeType: opts.format === 'jpeg' ? 'image/jpeg' : 'image/png', base64: b64 };
    } finally { if (opts.annotate) await page.pageCall('unannotate').catch(() => {}); }
  }

  async find(target: (Target & { limit?: number }) | { query: string; limit?: number }): Promise<FindResult | ElementAtResult | QueryFindResult> {
    return this.use(async (page) => {
      if ('query' in target) return await page.pageCall('findByQuery', { query: target.query, limit: target.limit ?? 20 }) as QueryFindResult;
      // a viewport point (screenshot coordinates) → the element there and its ancestors, as locators
      if ('x' in target) return await page.pageCall('elementAt', { x: target.x, y: target.y }) as ElementAtResult;
      // same engine and the same compiled selector as act: what find lists is exactly what act would resolve
      const spec = target as Record<string, unknown>;
      const selector = targetToSelector(spec);
      if (!selector) throw new ActionError('invalid_target', 'find needs a selector, an aria ref (eN), a semantic locator (role/name/label/text/testid), or a point {x,y}', 'Pass one of: {ref} from observe, {selector}, {role,name}, {label}, {text}, {testid}, or {x,y}.');
      return await page.pageCall('find', { selector, fallback: fallbackSelector(spec), limit: target.limit ?? 20 }) as FindResult;
    });
  }

  /**
   * Linear text of a bounded document. Scrolls to mount lazy content, retains repeated text from distinct nodes, restores the scroll position.
   * No refs. A feed that grows without a bottom returns reason `unbounded` and the head already read — do not call it again to finish the feed.
   */
  async read(opts: ReadOptions = {}): Promise<ReadTextResult> {
    return this.use(async (page) => {
      if (opts.start !== undefined && !opts.readId) throw new ActionError('invalid_args', 'Continuing a read requires both readId and start.', 'Copy readId and nextStart from the previous tab_read result.');
      const r = await page.pageCall('readText', opts) as ReadTextResult;
      if (r.reason === 'stale') throw new ActionError('stale_read', 'This page no longer has that text capture.', 'Call tab_read without readId to start a new capture.');
      return r;
    });
  }

  /** wait + act in one call at the runtime edge: locate → wait actionable → hit-test → real input → settle. `method:'dom'` skips the mouse event. */
  async act(opts: ActOptions): Promise<Record<string, unknown>> {
    const { action } = opts;
    return this.use(async (page) => {
      try {
        const capture = this.ctx.rt.hasFeature('network');
        if (capture) await this.harvest(page);
        const networkFrom = this.ctx.state.netLog.get(this.id)?.seq ?? 0;
        // use the page already held by this.use(): calling this.reload()/back()/forward() here would re-enter the session lock and deadlock
        if (action === 'back' || action === 'forward' || action === 'reload') {
          const h = await page.history(action);
          if (capture) await this.harvest(page);
          return { action, ...h, delivery: 'applied', controlState: 'unverified', ...(capture && { network: { afterSequence: networkFrom, cursor: this.ctx.state.netLog.get(this.id)?.seq ?? networkFrom } }) };
        }
        if (action === 'scroll' && !opts.target) {
          // no target: wheel at the viewport centre
          const vp = await page.evaluate<{ x: number; y: number }>('({ x: innerWidth / 2, y: innerHeight / 2 })');
          opts = { ...opts, target: { x: vp.x, y: vp.y } };
        }
        if (!opts.target) throw new ActionError('missing_target', `action "${action}" needs a target`, 'Pass a target: a {ref} from observe, or a selector/role+name/label/text/testid.');
        const r = await page.act({ kind: action, target: opts.target as Record<string, unknown>, value: opts.value, files: opts.files, to: opts.to as Record<string, unknown> | undefined, direction: opts.direction, amount: opts.amount, timeoutMs: opts.timeoutMs, settleMs: opts.settleMs ?? 600, cursor: this.ctx.rt.cursorEnabled, ...(opts.method ? { method: opts.method } : {}) });
        if (capture) await this.harvest(page);
        const delivery = r.method === 'dom' || ['fill', 'check', 'uncheck', 'select', 'upload', 'focus'].includes(action) ? 'applied' : action === 'click' || action === 'dblclick' ? 'received' : 'dispatched';
        const controlVerified = r.verified === true || (action === 'check' && r.checked === true) || (action === 'uncheck' && r.checked === false) || (action === 'select' && Array.isArray(r.selected) && r.selected.length > 0);
        // Return the outcome and the fields needed to choose the next action.
        return {
          action,
          delivery,
          controlState: controlVerified ? 'verified' : 'unverified',
          ...(capture && { network: { afterSequence: networkFrom, cursor: this.ctx.state.netLog.get(this.id)?.seq ?? networkFrom } }),
          ...(r.matches_n > 1 ? { matches_n: r.matches_n } : {}),
          ...(r.navigated ? { navigated: true, ...(r.url !== undefined && { url: r.url }) } : {}),
          ...(r.ref ? { ref: r.ref } : {}),
          ...(r.filled !== undefined ? { filled: r.filled, verified: r.verified, actual: r.actual } : {}),
          ...(r.checked !== undefined ? { checked: r.checked, changed: r.changed } : {}),
          ...(r.selected !== undefined ? { selected: r.selected } : {}),
          ...(r.files !== undefined ? { files: r.files } : {}),
          ...(r.openedTabs?.length ? { openedTabs: r.openedTabs.map(({ page, tabId, url, title, pending }) => ({ ...(page && { tab: page }), tabId, url, title, ...(pending && { pending }) })) } : {}),
          ...(r.download ? { download: r.download } : {}),
          ...(action === 'click' && r.method === 'dom' ? { method: 'dom' as const } : {}),
        };
      } catch (err) {
        if (err instanceof ActionError) throw err;
        const e = err as { code?: string; message?: string; hint?: string; data?: unknown };
        throw new ActionError(e.code ?? 'action_failed', e.message ?? String(err), e.hint, e.data && typeof e.data === 'object' ? e.data as Record<string, unknown> : undefined);
      }
    });
  }

  /** WebMCP: tools the page itself registers via navigator.modelContext (page-provided tool source). */
  readonly webmcp = {
    list: async (): Promise<Array<{ name: string; description?: string; inputSchema?: unknown }>> => this.use(async (p) => {
      const r = await p.evaluate(`(async () => { const mc = navigator.modelContext || document.modelContext; if (!mc || typeof mc.getTools !== 'function') return []; const tools = await mc.getTools(); return (tools || []).map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })); })()`);
      return Array.isArray(r) ? r as Array<{ name: string; description?: string; inputSchema?: unknown }> : [];
    }),
    call: async (name: string, input: Record<string, unknown> = {}): Promise<unknown> => this.use(async (p) => {
      return p.evaluateWithArgs(`(async () => { const mc = navigator.modelContext || document.modelContext; if (!mc) throw new Error('page exposes no modelContext'); if (typeof mc.executeTool === 'function') return await mc.executeTool(name, input); const tools = await mc.getTools(); const t = (tools || []).find(x => x.name === name); if (!t || typeof t.execute !== 'function') throw new Error('unknown page tool ' + name); return await t.execute(input); })()`, { name, input });
    }),
  };

  /** Assert what the page must show now (polled up to timeoutMs). */
  async expect(what: Expectation, opts: { timeoutMs?: number } = {}): Promise<CheckResult> {
    return this.use(async (page) => {
      try { return await page.expect(what, opts); }
      catch (err) { const e = err as { code?: string; message?: string; hint?: string; extra?: Record<string, unknown> }; throw new ActionError(e.code ?? 'expectation_failed', e.message ?? String(err), e.hint, e.extra); }
    });
  }

  /** Read-only page evaluation. */
  async evaluate(js: string, opts: { allowWrite?: boolean; frame?: number } = {}): Promise<unknown> {
    if (!opts.allowWrite && WRITE_EVAL_RE.test(js)) throw new ActionError('evaluate_read_only', 'evaluate is read-only; use act() for clicks, typing, navigation and form changes', 'Pass allowWrite:true only when the user explicitly wants a scripted page change.');
    return this.use(async (page) => {
      return opts.frame !== undefined ? page.evaluateInFrame(js, opts.frame) : page.evaluate(js);
    });
  }

  /** Native alert/confirm/prompt dialogs block the page; commands fail with `dialog_open` until answered. */
  readonly dialog = {
    get: async (): Promise<DialogInfo | null> => this.use(async (p) => (await p.dialog('get')).dialog),
    accept: async (text?: string): Promise<DialogInfo | null> => this.use(async (p) => (await p.dialog('accept', text)).dialog),
    dismiss: async (): Promise<DialogInfo | null> => this.use(async (p) => (await p.dialog('dismiss')).dialog),
  };

  /** Console messages and uncaught exceptions since the tab was attached (the plugin's tab.dev.logs); cursor-paged like network.read. */
  readonly console = {
    read: async (opts: { afterSequence?: number; limit?: number; levels?: Array<'debug' | 'info' | 'log' | 'warn' | 'error'>; filter?: string } = {}) => this.use((p) => p.consoleLogs(opts)),
  };

  readonly network = {
    start: async (pattern = ''): Promise<boolean> => this.use((p) => p.startNetworkCapture(pattern)),
    list: async (opts: { filter?: string; limit?: number; afterSequence?: number } = {}): Promise<{ cursor: number; entries: Record<string, unknown>[]; hasMore: boolean }> => {
      const raw = await this.network.read({ pattern: opts.filter, limit: opts.limit ?? 30, afterSequence: opts.afterSequence });
      return { ...raw, entries: (raw.entries as Array<Record<string, unknown> & { seq: number }>).map(networkSummary) };
    },
    detail: async (opts: { seq?: number; requestId?: string; part?: 'request' | 'response'; start?: number; maxChars?: number }): Promise<Record<string, unknown>> => this.use(async (p) => {
      await this.harvest(p);
      const log = this.ctx.state.netLog.get(this.id);
      const entry = log?.entries.find((e) => opts.seq !== undefined ? e.seq === opts.seq : opts.requestId !== undefined && e.requestId === opts.requestId);
      if (!entry) throw new ActionError('network_entry_not_found', 'No captured request matches this seq or requestId.', 'Call network.list() and copy its seq.');
      return networkDetail(entry, opts);
    }),
    /**
     * Cursor-paged read: pass `afterSequence` from the previous result to get only new requests. Returns network rows
     * only; endpoint candidates come from the explicit `recon.discover(tab)` (not a hidden side effect of reading).
     */
    read: async (opts: { pattern?: string; limit?: number; includeStatic?: boolean; afterSequence?: number } = {}): Promise<{ cursor: number; entries: unknown[]; hasMore: boolean }> => this.use(async (p) => {
      await this.harvest(p);
      let log = this.ctx.state.netLog.get(this.id);
      // Interactive tabs use CDP capture as the authoritative log. Adapter tabs are not armed by default,
      // so they may fall back to Performance entries when their capture is empty.
      if ((!log || !log.entries.length) && p.surface === 'adapter') { this.logNetwork(await p.networkRequests(opts.includeStatic ?? false).catch(() => []) as Array<Record<string, unknown>>); log = this.ctx.state.netLog.get(this.id)!; }
      const after = opts.afterSequence ?? 0;
      const matching = (log?.entries ?? []).filter((e) => e.seq > after && (!opts.pattern || String(e.url ?? e.name ?? '').includes(opts.pattern)));
      const limit = opts.limit ?? 100;
      const page = matching.slice(0, limit);
      return { cursor: page.length ? page[page.length - 1].seq : after, entries: page, hasMore: matching.length > limit };
    }),
  };
  async cookies(domain: string): Promise<unknown[]> { return this.use((p) => p.getCookies({ domain })); }
  /**
   * Read one cookie's value at run time — useful for per-request tokens an adapter needs (csrf/ct0/
   * csrftoken/XSRF-TOKEN). Defaults to the current page's host. Returns undefined when the cookie is absent.
   */
  async cookie(name: string, opts: { domain?: string } = {}): Promise<string | undefined> {
    let domain = opts.domain;
    if (!domain) { const u = await this.url().catch(() => null); try { domain = u ? new URL(u).hostname : undefined; } catch { domain = undefined; } }
    const list = await this.use((p) => p.getCookies(domain ? { domain } : {})) as Array<{ name?: string; value?: string }>;
    return list.find((c) => c?.name === name)?.value;
  }
  /** Fetch JSON through the page (its cookies and origin) after verifying the endpoint. */
  async fetchJson(url: string, opts: Record<string, unknown> = {}): Promise<unknown> { return this.use((p) => p.fetchJson(url, opts as never)); }
  async frames(): Promise<Array<{ index: number; frameId: string; url: string; name: string; crossOrigin?: boolean; oopif?: boolean }>> { return this.use((p) => p.frames()); }
  /** Wait for the page download begun after a tab_act cursor, then check Chrome's file state. */
  async download(afterSequence: number, timeoutMs = 30_000): Promise<DownloadWaitResult> { return this.use((p) => p.waitForDownload(afterSequence, timeoutMs)); }
}
