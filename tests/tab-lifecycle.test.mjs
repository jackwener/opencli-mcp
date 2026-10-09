import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionManager } from '../extension/src/sessions.js';

vi.mock('../extension/src/cdp.js', () => ({ ensureAttached: vi.fn(async () => {}), detach: vi.fn(async () => {}) }));

const event = () => ({ addListener: vi.fn(), removeListener: vi.fn() });

function chromeMock() {
  const tabs = {
    onRemoved: event(), onActivated: event(), onUpdated: event(),
    get: vi.fn(async (tabId) => ({ id: tabId, url: 'https://example.com/', windowId: 1 })),
    remove: vi.fn(async (_tabId) => {}),
    ungroup: vi.fn(async (_tabId) => {}),
    update: vi.fn(async (_tabId, _change) => {}),
    query: vi.fn(async () => []),
    create: vi.fn(),
    group: vi.fn(async () => 10),
  };
  vi.stubGlobal('chrome', {
    tabs,
    storage: { session: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) } },
    windows: { onFocusChanged: event(), onRemoved: event() },
    runtime: { onMessage: event() },
    tabGroups: { onRemoved: event(), update: vi.fn(async () => {}) },
    webNavigation: { onCreatedNavigationTarget: event(), onErrorOccurred: event() },
  });
  return tabs;
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('browser tab ownership', () => {
  it('finalizes only its own agent tabs and preserves user tabs and deliverables', async () => {
    const tabs = chromeMock();
    const manager = new SessionManager(() => {});
    await manager.ready();
    const session = manager.get('test');
    await manager.claimUserTab(session, { tabId: 1 });
    await manager.adoptCreatedTab(session, { id: 2, windowId: 1 });
    await manager.adoptCreatedTab(session, { id: 3, windowId: 1 });
    const other = manager.get('other');
    await manager.adoptCreatedTab(other, { id: 4, windowId: 1 });

    expect(await manager.finalize(session, [{ page: '3', status: 'deliverable' }])).toEqual({
      closed: ['2'], kept: ['1', '3'], failed: [],
    });
    expect(tabs.remove.mock.calls).toEqual([[2]]);
    expect(session.leases.size).toBe(0);
    expect(await manager.resolveTab(other, '4')).toBe(4);
  });
});
