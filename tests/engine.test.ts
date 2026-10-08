import { describe, expect, it } from 'vitest';
import { performAct, targetToSelector, type ActIO } from '../src/shared/engine.js';

import { ariaDiff } from '../src/api/diff.js';
import { collapseAria, subtreeByRef } from '../src/shared/aria-collapse.js';

const resolved = { ok: true as const, x: 10, y: 20, matches_n: 1, tag: 'button', hit: 'target' as const, blocker: null, editable: false, checkable: false, checked: false, isSelect: false, ref: 'e1', selector: '#go', usedSelector: '#go' };

function fakeIo(landed: boolean): { io: ActIO; calls: string[] } {
  const calls: string[] = [];
  const io: ActIO = {
    async call(fn) {
      calls.push(fn);
      if (fn === 'resolve') return resolved;
      if (fn === 'readClickProbe') return landed;
      if (fn === 'domClick') return { ok: true, ref: 'e1', tag: 'button', selector: '#go', x: 0, y: 0 };
      if (fn === 'settle') return { waitedMs: 0, quiet: true };
      return null;
    },
    async cdp(method, params) { calls.push(`${method}:${String((params as { type?: string } | undefined)?.type ?? '')}`); },
  };
  return { io, calls };
}

describe('click delivery', () => {
  it('fails when the mouse event does not reach the page, and does not click again', async () => {
    const { io, calls } = fakeIo(false);
    await expect(performAct(io, { kind: 'click', target: { ref: 'e1' }, settleMs: 0 })).rejects.toMatchObject({ code: 'not_delivered' });
    expect(calls.filter((c) => c === 'domClick')).toEqual([]);
    expect(calls).toContain('armClickProbe');
    expect(calls.at(-1)).toBe('clearActionTarget');
    expect(calls).toContain('Input.dispatchMouseEvent:mousePressed');
  });
});

it('preserves scoped ref identity in selectors, diffs and collapsed branches', () => {
  const a = 'e0123456789abcdef_1', b = 'e0123456789abcdef_2', c = 'e0123456789abcdef_3';
  const other = 'efedcba9876543210_1';
  expect(targetToSelector({ref: b, within: a})).toBe(`aria-ref=${a} >> aria-ref=${b}`);
  const before = `- group [ref=${a}]\n  - button "A" [ref=${b}]\n  - button "B" [ref=${c}]`;
  const changed = ariaDiff(before, `- group [ref=${a}]\n- button "Other document" [ref=${other}]`);
  expect(changed).toMatchObject({added: 1, removed: 2, changed: 0});
  expect(changed.text).toContain(`removed: ${b}–${c}`);
  const named = `- 'button "Quoted: [ref=e999]" [ref=${a}]'`;
  expect(ariaDiff(named, named.replace('e999', 'e998'))).toMatchObject({added:0, removed:0, changed:1});
  const upload = `- file-input \"Upload\" [ref=${a}] [hidden] [multiple]: \"accepts text/plain\"`;
  expect(subtreeByRef(upload, a)).toBe(upload);
  expect(collapseAria(before, 50)).toMatchObject({collapsed: true, text: expect.stringContaining(`[ref=${a}] (collapsed)`)});
});
