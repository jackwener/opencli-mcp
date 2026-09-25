/**
 * MCP server per session: typed core tools, dynamic site tools, the `js` code-mode tool,
 * resources (docs, sites) and prompts — all backed by the same object model.
 */
import { McpServer, ResourceTemplate, type RegisteredTool } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Runtime } from '../runtime/runtime.js';
import { createAgentApi, Tab, type AgentApi, type ActAction } from '../api/agent.js';
import { ActionError, errorEnvelope } from '../api/errors.js';
import { JsSession, safeStringify } from './js-session.js';
import { buildInstructions, listDocs, readDocForContext, type DocContext } from '../docs/manifest.js';
import { argsToShape, argSpec, coerceArgs } from '../sites/schema.js';
import { listDefinedTools } from '../sites/define.js';
import { checkActInput, checkExpect, type ActToolInput } from './act-input.js';
import { actionSchema, targetSchema } from './action-schema.js';

type Content = Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>;
type ToolResult = { content: Content; structuredContent?: Record<string, unknown>; isError?: boolean };

function text(s: string): Content[number] { return { type: 'text', text: s }; }
// One result envelope everywhere: success is `{ ok:true, …data }`, failure is `{ ok:false, error:{…} }` — compact JSON,
// in-band `ok` (the agent reads content text), no duplicate structuredContent. Raw strings (docs/markdown) pass through.
function ok(data: unknown, images: Array<{ mimeType: string; base64: string }> = []): ToolResult {
  const content: Content = [];
  if (typeof data === 'string') content.push(text(data));
  else if (Array.isArray(data)) content.push(text(safeStringify({ ok: true, value: data }, 120_000)));
  else if (data && typeof data === 'object') content.push(text(safeStringify({ ok: true, ...(data as Record<string, unknown>) }, 120_000)));
  else content.push(text(safeStringify({ ok: true }, 120_000)));
  for (const img of images) content.push({ type: 'image', data: img.base64, mimeType: img.mimeType });
  return { content };
}
function fail(err: unknown): ToolResult {
  return { content: [text(safeStringify(errorEnvelope(err)))], isError: true };
}
function stripImage<T extends Record<string, unknown>>(o: T): { data: Record<string, unknown>; images: Array<{ mimeType: string; base64: string }> } {
  const images: Array<{ mimeType: string; base64: string }> = [];
  const data: Record<string, unknown> = { ...o };
  const img = o.image as { __image?: boolean; mimeType: string; base64: string } | undefined;
  if (img && img.__image) { images.push({ mimeType: img.mimeType, base64: img.base64 }); data.image = `${img.mimeType} attached`; }
  return { data, images };
}

export interface SessionServer { server: McpServer; api: AgentApi; close(): Promise<void> }

export function createMcpServer(rt: Runtime, sessionId: string, opts: { version?: string; persistent?: boolean } = {}): SessionServer {
  const persistent = opts.persistent !== false; // stateless HTTP creates a fresh server per request: no long-lived rt listeners, and close() must not finalize the shared runtime session
  const api = createAgentApi(rt, sessionId);
  const state = rt.session(sessionId);
  const docCtx = (): DocContext => ({ backend: rt.backend(), capabilities: rt.features() });
  const server = new McpServer({ name: 'opencli-mcp', version: opts.version ?? '0.0.0' }, {
    capabilities: { tools: { listChanged: true }, resources: { listChanged: true }, prompts: {}, logging: {} },
    instructions: buildInstructions(docCtx()),
  });

  const tabOf = async (id?: string): Promise<Tab> => {
    const b = await api.agent.browsers.getDefault();
    if (id) return b.tabs.get(id);
    // selected is the last tab this session touched, not a disambiguator. The lease list is the only source.
    const tabs = (await b.tabs.list()).filter((t) => t.state === 'active');
    const ready = tabs.filter((t): t is typeof t & { id: string } => Boolean(t.id));
    if (tabs.length > 1) throw new ActionError('tab_required', `This session has ${tabs.length} tabs. Pass tab.`, 'Copy a ready tab id from this list; pending tabs have only tabId until their page is ready.', { details: { tabs: tabs.map((t) => ({ tab: t.id, tabId: t.tabId, pending: t.pending, url: t.url, title: t.title })) } });
    if (ready.length === 1) return b.tabs.get(ready[0].id);
    if (tabs.length === 1) throw new ActionError('tab_pending', `Tab ${tabs[0].tabId} has no page handle yet.`, 'Call tab_list again and match this tabId after its page becomes ready.', { details: { tabId: tabs[0].tabId } });
    throw new ActionError('no_tab', 'No tab is open in this session', 'Call tab_open first (or tab_claim a user tab).');
  };
  const run = async (fn: () => Promise<ToolResult>): Promise<ToolResult> => { try { return await fn(); } catch (err) { return fail(err); } };
  type Extra = { signal?: AbortSignal; _meta?: { progressToken?: string | number }; sendNotification?: (n: { method: 'notifications/progress'; params: { progressToken: string | number; progress: number; total?: number; message?: string } }) => Promise<void> };
  // v2 ServerContext carries request state under `mcpReq` (signal, _meta, notify) — lift the pieces we use.
  const ctxExtra = (ctx: unknown): Extra => {
    const m = (ctx as { mcpReq?: { signal?: AbortSignal; _meta?: { progressToken?: string | number }; notify?: (n: unknown) => Promise<void> } }).mcpReq ?? {};
    return { signal: m.signal, _meta: m._meta, sendNotification: m.notify ? (n) => m.notify!(n) : undefined };
  };
  /** Run a long site command with progress heartbeats (when the host passed a progressToken) and cancellation. */
  const runSiteWithProgress = async (site: string, command: string, args: Record<string, unknown>, extra: Extra): Promise<ToolResult> => {
    const cmd = await rt.registry.resolve(site, command);
    const coerced = coerceArgs(cmd.args, args);
    const token = extra._meta?.progressToken;
    const started = Date.now();
    let beat: NodeJS.Timeout | undefined;
    if (token !== undefined && extra.sendNotification) {
      beat = setInterval(() => { void extra.sendNotification!({ method: 'notifications/progress', params: { progressToken: token, progress: Math.round((Date.now() - started) / 1000), message: `${site} ${command} running (${Math.round((Date.now() - started) / 1000)}s)` } }).catch(() => {}); }, 5000);
    }
    try {
      const r = await rt.runSite(site, command, coerced, { signal: extra.signal });
      if (!r.ok) {
        const { code, message, hint, ...restErr } = r.error;
        return fail(new ActionError(code, message, hint, { site, command, ...restErr }));
      }
      return ok(r.rows !== undefined ? { rows: r.rows, ...(r.nextCursor && { nextCursor: r.nextCursor }) } : { value: r.value });
    } finally { if (beat) clearInterval(beat); }
  };
  // ── the entry surface: the few typed tools for the core loop; everything else lives in the object model behind `js` ──
  // ── diagnostics & discovery ──
  server.registerTool('doctor', { title: 'Doctor', description: 'Runtime status: browser connection, extension features and protocol warning (if versions differ), site/command counts, sessions. A protocol warning does not block browser commands.', inputSchema: {}, annotations: { readOnlyHint: true } }, async () => run(async () => ok(rt.doctor())));

  // ── session ──
  server.registerTool('session_finalize', { title: 'Finalize session tabs', description: 'End-of-task cleanup. Agent-created tabs not listed in keep are closed; deliverable tabs leave the group and stay open; handoff tabs stay in the group for a later turn. Claimed user tabs are only released.',
    inputSchema: { keep: z.array(z.object({ tab: z.string().describe('tab id'), status: z.enum(['deliverable', 'handoff']) })).default([]) },
    annotations: { destructiveHint: true },
  }, async ({ keep }) => run(async () => ok(await (await api.agent.browsers.getDefault()).tabs.finalize({ keep }))));

  // ── tabs ──
  server.registerTool('tab_list', { title: 'List tabs', description: 'List this session’s active and handoff tabs and, when user:true, user tabs available to claim. Session tabs include numeric tabId; id is the page handle when ready, or pending:true until ready. Match a pending popup by tabId on a later call. User tabs include tabId for tab_claim.',
    inputSchema: { user: z.boolean().default(false).describe('also list user tabs available to claim'), query: z.string().optional().describe('filter user tabs by title or URL'), limit: z.number().int().min(1).max(100).default(20).describe('maximum user tabs returned') }, annotations: { readOnlyHint: true },
  }, async ({ user, query, limit }) => run(async () => { const b = await api.agent.browsers.getDefault(); return ok({ tabs: await b.tabs.list(), ...(user ? { userTabs: await b.user.openTabs({ query, limit }) } : {}) }); }));
  server.registerTool('tab_open', { title: 'Open a tab', description: 'Open a URL in a new agent tab (background, in this session’s tab group) and return its id plus the initial page state.',
    inputSchema: { url: z.string().optional().describe('http(s) URL, or data:text/html,… for a scratch page'), observe: z.boolean().default(true), session: z.string().min(1).max(60).optional().describe('name this browser session (short, emoji-prefixed; becomes the Chrome tab-group title) — give it with the first tab') },
    annotations: { openWorldHint: true },
  }, async ({ url, observe, session: sessionName }) => run(async () => {
    const b = await api.agent.browsers.getDefault();
    if (sessionName) await b.nameSession(sessionName);
    const tab = await b.tabs.new(url);
    if (!observe) return ok({ tab: tab.id, url });
    const { data, images } = stripImage({ tab: tab.id, ...(await tab.observe()) });
    return ok(data, images);
  }));
  server.registerTool('tab_claim', { title: 'Claim a user tab', description: 'Claim active:true, a tabId from tab_list, or a unique fuzzy url/title lookup. For a specific tab mentioned by the user, pass exact expectedUrl/expectedTitle from its current listing; changed identity fails instead of claiming another tab. Returns page handle and numeric tabId. Claimed user tabs are released by session_finalize.',
    inputSchema: { tabId: z.number().int().positive().optional(), active: z.boolean().optional().describe('foreground tab of the last focused normal Chrome window'), title: z.string().optional().describe('fuzzy lookup only; omit with tabId or active'), url: z.string().optional().describe('fuzzy lookup only; omit with tabId or active'), expectedTitle: z.string().optional().describe('exact title guard for the selected tab'), expectedUrl: z.string().optional().describe('exact URL guard for the selected tab'), observe: z.boolean().default(true) },
    annotations: { openWorldHint: true },
  }, async ({ tabId, active, title, url, expectedTitle, expectedUrl, observe }) => run(async () => {
    const b = await api.agent.browsers.getDefault();
    const tab = await b.user.claimTab({ tabId, active, title, url, expectedTitle, expectedUrl });
    if (!observe) return ok({ tab: tab.id, tabId: tab.tabId });
    const { data, images } = stripImage({ tab: tab.id, tabId: tab.tabId, ...(await tab.observe()) });
    return ok(data, images);
  }));
  server.registerTool('tab_close', { title: 'Close tabs', description: 'Close one session tab with tab, or close explicit user tabs with tabIds:[...]. Numeric tabIds of unclaimed user tabs are closed directly without loading the pages. Inspect complete and the per-id closed/failed results. To keep a controlled tab open, use tab_release.',
    inputSchema: { tab: z.string().optional().describe('page handle for one session tab; omit when only one session tab is active'), tabIds: z.array(z.number().int().positive()).min(1).optional().describe('Chrome tabIds of user tabs to close in one call; cannot be combined with tab') },
    annotations: { destructiveHint: true },
  }, async ({ tab, tabIds }) => run(async () => {
    if (tab !== undefined && tabIds !== undefined) throw new ActionError('invalid_args', 'Pass tab or tabIds, not both.');
    const b = await api.agent.browsers.getDefault();
    if (tabIds) return ok(await b.user.closeTabs(tabIds));
    const t = await tabOf(tab);
    await t.close();
    return ok({ tab: t.id, closed: true });
  }));
  server.registerTool('tab_release', { title: 'Release a tab', description: 'Keep a controlled tab open and give up this session’s control. Works for both agent-created and claimed user tabs.',
    inputSchema: { tab: z.string().optional().describe('required when the session has more than one tab') },
  }, async ({ tab }) => run(async () => { const t = await tabOf(tab); await t.release(); return ok({ tab: t.id, released: true }); }));
  server.registerTool('tab_observe', { title: 'Observe a tab', description: 'Action map with [ref=eN] refs, or a screenshot. Returns snapshotId. Pass since with an id you still have to receive a diff against exactly that state; otherwise a full state is returned. Long document text is tab_read. A collapsed branch keeps its ref; pass ref to open it.',
    inputSchema: { tab: z.string().optional().describe('required when the session has more than one tab'), mode: z.enum(['state', 'screenshot', 'both']).default('state'), since: z.string().optional().describe('snapshotId from the state still in your context'), viewport: z.boolean().optional().describe('only the subtree on screen right now'), ref: z.string().optional().describe('open one collapsed branch (eN); ignores viewport'), annotate: z.boolean().default(false).describe('overlay eN labels on the screenshot'), fullPage: z.boolean().default(false) },
    annotations: { readOnlyHint: true },
  }, async ({ tab, ...o }) => run(async () => { const t = await tabOf(tab); const { data, images } = stripImage({ tab: t.id, ...(await t.observe(o)) }); return ok(data, images); }));
  server.registerTool('tab_read', { title: 'Read page text', description: 'Linear rendered text of one bounded page scan. No action refs; use tab_observe to act. To continue, pass both readId and nextStart from the previous result, so a changing page cannot shift the offset. When no nextStart remains, scan_limit or unbounded means the scan stopped before the page ended.',
    inputSchema: { tab: z.string().optional().describe('required when the session has more than one tab'), maxChars: z.number().int().min(200).max(80_000).optional().describe('maximum characters in this response (default 60000)'), start: z.number().int().min(0).optional().describe('nextStart from the previous result'), readId: z.string().optional().describe('readId from the same previous result') },
    annotations: { readOnlyHint: true },
  }, async ({ tab, maxChars, start, readId }) => run(async () => { const t = await tabOf(tab); return ok({ tab: t.id, ...(await t.read({ maxChars, start, readId })) }); }));
  server.registerTool('tab_find', { title: 'Find page elements', description: 'Use query to search the action map by accessible text and get replayable refs plus ancestor context; or use target to inspect exact locator candidates with the same engine as tab_act. Pass exactly one.',
    inputSchema: { tab: z.string().optional(), query: z.string().min(1).optional(), target: targetSchema.optional(), limit: z.number().int().min(1).max(50).default(20) }, annotations: { readOnlyHint: true },
  }, async ({ tab, query, target, limit }) => run(async () => {
    if (Boolean(query) === Boolean(target)) throw new ActionError('invalid_args', 'tab_find needs exactly one of query or target.');
    const t = await tabOf(tab);
    return ok({ tab: t.id, result: await t.find(query ? { query, limit } : { ...target, limit } as Parameters<Tab['find']>[0]) });
  }));
  const networkTool = server.registerTool('network_inspect', { title: 'Inspect captured requests', description: 'list returns compact request summaries; detail returns headers and a bounded request or response body for one seq. Capture starts when a session tab is attached. Use list after the page performs the operation, then detail on the relevant seq. Copy body.nextStart to continue reading.',
    inputSchema: { tab: z.string().optional(), action: z.enum(['list', 'detail']).default('list'), filter: z.string().optional().describe('URL substring for list'), afterSequence: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(100).default(30), seq: z.number().int().positive().optional().describe('required for detail; copy from list'), part: z.enum(['request', 'response']).default('response'), start: z.number().int().min(0).default(0), maxChars: z.number().int().min(200).max(100_000).default(8_000) }, annotations: { readOnlyHint: true },
  }, async ({ tab, action, filter, afterSequence, limit, seq, part, start, maxChars }) => run(async () => {
    if (!rt.hasFeature('network')) throw new ActionError('capability_unavailable', 'The connected extension does not advertise Network capture.', 'Run doctor to inspect its features and update the extension.');
    const t = await tabOf(tab);
    if (action === 'list') return ok({ tab: t.id, ...(await t.network.list({ filter, afterSequence, limit })) });
    if (seq === undefined) throw new ActionError('invalid_args', 'detail requires seq.', 'Call network_inspect action:list and copy an entry seq.');
    return ok({ tab: t.id, ...(await t.network.detail({ seq, part, start, maxChars })) });
  }));
  if (!rt.hasFeature('network')) networkTool.disable();
  const downloadTool = server.registerTool('tab_download_wait', { title: 'Wait for a download', description: 'Wait for the download begun after one tab_act. Copy download.afterSequence from that action and use the same tab. downloaded:true means Chrome completed the file; not_started, unconfirmed, ambiguous, and cursor_expired do not prove completion.',
    inputSchema: { tab: z.string().optional().describe('same page handle used by tab_act; required when the session has multiple tabs'), afterSequence: z.number().int().min(0).describe('download.afterSequence from tab_act'), timeoutMs: z.number().int().min(1).max(120_000).default(30_000) }, annotations: { readOnlyHint: true },
  }, async ({ tab, afterSequence, timeoutMs }) => run(async () => {
    const t = await tabOf(tab);
    return ok({ tab: t.id, ...(await t.download(afterSequence, timeoutMs)) });
  }));
  if (!rt.hasFeature('downloads')) downloadTool.disable();
  const onFeaturesChanged = (): void => {
    if (networkTool.enabled !== rt.hasFeature('network')) networkTool.update({ enabled: rt.hasFeature('network') });
    if (downloadTool.enabled !== rt.hasFeature('downloads')) downloadTool.update({ enabled: rt.hasFeature('downloads') });
    if (server.isConnected()) server.sendResourceListChanged();
  };
  if (persistent) rt.on('features-changed', onFeaturesChanged);
  server.registerTool('tab_act', { title: 'Act on a tab', description: 'One action. The result separates input delivery from verified control state. openedTabs identifies popups seen during the action: use tab directly, or match tabId in tab_list when pending:true. If expecting a download, pass download.afterSequence to tab_download_wait. A click does not prove the site completed the task; check the cheapest authoritative state with tab_expect or tab_observe. If an action has no effect, inspect before retrying. method:"dom" is a click-only fallback after not_delivered or no box.',
    inputSchema: actionSchema,
    annotations: { destructiveHint: true, openWorldHint: true },
  }, async (input) => run(async () => {
    const { tab, action, target, to, observe, value, files, direction, amount, settleMs, method } = input as unknown as ActToolInput & { tab?: string; observe?: boolean; settleMs?: number };
    const checked = checkActInput({ action: action as ActAction, target, to, value, files, direction, amount, method });
    const t = await tabOf(tab);
    const r = await t.act({ action: action as ActAction, target: checked.target, to: checked.to, value, files, direction, amount, settleMs, method: checked.method });
    if (!observe) return ok({ tab: t.id, ...r });
    const { data, images } = stripImage({ tab: t.id, ...r, after: await t.observe() });
    return ok(data, images);
  }));
  server.registerTool('tab_expect', { title: 'Expect', description: 'Assert what the page must show now. At least one of text / notText / url / title / selector / ref is required (visible:false requires absence, and needs selector or ref). Polls up to timeout seconds; fails with expectation_failed.', inputSchema: { tab: z.string().optional().describe('required when the session has more than one tab'), text: z.string().optional(), notText: z.string().optional(), url: z.string().optional(), title: z.string().optional(), selector: z.string().optional(), ref: z.string().optional(), visible: z.boolean().optional().describe('with selector or ref; false requires absence'), timeout: z.number().default(5) }, annotations: { readOnlyHint: true } }, async ({ tab, timeout, ...what }) => run(async () => { checkExpect(what); const t = await tabOf(tab); return ok({ tab: t.id, ...(await t.expect(what, { timeoutMs: timeout * 1000 })) }); }));

  // ── sites ──
  server.registerTool('sites_search', { title: 'Find site capabilities', description: 'No query: list available sites with sample commands. With a task, site, or domain as query: find matching commands. Results include args[{name,type,required,help,default,choices}] for site_run. Do not invent parameters.', inputSchema: { query: z.string().optional().describe('task, site, or domain; omit to browse available sites'), limit: z.number().int().min(1).max(100).default(20) }, annotations: { readOnlyHint: true } }, async ({ query, limit }) => run(async () => query?.trim() ? ok({ results: await api.sites.search(query, limit) }) : ok({ sites: rt.registry.sites().slice(0, limit) })));
  server.registerTool('site_run', { title: 'Run a site command', description: 'Run one site command. args must match the args list from sites_search. Invalid args return invalid_args with details.expected. Valid commands execute directly, including writes.', inputSchema: { site: z.string(), command: z.string(), args: z.record(z.string(), z.unknown()).default({}) }, annotations: { openWorldHint: true } }, async ({ site, command, args }, extra) => run(() => runSiteWithProgress(site, command, args, ctxExtra(extra))));

  // ── capabilities ──

  // ── recon & tools ──
  const valueDef: z.ZodType<import('opencli-mcp/adapter-sdk').ArgValue> = z.lazy(() => z.object({
    type: z.enum(['string', 'int', 'number', 'boolean', 'array', 'object']).optional(), nullable: z.boolean().optional(),
    choices: z.array(z.union([z.string(), z.number(), z.boolean()])).optional(),
    items: valueDef.optional(), properties: z.record(z.string(), valueDef.and(z.object({ required: z.boolean().optional(), help: z.string().optional() }))).optional(),
    min: z.number().optional(), max: z.number().optional(), minLength: z.number().int().min(0).optional(), maxLength: z.number().int().min(0).optional(), example: z.unknown().optional(),
  }));
  const argDef = valueDef.and(z.object({ name: z.string(), default: z.unknown().optional(), required: z.boolean().optional(), help: z.string().optional() }));
  server.registerTool('tools_define', { title: 'Draft a site adapter', description: 'Read docs_get {name:"define-tools"} before authoring. Create an inactive draft of a host-side JavaScript adapter. `func` is the source of `async ({ tab, args, sites, recon }) => {…}`. Then run tools_try with real sample args and an output assertion; tools_activate publishes a passing draft.',
    inputSchema: { site: z.string(), name: z.string(), description: z.string(), access: z.enum(['read', 'write']), domain: z.string().optional(), result: z.object({ kind: z.enum(['rows', 'value']), description: z.string(), fields: z.record(z.string(), z.string()).optional(), paginated: z.boolean().optional() }).optional(), args: z.array(argDef).optional(), func: z.string() },
  }, async (def) => run(async () => {
    const draft = await api.tools.define(def);
    return ok({ ...draft, status: 'draft', next: { tool: 'tools_try', requiredArgs: argSpec(def.args).filter((a) => a.required).map((a) => a.name), note: 'Provide real sample args and an assertion on the returned value or row count. The active adapter is unchanged.' } });
  }));
  server.registerTool('tools_try', { title: 'Verify an adapter draft', description: 'Execute an inactive adapter draft against the real logged-in site and assert its output. This may perform writes when the draft is a write command. A passing trial makes the draft eligible for tools_activate; inspect the returned result before activating.',
    inputSchema: { draftId: z.string().uuid(), args: z.record(z.string(), z.unknown()).default({}), expect: z.object({ path: z.string().optional().describe('dot path in rows or value, e.g. rows.0.id or value.success'), equals: z.unknown().optional().describe('expected value at path; omit to assert existence'), minRows: z.number().int().min(1).optional() }) }, annotations: { openWorldHint: true },
  }, async ({ draftId, args, expect }) => run(async () => {
    const trial = await api.tools.try(draftId, args, expect);
    return ok({ ...trial, next: trial.verification.passed ? { tool: 'tools_activate', draftId, note: 'Inspect the trial result before publishing.' } : { tool: 'tools_try', draftId, note: 'Revise the draft or use a different assertion; a failed trial cannot be activated.' } });
  }));
  server.registerTool('tools_activate', { title: 'Activate a verified adapter', description: 'Atomically publish a draft that passed tools_try. It becomes available through site_run; enabled site tools receive a tool-list change.',
    inputSchema: { draftId: z.string().uuid() },
  }, async ({ draftId }) => run(async () => {
    const active = await api.tools.activate(draftId);
    await syncSiteTools();
    return ok({ ...active, status: 'active', next: { tool: 'site_run', note: 'The verified adapter is now available.' } });
  }));
  server.registerTool('tools_discard', { title: 'Discard an adapter draft', description: 'Delete an inactive adapter draft without changing the active adapter.',
    inputSchema: { draftId: z.string().uuid() },
  }, async ({ draftId }) => run(async () => ok(api.tools.discard(draftId))));

  // ── docs ──
  server.registerTool('docs_list', { title: 'List docs', description: 'Documentation available for this backend.', inputSchema: {}, annotations: { readOnlyHint: true } }, async () => run(async () => ok({ docs: listDocs(docCtx()).filter((d) => d.available).map(({ name, mode, description }) => ({ name, mode, description })) })));
  server.registerTool('docs_get', { title: 'Read a doc', description: 'Read an available documentation page by name (see docs_list).', inputSchema: { name: z.string() }, annotations: { readOnlyHint: true } }, async ({ name }) => run(async () => {
    if (!listDocs(docCtx()).some((entry) => entry.name === name && entry.available)) throw new ActionError('unknown_doc', `no available doc "${name}"`, 'Call docs_list to see docs for the connected runtime.');
    const d = readDocForContext(name, docCtx());
    if (!d) throw new ActionError('unknown_doc', `no doc "${name}"`, 'Call docs_list to see available docs.');
    return ok(d);
  }));

  // ── code mode ──
  const jsGlobals = { agent: api.agent, browser: api.agent.browser, sites: api.sites, recon: api.recon, tools: api.tools, session: api.session, Tab };
  server.registerTool('js', {
    title: 'JavaScript session', description: 'Host-side JavaScript against the object model, not page JavaScript. Page scripts go through tab.evaluate. Pre-bound: browser, agent, sites, recon, tools, session. Top-level const/let persist; function declarations do not. Use const fn = (...) => ... for reusable helpers. The last expression is returned. Batch loops in one js call; browser.user.closeTabs(ids) closes explicit user-tab ids. User-tab lookup: browser.user.openTabs({query,limit}). For the full API, call docs_get {name:"api-reference"} when needed.',
    inputSchema: { code: z.string(), timeoutMs: z.number().int().max(1_800_000).default(300_000) },
    annotations: { openWorldHint: true, destructiveHint: true },
  }, async ({ code, timeoutMs }) => run(async () => {
    if (!state.js) state.js = new JsSession(jsGlobals);
    const r = await state.js.run(code, { timeoutMs });
    const content: Content = [];
    if (r.error) {
      // Same coded envelope as every other tool: branchable code/hint/data when the throw was an ActionError, else a generic js_error.
      const e = r.error;
      const env = { ok: false as const, error: { code: e.code ?? 'js_error', message: e.message, ...(e.hint && { hint: e.hint }), ...(e.data && { ...e.data }), ...(!e.code && e.stack && { stack: e.stack }) } };
      content.push(text(safeStringify(env, 120_000)));
    } else if (r.value !== undefined) content.push(text(safeStringify({ ok: true, value: r.value }, 120_000)));
    else content.push(text(safeStringify({ ok: true, value: null }, 120_000)));
    if (r.writes.length) {
      const joined = r.writes.join('\n');
      content.push(text(joined.length > 24_000 ? `${joined.slice(0, 24_000)}\n…(truncated ${joined.length - 24_000} chars)` : joined));
    }
    for (const img of r.images) content.push({ type: 'image', data: img.base64, mimeType: img.mimeType });
    return { content, isError: Boolean(r.error) };
  }));
  server.registerTool('js_reset', { title: 'Reset JavaScript session', description: 'Discard all JavaScript bindings (tabs and browser state are untouched).', inputSchema: {} }, async () => run(async () => { state.js?.reset(); return ok({ reset: true }); }));

  // ── dynamic site tools ──
  const siteTools = new Map<string, { reg: RegisteredTool; metadata: string }>();
  const performSiteToolSync = async (): Promise<void> => {
    const wanted = new Set<string>();
    let changed = false;
    for (const [site, { write }] of state.enabledSites) {
      for (const cmd of await rt.registry.commands(site)) {
        if (!write && cmd.access === 'write') continue;
        const name = `${site}_${cmd.name}`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
        wanted.add(name);
        const descriptor = {
          title: `${site} ${cmd.name}`,
          description: `${cmd.description}${cmd.domain ? ` (${cmd.domain})` : ''} [${cmd.access}]${cmd.result ? ` Returns ${cmd.result.kind}: ${cmd.result.description}` : ''}`,
          inputSchema: z.object(argsToShape(cmd.args)).strict(),
          annotations: { readOnlyHint: cmd.access === 'read', destructiveHint: cmd.access === 'write', openWorldHint: true },
          icons: cmd.domain ? [{ src: `https://${cmd.domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '')}/favicon.ico` }] : [],
        };
        const metadata = JSON.stringify({ description: cmd.description, access: cmd.access, domain: cmd.domain, args: cmd.args, result: cmd.result });
        const current = siteTools.get(name);
        if (current) {
          if (current.metadata !== metadata) {
            current.reg.update({ title: descriptor.title, description: descriptor.description, paramsSchema: descriptor.inputSchema, annotations: descriptor.annotations, icons: descriptor.icons });
            current.metadata = metadata;
            changed = true;
          }
          continue;
        }
        const reg = server.registerTool(name, descriptor, async (args, extra) => run(() => runSiteWithProgress(site, cmd.name, args as Record<string, unknown>, ctxExtra(extra))));
        siteTools.set(name, { reg, metadata });
        changed = true;
      }
    }
    for (const [name, { reg }] of siteTools) if (!wanted.has(name)) { reg.remove(); siteTools.delete(name); changed = true; }
    if (changed && server.isConnected()) server.sendToolListChanged();
  };
  let syncTail: Promise<void> = Promise.resolve();
  const syncSiteTools = (): Promise<void> => {
    const next = syncTail.then(performSiteToolSync);
    syncTail = next.catch(() => {});
    return next;
  };
  const onToolsChanged = (): void => { void syncSiteTools().catch((err) => rt.emit('log', `syncSiteTools failed: ${(err as Error).message}`)); };
  if (persistent) rt.on('tools-changed', onToolsChanged);
  const onLog = (msg: string): void => { if (server.isConnected()) void server.sendLoggingMessage({ level: 'info', logger: 'opencli-mcp', data: msg }).catch(() => {}); };
  if (persistent) rt.on('log', onLog);
  const onBrowserEvent = (e: { kind: string; session?: string }): void => {
    if (!server.isConnected()) return;
    if (e.session && e.session !== `mcp:${sessionId}`) return;
    // tabs are not exposed as a resource, so tab events don't change any resource list — just relay them on the browser log channel.
    void server.sendLoggingMessage({ level: 'info', logger: 'browser', data: e }).catch(() => {});
  };
  if (persistent) rt.on('browser-event', onBrowserEvent);
  // sites pre-enabled by config apply to every session
  for (const site of rt.configSites) if (rt.registry.has(site)) state.enabledSites.set(site, { write: rt.configSitesWrite.includes(site) });
  if (state.enabledSites.size) queueMicrotask(onToolsChanged);

  // ── resources ──
  server.registerResource('docs', new ResourceTemplate('opencli://docs/{name}', { list: async () => ({ resources: listDocs(docCtx()).filter((d) => d.available).map((d) => ({ uri: `opencli://docs/${d.name}`, name: d.name, description: d.description, mimeType: 'text/markdown' })) }) }), { title: 'Documentation', description: 'Agent-facing docs' }, async (uri, { name }) => {
    if (!listDocs(docCtx()).some((entry) => entry.name === String(name) && entry.available)) throw new ActionError('unknown_doc', `no available doc "${String(name)}"`);
    return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: readDocForContext(String(name), docCtx()) ?? `no doc ${String(name)}` }] };
  });
  server.registerResource('sites', 'opencli://sites', { title: 'Sites', description: 'All sites with command counts', mimeType: 'application/json' }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(api.sites.list(), null, 2) }] }));
  server.registerResource('site', new ResourceTemplate('opencli://sites/{site}', { list: undefined }), { title: 'Site commands', mimeType: 'application/json' }, async (uri, { site }) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify((await rt.registry.commands(String(site))).map((c) => ({ name: c.name, description: c.description, access: c.access, domain: c.domain, args: c.args, result: c.result })), null, 2) }] }));

  // ── prompts ──
  server.registerPrompt('browse', { title: 'Browse a site for a goal', description: 'Use the browser service to observe, act, verify, and finalize.', argsSchema: { goal: z.string(), url: z.string().optional() } }, ({ goal, url }) => ({ messages: [{ role: 'user', content: { type: 'text', text: `Goal: ${goal}${url ? `\nStart at: ${url}` : ''}\n\n1. Open or claim a tab, then use tab_observe → tab_act → tab_expect as needed.\n2. If a verified site adapter fits this task, you may use site_run instead of repeating the workflow.\n3. Finish with session_finalize, keeping only deliverable/handoff tabs.` } }] }));
  server.registerPrompt('write-tool', { title: 'Turn a flow into a tool', description: 'Explore and verify an API, then define an explicit adapter.', argsSchema: { site: z.string(), goal: z.string() } }, ({ site, goal }) => ({ messages: [{ role: 'user', content: { type: 'text', text: `Create a reusable ${site} adapter for: ${goal}\n\n1. Open the site and perform the flow once. Use network_inspect list/detail and recon.discover(tab) to identify candidate endpoints.\n2. Verify the chosen endpoint through the logged-in page, including authentication, arguments, pagination, and errors.\n3. Read docs_get {name:"define-tools"}, create a draft with tools_define, verify it with tools_try using sample args and an output assertion, then publish with tools_activate.` } }] }));

  return {
    server, api,
    close: async () => { if (!persistent) return; rt.off('tools-changed', onToolsChanged); rt.off('features-changed', onFeaturesChanged); rt.off('log', onLog); rt.off('browser-event', onBrowserEvent); await rt.closeSession(sessionId); },
  };
}
