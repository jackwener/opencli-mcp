import { describe, expect, it, vi } from 'vitest';
import { BrowserCommandError, type ExtensionBridge } from '../src/host/bridge.js';
import { createExtensionPage } from '../src/backends/extension-page.js';

describe('adapter tab recovery', () => {
  it('lets the session resolve a replacement tab without replaying a failed command', async () => {
    const send = vi.fn(async (_action: string, params: { page?: string }) => {
      expect(params.page).toBeUndefined();
      return { data: 'ok', page: send.mock.calls.length === 1 ? 'old-target' : 'new-target' };
    });
    const page = await createExtensionPage({ send } as unknown as ExtensionBridge, { session: 'site:twitter', surface: 'adapter' });
    expect(await page.evaluate('1')).toBe('ok');
    expect(page.getActivePage()).toBe('old-target');
    expect(await page.evaluate('2')).toBe('ok');
    expect(page.getActivePage()).toBe('new-target');
    expect(send).toHaveBeenCalledTimes(2);

    send.mockRejectedValueOnce(new BrowserCommandError('stale page identity', 'stale_page'));
    await expect(page.evaluate('3')).rejects.toMatchObject({ code: 'stale_page' });
    expect(send).toHaveBeenCalledTimes(3);
    send.mockResolvedValueOnce({ data: 'ok', page: 'new-target' });
    await page.closeTab();
    expect(send.mock.calls[3]?.[1]).not.toHaveProperty('page');
  });

  it('keeps an explicitly bound browser tab pinned to its original target', async () => {
    const send = vi.fn(async (_action: string, params: { page?: string }) => {
      expect(params.page).toBe('fixed-target');
      throw new BrowserCommandError('stale page identity', 'stale_page');
    });
    const page = await createExtensionPage({ send } as unknown as ExtensionBridge, { session: 'mcp:one', surface: 'browser', page: 'fixed-target' });
    await expect(page.evaluate('1')).rejects.toMatchObject({ code: 'stale_page' });
    expect(send).toHaveBeenCalledTimes(1);
  });
});
