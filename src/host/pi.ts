/** Configure pi-mcp-adapter in Pi's own global MCP config. */
import os from 'node:os';
import path from 'node:path';
import { setMcpEntry } from './jsonc-config.js';

type StdioCommand = { command: string; args: string[] };

export function registerPi(command: StdioCommand, agentDir = process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), '.pi', 'agent')): 'existing' | 'registered' {
  const expanded = agentDir === '~' ? os.homedir() : agentDir.startsWith('~/') ? path.join(os.homedir(), agentDir.slice(2)) : agentDir;
  const file = path.join(path.resolve(expanded), 'mcp.json');
  const entry = { command: command.command, args: [...command.args], protocolVersion: 'auto' };
  return setMcpEntry(file, 'mcpServers', 'opencli-mcp', entry);
}
