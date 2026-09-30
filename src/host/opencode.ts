/** Add one global OpenCode MCP entry while preserving JSONC comments and other settings. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setMcpEntry } from './jsonc-config.js';

type StdioCommand = { command: string; args: string[] };

export function registerOpenCode(command: StdioCommand, configHome = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config')): 'existing' | 'registered' {
  const dir = path.join(configHome, 'opencode');
  const json = path.join(dir, 'opencode.json');
  const jsonc = path.join(dir, 'opencode.jsonc');
  const file = fs.existsSync(json) ? json : fs.existsSync(jsonc) ? jsonc : json;
  const entry = { type: 'local', command: [command.command, ...command.args], enabled: true };
  return setMcpEntry(file, 'mcp', 'opencli-mcp', entry);
}
