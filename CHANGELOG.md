## 0.7.0 - 2026-11-21

- Optional MCP server for coding agents, off by default: `mcp.js` with the tools `get_quota` and `get_all_quotas`. Toggle it from the link at the foot of the status bar tooltip, the **GLM Quota: Toggle MCP Server** command, or `zaiQuota.mcp.enabled`. While on, VS Code lists the server under its MCP servers.
- The command line and MCP server read the key from `ZAI_API_KEY_COMMAND` when `ZAI_API_KEY` is not set.

## 0.6.0 - 2026-11-20

- Shows available quota-reset packs: an `R 5h/weekly` status segment and a "Reset packs" tooltip section with next expiry and last reset.
- Open Usage Page and double-click now go to z.ai's new usage page, `z.ai/manage-apikey/coding-plan/personal/usage`.

## 0.5.2 - 2026-10-23

- User-owned material now CC BY-NC-SA 4.0; third-party and earlier grants preserved.
- Provider error text is excluded from user-visible diagnostics.

