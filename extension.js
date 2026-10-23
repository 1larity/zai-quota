'use strict';

const vscode = require('vscode');
const api = require('./lib/api');
const { createMonitor } = require('./lib/monitor');
const quota = require('./lib/quota');

const SECRET_KEY = 'zaiQuota.apiKey';
const USAGE_URL = 'https://z.ai/manage-apikey/usage';

let secrets = null;
let monitor = null;

function friendlyError(error) {
  switch (error && error.reason) {
    case 'no-key':
      return "No z.ai API key set.\nRun 'GLM Quota: Set API Key' (or click this item) to add it.";
    case 'unauthorized':
      return "z.ai rejected the API key.\nRun 'GLM Quota: Set API Key' to update it.";
    case 'timeout':
      return 'z.ai usage endpoint did not respond in time.';
    case 'network':
      return error.message;
    default:
      return `GLM quota unavailable: ${(error && error.message) || 'unknown error'}`;
  }
}

async function promptForApiKey() {
  const key = await vscode.window.showInputBox({
    prompt: 'z.ai API key (GLM Coding Plan). Stored in VS Code secret storage; never written to settings or files.',
    password: true,
    ignoreFocusOut: true,
  });
  const trimmed = (key || '').trim();
  if (trimmed === '') {
    return null; // cancelled or empty
  }
  await secrets.store(SECRET_KEY, trimmed);
  monitor.log('api key set');
  return trimmed;
}

async function load(interactive) {
  let apiKey = await secrets.get(SECRET_KEY);
  if (!apiKey && interactive) {
    apiKey = await promptForApiKey();
  }
  if (!apiKey) {
    throw Object.assign(new Error('no API key set'), { reason: 'no-key' });
  }
  const host = vscode.workspace.getConfiguration('zaiQuota').get('host');
  const { body, host: usedHost } = await api.fetchUsage(apiKey, { host });
  const parsed = quota.parseUsageResponse(body);
  if (!parsed) {
    throw Object.assign(new Error('usage response not recognized'), {
      reason: 'shape',
      diagnostic: `${usedHost} top-level keys: ${quota.keyPaths(body).slice(0, 24).join(', ')}`,
    });
  }
  return { parsed, summary: `via ${usedHost}, windows=${parsed.windows.length}` };
}

// The key changed: drop data shown for the old key, then refresh.
function restartWithNewKey() {
  monitor.reset();
  monitor.refresh(false);
}

function activate(context) {
  secrets = context.secrets;
  monitor = createMonitor(vscode, context, {
    section: 'zaiQuota',
    name: 'GLM Quota',
    label: 'GLM',
    icon: '$(zap)',
    priority: 49,
    usageUrl: USAGE_URL,
    load,
    statusText: (parsed) => quota.statusText(parsed.windows, parsed.credits),
    tooltip: quota.tooltipText,
    friendlyError,
    credentialReasons: ['no-key', 'unauthorized'],
  });

  context.subscriptions.push(
    vscode.commands.registerCommand('zaiQuota.setApiKey', async () => {
      if (await promptForApiKey()) {
        restartWithNewKey();
      }
    }),
    vscode.commands.registerCommand('zaiQuota.clearApiKey', async () => {
      await secrets.delete(SECRET_KEY);
      monitor.log('api key cleared');
      restartWithNewKey();
    })
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
