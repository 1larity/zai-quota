'use strict';

// Status bar plumbing shared by the quota monitors (claude-quota, codex-quota,
// zai-quota). The source of truth is shared/monitor.js next to the three
// projects; ../sync-shared.sh copies it into each project's lib/.
//
// Owns the status item, output channel, refresh timer, click handling,
// last-known-good display and color bands. Each extension supplies only how
// to load and describe its own data. `vscode` is passed in so this module
// stays loadable from plain node.

const common = require('./common');

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
// Returns { refresh(interactive), reset(), log(line) }.
function createMonitor(vscode, context, options) {
  const credentialReasons = new Set(options.credentialReasons || []);
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

  function render(text, tooltip, band) {
    statusItem.text = text;
    statusItem.tooltip = tooltip;
    statusItem.backgroundColor = BAND_BACKGROUNDS[band]
      ? new vscode.ThemeColor(BAND_BACKGROUNDS[band])
      : undefined;
    statusItem.color = band === 'green' ? GREEN_FOREGROUND : undefined;
  }

  function renderLoading() {
    statusItem.text = `$(sync~spin) ${options.label}`;
    statusItem.tooltip = `${options.name}: refreshing…`;
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
      statusItem.tooltip = options.tooltip(
        lastGood.parsed,
        lastGood.fetchedAt,
        friendly.replace(/\n/g, ' ')
      );
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

  restartTimer();
  refresh(false);
  log('activated');

  return { refresh, reset, log };
}

module.exports = { createMonitor };
