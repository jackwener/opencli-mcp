import type { Command, StreamBatch, StreamOptions, StreamReadOptions } from '../protocol.js';
import type { SessionContext } from './context.js';
import { ActionError } from './errors.js';

export interface EventStream {
  /** Reads after the handle's last read, or an explicit cursor. Filtering still advances the cursor. */
  read(options?: StreamReadOptions): Promise<StreamBatch>;
  /** Idempotently releases this subscription. */
  close(): Promise<void>;
}

export async function browserCommand(ctx: SessionContext, feature: import('../protocol.js').BrowserFeature, action: Command['action'], params: Partial<Command> = {}): Promise<unknown> {
  if (!ctx.rt.hasFeature(feature)) throw new ActionError('capability_unavailable', `${feature} is not advertised by the connected extension`, 'Update the extension for this capability; existing browser operations remain available.');
  // Create only the session transport object, never a tab or debugger attachment.
  if (!params.session) await ctx.rt.getBrowserPage(ctx.sessionId);
  if (action === 'stream-watch' || (action === 'chrome-call' && ['tabs.create', 'tabs.duplicate', 'windows.create'].includes(params.chromeMethod ?? ''))) ctx.state.finalized = false;
  return (await ctx.rt.bridge!.send(action, { session: `mcp:${ctx.sessionId}`, surface: 'browser', ...params })).data;
}

export async function watch(ctx: SessionContext, source: 'chrome' | 'cdp' | 'console' | 'extension', event?: string, options?: StreamOptions, page?: string, route?: { session: string; surface: 'browser' | 'adapter' }): Promise<EventStream> {
  const descriptor = await browserCommand(ctx, 'streams', 'stream-watch', { ...route, streamSource: source, eventName: event, streamOptions: options, page }) as { id: string; cursor: string };
  // A newly registered subscription includes events received while attachment completed.
  let cursor: string | undefined;
  let closed = false;
  return {
    read: async (opts = {}) => {
      if (closed) throw new ActionError('stream_closed', 'This subscription was closed. Create a new watch.');
      const batch = await browserCommand(ctx, 'streams', 'stream-read', { ...route, streamId: descriptor.id, streamRead: { ...opts, cursor: opts.cursor ?? cursor } }) as StreamBatch;
      cursor = batch.cursor;
      return batch;
    },
    close: async () => {
      if (closed) return;
      await browserCommand(ctx, 'streams', 'stream-close', { ...route, streamId: descriptor.id });
      closed = true;
    },
  };
}
