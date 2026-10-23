'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
test('credential destination cannot be controlled by workspace settings', () => {
  const setting = require('../package.json').contributes.configuration.properties['zaiQuota.host'];
  assert.equal(setting.scope, 'machine');
  assert.deepEqual(setting.enum, ['api.z.ai', 'open.bigmodel.cn']);
});
