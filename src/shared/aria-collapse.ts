import { ARIA_REF_LINE } from './element-ref.js';

/** Character budget for the action map returned to the model. The cached tree used for diff stays whole. */
export const ARIA_BUDGET = 24_000;
export const COLLAPSE_NOTE = 'Collapsed branches keep their [ref]. Observe again with that ref and the same frame path to open one branch. This tree is the action map; read the document with tab.read().';

function lineIndent(line: string): number { return line.length - line.trimStart().length; }

/** The line that carries an element ref plus the deeper lines under it. */
export function subtreeByRef(text: string, ref: string): string | null {
  const lines = text.split('\n');
  const i = lines.findIndex((l) => ARIA_REF_LINE.exec(l)?.[2] === ref);
  if (i < 0) return null;
  const base = lineIndent(lines[i]);
  let end = i;
  for (let j = i + 1; j < lines.length; j++) {
    if (lineIndent(lines[j]) <= base) break;
    end = j;
  }
  return lines.slice(i, end + 1).join('\n');
}

/** Drop the children of the largest ref'd branch until the tree fits. The ref stays, marked `(collapsed)`. */
export function collapseAria(text: string, budget: number): { text: string; collapsed: boolean } {
  let lines = text.split('\n').filter((l) => l !== COLLAPSE_NOTE);
  let collapsed = false;
  const size = () => lines.join('\n').length;
  while (size() > budget) {
    let best: { i: number; end: number; gain: number } | null = null;
    for (let i = 0; i < lines.length; i++) {
      if (!ARIA_REF_LINE.test(lines[i]) || lines[i].includes('(collapsed)')) continue;
      const base = lineIndent(lines[i]);
      let end = i;
      for (let j = i + 1; j < lines.length; j++) {
        if (lineIndent(lines[j]) <= base) break;
        end = j;
      }
      if (end === i) continue;
      const gain = lines.slice(i + 1, end + 1).join('\n').length;
      if (!best || gain > best.gain) best = { i, end, gain };
    }
    if (!best || best.gain <= 0) break;
    const line = `${lines[best.i]} (collapsed)`;
    lines = [...lines.slice(0, best.i), line, ...lines.slice(best.end + 1)];
    collapsed = true;
  }
  if (collapsed) lines.push(COLLAPSE_NOTE);
  return { text: lines.join('\n'), collapsed };
}
