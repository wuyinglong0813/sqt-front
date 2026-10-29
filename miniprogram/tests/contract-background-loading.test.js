'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function harness() {
  let page;
  const requests = [], toasts = [], updates = [];
  const scriptPath = path.join(__dirname, '../pages/contract-preview/contract-preview.js');
  vm.runInNewContext(fs.readFileSync(scriptPath, 'utf8'), {
    Page: value => { page = value; },
    wx: { showToast: value => toasts.push(value) },
    require: id => id.endsWith('/request') ? { request: options => new Promise((resolve, reject) => {
      requests.push({ ...options, resolve, reject });
    }) } : require(path.resolve(path.dirname(scriptPath), id))
  });
  page.setData = (values, callback) => {
    updates.push(values);
    Object.assign(page.data, values);
    if (callback) callback();
  };
  Object.assign(page.data, { contractId: '12', canViewContractContent: true,
    canViewPayments: true, canViewInvoices: true, canViewOtherAttachments: true });
  return { page, requests, toasts, updates };
}

test('overlapping document reloads share one request per type and failures remain retryable in their section', async () => {
  const env = harness();
  const first = env.page.loadBusinessDocuments('SALES_ORDER');
  const same = env.page.loadBusinessDocuments('SALES_ORDER');
  const returns = env.page.loadBusinessDocuments('RETURN_ORDER');
  assert.equal(env.requests.length, 2);
  env.requests[0].reject(new Error('request:fail timeout'));
  env.requests[1].resolve([{ id: 'return-1' }]);
  await Promise.all([first, same, returns]);
  assert.equal(env.toasts.length, 0);
  assert.match(env.page.data.fulfillmentErrors.sales, /销售单加载失败/);
  assert.equal(env.page.data.returnDocuments[0].id, 'return-1');
  const retry = env.page.loadBusinessDocuments('SALES_ORDER');
  assert.equal(env.requests.length, 3);
  env.requests[2].resolve([{ id: 'sales-1' }]);
  await retry;
  assert.equal(env.page.data.salesDocuments[0].id, 'sales-1');
  assert.equal(env.page.data.fulfillmentErrors.sales, '');
});

test('a late document response cannot replace the current contract list', async () => {
  const env = harness();
  const old = env.page.loadBusinessDocuments('SALES_ORDER');
  env.page.data.contractId = '13';
  const current = env.page.loadBusinessDocuments('SALES_ORDER');
  env.requests[1].resolve([{ id: 'current' }]);
  await current;
  env.requests[0].resolve([{ id: 'obsolete' }]);
  await old;
  assert.equal(env.page.data.salesDocuments[0].id, 'current');
});

test('a document refresh after a mutation supersedes the old read for the same contract', async () => {
  const env = harness();
  const old = env.page.loadBusinessDocuments('SALES_ORDER');
  const current = env.page.loadBusinessDocuments('SALES_ORDER', true);
  assert.equal(env.requests.length, 2);
  env.requests[1].resolve([{ id: 'created' }]);
  await current;
  env.requests[0].resolve([]);
  await old;
  assert.equal(env.page.data.salesDocuments[0].id, 'created');
});

test('overlapping fulfillment reloads await one batch and preserve other section errors', async () => {
  const env = harness();
  env.page.data.fulfillmentErrors.sales = '销售单加载失败';
  env.page.data.logisticsList = [{ id: 'previous-logistics' }];
  const first = env.page.loadFulfillmentData();
  let sharedSettled = false;
  const same = env.page.loadFulfillmentData().then(() => { sharedSettled = true; });
  assert.equal(env.requests.length, 4);
  await Promise.resolve();
  assert.equal(sharedSettled, false);
  env.requests[0].reject(new Error('request:fail timeout'));
  env.requests.slice(1).forEach((request, index) => request.resolve([{ id: String(index) }]));
  await Promise.all([first, same]);
  assert.equal(env.toasts.length, 0);
  assert.equal(env.page.data.fulfillmentLoading, false);
  assert.equal(env.page.data.logisticsList[0].id, 'previous-logistics');
  assert.match(env.page.data.fulfillmentErrors.logistics, /物流单加载失败/);
  assert.equal(env.page.data.fulfillmentErrors.sales, '销售单加载失败');
  assert.equal(env.page.data.invoiceList.length, 1);
});

test('an unexpected fulfillment payload displays a retryable error in the derived list', async () => {
  const env = harness();
  const loading = env.page.loadFulfillmentData();
  env.requests[0].resolve({ invalid: true });
  env.requests.slice(1).forEach(request => request.resolve([]));
  await loading;
  assert.equal(env.page.data.fulfillmentLoading, false);
  assert.ok(env.page.data.visibleFulfillmentGroups.some(group => /加载失败/.test(group.errorText)));
});

test('changed contract or permissions start a new fulfillment batch and stale results do not replace it', async () => {
  const env = harness();
  const old = env.page.loadFulfillmentData();
  env.page.data.contractId = '13';
  env.page.data.canViewOtherAttachments = false;
  const current = env.page.loadFulfillmentData();
  assert.equal(env.requests.length, 7);
  env.requests.slice(4).forEach(request => request.resolve([{ id: 'current' }]));
  await current;
  env.requests.slice(0, 4).forEach(request => request.resolve([{ id: 'obsolete' }]));
  await old;
  assert.equal(env.page.data.invoiceList[0].id, 'current');
  assert.equal(env.page.data.otherAttachments.length, 0);
  assert.equal(env.page.data.fulfillmentLoading, false);
});

test('a fulfillment refresh after a mutation supersedes the previous batch and remains retryable', async () => {
  const env = harness();
  const old = env.page.loadFulfillmentData();
  const current = env.page.loadFulfillmentData(true);
  assert.equal(env.requests.length, 8);
  env.requests.slice(4).forEach(request => request.resolve([{ id: 'updated' }]));
  await current;
  env.requests.slice(0, 4).forEach(request => request.resolve([{ id: 'obsolete' }]));
  await old;
  assert.equal(env.page.data.invoiceList[0].id, 'updated');
  const retry = env.page.loadFulfillmentData();
  assert.equal(env.requests.length, 12);
  env.requests.slice(8).forEach(request => request.resolve([]));
  await retry;
  assert.equal(env.page.data.invoiceList.length, 0);
});

test('memo reloads share one request, retain existing notes on timeout and clear the inline error after retry', async () => {
  const env = harness();
  env.page.data.personalMemo = '已保存的备忘';
  env.page.data.memoPreview = '已保存的备忘';
  const first = env.page.loadContractMemo();
  const same = env.page.loadContractMemo();
  assert.equal(env.requests.length, 1);
  env.requests[0].reject(new Error('request:fail timeout'));
  await Promise.all([first, same]);
  assert.equal(env.toasts.length, 0);
  assert.equal(env.page.data.memoPreview, '已保存的备忘');
  assert.match(env.page.data.memoLoadError, /进展暂时无法读取/);
  const retry = env.page.loadContractMemo();
  env.requests[1].resolve({ content: '新备忘' });
  await retry;
  assert.equal(env.page.data.memoPreview, '新备忘');
  assert.equal(env.page.data.memoLoadError, '');
});

test('a memo read cannot overwrite a draft opened while it was pending', async () => {
  const env = harness();
  const pending = env.page.loadContractMemo();
  env.page.openMemoEditor();
  env.page.onMemoInput({ detail: { value: '编辑中的新内容' } });
  env.requests[0].resolve({ content: '先前保存的内容' });
  await pending;
  assert.equal(env.page.data.memoDraft, '编辑中的新内容');
  assert.equal(env.page.data.personalMemo, '先前保存的内容');
});

test('saving a memo invalidates a concurrent background read so old content cannot replace the saved result', async () => {
  const env = harness();
  env.page.data.memoDraft = '刚保存的内容';
  const save = env.page.saveContractMemo();
  const pending = env.page.loadContractMemo();
  env.requests[0].resolve({ content: '刚保存的内容' });
  await save;
  env.requests[1].resolve({ content: '旧内容' });
  await pending;
  assert.equal(env.page.data.memoDraft, '刚保存的内容');
  assert.equal(env.page.data.personalMemo, '刚保存的内容');
  assert.equal(env.page.data.memoLoadError, '');
});

test('opening personal progress during its initial read fills the untouched draft and prevents an empty save', async () => {
  const env = harness();
  const loading = env.page.loadContractMemo();
  env.page.openMemoEditor();
  await env.page.saveContractMemo();
  assert.equal(env.requests.length, 1);
  env.requests[0].resolve({ content: '上次约好周五送货' });
  await loading;
  assert.equal(env.page.data.memoDraft, '上次约好周五送货');
  assert.equal(env.page.data.memoLoading, false);
});

test('more menu opens personal progress without a summary and read-only contracts permit viewing only', async () => {
  const env = harness();
  env.page.data.contract = { id: '12' };
  env.page.data.personalMemo = '仅自己的记录';
  env.page.toggleContractMore();
  assert.equal(env.page.data.showContractMore, true);
  env.page.data.contractReadOnly = true;
  env.page.openMemoEditor();
  assert.equal(env.page.data.showContractMore, false);
  assert.equal(env.page.data.showMemoEditor, true);
  assert.equal(env.page.data.memoDraft, '仅自己的记录');
  await env.page.saveContractMemo();
  assert.equal(env.requests.length, 0);
  env.page.closeMemoEditor();
  env.page.data.canViewContractContent = false;
  env.page.toggleContractMore();
  env.page.openMemoEditor();
  assert.equal(env.page.data.showContractMore, false);
  assert.equal(env.page.data.showMemoEditor, false);
});

test('saving freezes the editor and a revoked viewer cannot repopulate private progress', async () => {
  const env = harness();
  env.page.data.memoDraft = '准备保存的内容';
  const save = env.page.saveContractMemo();
  env.page.onMemoInput({ detail: { value: '保存期间额外输入' } });
  assert.equal(env.page.data.memoDraft, '准备保存的内容');
  env.page.data.canViewContractContent = false;
  env.page.data.personalMemo = '';
  env.requests[0].resolve({ content: '准备保存的内容' });
  await save;
  assert.equal(env.page.data.personalMemo, '');
  assert.equal(env.page.data.memoSaving, false);
});

test('unloaded pages receive no background list, error or memo updates', async () => {
  const env = harness();
  const pending = [env.page.loadBusinessDocuments('SALES_ORDER'),
    env.page.loadFulfillmentData(), env.page.loadContractMemo()];
  const updatesBeforeUnload = env.updates.length;
  env.page._pdfPageUnloaded = true;
  env.requests.forEach((request, index) => {
    if (index % 2 === 0) request.resolve([]);
    else request.reject(new Error('request:fail timeout'));
  });
  await Promise.all(pending);
  assert.equal(env.updates.length, updatesBeforeUnload);
  assert.equal(env.toasts.length, 0);
});
