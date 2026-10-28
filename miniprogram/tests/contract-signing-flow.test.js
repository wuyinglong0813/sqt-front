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

function listHarness(file, records) {
  let page;
  const requests = [], toasts = [];
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, `../pages/${file}/${file}.js`), 'utf8'), {
    Page: value => { page = value; }, getApp: () => ({ globalData: {} }),
    wx: { showToast: options => toasts.push(options) },
    require: id => {
      if (id.endsWith('/contractStatus')) return require('../utils/contractStatus');
      if (id.endsWith('/datetime')) return require('../utils/datetime');
      if (id.endsWith('/request')) return { request: async options => {
        requests.push(options);
        if (options.url.endsWith('/summary')) return null;
        if (options.url.startsWith('/approvals/')) return [];
        return options.url === '/contracts/pending' ? records : { items: records };
      } };
      return {};
    }
  });
  page.setData = value => Object.assign(page.data, value);
  return { page, requests, toasts, load: () => file === 'contract-approval'
    ? page.loadPending() : page.loadContracts(file === 'order-detail' ? '往来公司' : true) };
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
  const { page, load } = listHarness('contract-center', [
    { id: '12', status: 'VOIDED', signingStatus: 'task_finished', statusText: '待签署作废协议' }
  ]);
  await load();
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
  });
}

test('a finished provider task awaiting archive is not displayed as an ordinary pending signature', async () => {
  const env = harness({ contractStatus: 'PENDING', signingError: '暂不可用',
    contractProgress: { signingStatus: 'task_finished', statusText: '签署结果确认中' } });
  await env.page.loadContractDetail();
  assert.equal(env.page.data.contract.statusText, '签署结果确认中');
  assert.equal(env.page.data.canSignContract, false);
  assert.equal(env.page.data.contract.status, 'PENDING');
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
  const records = [
    { id: '1', status: 'PENDING', signingStatus: 'task_terminated', statusText: '待我方签署' },
    { id: '2', status: 'PENDING', signingStatus: 'task_expired', statusText: '待对方签署' },
    { id: '3', status: 'PENDING', signingStatus: 'task_finished', statusText: '待我方签署' },
    { id: '4', status: 'REJECTED', signingStatus: 'task_terminated', statusText: '待对方签署' },
    { id: '5', status: 'PENDING', signingStatus: 'CREATING', statusText: '待我方签署' },
    { id: '6', status: 'PENDING', signingStatus: 'CREATE_FAILED', statusText: '待对方签署' },
    { id: '7', status: 'PENDING', signingStatus: 'task_finished', statusText: '签署结果待同步' },
    { id: '8', status: 'PENDING', signingStatus: 'sign_progress', statusText: '双方已签署，正在归档' }
  ];
  const { page, load } = listHarness('contract-center', records);
  await load();
  assert.deepEqual(Array.from(page.data.contracts, item => item.statusText),
    ['签署已终止', '签署已过期', '签署结果确认中', '已拒绝', '正在准备签署文件', '签署任务准备失败', '签署结果待同步', '双方已签署，正在归档']);
  assert.deepEqual(Array.from(page.data.contracts, item => item.signingStage),
    ['STOPPED', 'STOPPED', 'PROCESSING', '', 'PROCESSING', 'STOPPED', 'PROCESSING', 'PROCESSING']);
});

for (const file of ['order-detail', 'contract-center', 'contract-approval']) {
  test(`${file} shows whose signature is needed using server-confirmed viewer progress`, async () => {
    const records = [
      { id: '9007199254740993', status: 'PENDING', perspective: 'OUTGOING', signingStatus: 'sign_progress', statusText: '我方已签署，等待对方签署' },
      { id: '9007199254740995', status: 'PENDING', perspective: 'INCOMING', signingStatus: 'sign_progress', statusText: '待我方签署' },
      { id: '3', status: 'PENDING', perspective: 'OUTGOING', signingStatus: 'sign_progress', statusText: '待己方签署' },
      { id: '4', status: 'PENDING', perspective: 'INCOMING', signingStatus: 'sign_progress', statusText: '待对方签署' },
      { id: '5', status: 'PENDING', perspective: 'INCOMING', signingStatus: 'sign_completed', statusText: '待我方签署' },
      { id: '6', status: 'PENDING', perspective: 'OUTGOING', signingStatus: 'sign_progress', statusText: '签署中' },
      { id: '7', status: 'PENDING', perspective: 'INCOMING' },
      { id: '8', status: 'PENDING', perspective: 'OUTGOING' }
    ];
    const { page, load, toasts } = listHarness(file, records);
    await load();
    assert.deepEqual(toasts, []);
    assert.deepEqual(Array.from(page.data.contracts, item => item.statusText),
      ['待对方签署', '待我方签署', '待我方签署', '待对方签署', '双方已签署，正在归档', '签署中', '待签署', '待签署']);
    assert.deepEqual(Array.from(page.data.contracts, item => item.signingStage),
      ['OTHER', 'SELF', 'SELF', 'OTHER', 'PROCESSING', 'PENDING', 'PENDING', 'PENDING']);
    assert.equal(page.data.contracts[0].id, '9007199254740993');
    assert.ok(page.data.contracts.every(item => item.status === 'PENDING'));
  });
}

for (const file of ['order-detail', 'contract-center']) {
  test(`${file} keeps both signing stages in the pending count and filter`, async () => {
    const { page, load, requests } = listHarness(file, [
      { id: '1', status: 'PENDING', statusText: '待我方签署' },
      { id: '2', status: 'PENDING', statusText: '待对方签署' },
      { id: '3', status: 'ACTIVE' },
      { id: '4', status: 'VOIDED' }
    ]);
    await load();
    if (file === 'order-detail') {
      assert.equal(page.data.contractStats.pending, 2);
      assert.equal(page.data.contractStats.active, 1);
      assert.equal(page.data.contractStats.closed, 1);
      page.applyContractFilter('PENDING');
      assert.deepEqual(Array.from(page.data.filteredContracts, item => item.id), ['1', '2']);
      assert.equal(page.data.contractFilters.find(item => item.key === 'PENDING').count, 2);
    } else {
      assert.equal(page.data.summary.pending, 2);
      assert.equal(page.data.summary.active, 1);
      page.setData({ activeTab: 'PENDING' });
      page.applyFilter();
      assert.deepEqual(Array.from(page.data.visibleContracts, item => item.id), ['1', '2']);
      await page.loadContracts(true);
      assert.ok(requests.some(item => item.url.includes('&status=PENDING')));
    }
  });
}

test('approval records without an explicit lifecycle still show the server-confirmed signer', async () => {
  const { page, load } = listHarness('contract-approval', [
    { id: '1', perspective: 'OUTGOING', statusText: '待我方签署' }
  ]);
  await load();
  assert.equal(page.data.contracts[0].statusText, '待我方签署');
  assert.equal(page.data.contracts[0].signingStage, 'SELF');
  assert.equal(page.data.tabs.find(item => item.key === 'CONTRACT').count, 1);
});

test('counterparty cards keep local void and provider terminal progress distinct', async () => {
  const records = [
    { id: '1', status: 'PENDING', signingStatus: 'task_terminated' },
    { id: '2', status: 'PENDING', signingStatus: 'task_expired' },
    { id: '3', status: 'PENDING', signingStatus: 'task_finished' },
    { id: '4', status: 'VOIDED', statusText: '签署中', signingStatus: 'sign_progress' }
  ];
  const { page, load } = listHarness('order-detail', records);
  await load();
  assert.deepEqual(Array.from(page.data.contracts, item => item.statusText),
    ['签署已终止', '签署已过期', '签署结果确认中', '已作废']);
});

for (const file of ['order-detail', 'contract-center']) {
  test(`${file} preserves timeout withdrawals and counts them as closed instead of pending`, async () => {
    const records = [
      { id: '1', status: 'CANCELLED', signingStatus: 'SIGNING_TIMEOUT', statusText: '超过默认签署时间已撤回' },
      { id: '2', status: 'CANCELLED', signingStatus: 'task_terminated', statusText: '签署已终止' },
      { id: '3', status: 'PENDING', signingStatus: 'sign_progress', statusText: '待我方签署' }
    ];
    const { page, load } = listHarness(file, records);
    await load();
    assert.deepEqual(Array.from(page.data.contracts, item => item.statusText),
      ['超过默认签署时间已撤回', '已撤回', '待我方签署']);
    assert.equal(page.data.contracts[0].status, 'CANCELLED');
    if (file === 'order-detail') {
      assert.equal(page.data.contractStats.closed, 2);
      assert.equal(page.data.contractStats.pending, 1);
      page.applyContractFilter('CLOSED');
      assert.deepEqual(Array.from(page.data.filteredContracts, item => item.id), ['1', '2']);
    } else {
      assert.equal(page.data.summary.pending, 1);
      page.setData({ activeTab: 'PENDING' });
      page.applyFilter();
      assert.deepEqual(Array.from(page.data.visibleContracts, item => item.id), ['3']);
    }
  });
}

test('a timeout withdrawal stays visible in detail and can be edited without signing the cancelled task', async () => {
  const env = harness({ contractStatus: 'CANCELLED',
    contractProgress: { signingStatus: 'SIGNING_TIMEOUT', statusText: '超过默认签署时间已撤回' },
    signing: { status: 'task_terminated', statusText: '签署已终止', canSign: true } });
  await env.page.loadContractDetail();
  assert.equal(env.page.data.contract.statusText, '超过默认签署时间已撤回');
  assert.equal(env.page.data.signingTimedOut, true);
  assert.equal(env.page.data.canSignContract, false);
  assert.equal(env.page.data.canCancelContract, false);
  assert.equal(env.page.data.canEditContract, true);
  assert.equal(env.page.data.canCreateSalesOrder, false);
  assert.equal(env.page.data.canCreateReturnOrder, false);
  env.page.editContract();
  assert.equal(env.navigations[0], '/pages/sign-contract/sign-contract?mode=edit&contractId=12');
});

test('a withdrawal uses a clear contract label and keeps the confirmation free of billing explanations', async () => {
  const env = harness({ contractStatus: 'PENDING', signing: { status: 'sign_progress' } });
  await env.page.loadContractDetail();
  env.page.cancelContract();
  assert.equal(env.modals[0].title, '撤回合同');
  assert.match(env.modals[0].content, /对方将不能继续签署/);
  assert.doesNotMatch(env.modals[0].content, /预扣|扣费|退款|退回额度/);
  env.modals[0].success({ confirm: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(env.requests.filter(item => item.url === '/contracts/12/cancel').length, 1);
  assert.equal(env.toasts[0].title, '合同已撤回');
});

test('contract detail uses fresh signing progress without activating a partially signed contract', async () => {
  const env = harness({ contractStatus: 'PENDING', contractProgress: { statusText: '签署中' },
    signing: { status: 'sign_progress', statusText: '我方已签署，等待对方签署',
      initiatorSignStatus: 'signed', counterpartySignStatus: 'wait_sign', canSign: false } });
  await env.page.loadContractDetail();
  assert.equal(env.page.data.contract.status, 'PENDING');
  assert.equal(env.page.data.contract.statusText, '我方已签署，等待对方签署');
  assert.equal(env.page.data.pdfSupplierSignText, '已签署');
  assert.equal(env.page.data.pdfBuyerSignText, '待签署');
  assert.equal(env.page.data.canSignContract, false);
  assert.equal(env.page.data.canRequestEnd, false);
});

test('purchase-initiated contracts assign real signer progress to the correct supplier and buyer', async () => {
  const env = harness({ contractStatus: 'PENDING',
    contractProgress: { direction: 'PURCHASE', viewerDirection: 'SALE', perspective: 'INCOMING' },
    signing: { status: 'sign_progress', statusText: '待我方签署',
      initiatorSignStatus: 'signed', counterpartySignStatus: 'wait_sign', canSign: true } });
  await env.page.loadContractDetail();
  assert.equal(env.page.data.contract.status, 'PENDING');
  assert.equal(env.page.data.contract.statusText, '待我方签署');
  assert.equal(env.page.data.pdfSupplierSignText, '待签署');
  assert.equal(env.page.data.pdfBuyerSignText, '已签署');
  assert.equal(env.page.data.canSignContract, true);
});
