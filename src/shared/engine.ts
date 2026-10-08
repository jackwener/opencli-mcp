/**
 * The interaction engine, host side. Rebuilt on Playwright's injected script (what the ChatGPT plugin also embeds)
 * and split like Playwright itself: page-side logic is a real module (extension/src/page/index.ts) installed in the
 * extension's isolated world of every frame; this file only compiles targets, sequences the steps and drives CDP input.
 * One act = locate (strict, unique-visible fallback) → states (visible/enabled/editable) → scroll (three alignments)
 * → wall-clock stable box → hit-test → cursor overlay → real CDP mouse/keyboard → navigation wait → DOM settle.
 */
import { ELEMENT_REF } from './element-ref.js';
import type { ActSpec, ActResult, ActTarget, FrameStep } from '../protocol.js';
import { ENGINE_GLOBAL, PAGE_GLOBAL, type ResolveOutcome, type Resolved, type PointInfo, type SelectResult } from './page-contract.js';
export { ENGINE_GLOBAL, PAGE_GLOBAL } from './page-contract.js';

/** Evaluate once per world: installs Playwright's InjectedScript as globalThis.__opencliInjected, then the page module. */
export function installEngineJs(injectedSource: string, pageModuleSource: string): string {
  return `(() => {
    if (!globalThis.${ENGINE_GLOBAL}) {
      const module = {};
      ${injectedSource}
      globalThis.${ENGINE_GLOBAL}Class = module.exports.InjectedScript();
      globalThis.${ENGINE_GLOBAL} = new globalThis.${ENGINE_GLOBAL}Class(globalThis, {
        isUnderTest: false, sdkLanguage: 'javascript', frameSeq: 0, testIdAttributeName: 'data-testid',
        stableRafCount: 1, browserName: 'chromium', shouldPrependErrorPrefix: false, isUtilityWorld: true, customEngines: [],
      });
    }
    if (!globalThis.${PAGE_GLOBAL}) { ${pageModuleSource} }
    return 'installed';
  })()`;
}

/** The expression the host evaluates in a world to call one page-module function with JSON arguments. */
export function pageCallJs(fn: string, args: unknown): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(fn)) throw new Error(`invalid page function name ${fn}`);
  return `(async () => { try { return await globalThis.${PAGE_GLOBAL}.${fn}(${args === undefined ? '' : JSON.stringify(args)}); }
    catch (e) { return { __opencliPageError: { code: e?.code ?? 'page_error', message: e?.message ?? String(e), hint: e?.hint } }; } })()`;
}

export class ActError extends Error {
  constructor(readonly code: string, message: string, readonly hint?: string, readonly extra?: Record<string, unknown>) { super(message); }
}

/** Restore page errors after the JSON boundary, including observation and frame-routing failures. */
export function unwrapPageResult(value: unknown): unknown {
  const error = (value as { __opencliPageError?: { code: string; message: string; hint?: string } } | null)?.__opencliPageError;
  if (error) throw new ActError(error.code, error.message, error.hint);
  return value;
}

/** Compile an agent target into a Playwright selector (the same engines the plugin uses). */
export function targetToSelector(t: ActTarget): string | null {
  const inner = innerSelector(t);
  if (!inner) return null;
  const scope = scopeSelector(t.within);
  return scope ? `${scope} >> ${inner}` : inner;
}
/** A container to resolve inside: a selector (css or Playwright syntax) or an observed ref. */
function scopeSelector(within: string | undefined): string | null {
  if (!within) return null;
  const w = within.trim();
  if (ELEMENT_REF.test(w)) return `aria-ref=${w}`;
  return w;
}
function innerSelector(t: ActTarget): string | null {
  const q = (s: string, exact = false) => `${JSON.stringify(s)}${exact ? 's' : 'i'}`;
  const nth = typeof t.nth === 'number' ? ` >> nth=${t.nth}` : '';
  if (t.ref !== undefined && t.ref !== null) {
    const r = String(t.ref);
    if (ELEMENT_REF.test(r)) return `aria-ref=${r}`;
    return null;
  }
  if (t.selector) return `${t.selector}${nth}`;
  if (t.role) return `internal:role=${t.role}${t.name ? `[name=${q(t.name)}]` : ''}${nth}`;
  if (t.testid) return `internal:testid=[data-testid=${q(t.testid, true)}]${nth}`;
  if (t.label) return `internal:label=${q(t.label)}${nth}`;
  if (t.name) return `internal:role=button[name=${q(t.name)}]${nth}`;
  if (t.text) return `internal:text=${q(t.text)}${nth}`;
  return null;
}
/** Secondary selector tried when the primary finds nothing (e.g. label → placeholder). */
export function fallbackSelector(t: ActTarget): string | null {
  if (t.label && !t.role && !t.selector) { const f = `internal:attr=[placeholder=${JSON.stringify(t.label)}i]`; const scope = scopeSelector(t.within); return scope ? `${scope} >> ${f}` : f; }
  return null;
}

/** Normalize `target.frame` into ordered steps (outermost first); accepts arrays and Codex's `a >> internal:control=enter-frame >> b`. */
export function frameSteps(frame: FrameStep | FrameStep[] | undefined): FrameStep[] {
  if (frame === undefined) return [];
  const list = Array.isArray(frame) ? frame : [frame];
  return list.flatMap((f) => (typeof f === 'string' ? f.split(/\s*>>\s*(?:internal:control=enter-frame\s*>>\s*)?/).filter(Boolean).map((p) => (/^\d+$/.test(p) ? Number(p) : p)) : [f]));
}

const WRITE_KINDS = new Set(['click', 'dblclick', 'fill', 'type', 'press', 'check', 'uncheck', 'select', 'upload', 'drag']);
const ALIGNMENTS = [{ block: 'center', inline: 'center' }, { block: 'end', inline: 'end' }, { block: 'start', inline: 'start' }];

type KeyDef = { key: string; code: string; keyCode: number; text?: string };
const KEYS: Record<string, KeyDef> = {
  enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' }, return: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  tab: { key: 'Tab', code: 'Tab', keyCode: 9 }, escape: { key: 'Escape', code: 'Escape', keyCode: 27 }, esc: { key: 'Escape', code: 'Escape', keyCode: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 }, delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' }, arrowup: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 }, arrowdown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 }, arrowright: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 }, up: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 }, down: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  home: { key: 'Home', code: 'Home', keyCode: 36 }, end: { key: 'End', code: 'End', keyCode: 35 }, pageup: { key: 'PageUp', code: 'PageUp', keyCode: 33 }, pagedown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
};
const MODS: Record<string, number> = { alt: 1, control: 2, ctrl: 2, meta: 4, cmd: 4, command: 4, shift: 8 };
export function parseKey(spec: string): { def: KeyDef; modifiers: number } {
  const parts = spec.split('+').map((p) => p.trim()).filter(Boolean);
  let modifiers = 0; const keyName = parts[parts.length - 1] ?? spec;
  for (const p of parts.slice(0, -1)) modifiers |= MODS[p.toLowerCase()] ?? 0;
  const lower = keyName.toLowerCase();
  if (KEYS[lower]) return { def: KEYS[lower], modifiers };
  if (keyName.length === 1) { const upper = keyName.toUpperCase(); const code = /[a-z]/i.test(keyName) ? `Key${upper}` : /[0-9]/.test(keyName) ? `Digit${keyName}` : ''; return { def: { key: keyName, code, keyCode: upper.charCodeAt(0), text: modifiers & 6 ? undefined : keyName }, modifiers }; }
  return { def: { key: keyName, code: keyName, keyCode: 0 }, modifiers };
}

/** What a runtime edge provides: page-module calls in the target world, raw CDP on the attached target, cursor, navigation wait. */
export interface ActIO {
  /** Call `globalThis.__opencliPage.<fn>(args)` in the world the action targets. */
  call(fn: string, args?: unknown, timeoutMs?: number): Promise<unknown>;
  cdp(method: string, params?: Record<string, unknown>): Promise<unknown>;
  /** Set files on the remembered Element in its owning isolated world/session. */
  setFiles?(files: string[]): Promise<void>;
  cursor?(x: number, y: number): Promise<unknown>;
  /** Resolve after a navigation the action triggered has finished (or when none started within classifyMs). */
  waitForNavigation?(classifyMs: number, timeoutMs: number): Promise<{ navigated: boolean; url?: string }>;
  /** When the world is a child frame: the frame's position in the top viewport — input events are dispatched on the tab. */
  pointOffset?: { x: number; y: number };
}

async function mouse(io: ActIO, type: 'mouseMoved' | 'mousePressed' | 'mouseReleased', x: number, y: number, clickCount = 0, button: 'left' | 'none' = 'left'): Promise<void> {
  await io.cdp('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' ? 'none' : button, clickCount, buttons: type === 'mousePressed' ? 1 : 0 });
}
async function key(io: ActIO, spec: string): Promise<void> {
  const { def, modifiers } = parseKey(spec);
  await io.cdp('Input.dispatchKeyEvent', { type: def.text ? 'keyDown' : 'rawKeyDown', key: def.key, code: def.code, windowsVirtualKeyCode: def.keyCode, nativeVirtualKeyCode: def.keyCode, modifiers, ...(def.text && { text: def.text, unmodifiedText: def.text }) });
  await io.cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: def.key, code: def.code, windowsVirtualKeyCode: def.keyCode, nativeVirtualKeyCode: def.keyCode, modifiers });
}

async function resolve(io: ActIO, spec: ActSpec, target: ActTarget, timeoutMs: number, started: number): Promise<Resolved> {
  if (typeof target.x === 'number' && typeof target.y === 'number') {
    const r = await io.call('pointInfo', { x: target.x, y: target.y }) as PointInfo | null;
    if (!r) throw new ActError('not_found', `nothing at point ${target.x},${target.y}`);
    return { ok: true, x: target.x, y: target.y, matches_n: 1, tag: r.tag, hit: 'target', blocker: null, editable: r.editable, checkable: false, checked: false, isSelect: r.isSelect, ref: null, selector: null, usedSelector: `point:${target.x},${target.y}` };
  }
  const selector = targetToSelector(target);
  if (!selector) throw new ActError('invalid_target', 'target needs an observed ref, a selector, x/y, or a semantic locator (role/name/label/text/testid)');
  const fallback = fallbackSelector(target);
  const strict = WRITE_KINDS.has(spec.kind);
  const states = spec.kind === 'hover' || spec.kind === 'focus' || spec.kind === 'scroll' ? ['visible'] : spec.kind === 'fill' || spec.kind === 'type' ? ['visible', 'enabled', 'editable'] : ['visible', 'enabled'];
  let last: Exclude<ResolveOutcome, Resolved> | null = null;
  for (;;) {
    for (const align of spec.force ? [ALIGNMENTS[0]] : ALIGNMENTS) {
      const res = await io.call('resolve', { selector, fallback, strict, states, align }, timeoutMs + 2000) as ResolveOutcome;
      if ('ok' in res && res.ok) {
        if (res.hit === 'other' && !spec.force) { last = { error: { code: 'intercepted', message: `${res.blocker ?? 'another element'} intercepts the ${spec.kind} point`, hint: 'Dismiss the overlay or use a different target from tab_find.' }, retry: true }; continue; }
        return res;
      }
      const fail = res as Exclude<ResolveOutcome, Resolved>;
      last = fail;
      if (!fail.retry) throw new ActError(fail.error.code, fail.error.message, fail.error.hint, fail.error.candidates ? { candidates: fail.error.candidates } : undefined);
      break; // other alignments only matter after a hit-test miss
    }
    if (Date.now() - started >= timeoutMs) break;
    await new Promise((s) => setTimeout(s, 100));
  }
  const e = last?.error ?? { code: 'timeout', message: 'target did not become actionable' };
  throw new ActError(e.code, `${e.message} (waited ${Date.now() - started}ms)`, e.hint, e.candidates ? { candidates: e.candidates } : undefined);
}

export async function performAct(io: ActIO, spec: ActSpec): Promise<ActResult> {
  try { return await performAction(io, spec); }
  finally { await io.call('clearActionTarget', undefined, 1000).catch(() => {}); }
}

async function performAction(io: ActIO, spec: ActSpec): Promise<ActResult> {
  if (spec.method === 'dom') return performDomClick(io, spec);
  if (spec.method !== undefined && spec.method !== 'cdp') throw new ActError('invalid_args', `method "${spec.method}" is not a click method.`, 'method is "cdp" (default) or "dom".');
  if (spec.kind === 'upload') return performUpload(io, spec);
  const timeoutMs = spec.timeoutMs ?? 3000;
  const started = Date.now();
  const r = await resolve(io, spec, spec.target, timeoutMs, started);
  if (io.pointOffset) { r.x += io.pointOffset.x; r.y += io.pointOffset.y; }
  if (spec.cursor && io.cursor) await io.cursor(r.x, r.y).catch(() => {});
  const base: ActResult = { ok: true, kind: spec.kind, ref: r.ref, matches_n: r.matches_n, visible_n: r.matches_n, match_level: 'exact', point: { x: Math.round(r.x), y: Math.round(r.y) }, method: 'cdp', hit: r.hit, tag: r.tag, waitedMs: Date.now() - started, selector: r.selector ?? undefined };
  const focus = () => io.call('focus') as Promise<string>;
  const readValue = () => io.call('readValue') as Promise<string | null>;
  const navWait = spec.kind === 'click' || spec.kind === 'dblclick' || spec.kind === 'press' ? io.waitForNavigation?.(300, timeoutMs + 12_000) : undefined;
  switch (spec.kind) {
    case 'hover': await mouse(io, 'mouseMoved', r.x, r.y); break;
    case 'focus': { const f = await focus(); if (f !== 'done') throw new ActError('action_failed', `focus: ${f}`); break; }
    case 'click': case 'dblclick': {
      const count = spec.kind === 'dblclick' ? 2 : 1;
      await io.call('armClickProbe');
      await mouse(io, 'mouseMoved', r.x, r.y);
      for (let i = 1; i <= count; i++) { await mouse(io, 'mousePressed', r.x, r.y, i); await mouse(io, 'mouseReleased', r.x, r.y, i); }
      // A destroyed execution context is retried in a fresh world, where this probe reads 0. Navigation is the delivery signal for that case.
      let landed = false;
      try { landed = Boolean(await io.call('readClickProbe', undefined, 1500)); } catch { landed = false; }
      if (!landed && navWait) {
        const nav = await navWait.catch(() => ({ navigated: false as const }));
        if (nav.navigated) { landed = true; Object.assign(base, { navigated: true, url: nav.url }); }
      }
      if (!landed) {
        const hint = spec.kind === 'click'
          ? 'Retry this same target once with method:"dom" only when the event was not delivered or the element has no box. method:"dom" runs HTMLElement.click() and sends no mouse event. Do not send it after a click that already returned ok.'
          : 'Observe and retry this double-click. method:"dom" is only for a single click.';
        throw new ActError('not_delivered', 'the click did not reach the page — no pointerdown or mousedown fired', hint);
      }
      break;
    }
    case 'check': case 'uncheck': {
      const want = spec.kind === 'check';
      if (!r.checkable) throw new ActError('not_checkable', 'target is not a checkbox/radio/switch');
      if (r.checked !== want) { await mouse(io, 'mouseMoved', r.x, r.y); await mouse(io, 'mousePressed', r.x, r.y, 1); await mouse(io, 'mouseReleased', r.x, r.y, 1); }
      const after = await io.call('isChecked') as boolean | null;
      Object.assign(base, { checked: after, changed: after !== r.checked });
      if (after !== want) throw new ActError('action_failed', `expected checked=${want} but got ${after}`);
      break;
    }
    case 'fill': {
      if (!r.editable) throw new ActError('not_editable', 'target is not an editable field', 'Click the control that opens the editor, or target the input itself.');
      if (spec.value === undefined) throw new ActError('invalid_args', 'action "fill" needs value. Pass "" to clear; omitting it is not a clear.');
      const value = spec.value;
      // Playwright's fill: sets the value for date/color/range inputs ('done'), or focuses + selects text and asks for input ('needsinput')
      const outcome = await io.call('fill', { value }) as string;
      if (outcome === 'needsinput') {
        if (value === '') await key(io, 'Backspace'); else await io.cdp('Input.insertText', { text: value });
      } else if (outcome !== 'done') throw new ActError('not_editable', outcome.replace(/^error:/, ''));
      let actual = await readValue();
      let verified = actual === value;
      if (!verified) {
        await io.call('nativeSet', { value }); // controlled inputs that swallow insertText
        actual = await readValue();
        verified = actual === value;
        Object.assign(base, { method: 'dom' });
      }
      Object.assign(base, { filled: true, verified, actual: actual ?? undefined });
      break;
    }
    case 'type': {
      if (!r.editable) throw new ActError('not_editable', 'target is not an editable field');
      if (!spec.value) throw new ActError('invalid_args', 'action "type" needs a non-empty value.');
      const f = await focus(); if (f !== 'done') throw new ActError('action_failed', `focus: ${f}`);
      await io.call('caretToEnd');
      await io.cdp('Input.insertText', { text: spec.value });
      const actual = await readValue();
      Object.assign(base, { filled: true, verified: Boolean(actual && actual.endsWith(spec.value)), actual: actual ?? undefined });
      break;
    }
    case 'press': {
      if (!spec.value) throw new ActError('invalid_args', 'action "press" needs a non-empty key. There is no default.');
      await focus().catch(() => 'error:notconnected'); // non-focusable targets still receive page-level keys
      await key(io, spec.value);
      Object.assign(base, { key: spec.value });
      break;
    }
    case 'select': {
      if (!r.isSelect) throw new ActError('not_a_select', 'target is not a <select>; click it and choose the option like a user');
      if (!spec.value) throw new ActError('invalid_args', 'action "select" needs a non-empty option label or value.');
      const res = await io.call('select', { value: spec.value }) as SelectResult;
      if (res.error) throw new ActError(res.error === 'optionsnotfound' ? 'option_not_found' : res.error, res.error === 'optionsnotfound' ? `no option matches "${spec.value}"` : res.error, undefined, res.available ? { available: res.available } : undefined);
      Object.assign(base, { method: 'dom', selected: res.selected });
      break;
    }
    case 'scroll': {
      const dir = spec.direction ?? 'down'; const amount = spec.amount ?? 600;
      const dx = dir === 'left' ? -amount : dir === 'right' ? amount : 0; const dy = dir === 'up' ? -amount : dir === 'down' ? amount : 0;
      await io.cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', x: r.x, y: r.y, deltaX: dx, deltaY: dy });
      Object.assign(base, { direction: dir, amount });
      break;
    }
    case 'drag': {
      if (!spec.to) throw new ActError('missing_target', 'drag needs `to`');
      const dest = await resolve(io, { ...spec, kind: 'hover' }, spec.to, timeoutMs, Date.now());
      if (io.pointOffset) { dest.x += io.pointOffset.x; dest.y += io.pointOffset.y; }
      await mouse(io, 'mouseMoved', r.x, r.y); await mouse(io, 'mousePressed', r.x, r.y, 1);
      const steps = 8; for (let i = 1; i <= steps; i++) await mouse(io, 'mouseMoved', r.x + (dest.x - r.x) * i / steps, r.y + (dest.y - r.y) * i / steps);
      await mouse(io, 'mouseReleased', dest.x, dest.y, 1);
      Object.assign(base, { to: { x: Math.round(dest.x), y: Math.round(dest.y) } });
      break;
    }
  }
  if (navWait) { const nav = await navWait.catch(() => ({ navigated: false as const })); if (nav.navigated) Object.assign(base, { navigated: true, url: nav.url }); }
  const settleMs = spec.settleMs ?? 600;
  const actionDone = Date.now();
  if (settleMs > 0 && !(base as { navigated?: boolean }).navigated) { try { await io.call('settle', { maxMs: settleMs, quietMs: Math.min(200, settleMs) }, settleMs + 1500); } catch { /* navigation in flight */ } }
  const settled = Date.now();
  Object.assign(base, { elapsedMs: settled - started, timings: { resolveMs: base.waitedMs, actionMs: actionDone - started - base.waitedMs, settleMs: settled - actionDone } });
  return base;
}

/** File controls may be hidden by the site's own upload button; no pointer target or layout box is required. */
async function performUpload(io: ActIO, spec: ActSpec): Promise<ActResult> {
  const files = spec.files ?? [];
  if (!files.length) throw new ActError('missing_files', 'upload needs files');
  const selector = targetToSelector(spec.target);
  if (!selector) throw new ActError('invalid_target', 'upload needs a file-input ref or a locator associated with one');
  const started = Date.now();
  const resolved = await io.call('resolveUpload', { selector, fallback: fallbackSelector(spec.target), files: files.length }) as import('./page-contract.js').UploadTarget | import('./page-contract.js').ResolveFail;
  if (!('ok' in resolved)) throw new ActError(resolved.error.code, resolved.error.message, resolved.error.hint, resolved.error.candidates ? { candidates: resolved.error.candidates } : undefined);
  if (!io.setFiles) throw new ActError('unsupported', 'This runtime cannot upload files');
  await io.setFiles(files);
  const count = await io.call('fileSelectionCount') as number;
  return { ok: true, kind: 'upload', ref: resolved.ref, matches_n: resolved.matches_n, visible_n: 0, match_level: 'exact', point: { x: 0, y: 0 }, method: 'cdp', hit: 'target', tag: 'input', waitedMs: Date.now() - started, selector: resolved.selector ?? undefined, files: count, verified: count === files.length };
}

/** Explicit DOM activation. No mouse event is sent, so this cannot be a second click after a delivered one unless the caller asks again. */
async function performDomClick(io: ActIO, spec: ActSpec): Promise<ActResult> {
  if (spec.kind !== 'click') throw new ActError('invalid_args', 'method "dom" is only for click.', 'Real mouse input is the default. method:"dom" is the one click that has no layout box.');
  if (typeof spec.target.x === 'number') throw new ActError('invalid_args', 'method "dom" needs an element, not a point.', 'A point has no HTMLElement.click().');
  const selector = targetToSelector(spec.target);
  if (!selector) throw new ActError('invalid_target', 'target needs an observed ref, a selector, or a semantic locator (role/name/label/text/testid)');
  const timeoutMs = spec.timeoutMs ?? 3000;
  const started = Date.now();
  const res = await io.call('domClick', { selector, fallback: fallbackSelector(spec.target) }) as { ok?: true; error?: { code: string; message: string; hint?: string; candidates?: unknown[] }; ref?: string | null; tag?: string; selector?: string | null; x?: number; y?: number; matches_n?: number };
  if (!res || res.ok !== true) {
    const e = res?.error ?? { code: 'action_failed', message: 'DOM click failed' };
    throw new ActError(e.code, e.message, e.hint, e.candidates ? { candidates: e.candidates } : undefined);
  }
  const base: ActResult = { ok: true, kind: 'click', ref: res.ref, matches_n: 1, visible_n: 1, match_level: 'exact', point: { x: Math.round(res.x ?? 0), y: Math.round(res.y ?? 0) }, method: 'dom', hit: 'target', tag: res.tag ?? '', waitedMs: Date.now() - started, selector: res.selector ?? undefined };
  const navWait = io.waitForNavigation?.(300, timeoutMs + 12_000);
  if (navWait) { const nav = await navWait.catch(() => ({ navigated: false as const })); if (nav.navigated) Object.assign(base, { navigated: true, url: nav.url }); }
  const settleMs = spec.settleMs ?? 600;
  const actionDone = Date.now();
  if (settleMs > 0 && !base.navigated) { try { await io.call('settle', { maxMs: settleMs, quietMs: Math.min(200, settleMs) }, settleMs + 1500); } catch { /* navigation in flight */ } }
  Object.assign(base, { elapsedMs: Date.now() - started, timings: { resolveMs: base.waitedMs, actionMs: actionDone - started - base.waitedMs, settleMs: Date.now() - actionDone } });
  return base;
}
