/** Shared frame routing for observations, reads and actions. Observation never scrolls frame owners. */
import type { FrameStep } from '../../src/protocol.js';
import { ActError, PAGE_GLOBAL } from '../../src/shared/engine';
import { callPage, evaluateInWorld, frameCommand } from './world';

/**
 * Enter `target.frame` step by step, the way Codex chains `>> internal:control=enter-frame >>`: each step is resolved in
 * the engine world of the frame reached so far (main → child → grandchild …), the resolved <iframe> element is mapped to
 * its CDP frameId with DOM.describeNode on that frame's own session, and the iframe's viewport offset accumulates.
 * Same-origin, in-process cross-origin (data:/srcdoc) and out-of-process frames all route the same way.
 */
export async function routeFrames(tabId: number, steps: FrameStep[], aggressive: boolean, scroll = false): Promise<{ frameId: string; offset: { x: number; y: number } } | null> {
  if (!steps.length) return null;
  let frameId: string | null = null;
  const offset = { x: 0, y: 0 };
  for (const [depth, step] of steps.entries()) {
    const where = frameId === null ? 'the document' : `frame ${depth} (${steps[depth - 1]})`;
    const probe = await callPage(tabId, frameId, 'frameProbe', { step, scroll }, aggressive, 5_000) as { found: boolean; x?: number; y?: number };
    if (!probe.found) throw new ActError('frame_not_found', `no iframe matches ${JSON.stringify(step)} in ${where}`, 'Pass the css selector of the <iframe> or its 0-based index among iframes in that frame; chain steps outermost first.');
    const probedIn = frameId;
    let objectId: string | undefined;
    try {
      objectId = await evaluateInWorld(tabId, frameId, `globalThis.${PAGE_GLOBAL}.frameElement()`, aggressive, 5_000, false) as string | undefined;
      if (!objectId) throw new ActError('frame_unreachable', `the iframe ${JSON.stringify(step)} vanished while routing`, 'Observe and retry.');
      const { node } = await frameCommand(tabId, frameId, 'DOM.describeNode', { objectId }, aggressive, 5_000) as { node: { frameId?: string } };
      if (!node.frameId) throw new ActError('frame_unreachable', `the iframe ${JSON.stringify(step)} has no frame id yet`, 'The frame may still be loading; observe and retry.');
      offset.x += probe.x ?? 0; offset.y += probe.y ?? 0;
      frameId = node.frameId;
    } finally {
      if (objectId) await frameCommand(tabId, probedIn, 'Runtime.releaseObject', { objectId }, aggressive, 2_000).catch(() => {});
      await callPage(tabId, probedIn, 'clearFrameProbe', undefined, aggressive, 2_000).catch(() => {});
    }
  }
  return frameId === null ? null : { frameId, offset };
}
