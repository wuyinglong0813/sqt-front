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
  const calls = [], titles = [], toasts = [], updates = [];
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,
    '../pages/sales-order-detail/sales-order-detail.js'), 'utf8'), {
    Page: value => { definition = value; },
    wx: { setNavigationBarTitle: value => titles.push(value.title),
      showToast: value => toasts.push(value.title) },
    require: id => id.endsWith('/request') ? {
      request: options => { calls.push(options); return Promise.resolve().then(() => handler(options)); }
    } : id.endsWith('/datetime') ? { formatDateTime: value => value } : {}
  });
  const page = { ...definition, data: structuredClone(definition.data) };
  page.setData = update => { updates.push(update); Object.assign(page.data, update); };
  page.data.id = '2098123456789012345';
  return { page, calls, titles, toasts, updates };
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

test('warehouse actions distinguish pending or failed warehouse reads from an empty list', async () => {
  const warehouses = deferred();
  const env = harness(options => options.url === '/warehouses' ? warehouses.promise
    : options.url === `/trade-documents/${env.page.data.id}` ? detail() : null);
  await env.page.loadAll();
  env.page.chooseWarehouse();
  assert.equal(env.toasts.at(-1), '仓库加载中，请稍候');
  warehouses.reject(new Error('request:fail timeout'));
  await tick();
  env.page.chooseWarehouse();
  assert.equal(env.toasts.at(-1), '仓库加载失败，请下拉重试');
});
