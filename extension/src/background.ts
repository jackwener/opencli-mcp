/**
 * opencli-mcp extension service worker — the browser runtime.
 * Connects to the Chrome-spawned host over Native Messaging, owns chrome.debugger sessions,
 * tab leases / groups / claims / finalize, and the cursor overlay.
 * Page semantics arrive as commands (exec/navigate/…) from the host runtime.
 */
import type { Command, Result } from '../../src/protocol.js';
import * as executor from './cdp';
import * as identity from './identity';
import { executeWithJournal } from './journal';
import { NativeHost } from './native';
import { SessionManager, SessionError, type Session } from './sessions';
import { performAct, ActError } from './act';
import { evaluateInEngine, evaluateMain, registerFrameTracking, forgetTab as forgetEngineTab } from './world';

const CDP_ALLOWLIST = new Set([
  'Accessibility.enable', 'Accessibility.getFullAXTree', 'Accessibility.getPartialAXTree',
  'DOM.enable', 'DOM.getDocument', 'DOM.getBoxModel', 'DOM.getContentQuads', 'DOM.focus', 'DOM.querySelector', 'DOM.querySelectorAll', 'DOM.scrollIntoViewIfNeeded', 'DOM.describeNode', 'DOM.getNodeForLocation',
  'DOMSnapshot.captureSnapshot',
  'Input.dispatchMouseEvent', 'Input.dispatchKeyEvent', 'Input.insertText', 'Input.dispatchTouchEvent',
  'Page.getLayoutMetrics', 'Page.captureScreenshot', 'Page.getFrameTree', 'Page.handleJavaScriptDialog', 'Page.getNavigationHistory',
  'Runtime.enable', 'Runtime.getHeapUsage',
  'Emulation.setDeviceMetricsOverride', 'Emulation.clearDeviceMetricsOverride',
  'Network.enable', 'Network.getCookies', 'Performance.getMetrics',
]);

const host = new NativeHost((cmd) => executeWithJournal(cmd, handleCommand));
const sessions = new SessionManager((e) => host.event(e));

executor.registerListeners();
registerFrameTracking();
chrome.tabs.onRemoved.addListener((tabId) => forgetEngineTab(tabId));
chrome.webNavigation.onCommitted.addListener((d) => { if (d.frameId === 0) forgetEngineTab(d.tabId); });
chrome.runtime.onInstalled.addListener(() => host.connect());
chrome.runtime.onStartup.addListener(() => host.connect());
host.connect();

// ── helpers ──
function sessionFor(cmd: Command): Session {
  const key = cmd.session ?? 'default';
  return sessions.get(key, cmd.surface ?? 'browser');
}
function isSafeNavigationUrl(url: string): boolean { return url.startsWith('http://') || url.startsWith('https://') || url.startsWith('data:text/html'); }
function normalizeUrl(url?: string): string {
  if (!url) return '';
  try { const p = new URL(url); if ((p.protocol === 'https:' && p.port === '443') || (p.protocol === 'http:' && p.port === '80')) p.port = ''; return `${p.protocol}//${p.host}${p.pathname === '/' ? '' : p.pathname}${p.search}${p.hash}`; } catch { return url; }
}
function commandTimeoutMs(cmd: Command): number | undefined {
  if (cmd.deadlineAt) return Math.max(1000, cmd.deadlineAt - Date.now() - 500);
  return undefined;
}
async function pageScoped(id: string, tabId: number, data: unknown): Promise<Result> {
  return { id, ok: true, data, page: identity.pageId(tabId) };
}
function errorResult(id: string, err: unknown): Result {
  if (err instanceof SessionError) return { id, ok: false, error: err.message, errorCode: err.code, errorHint: err.hint };
  if (err instanceof ActError) return { id, ok: false, error: err.message, errorCode: err.code, errorHint: err.hint, data: err.extra };
  const e = err as { message?: string; code?: string; hint?: string; dialog?: unknown };
  const message = e?.message ?? String(err);
  const code = e?.code ?? (/No tab with id|no longer exists/i.test(message) ? 'stale_page' : /Cannot access|chrome:\/\//i.test(message) ? 'not_debuggable' : 'command_failed');
  return { id, ok: false, error: message, errorCode: code, errorHint: e?.hint, ...(e?.dialog ? { data: { dialog: e.dialog } } : {}) };
}
/** Every child frame of the tab (in document order), flagged cross-origin when its origin differs from the top document's. Opaque origins (data:, sandboxed) count as cross-origin. */
// ── router ──
async function handleCommand(cmd: Command): Promise<Result> {
  await sessions.ready();
  const s = sessionFor(cmd);
  try {
    switch (cmd.action) {
      case 'ping': return { id: cmd.id, ok: true, data: { pong: true, version: chrome.runtime.getManifest().version } };
      case 'exec': return await handleExec(cmd, s);
      case 'act': {
        if (!cmd.act) return { id: cmd.id, ok: false, error: 'Missing act spec', errorCode: 'invalid_target' };
        const tabId = await sessions.resolveTab(s, cmd.page);
        await ensureLoaded(tabId);
        const downloadFrom = executor.downloadCursor(tabId);
        // the action budget is the spec's own timeout (default 3s) — never the whole command deadline
        // Show the cursor at the action point but never block input on its arrival (waitForArrival:false) — the overlay is a UX affordance, not on the latency path.
        const { result, error, openedTabs } = await sessions.withChildTabs(tabId, () => performAct(tabId, { ...cmd.act!, timeoutMs: Math.min(cmd.act!.timeoutMs ?? 3000, 60_000) }, { aggressive: s.surface === 'browser', cursor: cmd.act!.cursor ? (x, y) => sessions.cursor(s, tabId, x, y, false) : undefined }));
        const started = executor.pageDownloadsAfter(tabId, downloadFrom).map(({ seq, guid, url, suggestedFilename }) => ({ seq, ...(guid && { guid }), url, suggestedFilename }));
        if (error) {
          const failure = errorResult(cmd.id, error);
          failure.data = { ...(typeof failure.data === 'object' && failure.data !== null ? failure.data : {}), ...(openedTabs.length && { openedTabs: openedTabs.map(({ page, tabId, url, title }) => ({ tab: page, tabId, url, title })) }), download: { afterSequence: downloadFrom, started } };
          return failure;
        }
        return pageScoped(cmd.id, tabId, { ...result, ...(openedTabs.length && { openedTabs }), download: { afterSequence: downloadFrom, started } });
      }
      case 'navigate': return await handleNavigate(cmd, s);
      case 'tabs': return await handleTabs(cmd, s);
      case 'cookies': return await handleCookies(cmd);
      case 'screenshot': { const tabId = await sessions.resolveTab(s, cmd.page); return pageScoped(cmd.id, tabId, await executor.screenshot(tabId, { format: cmd.format, quality: cmd.quality, fullPage: cmd.fullPage, width: cmd.width, height: cmd.height })); }
      case 'cdp': return await handleCdp(cmd, s);
      case 'frames': { const tabId = await sessions.resolveTab(s, cmd.page); return { id: cmd.id, ok: true, data: await executor.listFrames(tabId) }; }
      case 'network-capture-start': { const tabId = await sessions.resolveTab(s, cmd.page); await executor.startNetworkCapture(tabId, cmd.pattern); return pageScoped(cmd.id, tabId, { started: true }); }
      case 'network-capture-read': { const tabId = await sessions.resolveTab(s, cmd.page); return pageScoped(cmd.id, tabId, await executor.readNetworkCapture(tabId)); }
      case 'wait-download': {
        if (cmd.afterSequence === undefined) return { id: cmd.id, ok: false, error: 'Missing download cursor', errorCode: 'invalid_args', errorHint: 'Pass download.afterSequence from tab_act.' };
        const tabId = await sessions.resolveTab(s, cmd.page);
        return pageScoped(cmd.id, tabId, await executor.waitForDownload(tabId, cmd.afterSequence, cmd.timeoutMs ?? 30_000));
      }
      // ── session & tab lifecycle ──
      case 'session-name': { if (!cmd.name) return { id: cmd.id, ok: false, error: 'Missing name' }; await sessions.nameSession(s, cmd.name); return { id: cmd.id, ok: true, data: { name: cmd.name } }; }
      case 'user-tabs': return { id: cmd.id, ok: true, data: await sessions.listUserTabs({ query: cmd.query, limit: cmd.limit }) };
      case 'claim': { if (!cmd.claim) return { id: cmd.id, ok: false, error: 'Missing claim' }; const r = await sessions.claimUserTab(s, cmd.claim); return { id: cmd.id, ok: true, page: r.page, data: { url: r.tab.url, title: r.tab.title, tabId: r.tabId } }; }
      case 'close-user-tabs': { if (!cmd.tabIds?.length) return { id: cmd.id, ok: false, error: 'Missing tabIds', errorCode: 'invalid_args' }; return { id: cmd.id, ok: true, data: await sessions.closeUserTabs(cmd.tabIds) }; }
      case 'mark': { if (!cmd.page) return { id: cmd.id, ok: false, error: 'Missing page' }; const tabId = await identity.resolveTabId(cmd.page); sessions.mark(s, tabId, cmd.mark ?? null); return { id: cmd.id, ok: true, data: { mark: cmd.mark ?? null } }; }
      case 'session-finalize': return { id: cmd.id, ok: true, data: await sessions.finalize(s, cmd.keep ?? []) };
      // ── human visibility ──
      case 'cursor': { if (typeof cmd.x !== 'number' || typeof cmd.y !== 'number') return { id: cmd.id, ok: false, error: 'Missing x/y' }; const tabId = await sessions.resolveTab(s, cmd.page); const arrived = await sessions.cursor(s, tabId, cmd.x, cmd.y, cmd.waitForArrival !== false, cmd.timeoutMs ?? 1200); return pageScoped(cmd.id, tabId, { arrived }); }
      case 'dialog': {
        const tabId = await sessions.resolveTab(s, cmd.page);
        const op = cmd.dialogOp ?? 'get';
        if (op === 'get') return pageScoped(cmd.id, tabId, { dialog: executor.getDialog(tabId) });
        if (!executor.getDialog(tabId)) return { id: cmd.id, ok: false, error: 'No native dialog is open on this tab', errorCode: 'no_dialog', errorHint: 'Use dialog get to check; dialogs are tracked only while the debugger is attached.' };
        const dialog = await executor.handleDialog(tabId, op === 'accept', cmd.text);
        return pageScoped(cmd.id, tabId, { handled: op, dialog });
      }
      case 'console': { const tabId = await sessions.resolveTab(s, cmd.page); await executor.ensureAttached(tabId, s.surface === 'browser'); return pageScoped(cmd.id, tabId, executor.readConsole(tabId, { afterSequence: cmd.afterSequence, limit: cmd.limit, levels: cmd.levels, filter: cmd.filter })); }
      case 'history': {
        const tabId = await sessions.resolveTab(s, cmd.page);
        const op = cmd.historyOp ?? 'reload';
        // fire, do not await: with a debugger attached the reload/goBack promise can resolve only after the navigation, or never
        const trigger = op === 'reload' ? chrome.tabs.reload(tabId) : op === 'back' ? chrome.tabs.goBack(tabId) : chrome.tabs.goForward(tabId);
        trigger.catch((e) => console.warn(`[opencli-mcp] ${op} trigger: ${e instanceof Error ? e.message : String(e)}`));
        await Promise.race([trigger, new Promise((r) => setTimeout(r, 300))]); // let the navigation start before polling status
        const t = await waitForLoad(tabId, 15_000);
        const lease = s.leases.get(tabId); if (lease) { lease.url = t.url; lease.title = t.title; }
        return pageScoped(cmd.id, tabId, { op, url: t.url, title: t.title, timedOut: t.status !== 'complete' });
      }
      case 'visibility': { if (typeof cmd.visible === 'boolean') await sessions.setVisibility(s, cmd.visible); return { id: cmd.id, ok: true, data: { visible: s.visible } }; }
      default: return { id: cmd.id, ok: false, error: `Unknown action: ${String(cmd.action)}`, errorCode: 'unknown_action' };
    }
  } catch (err) {
    return errorResult(cmd.id, err);
  }
}

/** Resolve when the tab reports status complete (or the timeout elapses); returns the latest tab. */
async function waitForLoad(tabId: number, timeoutMs: number): Promise<chrome.tabs.Tab> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const t = await chrome.tabs.get(tabId);
    if (t.status === 'complete' && t.url) return t;
    if (Date.now() > deadline) return t;
    await new Promise((r) => setTimeout(r, 100));
  }
}
/**
 * A tab can be acted on as soon as it has a committed document (non-empty url) — even while still 'loading'
 * (long-polling pages never reach 'complete'). Only a tab with no document at all is waited for, briefly, then fails fast.
 */
async function ensureLoaded(tabId: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const t = await chrome.tabs.get(tabId);
    if (t.url) return;
    if (Date.now() > deadline) throw new SessionError('page_not_loaded', `tab ${tabId} has no committed document (status ${t.status}, pending ${t.pendingUrl ?? 'none'})`, 'The navigation did not commit (blocked, offline, or cancelled). Navigate to a reachable http(s) URL first.');
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function handleExec(cmd: Command, s: Session): Promise<Result> {
  if (!cmd.code) return { id: cmd.id, ok: false, error: 'Missing code' };
  const tabId = await sessions.resolveTab(s, cmd.page);
  await ensureLoaded(tabId);
  const aggressive = s.surface === 'browser';
  if (cmd.world === 'engine') return pageScoped(cmd.id, tabId, await evaluateInEngine(tabId, cmd.code, aggressive, commandTimeoutMs(cmd)));
  if (cmd.frameIndex != null) {
    const frames = await executor.listFrames(tabId);
    const f = frames[cmd.frameIndex];
    if (!f) return { id: cmd.id, ok: false, error: `Frame index ${cmd.frameIndex} out of range (${frames.length})`, errorCode: 'frame_not_found' };
    return pageScoped(cmd.id, tabId, await evaluateMain(tabId, f.frameId, cmd.code, aggressive, commandTimeoutMs(cmd)));
  }
  return pageScoped(cmd.id, tabId, await executor.evaluate(tabId, cmd.code, aggressive, commandTimeoutMs(cmd)));
}

/** True when the tab's committed document is Chrome's error page (blocked / DNS / refused), which the tabs API hides behind the requested URL. */
async function isErrorDocument(tabId: number): Promise<string | null> {
  try {
    const r = await executor.evaluate(tabId, `document.documentURI`, false, 2_000);
    const uri = typeof r === 'string' ? r : '';
    return uri.startsWith('chrome-error://') ? uri : null;
  } catch { return null; }
}

function notLoaded(id: string, target: string, detail: string): Result {
  return { id, ok: false, errorCode: 'page_not_loaded', error: `navigation to ${target} did not load: ${detail}`, errorHint: 'The browser blocked or could not reach the URL (policy, an extension, offline, DNS). Check the URL is reachable from this browser; chrome://policy lists URL blocklists.' };
}

async function handleNavigate(cmd: Command, s: Session): Promise<Result> {
  if (!cmd.url) return { id: cmd.id, ok: false, error: 'Missing url' };
  if (!isSafeNavigationUrl(cmd.url)) return { id: cmd.id, ok: false, error: 'Blocked URL scheme — only http:// and https:// are allowed', errorCode: 'invalid_url' };
  const hadTab = s.preferredTabId !== null || Boolean(cmd.page);
  const tabId = await sessions.resolveTab(s, cmd.page, cmd.url);
  const before = await chrome.tabs.get(tabId);
  const target = cmd.url;
  if (normalizeUrl(before.url) === normalizeUrl(target) || (before.pendingUrl && normalizeUrl(before.pendingUrl) === normalizeUrl(target))) {
    // already there, or just created for this URL (createTab already waited for the load once)
    const t = hadTab ? await waitForLoad(tabId, 15_000) : before;
    if (!t.url) return notLoaded(cmd.id, target, `did not commit (status ${t.status})`);
    const errDoc = await isErrorDocument(tabId);
    if (errDoc) return notLoaded(cmd.id, target, `the browser shows its error page (${errDoc})`);
    return pageScoped(cmd.id, tabId, { title: t.title, url: t.url, timedOut: t.status !== 'complete' });
  }
  const beforeNorm = normalizeUrl(before.url);
  let navError: string | null = null;
  const onErr = (d: chrome.webNavigation.WebNavigationFramedErrorCallbackDetails) => { if (d.tabId === tabId && d.frameId === 0) navError = d.error; };
  chrome.webNavigation.onErrorOccurred.addListener(onErr);
  // Adapter tabs may be provisioned blank before the command starts; arm capture before their first navigation too.
  if (s.surface === 'adapter') await executor.ensureAttached(tabId, false).catch(() => {});
  await chrome.tabs.update(tabId, { url: target });
  let timedOut = false;
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => { if (done) return; done = true; chrome.tabs.onUpdated.removeListener(listener); chrome.webNavigation.onErrorOccurred.removeListener(onErr); clearTimeout(timer); clearTimeout(check); resolve(); };
    const isDone = (url?: string) => normalizeUrl(url) === normalizeUrl(target) || normalizeUrl(url) !== beforeNorm;
    const listener = (id: number, info: chrome.tabs.OnUpdatedInfo, tab: chrome.tabs.Tab) => { if (id === tabId && info.status === 'complete' && isDone(tab.url ?? info.url)) finish(); };
    chrome.tabs.onUpdated.addListener(listener);
    const check = setTimeout(async () => { try { const t = await chrome.tabs.get(tabId); if (t.status === 'complete' && isDone(t.url)) finish(); } catch { finish(); } }, 100);
    const timer = setTimeout(() => { timedOut = true; finish(); }, 15_000);
  });
  chrome.webNavigation.onErrorOccurred.removeListener(onErr);
  const after = await chrome.tabs.get(tabId);
  if (navError) return notLoaded(cmd.id, target, navError);
  const errDoc = await isErrorDocument(tabId);
  if (errDoc) return notLoaded(cmd.id, target, `the browser shows its error page (${errDoc})`);
  const lease = s.leases.get(tabId); if (lease) { lease.url = after.url; lease.title = after.title; }
  return pageScoped(cmd.id, tabId, { title: after.title, url: after.url, timedOut });
}

async function handleTabs(cmd: Command, s: Session): Promise<Result> {
  switch (cmd.op) {
    case 'list': {
      const out: Array<{ index: number; tabId: number; page: string; url?: string; title?: string; active: boolean; selected: boolean; origin: string; state: string }> = [];
      let i = 0;
      for (const lease of s.leases.values()) {
        const t = await chrome.tabs.get(lease.tabId).catch(() => null);
        if (!t) continue;
        out.push({ index: i++, tabId: lease.tabId, page: identity.pageId(lease.tabId), url: t.url, title: t.title, active: Boolean(t.active), selected: lease.tabId === s.preferredTabId, origin: lease.origin, state: lease.state });
      }
      return { id: cmd.id, ok: true, data: out };
    }
    case 'new': {
      if (cmd.url && !isSafeNavigationUrl(cmd.url)) return { id: cmd.id, ok: false, error: 'Blocked URL scheme', errorCode: 'invalid_url' };
      const created = await sessions.createTab(s, cmd.url); // waits for the initial load when a URL is given
      const t = await chrome.tabs.get(created.tabId).catch(() => created.tab);
      if (cmd.url) {
        const detail = !t.url ? `did not commit (status ${t.status})` : await isErrorDocument(created.tabId).then((u) => (u ? `the browser shows its error page (${u})` : null));
        if (detail) {
          // Keep ownership until Chrome confirms the dead tab is closed; a failed close remains retryable.
          try { await sessions.endTab(s, created.tabId, 'close'); }
          catch (error) { throw new SessionError('tab_create_cleanup_failed', `Opening ${cmd.url} failed and tab ${created.tabId} could not be closed: ${String(error)}`, 'The tab remains in this session. Use tab_list and tab_close to clean it up.'); }
          return notLoaded(cmd.id, cmd.url, detail);
        }
      }
      return { id: cmd.id, ok: true, page: created.page, data: { url: t.url, title: t.title } };
    }
    case 'close':
    case 'release': {
      let tabId: number | undefined;
      if (cmd.page) tabId = await identity.resolveTabId(cmd.page).catch(() => undefined);
      else tabId = s.preferredTabId ?? undefined;
      if (tabId === undefined) return { id: cmd.id, ok: false, error: 'Page no longer exists', errorCode: 'stale_page' };
      return { id: cmd.id, ok: true, data: await sessions.endTab(s, tabId, cmd.op) };
    }
    default: return { id: cmd.id, ok: false, error: `Unknown tabs op: ${String(cmd.op)}` };
  }
}

async function handleCookies(cmd: Command): Promise<Result> {
  if (!cmd.domain && !cmd.url) return { id: cmd.id, ok: false, error: 'Cookie scope required: domain or url', errorCode: 'cookie_scope_required' };
  const details: chrome.cookies.GetAllDetails = {};
  if (cmd.url) details.url = cmd.url; else if (cmd.domain) details.domain = cmd.domain;
  const cookies = await chrome.cookies.getAll(details);
  return { id: cmd.id, ok: true, data: cookies.map((c) => ({ name: c.name, value: c.value, domain: c.domain, path: c.path, secure: c.secure, httpOnly: c.httpOnly, expirationDate: c.expirationDate })) };
}

async function handleCdp(cmd: Command, s: Session): Promise<Result> {
  if (!cmd.cdpMethod) return { id: cmd.id, ok: false, error: 'Missing cdpMethod' };
  if (!CDP_ALLOWLIST.has(cmd.cdpMethod)) return { id: cmd.id, ok: false, error: `CDP method not permitted: ${cmd.cdpMethod}`, errorCode: 'cdp_not_allowed' };
  const tabId = await sessions.resolveTab(s, cmd.page);
  await executor.ensureAttached(tabId, s.surface === 'browser');
  const params = cmd.cdpParams ?? {};
  const routeFrameId = typeof params.frameId === 'string' && params.sessionId === 'target' ? params.frameId : undefined;
  const { sessionId: _sid, frameId: _fid, targetUrl, ...rest } = params as Record<string, unknown>;
  const data = routeFrameId
    ? await executor.sendCommandInFrameTarget(tabId, routeFrameId, cmd.cdpMethod, rest, s.surface === 'browser', commandTimeoutMs(cmd) ?? 30_000)
    : await executor.sendDebuggerCommand({ tabId }, cmd.cdpMethod, _fid !== undefined ? { ...rest, frameId: _fid } : rest, commandTimeoutMs(cmd));
  return pageScoped(cmd.id, tabId, data);
}
