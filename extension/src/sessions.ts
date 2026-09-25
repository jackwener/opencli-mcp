/**
 * Sessions & tab leases — tabs are the user's property.
 * A session ⇄ one named Chrome tab group. Agent-created tabs (and popups they spawn) join the
 * group in the background, muted until looked at. User tabs are claimed by id (or a unique
 * url/title match; extra matchers are fail-closed guards) and never moved by claim.
 * finalize() decides what the user keeps.
 */
import type { BrowserEvent, CloseUserTabsResult } from '../../src/protocol.js';
import * as executor from './cdp';
import * as identity from './identity';

export type Origin = 'agent' | 'user';
export type Mark = 'deliverable' | 'handoff' | null;

export interface Lease { tabId: number; origin: Origin; mark: Mark; title?: string; url?: string; claimedAt: number; state: 'active' | 'handoff' }
export interface Session {
  key: string;
  surface: 'browser' | 'adapter';
  name: string | null;
  groupId: number | null;
  windowId: number | null;
  leases: Map<number, Lease>;
  preferredTabId: number | null;
  visible: boolean;
  idleTimer: ReturnType<typeof setTimeout> | null;
  lastActivity: number;
}

type ChildTab = { page: string; tabId: number; url?: string; title?: string };

type GroupColor = chrome.tabGroups.TabGroup['color'];
type WindowChoice = { windowId: number; initialTab?: chrome.tabs.Tab };
const GROUP_COLORS: GroupColor[] = ['blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];
const IDLE_MS: Record<Session['surface'], number> = { browser: 60 * 60_000, adapter: 10 * 60_000 };
const CONTENT_FILE = 'content/cursor.js';

export class SessionError extends Error { constructor(readonly code: string, message: string, readonly hint?: string) { super(message); } }

function isHttp(url?: string): boolean { return Boolean(url && (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('data:text/html'))); }

const STORE_KEY = 'opencli_mcp_sessions_v1';
type StoredSession = Omit<Session, 'leases' | 'idleTimer'> & { leases: Lease[] };
const RELEASED_KEY = 'opencli_mcp_released_v2';

export class SessionManager {
  readonly sessions = new Map<string, Session>();
  private readonly childObservers = new Map<number, Set<(child: Promise<ChildTab | null>) => void>>();
  /** Tabs finalize handed back to the user (kept, released, handoff). Commands to them are refused until a claim; a stale Tab handle cannot re-adopt one. */
  private readonly released = new Set<number>();
  private cursorSeq = 0;
  private restored: Promise<void> | null = null;

  /** Leases live in chrome.storage.session: they survive a service-worker restart but not a browser exit. */
  private persistQueue: Promise<void> = Promise.resolve();
  private persist(): Promise<void> {
    const data: StoredSession[] = [...this.sessions.values()].map(({ leases, idleTimer: _t, ...rest }) => ({ ...rest, leases: [...leases.values()].map((lease) => ({ ...lease })) }));
    const snapshot = { [STORE_KEY]: data, [RELEASED_KEY]: [...this.released] };
    this.persistQueue = this.persistQueue.then(() => chrome.storage.session.set(snapshot)).catch(() => {});
    return this.persistQueue;
  }
  private restore(): Promise<void> {
    if (!this.restored) this.restored = (async () => {
      try {
        const all = await chrome.storage.session.get([STORE_KEY, RELEASED_KEY]);
        for (const tabId of (all?.[RELEASED_KEY] ?? []) as number[]) this.released.add(tabId);
        const stored = all?.[STORE_KEY] as StoredSession[] | undefined;
        for (const st of stored ?? []) {
          if (this.sessions.has(st.key)) continue;
          const leases = new Map<number, Lease>();
          for (const l of st.leases) { try { await chrome.tabs.get(l.tabId); leases.set(l.tabId, l); } catch { /* tab gone */ } }
          if (leases.size === 0) continue;
          const session = { ...st, leases, idleTimer: null };
          this.sessions.set(st.key, session);
          if (st.surface === 'adapter' && st.windowId !== null && this.adapterWindowId === null) this.adapterWindowId = st.windowId;
          this.scheduleIdle(session);
        }
      } catch { /* storage unavailable */ }
    })();
    return this.restored;
  }
  constructor(private readonly emit: (e: BrowserEvent) => void) {
    chrome.tabs.onRemoved.addListener((tabId) => this.onTabRemoved(tabId));
    chrome.tabs.onActivated.addListener(({ tabId }) => { void this.unmuteIfOurs(tabId); void this.publishCursor(tabId); });
    chrome.windows.onFocusChanged.addListener(() => { for (const tabId of this.cursorState.keys()) void this.publishCursor(tabId); });
    // a freshly loaded document (navigation, bfcache restore) asks for the current overlay state instead of starting blank
    chrome.runtime.onMessage.addListener((msg: { type?: string }, sender, respond) => {
      if (msg?.type !== 'opencli:cursor-state?' || sender.tab?.id === undefined) return false;
      void this.observedState(sender.tab.id).then((state) => respond({ state })); return true;
    });
    chrome.tabGroups.onRemoved.addListener((g) => { for (const s of this.sessions.values()) if (s.groupId === g.id) s.groupId = null; });
    chrome.webNavigation.onCreatedNavigationTarget.addListener((d) => {
      const child = this.onChildTab(d.sourceTabId, d.tabId).catch((error) => {
        console.warn(`[opencli-mcp] child tab ${d.tabId} could not be claimed: ${String(error)}`);
        return null;
      });
      for (const observer of this.childObservers.get(d.sourceTabId) ?? []) observer(child);
      void child;
    });
    chrome.windows.onRemoved.addListener((windowId) => { if (this.adapterWindowId === windowId) this.adapterWindowId = null; for (const s of this.sessions.values()) if (s.windowId === windowId) { s.windowId = null; s.groupId = null; } });
    void this.restore();
  }

  async ready(): Promise<void> { await this.restore(); }

  get(key: string, surface: 'browser' | 'adapter' = 'browser'): Session {
    let s = this.sessions.get(key);
    if (!s) {
      s = { key, surface, name: null, groupId: null, windowId: null, leases: new Map(), preferredTabId: null, visible: false, idleTimer: null, lastActivity: Date.now() };
      this.sessions.set(key, s);
    }
    return s;
  }
  touch(s: Session): Promise<void> {
    s.lastActivity = Date.now();
    this.scheduleIdle(s);
    return this.persist();
  }
  private scheduleIdle(s: Session): void {
    if (s.idleTimer) clearTimeout(s.idleTimer);
    const remaining = Math.max(0, IDLE_MS[s.surface] - (Date.now() - s.lastActivity));
    s.idleTimer = setTimeout(() => { void this.finalize(s, []).catch(() => {}); }, remaining);
  }
  ownerOf(tabId: number): Session | null { for (const s of this.sessions.values()) if (s.leases.has(tabId)) return s; return null; }

  /** A child tab has an exact Chrome sourceTabId. Register before the action so even a fast popup is attributed. */
  async withChildTabs<T>(sourceTabId: number, action: () => Promise<T>): Promise<{ result?: T; error?: unknown; openedTabs: ChildTab[] }> {
    const children: Array<Promise<ChildTab | null>> = [];
    const observe = (child: Promise<ChildTab | null>) => { children.push(child); };
    let observers = this.childObservers.get(sourceTabId);
    if (!observers) { observers = new Set(); this.childObservers.set(sourceTabId, observers); }
    observers.add(observe);
    try {
      let result: T | undefined; let error: unknown;
      try { result = await action(); } catch (caught) { error = caught; }
      const openedTabs = (await Promise.all(children)).filter((child): child is ChildTab => child !== null);
      return { result, error, openedTabs };
    } finally {
      observers.delete(observe);
      if (observers.size === 0) this.childObservers.delete(sourceTabId);
    }
  }

  private async createWindow(state?: 'minimized'): Promise<WindowChoice> {
    const w = await chrome.windows.create({ focused: false, type: 'normal', url: 'about:blank', ...(state && { state }) });
    if (w?.id === undefined) throw new SessionError('window_create_failed', 'Could not create a browser window');
    const initialTab = w.tabs?.[0] ?? (await chrome.tabs.query({ windowId: w.id }))[0];
    if (initialTab?.id === undefined) {
      await chrome.windows.remove(w.id).catch(() => {});
      throw new SessionError('window_create_failed', `Created window ${w.id} has no tab`);
    }
    return { windowId: w.id, initialTab };
  }

  private async pickWindow(): Promise<WindowChoice> {
    const focused = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => null);
    if (focused?.id !== undefined && focused.type === 'normal' && focused.id !== this.adapterWindowId) return { windowId: focused.id };
    const all = await chrome.windows.getAll({ windowTypes: ['normal'] });
    const existing = all.find((w) => w.id !== undefined && w.id !== this.adapterWindowId);
    return existing?.id !== undefined ? { windowId: existing.id } : this.createWindow();
  }

  private colorFor(key: string): GroupColor {
    let h = 0; for (const c of key) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return GROUP_COLORS[h % GROUP_COLORS.length];
  }

  private async ensureGroup(s: Session, tabId: number): Promise<void> {
    if (s.surface === 'adapter') return; // background adapter runs stay out of the user's tab strip folders
    const title = s.name ?? 'opencli-mcp';
    if (s.groupId !== null) {
      try { await chrome.tabs.group({ groupId: s.groupId, tabIds: [tabId] }); return; } catch { s.groupId = null; }
    }
    const groupId = await chrome.tabs.group({ tabIds: [tabId] });
    s.groupId = groupId;
    await chrome.tabGroups.update(groupId, { title, color: this.colorFor(s.key) }).catch(() => {});
  }

  /** Background adapter runs get their own minimized window so they never clutter the user's tab strip. */
  private adapterWindowId: number | null = null;
  private async pickAdapterWindow(): Promise<WindowChoice> {
    if (this.adapterWindowId !== null) { try { await chrome.windows.get(this.adapterWindowId); return { windowId: this.adapterWindowId }; } catch { this.adapterWindowId = null; } }
    const choice = await this.createWindow('minimized');
    this.adapterWindowId = choice.windowId;
    return choice;
  }

  async createTab(s: Session, url?: string): Promise<{ tabId: number; page: string; tab: chrome.tabs.Tab }> {
    const pick = async () => s.surface === 'adapter' && !s.visible ? this.pickAdapterWindow() : this.pickWindow();
    let choice: WindowChoice = s.windowId === null ? await pick() : { windowId: s.windowId };
    const target = url && isHttp(url) ? url : 'about:blank';
    // Register the load watcher before the tab exists so a fast (cached) load is never missed.
    let createdId = -1; let loaded = false; let navError: string | null = null;
    let stopLoadWatch = () => {};
    const loadedP = target === 'about:blank' ? Promise.resolve() : new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout>;
      const done = () => { clearTimeout(timer); chrome.tabs.onUpdated.removeListener(listener); chrome.webNavigation.onErrorOccurred.removeListener(onErr); resolve(); };
      const listener = (id: number, info: chrome.tabs.OnUpdatedInfo, tabInfo: chrome.tabs.Tab) => { if (id === createdId && info.status === 'complete' && tabInfo.url && tabInfo.url !== 'about:blank') { loaded = true; done(); } };
      const onErr = (d: chrome.webNavigation.WebNavigationFramedErrorCallbackDetails) => { if (d.tabId === createdId && d.frameId === 0) { navError = d.error; done(); } };
      chrome.tabs.onUpdated.addListener(listener);
      chrome.webNavigation.onErrorOccurred.addListener(onErr);
      timer = setTimeout(done, 15_000);
      stopLoadWatch = done;
    });
    let tab!: chrome.tabs.Tab;
    // the tab is born blank, attached (network capture armed), and only then navigated: the requests of the first load
    // are evidence too — network inspection needs the document's own XHR/fetch, which fire before any command would attach
    try {
      try { tab = choice.initialTab ?? await chrome.tabs.create({ windowId: choice.windowId, url: 'about:blank', active: s.visible }); }
      catch { s.windowId = null; s.groupId = null; choice = await pick(); tab = choice.initialTab ?? await chrome.tabs.create({ windowId: choice.windowId, url: 'about:blank', active: s.visible }); }
      createdId = tab.id!;
      if (target !== 'about:blank') {
        await executor.ensureAttached(createdId, s.surface === 'browser').catch(() => { /* attach on first command instead */ });
        try { await chrome.tabs.update(createdId, { url: target }); }
        catch (error) { throw new SessionError('page_not_loaded', `navigation to ${target} failed: ${String(error)}`); }
        await loadedP;
        tab = await chrome.tabs.get(createdId).catch(() => tab);
        if (navError) throw new SessionError('page_not_loaded', `navigation to ${target} failed: ${navError}`, 'The browser blocked or could not reach the URL (policy, offline, DNS, or an extension). Check chrome://policy and the network.');
        if (!loaded && tab.url === 'about:blank') throw new SessionError('page_not_loaded', `navigation to ${target} did not start`);
        if (!loaded) console.warn(`[opencli-mcp] tab ${createdId} did not finish loading ${target} within 15s (url=${tab.url ?? ''})`);
      }
      if (!s.visible) await chrome.tabs.update(createdId, { muted: true }).catch(() => {});
      await this.ensureGroup(s, createdId);
    } catch (error) {
      stopLoadWatch();
      if (createdId >= 0) {
        await executor.detach(createdId).catch(() => {});
        try { await chrome.tabs.remove(createdId); }
        catch {
          const survivor = await chrome.tabs.get(createdId).catch(() => null);
          if (survivor) {
            s.windowId = survivor.windowId;
            s.leases.set(createdId, { tabId: createdId, origin: 'agent', mark: null, url: survivor.url, title: survivor.title, claimedAt: Date.now(), state: 'active' });
            s.preferredTabId = createdId;
            await this.touch(s);
            throw new SessionError('tab_create_cleanup_failed', `Opening the page failed and tab ${createdId} could not be closed: ${String(error)}`, 'The tab remains in this session. Use tab_list and tab_close to clean it up.');
          }
        }
      }
      throw error;
    }
    const tabId = createdId;
    s.windowId = tab.windowId;
    s.leases.set(tabId, { tabId, origin: 'agent', mark: null, url: tab.url, title: tab.title, claimedAt: Date.now(), state: 'active' });
    s.preferredTabId = tabId;
    const page = identity.pageId(tabId);
    this.emit({ kind: 'tab_created', session: s.key, page, tabId, url: tab.url, title: tab.title, origin: 'agent' });
    await this.touch(s);
    return { tabId, page, tab };
  }

  async listUserTabs(options: { query?: string; limit?: number; all?: boolean } = {}): Promise<Array<{ tabId: number; title?: string; url?: string; windowId: number; active: boolean; groupId?: number; lastAccessed?: number }>> {
    const tabs = await chrome.tabs.query({ windowType: 'normal' });
    const query = options.query?.trim().toLowerCase();
    const limit = Math.min(100, Math.max(1, options.limit ?? 20));
    // handoff tabs are the user's again: listed here so a later turn can claim them back
    return tabs.filter((t) => t.id !== undefined && isHttp(t.url) && (this.ownerOf(t.id)?.leases.get(t.id)?.state ?? 'none') !== 'active')
      .filter((t) => !query || (t.title ?? '').toLowerCase().includes(query) || (t.url ?? '').toLowerCase().includes(query))
      .sort((a, b) => ((b as { lastAccessed?: number }).lastAccessed ?? 0) - ((a as { lastAccessed?: number }).lastAccessed ?? 0))
      .slice(0, options.all ? undefined : limit)
      .map((t) => ({ tabId: t.id!, title: t.title, url: t.url, windowId: t.windowId, active: Boolean(t.active), groupId: t.groupId && t.groupId > 0 ? t.groupId : undefined, lastAccessed: (t as { lastAccessed?: number }).lastAccessed }));
  }

  /** Find by fuzzy url/title, then verify optional exact identity before adopting the chosen tab. */
  async claimUserTab(s: Session, claim: { tabId?: number; active?: boolean; title?: string; url?: string; expectedUrl?: string; expectedTitle?: string }): Promise<{ tabId: number; page: string; tab: chrome.tabs.Tab }> {
    if ((claim.active || claim.tabId !== undefined) && (claim.url !== undefined || claim.title !== undefined)) throw new SessionError('invalid_args', 'url/title are for lookup without tabId or active:true', 'Use expectedUrl/expectedTitle to verify the selected tab exactly.');
    const urlOk = (u?: string) => claim.url === undefined || (u !== undefined && (u === claim.url || u.startsWith(claim.url)));
    const titleOk = (t?: string) => claim.title === undefined || (t !== undefined && t.toLowerCase().includes(claim.title.toLowerCase()));
    let tab: chrome.tabs.Tab;
    if (claim.active) {
      const focused = await chrome.windows.getLastFocused({ windowTypes: ['normal'], populate: true }).catch(() => null);
      const activeTab = focused?.tabs?.find((candidate) => candidate.active);
      if (activeTab?.id === undefined) throw new SessionError('claim_not_found', 'No active tab in the last focused normal window', 'Focus the Chrome tab you want to use, then retry tab_claim {active:true}.');
      tab = await chrome.tabs.get(activeTab.id).catch(() => { throw new SessionError('claim_not_found', 'The foreground tab is no longer open', 'Focus the intended tab and retry.'); });
      if (!tab.active || tab.windowId !== focused?.id) throw new SessionError('claim_identity_mismatch', 'The foreground tab changed before it could be claimed', 'Focus the intended tab and retry.');
      if (claim.tabId !== undefined && tab.id !== claim.tabId) throw new SessionError('claim_identity_mismatch', `Active tab is ${tab.id}, not ${claim.tabId}`, 'Use the current tabId or omit it when claiming the active tab.');
    } else if (claim.tabId === undefined) {
      if (claim.url === undefined && claim.title === undefined) throw new SessionError('claim_not_allowed', 'claim needs a tabId, active:true, or a url/title to find the tab', 'Use tab_claim {active:true} for the foreground tab, or list user tabs first.');
      const candidates = (await this.listUserTabs({ query: claim.url ?? claim.title, all: true })).filter((t) => urlOk(t.url) && titleOk(t.title));
      if (candidates.length === 0) throw new SessionError('claim_not_found', `no user tab matches ${JSON.stringify({ url: claim.url, title: claim.title })}`, 'List user tabs and claim by tabId.');
      if (candidates.length > 1) throw new SessionError('claim_ambiguous', `${candidates.length} user tabs match; claim by tabId: ${candidates.map((c) => `${c.tabId} "${c.title}" ${c.url}`).join('; ')}`, 'Pass the tabId of the intended tab.');
      tab = await chrome.tabs.get(candidates[0].tabId);
      if (!urlOk(tab.url) || !titleOk(tab.title)) throw new SessionError('claim_identity_mismatch', `Tab ${tab.id} changed during lookup`, 'List user tabs again and claim the current tab.');
    } else {
      try { tab = await chrome.tabs.get(claim.tabId); } catch { throw new SessionError('claim_identity_mismatch', `Tab ${claim.tabId} no longer exists`, 'List user tabs again and claim a current one.'); }
    }
    if ((claim.expectedUrl !== undefined && tab.url !== claim.expectedUrl) || (claim.expectedTitle !== undefined && tab.title !== claim.expectedTitle)) throw new SessionError('claim_identity_mismatch', `Tab ${tab.id} changed (now "${tab.title}" ${tab.url})`, 'List user tabs again and use the current URL/title, or claim by tabId alone.');
    const tabId = tab.id!;
    if (!isHttp(tab.url)) throw new SessionError('claim_not_allowed', 'Only http(s) tabs can be claimed');
    const owner = this.ownerOf(tabId);
    const prior = owner?.leases.get(tabId);
    if (owner && owner !== s && prior?.state !== 'handoff') throw new SessionError('already_claimed', `Tab ${tabId} belongs to session ${owner.key}`);
    if (owner && owner !== s) { owner.leases.delete(tabId); if (owner.preferredTabId === tabId) owner.preferredTabId = null; } // a handoff tab moves to whoever claims it
    s.windowId = s.windowId ?? tab.windowId;
    this.released.delete(tabId); // a claim is the one way a released tab comes back
    // an agent-created handoff tab keeps its agent origin (and group), so a later finalize may still close it
    const origin = prior?.state === 'handoff' ? prior.origin : 'user';
    s.leases.set(tabId, { tabId, origin, mark: null, url: tab.url, title: tab.title, claimedAt: Date.now(), state: 'active' });
    s.preferredTabId = tabId;
    const page = identity.pageId(tabId);
    this.emit({ kind: 'tab_acquired', session: s.key, page, tabId, url: tab.url, title: tab.title, origin });
    await this.touch(s);
    return { tabId: tabId, page, tab };
  }

  /** Close explicit user-tab ids without acquiring them into a browser session. */
  async closeUserTabs(tabIds: number[]): Promise<CloseUserTabsResult> {
    const unique = [...new Set(tabIds)];
    const eligible = new Set((await chrome.tabs.query({ windowType: 'normal' }))
      .filter((tab) => tab.id !== undefined && (this.ownerOf(tab.id)?.leases.get(tab.id)?.state ?? 'none') !== 'active')
      .map((tab) => tab.id!));
    const outcomes = await Promise.all(unique.map(async (tabId) => {
      if (!eligible.has(tabId) || this.ownerOf(tabId)?.leases.get(tabId)?.state === 'active') return { tabId, reason: 'Tab is gone or controlled by a session' };
      try { await chrome.tabs.remove(tabId); return { tabId, closed: true as const }; }
      catch (error) { return { tabId, reason: String(error) }; }
    }));
    const closed = outcomes.filter((outcome): outcome is { tabId: number; closed: true } => 'closed' in outcome).map(({ tabId }) => tabId);
    const failed = outcomes.filter((outcome): outcome is { tabId: number; reason: string } => 'reason' in outcome);
    return { complete: failed.length === 0, closed, failed };
  }

  /** Resolve the tab a page-scoped command targets; create one when the session has none. */
  async resolveTab(s: Session, page?: string, initialUrl?: string): Promise<number> {
    await this.touch(s);
    if (page) {
      let tabId: number;
      try { tabId = await identity.resolveTabId(page); } catch { throw new SessionError('stale_page', `stale page identity ${page}`, 'That tab no longer exists; open or claim a fresh tab.'); }
      const lease = s.leases.get(tabId);
      if (lease?.state === 'handoff' || (!lease && this.released.has(tabId))) throw new SessionError('page_released', `page ${page} was handed back to the user by finalize`, 'finalize ends the session\'s control of its tabs; claim the tab again (browser.user.claimTab) or open a new one.');
      if (!lease) {
        const owner = this.ownerOf(tabId);
        if (owner && owner !== s) throw new SessionError('page_not_in_session', `page ${page} belongs to session ${owner.key}`);
        throw new SessionError('page_not_in_session', `page ${page} is not controlled by this session`, 'List tabs, then explicitly open or claim the intended tab.');
      }
      s.preferredTabId = tabId;
      return tabId;
    }
    if (s.preferredTabId !== null) {
      try { await chrome.tabs.get(s.preferredTabId); return s.preferredTabId; } catch { s.leases.delete(s.preferredTabId); s.preferredTabId = null; }
    }
    for (const lease of s.leases.values()) {
      if (lease.state !== 'active') continue;
      try { await chrome.tabs.get(lease.tabId); s.preferredTabId = lease.tabId; return lease.tabId; }
      catch { s.leases.delete(lease.tabId); }
    }
    if (s.surface === 'adapter') return (await this.createTab(s, initialUrl)).tabId;
    throw new SessionError('no_tab', 'No tab is controlled by this session', 'Use tab_open or tab_claim before a browser operation.');
  }

  /** End one lease with an explicit outcome. Closing removes the Chrome tab; releasing preserves it. */
  async endTab(s: Session, tabId: number, op: 'close' | 'release'): Promise<{ page: string; closed: boolean; released: boolean }> {
    const lease = s.leases.get(tabId);
    if (!lease) throw new SessionError('page_not_in_session', `tab ${tabId} is not controlled by this session`);
    const page = identity.pageId(tabId);
    await executor.detach(tabId).catch(() => {});
    await this.hideCursor(tabId);
    if (op === 'close') {
      const preferred = s.preferredTabId;
      s.leases.delete(tabId); // onRemoved may fire before chrome.tabs.remove resolves
      if (preferred === tabId) s.preferredTabId = null;
      try { await chrome.tabs.remove(tabId); }
      catch (error) {
        const missing = await chrome.tabs.get(tabId).then(() => false, (getError: unknown) => /No tab with id/i.test(String(getError)));
        if (!missing) {
          s.leases.set(tabId, lease);
          s.preferredTabId = preferred;
          throw new SessionError('tab_close_failed', `Could not close tab ${tabId}: ${String(error)}`);
        }
      }
      this.emit({ kind: 'tab_closed', session: s.key, page, tabId, origin: lease.origin });
    } else {
      if (lease.origin === 'agent') {
        try {
          await chrome.tabs.update(tabId, { muted: false });
          const tab = await chrome.tabs.get(tabId);
          if (tab.groupId !== undefined && tab.groupId >= 0) await chrome.tabs.ungroup(tabId);
        } catch (error) { throw new SessionError('tab_release_failed', `Could not release tab ${tabId}: ${String(error)}`, 'The tab is still controlled by this session. Retry tab_release or session_finalize.'); }
      }
      this.released.add(tabId);
      s.leases.delete(tabId);
      if (s.preferredTabId === tabId) s.preferredTabId = null;
      this.emit({ kind: 'tab_released', session: s.key, page, tabId, origin: lease.origin });
    }
    await this.persist();
    return { page, closed: op === 'close', released: op === 'release' };
  }

  async nameSession(s: Session, name: string): Promise<void> {
    s.name = name;
    if (s.groupId !== null) await chrome.tabGroups.update(s.groupId, { title: name }).catch(() => {});
    await this.persist();
  }

  mark(s: Session, tabId: number, mark: Mark): void {
    const lease = s.leases.get(tabId);
    if (!lease) throw new SessionError('page_not_in_session', `tab ${tabId} is not part of session ${s.key}`);
    lease.mark = mark;
    void this.persist();
  }

  async finalize(s: Session, keep: Array<{ page: string; status: 'deliverable' | 'handoff' }>): Promise<{ closed: string[]; kept: string[]; failed: Array<{ page: string; reason: string }> }> {
    const closed: string[] = []; const kept: string[] = []; const failed: Array<{ page: string; reason: string }> = [];
    const keepByTab = new Map<number, 'deliverable' | 'handoff'>();
    for (const k of keep) { try { keepByTab.set(await identity.resolveTabId(k.page), k.status); } catch { /* gone */ } }
    for (const lease of [...s.leases.values()]) {
      const status = keepByTab.get(lease.tabId) ?? lease.mark ?? null;
      const page = identity.pageId(lease.tabId);
      if (status === 'handoff') {
        await executor.detach(lease.tabId).catch(() => {});
        await this.hideCursor(lease.tabId);
        this.released.add(lease.tabId);
        lease.state = 'handoff'; lease.mark = 'handoff';
        kept.push(page); continue;
      }
      const op = status === 'deliverable' || lease.origin === 'user' ? 'release' : 'close';
      try {
        await this.endTab(s, lease.tabId, op);
        if (op === 'close') closed.push(page); else kept.push(page);
      } catch (error) {
        failed.push({ page, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    s.preferredTabId = null;
    if (s.leases.size === 0) { s.groupId = null; if (s.idleTimer) clearTimeout(s.idleTimer); this.sessions.delete(s.key); }
    await this.persist();
    if (failed.length === 0) this.emit({ kind: 'session_released', session: s.key, reason: 'finalize' });
    return { closed, kept, failed };
  }

  async setVisibility(s: Session, visible: boolean): Promise<void> {
    s.visible = visible;
    if (visible) {
      if (s.preferredTabId !== null) await chrome.tabs.update(s.preferredTabId, { active: true, muted: false }).catch(() => {});
      if (s.windowId !== null) await chrome.windows.update(s.windowId, { focused: true, state: 'normal' }).catch(() => {});
    }
  }

  private onTabRemoved(tabId: number): void {
    this.cursorState.delete(tabId);
    if (this.released.delete(tabId)) void this.persist();
    for (const s of this.sessions.values()) {
      if (!s.leases.delete(tabId)) continue;
      if (s.preferredTabId === tabId) s.preferredTabId = null;
      this.emit({ kind: 'tab_closed', session: s.key, page: identity.pageId(tabId), tabId });
      void this.persist();
    }
  }
  private async unmuteIfOurs(tabId: number): Promise<void> {
    if (!this.ownerOf(tabId)) return;
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (t?.mutedInfo?.muted && t.mutedInfo.reason === 'extension') await chrome.tabs.update(tabId, { muted: false }).catch(() => {});
  }
  private async onChildTab(sourceTabId: number, childId: number): Promise<ChildTab | null> {
    const s = this.ownerOf(sourceTabId);
    if (!s || s.leases.has(childId)) return null;
    if (s.leases.get(sourceTabId)?.state !== 'active') return null;
    // A claimed user tab keeps unrelated manual popups; a popup during an agent action belongs to that action.
    if (s.leases.get(sourceTabId)?.origin === 'user' && !this.childObservers.has(sourceTabId)) return null;
    const tab = await chrome.tabs.get(childId).catch(() => null);
    if (!tab) return null;
    s.leases.set(childId, { tabId: childId, origin: 'agent', mark: null, url: tab.url, title: tab.title, claimedAt: Date.now(), state: 'active' });
    if (!s.visible) await chrome.tabs.update(childId, { muted: true, active: false }).catch(() => {});
    await this.ensureGroup(s, childId);
    const page = identity.pageId(childId);
    this.emit({ kind: 'tab_created', session: s.key, page, tabId: childId, url: tab.url, title: tab.title, origin: 'agent' });
    void this.persist();
    return { page, tabId: childId, url: tab.url, title: tab.title };
  }

  // ── human visibility: content script for cursor overlay ──
  private async ensureContent(tabId: number): Promise<boolean> {
    try { const r = await chrome.tabs.sendMessage(tabId, { type: 'opencli:ping' }); if (r?.ok) return true; } catch { /* inject */ }
    try { await chrome.scripting.executeScript({ target: { tabId }, files: [CONTENT_FILE], injectImmediately: true }); return true; } catch { return false; }
  }
  /**
   * Cursor overlay state, owned here (the ChatGPT plugin's arrangement): the content script is a renderer that pulls
   * this on load and receives pushes, so the cursor survives navigations, hides when the session finalizes, and is
   * only *visible* in tabs the user is observing (active tab of a non-minimized window) — elsewhere the position is
   * remembered and the move neither animates nor waits.
   */
  private readonly cursorState = new Map<number, { session: string; x: number; y: number; seq: number; shown: boolean }>();

  private async isObserved(tabId: number): Promise<boolean> {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab || !tab.active) return false;
    const win = await chrome.windows.get(tab.windowId).catch(() => null);
    return Boolean(win && win.state !== 'minimized');
  }

  private async observedState(tabId: number): Promise<{ x: number; y: number; seq: number; visible: boolean } | null> {
    const st = this.cursorState.get(tabId);
    if (!st) return null;
    return { x: st.x, y: st.y, seq: st.seq, visible: st.shown && await this.isObserved(tabId) };
  }

  /** Push the current state to the tab's overlay (no animation, no wait). */
  private async publishCursor(tabId: number): Promise<void> {
    const state = await this.observedState(tabId);
    if (!state) return;
    if (!(await this.ensureContent(tabId))) return;
    await chrome.tabs.sendMessage(tabId, { type: 'opencli:cursor-state', state: { ...state, animate: false } }).catch(() => {});
  }

  async cursor(s: Session, tabId: number, x: number, y: number, waitForArrival: boolean, timeoutMs = 1200): Promise<boolean> {
    const seq = ++this.cursorSeq;
    this.cursorState.set(tabId, { session: s.key, x, y, seq, shown: true });
    const observed = await this.isObserved(tabId);
    if (!(await this.ensureContent(tabId))) return false;
    const p = chrome.tabs.sendMessage(tabId, { type: 'opencli:cursor-state', state: { x, y, seq, visible: observed, animate: observed && waitForArrival } });
    if (!observed || !waitForArrival) { p.catch(() => {}); return false; }
    const result = await Promise.race([p.catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), timeoutMs))]);
    return Boolean(result && (result as { arrived?: boolean; seq?: number }).arrived && (result as { seq?: number }).seq === seq);
  }

  /** Hide the overlay in a tab the session is done with (finalize, release); the position is forgotten. */
  async hideCursor(tabId: number): Promise<void> {
    if (!this.cursorState.delete(tabId)) return;
    if (!(await this.ensureContent(tabId))) return;
    await chrome.tabs.sendMessage(tabId, { type: 'opencli:cursor-state', state: null }).catch(() => {});
  }
}
