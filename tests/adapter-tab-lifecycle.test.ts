import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { ExtensionBridge } from '../src/host/bridge.js';
import type { NativeChannel } from '../src/host/native-messaging.js';
import { createMcpServer } from '../src/mcp/server.js';
import { Runtime } from '../src/runtime/runtime.js';
import { createAgentApi } from '../src/api/api.js';
import type { AdapterCommand } from '../src/sites/loader.js';
import type { Tab } from '../src/api/tab.js';
import { PROTOCOL_REVISION, type Command, type HostToExt } from '../src/protocol.js';

describe('adapter tab lifecycle', () => {
  it('selects a live site tab for every call and never rebinds an old Tab handle', async () => {
    const channel = new EventEmitter() as EventEmitter & { send: (message: HostToExt) => void };
    const siteTabs = new Map<number, string>();
    const browserTabs = new Map<number, string>([[201, 'https://x.com/old']]);
    let selectedBrowserTab = 201;
    let nextTabId = 100;
    let currentTabId: number | null = null;
    const commands: Command[] = [];
    channel.send = (message) => {
      if (message.type !== 'command') return;
      const cmd = message.command;
      commands.push(cmd);
      let result: { id: string; ok: boolean; data?: unknown; page?: string; error?: string; errorCode?: string };
      if (cmd.action === 'tabs' && cmd.op === 'list') {
        const browser = cmd.session?.startsWith('mcp:');
        const tabs = browser ? browserTabs : siteTabs;
        result = { id: cmd.id, ok: true, data: [...tabs].map(([id, url]) => ({ tabId: id, page: String(id), url, selected: id === (browser ? selectedBrowserTab : currentTabId), state: 'active' })) };
      } else if (cmd.action === 'tabs' && cmd.op === 'new') {
        currentTabId = ++nextTabId;
        siteTabs.set(currentTabId, 'https://x.com/home');
        result = { id: cmd.id, ok: true, page: String(currentTabId) };
      } else if (cmd.action === 'exec' && (!cmd.page || siteTabs.has(Number(cmd.page)))) {
        // An unbound adapter session creates its first tab on the first page command.
        if (!cmd.page && currentTabId === null) {
          currentTabId = ++nextTabId;
          siteTabs.set(currentTabId, 'https://x.com/home');
        }
        const page = cmd.page ?? String(currentTabId);
        result = { id: cmd.id, ok: true, page, data: siteTabs.get(Number(page)) };
      } else {
        result = { id: cmd.id, ok: false, error: `Tab ${cmd.page} is gone`, errorCode: 'stale_page' };
      }
      channel.emit('message', { type: 'result', result });
    };
    const bridge = new ExtensionBridge(channel as unknown as NativeChannel);
    const rt = new Runtime({ bridge });
    await rt.init();
    channel.emit('message', { type: 'hello', extensionVersion: 'test', protocolRevision: PROTOCOL_REVISION, features: [] });
    let firstTab: Tab | undefined;
    const command: AdapterCommand = {
      site: 'twitter', name: 'probe', description: 'Test tab selection', access: 'read', source: 'builtin', args: [],
      run: async ({ tab }) => {
        const selected = tab as Tab;
        firstTab ??= selected;
        const url = await selected.url();
        return { tab: selected.id, url };
      },
    };
    vi.spyOn(rt.registry, 'resolve').mockResolvedValue(command);
    const server = createMcpServer(rt, 'test');
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.server.connect(serverTransport);
    const client = new Client({ name: 'adapter-lifecycle-test', version: '1' }, { capabilities: {} });
    await client.connect(clientTransport);
    const call = async () => {
      const response = await client.callTool({ name: 'site_run', arguments: { site: 'twitter', command: 'probe', args: {} } });
      return JSON.parse((response.content as Array<{ text: string }>)[0].text) as { ok: boolean; value: { tab: string; url: string } };
    };
    try {
      expect(await call()).toMatchObject({ ok: true, value: { tab: '101', url: 'https://x.com/home' } });
      expect(await call()).toMatchObject({ ok: true, value: { tab: '101', url: 'https://x.com/home' } });
      siteTabs.delete(101); // Chrome closed the adapter tab between calls.
      currentTabId = null;
      expect(await call()).toMatchObject({ ok: true, value: { tab: '102', url: 'https://x.com/home' } });
      expect(commands.filter((cmd) => cmd.action === 'exec').map((cmd) => cmd.page)).toEqual([undefined, '101', undefined]);
      expect(commands.filter((cmd) => cmd.action === 'tabs' && cmd.op === 'new')).toHaveLength(0);
      await expect(firstTab!.url()).rejects.toMatchObject({ code: 'stale_page' });
      const browser = createAgentApi(rt, 'test').agent.browser;
      expect((await browser.tabs.selected())?.id).toBe('201');
      browserTabs.delete(201);
      browserTabs.set(202, 'https://x.com/new');
      selectedBrowserTab = 202;
      expect((await browser.tabs.selected())?.id).toBe('202');
    } finally {
      await client.close();
      await server.close();
      await rt.shutdown();
    }
  });
});
