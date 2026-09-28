// Generate docs/api-reference.md from the TypeScript declarations of the object model (src/api/agent.ts).
// The model-facing API reference is a projection of the code, never a hand-maintained copy (hand-written copies drift).
import ts from 'typescript';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const entries = ['src/api/api.ts', 'src/api/browser.ts', 'src/api/tab.ts', 'src/backends/extension-page.ts', 'src/shared/page-contract.ts', 'src/protocol.ts', 'src/sites/define.ts', 'src/sites/drafts.ts', 'src/sites/executor.ts', 'src/recon/discover.ts', 'src/recon/analyzer.ts', 'adapter-sdk/index.d.ts'].map((f) => resolve(root, f));
const program = ts.createProgram(entries, {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
  strict: true, exactOptionalPropertyTypes: true, skipLibCheck: true, noEmit: true, lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
});
const checker = program.getTypeChecker();
const FLAGS = ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope | ts.TypeFormatFlags.WriteArrayAsGenericType;

const doc = (sym) => { const parts = sym?.getDocumentationComment?.(checker) ?? []; return ts.displayPartsToString(parts).replace(/\s+/g, ' ').trim(); };
let sf; // current source file while scanning
const fmtType = (t) => checker.typeToString(t, undefined, FLAGS);
const sigText = (sig) => {
  const params = sig.getParameters().map((p) => {
    const d = p.valueDeclaration; const optional = d && ts.isParameter(d) && (d.questionToken || d.initializer) ? '?' : '';
    const t = fmtType(checker.getTypeOfSymbolAtLocation(p, d ?? sf));
    return `${p.getName()}${optional}: ${optional ? t.replace(/ \| undefined$/, '') : t}`;
  });
  return `(${params.join(', ')}): ${fmtType(sig.getReturnType())}`;
};
/** One member line: methods as signatures, object-valued properties expanded one level, everything else as a type. */
function memberLines(type, indent, depth) {
  const out = [];
  for (const m of checker.getPropertiesOfType(type)) {
    const name = m.getName();
    if (name.startsWith('_') || ['constructor', 'use', 'toJSON'].includes(name)) continue; // runtime plumbing is not model surface
    const decl = m.valueDeclaration ?? m.declarations?.[0];
    if (decl && ts.canHaveModifiers(decl) && ts.getModifiers(decl)?.some((x) => x.kind === ts.SyntaxKind.PrivateKeyword)) continue;
    const t = checker.getTypeOfSymbolAtLocation(m, decl ?? sf);
    const sigs = t.getCallSignatures();
    const comment = doc(m);
    if (sigs.length) { for (const s of sigs) out.push(`${indent}${name}${sigText(s)};${comment ? ` // ${comment}` : ''}`); continue; }
    const props = checker.getPropertiesOfType(t);
    const isObj = props.length && !t.isUnion() && (t.flags & ts.TypeFlags.Object) && !(t.symbol?.name === 'Promise') && !(t.symbol?.name === 'Map') && !(t.symbol?.name === 'Set') && depth < 2 && !['string', 'number', 'boolean'].includes(fmtType(t));
    if (isObj && props.some((p) => checker.getTypeOfSymbolAtLocation(p, p.valueDeclaration ?? sf).getCallSignatures().length)) {
      out.push(`${indent}${name}: {${comment ? ` // ${comment}` : ''}`);
      out.push(...memberLines(t, indent + '  ', depth + 1));
      out.push(`${indent}};`);
    } else { const opt = m.flags & ts.SymbolFlags.Optional; out.push(`${indent}${name}${opt ? '?' : ''}: ${opt ? fmtType(t).replace(/ \| undefined$/, '') : fmtType(t)};${comment ? ` // ${comment}` : ''}`); }
  }
  return out;
}
const sections = [];
const wanted = new Map([['AgentApi', 'interface'], ['Browser', 'class'], ['Tab', 'class']]);
const aliases = ['Target', 'ActAction', 'ActOptions', 'ActionOutcome', 'ObserveOptions', 'ObserveResult', 'ObservedContent', 'ObservedFrame', 'DomSnapshot', 'DomEntry', 'FrameOwner', 'ElementDetails', 'ReadElementOptions', 'ReadOptions', 'ImageValue', 'Box', 'FindEntry', 'FindResult', 'QueryFindResult', 'ElementAtResult', 'ReadTextResult', 'Expectation', 'CheckResult', 'FrameStep', 'DialogInfo', 'ConsoleEntry', 'UserTabInfo', 'CloseUserTabsResult', 'DownloadWaitResult', 'ToolDefinition', 'DraftExpectation', 'Arg', 'ArgValue', 'CommandRunResult', 'CommandRunError', 'DiscoverResult', 'EndpointCandidate', 'UrlMatch'];
for (const entry of entries) { sf = program.getSourceFile(entry); ts.forEachChild(sf, (node) => {
  if ((ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)) && node.name && wanted.has(node.name.text) && !entry.endsWith('adapter-sdk/index.d.ts')) {
    const sym = checker.getSymbolAtLocation(node.name);
    const type = ts.isClassDeclaration(node) ? checker.getDeclaredTypeOfSymbol(sym) : checker.getTypeAtLocation(node);
    const head = doc(sym);
    sections.push(`${head ? `// ${head}\n` : ''}${wanted.get(node.name.text)} ${node.name.text} {\n${memberLines(type, '  ', 0).join('\n')}\n}`);
  }
  if ((ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) && aliases.includes(node.name.text)) {
    sections.push(node.getText(sf).replace(/\s*\/\*\*[^*]*\*\/\s*/g, ' ').replace(/\n\s+/g, '\n  '));
  }
}); }
// keep a stable order: the entry object first, then Browser, Tab, then the value types
const order = ['interface AgentApi', 'class Browser', 'class Tab', 'type Target', 'type FrameStep', 'type ActAction', 'interface ActOptions', 'interface ActionOutcome', 'interface ObserveOptions', 'interface ReadOptions', 'interface ImageValue', 'interface Box', 'interface FindEntry', 'interface FindResult', 'interface QueryFindResult', 'interface ElementAtResult', 'interface ReadTextResult', 'interface Expectation', 'interface CheckResult', 'interface DialogInfo', 'interface ConsoleEntry', 'interface UserTabInfo', 'interface CloseUserTabsResult', 'interface DownloadWaitResult'];
const key = (s) => s.replace(/^\/\/.*\n/, '').replace(/^export /, '');
const rank = s => { const i = order.findIndex(k => key(s).startsWith(k)); return i < 0 ? order.length : i; };
sections.sort((a, b) => rank(a) - rank(b));
// `?` already says undefined for parameters (also inside type-literal method signatures); real `T | undefined` results and properties stay
const clean = (s) => s.replace(/^export /gm, '').replace(/ \| undefined(?=[,)])/g, '');
const md = `## API reference (generated from the public TypeScript declarations — do not edit)

In \`js\` the globals are \`browser\`, \`agent\`, \`sites\`, \`recon\`, \`tools\`, \`session\` and \`nodeRepl\`. Await API methods; returned Tab and Browser handles persist across calls. Use docs_get with name:"api-reference" and member:"Tab.act" (or another class/member) for a focused reference. Site adapter definitions are documented in \`define-tools\`.

\`\`\`ts
${sections.map(clean).join('\n\n')}
\`\`\`
`;
writeFileSync(resolve(root, 'docs/api-reference.md'), md);
console.log(`api reference → docs/api-reference.md (${md.length} chars, ${sections.length} declarations)`);
