'use strict';

// How cli.js and mcp.js read the GLM Coding Plan quota outside VS Code. The
// extension's VS Code secret storage is out of reach from a terminal, so the
// key comes from ZAI_API_KEY or ZAI_API_KEY_COMMAND; ZAI_HOST selects the
// API host (default api.z.ai).

const { execFile } = require('child_process');
const api = require('./api');
const quota = require('./quota');
const { serializeWindow } = require('./cli');

function serializeResets(resets) {
  if (!resets) {
    return null;
  }
  const pack = (p) => ({
    available: p.available,
    nextExpiry: p.nextExpiry ? p.nextExpiry.toISOString() : null,
  });
  return {
    fiveHour: pack(resets.fiveHour),
    week: pack(resets.week),
    lastFiveHourReset: resets.lastFiveHour ? resets.lastFiveHour.toISOString() : null,
    lastWeekReset: resets.lastWeek ? resets.lastWeek.toISOString() : null,
  };
}

const KEY_COMMAND_TIMEOUT_MS = 15000;

function noKey(message) {
  return Object.assign(new Error(message), { reason: 'no-key' });
}

// ZAI_API_KEY, else the trimmed output of ZAI_API_KEY_COMMAND (for example a
// keyring lookup), so agent configs can name a command instead of holding
// the key. The command's output never appears in errors.
function apiKey() {
  const direct = (process.env.ZAI_API_KEY || '').trim();
  if (direct) {
    return Promise.resolve(direct);
  }
  const command = (process.env.ZAI_API_KEY_COMMAND || '').trim();
  if (!command) {
    return Promise.reject(noKey('Set ZAI_API_KEY, or ZAI_API_KEY_COMMAND to a command that prints the key.'));
  }
  const [shell, args] =
    process.platform === 'win32'
      ? [process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', command]]
      : ['/bin/sh', ['-c', command]];
  return new Promise((resolve, reject) => {
    execFile(shell, args, { timeout: KEY_COMMAND_TIMEOUT_MS, maxBuffer: 64 * 1024, windowsHide: true }, (error, stdout) => {
      const key = String(stdout || '').trim();
      if (error || !key) {
        reject(noKey('ZAI_API_KEY_COMMAND failed or printed nothing.'));
        return;
      }
      resolve(key);
    });
  });
}

async function load() {
  const key = await apiKey();
  const host = process.env.ZAI_HOST || undefined;
  const { body } = await api.fetchUsage(key, { host });
  const parsed = quota.parseUsageResponse(body);
  if (!parsed) {
    throw Object.assign(new Error('usage response not recognized'), { reason: 'shape' });
  }
  try {
    const { body: resetsBody } = await api.fetchResets(key, { host });
    parsed.resets = quota.parseResetsResponse(resetsBody);
  } catch {
    parsed.resets = null; // optional detail
  }
  return { parsed };
}

module.exports = {
  provider: 'glm',
  load,
  extra: (parsed, now) => {
    return {
      credits: parsed.credits ? serializeWindow(parsed.credits, now) : null,
      resets: serializeResets(parsed.resets),
    };
  },
  helpExtra: 'Environment: ZAI_API_KEY or ZAI_API_KEY_COMMAND (one is required), ZAI_HOST (default api.z.ai).',
};
