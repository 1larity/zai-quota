'use strict';

// Shape-debugging helper: one real read against both z.ai endpoints.
//   ZAI_API_KEY=... [ZAI_HOST=open.bigmodel.cn] npm run smoke
// The key is sent only to ZAI_HOST (default api.z.ai).
// Output is sanitized: field names and identifier values only (limit type /
// unit / number, product names, status strings). Never amounts, percentages,
// reset timestamps, or the key itself. Safe to paste into chat or an issue.

const api = require('../lib/api');
const quota = require('../lib/quota');

const SUB_PATH = '/api/biz/subscription/list';
const HOST = process.env.ZAI_HOST || api.HOSTS[0];
const IDENTIFIER_KEYS = [
  'type',
  'unit',
  'number',
  'productName',
  'product_name',
  'planName',
  'packageName',
  'plan_type',
  'status',
  'valid',
  'purchaseTime',
  'purchase_time',
  'nextRenewTime',
  'next_renew_time',
  'level',
];

function identifierSummary(node) {
  if (!node || typeof node !== 'object') {
    return {};
  }
  const summary = { fields: Object.keys(node).sort() };
  for (const k of IDENTIFIER_KEYS) {
    if (node[k] !== undefined && typeof node[k] !== 'object') {
      summary[k] = node[k];
    }
  }
  return summary;
}

async function fetchSubscription(key, host) {
  const res = await fetch(`https://${host}${SUB_PATH}`, {
    headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
  });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    // non-JSON; keep null body, status still tells the story
  }
  return { status: res.status, body };
}

(async () => {
  const key = process.env.ZAI_API_KEY;
  if (!key) {
    console.error('Set ZAI_API_KEY in the environment. It is never printed.');
    process.exit(1);
  }

  console.log('== quota: /api/monitor/usage/quota/limit ==');
  try {
    const { body, host } = await api.fetchUsage(key, { host: HOST });
    const data = body && typeof body === 'object' && body.data ? body.data : {};
    console.log(`host: ${host}`);
    console.log(`data fields: ${Object.keys(data).sort().join(', ') || '(none)'}`);
    for (const limit of Array.isArray(data.limits) ? data.limits : []) {
      console.log(`limit: ${JSON.stringify(identifierSummary(limit))}`);
    }
    const parsed = quota.parseUsageResponse(body);
    if (parsed) {
      console.log(`parser windows: ${parsed.windows.map((w) => w.kind).join(', ') || '(none)'}`);
      console.log(`parser credits: ${parsed.credits ? parsed.credits.kind : '(none)'}`);
    } else {
      console.log('parser: null (unrecognized)');
    }
  } catch (err) {
    console.error(
      `quota fetch failed: ${(err && err.reason) || 'error'} ${String((err && err.message) || '').slice(0, 120)}`
    );
  }

  console.log('');
  console.log('== subscription: /api/biz/subscription/list ==');
  for (const host of [HOST]) {
    try {
      const { status, body } = await fetchSubscription(key, host);
      const data = body && typeof body === 'object' ? body.data : undefined;
      const entries = Array.isArray(data) ? data : [];
      console.log(`host: ${host} (HTTP ${status}, entries: ${entries.length})`);
      entries.forEach((entry, i) => {
        console.log(`entry[${i}]: ${JSON.stringify(identifierSummary(entry))}`);
      });
      if (entries.length === 0 && status === 200) {
        console.log(
          `top-level fields: ${body && typeof body === 'object' ? Object.keys(body).sort().join(', ') : '(none)'}`
        );
      }
    } catch (err) {
      console.log(`host: ${host} failed: ${String(err && err.message).slice(0, 120)}`);
    }
  }
})();
