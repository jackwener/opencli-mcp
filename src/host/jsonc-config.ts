/** Preserve user-owned JSONC settings when configuring one MCP server. */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { applyEdits, modify, parse, type ParseError } from 'jsonc-parser';

export function setMcpEntry(file: string, section: string, name: string, entry: object): 'existing' | 'registered' {
  const original = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '{}\n';
  const errors: ParseError[] = [];
  const config: unknown = parse(original, errors, { allowTrailingComma: true });
  if (errors.length || !config || typeof config !== 'object' || Array.isArray(config)) throw new Error(`Cannot read MCP config: ${file}`);
  const mcp = (config as Record<string, unknown>)[section];
  if (mcp !== undefined && (!mcp || typeof mcp !== 'object' || Array.isArray(mcp))) throw new Error(`Invalid ${section} section in MCP config: ${file}`);
  if (mcp && JSON.stringify((mcp as Record<string, unknown>)[name]) === JSON.stringify(entry)) return 'existing';

  const edits = modify(original, [section, name], entry, { formattingOptions: { insertSpaces: true, tabSize: 2, eol: '\n' } });
  const updated = applyEdits(original, edits);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.opencli-mcp-${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, updated, { mode: fs.existsSync(file) ? fs.statSync(file).mode & 0o777 : 0o600 });
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
  return 'registered';
}
