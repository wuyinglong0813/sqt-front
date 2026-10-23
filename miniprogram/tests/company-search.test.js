'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function harness(results) {
  let page;
  const modals = [], calls = [], navigations = [];
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../pages/company-bind/company-bind.js'), 'utf8'), {
    Page: value => { page = value; },
    wx: { showLoading() {}, hideLoading() {}, showToast() {}, showModal: o => modals.push(o),
      navigateTo: o => navigations.push(o.url) },
    require: () => ({ request: async o => { calls.push(o); return results; } })
  });
  page.setData = value => Object.assign(page.data, value);
  return { page, modals, calls, navigations };
}

test('onboarded search hides drafts from older servers, including the mistyped credit code', async () => {
  const { page, modals } = harness([
    { id: 'wrong', name: '河北云域科技有限公司', maskedCreditCode: '9113**********WN2W', verified: false },
    { id: 'correct', name: '河北云域科技有限公司', maskedCreditCode: '9113**********WN2M', verified: true },
    { id: 'unknown', name: '状态缺失企业' }
  ]);
  page.data.keyword = '河北';
  await page.doSearch();
  assert.deepEqual(Array.from(page.data.results, c => c.id), ['correct']);
  page.selectCompany({ currentTarget: { dataset: { index: 0 } } });
  page.confirmCompany();
  assert.equal(modals.length, 1);
  assert.match(modals[0].content, /企业管理员/);
});

test('pending companies never receive onboarded join instructions, including stale selections', () => {
  for (const verified of [false, undefined, 'true', 1]) {
    const { page, modals } = harness([]);
    const pending = { id: 'draft', name: '待认证企业', verified };
    page.data.results = [pending];
    page.selectCompany({ currentTarget: { dataset: { index: 0 } } });
    assert.equal(page.data.selectedCompany, null);
    page.data.selectedCompany = pending;
    page.confirmCompany();
    assert.equal(modals.length, 0);
  }
});

test('no verified match is shown as an empty onboarded search', async () => {
  const { page } = harness([{ id: 'draft', verified: false }]);
  page.data.keyword = '河北';
  await page.doSearch();
  assert.equal(page.data.results.length, 0);
  assert.equal(page.data.searched, true);
  assert.equal(page.data.selectedCompany, null);
});

test('a non-member can select an onboarded company and open its independent legal claim', async () => {
  const { page, calls, modals, navigations } = harness([
    { id: '9007199254740993', name: '已开通企业', verified: true }
  ]);
  page.data.keyword = '已开通';
  await page.doSearch();
  assert.equal(calls[0].withCompany, false);
  page.selectCompany({ currentTarget: { dataset: { index: 0 } } });
  page.startLegalClaim();
  assert.deepEqual(navigations, ['/pages/legal-representative/legal-representative?companyId=9007199254740993&claim=1']);
  assert.equal(calls.length, 1, 'Selecting legal claim does not bind membership or create a second company');
  assert.equal(modals.length, 0, 'A legal claimant does not need an invitation first');
});

test('an unverified or incomplete stale company selection cannot start a legal claim', () => {
  for (const company of [{ id: 'draft', verified: false }, { id: 'unknown' }, { verified: true }]) {
    const { page, navigations } = harness([]);
    page.data.selectedCompany = company;
    page.startLegalClaim();
    assert.equal(navigations.length, 0);
  }
});
