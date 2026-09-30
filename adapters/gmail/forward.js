import { defineAdapter, errors } from 'opencli-mcp/adapter-sdk';
import { accountNumber, gmailFetchThread, gmailMessageId, syncThreadId } from './_shared.js';
import { gmailCreateDraft, gmailSendDraft } from './send.js';

export default defineAdapter({
  description: 'Forward the text of a Gmail message through the draft-create and send sync JSON APIs. Attachments are listed but not copied.',
  access: 'write', domain: 'mail.google.com',
  result: { kind: 'value', description: 'Confirmed Gmail forward' },
  args: [
    { name: 'thread', type: 'string', required: true, help: 'thread ID from Gmail search' },
    { name: 'message', type: 'string', help: 'Message ID to forward; defaults to the latest message' },
    { name: 'from', type: 'string', required: true, help: 'Sender address for the selected Gmail account' },
    { name: 'to', type: 'string', required: true, help: 'Forward recipient' },
    { name: 'note', type: 'string', maxLength: 20000, help: 'Optional note before the forwarded text' },
    { name: 'account', type: 'int', default: 0, min: 0, max: 20 },
  ],
  async run({ tab, args }) {
    const account = accountNumber(args.account);
    const threadId = syncThreadId(args.thread);
    const messages = await gmailFetchThread(tab, threadId, account);
    const message = args.message ? messages.find((row) => row.messageId === gmailMessageId(args.message)) : messages.at(-1);
    if (!message) throw errors.argument('message does not belong to thread');
    const subject = /^fwd:/i.test(message.subject) ? message.subject : `Fwd: ${message.subject}`;
    const note = String(args.note || '').trim();
    const attachmentNote = message.attachments.length ? `\nAttachments in original: ${message.attachments.map((item) => item.name || item.attachmentId).join(', ')}` : '';
    const body = `${note ? `${note}\n\n` : ''}---------- Forwarded message ---------\nFrom: ${message.from || ''}\nDate: ${message.date}\nSubject: ${message.subject}\nTo: ${message.to || ''}\n\n${message.body || ''}${attachmentNote}`;
    const draft = await gmailCreateDraft(tab, { from: args.from, to: args.to, subject, body, account });
    return { ...await gmailSendDraft(tab, draft), forwardedMessageId: message.messageId, attachmentsCopied: false };
  },
});
