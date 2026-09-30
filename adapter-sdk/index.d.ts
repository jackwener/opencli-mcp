// opencli-mcp/adapter-sdk — the adapter contract (types). This file is the source of truth for what an adapter may use.

export type Access = 'read' | 'write';

export interface ArgValue {
  type?: 'string' | 'int' | 'number' | 'boolean' | 'array' | 'object';
  nullable?: boolean;
  choices?: Array<string | number | boolean>;
  items?: ArgValue;
  properties?: Record<string, ArgValue & { required?: boolean; help?: string }>;
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number;
  /** One representative value, shown to the agent; not used as a default. */
  example?: unknown;
}

export interface Arg extends ArgValue {
  /** snake_case, agent-native JSON key */
  name: string;
  required?: boolean;
  default?: unknown;
  /** one line, agent-facing, no CLI grammar */
  help?: string;
}

/** Cursor-paged network read (pass `afterSequence` from the previous result). */
export interface NetworkReadResult { cursor: number; entries: unknown[]; hasMore: boolean }

/**
 * The tab object model — the SAME surface an agent drives in the `js` tool. An adapter's `run` gets one bound to the
 * site's page. This interface is the adapter-visible subset; the core's Tab satisfies it structurally.
 */
export interface Tab {
  readonly id: string;
  goto(url: string, opts?: { waitUntil?: 'load' | 'none'; settleMs?: number }): Promise<{ url: string | null; title: string | null }>;
  url(): Promise<string | null>;
  reload(): Promise<void>;
  title(): Promise<string | null>;
  observe(opts?: Record<string, unknown>): Promise<Record<string, unknown>>;
  act(opts: Record<string, unknown>): Promise<Record<string, unknown>>;
  find(target: Record<string, unknown>): Promise<unknown>;
  expect(what: Record<string, unknown>, opts?: { timeoutMs?: number }): Promise<unknown>;
  evaluate(js: string | ((arg: any) => any), opts?: { arg?: unknown; frame?: number; timeoutMs?: number }): Promise<unknown>;
  /** Fetch JSON through the page (its cookies, its origin) — the network-first way to call a site's own API. */
  fetchJson(url: string, opts?: Record<string, unknown>): Promise<unknown>;
  /** Read one cookie's value at run time (e.g. a csrf token). */
  cookie(name: string, opts?: { domain?: string }): Promise<string | undefined>;
  cookies(domain: string): Promise<unknown[]>;
  screenshot(opts?: { fullPage?: boolean; annotate?: boolean; format?: 'png' | 'jpeg'; quality?: number }): Promise<unknown>;
  readonly network: {
    start(pattern?: string): Promise<boolean>;
    list(opts?: { filter?: string; limit?: number; afterSequence?: number }): Promise<{ cursor: number; entries: unknown[]; hasMore: boolean }>;
    detail(opts: { seq?: number; requestId?: string; part?: 'request' | 'response'; start?: number; maxChars?: number }): Promise<unknown>;
    read(opts?: { pattern?: string; limit?: number; includeStatic?: boolean; afterSequence?: number }): Promise<NetworkReadResult>;
  };
}

export interface Sites { [site: string]: Record<string, (args?: Record<string, unknown>) => Promise<unknown>> | unknown }
export interface Recon { discover(tab: Tab): Promise<unknown> }

/** What `run` receives. `tab` is the object model; `sites`/`recon` let an adapter reuse siblings + discovery. */
export interface AdapterContext {
  args: Record<string, unknown>;
  tab: Tab;
  sites: Sites;
  recon: Recon;
  signal?: AbortSignal;
}

export interface AdapterDescriptor {
  description: string;
  access: Access;
  /** Agent-facing result shape. `rows` may include nextCursor; `value` is one object/scalar. */
  result?: { kind: 'rows' | 'value'; description: string; fields?: Record<string, string>; paginated?: boolean };
  /** Site metadata and tool icon host; the adapter navigates explicitly when needed. */
  domain?: string;
  args?: Arg[];
  /** aliases resolve to this command */
  aliases?: string[];
  run(ctx: AdapterContext): Promise<unknown>;
}

/** Validate + return an adapter descriptor. Pure: no registration, no side effects. */
export function defineAdapter(descriptor: AdapterDescriptor): AdapterDescriptor;

export class AdapterError extends Error { code: string; hint?: string; constructor(code: string, message: string, hint?: string); }
export const errors: {
  auth(message?: string, hint?: string): AdapterError;
  empty(message?: string): AdapterError;
  argument(message: string, hint?: string): AdapterError;
  upstream(message: string, hint?: string): AdapterError;
};
