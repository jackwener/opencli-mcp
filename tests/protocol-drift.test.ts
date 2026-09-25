import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { ExtensionBridge, BrowserCommandError } from '../src/host/bridge.js';
import type { NativeChannel } from '../src/host/native-messaging.js';
import { Runtime } from '../src/runtime/runtime.js';
import { createAgentApi } from '../src/api/api.js';
import { PROTOCOL_REVISION, type HostToExt } from '../src/protocol.js';

describe('extension protocol drift', () => {
  it('keeps core commands available and warns about unsupported actions', async () => {
    const channel = new EventEmitter() as EventEmitter & { send: (message: HostToExt) => void };
    channel.send = (message) => {
      if (message.type !== 'command') return;
      const { id, action } = message.command;
      channel.emit('message', action === 'tabs'
        ? { type: 'result', result: { id, ok: true, data: [] } }
        : { type: 'result', result: { id, ok: false, error: `Unknown action: ${action}`, errorCode: 'unknown_action' } });
    };
    const bridge = new ExtensionBridge(channel as unknown as NativeChannel);
    const rt = new Runtime({ bridge });
    channel.emit('message', { type: 'hello', extensionVersion: 'old', protocolRevision: PROTOCOL_REVISION - 1, features: ['cdp'] });

    expect(rt.backend()).toBe('extension');
    expect(rt.features()).toEqual(['cdp']);
    expect(rt.doctor().extension).toMatchObject({ connected: true, protocolMatches: false, protocolWarning: expect.stringContaining('Browser commands remain available') });
    const browser = await createAgentApi(rt, 'test').agent.browsers.getDefault();
    expect(await browser.tabs.list()).toEqual([]);
    expect((await browser.capabilities.list()).map((item) => item.id)).toEqual(['cdp']);
    await expect(bridge.send('history')).rejects.toMatchObject({ code: 'unknown_action', hint: expect.stringContaining('update the host or extension') } satisfies Partial<BrowserCommandError>);

    channel.emit('message', { type: 'hello', extensionVersion: 'older' });
    expect(rt.backend()).toBe('extension');
    expect(rt.features()).toEqual([]);
    expect(rt.doctor().extension.protocolWarning).toContain('unknown');
  });
});
