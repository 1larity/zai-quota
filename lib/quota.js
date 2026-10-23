'use strict';

// Pure parsing/formatting helpers for the z.ai coding usage response
// (GET /api/monitor/usage/quota/limit):
//   { success, data: { level, limits: [ {type, unit, number, percentage,
//     total, usage, nextResetTime}, ... ] } }
// Windows are TOKENS_LIMIT entries identified by shape, not order:
//   unit 3 + number 5 -> 5-hour window, unit 6 + number 1 -> weekly window.
// Purchased credits ride along as CREDIT_LIMIT entries with the same fields;
// the first one is surfaced separately (parsed.credits) and never competes
// with the token windows for status text, window labels, or color bands.
// A CREDIT_LIMIT-only response still parses (windows: []).
// `percentage` is USED percent; `nextResetTime` is epoch milliseconds and may
// be absent for a fresh window with zero usage. Unknown/extra fields are
// always ignored. No vscode import, no fs, no network.

const common = require('./common');
const { clampPercent } = common;

const TOKENS_LIMIT = 'TOKENS_LIMIT';
const CREDIT_LIMIT = 'CREDIT_LIMIT';
const FIVE_HOUR = { unit: 3, number: 5 };
const WEEKLY = { unit: 6, number: 1 };
// Known `unit` codes; others are unknown and get a neutral label.
const UNIT_SUFFIX = { 3: 'h', 6: 'w' };

function asFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function parseResetAt(nextResetTime) {
  const v = asFiniteNumber(nextResetTime);
  if (v === undefined || v <= 0) {
    return null;
  }
  const ms = v >= 1e12 ? v : v * 1000; // documented as ms; tolerate seconds
  const d = new Date(ms);
  return isNaN(d.getTime()) ? null : d;
}

function matchesShape(limit, shape) {
  return asFiniteNumber(limit.unit) === shape.unit && asFiniteNumber(limit.number) === shape.number;
}

// Adapt one TOKENS_LIMIT entry into a UsageWindow.
function adaptWindow(limit, identification) {
  const usedPercent = clampPercent(limit.percentage);
  const total = asFiniteNumber(limit.total);
  const usage = asFiniteNumber(limit.usage);
  const remainingCredits =
    total !== undefined && usage !== undefined ? total - usage : undefined;
  return {
    kind: identification.kind,
    label: identification.label,
    short: identification.short,
    order: identification.order,
    usedPercent,
    remainingPercent: usedPercent === undefined ? undefined : clampPercent(100 - usedPercent),
    resetAt: parseResetAt(limit.nextResetTime),
    limit: total,
    remaining: remainingCredits,
  };
}

// Parse a z.ai usage response body. Returns { windows, credits, planType,
// shape } or null when neither a token window nor a credit entry was found.
// Never throws.
function parseUsageResponse(body) {
  if (!body || typeof body !== 'object') {
    return null;
  }
  const data = body.data && typeof body.data === 'object' ? body.data : body;
  if (!Array.isArray(data.limits)) {
    return null;
  }
  const isLimit = (l) => l && typeof l === 'object';
  const tokenLimits = data.limits.filter((l) => isLimit(l) && l.type === TOKENS_LIMIT);
  const creditLimits = data.limits.filter((l) => isLimit(l) && l.type === CREDIT_LIMIT);
  if (tokenLimits.length === 0 && creditLimits.length === 0) {
    return null;
  }

  const five = tokenLimits.find((l) => matchesShape(l, FIVE_HOUR));
  const week = tokenLimits.find((l) => matchesShape(l, WEEKLY));
  const genericPool = tokenLimits.filter((l) => l !== five && l !== week);

  const windows = [];
  if (five) {
    windows.push(adaptWindow(five, { kind: '5h', label: '5-hour', short: '5h', order: 0 }));
  }
  if (week) {
    windows.push(adaptWindow(week, { kind: 'week', label: 'Weekly', short: 'W', order: 1 }));
  }
  // Unknown extra TOKENS_LIMIT entries (future window types) still display,
  // with generic labels derived from their shape.
  for (const l of genericPool.slice(0, 2)) {
    const unit = asFiniteNumber(l.unit);
    const number = asFiniteNumber(l.number);
    const suffix = UNIT_SUFFIX[unit];
    const generic = suffix && number !== undefined ? `${number}${suffix}` : '';
    windows.push(adaptWindow(l, { kind: 'generic', label: generic || 'Window', short: generic, order: 2 }));
  }
  if (windows.length === 0 && creditLimits.length === 0) {
    return null;
  }

  const credits =
    creditLimits.length > 0
      ? adaptWindow(creditLimits[0], { kind: 'credits', label: 'Credits', short: 'C', order: 99 })
      : null;

  const planType = typeof data.level === 'string' && data.level ? data.level : null;
  return {
    windows: windows.sort((a, b) => a.order - b.order),
    credits,
    planType,
    shape: 'data.limits',
  };
}

function formatAmount(n) {
  return Math.round(n).toLocaleString(undefined);
}

// " (9,000 of 12,000 left)" when the entry carries absolute amounts.
function amountDetail(w, unit) {
  return w.remaining !== undefined && w.limit !== undefined
    ? ` (${formatAmount(w.remaining)} of ${formatAmount(w.limit)}${unit})`
    : '';
}

// Compact status bar text (without prefix), e.g. "5h 63% · W 81%".
// Purchased credits, when present, append a "C 87%" segment.
function statusText(windows, credits) {
  return common.statusText(credits ? [...windows, credits] : windows);
}

function tooltipText(parsed, fetchedAt, staleError) {
  const sections = parsed.windows.map((w) =>
    common.windowLines(w, fetchedAt, amountDetail(w, ' left'))
  );
  if (parsed.credits) {
    const c = parsed.credits;
    const lines = common.windowLines(
      { ...c, label: 'Purchased credits', usedPercent: undefined },
      fetchedAt,
      amountDetail(c, ' credits')
    );
    sections.push(lines);
  }
  return common.tooltipText('GLM Coding Plan quota', parsed.planType, fetchedAt, staleError, sections);
}

// Key-paths only (never values), used for sanitized diagnostics.
function keyPaths(node, depth = 0, prefix = '') {
  if (!node || typeof node !== 'object' || depth > 3) {
    return [];
  }
  const paths = [];
  for (const [k, v] of Object.entries(node)) {
    const path = prefix ? `${prefix}.${k}` : k;
    paths.push(path);
    if (v && typeof v === 'object') {
      const items = Array.isArray(v) ? v : [v];
      for (const item of items) {
        for (const sub of keyPaths(item, depth + 1, path)) {
          paths.push(sub);
        }
      }
    }
  }
  return paths;
}

module.exports = {
  clampPercent,
  parseUsageResponse,
  severityBand: common.severityBand,
  normalizeThresholds: common.normalizeThresholds,
  statusText,
  formatResets: common.formatResets,
  tooltipText,
  keyPaths,
};
