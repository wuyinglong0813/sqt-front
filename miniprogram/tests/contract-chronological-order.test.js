const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('company sections preserve global signing chronology across companies and filters', () => {
  let page;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../pages/contract-center/contract-center.js'), 'utf8'), {
    Page: value => { page = value; }, getApp: () => ({}), require: () => ({})
  });
  page.setData = patch => Object.assign(page.data, patch);
  page.data.contracts = [
    { id: 'newest', companyId: 'A', counterpartyName: '甲', status: 'ACTIVE' },
    { id: 'middle', companyId: 'B', counterpartyName: '乙', status: 'ACTIVE' },
    { id: 'oldest', companyId: 'A', counterpartyName: '甲', status: 'ACTIVE' }
  ];
  page.applyFilter();
  assert.deepEqual(Array.from(page.data.contractGroups.flatMap(group => group.items.map(item => item.id))), ['newest', 'middle', 'oldest']);
  assert.equal(new Set(page.data.contractGroups.map(group => group.groupId)).size, 3);
  page.data.selectedCompanyId = 'A'; page.applyFilter();
  assert.deepEqual(Array.from(page.data.contractGroups.flatMap(group => group.items.map(item => item.id))), ['newest', 'oldest']);
});
