'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const event = data => ({ currentTarget: { dataset: data } });
const plain = value => JSON.parse(JSON.stringify(value));

function harness(fileTransfer = {}) {
  let page;
  const modals = [], navigation = [], calls = [], scrolls = [], previews = [];
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../pages/contract-preview/contract-preview.js'), 'utf8'), {
    Page: definition => { page = definition; },
    wx: { env: { USER_DATA_PATH: '/test' }, showModal: value => modals.push(value), navigateTo: value => navigation.push(value),
      pageScrollTo: value => scrolls.push(value), showToast() {} },
    require: id => id.endsWith('/fileTransfer') ? fileTransfer
      : id.endsWith('/pdfPreview') ? { createPdfPreview: options => {
        const preview = { options, loads: [], retries: [], imageErrors: [], disposed: false,
          load(force) { this.loads.push(force); }, retry(page) { this.retries.push(page); },
          imageError(page) { this.imageErrors.push(page); }, dispose() { this.disposed = true; } };
        previews.push(preview);
        return preview;
      } }
      : id.endsWith('/request') ? { request: async options => { calls.push(options); return {}; } }
      : id.endsWith('/retail') ? require('../utils/retail') : {}, setTimeout() {}, clearTimeout() {}
  });
  page.setData = (value, callback) => { Object.assign(page.data, value); if (callback) callback(); };
  Object.assign(page.data, { contractId: '12', canViewContractContent: true, canViewPayments: true,
    canViewInvoices: true, canViewOtherAttachments: true, canCreateSalesOrder: true, canUploadAttachments: true });
  return { page, modals, navigation, calls, scrolls, previews };
}

test('finance filters show only permitted categories and preserve exact record IDs and zero amounts', () => {
  const { page } = harness();
  Object.assign(page.data, { canViewContractContent: false, canViewOtherAttachments: false,
    salesDocuments: [{ id: 'hidden', documentNo: 'hidden' }],
    invoiceList: [{ id: '9007199254740993', invoiceNo: 'FP-1', invoiceAmount: 0, invoiceDate: '2026-10-29' }] });
  page.updateFulfillmentCount();
  assert.equal(page.data.fulfillmentCount, 1);
  assert.deepEqual(plain(page.data.fulfillmentTabs.map(item => item.key)), ['ALL', 'PAYMENT_VOUCHER', 'INVOICE']);
  page.filterFulfillment(event({ key: 'INVOICE' }));
  const record = page.data.visibleFulfillmentGroups[0].items[0];
  assert.equal(record.id, '9007199254740993');
  assert.equal(record.amountText, '¥0.00');
  assert.equal(record.dateText, '2026-10-29');
});

test('sales and return rows go directly to details and no longer offer a duplicate outer menu', () => {
  const { page, navigation } = harness();
  page.data.salesDocuments = [{ id: '9007199254740993', documentNo: 'XS-一号', status: 'DRAFT', canDeleteDraft: true }];
  page.openFulfillmentRecord(event({ kind: 'SALES_ORDER', id: '9007199254740993' }));
  assert.equal(navigation[0].url, '/pages/sales-order-detail/sales-order-detail?id=9007199254740993&documentNo=XS-%E4%B8%80%E5%8F%B7');
  page.openFulfillmentMenu(event({ kind: 'SALES_ORDER', id: '9007199254740993' }));
  assert.equal(page.data.showFulfillmentMenu, false);
  page.data.returnDocuments = [{ id: 'return-1', documentNo: 'TH-1' }];
  page.openFulfillmentRecord(event({ kind: 'RETURN_ORDER', id: 'return-1' }));
  assert.match(navigation[1].url, /id=return-1&documentNo=TH-1$/);
});

test('invoice approval from more keeps the original confirmation step and cannot reuse revoked permissions', () => {
  const { page, modals, calls } = harness();
  const invoice = { id: '9', category: 'INVOICE', originalName: '发票.pdf', canConfirm: true };
  page.data.invoiceList = [invoice];
  page.openFulfillmentMenu(event({ kind: 'INVOICE', id: '9' }));
  page.runFulfillmentAction(event({ key: 'APPROVE' }));
  assert.equal(modals.length, 1);
  assert.equal(modals[0].title, '确认发票');
  assert.equal(calls.length, 0);
  assert.equal(page.data.showFulfillmentMenu, false);
  page.openFulfillmentMenu(event({ kind: 'INVOICE', id: '9' }));
  invoice.canConfirm = false;
  page.runFulfillmentAction(event({ key: 'APPROVE' }));
  assert.equal(modals.length, 1);
});

test('read-only and lost-view access remove mutation actions and close stale menus', () => {
  const { page, modals } = harness();
  page.data.invoiceList = [{ id: '9', canDelete: true, canConfirm: true }];
  page.data.contractReadOnly = true;
  page.openFulfillmentMenu(event({ kind: 'INVOICE', id: '9' }));
  assert.deepEqual(plain(page.data.fulfillmentMenuActions.map(item => item.key)), ['VIEW', 'DOWNLOAD']);
  page.runFulfillmentAction(event({ key: 'DELETE' }));
  assert.equal(modals.length, 0);
  assert.equal(page.fulfillmentCreateActions().length, 0);
  page.openFulfillmentMenu(event({ kind: 'INVOICE', id: '9' }));
  page.data.canViewInvoices = false;
  page.updateFulfillmentCount();
  assert.equal(page.data.showFulfillmentMenu, false);
  assert.equal(page.data.visibleFulfillmentGroups.some(group => group.key === 'INVOICE'), false);
});

test('add within an invoice filter opens its upload flow and a stale contract menu cannot dispatch', () => {
  const { page, modals } = harness();
  page.data.fulfillmentFilter = 'INVOICE';
  let category;
  page.chooseAttachment = e => { category = e.currentTarget.dataset.category; };
  page.openAddFulfillment();
  assert.equal(category, 'INVOICE');
  page.data.invoiceList = [{ id: '9', canDelete: true }];
  page.openFulfillmentMenu(event({ kind: 'INVOICE', id: '9' }));
  page.data.contractId = '13';
  page.runFulfillmentAction(event({ key: 'DELETE' }));
  assert.equal(modals.length, 0);
});

test('overview is bounded while view-all and search operate on the entire category', () => {
  const { page, scrolls } = harness();
  page.data.salesDocuments = Array.from({ length: 45 }, (_, index) => ({
    id: '9007199254740993' + String(index), documentNo: `XS-${index + 1}`,
    status: index % 2 ? 'ISSUED' : 'INBOUNDED', dateText: '2026-10-29'
  }));
  page.data.paymentAttachments = Array.from({ length: 28 }, (_, index) => ({ id: String(index), originalName: `凭证-${index}` }));
  page.updateFulfillmentCount();
  assert.equal(page.data.fulfillmentCount, 73);
  assert.deepEqual(plain(page.data.visibleFulfillmentGroups.filter(group => group.count).map(group => group.items.length)), [3, 3]);
  assert.equal(page.data.visibleFulfillmentGroups[0].count, 45);
  page.filterFulfillment(event({ key: 'SALES_ORDER' }));
  assert.equal(scrolls[0].selector, '#fulfillment-panel');
  assert.equal(page.data.fulfillmentTabAnchor, 'fulfillment-filter-SALES_ORDER');
  assert.equal(page.data.visibleFulfillmentGroups[0].items.length, 20);
  assert.equal(page.data.fulfillmentHasMore, true);
  page.showMoreFulfillment();
  assert.equal(page.data.visibleFulfillmentGroups[0].items.length, 40);
  page.onFulfillmentSearch({ detail: { value: 'XS-45' } });
  assert.equal(page.data.visibleFulfillmentGroups[0].items.length, 1);
  assert.equal(page.data.visibleFulfillmentGroups[0].items[0].id, page.data.salesDocuments[44].id);
  assert.equal(page.data.fulfillmentHasMore, false);
  assert.equal(page.data.fulfillmentMatchCount, 1);
  page.clearFulfillmentSearch();
  assert.equal(page.data.visibleFulfillmentGroups[0].items.length, 20);
});

test('status filtering precedes batching and switching category resets prior search and batch state', () => {
  const { page } = harness();
  page.data.invoiceList = Array.from({ length: 50 }, (_, index) => ({ id: String(index),
    invoiceNo: `FP-${index}`, status: index < 30 ? 'APPROVED' : 'PENDING_CONFIRMATION' }));
  page.filterFulfillment(event({ key: 'INVOICE' }));
  page.showMoreFulfillment();
  page.onFulfillmentStatusChange({ detail: { value: '1' } });
  assert.equal(page.data.fulfillmentMatchCount, 20);
  assert.equal(page.data.visibleFulfillmentGroups[0].items[0].id, '30');
  assert.equal(page.data.fulfillmentHasMore, false);
  page.onFulfillmentSearch({ detail: { value: 'FP-49' } });
  assert.equal(page.data.fulfillmentMatchCount, 1);
  page.filterFulfillment(event({ key: 'LOGISTICS' }));
  assert.equal(page.data.fulfillmentSearch, '');
  assert.equal(page.data.fulfillmentStatusIndex, 0);
  assert.equal(page.data.fulfillmentVisibleLimit, 20);
  assert.equal(page.data.fulfillmentShowStatus, false);
});

test('refreshes replace expanded records and lost category access returns to a clean overview', () => {
  const { page } = harness();
  page.data.invoiceList = Array.from({ length: 41 }, (_, index) => ({ id: String(index) }));
  page.filterFulfillment(event({ key: 'INVOICE' }));
  page.showMoreFulfillment();
  page.data.invoiceList = [{ id: 'latest', invoiceNo: 'FP-最新' }];
  page.updateFulfillmentCount();
  assert.equal(page.data.visibleFulfillmentGroups[0].items.length, 1);
  assert.equal(page.data.visibleFulfillmentGroups[0].items[0].id, 'latest');
  assert.equal(page.data.fulfillmentHasMore, false);
  page.onFulfillmentSearch({ detail: { value: 'FP' } });
  page.data.canViewInvoices = false;
  page.updateFulfillmentCount();
  assert.equal(page.data.fulfillmentFilter, 'ALL');
  assert.equal(page.data.fulfillmentSearch, '');
  assert.equal(page.data.fulfillmentStatusIndex, 0);
  assert.equal(page.data.fulfillmentCreateLabel, '');
  assert.equal(page.data.visibleFulfillmentGroups.some(group => group.key === 'INVOICE'), false);
});

test('overview plus creates the requested category including empty categories and rechecks current rights', () => {
  const { page } = harness();
  page.data.canCreateReturnOrder = true;
  page.updateFulfillmentCount();
  assert.equal(page.data.visibleFulfillmentGroups.find(group => group.key === 'SALES_ORDER').createLabel, '新建销售单');
  assert.equal(page.data.visibleFulfillmentGroups.find(group => group.key === 'RETURN_ORDER').count, 0);
  const created = [];
  page.createBusinessDocument = e => created.push(e.currentTarget.dataset.type);
  page.chooseAttachment = e => created.push(e.currentTarget.dataset.category);
  page.openAddFulfillment(event({ kind: 'RETURN_ORDER' }));
  page.openAddFulfillment(event({ kind: 'PAYMENT_VOUCHER' }));
  assert.deepEqual(created, ['RETURN_ORDER', 'PAYMENT_VOUCHER']);
  page.data.contractReadOnly = true;
  page.openAddFulfillment(event({ kind: 'RETURN_ORDER' }));
  page.updateFulfillmentCount();
  assert.deepEqual(created, ['RETURN_ORDER', 'PAYMENT_VOUCHER']);
  assert.equal(page.data.visibleFulfillmentGroups.length, 0);
});

test('file rows open content details and retain actions inside more after refreshing the record', () => {
  const { page, modals } = harness();
  page.data.invoiceList = [{ id: '9007199254740993', category: 'INVOICE', invoiceNo: 'FP-1', invoiceAmount: 0,
    originalName: '发票.pdf', statusText: '待我方确认', canConfirm: true }];
  page.openFulfillmentRecord(event({ kind: 'INVOICE', id: '9007199254740993' }));
  assert.equal(page.data.showFulfillmentDetail, true);
  assert.equal(page.data.showFulfillmentMenu, false);
  assert.equal(page.data.fulfillmentDetail.amountText, '¥0.00');
  let viewed;
  page.viewAttachment = e => { viewed = e.currentTarget.dataset.attachment.id; };
  page.viewFulfillmentDetailFile();
  assert.equal(viewed, '9007199254740993');
  page.openFulfillmentDetailMore();
  assert.deepEqual(plain(page.data.fulfillmentMenuActions.map(action => action.key)), ['APPROVE', 'REJECT']);
  page.runFulfillmentAction(event({ key: 'APPROVE' }));
  assert.equal(modals[0].title, '确认发票');
  page.data.invoiceList = [{ id: '9007199254740993', originalName: '发票.pdf', statusText: '已通过', canRequestVoid: true }];
  page.updateFulfillmentCount();
  assert.equal(page.data.fulfillmentDetail.statusText, '已通过');
  page.openFulfillmentDetailMore();
  assert.deepEqual(plain(page.data.fulfillmentMenuActions.map(action => action.key)), ['VOID']);
  page.data.canViewInvoices = false;
  page.updateFulfillmentCount();
  assert.equal(page.data.showFulfillmentDetail, false);
  assert.equal(page.data.showFulfillmentMenu, false);
  assert.equal(page.data.fulfillmentDetail, null);
});

test('late image loads cannot overwrite a different file or reopen a closed detail', async () => {
  const pending = [];
  const { page } = harness({ localFileReady: () => false,
    downloadChunkedApiFile: () => new Promise(resolve => pending.push(resolve)) });
  page.data.otherAttachments = [
    { id: 'a', contentType: 'image/png', originalName: 'a.png' },
    { id: 'b', contentType: 'image/png', originalName: 'b.png' }
  ];
  page.openFulfillmentRecord(event({ kind: 'OTHER', id: 'a' }));
  page.openFulfillmentRecord(event({ kind: 'OTHER', id: 'b' }));
  pending[0]({ filePath: '/a.png' });
  await Promise.resolve();
  assert.equal(page.data.fulfillmentDetail.id, 'b');
  assert.equal(page.data.fulfillmentDetailImage, '');
  assert.equal(page.data.fulfillmentDetailImageLoading, true);
  page.closeFulfillmentDetail();
  pending[1]({ filePath: '/b.png' });
  await Promise.resolve();
  assert.equal(page.data.showFulfillmentDetail, false);
  assert.equal(page.data.fulfillmentDetailImage, '');
});

test('a pending void can be reviewed or withdrawn while ordinary attachment edits remain locked', async () => {
  const { page, modals, calls } = harness();
  page.data.contract = { status: 'ACTIVE' };
  page.data.contractReadOnly = true;
  const invoice = { id: '9', category: 'INVOICE', pendingActionId: 'action-1', pendingActionType: 'VOID',
    contentType: 'application/pdf', pendingActionReason: '发票金额有误', canReviewAction: true, canConfirm: true, canDelete: true };
  page.data.invoiceList = [invoice];
  page.openFulfillmentRecord(event({ kind: 'INVOICE', id: '9' }));
  assert.equal(page.data.fulfillmentDetail.statusText, '作废待确认');
  assert.equal(page.data.fulfillmentDetail.fields.find(field => field.label === '作废原因').value, '发票金额有误');
  page.openFulfillmentDetailMore();
  assert.deepEqual(plain(page.data.fulfillmentMenuActions.map(item => item.key)), ['VOID_APPROVE', 'VOID_REJECT']);
  page.runFulfillmentAction(event({ key: 'VOID_APPROVE' }));
  assert.equal(modals[0].title, '确认作废资料');
  assert.equal(calls.length, 0);
  invoice.canReviewAction = false;
  invoice.canCancelAction = true;
  page.loadContractDetail = async () => {};
  page.openFulfillmentDetailMore();
  assert.deepEqual(plain(page.data.fulfillmentMenuActions.map(item => item.key)), ['VOID_CANCEL']);
  await page.runFulfillmentAction(event({ key: 'VOID_CANCEL' }));
  assert.equal(calls[0].url, '/bilateral-actions/action-1/cancel');
  page.data.contract.status = 'COMPLETED';
  page.openFulfillmentDetailMore();
  assert.equal(page.data.showFulfillmentMenu, false);
});

test('a replaced pending request cannot be processed from the previous attachment menu', () => {
  const { page, modals, calls } = harness();
  const invoice = { id: '9', category: 'INVOICE', pendingActionId: 'old', pendingActionType: 'VOID', canReviewAction: true };
  page.data.invoiceList = [invoice];
  page.openFulfillmentRecord(event({ kind: 'INVOICE', id: '9' }));
  page.openFulfillmentDetailMore();
  invoice.pendingActionId = 'new';
  page.runFulfillmentAction(event({ key: 'VOID_APPROVE' }));
  assert.equal(modals.length, 0);
  assert.equal(calls.length, 0);
  assert.equal(page.data.showFulfillmentMenu, false);
});

test('reopening an image shares its pending download and file actions wait until loading completes', async () => {
  let complete, downloads = 0, fileActions = 0;
  const { page } = harness({ localFileReady: () => false, downloadChunkedApiFile: () => {
    downloads += 1;
    return new Promise(resolve => { complete = resolve; });
  } });
  page.data.otherAttachments = [{ id: 'image-1', category: 'OTHER', originalName: '图片.png', contentType: 'image/png' }];
  page.viewAttachment = page.downloadAttachment = () => { fileActions += 1; };
  page.openFulfillmentRecord(event({ kind: 'OTHER', id: 'image-1' }));
  page.viewFulfillmentDetailFile();
  page.openFulfillmentDetailMore();
  page.runFulfillmentAction(event({ key: 'DOWNLOAD' }));
  assert.equal(fileActions, 0);
  page.closeFulfillmentDetail();
  page.openFulfillmentRecord(event({ kind: 'OTHER', id: 'image-1' }));
  assert.equal(downloads, 1);
  complete({ filePath: '/ready.png' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(page.data.fulfillmentDetailImage, '/ready.png');
  assert.equal(page.data.fulfillmentDetailImageLoading, false);
  page.openFulfillmentDetailMore();
  page.runFulfillmentAction(event({ key: 'DOWNLOAD' }));
  assert.equal(fileActions, 1);
});

test('PDF attachment details load real pages and keep view/download below the preview', async () => {
  const { page, previews } = harness();
  page.data.invoiceList = [{ id: '9007199254740993', category: 'INVOICE', contentType: 'Application/PDF; charset=binary',
    originalName: '发票', canRequestVoid: true }];
  page.openFulfillmentRecord(event({ kind: 'INVOICE', id: '9007199254740993' }));
  assert.equal(previews.length, 1);
  assert.equal(previews[0].options.baseUrl, '/contract-attachments/9007199254740993');
  assert.deepEqual(previews[0].loads, [false]);
  previews[0].options.onState({ pages: [{ pageNumber: 1, filePath: '/one.png' }, { pageNumber: 2, filePath: '/two.png' }], loading: false, error: '', versionChanged: false });
  assert.equal(page.data.fulfillmentDetailPdfPages.length, 2);
  page.retryFulfillmentDetailPdf(event({ page: 2 }));
  page.onFulfillmentPdfImageError(event({ page: 1 }));
  assert.deepEqual(previews[0].retries, [2]);
  assert.deepEqual(previews[0].imageErrors, [1]);
  const files = [];
  page.downloadAttachmentFile = async (attachment, download, options) => files.push({ id: attachment.id, download, current: options.shouldContinue() });
  await page.openFulfillmentDetailPdf(event({}));
  await page.openFulfillmentDetailPdf(event({ download: true }));
  assert.deepEqual(files, [{ id: '9007199254740993', download: false, current: true }, { id: '9007199254740993', download: true, current: true }]);
  page.openFulfillmentDetailMore();
  assert.deepEqual(plain(page.data.fulfillmentMenuActions.map(action => action.key)), ['VOID']);
  page.closeFulfillmentDetail();
  assert.equal(previews[0].disposed, true);
  previews[0].options.onState({ pages: [{ pageNumber: 9, filePath: '/late.png' }], loading: false });
  assert.deepEqual(plain(page.data.fulfillmentDetailPdfPages), []);
});

test('PDF preview responses cannot cross attachment switches or revoked view permissions', () => {
  const { page, previews } = harness();
  page.data.invoiceList = [{ id: 'a', originalName: 'a.PDF' }, { id: 'b', originalName: 'b.pdf' }];
  page.openFulfillmentRecord(event({ kind: 'INVOICE', id: 'a' }));
  page.openFulfillmentRecord(event({ kind: 'INVOICE', id: 'b' }));
  assert.equal(previews[0].disposed, true);
  assert.equal(previews[0].options.isCurrent(), false);
  previews[0].options.onState({ pages: [{ pageNumber: 1, filePath: '/a.png' }] });
  assert.equal(page.data.fulfillmentDetailPdfPages.length, 0);
  page.data.canViewInvoices = false;
  page.updateFulfillmentCount();
  assert.equal(previews[1].disposed, true);
  assert.equal(previews[1].options.isCurrent(), false);
  assert.equal(page.data.showFulfillmentDetail, false);
});
