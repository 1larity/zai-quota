'use strict';

// Pure helpers shared by the quota monitors (claude-quota, codex-quota,
// zai-quota). The source of truth is shared/common.js next to the three
// projects; ../sync-shared.sh copies it into each project's lib/.
// No vscode import, no fs, no network.

const DEFAULT_THRESHOLDS = { redBelowPercent: 10, amberBelowPercent: 30 };

function clampPercent(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.max(0, Math.min(100, value));
}

// Thresholds (percent remaining) come from user settings; invalid values fall
// back to the defaults and are clamped to 0..100.
function normalizeThresholds(thresholds) {
  const t = thresholds && typeof thresholds === 'object' ? thresholds : {};
  const clamp = (value, fallback) =>
    typeof value === 'number' && Number.isFinite(value)
      ? Math.max(0, Math.min(100, value))
      : fallback;
  return {
    redBelowPercent: clamp(t.redBelowPercent, DEFAULT_THRESHOLDS.redBelowPercent),
    amberBelowPercent: clamp(t.amberBelowPercent, DEFAULT_THRESHOLDS.amberBelowPercent),
  };
}

// Color band from the most constrained window (lowest remaining).
// Bands: red below redBelowPercent, amber below amberBelowPercent, else green.
// Red is checked first. Returns null when no window has a known percentage.
function severityBand(windows, thresholds) {
  const remainings = [];
  for (const w of windows) {
    const r = clampPercent(w && w.remainingPercent);
    if (r !== undefined) {
      remainings.push(r);
    }
  }
  if (remainings.length === 0) {
    return null;
  }
  const t = normalizeThresholds(thresholds);
  const lowest = Math.min(...remainings);
  if (lowest < t.redBelowPercent) {
    return 'red';
  }
  if (lowest < t.amberBelowPercent) {
    return 'amber';
  }
  return 'green';
}

// Compact status bar segments (without prefix), e.g. "5h 71% · W 83%".
// Windows marked inStatus: false appear only in the tooltip and color band.
function statusText(windows) {
  const segments = [];
  for (const w of windows) {
    if (!w || w.inStatus === false) {
      continue;
    }
    const r = clampPercent(w.remainingPercent);
    if (r === undefined) {
      if (w.short) {
        segments.push(w.short);
      }
      continue;
    }
    segments.push(w.short ? `${w.short} ${Math.round(r)}%` : `${Math.round(r)}%`);
  }
  return segments.join(' · ');
}

function formatDurationMs(ms) {
  if (!Number.isFinite(ms) || ms < 0) {
    return null;
  }
  if (ms < 60 * 1000) {
    return '<1m';
  }
  const totalMinutes = Math.floor(ms / 60000);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return h === 0 ? `${m}m` : `${h}h ${m}m`;
}

// "Tue 14:00 (in 3h 42m)" style; falls back to absolute-only.
function formatResets(resetAt, now) {
  const abs = resetAt.toLocaleString(undefined, {
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
  const rel = formatDurationMs(resetAt.getTime() - now.getTime());
  return rel ? `${abs} (in ${rel})` : abs;
}

// Tooltip lines for one window. `remainingDetail` is appended to the
// remaining percentage, e.g. " (9,000 of 12,000 left)".
function windowLines(w, now, remainingDetail = '') {
  const lines = [w.label || 'Window'];
  const remaining = clampPercent(w.remainingPercent);
  lines.push(
    remaining === undefined
      ? 'Remaining: unknown'
      : `Remaining: ${Math.round(remaining)}%${remainingDetail}`
  );
  const used = clampPercent(w.usedPercent);
  if (used !== undefined) {
    lines.push(`Used: ${Math.round(used)}%`);
  }
  if (w.resetAt) {
    lines.push(`Resets: ${formatResets(w.resetAt, now)}`);
  }
  return lines;
}

// Detailed hover tooltip: title, plan, optional stale-data warning, one block
// per section (arrays of lines; empty ones are skipped), last refresh time.
function tooltipText(title, planType, fetchedAt, staleError, sections) {
  const lines = [title];
  if (planType) {
    lines.push(`Plan: ${planType}`);
  }
  lines.push('');
  if (staleError) {
    lines.push(`Last refresh failed: ${staleError}`, 'Data below may be stale.', '');
  }
  for (const section of sections) {
    if (section && section.length > 0) {
      lines.push(...section, '');
    }
  }
  lines.push(`Last refreshed: ${fetchedAt.toLocaleTimeString()}`);
  return lines.join('\n');
}

module.exports = {
  DEFAULT_THRESHOLDS,
  clampPercent,
  normalizeThresholds,
  severityBand,
  statusText,
  formatDurationMs,
  formatResets,
  windowLines,
  tooltipText,
};
