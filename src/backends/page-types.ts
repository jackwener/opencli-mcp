/** The transport surface used by the browser object API. */
import type { ActSpec, ActResult, DialogInfo, ConsoleEntry, DownloadWaitResult, FrameStep } from '../protocol.js';
import type { Expectation, CheckResult } from '../shared/page-contract.js';

export interface ScreenshotOptions { format?: 'png' | 'jpeg'; quality?: number; fullPage?: boolean; width?: number; height?: number }

export interface RuntimePage {
  goto(url: string, options?: { waitUntil?: 'load' | 'none'; settleMs?: number }): Promise<void>;
  evaluate<T = unknown>(js: string): Promise<T>;
  fetchJson(url: string, opts?: { method?: string; headers?: Record<string, string>; body?: unknown; timeoutMs?: number }): Promise<unknown>;
  getCookies(opts?: { domain?: string; url?: string }): Promise<unknown[]>;
  tabs(): Promise<unknown[]>;
  networkRequests(includeStatic?: boolean): Promise<unknown[]>;
  getActivePage(): string | undefined;
  cdp(method: string, params?: Record<string, unknown>): Promise<unknown>;
  newTab(url?: string): Promise<string | undefined>;
  closeTab(target?: string): Promise<void>;
  releaseTab(target?: string): Promise<void>;
  closeWindow(): Promise<void>;
  screenshot(options?: ScreenshotOptions): Promise<string>;
  startNetworkCapture(pattern?: string): Promise<boolean>;
  readNetworkCapture(): Promise<unknown[]>;
  waitForDownload(afterSequence: number, timeoutMs?: number): Promise<DownloadWaitResult>;
  /** Child frames in document order; crossOrigin marks frames whose origin differs from the top document (data:/sandboxed count as cross-origin). */
  frames(): Promise<Array<{ index: number; frameId: string; url: string; name: string; crossOrigin?: boolean; oopif?: boolean }>>;
  evaluateInFrame(js: string, frameIndex: number): Promise<unknown>;
  getCurrentUrl(): Promise<string | null>;
  evaluateWithArgs(js: string, args: Record<string, unknown>): Promise<unknown>;
  /** opencli-mcp extras */
  readonly session: string;
  readonly surface: 'browser' | 'adapter';
  /** The interaction engine at this backend's edge (locate → wait → hit-test → real input → settle). */
  act(spec: ActSpec): Promise<ActResult>;
  /** Console messages and uncaught exceptions captured while attached (cursor-paged). */
  consoleLogs(opts?: { afterSequence?: number; limit?: number; levels?: string[]; filter?: string }): Promise<{ cursor: number; entries: ConsoleEntry[]; hasMore: boolean }>;
  /** Browser-driven reload / back / forward with a bounded load wait. */
  history(op: 'reload' | 'back' | 'forward'): Promise<{ url?: string; title?: string; timedOut?: boolean }>;
  dialog(op: 'get' | 'accept' | 'dismiss', text?: string): Promise<{ dialog: DialogInfo | null; handled?: string }>;
  /** Wait until an expectation about the page holds (text/url/title/selector/ref); throws expectation_failed with the failed checks and the page state. */
  expect(what: Expectation, opts?: { timeoutMs?: number }): Promise<CheckResult>;
  /** Accessibility snapshot text for browser sessions and adapters. */
  aria(opts?: { viewport?: boolean }): Promise<string>;
  /** Call one function of the page-side module (extension/src/page) in the main frame or a frame path, without scrolling. */
  pageCall(fn: string, args?: unknown, timeoutMs?: number, frame?: FrameStep | FrameStep[]): Promise<unknown>;
}
