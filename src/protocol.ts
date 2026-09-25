/**
 * opencli-mcp host ⇄ extension protocol.
 *
 * Transport: Chrome Native Messaging (4-byte LE length + JSON) between the
 * Chrome-spawned host process and the extension service worker. The host is
 * the MCP server; the extension is the browser runtime that owns the
 * chrome.debugger session, tab leases, tab groups, and cursor overlay.
 *
 * Envelope kinds:
 *   host → ext:  { type: 'command', command: Command }
 *   ext → host:  { type: 'hello', ... } | { type: 'result', result: Result } | { type: 'event', event: BrowserEvent }
 */

export type Action =
  // page control
  | 'exec' | 'navigate' | 'tabs' | 'cookies' | 'screenshot'
  | 'network-capture-start' | 'network-capture-read'
  | 'wait-download' | 'cdp' | 'frames'
  // session & tab-lifecycle (Codex-style: name, claim, finalize)
  | 'session-name' | 'session-finalize' | 'user-tabs' | 'claim' | 'close-user-tabs' | 'mark'
  // native JavaScript dialogs (alert/confirm/prompt/beforeunload) block the page; the agent sees and answers them explicitly
  | 'dialog'
  // reload/back/forward driven by the browser (evaluating location.reload() never returns: the context dies mid-call)
  | 'history'
  // console messages and uncaught exceptions of the tab, captured while attached (the plugin's tab.dev.logs)
  | 'console'
  // atomic interaction at the runtime edge: locate → wait actionable → hit-test → real input → settle
  | 'act'
  // human visibility
  | 'cursor' | 'visibility' | 'ping';

export interface Command {
  id: string;
  action: Action;
  /** Logical session (one MCP session ⇄ one named tab group). */
  session?: string;
  /** Surface policy: interactive browser session vs. background adapter run. */
  surface?: 'browser' | 'adapter';
  /** Stable Chrome tab id, encoded as a string; the extension checks session ownership. */
  page?: string;
  code?: string;
  /** exec: evaluate in the page's main world (default) or in the engine's isolated world */
  world?: 'main' | 'engine';
  url?: string;
  op?: 'list' | 'new' | 'close' | 'release';
  dialogOp?: 'get' | 'accept' | 'dismiss';
  historyOp?: 'reload' | 'back' | 'forward';
  /** console read: cursor paging */
  afterSequence?: number;
  limit?: number;
  /** user-tabs: case-insensitive title or URL search */
  query?: string;
  levels?: string[];
  filter?: string;
  domain?: string;
  format?: 'png' | 'jpeg';
  quality?: number;
  fullPage?: boolean;
  width?: number;
  height?: number;
  text?: string;
  pattern?: string;
  timeoutMs?: number;
  cdpMethod?: string;
  cdpParams?: Record<string, unknown>;
  frameIndex?: number;
  deadlineAt?: number;
  /** session-name */
  name?: string;
  /** claim: tabId/active choose a tab; url/title find a unique tab; expectedUrl/expectedTitle verify its current identity. */
  claim?: { tabId?: number; active?: boolean; title?: string; url?: string; expectedUrl?: string; expectedTitle?: string };
  /** close-user-tabs: numeric Chrome ids, without adopting the tabs into the session. */
  tabIds?: number[];
  /** mark / finalize */
  mark?: 'deliverable' | 'handoff' | null;
  keep?: Array<{ page: string; status: 'deliverable' | 'handoff' }>;
  /** cursor */
  x?: number;
  y?: number;
  waitForArrival?: boolean;
  /** visibility */
  visible?: boolean;
  /** act */
  act?: ActSpec;
}

export type ActKind = 'click' | 'dblclick' | 'hover' | 'focus' | 'fill' | 'type' | 'press' | 'check' | 'uncheck' | 'select' | 'scroll' | 'upload' | 'drag';
export interface ActTarget { ref?: number | string; /** raw Playwright selector, e.g. the `selector` returned by find */ selector?: string; /** scope: selector of a container, or an eN ref — the target is resolved inside it (generic labels are ambiguous by default; scope them) */ within?: string; nth?: number; role?: string; name?: string; label?: string; text?: string; testid?: string; x?: number; y?: number; /** iframe(s) to enter first, outermost first: css selector of the <iframe> or its 0-based index; a string may chain with ' >> ' (Codex enter-frame); same- and cross-origin frames are handled alike */ frame?: FrameStep | FrameStep[] }
export type FrameStep = string | number;
export interface ActSpec {
  kind: ActKind;
  target: ActTarget;
  value?: string;
  timeoutMs?: number;
  settleMs?: number;
  cursor?: boolean;
  force?: boolean;
  /**
   * click only. `cdp` (default) is a real mouse event and fails if the page did not receive it.
   * `dom` runs HTMLElement.click() and sends no mouse event — only when the event was not delivered or the element has no box.
   */
  method?: 'cdp' | 'dom';
  /** scroll */
  direction?: 'up' | 'down' | 'left' | 'right';
  amount?: number;
  /** upload */
  files?: string[];
  /** drag */
  to?: ActTarget;
}
/** A native JavaScript dialog currently blocking a tab. */
export interface DialogInfo { type: 'alert' | 'confirm' | 'prompt' | 'beforeunload'; message: string; defaultPrompt?: string; url?: string; openedAt: number }

export interface ConsoleEntry { seq: number; level: 'debug' | 'info' | 'log' | 'warn' | 'error'; message: string; timestamp: string; url?: string; line?: number }

export interface ActResult {
  ok: true;
  kind: ActKind;
  ref?: string | null;
  matches_n: number;
  visible_n: number;
  match_level: 'exact';
  point: { x: number; y: number };
  method: 'cdp' | 'dom';
  hit: 'target' | 'ancestor' | 'other';
  tag: string;
  /** ms spent resolving the target (visible/enabled/stable/hit-test) */
  waitedMs: number;
  /** end-to-end ms and its breakdown: resolve → dispatch (input events + verification) → settle (DOM quiet wait) */
  elapsedMs?: number;
  timings?: { resolveMs: number; actionMs: number; settleMs: number };
  /** Playwright-generated selector for locating the same element again. */
  selector?: string;
  /** set when the action triggered a navigation that has now finished */
  navigated?: boolean;
  url?: string;
  filled?: boolean; verified?: boolean; actual?: string; checked?: boolean; changed?: boolean; key?: string;
  /** options actually selected; upload count */
  selected?: string[];
  files?: number;
  /** Child tabs from this source tab while the action ran; each is claimed into the same session. */
  openedTabs?: Array<{ page?: string; tabId: number; url?: string; title?: string; pending?: true }>;
  /** Page.downloadWillBegin events observed while this action ran; completion is checked separately. */
  download?: { afterSequence: number; started: Array<{ seq: number; guid?: string; url: string; suggestedFilename: string }> };
}

export interface DownloadWaitResult {
  downloaded: boolean;
  started: boolean;
  sequence?: number;
  suggestedFilename?: string;
  /** Chrome has no source-tab field for files; this new download was paired with the tab's Page event by URL. */
  association?: 'url+event';
  candidates?: number;
  id?: number;
  filename?: string;
  url?: string;
  finalUrl?: string;
  mime?: string;
  totalBytes?: number;
  state?: string;
  danger?: string;
  error?: string;
  elapsedMs: number;
}

export interface CloseUserTabsResult {
  complete: boolean;
  closed: number[];
  failed: Array<{ tabId: number; reason: string }>;
}

export interface Result {
  id: string;
  ok: boolean;
  /** result payload on success; structured error details (e.g. candidates) on failure */
  data?: unknown;
  error?: string;
  errorCode?: string;
  errorHint?: string;
  page?: string;
}

export type BrowserEvent =
  | { kind: 'tab_created' | 'tab_acquired' | 'tab_closed' | 'tab_released'; session: string; page?: string; tabId: number; url?: string; title?: string; origin?: 'agent' | 'user' }
  | { kind: 'download'; state: string; filename?: string; url?: string }
  | { kind: 'dialog'; page?: string; dialogType: string; message?: string }
  | { kind: 'webmcp_changed'; page?: string }
  | { kind: 'session_released'; session: string; reason: string };

export type HostToExt = { type: 'command'; command: Command } | { type: 'ready'; version: string; port: number };
/** Advisory contract revision; individual capabilities and command results decide what works. */
export const PROTOCOL_REVISION = 2;
export type BrowserFeature = 'cdp' | 'network' | 'frames' | 'dialogs' | 'console' | 'downloads' | 'viewport' | 'visibility' | 'webmcp';
export type ExtToHost =
  | { type: 'hello'; extensionVersion: string; protocolRevision?: number; features?: BrowserFeature[] }
  | { type: 'result'; result: Result }
  | { type: 'event'; event: BrowserEvent };

export const NATIVE_HOST_NAME = 'com.opencli.mcp';
/** Chrome caps host → extension frames at 1 MiB. */
export const MAX_FRAME_BYTES = 1024 * 1024;
