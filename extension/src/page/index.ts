/**
 * Page-side module of the interaction engine. Bundled by esbuild and installed in the extension's isolated world of
 * every frame, next to Playwright's InjectedScript (globalThis.__opencliInjected). Exposes plain functions on
 * globalThis.__opencliPage; the host calls them with JSON arguments. Nothing here is assembled from strings, so this
 * file is type-checked with the extension and exercised by the browser smoke test.
 */
import {
  ENGINE_GLOBAL, PAGE_GLOBAL,
  type ResolveArgs, type ResolveOutcome, type ResolveFail, type Candidate, type FindArgs, type FindResult, type FindEntry, type QueryFindResult, type UploadTarget,
  type AriaArgs, type PointInfo, type FrameProbeResult, type SettleArgs, type SelectResult, type ElementAtResult, type Box, type Expectation, type CheckResult,
  type ReadTextArgs, type ReadTextResult, type DomClickArgs, type DomClickResult, type DomSnapshot, type ObserveFrameArgs, type FrameObservation, type ElementDetails,
} from '../../../src/shared/page-contract.js';
import { ARIA_REF_LINE } from '../../../src/shared/element-ref.js';
import { collapseAria, subtreeByRef } from '../../../src/shared/aria-collapse.js';
export { collapseAria, subtreeByRef };

/* eslint-disable @typescript-eslint/no-explicit-any */
type Injected = any;

function injected(): Injected {
  const i = (globalThis as any)[ENGINE_GLOBAL];
  if (!i) throw new Error('engine_missing');
  return i;
}

function query(selector: string, root: Node = document): Element[] {
  const i = injected();
  const run = (parsed: any, scope: Node): Element[] => {
    const at = parsed.parts.findIndex((part: any) => part.name === 'aria-ref');
    if (at < 0) return i.querySelectorAll(parsed, scope) as Element[];
    const el = requireRef(parsed.parts[at].body);
    const scopes: Node[] = at ? run({ ...parsed, parts: parsed.parts.slice(0, at) }, scope) : [scope];
    const inside = scopes.some(parent => {
      let node: Node = el;
      for (;;) {
        if (parent === node || parent.contains(node)) return true;
        const host = (node.getRootNode() as ShadowRoot).host;
        if (!host) return false;
        node = host;
      }
    });
    if (!inside) return [];
    return at + 1 === parsed.parts.length ? [el] : run({ ...parsed, parts: parsed.parts.slice(at + 1) }, el);
  };
  return run(i.parseSelector(selector), root);
}

/** Playwright's elementState throws for states that do not apply (e.g. 'checked' on a text input): read that as "not in this state". */
function stateOf(el: Element, name: string): { matches: boolean; received: string } {
  try { const r = injected().elementState(el, name); return { matches: r.matches === true, received: String(r.received ?? '') }; } catch (e) { return { matches: false, received: 'error:' + ((e as Error)?.message || String(e)) }; }
}
const is = (el: Element, name: string): boolean => stateOf(el, name).matches;

function box(el: Element): Box { const r = el.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; }
const text = (el: Element): string => ((el as HTMLElement).innerText || el.textContent || '').replace(/\s+/g, ' ').trim();

function replaySelector(el: Element): string | null {
  try { return injected().generateSelector(el, { testIdAttributeName: 'data-testid' }).selector as string; } catch { return null; }
}
function roleOf(el: Element): string {
  try { const u = injected().utils; return (u?.getAriaRole && u.getAriaRole(el)) || el.getAttribute('role') || ''; } catch { return el.getAttribute('role') || ''; }
}
function nameOf(el: Element): string {
  try { const u = injected().utils; return u?.getElementAccessibleName ? String(u.getElementAccessibleName(el, false) || '') : u?.getElementAccessibleNameText ? String(u.getElementAccessibleNameText(el, false) || '') : ''; } catch { return ''; }
}

// ── one element identity across ARIA, DOM, find and actions ──
// Playwright owns its capture refs. Only our document-local refs cross the public API boundary.
let refEngine: object | null = null;
let refScope = '';
let stableId = new WeakMap<Element, string>();
let nextStableId = 1;
const refToEl = new Map<string, WeakRef<Element>>();
let annotatedRefs: string[] = [];
function resetRefsIfEngineChanged(): void {
  const engine = injected();
  if (engine === refEngine) return;
  refEngine = engine;
  // Every isolated frame world and engine generation gets its own namespace, including after navigation.
  refScope = [...crypto.getRandomValues(new Uint8Array(8))].map(n => n.toString(16).padStart(2, '0')).join('');
  stableId = new WeakMap(); nextStableId = 1; refToEl.clear(); annotatedRefs = [];
}
function liveElement(ref: string): Element | undefined {
  resetRefsIfEngineChanged();
  const el = refToEl.get(ref)?.deref();
  return el?.isConnected && el.ownerDocument === document ? el : undefined;
}
function pageError(code: string, message: string, hint: string): Error {
  return Object.assign(new Error(message), { code, hint });
}
function requireRef(ref: string): Element {
  const el = liveElement(ref);
  if (!el) throw pageError('stale_ref', `Element ref ${ref} is stale or belongs to another document/frame.`, 'Observe again in the intended frame and use a returned ref with its frame path.');
  return el;
}
/** Register identity without retaining detached elements or evicting live refs from a large capture. */
function stableRefOf(el: Element): string {
  resetRefsIfEngineChanged();
  let ref = stableId.get(el);
  if (ref === undefined) {
    ref = `e${refScope}_${nextStableId++}`;
    stableId.set(el, ref);
    if (nextStableId % 512 === 0) {
      for (const [key, value] of refToEl) {
        const node = value.deref();
        if (!node?.isConnected || node.ownerDocument !== document) refToEl.delete(key);
      }
    }
  }
  refToEl.set(ref, new WeakRef(el));
  return ref;
}
export function ariaRefOf(el: Element): string | null { return stableRefOf(el); }

const candidate = (el: Element): Candidate => ({ tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || '', text: text(el).slice(0, 80), ref: ariaRefOf(el), visible: is(el, 'visible'), box: box(el) });

// Action state belongs to this isolated world, never to shared DOM attributes.
let actionElement: Element | null = null;
export function actionTarget(): Element | null {
  const el = actionElement;
  return el?.isConnected && el.ownerDocument === document ? el : null;
}
const actEl = actionTarget;
function rememberActionTarget(el: Element): void { actionElement = el; }
export function clearActionTarget(): void { actionElement = null; }

const ALIGN_BLOCKS = new Set(['start', 'center', 'end', 'nearest']);

/** Locate → strict/unique-visible → states → scroll → wall-clock stable box → hit-test → remember target. */
export async function resolve(args: ResolveArgs): Promise<ResolveOutcome> {
  const { selector, fallback, strict, states, align } = args;
  let usedSelector = selector;
  let matches = query(selector);
  if (!matches.length && fallback) { usedSelector = fallback; matches = query(fallback); }
  if (!matches.length) return { error: { code: 'not_found', message: `no element matches ${selector}` }, retry: true };
  let el = matches[0];
  if (matches.length > 1 && strict) {
    const visible = matches.filter((m) => is(m, 'visible'));
    if (visible.length === 1) el = visible[0];
    else return { error: { code: 'selector_ambiguous', message: `${matches.length} elements match ${selector}${visible.length ? ` (${visible.length} visible)` : ''}`, hint: 'Add nth, use a more specific locator, or act on a ref/selector from find.', candidates: matches.slice(0, 8).map(candidate) }, retry: false };
  }
  for (const st of states) {
    const r = stateOf(el, st);
    if (r.received === 'error:notconnected') return { error: { code: 'stale_ref', message: 'element detached during resolution' }, retry: true };
    if (!r.matches) return { error: { code: st === 'visible' ? 'not_visible' : st === 'enabled' ? 'not_enabled' : 'not_editable', message: `element is not ${st}${r.received.startsWith('error:') ? ` (${r.received.slice(6)})` : ''}`, candidates: [candidate(el)] }, retry: true };
  }
  try { el.scrollIntoView({ block: (ALIGN_BLOCKS.has(align.block) ? align.block : 'center') as ScrollLogicalPosition, inline: (ALIGN_BLOCKS.has(align.inline) ? align.inline : 'nearest') as ScrollLogicalPosition, behavior: 'instant' as ScrollBehavior }); } catch { /* not scrollable */ }
  // stable bounding box by wall clock: requestAnimationFrame is paused in background tabs
  let prev: string | null = null; let stable = 0; const t0 = performance.now();
  for (;;) {
    const r = el.getBoundingClientRect(); const cur = [r.left, r.top, r.width, r.height].map(Math.round).join(',');
    stable = prev === cur ? stable + 1 : 0; prev = cur;
    if (stable >= 1 || performance.now() - t0 > 700) break;
    await new Promise((res) => setTimeout(res, 40));
  }
  for (const st of states) if (!is(el, st)) return { error: { code: `not_${st}`, message: `element is not ${st} after scrolling` }, retry: true };
  const b = el.getBoundingClientRect();
  if (b.width <= 0 || b.height <= 0) return { error: { code: 'not_visible', message: 'element has no clickable box', hint: 'Retry this same target once with method:"dom". That runs HTMLElement.click() and sends no mouse event. Do not send it after a click that already returned ok.' }, retry: true };
  const x = Math.max(0, b.left + b.width / 2), y = Math.max(0, b.top + b.height / 2);
  if (x > innerWidth || y > innerHeight) return { error: { code: 'not_visible', message: 'element is outside the viewport' }, retry: true };
  const tag = el.tagName.toLowerCase();
  const type = (el as HTMLInputElement).type;
  const checkable = (tag === 'input' && (type === 'checkbox' || type === 'radio')) || ['checkbox', 'radio', 'switch'].includes(el.getAttribute('role') || '');
  const hit = injected().expectHitTarget({ x, y }, el);
  rememberActionTarget(el);
  return {
    ok: true, x, y, matches_n: matches.length, tag,
    hit: hit === 'done' ? 'target' : 'other',
    blocker: hit === 'done' ? null : (hit && hit.hitTargetDescription) || 'another element',
    editable: is(el, 'editable'), checkable, checked: checkable ? is(el, 'checked') : false, isSelect: tag === 'select',
    ref: ariaRefOf(el), selector: replaySelector(el), usedSelector,
  };
}

/** Remember the element under a viewport point for a point-targeted action. */
export function pointInfo(args: { x: number; y: number }): PointInfo | null {
  const el = document.elementFromPoint(args.x, args.y);
  if (!el) return null;
  rememberActionTarget(el);
  const tag = el.tagName.toLowerCase();
  const editable = Boolean((el as HTMLElement).isContentEditable || ((tag === 'input' || tag === 'textarea') && !(el as HTMLInputElement).readOnly && !(el as HTMLInputElement).disabled));
  return { tag, editable, isSelect: tag === 'select' };
}

// ── actions on the remembered element ──
const target = (): Element => { const el = actEl(); if (!el) throw new Error('error:notconnected'); return el; };
const retarget = (el: Element): Element => (injected().retarget(el, 'follow-label') as Element | null) || el;

function targetHasFocus(el: Element): boolean {
  const active = (el.getRootNode() as Document | ShadowRoot).activeElement;
  if (!el.isConnected || !active) return false;
  return active === el || el.contains(active) || (
    (el as HTMLElement).isContentEditable && (active as HTMLElement).isContentEditable && active.contains(el)
  );
}
export function focus(): string {
  const el = actEl(); if (!el) return 'error:notconnected';
  const t = retarget(el);
  // Editable descendants receive input through their editing host, not their own focus().
  let focusTarget = t;
  while ((focusTarget as HTMLElement).isContentEditable && (focusTarget.parentElement as HTMLElement | null)?.isContentEditable) focusTarget = focusTarget.parentElement!;
  const result = String(injected().focusNode(focusTarget, false));
  if (result !== 'done') return result;
  // Body/document targets intentionally send page-level keys to the current focus.
  return t === document.body || t === document.documentElement || targetHasFocus(t) ? 'done' : 'error:focusfailed';
}
export function readValue(): string | null {
  const el = actEl(); if (!el) return null;
  const t = retarget(el) as HTMLInputElement;
  return (t as HTMLElement).isContentEditable ? (t.textContent ?? '') : (t.value ?? null);
}
/** Playwright's fill: 'done' (value set for date/color/range…), 'needsinput' (focused + selected, host must insert text), or 'error:…'. */
export function fill(args: { value: string }): string {
  const el = actEl(); if (!el) return 'error:notconnected';
  try {
    if ((retarget(el) as HTMLElement).isContentEditable) {
      const focused = focus();
      if (focused !== 'done') return focused;
    }
    const result = String(injected().fill(el, args.value));
    return result === 'needsinput' && !targetHasFocus(retarget(el)) ? 'error:focusfailed' : result;
  } catch (e) { return 'error:' + ((e as Error)?.message || String(e)); }
}
export function isChecked(): boolean | null { const el = actEl(); if (!el) return null; const r = stateOf(el, 'checked'); return r.received.startsWith('error:') ? null : r.matches; }
export function select(args: { value: string }): SelectResult {
  const el = actEl(); if (!el) return { error: 'gone' };
  const i = injected();
  let r = i.selectOptions(el, [{ valueOrLabel: args.value }]);
  if (r === 'error:optionsnotfound' && /^\d+$/.test(args.value)) r = i.selectOptions(el, [{ index: Number(args.value) }]);
  if (typeof r === 'string' && r.startsWith('error:')) {
    const available = [...(el as HTMLSelectElement).options ?? []].map((o) => o.label || o.value).slice(0, 50);
    return { error: r.slice(6), available };
  }
  return { selected: Array.isArray(r) ? r.map(String) : [] };
}
export function caretToEnd(): void {
  const el = retarget(target()) as HTMLElement;
  if (el.isContentEditable) {
    const range = el.ownerDocument.createRange();
    range.selectNodeContents(el); range.collapse(false);
    const selection = el.ownerDocument.getSelection();
    selection?.removeAllRanges(); selection?.addRange(range);
  } else {
    const input = el as HTMLInputElement;
    if (typeof input.setSelectionRange === 'function') {
      try { input.setSelectionRange(input.value.length, input.value.length); } catch { /* non-text input */ }
    }
  }
}
/** Remember the file input associated with the target (inside it, its label's control, or the nearest form). */
export function resolveUpload(args: { selector: string; fallback: string | null; files: number }): UploadTarget | ResolveFail {
  let matches = query(args.selector);
  if (!matches.length && args.fallback) matches = query(args.fallback);
  if (!matches.length) return { error: { code: 'not_found', message: 'Upload target was not found. Observe again for a fresh file-input ref.' } };
  if (matches.length !== 1) return { error: { code: 'selector_ambiguous', message: `${matches.length} upload targets match`, candidates: matches.slice(0, 8).map(candidate) } };
  const el = matches[0];
  const direct = el instanceof HTMLInputElement && el.type === 'file' ? [el] : [];
  const controlled = el instanceof HTMLLabelElement && el.control instanceof HTMLInputElement && el.control.type === 'file' ? [el.control] : [];
  const nested = [...el.querySelectorAll<HTMLInputElement>('input[type=file]')];
  const inForm = el.closest('form')?.querySelectorAll<HTMLInputElement>('input[type=file]') ?? [];
  const candidates = [...new Set([...direct, ...controlled, ...nested, ...inForm])];
  if (!candidates.length) candidates.push(...document.querySelectorAll<HTMLInputElement>('input[type=file]'));
  if (candidates.length !== 1) return { error: { code: candidates.length ? 'selector_ambiguous' : 'not_a_file_input', message: candidates.length ? 'Several file inputs are available. Target one file-input ref from tab_observe.' : 'No file input is associated with this target.' } };
  const input = candidates[0];
  if (input.disabled) return { error: { code: 'not_enabled', message: 'The file input is disabled.' } };
  if (args.files > 1 && !input.multiple) return { error: { code: 'invalid_args', message: 'This file input accepts only one file.' } };
  rememberActionTarget(input);
  return { ok: true, ref: ariaRefOf(input), selector: replaySelector(input), matches_n: 1 };
}
export function fileSelectionCount(): number { const el = actEl(); return el instanceof HTMLInputElement ? el.files?.length ?? 0 : 0; }

/** Wait until the DOM has been quiet for `quietMs` (or `maxMs` elapsed). */
export function settle(args: SettleArgs): Promise<{ waitedMs: number; quiet: boolean }> {
  return new Promise((resolveP) => {
    const t0 = performance.now();
    let timer: ReturnType<typeof setTimeout>;
    const finish = (quiet: boolean) => { obs.disconnect(); clearTimeout(cap); resolveP({ waitedMs: Math.round(performance.now() - t0), quiet }); };
    const arm = () => { clearTimeout(timer); timer = setTimeout(() => finish(true), args.quietMs); };
    const obs = new MutationObserver(arm);
    obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
    const cap = setTimeout(() => { clearTimeout(timer); finish(false); }, args.maxMs);
    arm();
  });
}

// ── frames ──
let probedFrame: Element | null = null;
export function frameElement(): Element | null { return probedFrame?.isConnected ? probedFrame : null; }
export function frameProbe(args: { step: string | number; scroll?: boolean }): FrameProbeResult {
  probedFrame = null;
  const list = typeof args.step === 'number' ? [...document.querySelectorAll('iframe,frame')] : query(args.step);
  const fe = (typeof args.step === 'number' ? list[args.step] : list[0]) as HTMLIFrameElement | undefined;
  if (!fe || !/^(IFRAME|FRAME)$/.test(fe.tagName)) return { found: false };
  probedFrame = fe;
  let sameOrigin = false; try { sameOrigin = Boolean(fe.contentWindow && fe.contentWindow.document); } catch { sameOrigin = false; }
  if (args.scroll) try { fe.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' as ScrollBehavior }); } catch { /* not scrollable */ }
  const r = fe.getBoundingClientRect();
  return { found: true, sameOrigin, x: r.left + fe.clientLeft, y: r.top + fe.clientTop, src: fe.src || '' };
}
export function clearFrameProbe(): void { probedFrame = null; }

// ── click delivery: a real mouse event must hit the page; DOM click is an explicit other call ──
let probeHits = 0;
let probeCleanup: (() => void) | null = null;
/** Listen before the host dispatches the mouse event. Capture phase, so a handler that stops the event still counts as delivery. */
export function armClickProbe(): void {
  probeCleanup?.();
  probeHits = 0;
  const on = () => { probeHits++; };
  document.addEventListener('pointerdown', on, true);
  document.addEventListener('mousedown', on, true);
  probeCleanup = () => {
    document.removeEventListener('pointerdown', on, true);
    document.removeEventListener('mousedown', on, true);
    probeCleanup = null;
  };
}
export function readClickProbe(): boolean {
  const hit = probeHits > 0;
  probeCleanup?.();
  probeHits = 0;
  return hit;
}

/** HTMLElement.click() on a resolved element. No scroll, no hit-test, no mouse event — the caller already chose this instead of a pointer. */
export function domClick(args: DomClickArgs): DomClickResult {
  let matches = query(args.selector);
  if (!matches.length && args.fallback) matches = query(args.fallback);
  if (!matches.length) return { error: { code: 'not_found', message: `no element matches ${args.selector}` }, retry: true };
  let el = matches[0];
  if (matches.length > 1) {
    const visible = matches.filter((m) => is(m, 'visible'));
    if (visible.length === 1) el = visible[0];
    else return { error: { code: 'selector_ambiguous', message: `${matches.length} elements match ${args.selector}${visible.length ? ` (${visible.length} visible)` : ''}`, hint: 'Add nth, use a more specific locator, or act on a ref/selector from find.', candidates: matches.slice(0, 8).map(candidate) }, retry: false };
  }
  const enabled = stateOf(el, 'enabled');
  if (!enabled.matches) return { error: { code: 'not_enabled', message: `element is not enabled${enabled.received.startsWith('error:') ? ` (${enabled.received.slice(6)})` : ''}`, candidates: [candidate(el)] }, retry: true };
  rememberActionTarget(el);
  (el as HTMLElement).click();
  const b = el.getBoundingClientRect();
  return { ok: true, ref: ariaRefOf(el), tag: el.tagName.toLowerCase(), selector: replaySelector(el), x: b.width > 0 ? b.left + b.width / 2 : 0, y: b.height > 0 ? b.top + b.height / 2 : 0 };
}

// ── reading: linear text, not the action map ──
const READ_MAX_CHARS = 60_000;
/** 0.8 viewport per step, so this reaches a finite page of about 30 screens before giving up. */
const READ_MAX_STEPS = 40;
/** Growths at the bottom, not reset while scrolling through what was just appended. */
const READ_UNBOUNDED_GROWS = 3;

interface ScrollPort { read(): { x: number; y: number; height: number; scrollHeight: number }; scrollTo(x: number, y: number): void }

function asPort(el: Element, heightFallback: number): ScrollPort {
  return {
    read: () => ({
      x: el.scrollLeft || 0,
      y: el.scrollTop || 0,
      height: el.clientHeight || heightFallback,
      scrollHeight: el.scrollHeight || 0,
    }),
    scrollTo(x: number, y: number) {
      const left = Math.max(0, x);
      const top = Math.max(0, y);
      try { el.scrollTo({ left, top, behavior: 'instant' }); } catch { /* unsupported scrollTo */ }
      el.scrollLeft = left;
      el.scrollTop = top;
    },
  };
}

/** The scrollport that can still move. An inner overflow box wins when it has more hidden content than the document. */
function pickPort(): ScrollPort {
  const root = document.scrollingElement || document.documentElement;
  const doc = asPort(root, window.innerHeight || 800);
  let best = doc;
  let bestRange = doc.read().scrollHeight - doc.read().height;
  if (!document.body) return doc;
  for (const el of query('css=*', document.body)) {
    let oy = '';
    try { oy = getComputedStyle(el).overflowY; } catch { oy = ''; }
    if (oy !== 'auto' && oy !== 'scroll' && oy !== 'overlay') continue;
    const port = asPort(el, 0);
    const m = port.read();
    if (m.height <= 0) continue;
    const range = m.scrollHeight - m.height;
    if (range > bestRange + 1) { best = port; bestRange = range; }
  }
  return best;
}
function skipRead(el: Element | null, visible: WeakMap<Element, boolean>): boolean {
  while (el) {
    const tag = el.tagName;
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return true;
    if (el.id === 'opencli-mcp-annotate') return true;
    if (el.hasAttribute('hidden')) return true;
    const cached = visible.get(el);
    if (cached === false) return true;
    if (cached === undefined) {
      const style = getComputedStyle(el);
      const shown = style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse';
      visible.set(el, shown);
      if (!shown) return true;
    }
    el = el.parentElement ?? (el.getRootNode() as ShadowRoot).host ?? null;
  }
  return false;
}
function pageLines(): Array<{ node: Node; text: string }> {
  const out: Array<{ node: Node; text: string }> = [];
  if (!document.body) return out;
  const visible = new WeakMap<Element, boolean>();
  const visit = (root: Node) => {
    for (const n of root.childNodes) {
      if (n.nodeType === Node.TEXT_NODE) {
        const parent = n.parentElement ?? (n.getRootNode() as ShadowRoot).host;
        if (!skipRead(parent, visible)) {
          const t = (n.textContent || '').replace(/\s+/g, ' ').trim();
          if (t) out.push({ node: n, text: t });
        }
      } else if (n instanceof Element && !skipRead(n, visible)) {
        visit(n);
        if (n.shadowRoot) visit(n.shadowRoot);
      }
    }
  };
  visit(document.body);
  return out;
}

/**
 * Text of a bounded page. Scrolls to mount lazy content, tracks nodes already seen, then restores the scroll position.
 * A feed that grows every time we reach the bottom stops after a few passes: the head already read is the answer.
 */
const READ_CAPTURE_MAX_CHARS = 240_000;
const READ_PREFIX = Math.random().toString(36).slice(2);
let readSeq = 0;
let lastRead: { id: string; text: string; reachedBottom: boolean; reason?: 'scan_limit' | 'unbounded' } | null = null;
function sliceRead(capture: NonNullable<typeof lastRead>, start: number, maxChars: number): ReadTextResult {
  const text = capture.text.slice(start, start + maxChars);
  const nextStart = start + text.length < capture.text.length ? start + text.length : undefined;
  const complete = capture.reachedBottom && nextStart === undefined;
  return { readId: capture.id, text, complete, ...(!complete && { reason: nextStart !== undefined ? 'budget' as const : capture.reason ?? 'scan_limit' as const }), chars: text.length, start, ...(nextStart !== undefined && { nextStart }) };
}
export async function readText(args: ReadTextArgs = {}): Promise<ReadTextResult> {
  const maxChars = args.maxChars && args.maxChars > 0 ? Math.round(args.maxChars) : READ_MAX_CHARS;
  const start = args.start && args.start > 0 ? Math.round(args.start) : 0;
  if (args.readId) return lastRead?.id === args.readId ? sliceRead(lastRead, start, maxChars) : { readId: args.readId, text: '', complete: false, reason: 'stale', chars: 0, start };
  if (start) return { readId: '', text: '', complete: false, reason: 'stale', chars: 0, start };
  const maxSteps = args.maxSteps && args.maxSteps > 0 ? Math.round(args.maxSteps) : READ_MAX_STEPS;
  const waitMs = args.waitMs === undefined ? 40 : Math.max(0, args.waitMs);
  const wait = () => new Promise((r) => setTimeout(r, waitMs));
  const port = pickPort();
  const saved = port.read();
  const seen = new WeakMap<Node, string>();
  const lines: string[] = [];
  let chars = 0;
  const absorb = () => {
    for (const { node, text } of pageLines()) {
      if (seen.get(node) === text) continue;
      seen.set(node, text);
      const separator = lines.length ? 1 : 0;
      const remaining = READ_CAPTURE_MAX_CHARS - chars - separator;
      if (remaining <= 0) break;
      const kept = text.slice(0, remaining);
      chars += kept.length + separator;
      lines.push(kept);
    }
  };
  const finish = (reachedBottom: boolean, reason?: 'scan_limit' | 'unbounded'): ReadTextResult => {
    lastRead = { id: `${READ_PREFIX}-${++readSeq}`, text: lines.join('\n'), reachedBottom, reason };
    return sliceRead(lastRead, 0, maxChars);
  };
  try {
    port.scrollTo(saved.x, 0);
    // Count height increases and do not reset them while scrolling through a tall append.
    let grows = 0;
    let lastHeight = port.read().scrollHeight;
    for (let step = 0; step < maxSteps; step++) {
      await wait();
      absorb();
      if (chars >= READ_CAPTURE_MAX_CHARS) return finish(false, 'scan_limit');
      const m = port.read();
      // Only a growth at the previous bottom counts. A taller image mid-page does not make this a feed.
      const reachedPriorBottom = m.y + m.height >= lastHeight - 1;
      if (reachedPriorBottom && m.scrollHeight > lastHeight + 1) {
        grows++;
        if (grows >= READ_UNBOUNDED_GROWS) return finish(false, 'unbounded');
      }
      lastHeight = m.scrollHeight;
      const atBottom = m.y + m.height >= m.scrollHeight - 1;
      if (atBottom) {
        const heightBefore = m.scrollHeight;
        port.scrollTo(saved.x, m.y + 1);
        await wait();
        absorb();
        if (chars >= READ_CAPTURE_MAX_CHARS) return finish(false, 'scan_limit');
        const after = port.read();
        if (after.scrollHeight <= heightBefore + 1) return finish(true);
        grows++;
        lastHeight = after.scrollHeight;
        if (grows >= READ_UNBOUNDED_GROWS) return finish(false, 'unbounded');
      }
      const here = port.read();
      port.scrollTo(saved.x, here.y + Math.max(1, Math.floor(here.height * 0.8)));
    }
    return finish(false, 'scan_limit');
  } finally {
    port.scrollTo(saved.x, saved.y);
  }
}

// ── observation: the aria snapshot is the action map, not the document ──
const CRED = /user[-_ ]?name|e[-_ ]?mail|one[-_ ]?time[-_ ]?code|password|passcode|passwd|\botp\b|\b(?:2fa|mfa)\b|phone|mobile|\btel\b|\bcc-|cvc|cvv|csc|card|credit|payment|security[-_ ]?code|\biban\b|account[-_ ]?number|routing|ssn|social[-_ ]?security/i;
/** Credential fields never expose their value to the model (the ChatGPT plugin's rule). */
export function isCredentialField(el: Element): boolean {
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return false;
  if ((el as HTMLInputElement).type === 'password') return true;
  const hay = ['type', 'autocomplete', 'id', 'name', 'placeholder', 'aria-label', 'title'].map((a) => el.getAttribute(a) || '').join(' ');
  return CRED.test(hay);
}
function intersectsViewport(el: Element): boolean {
  const vw = window.visualViewport?.width ?? innerWidth, vh = window.visualViewport?.height ?? innerHeight;
  for (const r of el.getClientRects()) if (r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < vw && r.top < vh) return true;
  return false;
}
export function aria(args: AriaArgs = {}): string {
  if (args.ref) requireRef(args.ref);
  const i = injected();
  annotatedRefs = [];
  const raw: string = i.ariaSnapshot(document.body || document.documentElement, { mode: 'ai' });
  resetRefsIfEngineChanged();
  // Resolve native refs through the same engine that emitted them, synchronously within this capture.
  const elements = new Map<string, Element>();
  for (const line of raw.split('\n')) {
    const match = ARIA_REF_LINE.exec(line);
    if (!match) continue;
    let refs: Element[];
    try { refs = i.querySelectorAll(i.parseSelector(`aria-ref=${match[2]}`), document); }
    catch { refs = []; }
    const el = refs[0];
    if (refs.length !== 1 || !el?.isConnected || el.ownerDocument !== document) {
      throw pageError('snapshot_ref_unavailable', `Could not resolve captured ref ${match[2]}.`, 'Use tab.observe({format:"dom"}) for independent DOM evidence.');
    }
    elements.set(match[2], el);
  }
  const out: string[] = [];
  let dropBelow: number | null = null; // indent depth of a dropped (offscreen) node: its deeper children go too
  for (const line of raw.split('\n')) {
    const indent = line.length - line.trimStart().length;
    if (dropBelow !== null) { if (indent > dropBelow) continue; dropBelow = null; }
    const m = ARIA_REF_LINE.exec(line);
    if (!m) { out.push(line); continue; }
    const el = elements.get(m[2])!;
    // pin the line to the element's stable ref (identity is independent of the viewport filter below)
    let rline = m[1] + stableRefOf(el) + m[3] + (m[4] ?? '');
    // a ref opens that branch even when it is off screen; viewport is not a page of the tree
    if (args.viewport && !args.ref && !intersectsViewport(el)) { dropBelow = indent; continue; }
    if (m[4] && isCredentialField(el)) { out.push(rline.slice(0, rline.length - m[4].length) + ': <redacted>'); continue; }
    // Drop a value that just repeats the accessible name (Playwright renders `textbox "X": X` → the reported "X X" dup).
    if (m[4]) { const val = m[4].replace(/^:\s*/, '').trim(); if (val && rline.includes('"' + val + '"')) rline = rline.slice(0, rline.length - m[4].length); }
    out.push(rline);
  }
  annotatedRefs = [...elements.values()].map(stableRefOf);
  // AX snapshots omit hidden file controls. Include them as addressable upload targets.
  const inAx = new Set(elements.values());
  const missingFiles = [...document.querySelectorAll<HTMLInputElement>('input[type=file]')].filter((el) => !inAx.has(el));
  for (const input of missingFiles.slice(0, 20)) {
    const label = input.labels?.[0]?.textContent?.trim() || input.getAttribute('aria-label') || input.name || 'file upload';
    const hidden = !is(input, 'visible') || !intersectsViewport(input);
    out.push(`- file-input ${JSON.stringify(label.slice(0, 100))} [ref=${stableRefOf(input)}]${hidden ? ' [hidden]' : ''}${input.multiple ? ' [multiple]' : ''}${input.accept ? ': ' + JSON.stringify('accepts ' + input.accept.slice(0, 100)) : ''}`);
  }
  if (missingFiles.length > 20) out.push(`- ${missingFiles.length - 20} more file inputs omitted`);
  // the plugin always ends its state with the focused element; ours names the focused ref so the next action can target it
  const active = document.activeElement;
  const focusRef = active && active !== document.body ? ariaRefOf(active) : null;
  let text = out.join('\n') + (focusRef ? `\nFocused: [ref=${focusRef}]` : '');
  if (args.ref) {
    const sub = subtreeByRef(text, args.ref);
    if (sub == null) return `No node [ref=${args.ref}] in this snapshot. Observe again without ref.`;
    text = sub;
  }
  // The host collapses the copy it returns. A caller that passes budget (tests) collapses here.
  return typeof args.budget === 'number' ? collapseAria(text, args.budget).text : text;
}

/** Read live properties, not initial HTML value/checked attributes. */
function domAttributes(el: Element): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const key of ['id', 'name', 'type', 'role', 'aria-label', 'aria-labelledby', 'aria-describedby', 'aria-expanded', 'aria-selected', 'aria-checked', 'aria-disabled', 'placeholder', 'title', 'href', 'src', 'contenteditable', 'tabindex', 'data-testid']) {
    const value = el.getAttribute(key); if (value !== null) attrs[key] = value;
  }
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
    attrs.value = isCredentialField(el) ? '<redacted>' : el.value;
    attrs.disabled = String(el.disabled);
    attrs.required = String(el.required);
  }
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) attrs.readonly = String(el.readOnly);
  if (el instanceof HTMLInputElement && ['checkbox', 'radio'].includes(el.type)) { attrs.checked = String(el.checked); attrs.indeterminate = String(el.indeterminate); }
  if (el instanceof HTMLOptionElement) attrs.selected = String(el.selected);
  if (el instanceof HTMLSelectElement || el instanceof HTMLInputElement && el.type === 'file') attrs.multiple = String(el.multiple);
  return attrs;
}

const INTERACTIVE_ROLES = new Set(['button', 'link', 'textbox', 'checkbox', 'radio', 'combobox', 'listbox', 'option', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'slider', 'spinbutton', 'switch', 'tab', 'treeitem', 'searchbox']);
function isControl(el: Element): boolean {
  return /^(A|BUTTON|INPUT|SELECT|TEXTAREA|DETAILS|SUMMARY|OPTION)$/.test(el.tagName)
    || el.hasAttribute('onclick') || el.hasAttribute('href') || (el as HTMLElement).isContentEditable
    || (el.hasAttribute('tabindex') && Number(el.getAttribute('tabindex')) >= 0)
    || INTERACTIVE_ROLES.has(el.getAttribute('role') ?? '');
}

/** Independent DOM evidence, including open shadow roots; shares stable refs with ARIA and actions. */
export function visibleDom(args: ObserveFrameArgs = {}): DomSnapshot {
  const root = args.ref ? query(`aria-ref=${args.ref}`)[0] : document;
  if (!root) throw new Error(`stale_ref: ${args.ref}; observe again without ref`);
  const elements = [...(root instanceof Element ? [root] : []), ...query('css=*', root)]
    .filter(el => isControl(el) && is(el, 'visible') && (args.viewport === false || intersectsViewport(el)));
  const start = Math.max(0, Math.floor(args.start ?? 0));
  const limit = Math.max(1, Math.min(200, Math.floor(args.limit ?? 60)));
  const entries = elements.slice(start, start + limit).map(el => {
    let truncated = false;
    const clip = (value: string, max: number) => { if (value.length <= max) return value; truncated = true; return value.slice(0, max) + '…'; };
    return { ref: ariaRefOf(el)!, tag: el.tagName.toLowerCase(), text: clip(isCredentialField(el) ? '<redacted>' : text(el), 160), attrs: Object.fromEntries(Object.entries(domAttributes(el)).map(([k, v]) => [k, clip(v, 300)])), truncated };
  });
  const nextStart = start + entries.length < elements.length ? start + entries.length : undefined;
  return { entries, total: elements.length, start, ...(nextStart !== undefined && { nextStart }), scope: args.viewport === false ? 'document' : 'viewport' };
}

/** Capture one document and describe its frame owners without entering or scrolling them. */
export function observeFrame(args: ObserveFrameArgs = {}): FrameObservation {
  const content = args.format === 'dom' ? { dom: visibleDom(args) } : { state: aria(args) };
  const root = args.ref ? query(`aria-ref=${args.ref}`)[0] : document;
  const children = root ? [...(root instanceof Element && /^(IFRAME|FRAME)$/.test(root.tagName) ? [root] : []), ...query('css=iframe,frame', root)]
    .filter(el => el.getAttribute('aria-hidden') !== 'true' && is(el, 'visible') && (!args.viewport || intersectsViewport(el)))
    .map(el => ({ ref: ariaRefOf(el)!, id: el.id, name: el.getAttribute('name') ?? '', src: el.getAttribute('src') ?? '' })) : [];
  return { ...content, children };
}

/** Exact evidence for a single target, with the same strict resolution as actions and no scrolling. */
export function readElement(args: FindArgs): ElementDetails | ResolveFail {
  let matches = query(args.selector);
  if (!matches.length && args.fallback) matches = query(args.fallback);
  if (!matches.length) return { error: { code: 'not_found', message: `no element matches ${args.selector}`, hint: 'Observe or find the target again.' } };
  if (matches.length > 1) {
    const visible = matches.filter(el => is(el, 'visible'));
    if (visible.length !== 1) return { error: { code: 'selector_ambiguous', message: `${matches.length} elements match ${args.selector}`, hint: 'Use a ref from observe/find, or a more specific locator.' } };
    matches = visible;
  }
  const el = matches[0];
  return { ref: ariaRefOf(el)!, tag: el.tagName.toLowerCase(), name: nameOf(el), text: isCredentialField(el) ? '<redacted>' : (el as HTMLElement).innerText ?? el.textContent ?? '', attrs: domAttributes(el) };
}

const describe = (el: Element, i: number): FindEntry => {
  const attrs = Object.fromEntries(Object.entries(domAttributes(el)).map(([key, value]) => [key, value.slice(0, 200)]));
  return { nth: i, ref: ariaRefOf(el), selector: replaySelector(el), tag: el.tagName.toLowerCase(), role: roleOf(el), name: nameOf(el).slice(0, 120), text: text(el).slice(0, 120), attrs, visible: is(el, 'visible'), enabled: stateOf(el, 'enabled').received.startsWith('error:') ? null : is(el, 'enabled'), editable: stateOf(el, 'editable').received.startsWith('error:') ? null : is(el, 'editable'), box: box(el) };
};

/** Same engine, same selector and fallback as act; every entry is replayable via `selector` and `ref`. */
export function find(args: FindArgs): FindResult {
  let usedSelector = args.selector;
  let matches = query(args.selector);
  if (!matches.length && args.fallback) { usedSelector = args.fallback; matches = query(args.fallback); }
  const visible_n = matches.filter((m) => is(m, 'visible')).length;
  return { matches_n: matches.length, visible_n, selector: usedSelector, entries: matches.slice(0, Math.max(1, Math.min(args.limit, 100))).map(describe) };
}

/** Search DOM evidence independently of ARIA, including attributes, live values and open shadow roots. */
export function findByQuery(args: { query: string; limit: number }): QueryFindResult {
  const q = args.query.trim().toLowerCase();
  if (!q) return { matches_n: 0, entries: [] };
  const entries: QueryFindResult['entries'] = [];
  let matches = 0;
  for (const el of query('css=*')) {
    if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(el.tagName) || !is(el, 'visible')) continue;
    const ownText = [...el.childNodes].filter(n => n.nodeType === Node.TEXT_NODE).map(n => n.textContent ?? '').join(' ');
    const evidence = [ownText, ...(isControl(el) ? [text(el), nameOf(el)] : []), ...Object.values(domAttributes(el))].join(' ').toLowerCase();
    if (!evidence.includes(q)) continue;
    matches++;
    if (entries.length >= Math.max(1, Math.min(args.limit, 50))) continue;
    const ancestors: Element[] = [];
    let node: Element | null = el;
    while (node && ancestors.length < 8) {
      ancestors.push(node);
      node = node.parentElement ?? ((node.getRootNode() as ShadowRoot).host || null);
    }
    const interactive = ancestors.find(isControl);
    entries.push({ ...describe(el, matches - 1), path: ancestors.slice(1, 5).reverse().map(n => `${n.tagName.toLowerCase()}${n.id ? '#' + n.id : ''}`), interactiveAncestorRef: interactive ? ariaRefOf(interactive) : null });
  }
  return { matches_n: matches, entries };
}

/** The element under a viewport point and up to three ancestors: turns visual evidence into locators. */
export function elementAt(args: { x: number; y: number }): ElementAtResult {
  const el = document.elementFromPoint(args.x, args.y);
  if (!el) return { matches_n: 0, entries: [] };
  const chain: Element[] = []; let n: Element | null = el;
  while (n && n !== document.body && chain.length < 4) { chain.push(n); n = n.parentElement; }
  return { matches_n: chain.length, entries: chain.map(describe) };
}

// ── screenshot annotation: public refs from the last successful ARIA capture ──
const ANNOTATE_ID = 'opencli-mcp-annotate';
export function annotate(): number {
  unannotate();
  resetRefsIfEngineChanged();
  const layer = document.createElement('div');
  layer.id = ANNOTATE_ID;
  layer.setAttribute('style', 'all:initial;position:fixed;inset:0;z-index:2147483645;pointer-events:none;font:11px/1 -apple-system,Segoe UI,Arial,sans-serif;');
  let count = 0;
  for (const ref of annotatedRefs) {
    const el = liveElement(ref); if (!el || !is(el, 'visible') || !intersectsViewport(el)) continue;
    const r = el.getBoundingClientRect();
    const tag = document.createElement('span');
    tag.textContent = ref; // the label matches the ref observe shows
    tag.setAttribute('style', `position:absolute;left:${Math.max(0, r.left)}px;top:${Math.max(0, r.top - 12)}px;background:#1d4ed8;color:#fff;padding:1px 3px;border-radius:2px;white-space:nowrap;`);
    const outline = document.createElement('div');
    outline.setAttribute('style', `position:absolute;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;outline:1px solid rgba(29,78,216,.8);`);
    layer.append(outline, tag);
    if (++count >= 300) break;
  }
  document.documentElement.appendChild(layer);
  return count;
}
export function unannotate(): void { document.getElementById(ANNOTATE_ID)?.remove(); }

/** Evaluate an expectation once (the host polls until it holds or times out). */
export function check(args: Expectation): CheckResult {
  const failed: string[] = [];
  const bodyText = (document.body?.innerText ?? document.body?.textContent ?? '').replace(/\s+/g, ' ');
  if (args.text !== undefined && !bodyText.includes(args.text)) failed.push(`text "${args.text}" not on the page`);
  if (args.notText !== undefined && bodyText.includes(args.notText)) failed.push(`text "${args.notText}" still on the page`);
  if (args.url !== undefined && !location.href.includes(args.url)) failed.push(`url ${location.href} does not include "${args.url}"`);
  if (args.title !== undefined && !document.title.includes(args.title)) failed.push(`title "${document.title}" does not include "${args.title}"`);
  const locator = args.selector ?? (args.ref ? `aria-ref=${args.ref}` : undefined);
  if (locator !== undefined) {
    const els = query(locator);
    const wantVisible = args.visible !== false;
    if (!els.length) { if (wantVisible) failed.push(`${locator} matches nothing`); }
    else if (wantVisible && !els.some((e) => is(e, 'visible'))) failed.push(`${locator} matches but none is visible`);
    else if (!wantVisible && els.some((e) => is(e, 'visible'))) failed.push(`${locator} is still visible`);
  }
  return { ok: failed.length === 0, failed, url: location.href, title: document.title };
}

export const api = { check, resolve, resolveUpload, fileSelectionCount, pointInfo, focus, readValue, fill, isChecked, select, caretToEnd, actionTarget, clearActionTarget, settle, frameProbe, frameElement, clearFrameProbe, aria, observeFrame, visibleDom, readElement, find, findByQuery, elementAt, annotate, unannotate, armClickProbe, readClickProbe, domClick, readText };
export type PageApi = typeof api;

(globalThis as any)[PAGE_GLOBAL] = api;
