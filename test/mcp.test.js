'use strict';

// Behavior tests for the stdio MCP server, driven over in-memory streams.
//   node --test test/mcp.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const { runMcpServer } = require('../lib/mcp');
const registry = require('../lib/registry');

const NOW = new Date('2026-11-21T12:00:00Z');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'quota-mcp-'));
}

function fakeCli(dir, name) {
  const file = path.join(dir, `${name}-cli.js`);
  fs.writeFileSync(file, '');
  return file;
}

function parsedFixture(remaining = 71) {
  return {
    planType: 'pro',
    windows: [{
      kind: '5h', label: '5-hour', short: '5h', usedPercent: 100 - remaining,
      remainingPercent: remaining, resetAt: new Date('2026-11-21T14:30:00Z'),
    }],
  };
}

// Sends each message as one line, closes stdin, and returns the parsed
// responses in arrival order once the server has finished.
async function exchange(messages, options) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  let text = '';
  stdout.on('data', (chunk) => { text += chunk; });
  const done = runMcpServer({ stdin, stdout, now: () => NOW, ...options });
  for (const m of messages) {
    stdin.write(`${typeof m === 'string' ? m : JSON.stringify(m)}\n`);
  }
  stdin.end();
  await done;
  return text.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

const call = (id, name, args) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });

function setup({ enabled = true } = {}) {
  const dir = tmpDir();
  const cli = fakeCli(dir, 'claude');
  registry.register({ provider: 'claude', cliPath: cli, mcpEnabled: enabled }, dir);
  return { dir, cli, base: { provider: 'claude', load: async () => ({ parsed: parsedFixture() }), registryDir: dir, version: '9.9.9' } };
}

test('initialize negotiates the protocol version and advertises tools', async () => {
  const { base } = setup();
  const [latest, older, unknown] = await exchange([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } },
    { jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2024-11-05' } },
    { jsonrpc: '2.0', id: 3, method: 'initialize', params: { protocolVersion: '1999-01-01' } },
  ], base);
  assert.equal(latest.result.protocolVersion, '2025-06-18');
  assert.deepEqual(latest.result.capabilities, { tools: { listChanged: false } });
  assert.deepEqual(latest.result.serverInfo, { name: 'claude-quota', version: '9.9.9' });
  assert.equal(older.result.protocolVersion, '2024-11-05');
  assert.equal(unknown.result.protocolVersion, '2025-06-18');
});

test('tools/list offers get_quota and get_all_quotas; notifications get no reply', async () => {
  const { base } = setup();
  const responses = await exchange([
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 'a', method: 'tools/list' },
    { jsonrpc: '2.0', id: 'b', method: 'ping' },
  ], base);
  assert.equal(responses.length, 2);
  const tools = responses.find((r) => r.id === 'a').result.tools;
  assert.deepEqual(tools.map((t) => t.name), ['get_quota', 'get_all_quotas']);
  assert.deepEqual(tools[0].inputSchema.properties.provider.enum, ['claude', 'codex', 'glm']);
  assert.equal(tools[0].annotations.readOnlyHint, true);
  assert.deepEqual(responses.find((r) => r.id === 'b').result, {});
});

test('get_quota returns the provider document as text and structured content', async () => {
  const { base } = setup();
  const [, res] = await exchange([
    { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
    call(1, 'get_quota', {}),
  ], base);
  assert.equal(res.result.isError, false);
  const doc = JSON.parse(res.result.content[0].text);
  assert.equal(doc.provider, 'claude');
  assert.equal(doc.ok, true);
  assert.equal(doc.windows[0].remainingPercent, 71);
  assert.deepEqual(res.result.structuredContent, doc);
});

test('older protocol versions get text content only', async () => {
  const { base } = setup();
  const [, res] = await exchange([
    { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2024-11-05' } },
    call(1, 'get_quota', {}),
  ], base);
  assert.equal('structuredContent' in res.result, false);
  assert.equal(JSON.parse(res.result.content[0].text).ok, true);
});

test('a provider with its toggle off answers mcp-disabled without loading', async () => {
  const { base } = setup({ enabled: false });
  let loaded = false;
  const [res] = await exchange([call(1, 'get_quota', {})], { ...base, load: async () => { loaded = true; } });
  assert.equal(loaded, false);
  assert.equal(res.result.isError, true);
  const doc = JSON.parse(res.result.content[0].text);
  assert.equal(doc.error.reason, 'mcp-disabled');
  assert.match(doc.error.message, /claudeQuota\.mcp\.enabled/);
});

test('the toggle is read per call, so no restart is needed', async () => {
  const { dir, cli, base } = setup({ enabled: false });
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const lines = [];
  stdout.on('data', (c) => lines.push(...String(c).trim().split('\n')));
  const done = runMcpServer({ stdin, stdout, now: () => NOW, ...base });
  const next = () => new Promise((r) => setImmediate(r));
  stdin.write(`${JSON.stringify(call(1, 'get_quota', {}))}\n`);
  await next(); await next();
  registry.register({ provider: 'claude', cliPath: cli, mcpEnabled: true }, dir);
  stdin.write(`${JSON.stringify(call(2, 'get_quota', {}))}\n`);
  stdin.end();
  await done;
  const byId = Object.fromEntries(lines.map((l) => JSON.parse(l)).map((r) => [r.id, r]));
  assert.equal(JSON.parse(byId[1].result.content[0].text).error.reason, 'mcp-disabled');
  assert.equal(JSON.parse(byId[2].result.content[0].text).ok, true);
});

test('other providers are read through their registered CLI only when enabled', async () => {
  const { dir, base } = setup();
  registry.register({ provider: 'codex', cliPath: fakeCli(dir, 'codex'), mcpEnabled: true }, dir);
  registry.register({ provider: 'glm', cliPath: fakeCli(dir, 'glm'), mcpEnabled: false }, dir);
  const ran = [];
  const runChild = async (entry) => {
    ran.push(entry.provider);
    return { schema: 1, provider: entry.provider, ok: true, band: 'red', windows: [{ kind: 'week', remainingPercent: 4, resetAt: null }] };
  };
  const byId = Object.fromEntries((await exchange([
    call(1, 'get_quota', { provider: 'codex' }),
    call(2, 'get_quota', { provider: 'glm' }),
    call(3, 'get_quota', { provider: 'nope' }),
  ], { ...base, runChild })).map((r) => [r.id, r]));
  const [codex, glm, missing] = [byId[1], byId[2], byId[3]]; // replies arrive as each call finishes
  assert.deepEqual(ran, ['codex']);
  assert.equal(JSON.parse(codex.result.content[0].text).band, 'red');
  assert.equal(JSON.parse(glm.result.content[0].text).error.reason, 'mcp-disabled');
  assert.equal(missing.error.code, -32602);
});

test('get_all_quotas collates enabled providers and marks disabled ones', async () => {
  const { dir, base } = setup();
  registry.register({ provider: 'codex', cliPath: fakeCli(dir, 'codex'), mcpEnabled: true }, dir);
  registry.register({ provider: 'glm', cliPath: fakeCli(dir, 'glm') }, dir); // never toggled: off
  const runChild = async (entry) => ({
    schema: 1, provider: entry.provider, ok: true, band: 'amber',
    windows: [{ kind: 'week', remainingPercent: 20, resetAt: null }],
  });
  const [res] = await exchange([call(1, 'get_all_quotas', {})], { ...base, runChild });
  const doc = JSON.parse(res.result.content[0].text);
  assert.deepEqual(Object.keys(doc.providers), ['claude', 'codex', 'glm']);
  assert.equal(doc.providers.glm.error.reason, 'mcp-disabled');
  assert.equal(doc.summary.worstBand, 'amber');
  assert.deepEqual(doc.summary.tightest, { provider: 'codex', kind: 'week', remainingPercent: 20, resetAt: null });
  assert.equal(res.result.isError, false);
});

test('unregistered providers report not-installed', async () => {
  const { base } = setup();
  const dir = base.registryDir;
  // An enabled entry whose CLI has been uninstalled: listRegistered prunes
  // it, so the provider counts as not installed.
  fs.writeFileSync(path.join(dir, 'codex.json'), JSON.stringify({ provider: 'codex', cli: '/nonexistent/cli.js', mcpEnabled: true }));
  const [res] = await exchange([call(1, 'get_quota', { provider: 'codex' })], base);
  assert.equal(JSON.parse(res.result.content[0].text).error.reason, 'not-installed');
});

test('bad input gets JSON-RPC errors, and batches are answered as arrays', async () => {
  const { base } = setup();
  const responses = await exchange([
    'not json',
    { jsonrpc: '2.0', id: 1, method: 'resources/list' },
    { jsonrpc: '1.0', id: 2, method: 'ping' },
    call(3, 'no_such_tool', {}),
    [{ jsonrpc: '2.0', id: 4, method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/initialized' }],
  ], base);
  const flat = responses.flatMap((r) => (Array.isArray(r) ? r : [r]));
  const code = (id) => flat.find((r) => r.id === id).error.code;
  assert.equal(code(null), -32700);
  assert.equal(code(1), -32601);
  assert.equal(code(2), -32600);
  assert.equal(code(3), -32602);
  assert.ok(responses.some((r) => Array.isArray(r) && r.length === 1 && r[0].id === 4));
});

test('registry keeps the toggle when a CLI or server re-registers', () => {
  const dir = tmpDir();
  const cli = fakeCli(dir, 'claude');
  assert.equal(registry.isMcpEnabled('claude', dir), false);
  registry.register({ provider: 'claude', cliPath: cli, mcpEnabled: true }, dir);
  registry.register({ provider: 'claude', cliPath: cli, version: '2' }, dir); // no flag: keep
  assert.equal(registry.isMcpEnabled('claude', dir), true);
  registry.register({ provider: 'claude', cliPath: cli, mcpEnabled: false }, dir);
  assert.equal(registry.isMcpEnabled('claude', dir), false);
  assert.equal(registry.isMcpEnabled('../evil', dir), false);
});

test('starting the server registers its CLI without changing the toggle', async () => {
  const dir = tmpDir();
  const cli = fakeCli(dir, 'claude');
  await exchange([], { provider: 'claude', load: async () => ({}), registryDir: dir, cliPath: cli });
  const [entry] = registry.listRegistered(dir);
  assert.equal(entry.cli, cli);
  assert.equal(entry.mcpEnabled, false);
});
