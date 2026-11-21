'use strict';

//   node --test test/cli.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { runCli, snapshot } = require('../lib/cli');

const NOW = new Date('2026-11-21T12:00:00Z');

function sink() {
  const s = { text: '', write(t) { s.text += t; } };
  return s;
}

function parsedFixture() {
  return {
    planType: 'max',
    windows: [
      {
        kind: '5h', label: '5-hour', short: '5h', usedPercent: 29, remainingPercent: 71,
        resetAt: new Date('2026-11-21T14:30:00Z'),
      },
      { kind: 'week', label: 'Weekly', short: 'W', usedPercent: 95, remainingPercent: 5, resetAt: null },
    ],
  };
}

async function run(argv, load, extra) {
  const stdout = sink();
  const stderr = sink();
  const code = await runCli({ provider: 'test', argv, load, extra, stdout, stderr, now: () => NOW });
  return { code, stdout: stdout.text, stderr: stderr.text };
}

test('success prints one JSON document with windows, band and countdown', async () => {
  const { code, stdout } = await run([], async () => ({ parsed: parsedFixture() }));
  assert.equal(code, 0);
  assert.ok(stdout.endsWith('\n') && stdout.trim().split('\n').length === 1);
  const doc = JSON.parse(stdout);
  assert.equal(doc.ok, true);
  assert.equal(doc.provider, 'test');
  assert.equal(doc.plan, 'max');
  assert.equal(doc.band, 'red');
  assert.equal(doc.status, '5h 71% · W 5%');
  assert.equal(doc.fetchedAt, NOW.toISOString());
  assert.deepEqual(doc.windows[0], {
    kind: '5h', label: '5-hour', usedPercent: 29, remainingPercent: 71,
    resetAt: '2026-11-21T14:30:00.000Z', resetsInSeconds: 9000,
  });
  assert.equal(doc.windows[1].resetAt, null);
  assert.equal(doc.windows[1].resetsInSeconds, null);
});

test('provider extras are merged and optional window fields kept', () => {
  const parsed = parsedFixture();
  parsed.windows[0].limit = 100;
  parsed.windows[0].remaining = 71;
  const doc = snapshot('test', parsed, NOW, () => ({ extraUsageEnabled: true }));
  assert.equal(doc.extraUsageEnabled, true);
  assert.equal(doc.windows[0].limit, 100);
  assert.equal(doc.windows[0].remaining, 71);
  assert.equal('limit' in doc.windows[1], false);
});

test('load failure prints ok:false with the classified reason and exits 1', async () => {
  const { code, stdout } = await run([], async () => {
    throw Object.assign(new Error('no key'), { reason: 'no-key' });
  });
  assert.equal(code, 1);
  const doc = JSON.parse(stdout);
  assert.equal(doc.ok, false);
  assert.deepEqual(doc.error, { reason: 'no-key', message: 'no key' });
});

test('unclassified errors report reason "error"', async () => {
  const { stdout } = await run([], async () => { throw new Error('boom'); });
  assert.equal(JSON.parse(stdout).error.reason, 'error');
});

test('--pretty indents and --help prints usage without loading', async () => {
  const pretty = await run(['--pretty'], async () => ({ parsed: parsedFixture() }));
  assert.ok(pretty.stdout.includes('\n  "ok": true'));
  let loaded = false;
  const help = await run(['--help'], async () => { loaded = true; });
  assert.equal(help.code, 0);
  assert.equal(loaded, false);
  assert.match(help.stdout, /Usage: test-quota/);
});

test('unknown arguments exit 2 with a JSON error', async () => {
  const { code, stdout, stderr } = await run(['--bogus'], async () => ({ parsed: parsedFixture() }));
  assert.equal(code, 2);
  assert.equal(JSON.parse(stdout).error.reason, 'usage');
  assert.match(stderr, /Usage:/);
});

// --- registry and --all collation -------------------------------------

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const registry = require('../lib/registry');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'quota-registry-'));
}

function fakeCli(dir, name) {
  const file = path.join(dir, `${name}-cli.js`);
  fs.writeFileSync(file, '');
  return file;
}

test('register writes an entry and listRegistered returns it', () => {
  const dir = tmpDir();
  const cli = fakeCli(dir, 'codex');
  assert.equal(registry.register({ provider: 'codex', cliPath: cli, version: '1.0.0' }, dir), true);
  const [entry] = registry.listRegistered(dir);
  assert.equal(entry.provider, 'codex');
  assert.equal(entry.cli, cli);
  assert.equal(entry.version, '1.0.0');
});

test('register rejects bad ids and relative paths without throwing', () => {
  const dir = tmpDir();
  assert.equal(registry.register({ provider: '../evil', cliPath: '/x/cli.js' }, dir), false);
  assert.equal(registry.register({ provider: 'ok', cliPath: 'cli.js' }, dir), false);
  assert.deepEqual(registry.listRegistered(dir), []);
});

test('entries for removed installs are pruned', () => {
  const dir = tmpDir();
  const cli = fakeCli(dir, 'glm');
  registry.register({ provider: 'glm', cliPath: cli }, dir);
  fs.rmSync(cli);
  assert.deepEqual(registry.listRegistered(dir), []);
  assert.equal(fs.existsSync(path.join(dir, 'glm.json')), false);
});

test('listRegistered tolerates a missing directory and junk files', () => {
  assert.deepEqual(registry.listRegistered(path.join(tmpDir(), 'nope')), []);
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'bad.json'), '{not json');
  fs.writeFileSync(path.join(dir, 'mismatch.json'), JSON.stringify({ provider: 'other', cli: '/x/cli.js' }));
  assert.deepEqual(registry.listRegistered(dir), []);
});

test('a CLI run registers itself', async () => {
  const dir = tmpDir();
  const cli = fakeCli(dir, 'self');
  await runCli({
    provider: 'test', argv: [], load: async () => ({ parsed: parsedFixture() }),
    cliPath: cli, version: '2.0.0', registryDir: dir,
    stdout: sink(), stderr: sink(), now: () => NOW,
  });
  assert.equal(registry.listRegistered(dir)[0].provider, 'test');
});

test('--all collates own data with other registered providers', async () => {
  const dir = tmpDir();
  registry.register({ provider: 'other', cliPath: fakeCli(dir, 'other') }, dir);
  const stdout = sink();
  const code = await runCli({
    provider: 'test', argv: ['--all'], load: async () => ({ parsed: parsedFixture() }),
    registryDir: dir, stdout, stderr: sink(), now: () => NOW,
    runChild: async (entry) => ({
      schema: 1, provider: entry.provider, ok: true, band: 'amber',
      windows: [{ kind: 'week', remainingPercent: 3, resetAt: null }],
    }),
  });
  assert.equal(code, 0);
  const doc = JSON.parse(stdout.text);
  assert.deepEqual(Object.keys(doc.providers), ['other', 'test']);
  assert.equal(doc.summary.worstBand, 'red');
  assert.deepEqual(doc.summary.tightest, { provider: 'other', kind: 'week', remainingPercent: 3, resetAt: null });
});

test('--all works alone when no other extension is installed', async () => {
  const stdout = sink();
  const code = await runCli({
    provider: 'test', argv: ['--all'], load: async () => ({ parsed: parsedFixture() }),
    registryDir: tmpDir(), stdout, stderr: sink(), now: () => NOW,
  });
  assert.equal(code, 0);
  assert.deepEqual(Object.keys(JSON.parse(stdout.text).providers), ['test']);
});

test('--all stays ok when one provider fails, and exits 1 only if all fail', async () => {
  const dir = tmpDir();
  registry.register({ provider: 'other', cliPath: fakeCli(dir, 'other') }, dir);
  const failing = async () => { throw Object.assign(new Error('x'), { reason: 'no-key' }); };
  const okChild = async (e) => ({ provider: e.provider, ok: true, band: 'green', windows: [] });
  const failChild = async (e) => ({ provider: e.provider, ok: false, error: { reason: 'timeout', message: 'x' } });
  const base = { provider: 'test', argv: ['--all'], registryDir: dir, stderr: sink(), now: () => NOW };

  let stdout = sink();
  assert.equal(await runCli({ ...base, stdout, load: failing, runChild: okChild }), 0);
  assert.equal(JSON.parse(stdout.text).providers.test.ok, false);

  stdout = sink();
  assert.equal(await runCli({ ...base, stdout, load: failing, runChild: failChild }), 1);
  assert.equal(JSON.parse(stdout.text).ok, false);
});

test('default child runner turns unusable output into a failure document', async () => {
  const dir = tmpDir();
  const bad = path.join(dir, 'bad-cli.js');
  fs.writeFileSync(bad, 'process.stdout.write("not json")');
  const good = path.join(dir, 'good-cli.js');
  fs.writeFileSync(good, 'process.stdout.write(JSON.stringify({provider:"good",ok:true,band:"green",windows:[]}))');
  registry.register({ provider: 'bad', cliPath: bad }, dir);
  registry.register({ provider: 'good', cliPath: good }, dir);
  const stdout = sink();
  await runCli({
    provider: 'test', argv: ['--all'], load: async () => ({ parsed: parsedFixture() }),
    registryDir: dir, stdout, stderr: sink(), now: () => NOW,
  });
  const doc = JSON.parse(stdout.text);
  assert.equal(doc.providers.bad.error.reason, 'child-failed');
  assert.equal(doc.providers.good.ok, true);
});
