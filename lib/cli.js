'use strict';

// JSON command-line front end shared by the quota monitors. Lets a coding
// agent (or any script) read the same quota data the status bar shows.
// No vscode import: each extension's cli.js supplies a `load()` that reads
// its own credentials and returns { parsed }.
//
// Output is always one JSON document on stdout. Exit code 0 on success, 1
// when the quota could not be read (the JSON then has ok:false and an
// error.reason), 2 for a usage error.

const { execFile } = require('child_process');
const common = require('./common');
const registry = require('./registry');

const SCHEMA_VERSION = 1;
const CHILD_TIMEOUT_MS = 30000;
const BAND_RANK = { green: 0, amber: 1, red: 2 };
const OPTIONAL_WINDOW_FIELDS = ['limit', 'remaining', 'windowMinutes'];

function numberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function isoOrNull(date) {
  return date instanceof Date && !isNaN(date.getTime()) ? date.toISOString() : null;
}

function serializeWindow(w, now) {
  const resetAt = w.resetAt instanceof Date && !isNaN(w.resetAt.getTime()) ? w.resetAt : null;
  const out = {
    kind: w.kind || 'unknown',
    label: w.label || null,
    usedPercent: numberOrNull(w.usedPercent),
    remainingPercent: numberOrNull(w.remainingPercent),
    resetAt: isoOrNull(resetAt),
    resetsInSeconds: resetAt ? Math.max(0, Math.round((resetAt.getTime() - now.getTime()) / 1000)) : null,
  };
  for (const key of OPTIONAL_WINDOW_FIELDS) {
    if (numberOrNull(w[key]) !== null) {
      out[key] = w[key];
    }
  }
  return out;
}

// Build the success document. `extra(parsed, now)` returns provider-specific
// top-level fields (credits, reset packs, ...).
function snapshot(provider, parsed, now, extra) {
  const windows = parsed.windows.map((w) => serializeWindow(w, now));
  return {
    schema: SCHEMA_VERSION,
    provider,
    ok: true,
    fetchedAt: now.toISOString(),
    plan: parsed.planType || null,
    band: common.severityBand(parsed.windows, null),
    status: common.statusText(parsed.windows),
    windows,
    ...(extra ? extra(parsed, now) : {}),
  };
}

function failure(provider, now, reason, message) {
  return {
    schema: SCHEMA_VERSION,
    provider,
    ok: false,
    fetchedAt: now.toISOString(),
    error: { reason, message },
  };
}

function usage(provider, helpExtra) {
  return [
    `Usage: ${provider}-quota [--all] [--pretty] [--help]`,
    '',
    'Prints this account\'s quota as one JSON document on stdout.',
    '  ok          true when the quota was read',
    '  band        green | amber | red, from the most constrained window (null if unknown)',
    '  windows[]   kind, label, usedPercent, remainingPercent, resetAt (ISO 8601), resetsInSeconds',
    '  error       { reason, message } when ok is false',
    '',
    'Options:',
    '  --all       collate every installed quota extension (claude, codex, glm) into one document',
    '  --pretty    indent the JSON',
    '  --help      show this text',
    'Exit codes: 0 read ok, 1 quota unavailable, 2 bad arguments.',
    ...(helpExtra ? ['', helpExtra] : []),
  ].join('\n');
}

// Run another extension's registered CLI and parse its JSON. Never rejects.
function runChild(entry, env = process.env) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [entry.cli],
      { timeout: CHILD_TIMEOUT_MS, maxBuffer: 1024 * 1024, env, windowsHide: true },
      (error, stdout) => {
        try {
          const doc = JSON.parse(stdout);
          if (doc && typeof doc === 'object' && typeof doc.ok === 'boolean') {
            resolve(doc);
            return;
          }
        } catch {
          // fall through to the failure document
        }
        const reason = error && error.killed ? 'timeout' : 'child-failed';
        resolve(failure(entry.provider, new Date(), reason, `${entry.provider} CLI produced no usable output.`));
      }
    );
  });
}

// Read this provider's quota into a snapshot or failure document. Never
// rejects.
async function readSnapshot({ provider, load, extra, now }) {
  try {
    const { parsed } = await load();
    return snapshot(provider, parsed, now, extra);
  } catch (error) {
    const reason = error && typeof error.reason === 'string' ? error.reason : 'error';
    return failure(provider, now, reason, String((error && error.message) || 'unknown error'));
  }
}

// One document covering every provider that answered, plus a summary of the
// tightest constraint across them.
function collate(docs, now) {
  const providers = {};
  let worstBand = null;
  let tightest = null;
  for (const doc of docs) {
    providers[doc.provider] = doc;
    if (!doc.ok) {
      continue;
    }
    if (doc.band && (worstBand === null || BAND_RANK[doc.band] > BAND_RANK[worstBand])) {
      worstBand = doc.band;
    }
    for (const w of doc.windows) {
      if (w.remainingPercent !== null && (tightest === null || w.remainingPercent < tightest.remainingPercent)) {
        tightest = { provider: doc.provider, kind: w.kind, remainingPercent: w.remainingPercent, resetAt: w.resetAt };
      }
    }
  }
  return {
    schema: SCHEMA_VERSION,
    ok: docs.some((d) => d.ok),
    fetchedAt: now.toISOString(),
    summary: { worstBand, tightest },
    providers,
  };
}

// Options: { provider, argv, load, extra, helpExtra, cliPath, version,
// registryDir, runChild, stdout, stderr, now }.
// `load()` resolves { parsed } or rejects with a classified error
// (err.reason). Resolves to the process exit code. Never throws.
async function runCli(options) {
  const { provider, argv = [], load } = options;
  const out = options.stdout || process.stdout;
  const err = options.stderr || process.stderr;
  const now = options.now ? options.now() : new Date();
  const flags = new Set(argv);
  const known = new Set(['--pretty', '--all', '--help', '-h']);
  const unknown = argv.filter((a) => !known.has(a));

  if (flags.has('--help') || flags.has('-h')) {
    out.write(`${usage(provider, options.helpExtra)}\n`);
    return 0;
  }
  const indent = flags.has('--pretty') ? 2 : undefined;
  const emit = (doc) => out.write(`${JSON.stringify(doc, null, indent)}\n`);

  if (unknown.length > 0) {
    emit(failure(provider, now, 'usage', `Unknown argument: ${unknown[0]}`));
    err.write(`${usage(provider, options.helpExtra)}\n`);
    return 2;
  }

  const dir = options.registryDir || registry.registryDir();
  if (options.cliPath) {
    registry.register({ provider, cliPath: options.cliPath, version: options.version }, dir);
  }

  const readOwn = () => readSnapshot({ provider, load, extra: options.extra, now });

  if (!flags.has('--all')) {
    const doc = await readOwn();
    emit(doc);
    return doc.ok ? 0 : 1;
  }

  const others = registry.listRegistered(dir).filter((e) => e.provider !== provider);
  const run = options.runChild || runChild;
  const docs = await Promise.all([readOwn(), ...others.map((e) => run(e))]);
  docs.sort((a, b) => a.provider.localeCompare(b.provider));
  const combined = collate(docs, now);
  emit(combined);
  return combined.ok ? 0 : 1;
}

module.exports = {
  SCHEMA_VERSION,
  snapshot,
  failure,
  serializeWindow,
  readSnapshot,
  runChild,
  collate,
  runCli,
};
