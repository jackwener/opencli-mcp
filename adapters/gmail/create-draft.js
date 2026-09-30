import { defineAdapter } from 'opencli-mcp/adapter-sdk';
import { composeArgs, gmailCreateDraft } from './send.js';

export default defineAdapter({
  description: 'Save a plain-text Gmail draft through the sync JSON API.',
  access: 'write', domain: 'mail.google.com',
  result: { kind: 'value', description: 'Saved Gmail draft' },
  args: composeArgs,
  async run({ tab, args }) {
    const { threadId, messageId, base } = await gmailCreateDraft(tab, args);
    return { saved: true, threadId, messageId, to: base.to, subject: base.subject };
  },
});
