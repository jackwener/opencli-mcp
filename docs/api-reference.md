## API reference (generated from the public TypeScript declarations — do not edit)

In `js` the globals are `agent`, `sites`, `recon`, `tools`, `session` (the members of `AgentApi`) plus `nodeRepl` and `Tab`. This is the object-model signature reference; typed entry tools are projections of it. Site adapter definitions are documented in `define-tools`.

```ts
interface AgentApi {
  agent: { browsers: { getDefault(): Promise<Browser>; }; browser: Browser; documentation: { get(name: string): string | null; }; };
  sites: Record<string, unknown> & { search(q: string, limit?: number): Promise<unknown>; list(): unknown; enable(site: string, opts?: { write?: boolean; }): Promise<{ site: string; tools: Array<string>; }>; disable(site: string): boolean; run(site: string, name: string, args?: Record<string, unknown>): Promise<unknown>; };
  recon: {
    discover(tab: Tab, opts?: { maxScripts?: number; includeStatic?: boolean; includeAssets?: boolean; includeInline?: boolean; fetchTimeoutMs?: number; network?: Array<Record<string, unknown>>; }): Promise<DiscoverResult>;
  };
  tools: {
    define(def: ToolDefinition | (Omit<ToolDefinition, "func"> & { func?: string | ((ctx: Record<string, unknown>) => unknown); })): Promise<{ draftId: string; site: string; name: string; args: Array<Arg>; }>;
    try(draftId: string, args: Record<string, unknown>, expect: DraftExpectation): Promise<{ result: CommandRunResult | CommandRunError; verification: { passed: boolean; checks: Array<{ check: string; passed: boolean; actual?: unknown; }>; }; }>;
    activate(draftId: string): Promise<{ site: string; name: string; file: string; verifiedAt: string; }>;
    discard(draftId: string): { draftId: string; discarded: true; };
    list(): Array<{ site: string; name: string; file: string; }>;
    remove(site: string, name: string): Promise<boolean>;
  };
  session: { id: string; };
}

class Browser {
  id: "chrome";
  type: "extension";
  tabs: {
    new(url?: string): Promise<Tab>;
    list(): Promise<Array<{ id?: string; tabId: number; pending?: true; url?: string; title?: string; active: boolean; selected: boolean; origin: "agent" | "user"; state: "active" | "handoff"; }>>;
    get(id: string): Tab;
    selected(): Promise<Tab | undefined>;
    finalize(opts?: { keep?: Array<{ tab: string | Tab; status: "handoff" | "deliverable"; }>; }): Promise<{ closed: Array<string>; kept: Array<string>; failed: Array<{ page: string; reason: string; }>; }>;
  };
  user: {
    openTabs(options?: { query?: string; limit?: number; }): Promise<Array<UserTabInfo>>;
    claimTab(tab: { tabId?: number; active?: boolean; title?: string; url?: string; expectedUrl?: string; expectedTitle?: string; }): Promise<Tab>; // Claim by foreground, id, or unique url/title lookup; expected fields verify the tab's current identity.
    closeTabs(tabIds: Array<number>): Promise<CloseUserTabsResult>; // Close user tabs by Chrome id without claiming or loading their pages.
  };
  nameSession(name: string): Promise<void>;
  capabilities: {
    list(): Promise<Array<{ id: string; description: string; }>>;
    get(id: string): Promise<Record<string, unknown>>;
  };
  documentation(): string;
}

class Tab {
  tabId?: number; // `id` is the Chrome tab id as a string; `tabId` is the numeric id when claimed from a user tab.
  id: string;
  goto(url: string, opts?: { waitUntil?: "load" | "none"; settleMs?: number; }): Promise<{ url: string | null; title: string | null; }>;
  url(): Promise<string | null>;
  title(): Promise<string | null>;
  back(): Promise<void>;
  forward(): Promise<void>;
  reload(): Promise<void>;
  close(): Promise<void>; // Close this tab, whether it was opened or claimed by this session.
  release(): Promise<void>; // Keep this tab open and give up this session's control of it.
  observe(opts?: ObserveOptions): Promise<{ url: string | null; title: string | null; state?: string; snapshotId?: string; diff?: boolean; changed?: { added: number; removed: number; changed?: number; }; image?: ImageValue; }>;
  screenshot(opts?: { fullPage?: boolean; annotate?: boolean; format?: "png" | "jpeg"; quality?: number; }): Promise<ImageValue>;
  find(target: (Target & { limit?: number; }) | { query: string; limit?: number; }): Promise<FindResult | ElementAtResult | QueryFindResult>;
  read(opts?: ReadOptions): Promise<ReadTextResult>; // Linear text of a bounded document. Scrolls to mount lazy content, retains repeated text from distinct nodes, restores the scroll position. No refs. A feed that grows without a bottom returns reason `unbounded` and the head already read — do not call it again to finish the feed.
  act(opts: ActOptions): Promise<Record<string, unknown>>; // wait + act in one call at the runtime edge: locate → wait actionable → hit-test → real input → settle. `method:'dom'` skips the mouse event.
  webmcp: { // WebMCP: tools the page itself registers via navigator.modelContext (page-provided tool source).
    list(): Promise<Array<{ name: string; description?: string; inputSchema?: unknown; }>>;
    call(name: string, input?: Record<string, unknown>): Promise<unknown>;
  };
  expect(what: Expectation, opts?: { timeoutMs?: number; }): Promise<CheckResult>; // Assert what the page must show now (polled up to timeoutMs).
  evaluate(js: string, opts?: { allowWrite?: boolean; frame?: number; }): Promise<unknown>; // Read-only page evaluation.
  dialog: { // Native alert/confirm/prompt dialogs block the page; commands fail with `dialog_open` until answered.
    get(): Promise<DialogInfo | null>;
    accept(text?: string): Promise<DialogInfo | null>;
    dismiss(): Promise<DialogInfo | null>;
  };
  console: { // Console messages and uncaught exceptions since the tab was attached (the plugin's tab.dev.logs); cursor-paged like network.read.
    read(opts?: { afterSequence?: number; limit?: number; levels?: Array<"debug" | "info" | "log" | "warn" | "error">; filter?: string; }): Promise<{ cursor: number; entries: Array<ConsoleEntry>; hasMore: boolean; }>;
  };
  network: {
    start(pattern?: string): Promise<boolean>;
    list(opts?: { filter?: string; limit?: number; afterSequence?: number; }): Promise<{ cursor: number; entries: Array<Record<string, unknown>>; hasMore: boolean; }>;
    detail(opts: { seq?: number; requestId?: string; part?: "request" | "response"; start?: number; maxChars?: number; }): Promise<Record<string, unknown>>;
    read(opts?: { pattern?: string; limit?: number; includeStatic?: boolean; afterSequence?: number; }): Promise<{ cursor: number; entries: Array<unknown>; hasMore: boolean; }>; // Cursor-paged read: pass `afterSequence` from the previous result to get only new requests. Returns network rows only; endpoint candidates come from the explicit `recon.discover(tab)` (not a hidden side effect of reading).
  };
  cookies(domain: string): Promise<Array<unknown>>;
  cookie(name: string, opts?: { domain?: string; }): Promise<string | undefined>; // Read one cookie's value at run time — useful for per-request tokens an adapter needs (csrf/ct0/ csrftoken/XSRF-TOKEN). Defaults to the current page's host. Returns undefined when the cookie is absent.
  fetchJson(url: string, opts?: Record<string, unknown>): Promise<unknown>; // Fetch JSON through the page (its cookies and origin) after verifying the endpoint.
  frames(): Promise<Array<{ index: number; frameId: string; url: string; name: string; crossOrigin?: boolean; oopif?: boolean; }>>;
  download(afterSequence: number, timeoutMs?: number): Promise<DownloadWaitResult>; // Wait for the page download begun after a tab_act cursor, then check Chrome's file state.
}

type Target = ({ frame?: FrameStep | FrameStep[]; within?: string }) & (
  | { ref: number | string }
  | { selector: string; nth?: number }
  | { role?: string; name?: string; label?: string; text?: string; testid?: string; nth?: number }
  | { x: number; y: number });

type FrameStep = string | number;

type ActAction = 'click' | 'dblclick' | 'hover' | 'focus' | 'fill' | 'type' | 'press' | 'select' | 'check' | 'uncheck' | 'upload' | 'drag' | 'scroll' | 'back' | 'forward' | 'reload';

interface ActOptions { target?: Target; action: ActAction; value?: string; files?: string[]; to?: Target; direction?: 'up' | 'down' | 'left' | 'right'; amount?: number; timeoutMs?: number; settleMs?: number; method?: 'cdp' | 'dom' }

interface ObserveOptions { mode?: 'state' | 'screenshot' | 'both'; since?: string; viewport?: boolean; ref?: string; annotate?: boolean; fullPage?: boolean }

interface ReadOptions { maxChars?: number; start?: number; readId?: string }

interface ImageValue { __image: true; mimeType: string; base64: string }

interface Box { x: number; y: number; w: number; h: number }

interface FindEntry {
  nth: number;
  ref: string | null;
  selector: string | null;
  tag: string; role: string; name: string; text: string;
  attrs: Record<string, string>;
  visible: boolean; enabled: boolean | null; editable: boolean | null;
  box: Box;
}

interface FindResult { matches_n: number; visible_n: number; selector: string; entries: FindEntry[] }

interface QueryFindResult { matches_n: number; entries: Array<FindEntry & { path: string[]; interactiveAncestorRef: string | null }> }

interface ElementAtResult { matches_n: number; entries: FindEntry[] }

interface ReadTextResult { readId: string; text: string; complete: boolean; reason?: 'budget' | 'scan_limit' | 'unbounded' | 'stale'; chars: number; start: number; nextStart?: number }

interface Expectation { text?: string; notText?: string; selector?: string; ref?: string; url?: string; title?: string; visible?: boolean }

interface CheckResult { ok: boolean; failed: string[]; url: string; title: string }

interface DialogInfo { type: 'alert' | 'confirm' | 'prompt' | 'beforeunload'; message: string; defaultPrompt?: string; url?: string; openedAt: number }

interface ConsoleEntry { seq: number; level: 'debug' | 'info' | 'log' | 'warn' | 'error'; message: string; timestamp: string; url?: string; line?: number }

interface UserTabInfo { tabId: number; title?: string; url?: string; windowId: number; active: boolean; groupId?: number; lastAccessed?: number }

interface CloseUserTabsResult {
  complete: boolean;
  closed: number[];
  failed: Array<{ tabId: number; reason: string }>;
}

interface DownloadWaitResult {
  downloaded: boolean;
  started: boolean;
  sequence?: number;
  suggestedFilename?: string; association?: 'url+event';
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
```
