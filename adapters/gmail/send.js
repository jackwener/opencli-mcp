import { defineAdapter, errors } from 'opencli-mcp/adapter-sdk';
import { accountNumber, gmailSyncMutation } from './_shared.js';

const EMAIL = /^[^\s@,<>]+@[^\s@,<>]+\.[^\s@,<>]+$/;
const escapeHtml = (value) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;').replaceAll('\n', '<br>');

function addresses(value) {
  const items = String(value || '').split(',').map((item) => item.trim());
  if (!items.length || items.some((item) => !EMAIL.test(item))) throw errors.argument('to must contain one or more comma-separated email addresses');
  return items;
}

function newId(prefix) {
  return `${prefix}-a:r${Date.now()}${Math.floor(Math.random() * 1_000_000).toString().padStart(6, '0')}`;
}

export function composeMessage({ messageId, signature, from, fromName, to, subject, body, timestamp, labels }) {
  const row = Array(78).fill(null);
  row[0] = messageId;
  row[1] = [1, from, fromName || null, null, null, null, null, null, null, from];
  row[2] = to.map((address) => [1, address]);
  row[6] = timestamp;
  row[7] = subject;
  row[8] = [null, [[0, `<div dir="ltr">${escapeHtml(body)}</div>`]], null, null, null, null, 1];
  row[10] = labels;
  row[17] = timestamp;
  row[35] = [null, null, null, null, null, 0];
  row[36] = [null, null, null, 0];
  row[41] = 0;
  row[42] = [0, 0, 0, null, 0];
  row[51] = signature;
  row[76] = [null, null, null, null, null, null, signature];
  row[77] = [];
  return row;
}

export const composeArgs = [
  { name: 'to', type: 'string', required: true, help: 'One or more comma-separated email addresses' },
  { name: 'subject', type: 'string', required: true, maxLength: 998 },
  { name: 'body', type: 'string', required: true, maxLength: 200000 },
  { name: 'from', type: 'string', required: true, help: 'Sender address for the selected Gmail account' },
  { name: 'account', type: 'int', default: 0, min: 0, max: 20 },
];

export async function gmailCreateDraft(tab, args, existingThreadId = null) {
  const account = accountNumber(args.account);
  const to = addresses(args.to);
  const subject = String(args.subject || '').trim();
  const body = String(args.body || '');
  if (!subject || subject.length > 998) throw errors.argument('subject must contain 1–998 characters');
  if (!body.trim() || body.length > 200000) throw errors.argument('body must contain 1–200000 characters');

  const from = String(args.from || '').trim();
  if (!EMAIL.test(from)) throw errors.argument('from must be an email address');

  const threadId = existingThreadId || newId('thread');
  const messageId = newId('msg');
  const timestamp = Date.now();
  const signature = `s:${timestamp}${Math.floor(Math.random() * 1_000_000)}|#${messageId}|0`;
  const base = { messageId, signature, from, fromName: null, to, subject, body, timestamp };
  const draftNode = [null, null, [['', null, timestamp, threadId, [composeMessage({ ...base, labels: ['^all', '^r', '^r_bt', '^io_im', '^io_imc3'] })]]]];
  await gmailSyncMutation(tab, [[4, [threadId, draftNode]]], account);
  return { account, threadId, messageId, base };
}

export async function gmailSendDraft(tab, draft) {
  const { account, threadId, messageId, base } = draft;
  const sendNode = Array(14).fill(null);
  sendNode[13] = [composeMessage({ ...base, labels: ['^all', '^pfg', '^f_bt', '^f_btns', '^f_cl', '^i', '^u', '^io_im', '^io_imc3'] })];
  try { await gmailSyncMutation(tab, [[6, [threadId, sendNode]]], account); }
  catch (cause) { throw errors.upstream(`Gmail send outcome is uncertain for draft ${threadId}; check Sent before retrying: ${String(cause?.message || cause)}`); }
  return { sent: true, threadId, messageId, to: base.to, subject: base.subject };
}

export default defineAdapter({
  description: 'Send a plain-text Gmail message through the draft-create and send sync JSON APIs.',
  access: 'write', domain: 'mail.google.com',
  result: { kind: 'value', description: 'Confirmed Gmail send' },
  args: composeArgs,
  async run({ tab, args }) {
    return gmailSendDraft(tab, await gmailCreateDraft(tab, args));
  },
});
