/**
 * MCP server per session: REPL entry, dynamic site tools, diagnostics and cleanup,
 * resources (docs, sites) and prompts — all backed by the same object model.
 */
import { McpServer, ResourceTemplate, type RegisteredTool } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Runtime } from '../runtime/runtime.js';
import { createAgentApi, type AgentApi } from '../api/agent.js';
import { ActionError, errorEnvelope } from '../api/errors.js';
import { JsSession, safeStringify } from './js-session.js';
import { buildInstructions, listDocs, readDocForContext, type DocContext } from '../docs/manifest.js';
import { argsToShape, coerceArgs } from '../sites/schema.js';

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
  // ── entry surface: REPL, site commands, discovery and lifecycle ──
  // ── diagnostics & discovery ──
  server.registerTool('doctor', { title: 'Doctor', description: 'Runtime status: browser connection, extension features and protocol warning (if versions differ), site/command counts, sessions. A protocol warning does not block browser commands.', inputSchema: {}, annotations: { readOnlyHint: true } }, async () => run(async () => ok({ ...rt.doctor(), javascript: state.js?.status() ?? { state: 'idle', generation: 0, pendingCalls: 0 } })));

  // ── session ──
  server.registerTool('session_finalize', { title: 'Finalize session tabs', description: 'End-of-task cleanup. Agent-created tabs not listed in keep are closed; deliverable tabs leave the group and stay open; handoff tabs stay in the group for a later turn. Claimed user tabs are only released.',
    inputSchema: { keep: z.array(z.object({ tab: z.string().describe('tab id'), status: z.enum(['deliverable', 'handoff']) })).default([]) },
    annotations: { destructiveHint: true },
  }, async ({ keep }) => run(async () => {
    if (state.js && state.js.status().state !== 'idle') throw new ActionError('js_busy', 'JavaScript or dispatched API work is still running.', 'Wait for js to finish, or call js_reset and wait for doctor javascript.pendingCalls:0 before finalizing.');
    return ok(await (await api.agent.browsers.getDefault()).tabs.finalize({ keep }));
  }));

  // ── sites ──
  server.registerTool('sites_search', { title: 'Find site capabilities', description: 'No query: list available sites with sample commands. With a task, site, or domain as query: find matching commands. Results include args[{name,type,required,help,default,choices}] for site_run. Do not invent parameters.', inputSchema: { query: z.string().optional().describe('task, site, or domain; omit to browse available sites'), limit: z.number().int().min(1).max(100).default(20) }, annotations: { readOnlyHint: true } }, async ({ query, limit }) => run(async () => query?.trim() ? ok({ results: await api.sites.search(query, limit) }) : ok({ sites: rt.registry.sites().slice(0, limit) })));
  server.registerTool('site_run', { title: 'Run a site command', description: 'Run one site command. args must match the args list from sites_search. Invalid args return invalid_args with details.expected. Valid commands execute directly, including writes.', inputSchema: { site: z.string(), command: z.string(), args: z.record(z.string(), z.unknown()).default({}) }, annotations: { openWorldHint: true } }, async ({ site, command, args }, extra) => run(() => runSiteWithProgress(site, command, args, ctxExtra(extra))));

  // ── docs ──
  server.registerTool('docs_get', { title: 'Read a doc', description: 'No name: compact REPL quickstart and available topics. Pass name for a topic; use member with api-reference for one class or method, e.g. Tab.act or Tab.network.', inputSchema: { name: z.string().optional(), member: z.string().optional() }, annotations: { readOnlyHint: true } }, async ({ name, member }) => run(async () => {
    if (!name) return ok(`${readDocForContext('js-tool', docCtx()) ?? ''}\n\nAvailable topics:\n${listDocs(docCtx()).filter(d => d.available).map(d => `- ${d.name}${d.description ? ': ' + d.description : ''}`).join('\n')}`);
    if (member && name !== 'api-reference') throw new ActionError('invalid_args', 'member is supported only with api-reference.');
    if (!listDocs(docCtx()).some((entry) => entry.name === name && entry.available)) throw new ActionError('unknown_doc', `no available doc "${name}"`, 'Call docs_get without a name to see available topics.');
    const d = readDocForContext(name, docCtx(), member);
    if (!d) throw new ActionError('unknown_doc', `no doc "${name}"`, 'Call docs_get without a name to see available topics.');
    return ok(d);
  }));

  // ── code mode ──
  const jsGlobals = { agent: api.agent, browser: api.agent.browser, sites: api.sites, recon: api.recon, tools: api.tools, session: api.session };
  server.registerTool('js', {
    title: 'Browser JavaScript REPL', description: 'Primary browser workspace. Persistent Node REPL: variables, functions, classes and top-level await; use let for reusable bindings. Pre-bound browser, sites, tools, recon. Start: let tab = await browser.tabs.new("https://example.com"); await tab.observe(). Reuse tab across calls; await tab.act({action:"click", target:{ref:"..."}}) with an observed ref, then observe. Batch determined steps and return at new decision points. Await every API call. Last expression is returned; nodeRepl.write(value) adds output. Page JS uses tab.evaluate. docs_get with no arguments returns quickstart/topics; api-reference with member:"Tab.act" gives exact types.',
    inputSchema: { code: z.string(), timeoutMs: z.number().int().min(1).max(1_800_000).default(300_000), maxChars: z.number().int().min(1000).max(120_000).default(12_000).describe('result text budget; retain large data in a variable and return only relevant parts') },
    annotations: { openWorldHint: true, destructiveHint: true },
  }, async ({ code, timeoutMs, maxChars }, extra) => run(async () => {
    if (!state.js) state.js = new JsSession(jsGlobals, async () => { if (rt.hasFeature('streams')) await rt.bridge!.send('streams-reset', { session: `mcp:${sessionId}` }); });
    const r = await state.js.run(code, { timeoutMs, signal: ctxExtra(extra).signal });
    await syncSiteTools();
    const content: Content = [];
    if (r.error) {
      // Same coded envelope as every other tool: branchable code/hint/data when the throw was an ActionError, else a generic js_error.
      const e = r.error;
      const env = { ok: false as const, error: { code: e.code ?? 'js_error', message: e.message, ...(e.hint && { hint: e.hint }), ...(e.data && { ...e.data }), ...(!e.code && e.stack && { stack: e.stack.split('\n').slice(0, 4).join('\n') }) } };
      content.push(text(safeStringify(env, maxChars)));
    } else if (r.value !== undefined) content.push(text(safeStringify({ ok: true, value: r.value }, maxChars)));
    else content.push(text(safeStringify({ ok: true, value: null }, maxChars)));
    if (r.writes.length) {
      const joined = r.writes.join('\n');
      content.push(text(joined.length > 24_000 ? `${joined.slice(0, 24_000)}\n…(truncated ${joined.length - 24_000} chars)` : joined));
    }
    for (const img of r.images) content.push({ type: 'image', data: img.base64, mimeType: img.mimeType });
    return { content, isError: Boolean(r.error) };
  }));
  server.registerTool('js_reset', { title: 'Reset JavaScript session', description: 'Stop JavaScript, clear bindings and close explicit subscriptions; browser tabs stay open. pendingCalls reports already dispatched API operations that may still complete. Wait until doctor shows javascript.pendingCalls:0 before more js; inspect the page before retrying actions.', inputSchema: {} }, async () => run(async () => { return ok(state.js?.reset() ?? { reset: true, pendingCalls: 0 }); }));

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
  const onFeaturesChanged = (): void => { if (server.isConnected()) server.sendResourceListChanged(); };
  if (persistent) rt.on('features-changed', onFeaturesChanged);
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
  server.registerResource('sites', 'opencli://sites', { title: 'Sites', description: 'All sites with command counts', mimeType: 'application/json' }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(await api.sites.list(), null, 2) }] }));
  server.registerResource('site', new ResourceTemplate('opencli://sites/{site}', { list: undefined }), { title: 'Site commands', mimeType: 'application/json' }, async (uri, { site }) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify((await rt.registry.commands(String(site))).map((c) => ({ name: c.name, description: c.description, access: c.access, domain: c.domain, args: c.args, result: c.result })), null, 2) }] }));

  // ── prompts ──
  server.registerPrompt('browse', { title: 'Browse a site for a goal', description: 'Use the browser service to observe, act, verify, and finalize.', argsSchema: { goal: z.string(), url: z.string().optional() } }, ({ goal, url }) => ({ messages: [{ role: 'user', content: { type: 'text', text: `Goal: ${goal}${url ? `\nStart at: ${url}` : ''}\n\n1. Read docs_get for the quickstart. Use js with browser.tabs.new or browser.user.claimTab, then tab.observe → tab.act → tab.expect as needed.\n2. If a verified site adapter fits this task, you may use site_run instead of repeating the workflow.\n3. Finish with session_finalize, keeping only deliverable/handoff tabs.` } }] }));
  server.registerPrompt('write-tool', { title: 'Turn a flow into a tool', description: 'Explore and verify an API, then define an explicit adapter.', argsSchema: { site: z.string(), goal: z.string() } }, ({ site, goal }) => ({ messages: [{ role: 'user', content: { type: 'text', text: `Create a reusable ${site} adapter for: ${goal}\n\n1. Open the site and perform the flow once. Use tab.network.list/detail in js and recon.discover(tab) to identify candidate endpoints.\n2. Verify the chosen endpoint through the logged-in page, including authentication, arguments, pagination, and errors.\n3. Read docs_get {name:"define-tools"}, use js to define a draft with tools.define, verify it with tools.try using sample args and an output assertion, then publish with tools.activate.` } }] }));

  return {
    server, api,
    close: async () => { if (!persistent) return; rt.off('tools-changed', onToolsChanged); rt.off('features-changed', onFeaturesChanged); rt.off('log', onLog); rt.off('browser-event', onBrowserEvent); await rt.closeSession(sessionId); },
  };
}
