const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const pkg = require('../package.json');
test('public metadata uses required licence and no runtime dependencies', () => {
  assert.equal(pkg.license, 'CC-BY-NC-SA-4.0');
  assert.equal(Object.keys(pkg.dependencies || {}).length, 0);
  assert.match(pkg.repository.url, /^https:\/\/github\.com\/1larity\//);
});
test('sensitive settings cannot be supplied by a workspace', () => {
  const props = pkg.contributes.configuration.properties;
  for (const key of ['codexQuota.codexPath', 'claudeQuota.credentialsPath', 'zaiQuota.host']) {
    if (props[key]) assert.equal(props[key].scope, 'machine');
  }
  if (props['codexQuota.codexPath'] || props['claudeQuota.credentialsPath']) {
    assert.equal(pkg.capabilities.untrustedWorkspaces.supported, false);
  }
});
