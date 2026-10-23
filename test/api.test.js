'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const https = require('https');
const api = require('../lib/api');
const VALID = { success: true, data: { limits: [] }, five_hour: { utilization: 20 } };

async function fixture(t, handler) {
  let calls = 0;
  const seen = [];
  const server = http.createServer((req, res) => handler(req, res, ++calls));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const original = https.request;
  https.request = (options, callback) => {
    seen.push(options);
    return http.request({ host: '127.0.0.1', port: server.address().port, path: '/', timeout: options.timeout }, callback);
  };
  t.after(() => { https.request = original; server.closeAllConnections(); server.close(); });
  return seen;
}

async function bounded(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('fetchUsage hung after response termination')), 1500);
    })]);
  } finally { clearTimeout(timer); }
}

function truncate(res) {
  res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '1000' });
  res.write('{"partial":');
  setTimeout(() => res.socket?.destroy(), 5);
}

test('interrupted response rejects as network failure rather than hanging', async t => {
  await fixture(t, (_req, res) => truncate(res));
  await assert.rejects(bounded(api.fetchUsage('synthetic-token', { timeoutMs: 50 })), e => e.reason === 'network');
});

test('retry recovers after an interrupted response', async t => {
  const seen = await fixture(t, (_req, res, n) => n === 1 ? truncate(res) : res.end(JSON.stringify(VALID)));
  const result = await bounded(api.fetchUsage('synthetic-token', { timeoutMs: 50 }));
  assert.deepEqual(result.body || result, VALID);
  assert.equal(seen.length, 2);
});

test('absolute deadline bounds a response that keeps trickling data', async t => {
  await fixture(t, (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const timer = setInterval(() => res.write(' '), 10);
    res.on('close', () => clearInterval(timer));
  });
  await assert.rejects(bounded(api.fetchUsage('synthetic-token', { timeoutMs: 50 })), e => e.reason === 'timeout');
});

test('complete responses succeed and preserve HTTP auth classification', async t => {
  await fixture(t, (_req, res, n) => {
    res.statusCode = n === 1 ? 200 : 401;
    res.end(JSON.stringify(VALID));
  });
  const result = await bounded(api.fetchUsage('synthetic-token', { timeoutMs: 50 }));
  assert.deepEqual(result.body || result, VALID);
  await assert.rejects(bounded(api.fetchUsage('synthetic-token', { timeoutMs: 50 })), e => e.reason === 'unauthorized');
});

test('provider-reflected credentials never appear in errors', async t => {
  await fixture(t, (_req, res) => res.end(JSON.stringify({success: false, code: 401, msg: 'invalid key synthetic-secret-reflected'})));
  await assert.rejects(api.fetchUsage('synthetic-secret-reflected', {timeoutMs: 50}), e => {
    assert.equal(e.reason, 'unauthorized');
    assert(!e.message.includes('synthetic-secret-reflected'));
    return true;
  });
});
