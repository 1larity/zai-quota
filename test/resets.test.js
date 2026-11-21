'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const quota = require('../lib/quota');

const NOW = new Date('2026-11-01T00:00:00Z');
const BODY = {
  code: 200,
  success: true,
  data: {
    targetType: 'PERSONAL',
    lastFiveHourResetTime: '2026-09-11 06:02:16',
    lastWeekResetTime: null,
    fiveHourResets: [
      { recordId: 1, expireTime: '2026-10-18 23:59:59', available: false },
      { recordId: 2, expireTime: '2026-11-07 23:59:59', available: true },
      { recordId: 3, expireTime: '2026-11-05 23:59:59', available: true },
      { recordId: 4, expireTime: '2026-10-30 23:59:59', available: true }, // expired
    ],
    weekResets: [
      { recordId: 5, expireTime: '2026-11-07 23:59:59', available: true },
    ],
  },
};

test('counts available, unexpired reset packs and finds the nearest expiry', () => {
  const r = quota.parseResetsResponse(BODY, NOW);
  assert.equal(r.fiveHour.available, 2);
  assert.equal(r.week.available, 1);
  assert.equal(r.fiveHour.nextExpiry.toISOString(), '2026-11-05T15:59:59.000Z');
  assert.equal(r.lastFiveHour.toISOString(), '2026-09-10T22:02:16.000Z');
  assert.equal(r.lastWeek, null);
});

test('unrecognized or empty bodies parse to null', () => {
  assert.equal(quota.parseResetsResponse(null), null);
  assert.equal(quota.parseResetsResponse({ success: true, data: {} }), null);
  assert.equal(quota.parseResetsResponse({ success: true, data: { fiveHourResets: 'x' } }), null);
});

test('status text appends an R segment only when packs are available', () => {
  const windows = [{ short: '5h', remainingPercent: 60 }];
  const resets = quota.parseResetsResponse(BODY, NOW);
  assert.equal(quota.statusText(windows, null, resets), '5h 60% · R 2/1');
  const none = quota.parseResetsResponse({ data: { fiveHourResets: [], weekResets: [] } }, NOW);
  assert.equal(quota.statusText(windows, null, none), '5h 60%');
  assert.equal(quota.statusText(windows, null, null), '5h 60%');
});

test('tooltip lists reset packs', () => {
  const parsed = {
    windows: [],
    credits: null,
    planType: null,
    resets: quota.parseResetsResponse(BODY, NOW),
  };
  const text = quota.tooltipText(parsed, NOW, null);
  assert.match(text, /Reset packs\n5-hour: 2 available \(next expires .+\)\nWeekly: 1 available/);
  assert.match(text, /Last 5-hour reset: /);
  assert.doesNotMatch(text, /Last weekly reset/);
});
