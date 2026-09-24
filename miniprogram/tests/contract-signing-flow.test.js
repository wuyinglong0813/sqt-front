'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function harness({ signing, action = {}, permissions = ['all'] }) {
  let page;
  const modals = [], requests = [], navigations = [], toasts = [];
  const request = async options => {
    requests.push(options);
    if (options.url === '/contracts/12') return { id: '12', status: 'ACTIVE', perspective: 'OUTGOING',
      direction: 'SALE', name: '测试合同', terms: '{}' };
    if (options.url === '/contracts/12/signing') return signing;
    if (options.url.startsWith('/bilateral-actions/active')) return action;
    return {};
  };
  const app = { globalData: { memberInfo: { permissions }, companies: [] }, getCurrentCompanyId: () => '3' };
  const wx = { showModal: options => modals.push(options), showToast: options => toasts.push(options),
    setNavigationBarTitle() {}, navigateTo: options => navigations.push(options.url) };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../pages/contract-preview/contract-preview.js'), 'utf8'), {
    Page: value => { page = value; }, wx, getApp: () => app, setTimeout: () => 0, clearTimeout() {},
    require: id => id.endsWith('/request') ? { request }
      : id.endsWith('/chineseCurrency') ? require('../utils/chineseCurrency') : {}
  });
  page.data.contractId = '12';
  page.setData = (value, callback) => { Object.assign(page.data, value); if (callback) callback(); };
  ['loadContractMemo', 'loadSignedContractPreview', 'promptProjectLedgerIfNeeded',
    'loadBusinessDocuments', 'loadFulfillmentData'].forEach(name => { page[name] = () => {}; });
  return { page, modals, requests, navigations, toasts };
}

test('approved but incomplete abolish offers bilateral recovery while keeping fulfillment frozen', async () => {
  const env = harness({ signing: { status: 'ABOLISH_task_terminated', abolishApproved: true, canSign: true } });
  await env.page.loadContractDetail();
  assert.equal(env.toasts.length, 0);
  assert.equal(env.page.data.contractReadOnly, true);
  assert.equal(env.page.data.canResumeContract, true);
  env.page.requestContractResume();
  let submitted;
  env.page.submitBilateralAction = (...args) => { submitted = args; };
  env.modals[0].success({ confirm: true, content: '双方继续履约' });
  assert.deepEqual(submitted, ['CONTRACT', '12', 'RESUME', '双方继续履约', false]);
});

test('pending recovery hides both another recovery request and provider signing', async () => {
  const env = harness({ signing: { status: 'abolishing', abolishApproved: true, canSign: true },
    action: { id: '21', bizType: 'CONTRACT', actionType: 'RESUME', canReview: true, actionText: '恢复履约' } });
  await env.page.loadContractDetail();
  assert.equal(env.page.data.canResumeContract, false);
  assert.equal(env.page.data.canSignContract, false);
  assert.equal(env.page.data.contract.statusText, '恢复履约待确认');
  env.page.reviewContractAction({ currentTarget: { dataset: { decision: 'APPROVE' } } });
  assert.match(env.modals[0].content, /原合同仍有效/);
  assert.match(env.modals[0].content, /核验失败/);
});

test('accepting recovery refreshes the contract without opening a new abolish signing task', async () => {
  const env = harness({ signing: { status: 'abolishing', abolishApproved: true },
    action: { id: '21', bizType: 'CONTRACT', actionType: 'RESUME', canReview: true } });
  await env.page.loadContractDetail();
  await env.page.submitContractActionDecision('21', 'APPROVE', '');
  assert.equal(env.requests.filter(item => item.url === '/bilateral-actions/21/decision').length, 1);
  assert.equal(env.navigations.length, 0);
});

test('unknown provider creation outcome exposes no unsafe recovery or signing button', async () => {
  const env = harness({ signing: { status: 'ABOLISH_CREATION_UNCERTAIN', abolishApproved: true, canSign: true } });
  await env.page.loadContractDetail();
  assert.equal(env.page.data.contractReadOnly, true);
  assert.equal(env.page.data.canResumeContract, false);
  assert.equal(env.page.data.canSignContract, false);
});

test('contract viewers without signing permission cannot request recovery', async () => {
  const env = harness({ signing: { status: 'abolishing', abolishApproved: true, canSign: true },
    permissions: ['contract_view'] });
  await env.page.loadContractDetail();
  assert.equal(env.page.data.canResumeContract, false);
  assert.equal(env.page.data.canSignContract, false);
});
