const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function harness(handler) {
  let definition;
  const calls = [], titles = [], toasts = [], updates = [], modals = [], previews = [];
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,
    '../pages/sales-order-detail/sales-order-detail.js'), 'utf8'), {
    Page: value => { definition = value; },
    wx: { setNavigationBarTitle: value => titles.push(value.title),
      showToast: value => toasts.push(value.title), showModal: value => modals.push(value) },
    require: id => id.endsWith('/request') ? {
      request: options => { calls.push(options); return Promise.resolve().then(() => handler(options)); }
    } : id.endsWith('/pdfPreview') ? { createPdfPreview: options => {
      const session = { options, disposed: false, loads: [], retries: [], imageErrors: [],
        load: async force => { session.loads.push(force); }, dispose: () => { session.disposed = true; },
        retry: async number => session.retries.push(number), imageError: number => session.imageErrors.push(number) };
      previews.push(session); return session;
    } } : id.endsWith('/datetime') ? { formatDateTime: value => value } : {}
  });
  const page = { ...definition, data: structuredClone(definition.data) };
  page.setData = update => { updates.push(update); Object.assign(page.data, update); };
  page.data.id = '2098123456789012345';
  return { page, calls, titles, toasts, updates, modals, previews };
}

const detail = (title = '销售单') => ({ documentNo: 'XS-001', documentType: 'SALES_ORDER',
  content: { title, companyName: '供方', counterpartyName: '需方' }, items: [{ id: '1' }] });
const tick = () => new Promise(resolve => setImmediate(resolve));

test('renders the document without waiting for memo, warehouses or active actions', async () => {
  const pending = deferred();
  const env = harness(options => options.url === `/trade-documents/${env.page.data.id}`
    ? detail() : pending.promise);
  await env.page.loadAll();
  assert.equal(env.page.data.detail.title, '销售单');
  assert.equal(env.page.data.loading, false);
  assert.equal(env.page.data.memoLoading, true);
  assert.equal(env.calls.length, 4);
  pending.resolve(null);
  await tick();
  assert.equal(env.page.data.memoLoading, false);
});

test('auxiliary failures keep the document visible and allow retrying the memo', async () => {
  let memoFailed = true;
  const env = harness(options => {
    if (options.url === `/trade-documents/${env.page.data.id}`) return detail();
    if (options.url.endsWith('/memo') && !memoFailed) return { content: '已安排发货' };
    throw new Error('request:fail timeout');
  });
  await env.page.loadAll();
  await tick();
  assert.equal(env.page.data.loading, false);
  assert.equal(env.page.data.loadError, '');
  assert.equal(env.page.data.detail.documentNo, 'XS-001');
  assert.equal(env.page.data.memoError, '进展加载失败，点击重试');
  env.page.openMemoEditor();
  assert.equal(env.page.data.showMemoEditor, false);
  await tick();
  memoFailed = false;
  env.page.openMemoEditor();
  await tick();
  assert.equal(env.page.data.memo, '已安排发货');
  assert.equal(env.page.data.memoError, '');
  env.page.openMemoEditor();
  assert.equal(env.page.data.showMemoEditor, true);
});

test('document timeout ends loading, shows a readable error and can be retried', async () => {
  let failed = true;
  const env = harness(options => {
    if (options.url === `/trade-documents/${env.page.data.id}`) {
      if (failed) throw new Error('request:fail timeout');
      return detail();
    }
    return null;
  });
  await env.page.loadAll();
  assert.equal(env.page.data.loading, false);
  assert.equal(env.page.data.detail, null);
  assert.equal(env.page.data.loadError, '单据加载超时，请重试');
  failed = false;
  await env.page.loadAll();
  assert.equal(env.page.data.loadError, '');
  assert.equal(env.page.data.detail.documentNo, 'XS-001');
});

test('an older refresh cannot overwrite current detail or supporting data', async () => {
  const first = Array.from({ length: 4 }, deferred);
  const latest = [detail('最新单据'), { content: '最新进展' },
    [{ id: 'new-warehouse' }], { id: 'new-action' }];
  let index = 0;
  const env = harness(() => {
    const requestIndex = index++;
    return requestIndex < 4 ? first[requestIndex].promise : latest[requestIndex - 4];
  });
  const oldLoad = env.page.loadAll();
  await tick();
  await env.page.loadAll();
  await tick();
  first[0].resolve(detail('旧单据'));
  first[1].resolve({ content: '旧进展' });
  first[2].resolve([{ id: 'old-warehouse' }]);
  first[3].resolve({ id: 'old-action' });
  await oldLoad;
  await tick();
  assert.equal(env.page.data.detail.title, '最新单据');
  assert.equal(env.page.data.memo, '最新进展');
  assert.equal(env.page.data.warehouses[0].id, 'new-warehouse');
  assert.equal(env.page.data.activeAction.id, 'new-action');
  assert.equal(env.page.data.loading, false);
});

test('unloading discards all pending responses and navigation changes', async () => {
  const pending = deferred();
  const env = harness(() => pending.promise);
  const loading = env.page.loadAll();
  await tick();
  env.page.onUnload();
  const updateCount = env.updates.length;
  pending.resolve(detail());
  await loading;
  await tick();
  assert.equal(env.updates.length, updateCount);
  assert.equal(env.titles.length, 0);
});

test('a memo read started before saving cannot restore the old memo', async () => {
  const oldMemo = deferred();
  const env = harness(options => {
    if (options.method === 'POST') return { content: options.data.content };
    if (options.url.endsWith('/memo')) return oldMemo.promise;
    return options.url === `/trade-documents/${env.page.data.id}` ? detail() : null;
  });
  await env.page.loadAll();
  env.page.data.memoDraft = '刚保存的进展';
  await env.page.saveMemo();
  oldMemo.resolve({ content: '旧进展' });
  await tick();
  assert.equal(env.page.data.memo, '刚保存的进展');
  assert.equal(env.page.data.memoLoading, false);
});

test('warehouse picker distinguishes pending or failed warehouse reads from an empty list', async () => {
  const warehouses = deferred();
  const env = harness(options => options.url === '/warehouses' ? warehouses.promise
    : options.url === `/trade-documents/${env.page.data.id}` ? detail() : null);
  await env.page.loadAll();
  env.page.chooseWarehouse();
  assert.equal(env.page.data.showWarehousePicker, true);
  assert.equal(env.page.data.warehousesLoading, true);
  warehouses.reject(new Error('request:fail timeout'));
  await tick();
  assert.equal(env.page.data.warehousesError, '仓库加载失败，请点击重试');
  assert.equal(env.page.data.warehousesLoading, false);
});

test('returning after warehouse creation refreshes the open picker without leaving the document', async () => {
  let warehouses = [];
  const env = harness(options => options.url === '/warehouses' ? warehouses
    : options.url === `/trade-documents/${env.page.data.id}` ? detail() : null);
  await env.page.loadAll();
  env.page.onShow();
  env.page.chooseWarehouse();
  await tick();
  assert.equal(env.page.data.warehouses.length, 0);
  warehouses = [{ id: '9007199254740993', name: '新仓库' }];
  env.page.onShow();
  await tick();
  assert.equal(env.page.data.showWarehousePicker, true);
  assert.equal(env.page.data.warehouses[0].name, '新仓库');
  let signature;
  env.page.openSignatureEditor = (...args) => { signature = args; };
  env.page.selectWarehouse({ currentTarget: { dataset: { id: warehouses[0].id } } });
  env.page.confirmWarehouse();
  assert.deepEqual(signature, ['INBOUND', '9007199254740993']);
});

test('latest warehouse refresh wins and an invalid old selection is cleared', async () => {
  const first = deferred(), second = deferred();
  let index = 0;
  const env = harness(() => (++index === 1 ? first.promise : second.promise));
  env.page.data.selectedWarehouseId = 'deleted';
  const old = env.page.loadWarehouses(), latest = env.page.loadWarehouses();
  second.resolve([{ id: 'new', name: '最新仓库' }]);
  await latest;
  first.resolve([{ id: 'old', name: '旧仓库' }]);
  await old;
  assert.equal(env.page.data.warehouses[0].id, 'new');
  assert.equal(env.page.data.selectedWarehouseId, '');
});

test('sales publication records the chosen source warehouse before asking for confirmation', async () => {
  const env = harness(() => [{ id: 'source', name: '供方电线仓库' }]);
  env.page.data.detail = { canPublish: true };
  let chosen;
  env.page.confirmPublishDraft = id => { chosen = id; };
  env.page.publishDraft();
  assert.equal(chosen, undefined);
  assert.equal(env.page.data.warehousePickerTitle, '选择销售出库仓库');
  await tick();
  env.page.selectWarehouse({ currentTarget: { dataset: { id: 'source' } } });
  env.page.confirmWarehouse();
  assert.equal(chosen, 'source');
});

for (const buyer of [true, false]) {
  test(`return confirmation chooses the ${buyer ? 'buyer outbound' : 'supplier inbound'} warehouse`, async () => {
    const env = harness(() => [{ id: 'own-warehouse', name: '本方仓库' }]);
    env.page.data.isReturnOrder = true;
    env.page.data.detail = { viewerCompanyId: buyer ? '2' : '1', buyerCompanyId: '2', supplierCompanyId: '1' };
    let signature;
    env.page.openSignatureEditor = (...args) => { signature = args; };
    if (buyer) env.page.receiveOnly(); else env.page.chooseWarehouse();
    await tick();
    assert.equal(env.page.data.warehousePickerTitle, buyer ? '选择退货出库仓库' : '选择退货入库仓库');
    env.page.selectWarehouse({ currentTarget: { dataset: { id: 'own-warehouse' } } });
    env.page.confirmWarehouse();
    assert.deepEqual(signature, [buyer ? 'RECEIVE_ONLY' : 'INBOUND', 'own-warehouse']);
  });
}

const moreEvent = action => ({ currentTarget: { dataset: { action } } });

test('the document menu follows current rights and read-only documents keep only reading actions', () => {
  const { page } = harness(() => null);
  page.data.detail = { status: 'DRAFT', canEditDraft: true, canDeleteDraft: true };
  page.toggleDocumentMore();
  assert.deepEqual(Array.from(page.data.documentMoreActions, item => item.key),
    ['memo', 'edit', 'delete']);
  page.closeDocumentMore();
  page.data.detail = { status: 'INBOUNDED', canRequestVoid: true, canSelectOutboundWarehouse: true };
  page.data.activeAction = { id: 'action-1', canCancel: true, status: 'PENDING',
    actionType: 'VOID', bizType: 'BUSINESS_DOCUMENT', bizId: page.data.id };
  page.toggleDocumentMore();
  assert.deepEqual(Array.from(page.data.documentMoreActions, item => item.key),
    ['memo', 'warehouse', 'cancelVoid', 'void']);
  page.closeDocumentMore();
  page.data.detail.contractReadOnly = true;
  page.toggleDocumentMore();
  assert.deepEqual(Array.from(page.data.documentMoreActions, item => item.key), ['cancelVoid', 'memo']);
  page.closeDocumentMore();
  page.data.detail.contractStatus = 'COMPLETED';
  page.toggleDocumentMore();
  assert.deepEqual(Array.from(page.data.documentMoreActions, item => item.key), ['memo']);
});

test('PDF actions remain beneath the document while more contains management actions only', () => {
  const { page } = harness(() => null);
  page.data.detail = { status: 'INBOUNDED' };
  const downloads = [];
  page.downloadPdf = showToast => downloads.push({ showToast, menuOpen: page.data.showDocumentMore });
  page.toggleDocumentMore();
  assert.equal(page.data.documentMoreActions.some(item => ['view', 'download'].includes(item.key)), false);
  page.closeDocumentMore();
  page.viewPdf();
  page.downloadDocumentPdf();
  assert.deepEqual(downloads, [{ showToast: false, menuOpen: false }, { showToast: true, menuOpen: false }]);
});

test('revoked rights, changed documents and busy actions cannot execute stale menu events', () => {
  const { page } = harness(() => null);
  let requests = 0;
  page.requestDocumentVoid = () => requests++;
  page.data.detail = { canRequestVoid: true };
  page.toggleDocumentMore();
  page.data.detail.canRequestVoid = false;
  page.runDocumentMoreAction(moreEvent('void'));
  assert.equal(requests, 0);
  assert.equal(page.data.showDocumentMore, false);
  page.data.detail.canRequestVoid = true;
  page.toggleDocumentMore();
  page.data.id = 'another-document';
  page.runDocumentMoreAction(moreEvent('void'));
  assert.equal(requests, 0);
  assert.equal(page.data.showDocumentMore, false);
  page.toggleDocumentMore();
  page.data.actionLoading = true;
  page.runDocumentMoreAction(moreEvent('void'));
  assert.equal(requests, 0);
  page.data.actionLoading = false;
  page.data.detail.contractReadOnly = true;
  page.runDocumentMoreAction(moreEvent('void'));
  assert.equal(requests, 0);
});

test('a refresh closes more and an old cancellation never targets a replacement application', async () => {
  const { page } = harness(() => detail());
  let cancels = 0;
  page.cancelDocumentVoid = () => cancels++;
  page.data.detail = {};
  page.data.activeAction = { id: 'old-action', canCancel: true, status: 'PENDING',
    actionType: 'VOID', bizType: 'BUSINESS_DOCUMENT', bizId: page.data.id };
  page.toggleDocumentMore();
  page.data.activeAction = { ...page.data.activeAction, id: 'new-action' };
  page.runDocumentMoreAction(moreEvent('cancelVoid'));
  assert.equal(cancels, 0);
  page.toggleDocumentMore();
  await page.loadAll();
  assert.equal(page.data.showDocumentMore, false);
  assert.equal(page.data.documentMoreActions.length, 0);
  page.runDocumentMoreAction(moreEvent('cancelVoid'));
  assert.equal(cancels, 0);
});

test('a pending document void can be cancelled from more while the active contract is temporarily read-only', async () => {
  const env = harness(options => options.url === `/trade-documents/${env.page.data.id}`
    ? { ...detail(), contractStatus: 'ACTIVE', contractReadOnly: false } : null);
  env.page.data.detail = { contractStatus: 'ACTIVE', contractReadOnly: true,
    canRequestVoid: false, canWithdraw: false };
  env.page.data.activeAction = { id: '2098123456789012999', contractId: '2098123456789012000',
    bizType: 'BUSINESS_DOCUMENT', bizId: env.page.data.id, actionType: 'VOID', status: 'PENDING',
    canCancel: true, canReview: false, reason: '本次销售单需要撤回调整' };
  env.page.toggleDocumentMore();
  assert.deepEqual(Array.from(env.page.data.documentMoreActions, item => item.key),
    ['cancelVoid', 'memo']);
  await env.page.runDocumentMoreAction(moreEvent('cancelVoid'));
  const cancellation = env.calls.filter(options => options.method === 'POST');
  assert.equal(cancellation.length, 1);
  assert.equal(cancellation[0].url, '/bilateral-actions/2098123456789012999/cancel');
  assert.equal(env.page.data.showDocumentMore, false);
  assert.equal(env.page.data.detail.contractReadOnly, false);
  assert.equal(env.page.data.actionLoading, false);
});

test('only the current pending document void is a read-only exception and terminal contracts cannot cancel', async () => {
  const invalidStates = [
    { action: { bizType: 'CONTRACT' } },
    { action: { bizId: '2098123456789012346' } },
    { action: { status: 'APPROVED' } },
    { action: { actionType: 'END' } },
    { action: { canCancel: false } },
    { action: { id: '' } },
    { contractStatus: 'COMPLETED' },
    { contractStatus: 'VOIDED' }
  ];
  for (const state of invalidStates) {
    const { page, calls } = harness(() => null);
    page.data.detail = { contractReadOnly: true, contractStatus: state.contractStatus || 'ACTIVE' };
    page.data.activeAction = { id: 'action-1', canCancel: true, status: 'PENDING',
      actionType: 'VOID', bizType: 'BUSINESS_DOCUMENT', bizId: page.data.id, ...state.action };
    page.toggleDocumentMore();
    assert.equal(page.data.documentMoreActions.some(item => item.key === 'cancelVoid'), false,
      JSON.stringify(state));
    await page.cancelDocumentVoid();
    assert.equal(calls.length, 0, JSON.stringify(state));
  }
});

test('moving void and delete into more keeps the original confirmations and does not submit on a menu tap', () => {
  const env = harness(() => null);
  env.page.data.detail = { status: 'DRAFT', canDeleteDraft: true, canRequestVoid: true };
  env.page.data.documentLabel = '退货单';
  env.page.data.documentNo = 'TH-001';
  env.page.toggleDocumentMore();
  env.page.runDocumentMoreAction(moreEvent('void'));
  assert.equal(env.modals[0].title, '申请作废退货单');
  assert.equal(env.modals[0].editable, true);
  assert.equal(env.calls.length, 0);
  env.modals[0].success({ confirm: false });
  env.page.toggleDocumentMore();
  env.page.runDocumentMoreAction(moreEvent('delete'));
  assert.equal(env.modals[1].title, '删除退货单');
  assert.match(env.modals[1].content, /TH-001/);
  assert.equal(env.calls.length, 0);
});

test('the source warehouse remains configurable from more without bypassing warehouse selection', async () => {
  const { page } = harness(() => [{ id: 'source', name: '供方仓库' }]);
  page.data.detail = { canSelectOutboundWarehouse: true };
  page.toggleDocumentMore();
  page.runDocumentMoreAction(moreEvent('warehouse'));
  assert.equal(page.data.showDocumentMore, false);
  assert.equal(page.data.showWarehousePicker, true);
  assert.equal(page.data.warehousePickerTitle, '设置销售出库仓库');
  await tick();
  assert.equal(page.data.warehouses[0].id, 'source');
});

test('read-only personal progress can be opened from more and cannot be edited or saved', async () => {
  const { page, calls } = harness(() => null);
  page.data.detail = { contractReadOnly: true };
  page.data.memo = '曾安排退货';
  page.toggleDocumentMore();
  page.runDocumentMoreAction(moreEvent('memo'));
  assert.equal(page.data.showMemoEditor, true);
  assert.equal(page.data.memoDraft, '曾安排退货');
  page.onMemoInput({ detail: { value: '无法修改' } });
  await page.saveMemo();
  assert.equal(page.data.memoDraft, '曾安排退货');
  assert.equal(calls.length, 0);
});

test('document content starts a real PDF preview bound to its exact ID and refresh replaces that session', async () => {
  const env = harness(options => options.url === `/trade-documents/${env.page.data.id}` ? detail() : null);
  await env.page.loadAll();
  assert.equal(env.previews.length, 1);
  const first = env.previews[0];
  assert.equal(first.options.baseUrl, '/trade-documents/2098123456789012345');
  assert.equal(first.options.cachePrefix, 'trade-document-2098123456789012345');
  assert.equal(first.options.isCurrent(), true);
  first.options.onState({ pages: [{ pageNumber: 1, filePath: '/page1.png' }, { pageNumber: 2, filePath: '/page2.png' }], loading: false, error: '', versionChanged: false });
  assert.equal(env.page.data.pdfPreviewPages.length, 2);
  await env.page.loadAll();
  assert.equal(first.disposed, true);
  assert.equal(first.options.isCurrent(), false);
  assert.equal(env.previews.length, 2);
  assert.equal(env.page.data.pdfPreviewPages.length, 0);
  env.page.onUnload();
  assert.equal(env.previews[1].disposed, true);
  assert.equal(env.previews[1].options.isCurrent(), false);
});

test('preview page retry and image failures use the current preview session', async () => {
  const env = harness(options => options.url === `/trade-documents/${env.page.data.id}` ? detail() : null);
  await env.page.loadAll();
  const session = env.previews[0];
  await env.page.retryDocumentPreview({ currentTarget: { dataset: { page: 2 } } });
  await env.page.retryDocumentPreview();
  env.page.onDocumentPreviewImageError({ currentTarget: { dataset: { page: 2 } } });
  assert.deepEqual(session.retries, [2]);
  assert.deepEqual(session.loads, [undefined, true]);
  assert.deepEqual(session.imageErrors, [2]);
});

test('current publication and confirmation tasks are reached from more through the original flows', () => {
  const { page } = harness(() => null);
  const routed = [];
  for (const method of ['publishDraft', 'receiveOnly', 'chooseWarehouse', 'rejectSalesOrder']) {
    page[method] = () => routed.push({ method, menuOpen: page.data.showDocumentMore });
  }
  page.data.detail = { canPublish: true };
  page.toggleDocumentMore();
  assert.equal(page.data.documentMoreActions[0].key, 'publish');
  page.runDocumentMoreAction(moreEvent('publish'));
  page.data.detail = { canReceive: true, canInbound: true, canReject: true };
  for (const action of ['receive', 'inbound', 'reject']) {
    page.toggleDocumentMore();
    page.runDocumentMoreAction(moreEvent(action));
  }
  assert.deepEqual(routed, ['publishDraft', 'receiveOnly', 'chooseWarehouse', 'rejectSalesOrder']
    .map(method => ({ method, menuOpen: false })));
  page.data.isReturnOrder = true;
  page.data.detail = { canReceive: true, buyerCompanyId: '9007199254740993', viewerCompanyId: '9007199254740993' };
  page.toggleDocumentMore();
  assert.equal(page.data.documentMoreActions[0].label, '同意并退货出库');
  page.closeDocumentMore();
  page.data.detail.viewerCompanyId = '9007199254740994';
  page.toggleDocumentMore();
  assert.equal(page.data.documentMoreActions.some(item => item.key === 'receive'), false);
  page.closeDocumentMore();
  page.data.detail = { canReceive: true, canInbound: true, canReject: true, contractReadOnly: true };
  page.toggleDocumentMore();
  assert.deepEqual(Array.from(page.data.documentMoreActions, item => item.key), ['memo']);
});

test('pending void review remains in more during the read-only lock and cannot confirm a replaced request', async () => {
  const { page, modals, calls } = harness(() => null);
  page.data.detail = { contractReadOnly: true, contractStatus: 'ACTIVE' };
  page.data.activeAction = { id: 'void-1', canReview: true, status: 'PENDING', actionType: 'VOID',
    bizType: 'BUSINESS_DOCUMENT', bizId: page.data.id };
  page.toggleDocumentMore();
  assert.deepEqual(Array.from(page.data.documentMoreActions, item => item.key), ['voidApprove', 'voidReject', 'memo']);
  page.runDocumentMoreAction(moreEvent('voidApprove'));
  assert.equal(modals[0].title, '确认作废销售单');
  assert.equal(calls.length, 0);
  page.data.activeAction = { ...page.data.activeAction, id: 'void-2' };
  await modals[0].success({ confirm: true });
  assert.equal(calls.length, 0);
  page.toggleDocumentMore();
  page.data.activeAction.bizId = 'a-different-document';
  page.runDocumentMoreAction(moreEvent('voidReject'));
  assert.equal(modals.length, 1);
});
