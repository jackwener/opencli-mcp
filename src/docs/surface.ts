/** Runtime capability catalog shared by browser discovery and model-facing API projection. */
import type { BrowserFeature } from '../protocol.js';

export const BROWSER_CAPABILITIES: Array<{ id: BrowserFeature; description: string; doc?: string }> = [
  { id: 'cdp', description: 'Allowlisted Chrome DevTools Protocol on the current tab.', doc: 'capabilities/cdp' },
  { id: 'viewport', description: 'Temporarily override and reset viewport dimensions.' },
  { id: 'visibility', description: 'Show or hide the session window.', doc: 'capabilities/visibility' },
  { id: 'webmcp', description: 'Tools registered by the current page.', doc: 'capabilities/webmcp' },
];

export const TAB_FEATURES: Record<string, BrowserFeature> = {
  webmcp: 'webmcp', dialog: 'dialogs', console: 'console', network: 'network', frames: 'frames', download: 'downloads',
};

/** Keep generated source documentation complete on disk; project only available members for an MCP client. */
export function projectApiReference(source: string, features: readonly BrowserFeature[]): string {
  const available = new Set(features);
  const lines: string[] = [];
  let inTab = false;
  let skippingObject = false;
  for (const line of source.split('\n')) {
    if (line === 'class Tab {') inTab = true;
    if (inTab && line === '}') inTab = false;
    if (skippingObject) {
      if (line === '  };') skippingObject = false;
      continue;
    }
    if (inTab) {
      const member = /^  (\w+)(?:\(|:)/.exec(line)?.[1];
      const feature = member && TAB_FEATURES[member];
      if (feature && !available.has(feature)) {
        if (line.includes(': {')) skippingObject = true;
        continue;
      }
    }
    lines.push(line);
  }
  const banner = `Available extension features now: ${features.length ? features.join(', ') : 'none (browser disconnected or not advertised)'}. Optional Tab members absent below are unavailable.`;
  return lines.join('\n').replace('```ts\n', `${banner}\n\n\`\`\`ts\n`);
}

/** Slice the generated reference and include the value types needed by that member. */
export function selectApiReference(source: string, member: string): string | null {
  const code = source.split('```ts\n')[1]?.split('```')[0];
  if (!code) return null;
  const declarations = new Map<string, string>();
  const starts = [...code.matchAll(/^(?:class|interface|type) (\w+)\b/gm)];
  for (const [i, match] of starts.entries()) declarations.set(match[1], code.slice(match.index, starts[i + 1]?.index ?? code.length).trim());
  const [name, method, ...rest] = member.split('.');
  if (rest.length) return null;
  let selected = declarations.get(name);
  if (!selected) return null;
  if (method) {
    const lines = selected.split('\n');
    const start = lines.findIndex(line => /^  (\w+)\??(?:\(|:)/.exec(line)?.[1] === method);
    if (start < 0) return null;
    let end = start + 1;
    // Keep adjacent overloads together; a focused read reference must show both element and document reads.
    while (end < lines.length && /^  (\w+)\(/.exec(lines[end])?.[1] === method) end++;
    if (/\{\s*(?:\/\/.*)?$/.test(lines[start])) { while (end < lines.length && lines[end] !== '  };') end++; end++; }
    selected = `${lines[0]}\n${lines.slice(start, end).join('\n')}\n}`;
  }
  const included = new Set([name]);
  const sections = [selected];
  for (const section of sections) for (const token of section.match(/\b[A-Z]\w*\b/g) ?? []) {
    if (included.has(token) || ['Tab', 'Browser', 'AgentApi'].includes(token)) continue;
    const declaration = declarations.get(token);
    if (declaration) { included.add(token); sections.push(declaration); }
  }
  return `## API reference: ${member}\n\n${source.match(/^Available extension features now:.*$/m)?.[0] ?? ''}\n\n\`\`\`ts\n${sections.join('\n\n')}\n\`\`\`\n\nFor returned object handles, request their class or member (for example Tab.observe).`;
}
