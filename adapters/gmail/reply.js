import { defineAdapter, errors } from 'opencli-mcp/adapter-sdk';
import { accountNumber, gmailFetchThread, syncThreadId } from './_shared.js';
import { gmailCreateDraft, gmailSendDraft } from './send.js';

export default defineAdapter({
  description: 'Reply to a Gmail thread through the draft-create and send sync JSON APIs.',
  access: 'write', domain: 'mail.google.com',
  result: { kind: 'value', description: 'Confirmed Gmail reply' },
  args: [
    { name: 'thread', type: 'string', required: true, help: 'thread ID from Gmail search' },
    { name: 'from', type: 'string', required: true, help: 'Sender address for the selected Gmail account' },
    { name: 'body', type: 'string', required: true, maxLength: 200000 },
    { name: 'to', type: 'string', help: 'Override reply recipient; defaults to the latest message sender' },
    { name: 'account', type: 'int', default: 0, min: 0, max: 20 },
  ],
  async run({ tab, args }) {
    const account = accountNumber(args.account);
    const threadId = syncThreadId(args.thread);
    const messages = await gmailFetchThread(tab, threadId, account);
    const latest = messages.at(-1);
    const from = String(args.from || '').trim();
    const to = String(args.to || (latest.from?.toLowerCase() === from.toLowerCase() ? latest.to?.split(',')[0] : latest.from) || '').trim();
    if (!to) throw errors.argument('Could not infer reply recipient; pass to explicitly');
    const subject = /^re:/i.test(latest.subject) ? latest.subject : `Re: ${latest.subject}`;
    const draft = await gmailCreateDraft(tab, { from, to, subject, body: args.body, account }, threadId);
    return gmailSendDraft(tab, draft);
  },
});
