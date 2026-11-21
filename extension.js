'use strict';

const vscode = require('vscode');
const api = require('./lib/api');
const path = require('path');
const { createMonitor } = require('./lib/monitor');
const quota = require('./lib/quota');

const SECRET_KEY = 'zaiQuota.apiKey';
const USAGE_URL = 'https://z.ai/manage-apikey/coding-plan/personal/usage';

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
  // Reset packs are optional extra detail: a failed read keeps the quota
  // display and logs the reason only.
  let resetsNote = 'resets=none';
  try {
    const { body: resetsBody } = await api.fetchResets(apiKey, { host });
    parsed.resets = quota.parseResetsResponse(resetsBody);
    resetsNote = parsed.resets ? 'resets=ok' : 'resets=unrecognized';
  } catch (error) {
    resetsNote = `resets=failed:${(error && error.reason) || 'error'}`;
  }
  return { parsed, summary: `via ${usedHost}, windows=${parsed.windows.length}, ${resetsNote}` };
}

// The key changed: drop data shown for the old key, then refresh.
function restartWithNewKey() {
  monitor.reset();
  monitor.refresh(false);
}

// cli.js and the opt-in MCP server (mcp.js), registered by the monitor.
function agentOptions(provider, env) {
  return {
    provider,
    cliPath: path.join(__dirname, 'cli.js'),
    mcpPath: path.join(__dirname, 'mcp.js'),
    version: require('./package.json').version,
    env,
  };
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
    statusText: (parsed) => quota.statusText(parsed.windows, parsed.credits, parsed.resets),
    tooltip: quota.tooltipText,
    friendlyError,
    credentialReasons: ['no-key', 'unauthorized'],
    agent: agentOptions('glm', async () => {
      const env = { ZAI_HOST: vscode.workspace.getConfiguration('zaiQuota').get('host') || 'api.z.ai' };
      const key = await secrets.get(SECRET_KEY);
      if (key) {
        env.ZAI_API_KEY = key;
      }
      return env;
    }),
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
