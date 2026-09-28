import { defineAdapter, errors } from 'opencli-mcp/adapter-sdk';
import { compact, csrf, ensureLinkedIn, linkedinApi } from './_shared.js';

const PROFILE_DECORATION = '(entityUrn,objectUrn,firstName,lastName,fullName,headline,degree,inmailRestriction,memberBadges,defaultPosition)';
const CREDITS = '/sales-api/salesApiCredits?q=findCreditGrant&creditGrantType=LSS_INMAIL';
const CREATE = '/sales-api/salesApiMessageActions?action=createMessage';

export function parseSalesRecipient(value) {
  const raw = compact(value);
  const urn = raw.match(/^urn:li:fs_salesProfile:\(([^,()]+),([^,()]+),([^,()]+)\)$/);
  if (urn && urn.slice(1).every((part) => part && !['undefined', 'null', 'not_available'].includes(part.toLowerCase()))) {
    return { profileId: urn[1], authType: urn[2], authToken: urn[3], urn: raw };
  }
  let url;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== 'https:' || !['linkedin.com', 'www.linkedin.com'].includes(url.hostname) || url.username || url.password || url.port) return null;
  const lead = url.pathname.match(/^\/sales\/lead\/([^,/]+),([^,/]+),([^/]+)\/?$/);
  if (lead) {
    const [profileId, authType, authToken] = lead.slice(1).map(decodeURIComponent);
    if ([profileId, authType, authToken].some((part) => !part || ['undefined', 'null', 'not_available'].includes(part.toLowerCase()))) return null;
    return { profileId, authType, authToken, urn: `urn:li:fs_salesProfile:(${profileId},${authType},${authToken})` };
  }
  const profile = url.pathname.match(/^\/in\/([^/]+)\/?$/);
  return profile ? { profileId: decodeURIComponent(profile[1]), authType: '', authToken: '', urn: '' } : null;
}

export function messagePayload(recipientUrn, subject, body, copyToCrm = false, trackingId = crypto.randomUUID().replaceAll('-', '').slice(0, 16)) {
  if (!parseSalesRecipient(recipientUrn)?.urn) throw errors.argument('recipient must resolve to a Sales Navigator lead URN');
  const title = compact(subject);
  const text = String(body ?? '').trim();
  if (!title || title.length > 200) throw errors.argument('subject must be 1–200 characters');
  if (!text || text.length > 1900) throw errors.argument('body must be 1–1900 characters');
  return { createMessageRequest: { recipients: [recipientUrn], subject: title, body: text,
    copyToCrm: Boolean(copyToCrm), trackingId } };
}

export function remainingCredits(json) {
  const element = json?.elements?.find?.((item) => item?.type === 'LSS_INMAIL' && Number.isInteger(item.value));
  return element ? element.value : null;
}

async function resolveRecipient(tab, raw) {
  const recipient = parseSalesRecipient(raw);
  if (!recipient) throw errors.argument('recipient must be a Sales Navigator lead URL, profile URL, or lead URN');
  if (recipient.urn) return recipient;
  await tab.goto(`https://www.linkedin.com/sales/lead/${encodeURIComponent(recipient.profileId)}`, { waitUntil: 'load' });
  const current = await tab.url();
  const resolved = parseSalesRecipient(current);
  if (resolved?.urn) return resolved;
  const resource = await tab.evaluate(`performance.getEntriesByType('resource').map((item) => item.name)
    .find((name) => name.includes('/sales-api/salesApiProfiles/') && name.includes(${JSON.stringify(recipient.profileId)})) || null`);
  const key = String(resource || '').match(/profileId:([^,)]+),authType:([^,)]+),authToken:([^,)]+)\)/);
  if (key) return parseSalesRecipient(`urn:li:fs_salesProfile:(${key[1]},${key[2]},${key[3]})`);
  throw errors.auth('Sales Navigator could not resolve the recipient', 'Open Sales Navigator with an account that has access to this lead.');
}

function profilePath(recipient) {
  const key = `(profileId:${recipient.profileId},authType:${recipient.authType},authToken:${recipient.authToken})`;
  const decoration = encodeURIComponent(PROFILE_DECORATION).replace(/\(/g, '%28').replace(/\)/g, '%29');
  return `/sales-api/salesApiProfiles/${key}?decoration=${decoration}`;
}

function profileSummary(json) {
  const data = json?.data || json || {};
  const position = data.defaultPosition || data.positions?.find?.((item) => item.current) || data.positions?.[0] || {};
  const name = compact(data.fullName || `${data.firstName || ''} ${data.lastName || ''}`);
  if (!name) throw errors.upstream('Sales Navigator profile API returned no recipient name');
  return { recipient: name, title: compact(position.title || data.headline),
    company: compact(position.companyName || position.company?.name),
    degree: compact(data.degree), inmail_restriction: compact(data.inmailRestriction),
    open_link: Boolean(data.memberBadges?.openLink) };
}

async function sendMessage(tab, token, payload) {
  const response = await tab.evaluate(`(async () => {
    const response = await fetch(${JSON.stringify(`https://www.linkedin.com${CREATE}`)}, {
      method: 'POST', credentials: 'include', headers: {
        'csrf-token': ${JSON.stringify(token)}, 'x-restli-protocol-version': '2.0.0',
        'content-type': 'application/json', accept: 'application/vnd.linkedin.normalized+json+2.1',
      }, body: ${JSON.stringify(JSON.stringify(payload))},
    });
    const text = await response.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* empty/non-JSON success */ }
    return { status: response.status, ok: response.ok, json };
  })()`);
  if (response?.status === 401 || response?.status === 403) throw errors.auth('Sales Navigator message API denied access');
  if (!response?.ok) throw errors.upstream(`Sales Navigator message API returned HTTP ${response?.status || 'unknown'}`);
  return response;
}

export default defineAdapter({
  description: 'Validate or send a Sales Navigator InMail through its sales API. Requires Sales Navigator access.',
  access: 'write', domain: 'linkedin.com',
  result: { kind: 'value', description: 'InMail validation or send result' },
  args: [
    { name: 'recipient', type: 'string', required: true, help: 'Sales Navigator lead URL, LinkedIn profile URL, or lead URN' },
    { name: 'subject', type: 'string', required: true },
    { name: 'body', type: 'string', required: true },
    { name: 'send', type: 'boolean', default: false, help: 'Send the InMail after validation' },
    { name: 'copy_to_crm', type: 'boolean', default: false },
  ],
  async run({ tab, args }) {
    await ensureLinkedIn(tab);
    const recipient = await resolveRecipient(tab, args.recipient);
    const payload = messagePayload(recipient.urn, args.subject, args.body, args.copy_to_crm);
    const summary = profileSummary(await linkedinApi(tab, profilePath(recipient)));
    if (summary.inmail_restriction && summary.inmail_restriction !== 'NO_RESTRICTION') {
      throw errors.upstream(`Sales Navigator recipient blocks InMail: ${summary.inmail_restriction}`);
    }
    const before = remainingCredits(await linkedinApi(tab, CREDITS));
    if (before === null) throw errors.upstream('Sales Navigator credits API returned no InMail balance');
    if (before <= 0) throw errors.upstream('No Sales Navigator InMail credits remain');
    if (!args.send) return { status: 'validated_dry_run', ...summary, recipient_urn: recipient.urn,
      credits_before: before, message_chars: payload.createMessageRequest.body.length,
      subject_chars: payload.createMessageRequest.subject.length };
    const token = await csrf(tab);
    const sent = await sendMessage(tab, token, payload);
    const after = remainingCredits(await linkedinApi(tab, CREDITS));
    return { status: 'submitted', ...summary, recipient_urn: recipient.urn,
      response_status: sent.status, response_id: sent.json?.data?.id || sent.json?.id || null,
      credits_before: before, credits_after: after,
      message_chars: payload.createMessageRequest.body.length,
      subject_chars: payload.createMessageRequest.subject.length };
  },
});
