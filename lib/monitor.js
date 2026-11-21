'use strict';

// Status bar plumbing shared by the quota monitors (claude-quota, codex-quota,
// zai-quota).
//
// Owns the status item, output channel, refresh timer, click handling,
// last-known-good display and color bands. Each extension supplies only how
// to load and describe its own data. `vscode` is passed in so this module
// stays loadable from plain node.

const common = require('./common');
const registry = require('./registry');

const MIN_INTERVAL_SECONDS = 15;

// VS Code's extension host only allows two background colors on status bar
// items (see ExtHostStatusBarItem.ALLOWED_BACKGROUND_COLORS):
//   statusBarItem.errorBackground   (dark red tint)
//   statusBarItem.warningBackground (amber tint)
// Any other background id is silently dropped, so a green background is not
// possible. For the green band we color the foreground text instead. The hex
// is a constant (not a ThemeColor and not window.activeColorTheme, which is a
// proposed API): #2EA043 stays readable on both dark and light status bars.
const BAND_BACKGROUNDS = {
  red: 'statusBarItem.errorBackground',
  amber: 'statusBarItem.warningBackground',
};
const GREEN_FOREGROUND = '#2EA043';

// Status bar items report every click as one command invocation; there is no
// double-click event. A second invocation within DOUBLE_CLICK_MS cancels the
// pending single-click action and opens the usage page instead.
const DOUBLE_CLICK_MS = 300;

// Options:
//   section            configuration section and command prefix ('codexQuota')
//   name               status item / output channel name ('Codex Quota')
//   label              short status bar label ('Codex')
//   icon               codicon shown next to live data ('$(pulse)')
//   priority           status bar priority (left alignment)
//   usageUrl           page for double click and the Open Usage Page command
//   load(interactive)  resolves { parsed, summary }; rejects classified errors
//                      (err.reason, optional err.diagnostic for the log);
//                      parsed.windows drives the color band
//   statusText(parsed) compact text after the label, e.g. "5h 71% · W 83%"
//   tooltip(parsed, fetchedAt, staleError)
//   friendlyError(error) -> tooltip text for a failed refresh
//   credentialReasons  error reasons meaning the credential is missing or
//                      dead: show $(key) and drop the last known good data,
//                      since stale percentages would be misleading
//   agent              optional { provider, cliPath, mcpPath, version, env() }:
//                      registers cli.js for `--all`, and adds the opt-in MCP
//                      server. Its toggle (setting <section>.mcp.enabled,
//                      default off) sits at the foot of every tooltip; while
//                      on, mcp.js answers for this provider and is listed in
//                      VS Code's MCP servers. env() resolves extra environment
//                      for that server (credentials), read only as VS Code
//                      starts it.
// Returns { refresh(interactive), reset(), log(line) }.
function createMonitor(vscode, context, options) {
  const credentialReasons = new Set(options.credentialReasons || []);
  const agent = options.agent || null;
  const toggleCommand = `${options.section}.toggleMcp`;
  let tooltipText = ''; // plain text of the current tooltip, before the MCP footer
  let mcpChanged = null; // fires when the VS Code MCP server list changes
  let outputChannel = null;
  let timer = null;
  let clickTimer = null;
  let refreshing = false;
  let queuedInteractive = null; // a refresh requested mid-flight, or null
  let missedTick = false;
  let generation = 0; // bumped by reset() to discard in-flight results
  let lastGood = null; // { parsed, fetchedAt }

  const statusItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    options.priority
  );
  statusItem.name = options.name;
  statusItem.command = `${options.section}.statusClick`;

  function config() {
    return vscode.workspace.getConfiguration(options.section);
  }

  function log(line) {
    // Sanitized structural logging only: no credentials, no raw responses,
    // no account values.
    if (!outputChannel) {
      outputChannel = vscode.window.createOutputChannel(options.name);
    }
    outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] ${line}`);
  }

  function intervalMs() {
    const seconds = Number(config().get('refreshIntervalSeconds')) || 60;
    return Math.max(MIN_INTERVAL_SECONDS, seconds) * 1000;
  }

  function restartTimer() {
    if (timer) {
      clearInterval(timer);
    }
    timer = setInterval(() => {
      // Every open window runs its own copy of the extension; only the
      // focused one polls. A window that missed ticks catches up on focus.
      if (!vscode.window.state.focused) {
        missedTick = true;
        return;
      }
      refresh(false);
    }, intervalMs());
  }

  function mcpEnabled() {
    return config().get('mcp.enabled') === true;
  }

  // Plain tooltip text as Markdown, line breaks kept, plus the MCP toggle.
  function withMcpFooter(text) {
    const escape = (line) => line.replace(/[\\`*_{}[\]()#+\-.!|<>~]/g, '\\$&');
    const body = text
      .split(/\n{2,}/)
      .map((block) => block.split('\n').map(escape).join('  \n'))
      .join('\n\n');
    const on = mcpEnabled();
    const md = new vscode.MarkdownString(
      `${body}\n\n---\n\nMCP server: **${on ? 'on' : 'off'}** · ` +
        `[Turn ${on ? 'off' : 'on'}](command:${toggleCommand} "${on ? 'Stop' : 'Let'} coding agents ` +
        `read this quota over MCP")`
    );
    md.isTrusted = { enabledCommands: [toggleCommand] };
    return md;
  }

  function setTooltip(text) {
    tooltipText = text;
    statusItem.tooltip = agent ? withMcpFooter(text) : text;
  }

  // Mirror the toggle into the registry (read by mcp.js) and VS Code's list.
  function syncAgent() {
    registry.register({
      provider: agent.provider,
      cliPath: agent.cliPath,
      version: agent.version,
      mcpEnabled: mcpEnabled(),
    });
    if (mcpChanged) {
      mcpChanged.fire();
    }
  }

  async function toggleMcp() {
    const next = !mcpEnabled();
    await config().update('mcp.enabled', next, vscode.ConfigurationTarget.Global);
    log(`mcp server ${next ? 'on' : 'off'}`);
  }

  // VS Code 1.101+ lists provider-supplied MCP servers for its own chat.
  // Older hosts lack the API; the toggle still drives mcp.js for other agents.
  function registerVsCodeMcp() {
    if (!vscode.lm || typeof vscode.lm.registerMcpServerDefinitionProvider !== 'function' ||
        typeof vscode.McpStdioServerDefinition !== 'function') {
      return;
    }
    mcpChanged = new vscode.EventEmitter();
    context.subscriptions.push(
      mcpChanged,
      vscode.lm.registerMcpServerDefinitionProvider(`${options.section}.mcp`, {
        onDidChangeMcpServerDefinitions: mcpChanged.event,
        provideMcpServerDefinitions: () =>
          mcpEnabled()
            ? [
                // The extension host binary runs as plain node with
                // ELECTRON_RUN_AS_NODE, so no separate node install is needed.
                new vscode.McpStdioServerDefinition(
                  options.name,
                  process.execPath,
                  [agent.mcpPath],
                  { ELECTRON_RUN_AS_NODE: '1' },
                  agent.version
                ),
              ]
            : [],
        resolveMcpServerDefinition: async (server) => {
          // Credentials join the environment only as the server starts.
          const extra = agent.env ? await agent.env() : {};
          server.env = { ...(server.env || {}), ...extra };
          return server;
        },
      })
    );
  }

  function render(text, tooltip, band) {
    statusItem.text = text;
    setTooltip(tooltip);
    statusItem.backgroundColor = BAND_BACKGROUNDS[band]
      ? new vscode.ThemeColor(BAND_BACKGROUNDS[band])
      : undefined;
    statusItem.color = band === 'green' ? GREEN_FOREGROUND : undefined;
  }

  function renderLoading() {
    statusItem.text = `$(sync~spin) ${options.label}`;
    setTooltip(`${options.name}: refreshing…`);
  }

  function renderSuccess(parsed, fetchedAt) {
    const band = common.severityBand(parsed.windows, config().get('thresholds'));
    const text = options.statusText(parsed);
    render(
      `${options.icon} ${options.label}${text ? ` ${text}` : ''}`,
      options.tooltip(parsed, fetchedAt, null),
      band
    );
    return band;
  }

  function renderFailure(error) {
    const friendly = options.friendlyError(error);
    if (error && credentialReasons.has(error.reason)) {
      lastGood = null;
      render(`$(key) ${options.label} ?`, friendly, null);
    } else if (lastGood) {
      // Keep the last known good text and colors; mark data stale.
      setTooltip(options.tooltip(
        lastGood.parsed,
        lastGood.fetchedAt,
        friendly.replace(/\n/g, ' ')
      ));
    } else {
      render(`$(warning) ${options.label} ?`, friendly, null);
    }
  }

  async function refresh(interactive) {
    if (refreshing) {
      // No overlapping requests; run once more after the current one.
      queuedInteractive = Boolean(queuedInteractive || interactive);
      return;
    }
    refreshing = true;
    const startedIn = generation;
    try {
      if (!lastGood) {
        renderLoading();
      }
      const { parsed, summary } = await options.load(interactive);
      if (startedIn !== generation) {
        return; // reset() while in flight; this result is for old state
      }
      lastGood = { parsed, fetchedAt: new Date() };
      const band = renderSuccess(parsed, lastGood.fetchedAt);
      log(`refresh ok (${summary}, band=${band === null ? 'none' : band})`);
    } catch (error) {
      if (startedIn !== generation) {
        return;
      }
      renderFailure(error);
      const allowedReasons = new Set(['not-found', 'not-executable', 'exited', 'timeout',
        'not-authenticated', 'unavailable', 'no-key', 'unauthorized', 'network',
        'rate-limited', 'http', 'bad-json', 'api', 'shape', 'malformed', 'expired']);
      const reason = error && allowedReasons.has(error.reason) ? error.reason : 'error';
      log(`refresh failed: ${reason}`);
    } finally {
      refreshing = false;
      if (queuedInteractive !== null) {
        const queued = queuedInteractive;
        queuedInteractive = null;
        refresh(queued);
      }
    }
  }

  // Forget the displayed data (e.g. after the credential changed). Any
  // refresh still in flight is discarded when it lands.
  function reset() {
    generation += 1;
    lastGood = null;
  }

  function openUsagePage() {
    vscode.env.openExternal(vscode.Uri.parse(options.usageUrl));
  }

  function statusClick() {
    if (clickTimer) {
      clearTimeout(clickTimer);
      clickTimer = null;
      openUsagePage();
      return;
    }
    clickTimer = setTimeout(() => {
      clickTimer = null;
      refresh(true);
    }, DOUBLE_CLICK_MS);
  }

  renderLoading();
  statusItem.show();

  context.subscriptions.push(
    statusItem,
    vscode.commands.registerCommand(`${options.section}.statusClick`, () => statusClick()),
    vscode.commands.registerCommand(`${options.section}.openUsagePage`, () => openUsagePage()),
    vscode.commands.registerCommand(`${options.section}.refresh`, () => refresh(true)),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (agent && event.affectsConfiguration(`${options.section}.mcp`)) {
        syncAgent();
        setTooltip(tooltipText); // show the new toggle state at once
      }
      if (event.affectsConfiguration(options.section)) {
        restartTimer();
        refresh(false);
      }
    }),
    vscode.window.onDidChangeWindowState((state) => {
      if (state.focused && missedTick) {
        missedTick = false;
        refresh(false);
      }
    }),
    {
      dispose() {
        clearInterval(timer);
        clearTimeout(clickTimer);
        if (outputChannel) {
          outputChannel.dispose();
        }
      },
    }
  );

  if (agent) {
    context.subscriptions.push(vscode.commands.registerCommand(toggleCommand, () => toggleMcp()));
    registerVsCodeMcp();
    syncAgent();
  }

  restartTimer();
  refresh(false);
  log('activated');

  return { refresh, reset, log };
}

module.exports = { createMonitor };
