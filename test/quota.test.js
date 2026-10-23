'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const quota = require('../lib/quota.js');

// The verified response schema of GET /api/monitor/usage/quota/limit.
// CREDIT_LIMIT appears when the account has purchased credits (same fields;
// `percentage` is USED percent there too).
const REAL_SHAPE = {
  success: true,
  data: {
    level: 'pro',
    limits: [
      {
        type: 'TOKENS_LIMIT',
        unit: 3,
        number: 5,
        percentage: 25, // USED percent
        total: 12000,
        usage: 3000,
        nextResetTime: 1787521415000, // epoch ms
      },
      {
        type: 'TOKENS_LIMIT',
        unit: 6,
        number: 1,
        percentage: 15,
        total: 60000,
        usage: 9000,
        nextResetTime: 1787640000000,
      },
      {
        type: 'CREDIT_LIMIT',
        unit: 3,
        number: 5,
        percentage: 10,
        total: 2000,
        usage: 200,
        nextResetTime: 1788300000000,
      },
      { type: 'TIME_LIMIT', unit: 5, number: 1, percentage: 40 }, // monthly, ignored
    ],
  },
};

test('parses the verified schema: shape-identified windows, used->remaining', () => {
  const parsed = quota.parseUsageResponse(REAL_SHAPE);
  assert.equal(parsed.planType, 'pro');
  assert.equal(parsed.windows.length, 2); // TIME_LIMIT and CREDIT_LIMIT excluded
  const five = parsed.windows[0];
  assert.equal(five.kind, '5h');
  assert.equal(five.remainingPercent, 75); // percentage is USED
  assert.equal(five.usedPercent, 25);
  assert.equal(five.limit, 12000);
  assert.equal(five.remaining, 9000); // total - usage
  assert.ok(five.resetAt instanceof Date);
  assert.equal(five.resetAt.getTime(), 1787521415000);
  const week = parsed.windows[1];
  assert.equal(week.kind, 'week');
  assert.equal(week.remainingPercent, 85);
});

test('purchased CREDIT_LIMIT is surfaced separately when present', () => {
  const parsed = quota.parseUsageResponse(REAL_SHAPE);
  assert.equal(parsed.credits.kind, 'credits');
  assert.equal(parsed.credits.usedPercent, 10);
  assert.equal(parsed.credits.remainingPercent, 90);
  assert.equal(parsed.credits.limit, 2000);
  assert.equal(parsed.credits.remaining, 1800);
  assert.ok(parsed.credits.resetAt instanceof Date);
  // Credits never join the window slots or the color bands.
  assert.equal(quota.statusText(parsed.windows, parsed.credits), '5h 75% · W 85% · C 90%');
  assert.equal(quota.severityBand(parsed.windows, null), 'green'); // 75% only, credits ignored
  const tip = quota.tooltipText(parsed, new Date(), null);
  assert.match(tip, /Purchased credits/);
  assert.match(tip, /Remaining: 90% \(1,800 of 2,000 credits\)/);
});

test('statusText and tooltip render from the verified schema', () => {
  const parsed = quota.parseUsageResponse(REAL_SHAPE);
  assert.equal(quota.statusText(parsed.windows), '5h 75% · W 85%');
  const tip = quota.tooltipText(parsed, new Date(), null);
  assert.match(tip, /Plan: pro/);
  assert.match(tip, /Remaining: 75% \(9,000 of 12,000 left\)/);
  assert.match(tip, /Resets: /);
  assert.match(tip, /Last refreshed: /);
});

test('credits-only response parses without token windows', () => {
  const body = {
    data: {
      level: 'pro',
      limits: [{ type: 'CREDIT_LIMIT', percentage: 20, total: 2000, usage: 400 }],
    },
  };
  const parsed = quota.parseUsageResponse(body);
  assert.deepEqual(parsed.windows, []);
  assert.equal(parsed.credits.remainingPercent, 80);
  assert.equal(quota.statusText(parsed.windows, parsed.credits), 'C 80%');
  assert.equal(quota.severityBand(parsed.windows), null);
});

test('no CREDIT_LIMIT entry means no credits display', () => {
  const body = { data: { limits: [{ type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 10 }] } };
  const parsed = quota.parseUsageResponse(body);
  assert.equal(parsed.credits, null);
  assert.equal(quota.statusText(parsed.windows, parsed.credits), '5h 90%');
  const tip = quota.tooltipText(parsed, new Date(), null);
  assert.doesNotMatch(tip, /Purchased credits/);
});

test('zero-usage fresh window without nextResetTime is kept, not zero-remaining', () => {
  const body = {
    data: {
      limits: [
        { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 0 }, // used 0
        { type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage: 10, nextResetTime: 1787640000000 },
      ],
    },
  };
  const parsed = quota.parseUsageResponse(body);
  assert.equal(parsed.windows[0].usedPercent, 0);
  assert.equal(parsed.windows[0].remainingPercent, 100);
  assert.equal(parsed.windows[0].resetAt, null); // absent reset tolerated
});

test('missing percentage keeps window with unknown values', () => {
  const body = {
    data: {
      limits: [
        { type: 'TOKENS_LIMIT', unit: 3, number: 5 },
        { type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage: 50 },
      ],
    },
  };
  const parsed = quota.parseUsageResponse(body);
  assert.equal(parsed.windows[0].remainingPercent, undefined);
  assert.equal(parsed.windows[1].remainingPercent, 50);
  assert.equal(quota.statusText(parsed.windows), '5h · W 50%');
});

test('unknown extra TOKENS_LIMIT windows display generically', () => {
  const body = {
    data: {
      limits: [
        { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 10 },
        { type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage: 20 },
        { type: 'TOKENS_LIMIT', unit: 9, number: 2, percentage: 30, brandNew: true },
      ],
    },
  };
  const parsed = quota.parseUsageResponse(body);
  assert.equal(parsed.windows.length, 3);
  const extra = parsed.windows[2];
  assert.equal(extra.kind, 'generic');
  assert.equal(extra.remainingPercent, 70);
  // Unknown unit code: neutral label rather than a guessed duration.
  assert.equal(extra.label, 'Window');
  assert.equal(extra.short, '');
});

test('extra windows with known unit codes get duration labels', () => {
  const body = {
    data: {
      limits: [
        { type: 'TOKENS_LIMIT', unit: 3, number: 1, percentage: 10 },
        { type: 'TOKENS_LIMIT', unit: 6, number: 4, percentage: 20 },
      ],
    },
  };
  const parsed = quota.parseUsageResponse(body);
  assert.deepEqual(parsed.windows.map((w) => w.short), ['1h', '4w']);
});

test('auth-failure messages are matched narrowly', () => {
  const { AUTH_MESSAGE } = require('../lib/api.js');
  for (const msg of ['token expired', 'Invalid API key', 'API key is invalid', 'Unauthorized']) {
    assert.ok(AUTH_MESSAGE.test(msg), msg);
  }
  for (const msg of ['token limit exceeded', 'key quota exhausted', 'service busy']) {
    assert.ok(!AUTH_MESSAGE.test(msg), msg);
  }
});

test('unknown extra fields everywhere are ignored', () => {
  const body = {
    success: true,
    future: { nested: { deep: 1 } },
    data: {
      level: 'max',
      limits: [
        { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 5, newField: 'x' },
        { type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage: 9, another: [1, 2] },
      ],
    },
  };
  const parsed = quota.parseUsageResponse(body);
  assert.equal(parsed.planType, 'max');
  assert.equal(parsed.windows.length, 2);
});

test('only one window present parses fine', () => {
  const body = { data: { limits: [{ type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage: 61 }] } };
  const parsed = quota.parseUsageResponse(body);
  assert.equal(parsed.windows.length, 1);
  assert.equal(parsed.windows[0].kind, 'week');
  assert.equal(quota.statusText(parsed.windows), 'W 39%');
});

test('malformed bodies return null instead of throwing', () => {
  assert.equal(quota.parseUsageResponse(null), null);
  assert.equal(quota.parseUsageResponse('junk'), null);
  assert.equal(quota.parseUsageResponse({ data: null }), null);
  assert.equal(quota.parseUsageResponse({ data: { limits: 'nope' } }), null);
  assert.equal(quota.parseUsageResponse({ data: { limits: [{ type: 'OTHER', percentage: 5 }] } }), null);
});

test('error-wrapper bodies (success:false) have no data and parse null', () => {
  assert.equal(quota.parseUsageResponse({ code: 401, msg: 'token expired', success: false }), null);
});

test('percentage clamping protects the display', () => {
  const body = {
    data: {
      limits: [
        { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 130 },
        { type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage: -4 },
      ],
    },
  };
  const parsed = quota.parseUsageResponse(body);
  assert.equal(parsed.windows[0].usedPercent, 100);
  assert.equal(parsed.windows[0].remainingPercent, 0);
  assert.equal(parsed.windows[1].usedPercent, 0);
  assert.equal(parsed.windows[1].remainingPercent, 100);
});

test('severityBand thresholds apply to lowest window', () => {
  const w = (remainingPercent) => ({ remainingPercent });
  assert.equal(quota.severityBand([w(75), w(85)]), 'green');
  assert.equal(quota.severityBand([w(75), w(25)]), 'amber');
  assert.equal(quota.severityBand([w(75), w(5)]), 'red');
  assert.equal(quota.severityBand([], {}), null);
});

test('severityBand honors custom thresholds and falls back safely', () => {
  const w = (remainingPercent) => ({ remainingPercent });
  const t = { redBelowPercent: 20, amberBelowPercent: 50 };
  assert.equal(quota.severityBand([w(15)], t), 'red');
  assert.equal(quota.severityBand([w(45)], t), 'amber');
  assert.equal(quota.severityBand([w(50)], t), 'green');
  assert.equal(quota.severityBand([w(15)], null), 'amber');
  assert.equal(quota.severityBand([w(15)], 'junk'), 'amber');
});

test('normalizeThresholds clamps and fills defaults', () => {
  assert.deepEqual(quota.normalizeThresholds(undefined), { redBelowPercent: 10, amberBelowPercent: 30 });
  assert.deepEqual(quota.normalizeThresholds({ redBelowPercent: 200 }), { redBelowPercent: 100, amberBelowPercent: 30 });
});

test('keyPaths returns sanitized structural keys only', () => {
  const paths = quota.keyPaths({ data: { limits: [{ secret: 'x' }] } });
  assert.ok(paths.includes('data.limits.secret'));
  assert.equal(paths.filter((p) => p.includes('secret=x')).length, 0);
});
