'use strict';

// Per-user registry of installed quota extensions. Each extension records
// where its cli.js lives, so any one CLI can find the others and collate all
// quota data without depending on them. Entries are plain JSON files:
//   <dir>/<provider>.json  ->  { provider, cli, version, mcpEnabled, registeredAt }
// mcpEnabled mirrors the extension's opt-in MCP toggle; the MCP server
// answers for a provider only while it is true.
// <dir> is $QUOTA_MONITOR_DIR, else $XDG_CONFIG_HOME/quota-monitor, else
// ~/.config/quota-monitor (%APPDATA%\quota-monitor on Windows).
// No vscode import.

const fs = require('fs');
const os = require('os');
const path = require('path');

const PROVIDER_ID = /^[a-z][a-z0-9-]{0,31}$/;

function registryDir(env = process.env, home = os.homedir()) {
  if (env.QUOTA_MONITOR_DIR) {
    return env.QUOTA_MONITOR_DIR;
  }
  if (process.platform === 'win32' && env.APPDATA) {
    return path.join(env.APPDATA, 'quota-monitor');
  }
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'quota-monitor');
}

function readEntry(file) {
  try {
    const e = JSON.parse(fs.readFileSync(file, 'utf8'));
    return e && typeof e === 'object' ? e : null;
  } catch {
    return null;
  }
}

// Record (or refresh) this extension's entry. `mcpEnabled` is set only by
// the extension; a CLI or MCP server registering itself keeps the stored
// value (absent means off). Best effort: returns false instead of throwing,
// since registration must never break the extension.
function register({ provider, cliPath, version, mcpEnabled }, dir = registryDir()) {
  try {
    if (!PROVIDER_ID.test(provider) || !path.isAbsolute(cliPath)) {
      return false;
    }
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, `${provider}.json`);
    const previous = readEntry(target);
    const entry = {
      provider,
      cli: cliPath,
      version: version || null,
      mcpEnabled: typeof mcpEnabled === 'boolean' ? mcpEnabled : Boolean(previous && previous.mcpEnabled === true),
      registeredAt: new Date().toISOString(),
    };
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(entry)}\n`);
    fs.renameSync(tmp, target);
    return true;
  } catch {
    return false;
  }
}

// Entries whose cli.js still exists. Entries pointing at a removed install
// are deleted, so an uninstalled extension drops out on its own.
function listRegistered(dir = registryDir()) {
  let names;
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  const entries = [];
  for (const name of names.sort()) {
    const file = path.join(dir, name);
    try {
      const e = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!e || !PROVIDER_ID.test(e.provider) || `${e.provider}.json` !== name || !path.isAbsolute(e.cli)) {
        continue;
      }
      if (fs.existsSync(e.cli)) {
        entries.push(e);
      } else {
        fs.rmSync(file, { force: true });
      }
    } catch {
      // unreadable or malformed entry: ignore
    }
  }
  return entries;
}

// True only when the provider's extension has turned its MCP toggle on.
function isMcpEnabled(provider, dir = registryDir()) {
  if (!PROVIDER_ID.test(provider)) {
    return false;
  }
  const e = readEntry(path.join(dir, `${provider}.json`));
  return Boolean(e && e.provider === provider && e.mcpEnabled === true);
}

module.exports = { registryDir, register, listRegistered, isMcpEnabled };
