/**
 * stdio launcher for local MCP hosts (Claude Code, Cursor, Codex, …).
 * Proxies to the Chrome-spawned host. Browser and site-adapter commands share that runtime.
 */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { hostHealth, readHostState } from '../host/state.js';
import { SESSION_HEADER } from '../host/http.js';
import { buildInstructions } from '../docs/manifest.js';
import { localCatalog } from '../mcp/catalog.js';
import { doctor } from '../host/doctor.js';
import { ensureHostRegistration } from '../host/registration.js';

class HostUnavailableError extends Error {}

export async function runStdio(opts: { version: string }): Promise<void> {
  const log = (m: string): void => { process.stderr.write(`[opencli-mcp] ${m}\n`); };
  try { ensureHostRegistration(); } catch (err) { log(`browser registration failed: ${String(err)}`); }
  await proxyToHost(opts.version, log);
}

async function proxyToHost(version: string, log: (m: string) => void): Promise<void> {
  const sessionId = randomUUID();
  const catalog = await localCatalog(version);
  // The Chrome-spawned host restarts whenever the extension's Native port drops — an extension reload, a crash, or the
  // service worker being replaced. When that happens we must NOT kill the client's stdio channel (Codex/Claude don't
  // auto-reconnect a dead MCP server); we keep the stdio server up and reconnect to the host on demand, re-reading the
  // host state (its port/token can change across restarts).
  let client: Client | null = null;
  let clientGen = 0;
  let server!: Server;
  const wire = (c: Client): void => {
    c.setNotificationHandler('notifications/tools/list_changed', async () => { await server.sendToolListChanged().catch(() => {}); });
    c.setNotificationHandler('notifications/resources/list_changed', async () => { await server.sendResourceListChanged().catch(() => {}); });
    c.setNotificationHandler('notifications/prompts/list_changed', async () => { await server.sendPromptListChanged().catch(() => {}); });
    c.setNotificationHandler('notifications/message', async (n) => { await server.sendLoggingMessage(n.params).catch(() => {}); });
  };
  const connectOnce = async (): Promise<Client> => {
    // Re-resolve the host each time: an extension reload spawns a fresh host with a new port/token (state file rewritten).
    const st = readHostState();
    if (!st) throw new HostUnavailableError('host not running');
    const h = await hostHealth(st);
    if (!h.ok) throw new HostUnavailableError(h.error ?? 'host not running');
    const c = new Client({ name: 'opencli-mcp-stdio', version }, { capabilities: {} });
    const up = new StreamableHTTPClientTransport(new URL(`http://${st.host}:${st.port}/mcp`), { requestInit: { headers: { authorization: `Bearer ${st.token}`, [SESSION_HEADER]: sessionId } } });
    const gen = ++clientGen;
    up.onclose = () => { if (gen === clientGen) { client = null; log('host connection closed; will reconnect on next request'); } };
    up.onerror = () => { /* surfaced when a request fails; reconnect handles it */ };
    await c.connect(up);
    wire(c);
    client = c;
    return c;
  };
  let connecting: Promise<Client> | null = null;
  const ensure = async (): Promise<Client> => {
    if (client) return client;
    if (!connecting) connecting = connectOnce().finally(() => { connecting = null; });
    return connecting;
  };
  const isDisconnect = (err: unknown): boolean => err instanceof HostUnavailableError || /closed|ECONNREFUSED|ECONNRESET|fetch failed|not connected|terminated/i.test(String((err as Error)?.message ?? err));
  // Discovery reads may be retried after a disconnect; writes must never be replayed blindly.
  const via = async <T>(fn: (c: Client) => Promise<T>): Promise<T> => {
    try { return await fn(await ensure()); }
    catch (err) { if (!isDisconnect(err)) throw err; client = null; return fn(await ensure()); }
  };
  const hostDownError = (err: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: { code: 'host_unavailable', message: `opencli-mcp host not reachable: ${String((err as Error)?.message ?? err)}`, hint: 'Open Chrome and enable the extension, then retry. Run opencli-mcp doctor if it stays unavailable.', retryable: true } }) }], isError: true });
  const unknownOutcomeError = (err: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: { code: 'command_outcome_unknown', message: `Host connection dropped during the tool call: ${String((err as Error)?.message ?? err)}`, hint: 'The command may have applied. Inspect browser or site state before deciding whether to run it again.', retryable: false } }) }], isError: true });

  server = new Server({ name: 'opencli-mcp', version }, {
    capabilities: { tools: { listChanged: true }, resources: { listChanged: true }, prompts: { listChanged: true }, logging: {} },
    instructions: buildInstructions({ backend: 'extension', capabilities: [] }),
  });

  const discover = async <T>(upstream: (c: Client) => Promise<T>, offline: T): Promise<T> => {
    try { return await via(upstream); }
    catch (err) { if (!isDisconnect(err)) throw err; return offline; }
  };
  server.setRequestHandler('tools/list', async (r) => discover((c) => c.listTools(r.params), catalog.tools));
  // Long browser ops can run up to 30 min. Forward the client's progress token and abort signal so the host's progress
  // notifications reach the client and client cancellation stops the host call. A dropped host returns a retryable
  // host_unavailable result (not a dead channel), so the client can simply retry once Chrome is back.
  server.setRequestHandler('tools/call', async (r, ctx) => {
    if (r.params.name === 'doctor') {
      try { return await via((c) => c.callTool(r.params)); }
      catch (err) {
        if (!isDisconnect(err)) throw err;
        return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, data: await doctor() }) }] };
      }
    }
    const progressToken = (r.params as { _meta?: { progressToken?: string | number } })._meta?.progressToken;
    const call = (c: Client) => c.callTool(r.params, {
      timeout: 1_800_000,
      resetTimeoutOnProgress: true,
      signal: ctx.mcpReq.signal,
      ...(progressToken !== undefined
        ? { onprogress: (p) => { void ctx.mcpReq.notify({ method: 'notifications/progress', params: { ...p, progressToken } }); } }
        : {}),
    });
    let upstream: Client;
    try { upstream = await ensure(); } catch (err) { if (isDisconnect(err)) return hostDownError(err); throw err; }
    try { return await call(upstream); } catch (err) { if (isDisconnect(err)) { client = null; return unknownOutcomeError(err); } throw err; }
  });
  server.setRequestHandler('resources/list', async (r) => discover((c) => c.listResources(r.params), catalog.resources));
  server.setRequestHandler('resources/templates/list', async (r) => discover((c) => c.listResourceTemplates(r.params), catalog.resourceTemplates));
  server.setRequestHandler('resources/read', async (r) => via((c) => c.readResource(r.params)));
  server.setRequestHandler('prompts/list', async (r) => discover((c) => c.listPrompts(r.params), catalog.prompts));
  server.setRequestHandler('prompts/get', async (r) => via((c) => c.getPrompt(r.params)));

  const transport = new StdioServerTransport();
  // MCP clients commonly cache tools/list. Notify them when the Chrome-owned host
  // appears, disappears, or is replaced, so configured site tools can be rediscovered.
  let hostIdentity = '';
  let checkingHost = false;
  let stdioConnected = false;
  const watchHost = async (): Promise<void> => {
    if (checkingHost) return;
    checkingHost = true;
    try {
      const st = readHostState();
      const healthy = await hostHealth(st, 500);
      const next = st && healthy.ok ? `${st.pid}:${st.port}:${st.token}` : '';
      if (next !== hostIdentity) {
        hostIdentity = next;
        if (stdioConnected) await server.sendToolListChanged().catch(() => {});
      }
    } finally { checkingHost = false; }
  };
  const hostWatch = setInterval(() => { void watchHost(); }, 2000);
  hostWatch.unref();
  let closing = false;
  const bye = (why: string): void => {
    if (closing) return; closing = true;
    clearInterval(hostWatch);
    log(why);
    transport.onclose = undefined;
    void (async () => {
      await client?.close().catch(() => {});
      const st = readHostState();
      if (st) await fetch(`http://${st.host}:${st.port}/session`, { method: 'DELETE', headers: { authorization: `Bearer ${st.token}`, [SESSION_HEADER]: sessionId }, signal: AbortSignal.timeout(1500) }).catch(() => {});
    })().finally(() => process.exit(0));
  };
  // Only the client (Codex/Claude) going away ends the launcher — never a host drop.
  transport.onclose = () => bye('stdio closed');
  process.stdin.once('end', () => bye('stdin ended'));
  await server.connect(transport);
  stdioConnected = true;
  void watchHost();
}
