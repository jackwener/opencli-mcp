/**
 * Contract between the host-side engine (src/shared/engine.ts) and the page-side module
 * (extension/src/page/index.ts) that runs inside the extension's isolated world next to Playwright's
 * InjectedScript. Only plain JSON crosses this boundary: the host calls `globalThis.__opencliPage.<fn>(args)`.
 */
export const ENGINE_GLOBAL = '__opencliInjected';
export const PAGE_GLOBAL = '__opencliPage';
/** Attribute the resolver sets on the element an action is about to touch. */
export const ACT_MARK = 'data-opencli-act';

export interface ResolveArgs {
  selector: string;
  fallback: string | null;
  /** strict: several matches are only accepted when exactly one is visible */
  strict: boolean;
  /** actionability states to require, e.g. ['visible','enabled','editable'] */
  states: string[];
  align: { block: string; inline: string };
}

export interface Candidate { tag: string; role: string; text: string; ref: string | null; visible: boolean; box: Box }
export interface Box { x: number; y: number; w: number; h: number }

export interface Resolved {
  ok: true;
  x: number; y: number;
  matches_n: number;
  tag: string;
  hit: 'target' | 'other';
  blocker: string | null;
  editable: boolean; checkable: boolean; checked: boolean; isSelect: boolean;
  /** opaque Element ref shared across observation and action */
  ref: string | null;
  /** Playwright-generated selector for replay */
  selector: string | null;
  usedSelector: string;
}
export interface ResolveFail { error: { code: string; message: string; hint?: string; candidates?: Candidate[] }; retry?: boolean }
export type ResolveOutcome = Resolved | ResolveFail;

export interface FindArgs { selector: string; fallback: string | null; limit: number }
export interface FindEntry {
  nth: number;
  ref: string | null;
  selector: string | null;
  tag: string; role: string; name: string; text: string;
  attrs: Record<string, string>;
  visible: boolean; enabled: boolean | null; editable: boolean | null;
  box: Box;
}
export interface FindResult { matches_n: number; visible_n: number; selector: string; entries: FindEntry[] }
export interface QueryFindResult { matches_n: number; entries: Array<FindEntry & { path: string[]; interactiveAncestorRef: string | null }> }

export interface AriaArgs {
  /** only the subtree of elements intersecting the viewport */
  viewport?: boolean;
  /** open one branch of a previous snapshot (opaque ref). Ignores viewport so an off-screen collapsed branch can be read. */
  ref?: string;
  /** character budget before branches with a ref collapse. The host uses the default; tests pass a small one. */
  budget?: number;
}

/** Compact DOM evidence. Truncated fields can be read exactly with tab.read({target:{ref}}). */
export interface DomEntry { ref: string; tag: string; text: string; attrs: Record<string, string>; truncated: boolean }
export interface DomSnapshot { entries: DomEntry[]; total: number; start: number; nextStart?: number; scope: 'viewport' | 'document' }
export interface ObserveFrameArgs extends AriaArgs { format?: 'aria' | 'dom'; start?: number; limit?: number }
export interface FrameOwner { ref: string; id: string; name: string; src: string }
export interface FrameObservation { state?: string; dom?: DomSnapshot; children: FrameOwner[]; warnings?: string[] }
/** Full current DOM evidence for one element; no preview clipping. */
export interface ElementDetails { ref: string; tag: string; name: string; text: string; attrs: Record<string, string> }

export interface ReadTextArgs { maxChars?: number; start?: number; readId?: string; maxSteps?: number; waitMs?: number }
/** Linear document text from one bounded scan. `readId` and `nextStart` continue that same capture. */
export interface ReadTextResult { readId: string; text: string; complete: boolean; reason?: 'budget' | 'scan_limit' | 'unbounded' | 'stale'; chars: number; start: number; nextStart?: number }

export interface DomClickArgs { selector: string; fallback: string | null }
export interface UploadTarget { ok: true; ref: string | null; selector: string | null; matches_n: number }
export interface DomClickOk { ok: true; ref: string | null; tag: string; selector: string | null; x: number; y: number }
export type DomClickResult = DomClickOk | ResolveFail

export interface PointInfo { tag: string; editable: boolean; isSelect: boolean }

export interface FrameProbeResult { found: boolean; sameOrigin?: boolean; x?: number; y?: number; src?: string }

export interface SettleArgs { maxMs: number; quietMs: number }

export interface SelectResult { selected?: string[]; error?: string; available?: string[] }

export interface ElementAtResult { matches_n: number; entries: FindEntry[] }

/** What a flow expects of the page at a step; every field given must hold. */
export interface Expectation { text?: string; notText?: string; selector?: string; ref?: string; url?: string; title?: string; visible?: boolean }
export interface CheckResult { ok: boolean; failed: string[]; url: string; title: string }
