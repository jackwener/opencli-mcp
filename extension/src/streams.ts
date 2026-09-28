import type { StreamBatch, StreamOptions, StreamReadOptions } from '../../src/protocol.js';
import { extensionLogs } from './logs';
import { EventBuffer } from './event-buffer';
import { chromeMember } from './chrome-api';
import { ensureAttached, subscribeConsole } from './cdp';

interface Subscription { session: string; buffer: EventBuffer; dispose: () => void; tabId?: number; reason?: string }
const subscriptions = new Map<string, Subscription>();
const fail = (code: string, message: string) => Object.assign(new Error(message), { code });

export async function watchStream(session: string, source: 'chrome' | 'cdp' | 'console' | 'extension', event: string | undefined, options: StreamOptions = {}, tabId?: number): Promise<{ id: string; cursor: string }> {
  const capacity = options.capacity ?? 500;
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 2000) throw fail('invalid_args', 'capacity must be an integer from 1 to 2000');
  if ([...subscriptions.values()].filter(s => s.session === session).length >= 64) throw fail('stream_limit', 'Close unused streams before opening more (64 per session)');
  const buffer = new EventBuffer(capacity);
  let dispose: () => void;
  if (source === 'extension') {
    dispose = extensionLogs.subscribe(entry => buffer.push(entry));
  } else if (source === 'chrome') {
    if (!event || /(?:onMessage|onConnect|onAuthRequired|onDeterminingFilename)(?:External|Native)?$/.test(event) || event.startsWith('debugger.')) {
      throw fail('unsupported_event', 'Use a notification event; response callbacks, Ports and debugger events need their dedicated APIs');
    }
    if ((options.args ?? []).some(arg => Array.isArray(arg) && arg.some(v => v === 'blocking' || v === 'asyncBlocking'))) throw fail('unsupported_event', 'Synchronous/async blocking event responses are not supported');
    const { value } = chromeMember(event);
    if (typeof value?.addListener !== 'function') throw fail('chrome_api_unavailable', `chrome.${event} is not an available event`);
    const listener = (...args: unknown[]) => buffer.push({ event, args });
    value.addListener(listener, ...(options.args ?? []));
    dispose = () => value.removeListener(listener);
  } else {
    if (tabId === undefined) throw fail('invalid_args', 'Page subscriptions require an explicit Tab');
    if (source === 'console') dispose = subscribeConsole(tabId, entry => buffer.push(entry));
    else {
      if (!event || !/^[A-Za-z]+\.[A-Za-z]+$/.test(event)) throw fail('invalid_args', 'Use a CDP event such as Network.requestWillBeSent');
      const listener = (target: chrome.debugger.Debuggee, method: string, params?: object) => {
        // Root target only. Child target routing must be explicit, never silently mixed.
        if (target.tabId === tabId && !(target as { sessionId?: string }).sessionId && method === event) buffer.push({ event, params });
      };
      chrome.debugger.onEvent.addListener(listener);
      dispose = () => chrome.debugger.onEvent.removeListener(listener);
    }
    try { await ensureAttached(tabId, true); } catch (error) { dispose(); throw error; }
  }
  const id = crypto.randomUUID();
  subscriptions.set(id, { session, buffer, dispose, tabId });
  return { id, cursor: buffer.cursor() };
}
export function readStream(session: string, id: string, options: StreamReadOptions = {}): StreamBatch {
  const stream = subscriptions.get(id);
  if (!stream) return { entries: [], cursor: options.cursor ?? '', hasMore: false, dropped: 0, reset: true, closed: true, reason: 'Subscription no longer exists (reset, finalize or extension restart). Create a new watch.' };
  if (stream.session !== session) throw fail('stream_not_in_session', 'This subscription belongs to another session');
  return { ...stream.buffer.read(options), ...(stream.reason && { closed: true, reason: stream.reason }) };
}
export function closeStream(session: string, id: string): void {
  const stream = subscriptions.get(id);
  if (!stream) return;
  if (stream.session !== session) throw fail('stream_not_in_session', 'This subscription belongs to another session');
  stream.dispose(); subscriptions.delete(id);
}
export function closeSessionStreams(session: string): void {
  for (const [id, stream] of subscriptions) if (stream.session === session) closeStream(session, id);
}
export function endTabStreams(tabId: number, reason: string): void {
  for (const stream of subscriptions.values()) if (stream.tabId === tabId && !stream.reason) {
    stream.dispose(); stream.reason = reason;
  }
}
