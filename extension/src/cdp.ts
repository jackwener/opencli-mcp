// Derived from OpenCLI (https://github.com/jackwener/OpenCLI), Apache-2.0. Adapted for opencli-mcp.
import type { DownloadWaitResult } from '../../src/protocol.js';
/**
 * CDP execution via chrome.debugger API.
 *
 * chrome.debugger only needs the "debugger" permission — no host_permissions.
 * It can attach to any http/https tab. Avoid chrome:// and chrome-extension://
 * tabs (session tab selection prevents accidental use of unrelated tabs).
 */

const attached = new Set<number>();


// Large cap so agents stop hitting silent JSON.parse failures on real API bodies.
const CDP_RESPONSE_BODY_CAPTURE_LIMIT = 1 * 1024 * 1024;
/** Capture keeps at most this many pending entries per tab (the host drains after every goto/act). */
const CAPTURE_MAX_ENTRIES = 600;
/** Traffic that can carry data or trigger an action; assets (images, fonts, styles, scripts, media) are noise for API discovery. */
const CAPTURED_TYPES = new Set(['Document', 'XHR', 'Fetch', 'WebSocket', 'EventSource', 'Other']);
const CDP_REQUEST_BODY_CAPTURE_LIMIT = 1 * 1024 * 1024;

type NetworkCaptureEntry = {
  kind: 'cdp';
  requestId: string;
  url: string;
  method: string;
  /** CDP resource type: Document | XHR | Fetch | … */
  resourceType?: string;
  requestHeaders?: Record<string, string>;
  requestBodyKind?: string;
  requestBodyPreview?: string;
  requestBodyFullSize?: number;
  requestBodyTruncated?: boolean;
  responseStatus?: number;
  responseContentType?: string;
  responseHeaders?: Record<string, string>;
  responsePreview?: string;
  responseBodyFullSize?: number;
  responseBodyTruncated?: boolean;
  timestamp: number;
  /** response received and body read (or the load failed): only then does a read hand the entry out */
  done?: boolean;
};

type NetworkCaptureState = {
  patterns: string[];
  entries: NetworkCaptureEntry[];
  requestToIndex: Map<string, number>;
};

export interface PageDownloadStart { seq: number; guid?: string; url: string; suggestedFilename: string; timestamp: number }
type DownloadCapture = { pageSeq: number; entries: PageDownloadStart[]; anchors: Map<number, { pageSeq: number; chromeSeq: number }> };
type ChromeDownloadStart = { seq: number; id: number; url: string; finalUrl: string };
const pageDownloads = new Map<number, DownloadCapture>();
const chromeDownloads: ChromeDownloadStart[] = [];
let chromeDownloadSeq = 0;
let downloadCursorSeq = 0;

function downloadState(tabId: number): DownloadCapture {
  let state = pageDownloads.get(tabId);
  if (!state) { state = { pageSeq: 0, entries: [], anchors: new Map() }; pageDownloads.set(tabId, state); }
  return state;
}

/** Arm before the action: only Chrome downloads created after this point can satisfy the result. */
export function downloadCursor(tabId: number): number {
  const state = downloadState(tabId);
  const cursor = ++downloadCursorSeq;
  state.anchors.set(cursor, { pageSeq: state.pageSeq, chromeSeq: chromeDownloadSeq });
  if (state.anchors.size > 100) state.anchors.delete(state.anchors.keys().next().value!);
  return cursor;
}
export function pageDownloadsAfter(tabId: number, afterSequence: number): PageDownloadStart[] {
  const state = pageDownloads.get(tabId);
  const anchor = state?.anchors.get(afterSequence);
  return anchor ? state!.entries.filter((entry) => entry.seq > anchor.pageSeq) : [];
}

function notePageDownload(tabId: number, params: { guid?: string; url?: string; suggestedFilename?: string }): void {
  const state = downloadState(tabId);
  if (params.guid && state.entries.some((entry) => entry.guid === params.guid)) return;
  state.entries.push({ seq: ++state.pageSeq, ...(params.guid && { guid: params.guid }), url: String(params.url ?? ''), suggestedFilename: String(params.suggestedFilename ?? ''), timestamp: Date.now() });
  if (state.entries.length > 100) state.entries.splice(0, state.entries.length - 100);
}

const networkCaptures = new Map<number, NetworkCaptureState>();

/**
 * Native JavaScript dialogs (alert/confirm/prompt/beforeunload) freeze the page: every
 * Runtime/DOM command hangs until the dialog is answered. Track them from Page events
 * so commands fail fast with `dialog_open` instead of timing out, and let the agent
 * read and answer the dialog explicitly (the ChatGPT plugin surfaces dialogs as state).
 */
export interface PendingDialog { type: 'alert' | 'confirm' | 'prompt' | 'beforeunload'; message: string; defaultPrompt?: string; url?: string; openedAt: number; /** CDP session that reported it (an OOPIF child session); undefined = root */ sessionId?: string }
const dialogs = new Map<number, PendingDialog>();
const dialogWaiters = new Map<number, Set<(d: PendingDialog) => void>>();

/** Console messages + uncaught exceptions per tab (ring buffer), captured from Runtime events while attached. */
interface ConsoleEntry { seq: number; level: 'debug' | 'info' | 'log' | 'warn' | 'error'; message: string; timestamp: string; url?: string; line?: number }
const consoleLogs = new Map<number, { seq: number; entries: ConsoleEntry[] }>();
const CONSOLE_CAP = 500;
function noteConsole(tabId: number, level: ConsoleEntry['level'], message: string, url?: string, line?: number): void {
  let log = consoleLogs.get(tabId);
  if (!log) { log = { seq: 0, entries: [] }; consoleLogs.set(tabId, log); }
  log.entries.push({ seq: ++log.seq, level, message: message.slice(0, 4000), timestamp: new Date().toISOString(), url, line });
  if (log.entries.length > CONSOLE_CAP) log.entries.splice(0, log.entries.length - CONSOLE_CAP);
}
function describeRemoteObject(o: { type?: string; value?: unknown; description?: string; unserializableValue?: string }): string {
  if (o.value !== undefined) return typeof o.value === 'string' ? o.value : JSON.stringify(o.value);
  return o.unserializableValue ?? o.description ?? String(o.type ?? '');
}
export function readConsole(tabId: number, opts: { afterSequence?: number; limit?: number; levels?: string[]; filter?: string } = {}): { cursor: number; entries: ConsoleEntry[]; hasMore: boolean } {
  const log = consoleLogs.get(tabId);
  const after = opts.afterSequence ?? 0;
  const levels = opts.levels?.length ? new Set(opts.levels.map((l) => (l === 'warning' ? 'warn' : l))) : null;
  const all = (log?.entries ?? []).filter((e) => e.seq > after && (!levels || levels.has(e.level)) && (!opts.filter || e.message.includes(opts.filter)));
  const limit = Math.max(1, Math.min(opts.limit ?? 100, 500));
  const page = all.slice(0, limit);
  return { cursor: page.length ? page[page.length - 1].seq : after, entries: page, hasMore: all.length > limit };
}
const dialogClosedWaiters = new Map<number, Set<() => void>>();
export function getDialog(tabId: number): PendingDialog | null { return dialogs.get(tabId) ?? null; }

function dialogOpenError(tabId: number, d: PendingDialog, method: string): Error {
  return Object.assign(new Error(`${method} blocked: a native ${d.type} dialog is open ("${d.message.slice(0, 120)}")`), {
    code: 'dialog_open',
    hint: 'Read it with dialog get; answer it with dialog accept (optionally with prompt text) or dismiss, then retry.',
    dialog: d,
    tabId,
  });
}

/**
 * Answer the dialog the way the ChatGPT plugin does: send Page.handleJavaScriptDialog and treat the
 * Page.javascriptDialogClosed event as the confirmation — the command's own response may be delayed or lost while the
 * renderer sits in the dialog's nested loop. Tried on the session that reported the dialog (an OOPIF child) and on the
 * root session. chrome.debugger refuses Target.attachToTarget on the page ("Not allowed"), so there is no side channel;
 * what matters is that the root session is never detached while the dialog is open (see ensureAttached) because
 * Chromium keeps the dialog's pending callback in that session's PageHandler.
 */
export async function handleDialog(tabId: number, accept: boolean, promptText?: string): Promise<PendingDialog | null> {
  const d = dialogs.get(tabId) ?? null;
  const params = { accept, ...(promptText !== undefined && { promptText }) };
  let onClosed: (() => void) | undefined;
  const closed = new Promise<'closed'>((resolve) => {
    onClosed = () => resolve('closed');
    if (!dialogClosedWaiters.has(tabId)) dialogClosedWaiters.set(tabId, new Set());
    dialogClosedWaiters.get(tabId)!.add(onClosed);
  });
  const sessions = new Set<string | undefined>([d?.sessionId, undefined]);
  const attempts = [...sessions].map((sessionId) => {
    const target = (sessionId ? { tabId, sessionId } : { tabId }) as chrome.debugger.Debuggee;
    return sendDebuggerCommand(target, 'Page.handleJavaScriptDialog', params, 5_000).then(() => 'ok' as const, (e: unknown) => (e instanceof Error ? e.message : String(e)));
  });
  const allDone = Promise.all(attempts).then((rs) => (rs.includes('ok') ? 'ok' as const : rs.join(' | ')));
  const timeout = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 6_000));
  try {
    const outcome = await Promise.race([closed, allDone, timeout]);
    if (outcome === 'closed' || outcome === 'ok') { dialogs.delete(tabId); return d; }
    if (outcome === 'timeout') throw Object.assign(new Error('the dialog did not close within 6s'), { code: 'dialog_answer_timeout', hint: 'Check the browser window; the dialog may need the tab to be visible.' });
    if (/No dialog is showing/i.test(outcome)) throw Object.assign(new Error('no session sees a dialog to answer'), { code: 'no_dialog', hint: d ? 'The tracked dialog is stale; it was closed by the page or the user.' : 'Nothing is pending.' });
    throw new Error(outcome);
  } finally {
    if (onClosed) dialogClosedWaiters.get(tabId)?.delete(onClosed);
  }
}

function noteDialog(tabId: number, d: PendingDialog | null): void {
  if (d) { dialogs.set(tabId, d); for (const w of dialogWaiters.get(tabId) ?? []) w(d); }
  else { dialogs.delete(tabId); for (const w of dialogClosedWaiters.get(tabId) ?? []) w(); }
}

/**
 * Default deadline for a single chrome.debugger command. chrome.debugger has
 * no timeout of its own: a page-blocking native dialog (alert/confirm/print/
 * beforeunload) makes Runtime.evaluate hang forever, wedging every later
 * command on the tab. Long enough for legitimate in-page waits (default 30s
 * plus headroom), short enough to fail before the daemon's 120s timer.
 */
const CDP_COMMAND_TIMEOUT_MS = 60_000;

/**
 * chrome.debugger.sendCommand with a deadline. The underlying command cannot
 * be cancelled — this only unblocks the caller so the CLI gets an error
 * instead of an infinite hang.
 */
export async function sendDebuggerCommand<T = unknown>(
  target: chrome.debugger.Debuggee,
  method: string,
  params?: Record<string, unknown>,
  timeoutMs: number = CDP_COMMAND_TIMEOUT_MS,
): Promise<T> {
  return sendDebuggerCommandOnce(target, method, params, timeoutMs, true);
}

async function sendDebuggerCommandOnce<T>(target: chrome.debugger.Debuggee, method: string, params: Record<string, unknown> | undefined, timeoutMs: number, mayRetry: boolean): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tabId = target.tabId;
  const isDialogAnswer = method === 'Page.handleJavaScriptDialog';
  if (tabId !== undefined && !isDialogAnswer) { const d = dialogs.get(tabId); if (d) throw dialogOpenError(tabId, d, method); }
  let waiter: ((d: PendingDialog) => void) | undefined;
  const dialogPromise = tabId === undefined || isDialogAnswer ? null : new Promise<never>((_, reject) => {
    waiter = (d) => reject(dialogOpenError(tabId, d, method));
    if (!dialogWaiters.has(tabId)) dialogWaiters.set(tabId, new Set());
    dialogWaiters.get(tabId)!.add(waiter);
  });
  const commandPromise = (params === undefined
    ? chrome.debugger.sendCommand(target, method)
    : chrome.debugger.sendCommand(target, method, params)) as Promise<T>;
  // If the timeout wins the race, the command promise may still reject much
  // later (e.g. debugger detach on tab close) — swallow that on a side branch
  // so it never surfaces as an unhandled rejection in the service worker.
  commandPromise.catch(() => {});
  try {
    return await Promise.race([
      commandPromise,
      ...(dialogPromise ? [dialogPromise] : []),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(
          `CDP command ${method} timed out after ${Math.round(timeoutMs / 1000)}s — the page may be blocked by a native dialog (alert/confirm/print)`,
        )), timeoutMs);
      }),
    ]);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // the debugger went away under us (user clicked "cancel" on the debugging bar, another extension, a crash):
    // forget the attachment and retry the command once on a fresh attach — the plugin's "Debugger unattached" path
    if (mayRetry && tabId !== undefined && !(target as { sessionId?: string }).sessionId && attached.has(tabId) && /Debugger is not attached|Detached while|Target closed|not attached/i.test(msg)) {
      attached.delete(tabId);
      await ensureAttached(tabId, false);
      return sendDebuggerCommandOnce<T>(target, method, params, timeoutMs, false);
    }
    throw e;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (waiter && tabId !== undefined) dialogWaiters.get(tabId)?.delete(waiter);
  }
}

/** Check if a URL can be attached via CDP — only allow http(s) and blank pages. */
function isDebuggableUrl(url?: string): boolean {
  if (!url) return true;  // empty/undefined = tab still loading, allow it
  return url.startsWith('http://') || url.startsWith('https://') || url === 'about:blank' || url.startsWith('data:');
}

export async function ensureAttached(tabId: number, aggressiveRetry: boolean = false): Promise<void> {
  // Verify the tab URL is debuggable before attempting attach
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!isDebuggableUrl(tab.url)) {
      // Invalidate cache if previously attached
      attached.delete(tabId);
      throw new Error(`Cannot debug tab ${tabId}: URL is ${tab.url ?? 'unknown'}`);
    }
  } catch (e) {
    // Re-throw our own error, catch only chrome.tabs.get failures
    if (e instanceof Error && e.message.startsWith('Cannot debug tab')) throw e;
    attached.delete(tabId);
    throw new Error(`Tab ${tabId} no longer exists`);
  }

  // Attachment is a fact we track, not something to re-verify per command (the ChatGPT plugin does the same): the
  // `attached` set is kept honest by chrome.debugger.onDetach, and a command that still fails with "not attached"
  // forgets the tab and retries once (see sendDebuggerCommand). A per-command probe cost a round trip and, worse,
  // re-attached while a dialog was open — which dropped the session that owned the dialog's pending callback.
  if (attached.has(tabId)) return;
  const inFlight = attaching.get(tabId);
  if (inFlight) { await inFlight; return; }
  const p = attachNow(tabId, aggressiveRetry).finally(() => { attaching.delete(tabId); });
  attaching.set(tabId, p);
  await p;
}

/** One attach at a time per tab: concurrent commands on a fresh tab share the same attach instead of racing detach/attach. */
const attaching = new Map<number, Promise<void>>();

async function attachNow(tabId: number, aggressiveRetry: boolean): Promise<void> {

  // Retry attach up to 3 times — other extensions (1Password, Playwright MCP Bridge)
  // can temporarily interfere with chrome.debugger. A short delay usually resolves it.
  // Normal commands: 2 retries, 500ms delay (fast fail for non-browser use)
  // Browser commands: 5 retries, 1500ms delay (aggressive, tolerates extension interference)
  const MAX_ATTACH_RETRIES = aggressiveRetry ? 5 : 2;
  const RETRY_DELAY_MS = aggressiveRetry ? 1500 : 500;
  let lastError = '';

  // The forced detach below fires chrome.debugger.onDetach, whose handler wipes
  // this tab's armed network-capture state; detaching also disables the CDP
  // Network domain. Snapshot the capture so we can restore it after a successful
  // re-attach instead of silently dropping in-flight capture — otherwise any
  // non-navigate command that triggers a re-attach (a stale-attach health-check
  // failure during SPA navigation or third-party debugger interference) leaves
  // network-capture-read returning [] even though requests fired.
  const preservedNetworkCapture = networkCaptures.get(tabId);

  for (let attempt = 1; attempt <= MAX_ATTACH_RETRIES; attempt++) {
    try {
      // Force detach first to clear any stale state from other extensions
      try { await chrome.debugger.detach({ tabId }); } catch { /* ignore */ }
      await chrome.debugger.attach({ tabId }, '1.3');
      lastError = '';
      break; // Success
    } catch (e: unknown) {
      lastError = e instanceof Error ? e.message : String(e);
      if (attempt < MAX_ATTACH_RETRIES) {
        console.warn(`[opencli-mcp] attach attempt ${attempt}/${MAX_ATTACH_RETRIES} failed: ${lastError}, retrying in ${RETRY_DELAY_MS}ms...`);
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
        // Re-verify tab URL before retrying (it may have changed)
        try {
          const tab = await chrome.tabs.get(tabId);
          if (!isDebuggableUrl(tab.url)) {
            lastError = `Tab URL changed to ${tab.url} during retry`;
            break; // Don't retry if URL became un-debuggable
          }
        } catch {
          // Tab is gone — don't fail early here.
          // Later retry layers can re-resolve a fresh automation tab/window.
          lastError = `Tab ${tabId} no longer exists`;
          // Don't break; fall through to retry
        }
      }
    }
  }

  if (lastError) {
    // Log detailed diagnostics for debugging extension conflicts
    let finalUrl = 'unknown';
    let finalWindowId = 'unknown';
    try {
      const tab = await chrome.tabs.get(tabId);
      finalUrl = tab.url ?? 'undefined';
      finalWindowId = String(tab.windowId);
    } catch { /* tab gone */ }
    console.warn(`[opencli-mcp] attach failed for tab ${tabId}: url=${finalUrl}, windowId=${finalWindowId}, error=${lastError}`);

    const hint = lastError.includes('chrome-extension://')
      ? '. Tip: another Chrome extension may be interfering — try disabling other extensions'
      : '';
    throw new Error(`attach failed: ${lastError}${hint}`);
  }
  attached.add(tabId);

  try {
    await sendDebuggerCommand({ tabId }, 'Runtime.enable');
  } catch {
    // Some pages may not need explicit enable
  }
  // Page events carry javascriptDialogOpening/Closed (dialog tracking) — must be enabled per attach
  await sendDebuggerCommand({ tabId }, 'Page.enable').catch(() => {});
  // out-of-process iframes announce themselves as child sessions from now on (see trackOopifs)
  await armOopifAutoAttach(tabId);
  // like the ChatGPT plugin: pages gate on document.hasFocus() even when the tab is not the active one
  await sendDebuggerCommand({ tabId }, 'Emulation.setFocusEmulationEnabled', { enabled: true }, 3_000).catch(() => {});

  // Restore network capture that the re-attach (detach + onDetach) tore down.
  // The detach always disables the CDP Network domain, so re-enable it and put
  // the accumulated capture state back unconditionally. Done last (after the
  // awaits above) so it wins over the onDetach handler's delete, which fires
  // while those awaits yield to the event loop.
  if (!preservedNetworkCapture && aggressiveRetry) {
    // Browser tabs capture requests from attachment onward. Adapter tabs opt in explicitly.
    try { await sendDebuggerCommand({ tabId }, 'Network.enable'); networkCaptures.set(tabId, { patterns: [], entries: [], requestToIndex: new Map() }); } catch { /* next start-capture arms it */ }
  }
  if (preservedNetworkCapture) {
    try {
      await sendDebuggerCommand({ tabId }, 'Network.enable');
      networkCaptures.set(tabId, preservedNetworkCapture);
    } catch {
      // Leave capture cleared rather than arm a half-attached Network domain;
      // the next start-capture re-arms cleanly.
    }
  }
}

export async function evaluate(
  tabId: number,
  expression: string,
  aggressiveRetry: boolean = false,
  timeoutMs: number = CDP_COMMAND_TIMEOUT_MS,
): Promise<unknown> {
  // The host controls command retries. ensureAttached retries attachment locally;
  // a debugger error mid-evaluate invalidates the cache for the next attempt.
  try {
    await ensureAttached(tabId, aggressiveRetry);

    const result = await sendDebuggerCommand({ tabId }, 'Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    }, timeoutMs) as {
      result?: { type: string; value?: unknown; description?: string; subtype?: string };
      exceptionDetails?: { exception?: { description?: string }; text?: string };
    };

    if (result.exceptionDetails) {
      const errMsg = result.exceptionDetails.exception?.description
        || result.exceptionDetails.text
        || 'Eval error';
      throw new Error(errMsg);
    }

    return result.result?.value;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('Detached') || msg.includes('Debugger is not attached') || msg.includes('Target closed')) {
      attached.delete(tabId); // Force re-attach on the next command
    }
    throw e;
  }
}

/**
 * Capture a screenshot via CDP Page.captureScreenshot.
 * Returns base64-encoded image data.
 */
export async function screenshot(
  tabId: number,
  options: { format?: 'png' | 'jpeg'; quality?: number; fullPage?: boolean; width?: number; height?: number } = {},
): Promise<string> {
  await ensureAttached(tabId);

  const format = options.format ?? 'png';
  const fullPage = options.fullPage === true;
  const overrideWidth = options.width && options.width > 0 ? Math.ceil(options.width) : undefined;
  // height is ignored under fullPage so the existing measure-from-content path stays unchanged for users who pass --height alongside --full-page.
  const overrideHeight = !fullPage && options.height && options.height > 0 ? Math.ceil(options.height) : undefined;
  const needsOverride = fullPage || overrideWidth !== undefined || overrideHeight !== undefined;

  if (needsOverride) {
    // When width is set, apply it first so layout reflows before we read content size.
    if (overrideWidth !== undefined && fullPage) {
      await sendDebuggerCommand({ tabId }, 'Emulation.setDeviceMetricsOverride', {
        mobile: false,
        width: overrideWidth,
        height: 0,
        deviceScaleFactor: 1,
      });
    }
    let finalWidth = overrideWidth ?? 0;
    let finalHeight = overrideHeight ?? 0;
    if (fullPage) {
      const metrics = await sendDebuggerCommand({ tabId }, 'Page.getLayoutMetrics') as {
        contentSize?: { width: number; height: number };
        cssContentSize?: { width: number; height: number };
      };
      const size = metrics.cssContentSize || metrics.contentSize;
      if (size) {
        if (finalWidth === 0) finalWidth = Math.ceil(size.width);
        finalHeight = Math.ceil(size.height);
      }
    }
    await sendDebuggerCommand({ tabId }, 'Emulation.setDeviceMetricsOverride', {
      mobile: false,
      width: finalWidth,
      height: finalHeight,
      deviceScaleFactor: 1,
    });
  }

  try {
    const params: Record<string, unknown> = { format };
    if (format === 'jpeg' && options.quality !== undefined) {
      params.quality = Math.max(0, Math.min(100, options.quality));
    }

    const result = await sendDebuggerCommand({ tabId }, 'Page.captureScreenshot', params) as {
      data: string; // base64-encoded
    };

    return result.data;
  } finally {
    if (needsOverride) {
      await sendDebuggerCommand({ tabId }, 'Emulation.clearDeviceMetricsOverride').catch(() => {});
    }
  }
}

function downloadResult(item: chrome.downloads.DownloadItem, startedAt: number, event: PageDownloadStart): DownloadWaitResult {
  return {
    downloaded: item.state === 'complete',
    started: true,
    sequence: event.seq,
    suggestedFilename: event.suggestedFilename,
    association: 'url+event',
    id: item.id,
    filename: item.filename,
    url: item.url,
    finalUrl: item.finalUrl,
    mime: item.mime,
    totalBytes: item.totalBytes,
    state: item.state,
    danger: item.danger,
    error: item.error,
    elapsedMs: Date.now() - startedAt,
  };
}

/** Pair the tab's Page event with a new Chrome download observed after the action was armed. */
export async function waitForDownload(tabId: number, afterSequence: number, timeoutMs: number = 30000): Promise<DownloadWaitResult> {
  const startedAt = Date.now();
  const timeout = Math.max(1, timeoutMs);
  const deadline = startedAt + timeout;
  const anchor = pageDownloads.get(tabId)?.anchors.get(afterSequence);
  if (!anchor) return { downloaded: false, started: false, state: 'cursor_expired', error: 'Download cursor is no longer available.', elapsedMs: 0 };
  let event: PageDownloadStart | undefined;
  for (;;) {
    const starts = pageDownloadsAfter(tabId, afterSequence);
    if (starts.length > 1) return { downloaded: false, started: true, state: 'ambiguous', candidates: starts.length, error: 'This action started multiple downloads.', elapsedMs: Date.now() - startedAt };
    event = starts[0];
    if (event) break;
    if (Date.now() >= deadline) return { downloaded: false, started: false, state: 'not_started', elapsedMs: Date.now() - startedAt };
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  for (;;) {
    const starts = pageDownloadsAfter(tabId, afterSequence);
    if (starts.length > 1) return { downloaded: false, started: true, state: 'ambiguous', candidates: starts.length, error: 'This action started multiple downloads.', elapsedMs: Date.now() - startedAt };
    const matches = chromeDownloads.filter((item) => item.seq > anchor.chromeSeq && (item.url === event.url || item.finalUrl === event.url));
    if (matches.length > 1) return { downloaded: false, started: true, sequence: event.seq, suggestedFilename: event.suggestedFilename, state: 'ambiguous', candidates: matches.length, error: 'Multiple Chrome downloads match the page event.', elapsedMs: Date.now() - startedAt };
    const item = matches[0] ? (await chrome.downloads.search({ id: matches[0].id }))[0] : undefined;
    if (item?.state === 'complete' || item?.state === 'interrupted') return downloadResult(item, startedAt, event);
    if (Date.now() >= deadline) return { downloaded: false, started: true, sequence: event.seq, suggestedFilename: event.suggestedFilename, url: event.url, state: item?.state ?? 'unconfirmed', elapsedMs: Date.now() - startedAt };
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/**
 * Out-of-process iframes (site isolation) are separate targets. A tab-scoped `Target.getTargets` does not list them;
 * what works — and what the ChatGPT plugin does — is `Target.setAutoAttach({flatten:true})` on the tab session, after
 * which Chrome reports every OOPIF child as `Target.attachedToTarget` with its own sessionId. Commands for such a frame
 * are sent on `{tabId, sessionId}`; the frameId of an OOPIF equals its targetId. Nested OOPIFs are auto-attached from
 * their parent session the same way.
 */
interface OopifSession { sessionId: string; targetId: string; url: string; parentSessionId?: string }
const oopifByTab = new Map<number, Map<string, OopifSession>>(); // tabId → targetId(frameId) → session
const oopifWaiters = new Map<string, Set<() => void>>();          // `${tabId}:${frameId}` → resolvers waiting for attach

export function oopifSessions(tabId: number): OopifSession[] { return [...(oopifByTab.get(tabId)?.values() ?? [])]; }

function noteOopif(tabId: number, info: { targetId: string; type: string; url: string }, sessionId: string, parentSessionId?: string): void {
  if (info.type !== 'iframe') return;
  if (!oopifByTab.has(tabId)) oopifByTab.set(tabId, new Map());
  oopifByTab.get(tabId)!.set(info.targetId, { sessionId, targetId: info.targetId, url: info.url, parentSessionId });
  for (const w of oopifWaiters.get(`${tabId}:${info.targetId}`) ?? []) w();
  // the child may host further OOPIFs: auto-attach from its session too (Page must be enabled for frame trees)
  void sendDebuggerCommand({ tabId, sessionId } as chrome.debugger.Debuggee, 'Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, 3_000).catch(() => {});
  void sendDebuggerCommand({ tabId, sessionId } as chrome.debugger.Debuggee, 'Page.enable', undefined, 3_000).catch(() => {});
}

/** Called once from registerListeners: keep the OOPIF map honest from Target events on the tab and its child sessions. */
function trackOopifs(source: chrome.debugger.Debuggee, method: string, params: any): void {
  const tabId = source.tabId; if (!tabId) return;
  if (method === 'Target.attachedToTarget' && params?.sessionId && params?.targetInfo) noteOopif(tabId, params.targetInfo, params.sessionId, (source as { sessionId?: string }).sessionId);
  else if (method === 'Target.detachedFromTarget' && params?.targetId) oopifByTab.get(tabId)?.delete(params.targetId);
  else if (method === 'Target.targetInfoChanged' && params?.targetInfo?.targetId) { const e = oopifByTab.get(tabId)?.get(params.targetInfo.targetId); if (e) e.url = params.targetInfo.url; }
}

/** Auto-attach is armed at tab attach (see attachNow) so OOPIF sessions exist before anyone asks for them. */
export async function armOopifAutoAttach(tabId: number): Promise<void> {
  await sendDebuggerCommand({ tabId }, 'Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, 3_000).catch((e) => console.warn(`[opencli-mcp] Target.setAutoAttach failed for tab ${tabId}: ${e instanceof Error ? e.message : String(e)}`));
}

/** Sessions we opened ourselves by attaching to the iframe target (the plugin's approach); keyed `${tabId}:${frameId}`. */
const directTargets = new Map<string, string>();

/** Debuggee for a frame's own session: a tracked auto-attached child session, else a direct attachment to the iframe target. */
async function frameDebuggee(tabId: number, frameId: string, aggressiveRetry = false): Promise<chrome.debugger.Debuggee> {
  const tracked = oopifByTab.get(tabId)?.get(frameId);
  if (tracked) return { tabId, sessionId: tracked.sessionId } as chrome.debugger.Debuggee;
  const key = `${tabId}:${frameId}`;
  if (directTargets.has(key)) return { targetId: frameId } as chrome.debugger.Debuggee;
  await ensureAttached(tabId, aggressiveRetry);
  try { await chrome.debugger.attach({ targetId: frameId } as chrome.debugger.Debuggee, '1.3'); }
  catch (e) { const msg = e instanceof Error ? e.message : String(e); if (!/already attached/i.test(msg)) throw Object.assign(new Error(`frame ${frameId} has no attachable target: ${msg}`), { code: 'frame_unreachable' }); }
  directTargets.set(key, frameId);
  return { targetId: frameId } as chrome.debugger.Debuggee;
}

async function ensureFrameSession(tabId: number, frameId: string, aggressiveRetry = false, waitMs = 1_500): Promise<OopifSession> {
  await ensureAttached(tabId, aggressiveRetry);
  const found = oopifByTab.get(tabId)?.get(frameId);
  if (found) return found;
  await armOopifAutoAttach(tabId);
  const again = oopifByTab.get(tabId)?.get(frameId);
  if (again) return again;
  // the frame may be attaching right now (navigation in flight): wait briefly for its attachedToTarget
  const key = `${tabId}:${frameId}`;
  await new Promise<void>((resolve) => {
    const w = () => { oopifWaiters.get(key)?.delete(w); resolve(); };
    if (!oopifWaiters.has(key)) oopifWaiters.set(key, new Set());
    oopifWaiters.get(key)!.add(w);
    setTimeout(w, waitMs);
  });
  const late = oopifByTab.get(tabId)?.get(frameId);
  if (late) return late;
  throw Object.assign(new Error(`frame ${frameId} has no out-of-process target`), { code: 'frame_unreachable' });
}

/** True when the frame renders in its own process (has an auto-attached iframe session); false for in-process frames. */
export async function hasFrameTarget(tabId: number, frameId: string, aggressiveRetry = false): Promise<boolean> {
  try { await frameDebuggee(tabId, frameId, aggressiveRetry); return true; } catch { return false; }
}

export async function sendCommandInFrameTarget(
  tabId: number,
  frameId: string,
  method: string,
  params: Record<string, unknown> = {},
  aggressiveRetry: boolean = false,
  timeoutMs: number = CDP_COMMAND_TIMEOUT_MS,
): Promise<unknown> {
  const target = await frameDebuggee(tabId, frameId, aggressiveRetry);
  return sendDebuggerCommand(target, method, params, timeoutMs);
}

export interface FrameEntry { index: number; frameId: string; url: string; name: string; crossOrigin: boolean; /** lives in its own renderer process (site isolation) */ oopif: boolean }
type FrameNode = { frame: { id: string; url: string; name?: string }; childFrames?: FrameNode[] };

/**
 * Every child frame of the tab in one stable list: the root session's frame tree (in-process frames, document order)
 * merged with the tab's out-of-process iframe targets, each with its own subtree. Under site isolation an OOPIF is a
 * separate target and never appears in the root tree, so enumeration and frame-scoped evaluate must share this list.
 */
export async function listFrames(tabId: number): Promise<FrameEntry[]> {
  await ensureAttached(tabId);
  const origin = (u: string) => { try { return new URL(u).origin; } catch { return null; } };
  const out: FrameEntry[] = [];
  const seen = new Set<string>();
  const { frameTree: root } = await sendDebuggerCommand({ tabId }, 'Page.getFrameTree') as { frameTree: FrameNode };
  const top = origin(root.frame.url);
  const inTree = new Map<string, FrameNode['frame']>();
  const index = (node: FrameNode) => { for (const c of node.childFrames ?? []) { inTree.set(c.frame.id, c.frame); index(c); } };
  index(root);
  seen.add(root.frame.id);
  const push = (f: { id: string; url: string; name?: string }, oopif: boolean) => {
    if (seen.has(f.id)) return; seen.add(f.id);
    const o = origin(f.url);
    out.push({ index: out.length, frameId: f.id, url: f.url, name: f.name ?? '', crossOrigin: oopif || o === null || o === 'null' || o !== top, oopif });
  };
  // Frames come from the DOM in document order: every <iframe>/<frame> node carries its frameId, in-process or not
  // (a tab-scoped Target.getTargets does not list out-of-process iframes; the root frame tree does not contain them).
  type DomNode = { nodeName?: string; frameId?: string; children?: DomNode[]; contentDocument?: DomNode; shadowRoots?: DomNode[] };
  const iframeIds = (doc: DomNode): string[] => {
    const ids: string[] = [];
    const walk = (n: DomNode) => { if ((n.nodeName === 'IFRAME' || n.nodeName === 'FRAME') && n.frameId) ids.push(n.frameId); for (const c of n.children ?? []) walk(c); for (const c of n.shadowRoots ?? []) walk(c); if (n.contentDocument) walk(n.contentDocument); };
    walk(doc);
    return ids;
  };
  const visit = async (target: chrome.debugger.Debuggee, oopif: boolean, depth: number): Promise<void> => {
    if (depth > 4) return;
    let ids: string[] = [];
    try { const { root: doc } = await sendDebuggerCommand(target, 'DOM.getDocument', { depth: -1, pierce: true }, 5_000) as { root: DomNode }; ids = iframeIds(doc); } catch { return; }
    for (const id of ids) {
      if (seen.has(id)) continue;
      const known = inTree.get(id);
      if (known) { push(known, oopif); continue; } // in-process (relative to this session): described by the frame tree
      // not in this session's tree → its own process: attach to the iframe target (targetId == frameId) and read its tree
      try {
        const child = await frameDebuggee(tabId, id);
        const { frameTree } = await sendDebuggerCommand(child, 'Page.getFrameTree', undefined, 3_000) as { frameTree: FrameNode };
        push({ id, url: frameTree.frame.url, name: frameTree.frame.name }, true);
        const sub = (n: FrameNode) => { for (const c of n.childFrames ?? []) { inTree.set(c.frame.id, c.frame); sub(c); } };
        sub(frameTree);
        await visit(child, true, depth + 1);
      } catch (e) {
        push({ id, url: '' }, true);
        console.warn(`[opencli-mcp] frame ${id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  };
  await visit({ tabId }, false, 0);
  return out;
}

function normalizeCapturePatterns(pattern?: string): string[] {
  return String(pattern || '')
    .split('|')
    .map((part) => part.trim())
    .filter(Boolean);
}

function shouldCaptureUrl(url: string | undefined, patterns: string[]): boolean {
  if (!url) return false;
  if (!patterns.length) return true;
  return patterns.some((pattern) => url.includes(pattern));
}

function normalizeHeaders(headers: unknown): Record<string, string> {
  if (!headers || typeof headers !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    out[String(key)] = String(value);
  }
  return out;
}

function getOrCreateNetworkCaptureEntry(tabId: number, requestId: string, fallback?: {
  url?: string;
  method?: string;
  requestHeaders?: Record<string, string>;
  resourceType?: string;
}): NetworkCaptureEntry | null {
  const state = networkCaptures.get(tabId);
  if (!state) return null;
  const existingIndex = state.requestToIndex.get(requestId);
  if (existingIndex !== undefined) {
    return state.entries[existingIndex] || null;
  }
  const url = fallback?.url || '';
  if (!shouldCaptureUrl(url, state.patterns)) return null;
  if (fallback?.resourceType && !CAPTURED_TYPES.has(fallback.resourceType)) return null;
  if (/^(data|blob|chrome-extension):/.test(url)) return null;
  if (state.entries.length >= CAPTURE_MAX_ENTRIES) {
    // drop the oldest third; rebuild the index so in-flight requests keep resolving
    const drop = Math.floor(CAPTURE_MAX_ENTRIES / 3);
    state.entries.splice(0, drop);
    for (const [rid, idx] of [...state.requestToIndex]) { if (idx < drop) state.requestToIndex.delete(rid); else state.requestToIndex.set(rid, idx - drop); }
  }
  const entry: NetworkCaptureEntry = {
    kind: 'cdp',
    requestId,
    url,
    method: fallback?.method || 'GET',
    resourceType: fallback?.resourceType,
    requestHeaders: fallback?.requestHeaders || {},
    timestamp: Date.now(),
  };
  state.entries.push(entry);
  state.requestToIndex.set(requestId, state.entries.length - 1);
  return entry;
}

export async function startNetworkCapture(
  tabId: number,
  pattern?: string,
): Promise<void> {
  await ensureAttached(tabId);
  await sendDebuggerCommand({ tabId }, 'Network.enable');
  networkCaptures.set(tabId, {
    patterns: normalizeCapturePatterns(pattern),
    entries: [],
    requestToIndex: new Map(),
  });
}

/** Hand out the finished entries and keep the in-flight ones: the host drains after every goto/act, and an entry drained
 * before its response arrived would never get its status, content type and body (response events are lookup-only). */
export async function readNetworkCapture(tabId: number): Promise<NetworkCaptureEntry[]> {
  const state = networkCaptures.get(tabId);
  if (!state) return [];
  const out: NetworkCaptureEntry[] = []; const keep: NetworkCaptureEntry[] = []; const keepIds = new Map<string, number>();
  const idOf = new Map<number, string>(); for (const [rid, idx] of state.requestToIndex) idOf.set(idx, rid);
  const stale = Date.now() - 60_000; // a request with no end event after a minute is handed out as it is
  state.entries.forEach((e, idx) => {
    if (e.done || e.timestamp < stale) { out.push(e); return; }
    const rid = idOf.get(idx); if (rid) keepIds.set(rid, keep.length); keep.push(e);
  });
  state.entries = keep; state.requestToIndex = keepIds;
  return out;
}

export function hasActiveNetworkCapture(tabId: number): boolean {
  return networkCaptures.has(tabId);
}


export async function detach(tabId: number): Promise<void> {
  oopifByTab.delete(tabId);
  if (!attached.has(tabId)) return;
  attached.delete(tabId);
  networkCaptures.delete(tabId);
  try { await chrome.debugger.detach({ tabId }); } catch { /* ignore */ }
}

export function registerListeners(): void {
  chrome.downloads.onCreated.addListener((item) => {
    chromeDownloads.push({ seq: ++chromeDownloadSeq, id: item.id, url: item.url, finalUrl: item.finalUrl });
    if (chromeDownloads.length > 200) chromeDownloads.splice(0, chromeDownloads.length - 200);
  });
  chrome.debugger.onEvent.addListener((source, method, params: any) => {
    if (!source.tabId) return;
    if (method.startsWith('Target.')) { trackOopifs(source, method, params); return; }
    if (method === 'Page.downloadWillBegin') { notePageDownload(source.tabId, params ?? {}); return; }
    if (method === 'Runtime.consoleAPICalled') {
      const t = String(params?.type ?? 'log'); const level = (t === 'warning' ? 'warn' : ['debug', 'info', 'log', 'warn', 'error'].includes(t) ? t : 'log') as ConsoleEntry['level'];
      const frame = params?.stackTrace?.callFrames?.[0];
      noteConsole(source.tabId, level, ((params?.args ?? []) as Array<{ type?: string; value?: unknown; description?: string }>).map(describeRemoteObject).join(' '), frame?.url, frame?.lineNumber);
      return;
    }
    if (method === 'Runtime.exceptionThrown') {
      const d = params?.exceptionDetails ?? {};
      noteConsole(source.tabId, 'error', `Uncaught ${d.exception?.description ?? d.text ?? 'exception'}`, d.url, d.lineNumber);
      return;
    }
    if (method === 'Page.javascriptDialogOpening') { if (!dialogs.has(source.tabId)) noteDialog(source.tabId, { type: params?.type ?? 'alert', message: String(params?.message ?? ''), defaultPrompt: params?.defaultPrompt, url: params?.url, openedAt: Date.now(), sessionId: source.sessionId }); }
    else if (method === 'Page.javascriptDialogClosed') noteDialog(source.tabId, null);
  });
  chrome.tabs.onRemoved.addListener((tabId) => {
    consoleLogs.delete(tabId);
    for (const k of [...directTargets.keys()]) if (k.startsWith(`${tabId}:`)) directTargets.delete(k);
    dialogs.delete(tabId); dialogWaiters.delete(tabId); dialogClosedWaiters.delete(tabId);
    attached.delete(tabId);
    networkCaptures.delete(tabId);
    pageDownloads.delete(tabId);
      oopifByTab.delete(tabId);
  });
  chrome.debugger.onDetach.addListener((source) => {
    const sessionId = (source as { sessionId?: string }).sessionId;
    if (source.tabId && sessionId) {
      // a child (OOPIF) session went away — e.g. its frame navigated; the tab's root attachment is untouched
      const m = oopifByTab.get(source.tabId);
      if (m) for (const [id, s] of m) if (s.sessionId === sessionId) m.delete(id);
      return;
    }
    if (source.tabId) {
      dialogs.delete(source.tabId);
      attached.delete(source.tabId);
      networkCaptures.delete(source.tabId);
      oopifByTab.delete(source.tabId);
      for (const k of [...directTargets.keys()]) if (k.startsWith(`${source.tabId}:`)) directTargets.delete(k);
      return;
    }
    if ((source as { targetId?: string }).targetId) { const tid = (source as { targetId?: string }).targetId!; for (const [k, v] of directTargets) if (v === tid) directTargets.delete(k); return; }
  });
  // Invalidate attached cache when tab URL changes to non-debuggable
  chrome.tabs.onUpdated.addListener(async (tabId, info) => {
    if (info.url && !isDebuggableUrl(info.url)) {
      await detach(tabId);
    }
  });
  chrome.debugger.onEvent.addListener(async (source, method, params) => {
    const tabId = source.tabId;
    if (!tabId) return;
    const state = networkCaptures.get(tabId);
    if (!state) return;
    const eventParams = params as Record<string, any> | undefined;

    if (method === 'Network.requestWillBeSent') {
      const requestId = String(eventParams?.requestId || '');
      const request = eventParams?.request as {
        url?: string;
        method?: string;
        headers?: Record<string, unknown>;
        postData?: string;
        hasPostData?: boolean;
      } | undefined;
      const entry = getOrCreateNetworkCaptureEntry(tabId, requestId, {
        url: request?.url,
        method: request?.method,
        requestHeaders: normalizeHeaders(request?.headers),
        resourceType: typeof eventParams?.type === 'string' ? eventParams.type : undefined,
      });
      if (!entry) return;
      // On an HTTP 30x, CDP re-fires requestWillBeSent with the SAME requestId
      // (the prior hop is carried in `redirectResponse`) for the redirect
      // target — typically a GET with no postData. Overwriting the body here
      // would wipe the original request's captured POST body, so only populate
      // the body on the initial send.
      if (!eventParams?.redirectResponse) {
        entry.requestBodyKind = request?.hasPostData ? 'string' : 'empty';
        {
          const raw = String(request?.postData || '');
          const fullSize = raw.length;
          const truncated = fullSize > CDP_REQUEST_BODY_CAPTURE_LIMIT;
          entry.requestBodyPreview = truncated ? raw.slice(0, CDP_REQUEST_BODY_CAPTURE_LIMIT) : raw;
          entry.requestBodyFullSize = fullSize;
          entry.requestBodyTruncated = truncated;
        }
        try {
          const postData = await sendDebuggerCommand({ tabId }, 'Network.getRequestPostData', { requestId }) as { postData?: string };
          if (postData?.postData) {
            const raw = postData.postData;
            const fullSize = raw.length;
            const truncated = fullSize > CDP_REQUEST_BODY_CAPTURE_LIMIT;
            entry.requestBodyKind = 'string';
            entry.requestBodyPreview = truncated ? raw.slice(0, CDP_REQUEST_BODY_CAPTURE_LIMIT) : raw;
            entry.requestBodyFullSize = fullSize;
            entry.requestBodyTruncated = truncated;
          }
        } catch {
          // Optional; some requests do not expose postData.
        }
      }
      return;
    }

    if (method === 'Network.responseReceived') {
      const requestId = String(eventParams?.requestId || '');
      const response = eventParams?.response as {
        url?: string;
        mimeType?: string;
        status?: number;
        headers?: Record<string, unknown>;
      } | undefined;
      // Lookup-only (like loadingFinished below): never create an entry from a
      // response. If the matching requestWillBeSent was already drained by a
      // readNetworkCapture() while the request was in flight, creating one here
      // produces an orphan half-entry with a defaulted method ('GET') and no
      // request data.
      const stateEntryIndex = state.requestToIndex.get(requestId);
      if (stateEntryIndex === undefined) return;
      const entry = state.entries[stateEntryIndex];
      if (!entry) return;
      entry.responseStatus = response?.status;
      entry.responseContentType = response?.mimeType || '';
      entry.responseHeaders = normalizeHeaders(response?.headers);
      return;
    }

    if (method === 'Network.loadingFailed') {
      const requestId = String(eventParams?.requestId || '');
      const stateEntryIndex = state.requestToIndex.get(requestId);
      const entry = stateEntryIndex === undefined ? undefined : state.entries[stateEntryIndex];
      if (entry) entry.done = true;
      return;
    }
    if (method === 'Network.loadingFinished') {
      const requestId = String(eventParams?.requestId || '');
      const stateEntryIndex = state.requestToIndex.get(requestId);
      if (stateEntryIndex === undefined) return;
      const entry = state.entries[stateEntryIndex];
      if (!entry) return;
      const finish = () => { entry.done = true; };
      // bodies only for what can carry data: JSON-ish XHR/fetch and documents; assets were filtered at request time
      if (entry.responseContentType && !/json|graphql|x-component|text\/plain|javascript|html|xml/i.test(entry.responseContentType)) { finish(); return; }
      try {
        const body = await sendDebuggerCommand({ tabId }, 'Network.getResponseBody', { requestId }) as {
          body?: string;
          base64Encoded?: boolean;
        };
        if (typeof body?.body === 'string') {
          const fullSize = body.body.length;
          const truncated = fullSize > CDP_RESPONSE_BODY_CAPTURE_LIMIT;
          const stored = truncated ? body.body.slice(0, CDP_RESPONSE_BODY_CAPTURE_LIMIT) : body.body;
          entry.responsePreview = body.base64Encoded ? `base64:${stored}` : stored;
          entry.responseBodyFullSize = fullSize;
          entry.responseBodyTruncated = truncated;
        }
      } catch {
        // Optional; bodies are unavailable for some requests (e.g. uploads).
      }
      finish();
    }
  });
}
