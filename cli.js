#!/usr/bin/env node
'use strict';

// JSON command line for coding agents: prints the GLM Coding Plan quota the status
// bar shows. lib/source.js says where it reads it from; `--help` lists the
// environment variables.

const path = require('path');
const source = require('./lib/source');
const { runCli } = require('./lib/cli');

runCli({
  ...source,
  argv: process.argv.slice(2),
  cliPath: path.join(__dirname, 'cli.js'),
  version: require('./package.json').version,
}).then((code) => {
  if (source.dispose) {
    source.dispose();
  }
  process.exitCode = code;
});
