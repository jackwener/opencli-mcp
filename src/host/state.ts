/** Host state on disk: where local launchers find the running host and its bearer token. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

/** The one place state lives: token, host state, config, agent-defined tools. */
export const OPENCLI_MCP_DIR = path.join(os.homedir(), '.opencli-mcp');
export const RUN_DIR = path.join(OPENCLI_MCP_DIR, 'run');
export const HOST_STATE_FILE = path.join(RUN_DIR, 'host.json');
export const TOKEN_FILE = path.join(OPENCLI_MCP_DIR, 'token');
export const CONFIG_FILE = path.join(OPENCLI_MCP_DIR, 'config.json');
export const DEFAULT_PORT = 19991;

export interface HostState { pid: number; port: number; host: string; token: string }
export interface Config { port?: number; cursor?: boolean; sites?: string[]; sitesWrite?: string[] }

export function readConfig(): Config {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) as Config; } catch { return {}; }
}

export function loadOrCreateToken(): string {
  try { const t = fs.readFileSync(TOKEN_FILE, 'utf8').trim(); if (t.length >= 32) return t; } catch { /* create */ }
  fs.mkdirSync(OPENCLI_MCP_DIR, { recursive: true });
  const t = randomBytes(24).toString('base64url');
  fs.writeFileSync(TOKEN_FILE, t, { mode: 0o600 });
  return t;
}

export function writeHostState(s: HostState): void {
  fs.mkdirSync(RUN_DIR, { recursive: true });
  fs.writeFileSync(HOST_STATE_FILE, JSON.stringify(s, null, 2), { mode: 0o600 });
}
export function clearHostState(pid: number): void {
  try { const s = readHostState(); if (s && s.pid === pid) fs.rmSync(HOST_STATE_FILE); } catch { /* ignore */ }
}
export function readHostState(): HostState | null {
  try { return JSON.parse(fs.readFileSync(HOST_STATE_FILE, 'utf8')) as HostState; } catch { return null; }
}

export async function hostHealth(s: HostState | null, timeoutMs = 1500): Promise<{ ok: boolean; backend?: string; sessions?: number; extensionConnected?: boolean; protocolWarning?: string | null; error?: string }> {
  if (!s) return { ok: false, error: 'no host state file' };
  try {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(`http://${s.host}:${s.port}/health`, { signal: ctrl.signal, headers: { authorization: `Bearer ${s.token}` } });
    clearTimeout(t);
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const j = await res.json() as { backend: string; sessions: number; extensionConnected: boolean; protocolWarning: string | null };
    return { ok: true, ...j };
  } catch (err) { return { ok: false, error: (err as Error).message }; }
}
