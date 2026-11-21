'use strict';

// Model Context Protocol server over stdio, shared by the quota monitors.
// Gives a coding agent (Claude Code, Codex, Kilo, VS Code chat) the same
// JSON quota documents as cli.js through two tools:
//   get_quota       one provider (default: this extension's own)
//   get_all_quotas  every installed provider, plus the tightest window
// A provider answers only while its extension's MCP toggle is on (setting
// <section>.mcp.enabled, mirrored into the registry); otherwise its document
// is ok:false with reason 'mcp-disabled'. The toggle is read on every call,
// so turning it on or off needs no restart.
//
// Transport: newline-delimited JSON-RPC 2.0 on stdin/stdout; stdout carries
// protocol messages only. No vscode import, no dependencies.

const cli = require('./cli');
const registry = require('./registry');

const SUPPORTED_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const STRUCTURED_FROM = '2025-06-18';

const PROVIDERS = {
  claude: { name: 'Claude Quota', setting: 'claudeQuota.mcp.enabled' },
  codex: { name: 'Codex Quota', setting: 'codexQuota.mcp.enabled' },
  glm: { name: 'GLM Quota', setting: 'zaiQuota.mcp.enabled' },
};

const RPC = { parse: -32700, invalidRequest: -32600, methodNotFound: -32601, invalidParams: -32602 };

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id: id === undefined ? null : id, error: { code, message } };
}

function disabledDoc(provider, now) {
  const p = PROVIDERS[provider];
  const where = p
    ? `Turn it on from the ${p.name} status bar tooltip in VS Code (setting ${p.setting}).`
    : 'Turn it on from its status bar tooltip in VS Code.';
  return cli.failure(provider, now, 'mcp-disabled', `MCP access to ${provider} quota is off. ${where}`);
}

function toolDefinitions(ownProvider) {
  return [
    {
      name: 'get_quota',
      title: 'Get quota',
      description:
        `Remaining subscription quota for one provider (default ${ownProvider}) as a JSON document: ` +
        'band (green/amber/red), and windows[] with remainingPercent, resetAt and resetsInSeconds. ' +
        'ok:false carries error.reason, e.g. mcp-disabled, expired, no-key.',
      inputSchema: {
        type: 'object',
        properties: {
          provider: {
            type: 'string',
            enum: Object.keys(PROVIDERS),
            description: `Provider to read; defaults to ${ownProvider}.`,
          },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    {
      name: 'get_all_quotas',
      title: 'Get all quotas',
      description:
        'Quota of every installed provider (claude, codex, glm) in one JSON document: providers.<id> ' +
        'per provider, and summary.worstBand and summary.tightest (provider and window with the least left). ' +
        'Use before choosing which model or agent to hand work to.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
  ];
}

// Options: { provider, load, extra, version, cliPath, registryDir, runChild,
// stdin, stdout, now }. Resolves when stdin ends and every request has been
// answered.
function runMcpServer(options) {
  const { provider, load } = options;
  const stdin = options.stdin || process.stdin;
  const stdout = options.stdout || process.stdout;
  const dir = options.registryDir || registry.registryDir();
  const run = options.runChild || cli.runChild;
  const clock = options.now || (() => new Date());
  let protocolVersion = SUPPORTED_VERSIONS[0];

  if (options.cliPath) {
    // Keeps get_all_quotas on other servers able to reach this provider.
    registry.register({ provider, cliPath: options.cliPath, version: options.version }, dir);
  }

  async function readProvider(target) {
    const now = clock();
    if (!registry.isMcpEnabled(target, dir)) {
      return disabledDoc(target, now);
    }
    if (target === provider) {
      return cli.readSnapshot({ provider, load, extra: options.extra, now });
    }
    const entry = registry.listRegistered(dir).find((e) => e.provider === target);
    if (!entry) {
      return cli.failure(target, now, 'not-installed', `No ${target} quota extension is registered on this machine.`);
    }
    return run(entry);
  }

  async function readAll() {
    const ids = new Set([provider, ...registry.listRegistered(dir).map((e) => e.provider)]);
    const docs = await Promise.all([...ids].map((id) => readProvider(id)));
    docs.sort((a, b) => a.provider.localeCompare(b.provider));
    return cli.collate(docs, clock());
  }

  function toolResult(doc, ok) {
    const result = {
      content: [{ type: 'text', text: JSON.stringify(doc) }],
      isError: !ok,
    };
    if (protocolVersion >= STRUCTURED_FROM) {
      result.structuredContent = doc;
    }
    return result;
  }

  async function callTool(id, params) {
    const name = params && params.name;
    const args = (params && params.arguments) || {};
    if (name === 'get_quota') {
      const target = args.provider === undefined ? provider : args.provider;
      if (!Object.prototype.hasOwnProperty.call(PROVIDERS, target)) {
        return rpcError(id, RPC.invalidParams, `Unknown provider: ${String(target)}`);
      }
      const doc = await readProvider(target);
      return { jsonrpc: '2.0', id, result: toolResult(doc, doc.ok) };
    }
    if (name === 'get_all_quotas') {
      const doc = await readAll();
      return { jsonrpc: '2.0', id, result: toolResult(doc, doc.ok) };
    }
    return rpcError(id, RPC.invalidParams, `Unknown tool: ${String(name)}`);
  }

  // Resolves the response for one message, or null for a notification.
  async function handle(msg) {
    if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      return rpcError(msg && msg.id, RPC.invalidRequest, 'Invalid request');
    }
    const isRequest = msg.id !== undefined && msg.id !== null;
    if (!isRequest) {
      return null; // notifications/initialized, cancellations: nothing to answer
    }
    switch (msg.method) {
      case 'initialize': {
        const requested = msg.params && msg.params.protocolVersion;
        protocolVersion = SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0];
        return {
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            protocolVersion,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: `${provider}-quota`, version: options.version || '0.0.0' },
            instructions:
              'Read-only subscription quota for Claude, Codex and GLM. Call get_all_quotas before long or ' +
              'expensive work; red means under 10% left in some window, amber under 30%.',
          },
        };
      }
      case 'ping':
        return { jsonrpc: '2.0', id: msg.id, result: {} };
      case 'tools/list':
        return { jsonrpc: '2.0', id: msg.id, result: { tools: toolDefinitions(provider) } };
      case 'tools/call':
        return callTool(msg.id, msg.params);
      default:
        return rpcError(msg.id, RPC.methodNotFound, `Method not found: ${msg.method}`);
    }
  }

  function send(response) {
    if (response) {
      stdout.write(`${JSON.stringify(response)}\n`);
    }
  }

  async function onLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      send(rpcError(null, RPC.parse, 'Parse error'));
      return;
    }
    if (Array.isArray(msg)) {
      // JSON-RPC batch (protocol 2025-03-26).
      const responses = (await Promise.all(msg.map((m) => handle(m).catch(() => null)))).filter(Boolean);
      if (responses.length > 0) {
        stdout.write(`${JSON.stringify(responses)}\n`);
      }
      return;
    }
    send(await handle(msg).catch(() => rpcError(msg && msg.id, RPC.invalidRequest, 'Request failed')));
  }

  return new Promise((resolve) => {
    const pending = new Set();
    let buffer = '';
    let ended = false;
    const maybeDone = () => {
      if (ended && pending.size === 0) {
        resolve();
      }
    };
    stdin.setEncoding('utf8');
    stdin.on('data', (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) {
          const job = onLine(line).finally(() => {
            pending.delete(job);
            maybeDone();
          });
          pending.add(job);
        }
      }
    });
    stdin.on('end', () => {
      ended = true;
      maybeDone();
    });
  });
}

module.exports = { runMcpServer, toolDefinitions, SUPPORTED_VERSIONS, PROVIDERS };
