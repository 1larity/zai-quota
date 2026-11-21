'use strict';

// Behavior tests for monitor.js against a minimal fake vscode API.
//   node --test test/monitor.test.js

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

// --- opt-in MCP server (agent option) ---------------------------------

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const registry = require('../lib/registry');

// fakeVscode plus the APIs the agent option uses: mutable settings with
// update(), MarkdownString, EventEmitter and the lm MCP provider registry.
function agentVscode() {
  const vscode = fakeVscode();
  const settings = { refreshIntervalSeconds: 3600 };
  vscode.settings = settings;
  vscode.ConfigurationTarget = { Global: 1 };
  vscode.workspace.getConfiguration = () => ({
    get: (k) => settings[k],
    update: async (k, v) => {
      settings[k] = v;
      const event = { affectsConfiguration: (s) => `testQuota.${k}`.startsWith(s) };
      vscode.listeners.config.forEach((fn) => fn(event));
    },
  });
  vscode.MarkdownString = class {
    constructor(value) {
      this.value = value;
    }
  };
  vscode.EventEmitter = class {
    constructor() {
      this.fired = 0;
      this.event = () => ({ dispose() {} });
    }
    fire() {
      this.fired += 1;
    }
    dispose() {}
  };
  vscode.McpStdioServerDefinition = class {
    constructor(label, command, args, env, version) {
      Object.assign(this, { label, command, args, env, version });
    }
  };
  vscode.lm = {
    registerMcpServerDefinitionProvider: (id, provider) => {
      vscode.mcpProvider = { id, provider };
      return { dispose() {} };
    },
  };
  return vscode;
}

function setupAgent(t, vscode = agentVscode()) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-monitor-'));
  const previous = process.env.QUOTA_MONITOR_DIR;
  process.env.QUOTA_MONITOR_DIR = dir;
  const cliPath = path.join(dir, 'cli.js');
  fs.writeFileSync(cliPath, '');
  const context = { subscriptions: [] };
  createMonitor(vscode, context, {
    section: 'testQuota', name: 'Test Quota', label: 'Test', icon: '$(pulse)', priority: 1,
    usageUrl: 'https://example.invalid/usage',
    load: async () => ok('5h 80%', 80),
    statusText: (parsed) => parsed.text,
    tooltip: (parsed) => `Test quota\nPlan: [pro]\n\nRemaining: 80%`,
    friendlyError: (err) => `friendly:${err.reason}`,
    agent: {
      provider: 'test', cliPath, mcpPath: path.join(dir, 'mcp.js'), version: '1.2.3',
      env: async () => ({ TEST_KEY: 'k' }),
    },
  });
  t.after(() => {
    context.subscriptions.forEach((d) => d.dispose());
    if (previous === undefined) delete process.env.QUOTA_MONITOR_DIR;
    else process.env.QUOTA_MONITOR_DIR = previous;
  });
  return { vscode, dir, cliPath };
}

test('the tooltip carries an MCP toggle that is off by default', async (t) => {
  const { vscode, dir } = setupAgent(t);
  await tick();
  const md = vscode.item.tooltip;
  assert.ok(md instanceof vscode.MarkdownString);
  assert.match(md.value, /^Test quota  \nPlan: \\\[pro\\\]\n\nRemaining: 80%/); // escaped, breaks kept
  assert.match(md.value, /MCP server: \*\*off\*\* · \[Turn on\]\(command:testQuota\.toggleMcp /);
  assert.deepEqual(md.isTrusted, { enabledCommands: ['testQuota.toggleMcp'] });
  assert.equal(registry.isMcpEnabled('test', dir), false);
  assert.equal(registry.listRegistered(dir)[0].version, '1.2.3');
});

test('toggling flips the setting, the registry, the tooltip and the VS Code list', async (t) => {
  const { vscode, dir } = setupAgent(t);
  await tick();
  const { id, provider } = vscode.mcpProvider;
  assert.equal(id, 'testQuota.mcp');
  assert.deepEqual(provider.provideMcpServerDefinitions(), []);

  await vscode.registered['testQuota.toggleMcp']();
  assert.equal(vscode.settings['mcp.enabled'], true);
  assert.equal(registry.isMcpEnabled('test', dir), true);
  assert.match(vscode.item.tooltip.value, /MCP server: \*\*on\*\* · \[Turn off\]/);
  const [def] = provider.provideMcpServerDefinitions();
  assert.equal(def.command, process.execPath);
  assert.deepEqual(def.args, [path.join(dir, 'mcp.js')]);
  assert.deepEqual(def.env, { ELECTRON_RUN_AS_NODE: '1' }); // no credentials in the listing
  const resolved = await provider.resolveMcpServerDefinition(def);
  assert.deepEqual(resolved.env, { ELECTRON_RUN_AS_NODE: '1', TEST_KEY: 'k' });

  await vscode.registered['testQuota.toggleMcp']();
  assert.equal(registry.isMcpEnabled('test', dir), false);
  assert.deepEqual(provider.provideMcpServerDefinitions(), []);
});

test('hosts without the MCP API still get the toggle and registry sync', async (t) => {
  const vscode = agentVscode();
  delete vscode.lm;
  const { dir } = setupAgent(t, vscode);
  await tick();
  await vscode.registered['testQuota.toggleMcp']();
  assert.equal(registry.isMcpEnabled('test', dir), true);
  assert.match(vscode.item.tooltip.value, /\*\*on\*\*/);
});

test('without the agent option the tooltip stays plain text', async (t) => {
  const { vscode, dispose } = setup(async () => ok('5h 80%', 80));
  t.after(dispose);
  await tick();
  assert.equal(typeof vscode.item.tooltip, 'string');
  assert.equal(vscode.registered['testQuota.toggleMcp'], undefined);
});
