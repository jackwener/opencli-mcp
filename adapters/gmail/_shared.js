import { errors } from 'opencli-mcp/adapter-sdk';

const ORIGIN = 'https://mail.google.com';
const REQUIRED_HEADERS = new Set(['content-type', 'x-framework-xsrf-token', 'x-gmail-btai', 'x-gmail-storage-request', 'x-google-btd']);

export function accountNumber(value) {
  const n = value === undefined ? 0 : Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 20) throw errors.argument('account must be an integer between 0 and 20');
  return n;
}

const clean = (value) => typeof value === 'string' ? value.trim() : '';

function addressRef(value) {
  if (!Array.isArray(value)) return null;
  const address = clean(value[1]);
  return address.includes('@') ? { address, name: clean(value[2]) || null } : null;
}

function isoDate(value) {
  let n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw errors.upstream('Gmail returned an invalid timestamp');
  if (n < 1e10) n *= 1000;
  if (n > 1e13) n /= 1000;
  const date = new Date(n);
  if (Number.isNaN(date.getTime())) throw errors.upstream('Gmail returned an invalid timestamp');
  return date.toISOString();
}

export function parseBatchView(body) {
  if (!Array.isArray(body) || body.length !== 19) throw errors.upstream('Gmail batch-view response changed shape');
  const records = Array.isArray(body[2]) ? body[2] : [];
  return records.map((wrapper, index) => {
    const record = wrapper?.[0];
    if (!Array.isArray(record) || record.length < 5) throw errors.upstream(`Gmail thread ${index} is malformed`);
    const id = clean(record[3]).replace(/^#/, '');
    if (!id) throw errors.upstream(`Gmail thread ${index} has no id`);
    const messages = Array.isArray(record[4]) ? record[4] : [];
    const last = messages.at(-1);
    const sender = Array.isArray(last?.[1]) ? last[1] : [];
    const labels = [...new Set(messages.flatMap((message) => Array.isArray(message?.[10]) ? message[10] : []).filter((label) => typeof label === 'string' && label.startsWith('^')))];
    return {
      threadId: id,
      subject: clean(record[0]) || '(no subject)',
      from: clean(sender[1]) || null,
      fromName: clean(sender[2]) || null,
      snippet: clean(record[1]) || null,
      messageCount: messages.length,
      unread: labels.includes('^u'),
      starred: labels.includes('^t'),
      date: isoDate(record[2]),
      labels,
    };
  });
}

const SYSTEM_LABELS = new Map([
  ['^i', 'Inbox'], ['^f', 'Sent'], ['^r', 'Drafts'], ['^t', 'Starred'],
  ['^s', 'Spam'], ['^k', 'Trash'], ['^all', 'All Mail'], ['^scheduled', 'Scheduled'],
  ['^smartlabel_personal', 'Primary'], ['^smartlabel_social', 'Social'],
  ['^smartlabel_promo', 'Promotions'], ['^smartlabel_notification', 'Updates'],
  ['^smartlabel_group', 'Forums'],
]);

export function parseLabelStatus(body, userLabels) {
  const counts = body?.[2]?.[0];
  if (!Array.isArray(counts) || !counts.length) throw errors.upstream('Gmail label-status response changed shape');
  const names = new Map(userLabels.map((label) => [label.id, label.name]));
  const rows = [];
  for (const item of counts) {
    const id = clean(item?.[0]);
    if (!SYSTEM_LABELS.has(id) && !id.startsWith('^x_')) continue;
    if (id.startsWith('^x_') && !names.has(id)) throw errors.upstream(`Gmail bootstrap omitted the name of label ${id}`);
    const count = (index) => item[index] != null && Number.isFinite(Number(item[index])) ? Number(item[index]) : null;
    rows.push({ id, name: names.get(id) || SYSTEM_LABELS.get(id), type: id.startsWith('^x_') ? 'user' : 'system', unreadCount: count(1), totalCount: count(2) });
  }
  return rows;
}

/** Gmail embeds label definitions as escaped JSON records in its initial HTTP payload. */
export function parseBootstrapUserLabels(html) {
  const result = new Map();
  const pattern = /\[\[\\"(\^x_[^"\\]+)\\",\\"([\s\S]*?)\\",null/g;
  for (const match of String(html).matchAll(pattern)) {
    let name;
    try { name = JSON.parse(`"${match[2]}"`); } catch { continue; }
    if (name && name.length <= 500) result.set(match[1], name);
  }
  return [...result].map(([id, name]) => ({ id, name }));
}

export async function gmailLabels(tab, account = 0) {
  const { url, headers } = await gmailRequestTemplate(tab, 'in:anywhere', account);
  const statusUrl = url.replace('/i/bv?', '/i/s?');
  if (statusUrl === url) throw errors.upstream('Gmail batch-view URL cannot be converted to label-status URL');
  let status;
  try { status = await tab.fetchJson(statusUrl, { method: 'POST', headers, body: [] }); }
  catch (cause) { throw errors.upstream(`Gmail label-status API failed: ${String(cause?.message || cause)}`); }
  const accountPath = `/mail/u/${account}/?opencli_labels=1`;
  const script = `(async () => { const response = await fetch(${JSON.stringify(accountPath)}, { credentials: 'include' }); if (!response.ok) return { httpError: response.status }; return (${parseBootstrapUserLabels.toString()})(await response.text()); })()`;
  const bootstrap = await tab.evaluate(script);
  if (bootstrap?.httpError) throw errors.upstream(`Gmail label bootstrap returned HTTP ${bootstrap.httpError}`);
  if (!Array.isArray(bootstrap)) throw errors.upstream('Gmail label bootstrap response changed shape');
  return parseLabelStatus(status, bootstrap);
}

/** Capture Gmail's own request as a short-lived template for its JSON API. */
export async function gmailRequestTemplate(tab, query, account) {
  const normalized = clean(query);
  if (!normalized) throw errors.argument('Gmail search query cannot be empty');
  const path = `/sync/u/${account}/i/bv`;
  const inbox = `${ORIGIN}/mail/u/${account}/#inbox`;
  await tab.goto(inbox, { waitUntil: 'load' });
  await tab.network.start(path);
  let cursor = (await tab.network.read({ pattern: path, limit: 1000 })).cursor;
  await tab.goto(`${ORIGIN}/mail/u/${account}/#search/${encodeURIComponent(normalized)}`, { waitUntil: 'load' });
  let entry;
  for (let attempt = 0; attempt < 20 && !entry; attempt++) {
    const page = await tab.network.read({ pattern: path, afterSequence: cursor, limit: 100 });
    cursor = page.cursor;
    entry = page.entries.find((item) => {
      if (item.method !== 'POST' || !item.requestBodyPreview || item.requestBodyTruncated || item.responseStatus !== 200) return false;
      try { return JSON.parse(item.requestBodyPreview)?.[0]?.[3] === normalized; } catch { return false; }
    });
    if (!entry) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!entry) throw errors.upstream('Gmail did not issue a batch-view API request');
  let body;
  try { body = JSON.parse(entry.requestBodyPreview); } catch { throw errors.upstream('Gmail batch-view request is malformed'); }
  if (!Array.isArray(body?.[0]) || body[0][3] !== normalized) throw errors.upstream('Gmail batch-view request did not match the query');
  const headers = Object.fromEntries(Object.entries(entry.requestHeaders || {}).filter(([key]) => REQUIRED_HEADERS.has(key.toLowerCase())));
  if (![...REQUIRED_HEADERS].every((name) => Object.keys(headers).some((key) => key.toLowerCase() === name))) throw errors.upstream('Gmail batch-view request is missing required headers');
  return { url: entry.url, headers, body };
}

export async function gmailBatchView(tab, query, account = 0) {
  const { url, headers, body } = await gmailRequestTemplate(tab, query, account);
  try { return await tab.fetchJson(url, { method: 'POST', headers, body }); }
  catch (cause) { throw errors.upstream(`Gmail batch-view API failed: ${String(cause?.message || cause)}`); }
}

export function syncThreadId(value) {
  const raw = clean(value);
  const direct = raw.replace(/^#/, '').match(/^thread-([fa]):(r?\d+)$/);
  if (direct) return `thread-${direct[1]}:${direct[2]}`;
  const hex = raw.match(/(?:^|\/|#)([a-f\d]{10,})\/?$/i)?.[1];
  if (hex) return `thread-f:${BigInt(`0x${hex}`).toString(10)}`;
  throw errors.argument('thread must be a Gmail thread ID or Gmail thread URL');
}

export async function gmailSyncMutation(tab, operations, account = 0) {
  if (!Array.isArray(operations) || !operations.length) throw errors.argument('Gmail mutation requires an operation');
  const { url, headers } = await gmailRequestTemplate(tab, 'in:anywhere', account);
  const syncUrl = url.replace('/i/bv?', '/i/s?');
  if (syncUrl === url) throw errors.upstream('Gmail batch-view URL cannot be converted to sync URL');
  const body = [null, [operations], null, null, 2];
  if (operations.some((operation) => [2, 6].includes(operation[0]))) body[0] = [null, null, 2];
  let response;
  try { response = await tab.fetchJson(syncUrl, { method: 'POST', headers, body }); }
  catch (cause) { throw errors.upstream(`Gmail sync API failed; check the mailbox before retrying: ${String(cause?.message || cause)}`); }
  const statuses = response?.[0]?.[0];
  if (!Array.isArray(statuses) || statuses.length !== operations.length || statuses.some((row, index) => row?.[0] !== operations[index][0] || row?.[1] !== 0)) {
    throw errors.upstream('Gmail sync API did not confirm every operation; check the mailbox before retrying');
  }
  return statuses;
}

export function gmailMessageId(value) {
  const id = clean(value).replace(/^#/, '');
  if (!/^msg-[fa]:r?\d+$/.test(id)) throw errors.argument('message must be a Gmail message ID');
  return id;
}

export function gmailLabelOperation(threadId, messageIds, add = [], remove = []) {
  if (!messageIds.length) throw errors.argument('At least one Gmail message is required');
  const node = [null, null, null, null, null, null, [add.length ? add : null, remove.length ? remove : null, messageIds]];
  return [3, [threadId, node]];
}

const htmlToText = (value) => String(value || '')
  .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
  .replace(/<br\s*\/?\s*>/gi, '\n')
  .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
  .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
  .replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').trim();

export function parseFetchData(body) {
  if (!Array.isArray(body) || !Array.isArray(body[1])) throw errors.upstream('Gmail fetch-data response changed shape');
  const messages = [];
  for (const thread of body[1]) {
    const threadId = clean(thread?.[0]).replace(/^#/, '');
    for (const wrapper of Array.isArray(thread?.[2]) ? thread[2] : []) {
      const messageId = clean(wrapper?.[0]).replace(/^#/, '');
      const record = wrapper?.[1];
      if (!threadId || !messageId || !Array.isArray(record)) throw errors.upstream('Gmail message is malformed');
      const senderCard = record[10];
      const from = clean(senderCard?.[16]);
      const bodyBlock = Array.isArray(record[5]) ? record[5] : [];
      const plain = clean(bodyBlock[4]?.[6]);
      const html = (Array.isArray(bodyBlock[1]) ? bodyBlock[1] : []).map((part) => clean(part?.[2]?.[1])).join('');
      const text = plain && !/[.#@][\w-]+\s*\{[^}]+\}/.test(plain.slice(0, 500)) ? plain : (htmlToText(html) || plain || clean(record[6]));
      const attachments = (Array.isArray(record[13]) ? record[13] : []).map((item) => {
        const node = item?.[0];
        const data = node?.[3];
        if (!Array.isArray(data) || !clean(node?.[1])) return null;
        return {
          attachmentId: clean(node[1]), name: clean(data[2]) || null,
          mimeType: clean(data[3]) || null,
          size: data[4] != null && Number.isFinite(Number(data[4])) ? Number(data[4]) : null,
        };
      }).filter(Boolean);
      messages.push({
        messageId, legacyMessageId: clean(record[34]) || null, threadId,
        subject: clean(record[4]) || '(no subject)',
        from: from.includes('@') ? from : null, fromName: clean(senderCard?.[14]) || null,
        to: (Array.isArray(record[0]) ? record[0] : []).map(addressRef).filter(Boolean).map((x) => x.address).join(', ') || null,
        cc: (Array.isArray(record[1]) ? record[1] : []).map(addressRef).filter(Boolean).map((x) => x.address).join(', ') || null,
        date: isoDate(record[16]), snippet: clean(record[6]) || null,
        body: `${text.slice(0, 20_000)}${Number(bodyBlock[2]) === 1 ? '\n\n[message clipped by Gmail]' : ''}`.trim() || null,
        attachments,
      });
    }
  }
  return messages;
}

export async function gmailFetchThread(tab, thread, account = 0) {
  const id = syncThreadId(thread);
  const { url, headers } = await gmailRequestTemplate(tab, 'in:anywhere', account);
  const fdUrl = url.replace(`/i/bv?`, `/i/fd?`);
  if (fdUrl === url) throw errors.upstream('Gmail batch-view URL cannot be converted to fetch-data URL');
  let response;
  try { response = await tab.fetchJson(fdUrl, { method: 'POST', headers, body: [[[id, 1]], 2] }); }
  catch (cause) { throw errors.upstream(`Gmail fetch-data API failed: ${String(cause?.message || cause)}`); }
  const rows = parseFetchData(response).filter((message) => message.threadId === id);
  if (!rows.length) throw errors.empty(`No messages found in ${id}`);
  return rows;
}
