/** Extension edge of the interaction engine: engine-world evaluation, CDP on the attached tab, cursor overlay, navigation wait. */
import type { ActSpec, ActResult } from '../../src/protocol.js';
import { performAct as run, ActError, frameSteps } from '../../src/shared/engine';
import * as executor from './cdp';
import { callPage, frameCommand, evaluateInWorld } from './world';
import { PAGE_GLOBAL } from '../../src/shared/page-contract';
import { routeFrames } from './frames';

export { ActError };

/** Resolve once a navigation started within `classifyMs` has finished (or immediately with navigated:false). */
export function waitForNavigation(tabId: number, classifyMs: number, timeoutMs: number): Promise<{ navigated: boolean; url?: string }> {
  return new Promise((resolve) => {
    let started = false; let done = false;
    const finish = (navigated: boolean, url?: string) => { if (done) return; done = true; chrome.webNavigation.onBeforeNavigate.removeListener(onStart); chrome.webNavigation.onCompleted.removeListener(onEnd); chrome.webNavigation.onErrorOccurred.removeListener(onEnd); chrome.tabs.onUpdated.removeListener(onUpdated); clearTimeout(classify); clearTimeout(overall); resolve({ navigated, url }); };
    type NavDetails = { tabId: number; frameId: number; url: string };
    const onStart = (d: NavDetails) => { if (d.tabId === tabId && d.frameId === 0) { started = true; clearTimeout(classify); } };
    const onEnd = (d: NavDetails) => { if (started && d.tabId === tabId && d.frameId === 0) finish(true, d.url); };
    const onUpdated = (id: number, info: chrome.tabs.OnUpdatedInfo, tab: chrome.tabs.Tab) => { if (id === tabId && started && info.status === 'complete') finish(true, tab.url); };
    chrome.webNavigation.onBeforeNavigate.addListener(onStart);
    chrome.webNavigation.onCompleted.addListener(onEnd);
    chrome.webNavigation.onErrorOccurred.addListener(onEnd);
    chrome.tabs.onUpdated.addListener(onUpdated);
    const classify = setTimeout(() => { if (!started) finish(false); }, classifyMs);
    const overall = setTimeout(() => finish(started), timeoutMs);
  });
}

/** Pass the actual Element handle to CDP, including shadow roots and child frame sessions. */
async function setFiles(tabId: number, frameId: string | null, files: string[], aggressive: boolean): Promise<void> {
  const objectId = await evaluateInWorld(tabId, frameId, `globalThis.${PAGE_GLOBAL}.actionTarget()`, aggressive, undefined, false);
  if (typeof objectId !== 'string') throw new ActError('stale_ref', 'Upload target is no longer connected');
  try {
    await frameCommand(tabId, frameId, 'DOM.setFileInputFiles', { files, objectId }, aggressive);
  } finally {
    await frameCommand(tabId, frameId, 'Runtime.releaseObject', { objectId }, aggressive).catch(() => {});
  }
}

export async function performAct(tabId: number, spec: ActSpec, opts: { aggressive: boolean; cursor?: (x: number, y: number) => Promise<unknown> }): Promise<ActResult> {
  await executor.ensureAttached(tabId, opts.aggressive);
  const route = typeof spec.target.x === 'number' ? null : await routeFrames(tabId, frameSteps(spec.target.frame), opts.aggressive, true);
  if (route) {
    const { frame: _frame, ...target } = spec.target;
    return run({
      call: async (fn, args, timeoutMs) => {
        const result = await callPage(tabId, route.frameId, fn, args, opts.aggressive, timeoutMs);
        // resolve scrolls the element and can move every ancestor iframe. Input coordinates must use the
        // post-scroll offsets, not the positions captured while initially entering the frame chain.
        if (fn === 'resolve' && (result as { ok?: boolean })?.ok) {
          const current = await routeFrames(tabId, frameSteps(spec.target.frame), opts.aggressive);
          if (!current || current.frameId !== route.frameId) throw new ActError('frame_unreachable', 'The frame changed during element resolution', 'Observe and locate the target again.');
          Object.assign(route.offset, current.offset);
        }
        return result;
      },
      // DOM.* must address the frame's own session (node ids are per session); Input.* is dispatched on the tab and routed by Chrome
      cdp: (method, params) => method.startsWith('DOM.') ? frameCommand(tabId, route.frameId, method, params ?? {}, opts.aggressive) : executor.sendDebuggerCommand({ tabId }, method, params),
      setFiles: files => setFiles(tabId, route.frameId, files, opts.aggressive),
      cursor: opts.cursor,
      waitForNavigation: (classifyMs, timeoutMs) => waitForNavigation(tabId, classifyMs, timeoutMs),
      pointOffset: route.offset,
    }, { ...spec, target });
  }
  return run({
    call: (fn, args, timeoutMs) => callPage(tabId, null, fn, args, opts.aggressive, timeoutMs),
    cdp: (method, params) => executor.sendDebuggerCommand({ tabId }, method, params),
    setFiles: files => setFiles(tabId, null, files, opts.aggressive),
    cursor: opts.cursor,
    waitForNavigation: (classifyMs, timeoutMs) => waitForNavigation(tabId, classifyMs, timeoutMs),
  }, spec);
}
