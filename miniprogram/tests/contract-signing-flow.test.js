'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function harness({ signing, action = {}, permissions = ['all'], syncResult = null, syncError = null,
  contractStatus = 'ACTIVE', contractProgress = {}, signingError = null }) {
  let page;
  const modals = [], requests = [], navigations = [], toasts = [];
  const request = async options => {
    requests.push(options);
    if (options.url === '/contracts/12') return { id: '12', status: contractStatus, perspective: 'OUTGOING',
      direction: 'SALE', name: '测试合同', terms: '{}', ...contractProgress };
    if (options.url === '/contracts/12/signing') {
      if (signingError) throw new Error(signingError);
      return signing;
    }
    if (options.url === '/contracts/12/signing/sync') {
      if (syncError) throw new Error(syncError);
      if (syncResult) {
        signing = syncResult;
        if (syncResult.status === 'revoked') contractStatus = 'VOIDED';
      }
      return syncResult || signing;
    }
    if (options.url.startsWith('/bilateral-actions/active')) return action;
    return {};
  };
  const app = { globalData: { token: 'session', currentCompanyId: '3', memberInfo: { permissions }, companies: [] }, getCurrentCompanyId: () => '3' };
  const wx = { showModal: options => modals.push(options), showToast: options => toasts.push(options),
    setNavigationBarTitle() {}, navigateTo: options => navigations.push(options.url) };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../pages/contract-preview/contract-preview.js'), 'utf8'), {
    Page: value => { page = value; }, wx, getApp: () => app, setTimeout: () => 0, clearTimeout() {},
    require: id => id.endsWith('/request') ? { request }
      : id.endsWith('/signingContinuation') ? require('../utils/signingContinuation')
      : id.endsWith('/chineseCurrency') ? require('../utils/chineseCurrency')
      : id.endsWith('/retail') ? require('../utils/retail') : {}
  });
  page.data.contractId = '12';
  page.setData = (value, callback) => { Object.assign(page.data, value); if (callback) callback(); };
  ['loadContractMemo', 'loadSignedContractPreview', 'promptProjectLedgerIfNeeded',
    'loadBusinessDocuments', 'loadFulfillmentData'].forEach(name => { page[name] = () => {}; });
  return { page, app, modals, requests, navigations, toasts };
}

test('an active contract can request local void even if electronic signing status is unavailable', async () => {
  const env = harness({ signingError: '电子签状态不可用' });
  await env.page.loadContractDetail();
  assert.equal(env.page.data.contractReadOnly, false);
  assert.equal(env.page.data.canRequestVoid, true);
  assert.equal(env.page.data.canSignContract, false);
  env.page.requestContractVoid();
  let submitted;
  env.page.submitBilateralAction = (...args) => { submitted = args; };
  env.modals[0].success({ confirm: true, content: '双方协商停止合作' });
  assert.deepEqual(submitted, ['CONTRACT', '12', 'VOID', '双方协商停止合作', false]);
});

test('pending local void approval freezes fulfillment and describes permanent local void', async () => {
  const env = harness({ signing: { canSign: true },
    action: { id: '21', status: 'PENDING', bizType: 'CONTRACT', actionType: 'VOID', canReview: true, actionText: '作废' } });
  await env.page.loadContractDetail();
  assert.equal(env.page.data.contractReadOnly, true);
  assert.equal(env.page.data.canSignContract, false);
  assert.equal(env.page.data.canRequestVoid, false);
  assert.equal(env.page.data.canCreateSalesOrder, false);
  assert.equal(env.page.data.canCreateReturnOrder, false);
  assert.equal(env.page.data.contract.statusText, '作废待确认');
  env.page.reviewContractAction({ currentTarget: { dataset: { decision: 'APPROVE' } } });
  assert.match(env.modals[0].content, /商签通内作废.*永久只读/);
  assert.doesNotMatch(env.modals[0].content, /签署作废|作废协议|法大大/);
});

test('contract viewers without signing permission cannot request local void', async () => {
  const env = harness({ signing: { canAbolish: true }, permissions: ['contract_view'] });
  await env.page.loadContractDetail();
  assert.equal(env.page.data.canRequestVoid, false);
});

test('local void takes precedence over stale provider metadata and pending actions', async () => {
  const env = harness({ contractStatus: 'VOIDED',
    contractProgress: { statusText: '待签署作废协议', abolishPending: true },
    action: { id: '21', status: 'PENDING', bizType: 'CONTRACT', actionType: 'VOID', canReview: true },
    signing: { status: 'ABOLISH_CREATION_UNCERTAIN', abolishApproved: true, canSign: true } });
  env.page.onLoad({ contractId: '12' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(env.page.data.contract.statusText, '已作废');
  assert.equal(env.page.data.contractReadOnly, true);
  assert.equal(env.page.data.activeContractAction, null);
  assert.equal(env.page.data.canSignContract, false);
  assert.equal(env.requests.some(item => item.url.endsWith('/signing/sync')), false);
});

test('the contract list displays local void state independently of the original signed task', async () => {
  let page;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../pages/contract-center/contract-center.js'), 'utf8'), {
    Page: value => { page = value; }, getApp: () => ({ globalData: {} }), wx: { showToast() {} },
    require: id => id.endsWith('/request') ? { request: async options => options.url === '/contracts/summary'
      ? {} : { items: [{ id: '12', status: 'VOIDED', signingStatus: 'task_finished', statusText: '待签署作废协议' }] } }
      : { formatDateTime: () => '' }
  });
  page.setData = value => Object.assign(page.data, value);
  await page.loadContracts(true);
  assert.equal(page.data.contracts[0].status, 'VOIDED');
  assert.equal(page.data.contracts[0].statusText, '已作废');
});

for (const [status, text] of [['task_terminated', '签署已终止'], ['expired', '签署已过期'], ['task_expired', '签署已过期']]) {
  test(`${status} agrees with the list while keeping modification and withdrawal available`, async () => {
    const env = harness({ contractStatus: 'PENDING',
      contractProgress: { signingStatus: status, statusText: text },
      signing: { status, statusText: text, canSign: true } });
    await env.page.loadContractDetail();
    assert.equal(env.page.data.contract.status, 'PENDING');
    assert.equal(env.page.data.contract.statusText, text);
    assert.equal(env.page.data.signing.statusText, text);
    assert.equal(env.page.data.canSignContract, false);
    assert.equal(env.page.data.canEditContract, true);
    assert.equal(env.page.data.canCancelContract, true);
    assert.match(env.page.data.signingActionHint, /已停止/);
  });
}

test('a finished provider task awaiting archive is not displayed as an ordinary pending signature', async () => {
  const env = harness({ contractStatus: 'PENDING', signingError: '暂不可用',
    contractProgress: { signingStatus: 'task_finished', statusText: '签署结果确认中' } });
  await env.page.loadContractDetail();
  assert.equal(env.page.data.contract.statusText, '签署结果确认中');
  assert.equal(env.page.data.canSignContract, false);
  assert.match(env.page.data.signingActionHint, /归档结果/);
});

test('native contract recovery keeps the original contract and waits for an explicit tap', async () => {
  const env = harness({ contractStatus: 'PENDING', signing: { status: 'sign_progress', canSign: true } });
  require('../utils/signingContinuation').rememberServiceRecovery(env.app, 'contract', { contractId: '12' });
  await env.page.loadContractDetail();
  assert.equal(env.page.data.serviceRecoveryAvailable, true);
  assert.equal(env.navigations.length, 0);
  env.page.renewServiceLink();
  assert.equal(env.navigations[0], '/pages/fadada-auth/fadada-auth?scene=contract&contractId=12');
  env.app.globalData.currentCompanyId = '4';
  env.page.renewServiceLink(); assert.equal(env.navigations.length, 1);
});

test('the list displays remote terminal states and a refused local contract consistently', async () => {
  let page;
  const records = [
    { id: '1', status: 'PENDING', signingStatus: 'task_terminated' },
    { id: '2', status: 'PENDING', signingStatus: 'task_expired' },
    { id: '3', status: 'PENDING', signingStatus: 'task_finished' },
    { id: '4', status: 'REJECTED', signingStatus: 'task_terminated' }
  ];
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../pages/contract-center/contract-center.js'), 'utf8'), {
    Page: value => { page = value; }, getApp: () => ({ globalData: {} }), wx: { showToast() {} },
    require: id => id.endsWith('/request') ? { request: async o => o.url.endsWith('/summary') ? {} : { items: records } }
      : { formatDateTime: () => '' }
  });
  page.setData = value => Object.assign(page.data, value);
  await page.loadContracts(true);
  assert.deepEqual(Array.from(page.data.contracts, item => item.statusText), ['签署已终止', '签署已过期', '签署结果确认中', '已拒绝']);
});
