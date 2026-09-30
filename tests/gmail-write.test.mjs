import { describe, expect, it } from 'vitest';
import send, { composeMessage } from '../adapters/gmail/send.js';
import createDraft from '../adapters/gmail/create-draft.js';
import reply from '../adapters/gmail/reply.js';
import forward from '../adapters/gmail/forward.js';
import modify from '../adapters/gmail/modify.js';
import remove from '../adapters/gmail/delete.js';
import { syncThreadId } from '../adapters/gmail/_shared.js';

const threadId = 'thread-a:r1234567890123456789';
const messageId = 'msg-a:r1234567890123456789';

function fakeTab() {
  const writes = [];
  const record = [];
  record[4] = 'Test';
  record[5] = [];
  record[5][4] = [];
  record[5][4][6] = 'Body';
  record[10] = [];
  record[10][16] = 'sender@example.com';
  record[13] = [];
  record[16] = 1_790_000_000_000;
  let query = 'in:anywhere';
  let removed = false;
  const tab = {
    writes,
    goto: async (url) => { query = decodeURIComponent(url.split('#search/')[1] || 'in:anywhere'); },
    network: {
      start: async () => true,
      read: async () => ({ cursor: 1, entries: [{
        url: 'https://mail.google.com/sync/u/0/i/bv?hl=en', method: 'POST', responseStatus: 200,
        requestBodyPreview: JSON.stringify([[79, 51, null, query]]), requestBodyTruncated: false,
        requestHeaders: {
          'Content-Type': 'application/json', 'X-Framework-Xsrf-Token': 'token',
          'X-Gmail-BTAI': 'token', 'X-Gmail-Storage-Request': 'token', 'X-Google-BTD': 'token',
        },
      }] }),
    },
    fetchJson: async (url, opts) => {
      if (url.includes('/i/fd?')) return [null, [[threadId, null, removed ? [] : [[messageId, record]]]]];
      if (url.includes('/i/s?')) {
        writes.push({ url, ...opts });
        if (opts.body[1][0].some((operation) => operation[0] === 2)) removed = true;
        return [[opts.body[1][0].map((operation) => [operation[0], 0])]];
      }
      throw new Error(`Unexpected API: ${url}`);
    },
  };
  return tab;
}

describe('Gmail write APIs', () => {
  it('accepts both Gmail thread ID families', () => {
    expect(syncThreadId(threadId)).toBe(threadId);
    expect(syncThreadId('thread-f:123')).toBe('thread-f:123');
  });

  it('creates a draft before sending and escapes the HTML payload', async () => {
    const tab = fakeTab();
    const result = await send.run({ tab, args: {
      from: 'sender@example.com', to: 'recipient@example.com', subject: 'Hi', body: '<hello> & goodbye',
    } });
    expect(result.sent).toBe(true);
    expect(tab.writes.map((write) => write.body[1][0][0][0])).toEqual([4, 6]);
    const draft = tab.writes[0].body[1][0][0];
    const sent = tab.writes[1].body[1][0][0];
    expect(draft[1][0]).toBe(sent[1][0]);
    expect(sent[1][1][13][0][7]).toBe('Hi');
    expect(sent[1][1][13][0][8][1][0][1]).toContain('&lt;hello&gt; &amp; goodbye');
    expect(composeMessage({ messageId, signature: 's:1', from: 'a@b.com', to: ['b@c.com'], subject: 'x', body: 'x', timestamp: 1, labels: [] })[0]).toBe(messageId);
  });

  it('keeps saved drafts unsent and replies in the existing thread', async () => {
    const tab = fakeTab();
    await createDraft.run({ tab, args: { from: 'sender@example.com', to: 'recipient@example.com', subject: 'Draft', body: 'Saved' } });
    expect(tab.writes.map((write) => write.body[1][0][0][0])).toEqual([4]);
    const result = await reply.run({ tab, args: { thread: threadId, from: 'me@example.com', body: 'Reply' } });
    expect(result.threadId).toBe(threadId);
    expect(result.to).toEqual(['sender@example.com']);
    expect(tab.writes.slice(1).map((write) => write.body[1][0][0][0])).toEqual([4, 6]);
  });

  it('forwards message text through the send API', async () => {
    const tab = fakeTab();
    const result = await forward.run({ tab, args: { thread: threadId, from: 'me@example.com', to: 'other@example.com', note: 'FYI' } });
    expect(result.forwardedMessageId).toBe(messageId);
    const sent = tab.writes[1].body[1][0][0][1][1][13][0];
    expect(sent[7]).toBe('Fwd: Test');
    expect(sent[8][1][0][1]).toContain('Forwarded message');
  });

  it('uses message IDs for label changes and permanent deletion', async () => {
    const tab = fakeTab();
    await modify.run({ tab, args: { thread: threadId, action: 'trash' } });
    await remove.run({ tab, args: { thread: threadId } });
    expect(tab.writes[0].body[1][0][0]).toEqual([3, [threadId, [null, null, null, null, null, null, [['^k'], ['^i', '^s'], [messageId]]]]]);
    expect(tab.writes[1].body[1][0][0]).toEqual([3, [threadId, [null, null, null, null, null, null, [['^k'], ['^i', '^s'], [messageId]]]]]);
    await remove.run({ tab, args: { thread: threadId, permanent: true } });
    expect(tab.writes.at(-1).body[1][0][0]).toEqual([2, [threadId, [null, null, null, null, [[messageId]]]]]);
  });
});
