/**
 * MCP over loopback HTTP (MCP 2026-07-28, stateless). The v2 `createMcpHandler` serves each request with a fresh
 * McpServer from the factory over the shared runtime; a thin node wrapper adds the bearer-token gate and /health.
 * Local launchers proxy here; cloud agents reach the same endpoint through an authenticated tunnel.
 */
import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import type { Runtime } from '../runtime/runtime.js';
import { createMcpServer } from '../mcp/server.js';

export interface HttpServerHandle { port: number; host: string; close(): Promise<void> }

/** Stdio launchers supply a stable id per connection; direct HTTP clients may supply one too. */
export const SESSION_HEADER = 'x-opencli-session-id';
const sessionId = (value: string | null): string | null => value !== null && /^[a-zA-Z0-9_-]{1,128}$/.test(value) ? value : null;

export async function startHttpServer(rt: Runtime, opts: { port: number; host?: string; token: string; version: string }): Promise<HttpServerHandle> {
  const host = opts.host ?? '127.0.0.1';
  const handler = createMcpHandler(
    ({ requestInfo }) => {
      const id = sessionId(requestInfo?.headers.get(SESSION_HEADER) ?? null);
      if (!id) throw new Error(`${SESSION_HEADER} is required`);
      return createMcpServer(rt, id, { version: opts.version, persistent: false }).server;
    },
    { onerror: (e) => rt.emit('log', `http error: ${e.message}`) },
  );
  const mcp = toNodeHandler(handler);

  // Under the stateless per-request model a server instance has no lasting connection, so change notifications go through
  // the handler's subscription bus (subscriptions/listen) instead of a per-server sendToolListChanged.
  const onToolsChanged = (): void => handler.notify.toolsChanged();
  rt.on('tools-changed', onToolsChanged);

  const authorized = (req: http.IncomingMessage): boolean => {
    const h = req.headers.authorization ?? '';
    const bearer = h.startsWith('Bearer ') ? h.slice(7) : '';
    const a = Buffer.from(bearer); const b = Buffer.from(opts.token);
    return a.length === b.length && timingSafeEqual(a, b);
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${host}`);
    try {
      if (!authorized(req)) { res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'unauthorized' })); return; }
      if (url.pathname === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, backend: rt.backend(), sessions: rt.sessions.size, extensionConnected: Boolean(rt.bridge?.connected), protocolWarning: rt.bridge?.protocolWarning ?? null, version: opts.version, uptimeMs: Date.now() - rt.startedAt }));
        return;
      }
      const rawSession = req.headers[SESSION_HEADER];
      const requestedSession = sessionId(typeof rawSession === 'string' ? rawSession : null);
      if (requestedSession === null) { res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: `${SESSION_HEADER} is required and must contain 1–128 letters, digits, hyphens or underscores` })); return; }
      if (url.pathname === '/session' && req.method === 'DELETE') {
        await rt.closeSession(requestedSession);
        res.writeHead(204).end();
        return;
      }
      if (url.pathname !== '/mcp') { res.writeHead(404).end(); return; }
      await mcp(req, res);
    } catch (err) {
      rt.emit('log', `http error: ${(err as Error).stack ?? err}`);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: (err as Error).message }));
    }
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, host, () => { const a = server.address(); resolve(typeof a === 'object' && a ? a.port : opts.port); });
  });
  return {
    port, host,
    close: async () => { rt.off('tools-changed', onToolsChanged); await handler.close().catch(() => {}); await new Promise<void>((r) => server.close(() => r())); },
  };
}
