import { defineAdapter, errors } from 'opencli-mcp/adapter-sdk';
import { accountNumber, gmailFetchThread, gmailLabelOperation, gmailSyncMutation, gmailMessageId, syncThreadId } from './_shared.js';

const ACTIONS = {
  read: [[], ['^u', '^us']],
  unread: [['^u'], []],
  star: [['^t'], []],
  unstar: [[], ['^t']],
  archive: [[], ['^i']],
  inbox: [['^i'], []],
  trash: [['^k'], ['^i', '^s']],
  restore: [['^i'], ['^k']],
  spam: [['^s'], ['^i']],
  not_spam: [['^i'], ['^s']],
};

export default defineAdapter({
  description: 'Change Gmail message state through the sync JSON API: read, unread, star, unstar, archive, inbox, trash, restore, spam, not_spam, add_label, or remove_label.',
  access: 'write', domain: 'mail.google.com',
  result: { kind: 'value', description: 'Confirmed Gmail sync operation' },
  args: [
    { name: 'thread', type: 'string', required: true, help: 'thread ID from Gmail search' },
    { name: 'action', type: 'string', required: true, choices: [...Object.keys(ACTIONS), 'add_label', 'remove_label'] },
    { name: 'message', type: 'string', help: 'Optional message ID; defaults to every message in the thread' },
    { name: 'label_id', type: 'string', help: 'User label ID (^x_...) for add_label or remove_label' },
    { name: 'account', type: 'int', default: 0, min: 0, max: 20 },
  ],
  async run({ tab, args }) {
    const account = accountNumber(args.account);
    const threadId = syncThreadId(args.thread);
    const messages = await gmailFetchThread(tab, threadId, account);
    const messageIds = args.message ? [gmailMessageId(args.message)] : messages.map((row) => row.messageId);
    if (args.message && !messages.some((row) => row.messageId === messageIds[0])) throw errors.argument('message does not belong to thread');
    let labels = ACTIONS[args.action];
    if (args.action === 'add_label' || args.action === 'remove_label') {
      const label = String(args.label_id || '').trim();
      if (!/^\^x_[\w-]+$/.test(label)) throw errors.argument('label_id must be a Gmail user label ID (^x_...)');
      labels = args.action === 'add_label' ? [[label], []] : [[], [label]];
    }
    if (!labels) throw errors.argument('Unknown Gmail action');
    await gmailSyncMutation(tab, [gmailLabelOperation(threadId, messageIds, ...labels)], account);
    return { confirmed: true, action: args.action, threadId, messageIds };
  },
});
