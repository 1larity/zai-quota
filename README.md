<p align="center"><img src="assets/logo.png" alt="Quota Monitor for GLM (z.ai)" width="640"></p>

# Quota Monitor for GLM (z.ai)

Show z.ai GLM Coding Plan quota usage in the VS Code status bar.

## Features

- See remaining quota in the VS Code status bar, with colour warnings when it runs low.
- Hover for usage windows and reset times.
- Refresh on demand or open the provider's usage page from the Command Palette.
- Adjust the refresh interval and warning thresholds.
- Optionally make quota information available to coding agents through MCP.

## Get started

1. Create a GLM Coding Plan key at [z.ai API Keys](https://z.ai/manage-apikey/apikey-list).
2. Click the **GLM** status bar item, or run **GLM Quota: Set API Key** from the Command Palette, and enter the key. VS Code stores it in secret storage.
3. Hover over the status bar item for quota details and reset times. Click to refresh or double-click to open the usage page.

For a key issued by BigModel in mainland China, set `zaiQuota.host` to `open.bigmodel.cn` in User settings. The default is `api.z.ai`.

Open the Command Palette with `Ctrl+Shift+P` on Windows/Linux or `Cmd+Shift+P` on macOS and search for **GLM Quota** to find the available commands.

## Commands

- **GLM Quota: Refresh**
- **GLM Quota: Open Usage Page**
- **GLM Quota: Set API Key**
- **GLM Quota: Clear API Key**
- **GLM Quota: Toggle MCP Server**

## Reading your quota

The status bar shows remaining percentages for available usage windows. Hover for more detail. By default, a red warning indicates less than 10% remaining, amber indicates less than 30%, and green indicates 30% or more. The most constrained window determines the colour. You can change the thresholds in Settings.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `zaiQuota.host` | `api.z.ai` | Usage endpoint host: `api.z.ai` (international) or `open.bigmodel.cn` (mainland China). Pick the one your key was issued by. |
| `zaiQuota.refreshIntervalSeconds` | `60` | Refresh interval in seconds (minimum 15). |
| `zaiQuota.thresholds` | `{ "redBelowPercent": 10, "amberBelowPercent": 30 }` | Color bands: below `redBelowPercent` → red tint, below `amberBelowPercent` → amber tint, otherwise green text. |
| `zaiQuota.mcp.enabled` | `false` | Lets coding agents read this quota through the MCP server. Toggle it from the link at the foot of the status bar tooltip. |


## Troubleshooting

- A key icon and `GLM ?` means the key is missing or was rejected. Run **GLM Quota: Set API Key** to enter it again.
- A warning icon means the last refresh failed. Hover for the reason and check that `zaiQuota.host` matches the service that issued your key.
- Check the **GLM Quota** output channel under **View > Output** for status messages.

## Privacy and access

The extension sends your key over HTTPS to the configured z.ai or BigModel host. Its usage endpoints are undocumented and may change. The extension sends no telemetry. Never include keys, tokens or account responses in bug reports.

## Licence

Copyright © 2026 Richard Beech / 1larity. User-owned code, documentation and assets
are licensed under [Creative Commons Attribution-NonCommercial-ShareAlike 4.0
International](https://creativecommons.org/licenses/by-nc-sa/4.0/)
(**CC BY-NC-SA 4.0**). Credit the author and source, link the licence, indicate
changes, use non-commercially and share adaptations under the same licence.
Third-party material retains its own terms; previous licence grants are not revoked.
See [LICENSE](LICENSE) for the legal text.

## JSON command line for coding agents

`glm-quota` prints the quota shown in the status bar as one JSON document, so an
agent can check its own limits before starting long work.

```sh
node cli.js --pretty        # from the extension folder
npx . --pretty              # or install the glm-quota command: npm link
```

Fields: `ok`, `provider`, `plan`, `band` (`green`, `amber` or `red`, from the
most constrained window), `status` (the status bar text) and `windows[]` with
`kind`, `label`, `usedPercent`, `remainingPercent`, `resetAt` (ISO 8601) and
`resetsInSeconds`. `credits` describes purchased credits and `resets` the available reset packs.
When the quota cannot be read, `ok` is `false`, `error.reason` and
`error.message` say why, and the exit code is 1. The key is read from `ZAI_API_KEY`, or from the output of `ZAI_API_KEY_COMMAND` (for example `secret-tool lookup service zai account api`); `ZAI_HOST` selects the API host.

### All installed quota extensions in one document

`glm-quota --all` collates the quota of every installed Claude, Codex and GLM
quota extension into one JSON document: `providers` holds each extension's
own document keyed by `claude`, `codex` or `glm`, and `summary` gives the
worst `band` and the `tightest` window across them. Extensions that are not
installed are left out, and a provider that fails shows `ok: false` without
affecting the others. The exit code is 0 when at least one provider answered.

Each extension records the location of its `cli.js` in
`~/.config/quota-monitor/` (`$XDG_CONFIG_HOME`, `$QUOTA_MONITOR_DIR` or
`%APPDATA%` where set) when it activates or its CLI runs. Any one installed
extension can therefore produce the combined view.

## MCP server for coding agents

`mcp.js` is a Model Context Protocol server (stdio) with two read-only tools:

- `get_quota` returns one provider's document, the same one the command line prints. `provider` picks `claude`, `codex` or `glm` and defaults to `glm`.
- `get_all_quotas` returns the combined document of `--all`.

The server is off by default. Turn it on with the link at the foot of the status bar tooltip, the **GLM Quota: Toggle MCP Server** command, or the `zaiQuota.mcp.enabled` setting. Each provider answers only while its own extension's toggle is on; otherwise its document has `ok: false` and `error.reason` `mcp-disabled`. A change applies from the next tool call, with no agent restart.

While it is on, VS Code 1.101 and later list the server under their MCP servers, running with this extension's own settings and credentials. Other agents start it with `node <folder>/mcp.js`, where `<folder>` is this extension's folder or a source checkout. The installed folder name includes the version, so a source checkout gives a path that survives updates. Outside VS Code the key comes from `ZAI_API_KEY_COMMAND`, a command that prints it (such as a keyring lookup), so the agent config names a command rather than holding the key. `ZAI_API_KEY` also works, and `ZAI_HOST` selects the API host.

```sh
# Claude Code
claude mcp add -s user quota -e ZAI_API_KEY_COMMAND='secret-tool lookup service zai account api' -- node <folder>/mcp.js
```

```toml
# Codex: ~/.codex/config.toml
[mcp_servers.quota]
command = "node"
args = ["<folder>/mcp.js"]
env = { ZAI_API_KEY_COMMAND = "secret-tool lookup service zai account api" }
```

```jsonc
// Kilo: ~/.config/kilo/kilo.jsonc
"mcp": { "quota": { "type": "local", "command": ["node", "<folder>/mcp.js"], "environment": { "ZAI_API_KEY_COMMAND": "secret-tool lookup service zai account api" }, "enabled": true } }
```

Any one server reports all installed providers, so one entry per agent is enough. Give that entry `ZAI_API_KEY_COMMAND` so GLM can answer through it too.
