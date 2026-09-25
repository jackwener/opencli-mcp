import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { Runtime } from '../src/runtime/runtime.js';
import { startHttpServer } from '../src/host/http.js';

describe('stdio launcher when Chrome starts later', () => {
  const cleanup: Array<() => Promise<void> | void> = [];
  afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

  it('keeps tool discovery and the same MCP connection alive until the host appears', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'opencli-late-host-'));
    cleanup.push(() => fs.rmSync(home, { recursive: true, force: true }));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', path.resolve('src/main.ts'), 'stdio'],
      env: { ...process.env, HOME: home, ELECTRON_RUN_AS_NODE: '1' },
      stderr: 'pipe',
    });
    const client = new Client({ name: 'late-host-test', version: '1' }, { capabilities: {} });
    let toolsChanged!: () => void;
    const changed = new Promise<void>((resolve) => { toolsChanged = resolve; });
    client.setNotificationHandler('notifications/tools/list_changed', async () => { toolsChanged(); });
    await client.connect(transport);
    cleanup.push(() => client.close());

    expect(client.getInstructions()).toContain('opencli-mcp');
    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain('tab_open');
    expect((await client.listResources()).resources.some((resource) => resource.uri.startsWith('opencli://docs/'))).toBe(true);
    const offlineDoctor = await client.callTool({ name: 'doctor', arguments: {} });
    expect(offlineDoctor.isError).not.toBe(true);
    const offlineData = JSON.parse((offlineDoctor.content[0] as { text: string }).text) as { data: { extension: { id: string; storeUrl: string }; manifests: Array<{ browser: string; present: boolean; launcherExists: boolean; file: string }> } };
    expect(offlineData.data.extension).toEqual({ id: expect.any(String), storeUrl: expect.stringContaining('chromewebstore.google.com') });
    const chrome = offlineData.data.manifests.find((manifest) => manifest.browser === 'chrome');
    expect(chrome).toMatchObject({ present: true, launcherExists: true });
    const launcher = JSON.parse(fs.readFileSync(chrome!.file, 'utf8')) as { path: string };
    expect(fs.readFileSync(launcher.path, 'utf8')).toContain('ELECTRON_RUN_AS_NODE=1');
    const offline = await client.callTool({ name: 'tab_open', arguments: { url: 'https://example.com' } });
    expect(offline.isError).toBe(true);
    expect(offline.content).toMatchObject([{ type: 'text', text: expect.stringContaining('host_unavailable') }]);

    const rt = new Runtime();
    await rt.init();
    const host = await startHttpServer(rt, { port: 0, token: 'late-host-token', version: 'test' });
    cleanup.push(() => host.close());
    const run = path.join(home, '.opencli-mcp', 'run');
    fs.mkdirSync(run, { recursive: true });
    fs.writeFileSync(path.join(run, 'host.json'), JSON.stringify({ pid: process.pid, host: host.host, port: host.port, token: 'late-host-token' }));

    let timeout!: NodeJS.Timeout;
    try {
      await Promise.race([changed, new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('tools/list_changed was not sent')), 5000); })]);
    } finally { clearTimeout(timeout); }
    const online = await client.callTool({ name: 'doctor', arguments: {} });
    expect(online.isError).not.toBe(true);
    expect(online.content).toMatchObject([{ type: 'text', text: expect.stringContaining('"ok":true') }]);
    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain('tab_open');
  });
});
