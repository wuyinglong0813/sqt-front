'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function harness() {
  const root = path.join(__dirname, '..');
  const app = { globalData: { baseUrl: 'https://api.example.test', token: 'session', currentCompanyId: 'company-1' } };
  const requests = [], writes = [], removed = [], opened = [], notices = [];
  const wx = {
    env: { USER_DATA_PATH: '/user' }, getStorageSync: () => '',
    showLoading() {}, hideLoading() {},
    showToast: options => notices.push(options.title),
    openDocument: options => opened.push(options),
    getFileSystemManager: () => ({
      writeFile: options => { writes.push(options); options.success(); },
      unlinkSync: file => removed.push(file)
    }),
    request: options => requests.push(options)
  };
  const modules = new Map();
  function load(file) {
    const absolute = path.resolve(root, file);
    if (modules.has(absolute)) return modules.get(absolute).exports;
    const module = { exports: {} };
    modules.set(absolute, module);
    vm.runInNewContext(fs.readFileSync(absolute, 'utf8'), {
      module, exports: module.exports, wx, getApp: () => app,
      require: id => load(path.relative(root, path.resolve(path.dirname(absolute), `${id}.js`)))
    }, { filename: absolute });
    return module.exports;
  }
  function page(file) {
    let definition;
    const absolute = path.resolve(root, file);
    vm.runInNewContext(fs.readFileSync(absolute, 'utf8'), {
      wx, getApp: () => app, Page: value => { definition = value; },
      require: id => load(path.relative(root, path.resolve(path.dirname(absolute), `${id}.js`)))
    }, { filename: absolute });
    const result = { ...definition, data: structuredClone(definition.data) };
    result.setData = (values, callback) => { Object.assign(result.data, values); if (callback) callback(); };
    result.data.id = '31';
    return result;
  }
  function succeed(index = 0) {
    requests[index].success({ statusCode: 200, data: { code: 0, data: {
      contentBase64: 'JVBERi0=', fileName: '销售单.pdf', contentType: 'application/pdf'
    } } });
  }
  return { app, wx, requests, writes, removed, opened, notices, page, succeed,
    download: load('utils/fileTransfer.js').downloadApiFile };
}

const settle = () => new Promise(resolve => setImmediate(resolve));

test('a transient PDF transport failure retries once with the same authenticated file request', async () => {
  const h = harness();
  const pending = h.download('/trade-documents/31/pdf-data', '/user/sales.pdf');
  h.requests[0].fail({ errMsg: 'request:fail timeout' });
  await settle();
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[1].timeout, 60000);
  assert.equal(h.requests[1].header.Authorization, 'session');
  assert.equal(h.requests[1].header['X-Company-Id'], 'company-1');
  h.succeed(1);
  assert.equal((await pending).filePath, '/user/sales.pdf');
  assert.equal(h.writes.length, 1);
});

test('persistent transport failures stop after one retry and show an actionable message', async () => {
  const h = harness();
  const pending = assert.rejects(h.download('/pdf-data', '/user/sales.pdf'), /下载超时.*重试/);
  h.requests[0].fail({ errMsg: 'request:fail timeout' });
  await settle();
  h.requests[1].fail({ errMsg: 'request:fail timeout' });
  await pending;
  assert.equal(h.requests.length, 2);
  assert.equal(h.writes.length, 0);
});

test('authorization and business failures are never retried as network errors', async () => {
  for (const statusCode of [403, 500]) {
    const h = harness();
    const pending = assert.rejects(h.download('/pdf-data', '/user/sales.pdf'), /无权查看/);
    h.requests[0].success({ statusCode, data: { code: statusCode, message: '无权查看' } });
    await pending;
    assert.equal(h.requests.length, 1);
    assert.equal(h.writes.length, 0);
  }
});

test('switching company during a failed download prevents retries in the new company', async () => {
  const h = harness();
  const pending = assert.rejects(h.download('/pdf-data', '/user/sales.pdf'), /企业或登录状态已变化/);
  h.app.globalData.currentCompanyId = 'company-2';
  h.requests[0].fail({ errMsg: 'request:fail timeout' });
  await pending;
  assert.equal(h.requests.length, 1);
  assert.equal(h.writes.length, 0);
});

test('leaving a page before the file response prevents writing or reopening it', async () => {
  const h = harness();
  let visible = true;
  const pending = assert.rejects(h.download('/pdf-data', '/user/sales.pdf', {
    shouldContinue: () => visible
  }), /已取消下载/);
  visible = false;
  h.succeed();
  await pending;
  assert.equal(h.writes.length, 0);
});

test('a failed local write removes the partial file without requesting another PDF', async () => {
  const h = harness();
  h.wx.getFileSystemManager = () => ({
    writeFile: options => options.fail({ errMsg: '存储空间不足' }),
    unlinkSync: file => h.removed.push(file)
  });
  const pending = assert.rejects(h.download('/pdf-data', '/user/sales.pdf'), /存储空间不足/);
  h.succeed();
  await pending;
  assert.deepEqual(h.removed, ['/user/sales.pdf']);
  assert.equal(h.requests.length, 1);
});

test('leaving while the file is being saved removes the cancelled output', async () => {
  const h = harness();
  let finishWrite, visible = true;
  h.wx.getFileSystemManager = () => ({
    writeFile: options => { finishWrite = options.success; },
    unlinkSync: file => h.removed.push(file)
  });
  const pending = assert.rejects(h.download('/pdf-data', '/user/sales.pdf', {
    shouldContinue: () => visible
  }), /已取消下载/);
  h.succeed(); await settle();
  visible = false;
  finishWrite(); await pending;
  assert.deepEqual(h.removed, ['/user/sales.pdf']);
});

for (const kind of ['contract', 'sales']) {
  function start(page) {
    return kind === 'contract'
      ? page.downloadBusinessDocumentFile({ id: '31', documentNo: 'XS-31' }, true)
      : page.downloadPdf(true);
  }
  function setup() {
    const h = harness();
    h.view = h.page(kind === 'contract' ? 'pages/contract-preview/contract-preview.js'
      : 'pages/sales-order-detail/sales-order-detail.js');
    return h;
  }
  test(`${kind} PDF actions ignore repeated taps and can download again after completion`, async () => {
    const h = setup();
    const first = start(h.view);
    await start(h.view);
    assert.equal(h.requests.length, 1);
    h.succeed(); await first;
    assert.equal(h.opened.length, 1);
    const next = start(h.view);
    assert.equal(h.requests.length, 2);
    h.succeed(1); await next;
    assert.equal(h.opened.length, 2);
  });
  test(`${kind} PDF response arriving after unload never opens a document or reports success`, async () => {
    const h = setup();
    const pending = start(h.view);
    h.view.onUnload();
    h.succeed(); await pending;
    assert.equal(h.opened.length, 0);
    assert.equal(h.notices.length, 0);
    assert.equal(h.writes.length, 0);
  });
  test(`${kind} PDF failure releases the download action for a manual retry`, async () => {
    const h = setup();
    const failed = start(h.view);
    h.requests[0].success({ statusCode: 500, data: { code: 500, message: 'PDF生成失败' } });
    await failed;
    assert.match(h.notices[0], /PDF生成失败/);
    const retry = start(h.view);
    assert.equal(h.requests.length, 2);
    h.succeed(1); await retry;
    assert.equal(h.opened.length, 1);
  });
}
