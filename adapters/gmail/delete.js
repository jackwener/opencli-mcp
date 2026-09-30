import { defineAdapter, errors } from 'opencli-mcp/adapter-sdk';
import { accountNumber, gmailFetchThread, gmailLabelOperation, gmailMessageId, gmailSyncMutation, syncThreadId } from './_shared.js';

export default defineAdapter({
  description: 'Move a Gmail thread or message to Trash, or permanently delete it, through the sync JSON API.',
  access: 'write', domain: 'mail.google.com',
  result: { kind: 'value', description: 'Confirmed Gmail deletion' },
  args: [
    { name: 'thread', type: 'string', required: true, help: 'thread ID from Gmail search' },
    { name: 'message', type: 'string', help: 'Optional message ID; defaults to every message in the thread' },
    { name: 'permanent', type: 'boolean', default: false, help: 'Also permanently delete from Trash' },
    { name: 'account', type: 'int', default: 0, min: 0, max: 20 },
  ],
  async run({ tab, args }) {
    const account = accountNumber(args.account);
    const threadId = syncThreadId(args.thread);
    const messages = await gmailFetchThread(tab, threadId, account);
    const messageIds = args.message ? [gmailMessageId(args.message)] : messages.map((row) => row.messageId);
    if (args.message && !messages.some((row) => row.messageId === messageIds[0])) throw errors.argument('message does not belong to thread');
    await gmailSyncMutation(tab, [gmailLabelOperation(threadId, messageIds, ['^k'], ['^i', '^s'])], account);
    if (!args.permanent) return { trashed: true, threadId, messageIds };
    const operations = messageIds.map((id) => [2, [threadId, [null, null, null, null, [[id]]]]]);
    await gmailSyncMutation(tab, operations, account);
    let remaining = [];
    try { remaining = await gmailFetchThread(tab, threadId, account); }
    catch (cause) { if (cause?.code !== 'empty_result') throw cause; }
    if (remaining.some((row) => messageIds.includes(row.messageId))) throw errors.upstream('Gmail did not remove every message; check Trash before retrying');
    return { deleted: true, threadId, messageIds };
  },
});
