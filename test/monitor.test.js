'use strict';

// Behavior tests for monitor.js against a minimal fake vscode API.
//   node --test shared/monitor.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { createMonitor } = require('../lib/monitor');

function fakeVscode() {
  const commands = {};
  const listeners = { config: [], windowState: [] };
  const item = { show() {}, dispose() {} };
  const vscode = {
    item,
    registered: commands,
    listeners,
    opened: [],
    logs: [],
    StatusBarAlignment: { Left: 1 },
    ThemeColor: class {
      constructor(id) {
        this.id = id;
      }
    },
    Uri: { parse: (s) => s },
    env: { openExternal: (u) => vscode.opened.push(u) },
    window: {
      state: { focused: true },
      createStatusBarItem: () => item,
      createOutputChannel: () => ({ appendLine(line) { vscode.logs.push(line); }, dispose() {} }),
      onDidChangeWindowState: (fn) => listeners.windowState.push(fn) && { dispose() {} },
    },
    workspace: {
      getConfiguration: () => ({ get: (k) => (k === 'refreshIntervalSeconds' ? 3600 : undefined) }),
      onDidChangeConfiguration: (fn) => listeners.config.push(fn) && { dispose() {} },
    },
    commands: {
      registerCommand: (id, fn) => {
        commands[id] = fn;
        return { dispose() {} };
      },
    },
  };
  return vscode;
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setup(load, extra = {}) {
  const vscode = fakeVscode();
  const context = { subscriptions: [] };
  const monitor = createMonitor(vscode, context, {
    section: 'testQuota',
    name: 'Test Quota',
    label: 'Test',
    icon: '$(pulse)',
    priority: 1,
    usageUrl: 'https://example.invalid/usage',
    load,
    statusText: (parsed) => parsed.text,
    tooltip: (parsed, fetchedAt, stale) => `tip:${parsed.text}${stale ? ` stale:${stale}` : ''}`,
    friendlyError: (err) => `friendly:${err.reason}`,
    credentialReasons: ['dead-key'],
    ...extra,
  });
  return { vscode, context, monitor, dispose: () => context.subscriptions.forEach((d) => d.dispose()) };
}

const ok = (text, remaining) => ({
  parsed: { text, windows: [{ remainingPercent: remaining }] },
  summary: 'ok',
});
const fail = (reason) => Object.assign(new Error(reason), { reason });

test('success renders text, tooltip and band; failure keeps last good as stale', async () => {
  const results = [ok('5h 80%', 80), fail('timeout')];
  const { vscode, monitor, dispose } = setup(async () => {
    const r = results.shift();
    if (r instanceof Error) throw r;
    return r;
  });
  await tick();
  assert.equal(vscode.item.text, '$(pulse) Test 5h 80%');
  assert.equal(vscode.item.color, '#2EA043');
  await monitor.refresh(false);
  assert.equal(vscode.item.text, '$(pulse) Test 5h 80%');
  assert.equal(vscode.item.tooltip, 'tip:5h 80% stale:friendly:timeout');
  dispose();
});

test('credential failures show the key state and drop last good data', async () => {
  const results = [ok('5h 5%', 5), fail('dead-key'), fail('timeout')];
  const { vscode, monitor, dispose } = setup(async () => {
    const r = results.shift();
    if (r instanceof Error) throw r;
    return r;
  });
  await tick();
  assert.equal(vscode.item.backgroundColor.id, 'statusBarItem.errorBackground');
  await monitor.refresh(false);
  assert.equal(vscode.item.text, '$(key) Test ?');
  assert.equal(vscode.item.backgroundColor, undefined);
  await monitor.refresh(false); // no last good left, so a plain warning
  assert.equal(vscode.item.text, '$(warning) Test ?');
  dispose();
});

test('a refresh requested mid-flight is queued, not dropped', async () => {
  const gates = [deferred(), deferred()];
  let calls = 0;
  const seen = [];
  const { vscode, monitor, dispose } = setup(async (interactive) => {
    seen.push(interactive);
    return gates[calls++].promise;
  });
  monitor.refresh(true); // queued behind the activation refresh
  monitor.refresh(false); // coalesced into the same queued run
  gates[0].resolve(ok('first', 50));
  await tick();
  await tick();
  assert.equal(calls, 2);
  assert.deepEqual(seen, [false, true]);
  gates[1].resolve(ok('second', 50));
  await tick();
  assert.equal(vscode.item.text, '$(pulse) Test second');
  dispose();
});

test('reset() discards a result that lands afterwards', async () => {
  const gate = deferred();
  const { vscode, monitor, dispose } = setup(() => gate.promise);
  monitor.reset();
  gate.resolve(ok('old-key data', 50));
  await tick();
  assert.equal(vscode.item.text, '$(sync~spin) Test');
  dispose();
});

test('unfocused windows skip timer ticks and catch up on focus', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let calls = 0;
  const { vscode, dispose } = setup(async () => {
    calls += 1;
    return ok('x', 50);
  });
  await tick();
  assert.equal(calls, 1); // activation refresh
  vscode.window.state.focused = false;
  t.mock.timers.tick(3600 * 1000);
  await tick();
  assert.equal(calls, 1);
  vscode.listeners.windowState.forEach((fn) => fn({ focused: true }));
  await tick();
  assert.equal(calls, 2);
  vscode.listeners.windowState.forEach((fn) => fn({ focused: true })); // nothing missed now
  await tick();
  assert.equal(calls, 2);
  dispose();
});

test('double click opens the usage page instead of refreshing', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const { vscode, dispose } = setup(async () => {
    calls += 1;
    return ok('x', 50);
  });
  await tick();
  vscode.registered['testQuota.statusClick']();
  vscode.registered['testQuota.statusClick']();
  t.mock.timers.tick(1000);
  await tick();
  assert.deepEqual(vscode.opened, ['https://example.invalid/usage']);
  assert.equal(calls, 1);
  vscode.registered['testQuota.statusClick']();
  t.mock.timers.tick(1000);
  await tick();
  assert.equal(calls, 2);
  dispose();
});

test('logs omit arbitrary error text and diagnostics', async () => {
  const { vscode, context } = setup(async () => { throw Object.assign(new Error('synthetic-secret'), {reason: 'network', diagnostic: 'synthetic-secret'}); });
  await tick();
  assert(vscode.logs.some(line => line.includes('refresh failed: network')));
  assert(!vscode.logs.some(line => line.includes('synthetic-secret')));
  for (const sub of context.subscriptions) sub.dispose?.();
});
