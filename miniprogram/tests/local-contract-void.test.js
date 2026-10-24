'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const continuation = require('../utils/signingContinuation');
const { captureCompanyContext } = require('../utils/companyContext');

function harness(handler = async () => ({})) {
  const calls = [], navigations = [], toasts = [], modals = [];
  const app = {
    globalData: { token: 'session', currentCompanyId: '3', memberInfo: { permissions: ['all'] }, companies: [] },
    getCurrentCompanyId: () => '3'
  };
  const wx = {
    showLoading() {}, hideLoading() {}, setNavigationBarTitle() {},
    showToast: value => toasts.push(value), showModal: value => modals.push(value),
    navigateTo: value => navigations.push(value.url), redirectTo: value => navigations.push(value.url),
    switchTab: value => navigations.push(value.url), navigateBack: value => navigations.push(value && value.delta || 1),
    requirePrivacyAuthorize: value => value.success()
  };
  function page(file) {
    let result;
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../pages', file, `${file}.js`), 'utf8'), {
      Page: value => { result = value; }, wx, getApp: () => app, getCurrentPages: () => [],
      setTimeout: () => 0, clearTimeout() {},
      require: id => {
        if (id.endsWith('/request')) return { request: async value => { calls.push(value); return handler(value); } };
        if (id.endsWith('/signingContinuation')) return continuation;
        if (id.endsWith('/companyContext')) return require('../utils/companyContext');
        if (id.endsWith('/privacy')) return require('./privacy-fixture')(wx, () => app);
        if (id.endsWith('/chineseCurrency')) return require('../utils/chineseCurrency');
        if (id.endsWith('/retail')) return require('../utils/retail');
        return {};
      }
    });
    result.setData = (value, done) => { Object.assign(result.data, value); if (done) done(); };
    return result;
  }
  return { page, app, calls, navigations, toasts, modals,
    settled: () => new Promise(resolve => setImmediate(resolve)) };
}

test('approving a contract void refreshes the local result without opening electronic signing', async () => {
  const h = harness();
  const page = h.page('contract-preview');
  page.data.contractId = '12';
  page.data.activeContractAction = { id: '21', bizType: 'CONTRACT', actionType: 'VOID', canReview: true };
  let refreshed = 0;
  page.loadContractDetail = async () => { refreshed++; page.data.contract = { status: 'VOIDED' }; };
  await page.submitContractActionDecision('21', 'APPROVE', '');
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].url, '/bilateral-actions/21/decision');
  assert.equal(h.calls[0].data.decision, 'APPROVE');
  assert.equal(refreshed, 1);
  assert.equal(page.data.contract.status, 'VOIDED');
  assert.equal(h.navigations.length, 0);
  assert.ok(h.toasts.some(value => value.title === '已作废'));
});

test('approval list refreshes local void decisions without opening a provider page', async () => {
  const h = harness();
  const page = h.page('contract-approval');
  let refreshed = 0;
  page.loadPending = async () => { refreshed++; };
  await page.submitBilateralDecision({ actionId: '21', contractId: '12', bizType: 'CONTRACT', actionType: 'VOID' }, 'APPROVE', '');
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].url, '/bilateral-actions/21/decision');
  assert.equal(refreshed, 1);
  assert.equal(h.navigations.length, 0);
  assert.ok(h.toasts.some(value => value.title === '已作废'));
});

test('a locally voided contract remains permanently read only despite stale provider permissions', async () => {
  const h = harness(async options => {
    if (options.url === '/contracts/12') return { id: '12', status: 'VOIDED', perspective: 'OUTGOING', direction: 'SALE', terms: '{}' };
    if (options.url === '/contracts/12/signing') return { status: 'ABOLISH_sign_progress', abolishApproved: true, canSign: true, canAbolish: true };
    return {};
  });
  const page = h.page('contract-preview');
  page.data.contractId = '12';
  for (const method of ['loadContractMemo', 'loadSignedContractPreview', 'promptProjectLedgerIfNeeded']) page[method] = () => {};
  await page.loadContractDetail();
  assert.equal(page.data.contract.statusText, '已作废');
  assert.equal(page.data.contractReadOnly, true);
  assert.equal(page.data.canDeleteContract, true);
  for (const flag of ['canSignContract', 'canResumeContract', 'canEditContract', 'canCancelContract',
    'canRequestEnd', 'canRequestVoid', 'canCreateSalesOrder', 'canCreateReturnOrder', 'canManageContractSeal']) {
    assert.notEqual(page.data[flag], true, `${flag} must be unavailable on a voided contract`);
  }
  page.signContract();
  assert.equal(h.navigations.length, 0);
});

test('a void request only offers withdrawal while the bilateral application is pending', async () => {
  const h = harness();
  const page = h.page('contract-preview');
  page.data.contractId = '12';
  page.data.activeContractAction = { id: '21', bizType: 'CONTRACT', actionType: 'VOID', status: 'APPROVED', canCancel: true };
  page.loadContractDetail = async () => {};
  await page.cancelContractBilateralAction();
  assert.equal(h.calls.length, 0);
});

test('the requester can withdraw a pending local void application', async () => {
  const h = harness();
  const page = h.page('contract-preview');
  page.data.activeContractAction = { id: '21', bizType: 'CONTRACT', actionType: 'VOID', status: 'PENDING', canCancel: true };
  let refreshed = 0;
  page.loadContractDetail = async () => { refreshed++; };
  await page.cancelContractBilateralAction();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].url, '/bilateral-actions/21/cancel');
  assert.equal(refreshed, 1);
});

test('retired recovery approvals cannot open an approval confirmation', () => {
  const h = harness();
  const detail = h.page('contract-preview');
  detail.data.activeContractAction = { id: '21', bizType: 'CONTRACT', actionType: 'RESUME', canReview: true };
  detail.reviewContractAction({ currentTarget: { dataset: { decision: 'APPROVE' } } });
  const approvals = h.page('contract-approval');
  approvals.reviewBilateralAction({ currentTarget: { dataset: { decision: 'APPROVE',
    item: { actionId: '21', bizType: 'CONTRACT', actionType: 'RESUME' } } } });
  assert.equal(h.modals.length, 0);
  assert.equal(h.calls.length, 0);
});

for (const entry of ['onLoad', 'prepareService', 'loadServiceUrl']) {
  test(`retired abolish ${entry} cannot create an electronic void task`, async () => {
    const h = harness();
    const page = h.page('fadada-auth');
    const options = { scene: 'abolish', contractId: '12', reason: '双方协商' };
    if (entry === 'onLoad') page.onLoad(options);
    else {
      page.data.scene = 'abolish';
      page.data.options = options;
      await page[entry]();
    }
    await h.settled();
    assert.equal(h.calls.length, 0);
    assert.equal(page.data.serviceUrl, '');
    assert.equal(page.data.loading, false);
    assert.match([page.data.serviceResultTitle, page.data.serviceResultMessage, page.data.errorMessage].join(' '), /作废/);
  });
}

test('an old electronic void return never posts a signing synchronization', async () => {
  const h = harness(async () => ({ id: '12', status: 'VOIDED', statusText: '已作废' }));
  const page = h.page('service-return');
  page.data.options = { scene: 'abolish', contractId: '12' };
  await page.syncResult();
  assert.equal(h.calls.filter(value => value.method === 'POST').length, 0);
  assert.equal(h.calls.filter(value => /signing\/sync|abolish-url/.test(value.url)).length, 0);
  assert.equal(page.data.loading, false);
});

test('electronic void continuations and recovery links are rejected, including cached legacy state', () => {
  const h = harness();
  assert.equal(continuation.createSigningContinuation(h.app, 'abolish', { contractId: '12' }), '');
  continuation.rememberServiceRecovery(h.app, 'abolish', { contractId: '12' });
  assert.equal(continuation.serviceRecovery(h.app), null);
  const context = captureCompanyContext(h.app);
  h.app._signingIdentityContinuation = { id: 'old', context, target: { scene: 'abolish', contractId: '12' } };
  h.app._fadadaServiceRecovery = { context, target: { scene: 'abolish', contractId: '12' } };
  assert.equal(continuation.signingContinuation(h.app, 'old'), null);
  assert.equal(continuation.resumeSigningContinuation(h.app, 'old', []), null);
  assert.equal(continuation.signingContinuationUrl(h.app, 'old'), '');
  assert.equal(continuation.serviceRecovery(h.app), null);
  assert.equal(continuation.serviceRecoveryUrl(h.app), '');
});


test('the receiving enterprise can remove a voided contract from its own list', async () => {
  const h = harness(async options => options.url === '/contracts/12'
    ? { id: '12', status: 'VOIDED', perspective: 'INCOMING', direction: 'PURCHASE', terms: '{}' } : {});
  const page = h.page('contract-preview');
  page.data.contractId = '12';
  for (const method of ['loadContractMemo', 'loadSignedContractPreview', 'promptProjectLedgerIfNeeded']) page[method] = () => {};
  await page.loadContractDetail();
  assert.equal(page.data.canDeleteContract, true);
  page.deleteContract();
  assert.match(h.modals[0].content, /仅从我方合同列表移除/);
  assert.equal(h.calls.filter(call => call.method === 'POST').length, 0);
  h.modals[0].success({ confirm: true });
  await h.settled();
  assert.equal(h.calls.filter(call => call.url === '/contracts/12/delete').length, 1);
});
