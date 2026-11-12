'use strict';
// DEV-CU P0-6：契约常量单测（TS 侧），锁定版本字符串并与 Go 侧常量逐字一致。
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const {
  CONTRACT_VERSION,
  CONTRACT_VERSION_ERROR_CODE,
  CONTRACT_COMPAT_POLICY,
} = require('../.build/ipc/computer-contract.js');

test('DEV-CU P0-6: 契约版本常量两侧逐字一致', () => {
  assert.equal(CONTRACT_VERSION, 'ops-computer/1');
  assert.equal(CONTRACT_VERSION_ERROR_CODE, 'computer_invalid_args');
  assert.equal(CONTRACT_COMPAT_POLICY.additiveFieldsOnly, true);
  assert.equal(CONTRACT_COMPAT_POLICY.noSemanticChange, true);
  assert.equal(CONTRACT_COMPAT_POLICY.removalRequiresVersionBump, true);
  assert.equal(CONTRACT_COMPAT_POLICY.removalKeepsReadCompatibilityForOneRelease, true);

  const go = fs.readFileSync(
    path.join(__dirname, '../../server/internal/app/computer_contract.go'),
    'utf8',
  );
  assert.match(go, /ContractVersion\s*=\s*"ops-computer\/1"/);
  assert.match(go, /ContractVersionErrorCode\s*=\s*"computer_invalid_args"/);
});
