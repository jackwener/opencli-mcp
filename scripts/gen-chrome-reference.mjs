// Build compact, on-demand signatures from the lockfile-pinned Chrome declarations.
import ts from 'typescript';
import { readFileSync, writeFileSync } from 'node:fs';
const file = 'node_modules/@types/chrome/index.d.ts';
const program = ts.createProgram([file], { skipLibCheck: true });
const checker = program.getTypeChecker();
const sf = program.getSourceFile(file);
const chromeNode = sf.statements.find(n => ts.isModuleDeclaration(n) && n.name.text === 'chrome');
const root = checker.getSymbolAtLocation(chromeNode.name);
const namespaces = ['debugger', 'tabs', 'windows', 'tabGroups', 'downloads', 'cookies', 'bookmarks', 'history', 'sessions', 'runtime', 'permissions', 'webNavigation', 'scripting', 'storage.local', 'storage.session', 'storage.sync'];
const catalog = {};
for (const path of namespaces) {
  let symbol = root;
  for (const part of path.split('.')) {
    const type = checker.getTypeOfSymbolAtLocation(symbol, symbol.valueDeclaration ?? symbol.declarations[0]);
    symbol = type.getProperty(part);
    if (!symbol) break;
  }
  if (!symbol) continue;
  const type = checker.getTypeOfSymbolAtLocation(symbol, symbol.valueDeclaration ?? symbol.declarations[0]);
  for (const member of type.getProperties()) {
    const decl = member.valueDeclaration ?? member.declarations[0];
    const mt = checker.getTypeOfSymbolAtLocation(member, decl);
    const sigs = mt.getCallSignatures();
    if (!sigs.length) continue;
    const direct = sigs.filter(s => !s.getParameters().some(p => p.name === 'callback'));
    const chosen = direct.length ? direct : sigs;
    const signatures = chosen.map(s => checker.signatureToString(s, decl, ts.TypeFormatFlags.NoTruncation));
    const parameters = {};
    for (const sig of chosen) for (const param of sig.getParameters()) {
      const pd = param.valueDeclaration;
      if (!pd || param.name === 'callback') continue;
      const pt = checker.getTypeOfSymbolAtLocation(param, pd);
      const fields = pt.getProperties().filter(p => !p.name.startsWith('__'));
      if (fields.length && !(pt.flags & ts.TypeFlags.StringLike) && !checker.isArrayType(pt)) {
        parameters[param.name] = Object.fromEntries(fields.slice(0, 60).map(p => {
          const d = p.valueDeclaration ?? p.declarations?.[0] ?? pd;
          return [p.name + (p.flags & ts.SymbolFlags.Optional ? '?' : ''), checker.typeToString(checker.getTypeOfSymbolAtLocation(p, d), d, ts.TypeFormatFlags.NoTruncation)];
        }));
      }
    }
    catalog[`${path}.${member.name}`] = { signatures, ...(Object.keys(parameters).length && { parameters }), callback: !direct.length,
      documentation: `https://developer.chrome.com/docs/extensions/reference/api/${path.split('.')[0]}#method-${member.name}` };
  }
}
const version = JSON.parse(readFileSync('node_modules/@types/chrome/package.json', 'utf8')).version;
writeFileSync('extension/chrome-reference.LICENSE.txt', readFileSync('node_modules/@types/chrome/LICENSE'));
writeFileSync('src/shared/chrome-reference.json', JSON.stringify({ source: `@types/chrome@${version}`, methods: catalog }, null, 2) + '\n');
console.log(`Chrome reference: ${Object.keys(catalog).length} methods`);
