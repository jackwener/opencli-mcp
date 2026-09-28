/**
 * Frame worlds — the one place that knows how to run code in a frame. Two worlds per frame:
 *  - the engine world: an isolated world where Playwright's injected script and our page module live, so page
 *    scripts cannot see or tamper with them (the ChatGPT plugin's arrangement);
 *  - the main world: the frame's own default context, for page JavaScript evaluation.
 * Both are keyed by tab+frame, routed to the frame's own session when it is out-of-process, and rebuilt when
 * Chrome reports a context gone.
 */
import * as executor from './cdp';
import { INJECTED_SOURCE } from '../../src/shared/injected-source';
import { ENGINE_GLOBAL, PAGE_GLOBAL, installEngineJs, pageCallJs } from '../../src/shared/engine';

/** The bundled page module (extension/dist/page.js), read once from the extension package. */
let pageModule: Promise<string> | null = null;
function pageModuleSource(): Promise<string> {
  pageModule ??= fetch(chrome.runtime.getURL('page.js')).then((r) => r.text());
  return pageModule;
}
const READY = `(globalThis.${ENGINE_GLOBAL} && globalThis.${PAGE_GLOBAL})`;

const WORLD_NAME = 'opencli-mcp-engine';
const contexts = new Map<string, number>(); // `${tabId}:${frameId}` → engine-world executionContextId
/** Default (main-world) execution contexts of in-process child frames, reported by Runtime on the root session. */
const mainContexts = new Map<string, number>();

/** Track main-world contexts per frame and drop everything of a tab when it goes away. Call once at startup. */
export function registerFrameTracking(): void {
  chrome.debugger.onEvent.addListener((source, method, params: any) => {
    const tabId = source.tabId;
    if (!tabId || source.sessionId) return; // child sessions (OOPIF) are evaluated without a context id
    if (method === 'Runtime.executionContextCreated') {
      const ctx = params?.context;
      if (ctx?.auxData?.frameId && ctx.auxData.isDefault === true) mainContexts.set(key(tabId, ctx.auxData.frameId), ctx.id);
    } else if (method === 'Runtime.executionContextDestroyed') {
      for (const [k, id] of mainContexts) if (id === params?.executionContextId && k.startsWith(`${tabId}:`)) { mainContexts.delete(k); break; }
    } else if (method === 'Runtime.executionContextsCleared') forgetTab(tabId);
  });
  chrome.tabs.onRemoved.addListener((tabId) => forgetTab(tabId));
  chrome.debugger.onDetach.addListener((source) => { if (source.tabId) forgetTab(source.tabId); });
}

function key(tabId: number, frameId: string): string { return `${tabId}:${frameId}`; }

export function forgetTab(tabId: number): void {
  for (const k of [...contexts.keys()]) if (k.startsWith(`${tabId}:`)) contexts.delete(k);
  for (const k of [...mainContexts.keys()]) if (k.startsWith(`${tabId}:`)) mainContexts.delete(k);
  for (const k of [...frameHosts.keys()]) if (k.startsWith(`${tabId}:`)) frameHosts.delete(k);
}

async function mainFrameId(tabId: number): Promise<string> {
  const { frameTree } = await executor.sendDebuggerCommand({ tabId }, 'Page.getFrameTree') as { frameTree: { frame: { id: string } } };
  return frameTree.frame.id;
}

async function ensureContext(tabId: number, aggressive: boolean): Promise<number> {
  await executor.ensureAttached(tabId, aggressive);
  const frameId = await mainFrameId(tabId);
  const k = key(tabId, frameId);
  const cached = contexts.get(k);
  if (cached !== undefined) return cached;
  const { executionContextId } = await executor.sendDebuggerCommand({ tabId }, 'Page.createIsolatedWorld', { frameId, worldName: WORLD_NAME, grantUniveralAccess: true }) as { executionContextId: number };
  contexts.set(k, executionContextId);
  await evaluateIn(tabId, executionContextId, installEngineJs(INJECTED_SOURCE, await pageModuleSource()), 15_000);
  return executionContextId;
}

async function evaluateIn(tabId: number, contextId: number, expression: string, timeoutMs?: number, byValue = true): Promise<unknown> {
  const r = await executor.sendDebuggerCommand({ tabId }, 'Runtime.evaluate', { expression, contextId, awaitPromise: true, returnByValue: byValue, userGesture: true }, timeoutMs) as { result?: { value?: unknown; objectId?: string }; exceptionDetails?: { exception?: { description?: string }; text?: string } };
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? 'evaluate failed');
  return byValue ? r.result?.value : r.result?.objectId;
}

const frameHosts = new Map<string, 'target' | 'root'>();

/**
 * Send a command for a child frame: to the frame's own target when it is out-of-process, otherwise to the tab's root
 * session (in-process cross-origin frames such as data:/sandboxed srcdoc/same-site have no target but accept
 * Page.createIsolatedWorld and Runtime.evaluate by frameId/contextId there).
 */
export async function frameCall(tabId: number, frameId: string, method: string, params: Record<string, unknown>, aggressive: boolean, timeoutMs?: number): Promise<unknown> {
  const k = key(tabId, frameId);
  let host = frameHosts.get(k);
  // only a positive answer is cached: an OOPIF may auto-attach a moment after its frame appears, so 'root' is re-checked each time
  if (!host) { host = (await executor.hasFrameTarget(tabId, frameId, aggressive)) ? 'target' : 'root'; if (host === 'target') frameHosts.set(k, host); }
  return host === 'target'
    ? executor.sendCommandInFrameTarget(tabId, frameId, method, params, aggressive, timeoutMs)
    : executor.sendDebuggerCommand({ tabId }, method, params, timeoutMs);
}

async function ensureFrameContext(tabId: number, frameId: string, aggressive: boolean): Promise<number> {
  const k = key(tabId, frameId);
  const cached = contexts.get(k);
  if (cached !== undefined) return cached;
  const { executionContextId } = await frameCall(tabId, frameId, 'Page.createIsolatedWorld', { frameId, worldName: WORLD_NAME, grantUniveralAccess: true }, aggressive) as { executionContextId: number };
  contexts.set(k, executionContextId);
  await evaluateInFrameCtx(tabId, frameId, executionContextId, installEngineJs(INJECTED_SOURCE, await pageModuleSource()), aggressive, 15_000);
  return executionContextId;
}

async function evaluateInFrameCtx(tabId: number, frameId: string, contextId: number, expression: string, aggressive: boolean, timeoutMs?: number, byValue = true): Promise<unknown> {
  const r = await frameCall(tabId, frameId, 'Runtime.evaluate', { expression, contextId, awaitPromise: true, returnByValue: byValue, userGesture: true }, aggressive, timeoutMs) as { result?: { value?: unknown; objectId?: string }; exceptionDetails?: { exception?: { description?: string }; text?: string } };
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? 'evaluate failed');
  return byValue ? r.result?.value : r.result?.objectId;
}

/** Evaluate in the engine world of an out-of-process iframe (its own debugger target), installing the engine on first use. */
export async function evaluateInFrameEngine(tabId: number, frameId: string, expression: string, aggressive: boolean, timeoutMs?: number): Promise<unknown> {
  const run = async () => { const ctx = await ensureFrameContext(tabId, frameId, aggressive); return evaluateInFrameCtx(tabId, frameId, ctx, `(() => { if (!globalThis.${ENGINE_GLOBAL}) throw new Error('engine_missing'); return (${expression}); })()`, aggressive, timeoutMs); };
  try { return await run(); } catch (err) {
    const msg = (err as Error).message ?? '';
    if (/Cannot find context|context was destroyed|engine_missing|not found|Inspected target navigated/i.test(msg)) { contexts.delete(key(tabId, frameId)); frameHosts.delete(key(tabId, frameId)); return run(); }
    throw err;
  }
}

/**
 * Evaluate in the engine world of the main frame (frameId null) or of a child frame, by value or as a remote object id.
 * The object id belongs to the session that owns the frame (root, or the OOPIF target) — pass the same frameId to
 * `frameCommand` to use it with DOM.* there.
 */
export async function evaluateInWorld(tabId: number, frameId: string | null, expression: string, aggressive: boolean, timeoutMs?: number, byValue = true): Promise<unknown> {
  const wrapped = `(() => { if (!${READY}) throw new Error('engine_missing'); return (${expression}); })()`;
  const run = async () => frameId === null
    ? evaluateIn(tabId, await ensureContext(tabId, aggressive), wrapped, timeoutMs, byValue)
    : evaluateInFrameCtx(tabId, frameId, await ensureFrameContext(tabId, frameId, aggressive), wrapped, aggressive, timeoutMs, byValue);
  try { return await run(); } catch (err) {
    const msg = (err as Error).message ?? '';
    if (/Cannot find context|context was destroyed|engine_missing|not found|Inspected target navigated/i.test(msg)) { if (frameId === null) forgetTab(tabId); else { contexts.delete(key(tabId, frameId)); frameHosts.delete(key(tabId, frameId)); } return run(); }
    throw err;
  }
}

/** Evaluate in a frame's MAIN world (read-only page access): root session for the main frame and in-process frames (by context id), the frame's own session otherwise. */
export async function evaluateMain(tabId: number, frameId: string | null, expression: string, aggressive: boolean, timeoutMs?: number): Promise<unknown> {
  await executor.ensureAttached(tabId, aggressive);
  if (frameId === null) return executor.evaluate(tabId, expression, aggressive, timeoutMs);
  const k = key(tabId, frameId);
  let host = frameHosts.get(k);
  // only a positive answer is cached: an OOPIF may auto-attach a moment after its frame appears, so 'root' is re-checked each time
  if (!host) { host = (await executor.hasFrameTarget(tabId, frameId, aggressive)) ? 'target' : 'root'; if (host === 'target') frameHosts.set(k, host); }
  const params: Record<string, unknown> = { expression, returnByValue: true, awaitPromise: true };
  if (host === 'root') {
    let ctx = mainContexts.get(k);
    if (ctx === undefined) { await executor.sendDebuggerCommand({ tabId }, 'Runtime.enable').catch(() => {}); await new Promise((r) => setTimeout(r, 50)); ctx = mainContexts.get(k); }
    if (ctx === undefined) throw Object.assign(new Error(`no execution context for frame ${frameId}`), { code: 'frame_unreachable', hint: 'The frame may still be loading; observe and retry.' });
    params.contextId = ctx;
  }
  const r = await frameCall(tabId, frameId, 'Runtime.evaluate', params, aggressive, timeoutMs) as { result?: { value?: unknown }; exceptionDetails?: { exception?: { description?: string }; text?: string } };
  if (r.exceptionDetails) {
    const msg = r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? 'evaluate failed';
    if (/Cannot find context|context with specified id|Execution context was destroyed/i.test(msg)) { mainContexts.delete(k); throw Object.assign(new Error(msg), { code: 'frame_unreachable', hint: 'The frame navigated; retry.' }); }
    throw new Error(msg);
  }
  return executor.evaluationValue(r.result);
}

/** Call one page-module function (extension/src/page) in the main frame's world or a child frame's world. */
export function callPage(tabId: number, frameId: string | null, fn: string, args: unknown, aggressive: boolean, timeoutMs?: number): Promise<unknown> {
  return evaluateInWorld(tabId, frameId, pageCallJs(fn, args), aggressive, timeoutMs);
}

/** A CDP command on the session that owns the frame: root for the main frame and in-process frames, the OOPIF target otherwise. */
export function frameCommand(tabId: number, frameId: string | null, method: string, params: Record<string, unknown>, aggressive: boolean, timeoutMs?: number): Promise<unknown> {
  return frameId === null ? executor.sendDebuggerCommand({ tabId }, method, params, timeoutMs) : frameCall(tabId, frameId, method, params, aggressive, timeoutMs);
}

/** Evaluate in the engine world; installs the engine on first use and recovers from a destroyed context once. */
export async function evaluateInEngine(tabId: number, expression: string, aggressive: boolean, timeoutMs?: number): Promise<unknown> {
  const run = async () => { const ctx = await ensureContext(tabId, aggressive); return evaluateIn(tabId, ctx, `(() => { if (!${READY}) throw new Error('engine_missing'); return (${expression}); })()`, timeoutMs); };
  try { return await run(); } catch (err) {
    const msg = (err as Error).message ?? '';
    if (/Cannot find context|context was destroyed|engine_missing|not found|Inspected target navigated/i.test(msg)) { forgetTab(tabId); return run(); }
    throw err;
  }
}
