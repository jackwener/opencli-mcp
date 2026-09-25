/**
 * Runtime — the resident kernel: site registry, per-MCP-session state, and page backends.
 * Lives inside the Chrome-spawned host. The stdio launcher proxies to this runtime.
 */
import { EventEmitter } from 'node:events';
import type { ExtensionBridge } from '../host/bridge.js';
import type { BrowserEvent } from '../protocol.js';
import { PROTOCOL_REVISION, type BrowserFeature } from '../protocol.js';
import { SiteRegistry, type AdapterCommand } from '../sites/loader.js';
import { runAdapter, type CommandRunResult, type CommandRunError, type PageProvider } from '../sites/executor.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { listDefinedTools, ensureUserSource, deleteTool, type ToolDefinition } from '../sites/define.js';
import { createDraft, tryDraft, activateDraft, discardDraft, type DraftExpectation } from '../sites/drafts.js';
import { defaultSources } from '../lib/sources.js';
import { createExtensionPage, type ExtensionRuntimePage } from '../backends/extension-page.js';
import type { RuntimePage } from '../backends/page-types.js';
import { JsSession } from '../mcp/js-session.js';
import { Tab, createAgentApi, type AgentApi } from '../api/agent.js';

export type Backend = 'extension' | 'none';

export interface RuntimeOptions {
  bridge?: ExtensionBridge | null;
  sites?: string[];
  sitesWrite?: string[];
  cursor?: boolean;
  log?: (msg: string) => void;
}

export interface SessionState {
  id: string;
  name?: string;
  createdAt: number;
  browserPage?: RuntimePage;
  browserPagePromise?: Promise<RuntimePage>;
  /** One page object per tab (same bridge, own identity); the session page above carries no tab and serves session-scope calls. */
  pages: Map<string, RuntimePage>;
  /** Per-tab serialization of page operations. */
  tabLocks: Map<string, Promise<void>>;
  enabledSites: Map<string, { write: boolean }>;
  capabilities: Set<string>;
  js?: JsSession;
  observationSeq: number;
  lastObserve: Map<string, { id: string; text: string }>;
  /** Network entries seen per tab, with monotonically increasing sequence numbers for cursor-based reads. */
  netLog: Map<string, { seq: number; entries: Array<Record<string, unknown> & { seq: number }>; seen: Set<string>; bodyChars: number }>;
  finalized: boolean;
}

export interface DoctorReport {
  backend: Backend;
  extension: { connected: boolean; protocolMatches: boolean; protocolWarning: string | null; version: string | null; protocolRevision: number | null; hostProtocolRevision: number; features: BrowserFeature[] };
  sites: number;
  commands: number;
  definedTools: number;
  sessions: number;
  cursor: boolean;
}

export interface RuntimeEvents {
  'browser-event': [BrowserEvent];
  'features-changed': [BrowserFeature[]];
  'tools-changed': [{ site?: string }];
  log: [string];
}

export class Runtime extends EventEmitter<RuntimeEvents> implements PageProvider {
  readonly registry = new SiteRegistry(defaultSources());
  readonly sessions = new Map<string, SessionState>();
  private readonly adapterRuns = new Map<string, Promise<void>>();
  private readonly adapterCallContext = new AsyncLocalStorage<{ sites: Set<string>; retired: boolean }>();
  private readonly siteApis = new Map<string, AgentApi>();
  bridge: ExtensionBridge | null;
  readonly cursorEnabled: boolean;
  readonly configSites: string[];
  readonly configSitesWrite: string[];
  readonly startedAt = Date.now();

  constructor(opts: RuntimeOptions = {}) {
    super();
    this.bridge = opts.bridge ?? null;
    this.cursorEnabled = opts.cursor ?? true;
    this.configSites = opts.sites ?? [];
    this.configSitesWrite = opts.sitesWrite ?? [];
    if (opts.log) this.on('log', opts.log);
    this.bridge?.on('event', (e) => this.emit('browser-event', e));
    this.bridge?.on('hello', () => this.emit('features-changed', this.features()));
    this.bridge?.on('close', () => { for (const s of this.sessions.values()) { s.browserPage = undefined; s.pages.clear(); } this.emit('features-changed', []); });
  }

  async init(): Promise<void> {
    await this.registry.load();
    try { ensureUserSource(); } catch (err) { this.emit('log', `user adapter dir unavailable: ${(err as Error).message}`); }
  }

  backend(): Backend {
    if (this.bridge?.connected) return 'extension';
    return 'none';
  }
  browserAvailable(): boolean { return this.backend() !== 'none'; }
  features(): BrowserFeature[] { return this.bridge?.connected ? this.bridge.extensionFeatures : []; }
  hasFeature(feature: BrowserFeature): boolean { return this.features().includes(feature); }

  session(id: string): SessionState {
    let s = this.sessions.get(id);
    if (!s) {
      s = { id, createdAt: Date.now(), pages: new Map(), tabLocks: new Map(), enabledSites: new Map(), capabilities: new Set(), observationSeq: 0, lastObserve: new Map(), netLog: new Map(), finalized: false };
      this.sessions.set(id, s);
    }
    return s;
  }

  /** One interactive browser page per MCP session (tabs are page identities on it). */
  async getBrowserPage(sessionId: string): Promise<RuntimePage> {
    const s = this.session(sessionId);
    if (s.browserPage) return s.browserPage;
    if (!s.browserPagePromise) {
      s.browserPagePromise = this.createPage({ session: `mcp:${sessionId}`, surface: 'browser' }).then((p) => { s.browserPage = p; return p; }).finally(() => { s.browserPagePromise = undefined; });
    }
    return s.browserPagePromise;
  }

  /** The page object bound to one tab of a session: commands carry the tab's identity, nothing is switched or shared. */
  async pageFor(sessionId: string, pageId: string): Promise<RuntimePage> {
    const s = this.session(sessionId);
    const existing = s.pages.get(pageId);
    if (existing) return existing;
    const page = await this.createPage({ session: `mcp:${sessionId}`, surface: 'browser', page: pageId });
    s.pages.set(pageId, page);
    return page;
  }
  forgetPage(sessionId: string, pageId: string): void { const s = this.sessions.get(sessionId); s?.pages.delete(pageId); s?.tabLocks.delete(pageId); if (s) for (const key of s.lastObserve.keys()) if (key.startsWith(`${pageId}:`)) s.lastObserve.delete(key); }

  /** Bind each adapter call to the site's current live tab; the extension owns that selection. */
  async getAdapterPage(site: string): Promise<RuntimePage> {
    const key = `site:${site}`;
    const session = await this.createPage({ session: key, surface: 'adapter' });
    const tabs = await session.tabs() as Array<{ page?: string; selected: boolean; state: 'active' | 'handoff' }>;
    const active = tabs.filter((tab) => tab.state === 'active');
    const current = active.find((tab) => tab.selected) ?? active[0];
    if (current && !current.page) throw Object.assign(new Error('Adapter tab is not ready'), { code: 'tab_pending', hint: 'Retry the adapter command when its tab has a page handle.' });
    return current?.page ? this.createPage({ session: key, surface: 'adapter', page: current.page }) : session;
  }

  private async createPage(opts: { session: string; surface: 'browser' | 'adapter'; page?: string }): Promise<RuntimePage> {
    const backend = this.backend();
    if (backend === 'extension' && this.bridge) return createExtensionPage(this.bridge, opts);
    throw Object.assign(new Error('No browser backend is connected'), { code: 'browser_unavailable', hint: 'Run `opencli-mcp doctor`. Chrome with the opencli-mcp extension must be running.' });
  }

  /** Adapters run on the browser object model: a Tab bound to the adapter page, plus sites/recon. */
  async toolContext(page: RuntimePage, site: string): Promise<Record<string, unknown>> {
    const sessionId = `site:${site}`;
    let api = this.siteApis.get(sessionId);
    if (!api) { api = createAgentApi(this, sessionId); this.siteApis.set(sessionId, api); }
    const state = this.session(sessionId);
    const tab = new Tab(page.getActivePage() ?? 'adapter', { rt: this, sessionId, state }, page);
    return { tab, page, sites: api.sites, recon: api.recon };
  }

  isExtensionPage(page: RuntimePage): page is ExtensionRuntimePage { return typeof (page as ExtensionRuntimePage).claim === 'function'; }

  async runSite(site: string, name: string, args: Record<string, unknown>, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<CommandRunResult | CommandRunError> {
    const cmd = await this.registry.resolve(site, name);
    return this.runCommand(cmd, args, opts);
  }

  private async runCommand(cmd: AdapterCommand, args: Record<string, unknown>, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<CommandRunResult | CommandRunError> {
    const site = cmd.site;
    const name = cmd.name;
    const active = this.adapterCallContext.getStore();
    if (active?.retired) return { ok: false, site, name, error: { code: 'command_outcome_unknown', message: 'The parent adapter call has timed out or been cancelled', hint: 'Inspect browser or site state before retrying.' }, elapsedMs: 0 };
    // A nested call into the same site is part of the current workflow and already owns its page.
    if (active?.sites.has(site)) return runAdapter(this, cmd, args, opts);
    const previous = this.adapterRuns.get(site) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.adapterRuns.set(site, current);
    await previous;
    try {
      const callContext = { sites: new Set([...(active?.sites ?? []), site]), retired: false };
      const result = await this.adapterCallContext.run(callContext, () => runAdapter(this, cmd, args, opts));
      if (!result.ok && result.error.code === 'command_outcome_unknown') {
        callContext.retired = true;
        // Timed-out adapter code may still be running. Retire its page before the next call uses this site.
        const key = `site:${site}`;
        await this.createPage({ session: key, surface: 'adapter' }).then((p) => p.closeWindow()).catch(() => {});
      }
      return result;
    } finally {
      release();
      if (this.adapterRuns.get(site) === current) this.adapterRuns.delete(site);
    }
  }

  async defineTool(def: ToolDefinition): ReturnType<typeof createDraft> {
    return createDraft(def, this.registry.sourceFile(def.site, def.name));
  }
  async tryToolDraft(id: string, args: Record<string, unknown>, expect: DraftExpectation): ReturnType<typeof tryDraft> {
    return tryDraft((cmd, sample) => this.runCommand(cmd, sample), id, args, expect);
  }
  async activateToolDraft(id: string): Promise<ReturnType<typeof activateDraft>> {
    const active = activateDraft(id, (site, name) => this.registry.sourceFile(site, name));
    await this.registry.load();
    this.emit('tools-changed', { site: active.site });
    return active;
  }
  discardToolDraft(id: string): ReturnType<typeof discardDraft> { return discardDraft(id); }
  async removeTool(site: string, name: string): Promise<boolean> {
    const ok = deleteTool(site, name);
    if (ok) { await this.registry.load(); this.emit('tools-changed', { site }); }
    return ok;
  }

  async closeSession(id: string, opts: { finalize?: boolean } = {}): Promise<void> {
    const s = this.sessions.get(id);
    if (!s) return;
    this.sessions.delete(id);
    const page = s.browserPage;
    if (page && opts.finalize !== false && !s.finalized) {
      try {
        if (this.isExtensionPage(page)) await page.finalize([]);
        else await page.closeWindow();
      } catch (err) { this.emit('log', `finalize on close failed: ${(err as Error).message}`); }
    }
  }

  async shutdown(): Promise<void> {
    for (const id of [...this.sessions.keys()]) await this.closeSession(id);
  }

  doctor(): DoctorReport {
    const list = this.registry.sites();
    return {
      backend: this.backend(),
      extension: { connected: Boolean(this.bridge?.connected), protocolMatches: Boolean(this.bridge?.protocolMatches), protocolWarning: this.bridge?.protocolWarning ?? null, version: this.bridge?.extensionVersion ?? null, protocolRevision: this.bridge?.protocolRevision ?? null, hostProtocolRevision: PROTOCOL_REVISION, features: this.features() },
      sites: list.length,
      commands: list.reduce((n, s) => n + s.commands, 0),
      definedTools: listDefinedTools().length,
      // Count only real MCP sessions; background adapter contexts are keyed `site:<site>` and are not agents.
      sessions: [...this.sessions.keys()].filter((k) => !k.startsWith('site:')).length,
      cursor: this.cursorEnabled,
    };
  }
}
