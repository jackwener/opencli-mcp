/**
 * Semantic diff of two aria snapshots, keyed on element identity (the ref of each line) the way the ChatGPT
 * plugin diffs accessibility trees: `~` a node whose line changed, `+` a node that appeared, removed nodes summarized
 * as ref ranges; text-only lines (no ref) are matched by content.
 */
import { ARIA_REF_LINE as REF } from '../shared/element-ref.js';

export interface AriaDiff { changedRatio: number; text: string; added: number; removed: number; changed: number }
export function ariaDiff(prev: string, next: string): AriaDiff {
  const index = (t: string) => { const m = new Map<string, string>(); const texts = new Map<string, number>(); for (const line of t.split('\n')) { const r = REF.exec(line); if (r) m.set(r[2], line); else if (line.trim()) texts.set(line, (texts.get(line) ?? 0) + 1); } return { m, texts }; };
  const a = index(prev), b = index(next);
  const out: string[] = []; let added = 0, removed = 0, changed = 0;
  const seenText = new Map<string, number>();
  for (const line of next.split('\n')) {
    const r = REF.exec(line);
    if (r) {
      const before = a.m.get(r[2]);
      if (before === undefined) { out.push(`+${line}`); added++; }
      else if (before !== line) { out.push(`~${line}`); changed++; }
    } else if (line.trim()) {
      const n = (seenText.get(line) ?? 0) + 1; seenText.set(line, n);
      if (n > (a.texts.get(line) ?? 0)) { out.push(`+${line}`); added++; }
    }
  }
  const gone = [...a.m.keys()].filter((k) => !b.m.has(k));
  for (const [line, n] of a.texts) removed += Math.max(0, n - (b.texts.get(line) ?? 0));
  removed += gone.length;
  if (gone.length) {
    // summarize removed refs as ranges: e12–e15, e20
    const nums = gone.map((k) => ({ k, n: Number(k.match(/\d+$/)![0]), p: k.replace(/\d+$/, '') })).sort((x, y) => x.p.localeCompare(y.p) || x.n - y.n);
    const ranges: string[] = []; let start = nums[0], last = nums[0];
    for (const cur of nums.slice(1)) { if (cur.p === last.p && cur.n === last.n + 1) { last = cur; continue; } ranges.push(start === last ? start.k : `${start.k}–${last.k}`); start = last = cur; }
    ranges.push(start === last ? start.k : `${start.k}–${last.k}`);
    out.push(`removed: ${ranges.join(', ')}`);
  }
  const total = Math.max(1, b.m.size + [...b.texts.values()].reduce((x, y) => x + y, 0));
  const header = 'Diff from the previous observe: ~ changed, + added; removed nodes are listed by ref.';
  return { changedRatio: (added + removed + changed) / total, text: out.length ? `${header}\n${out.join('\n')}` : '', added, removed, changed };
}
