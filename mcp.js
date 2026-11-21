#!/usr/bin/env node
'use strict';

// MCP server (stdio) for coding agents: tools get_quota and get_all_quotas
// return the same JSON documents as cli.js. Each provider answers while its
// extension's MCP toggle (in the status bar tooltip) is on. Agents launch it
// as `node <this file>`.

const path = require('path');
const source = require('./lib/source');
const { runMcpServer } = require('./lib/mcp');

runMcpServer({
  ...source,
  cliPath: path.join(__dirname, 'cli.js'),
  version: require('./package.json').version,
}).then(() => {
  if (source.dispose) {
    source.dispose();
  }
});
