'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function harness(options = {}) {
  const scriptPath = path.join(__dirname, '../pages/contract-preview/contract-preview.js');
  const files = new Set(options.files || []);
  const removed = [], downloads = [], requests = [];
  let manifest = options.manifest || { pageCount: 4, archiveKey: 'signed-task-1' };
  let manifestError = options.manifestError;
  let page;
  const request = async requestOptions => {
    requests.push(requestOptions.url);
    if (manifestError) throw manifestError;
    return manifest;
  };
  const fileSystem = {
    readdirSync: () => Array.from(files).map(file => file.slice('/user/'.length)),
    unlinkSync: file => { removed.push(file); files.delete(file); }
  };
  const fileTransfer = {
    localFileReady: file => files.has(file),
    downloadChunkedApiFile: async (url, filePath) => {
      const params = new URL(url, 'https://example.test').searchParams;
      const pageNumber = params.has('page') ? Number(params.get('page')) : null;
      downloads.push({ url, filePath, pageNumber, archiveKey: params.get('archiveKey') });
      if (options.onDownload) await options.onDownload({ pageNumber, page, url });
      files.add(filePath);
      return { filePath };
    }
  };
  vm.runInNewContext(fs.readFileSync(scriptPath, 'utf8'), {
    Page: value => { page = value; },
    wx: { env: { USER_DATA_PATH: '/user' }, getFileSystemManager: () => fileSystem },
    require: id => id.endsWith('/fileTransfer') ? fileTransfer
      : id.endsWith('/request') ? { request }
        : require(path.resolve(path.dirname(scriptPath), id))
  });
  page.setData = (values, callback) => {
    Object.assign(page.data, values);
    if (callback) callback();
  };
  Object.assign(page.data, { contractId: '12', signedContractArchived: true });
  return { page, files, removed, downloads, requests,
    setManifest: value => { manifest = value; manifestError = null; } };
}

test('a four-page archive reveals every page in reading order, including the first and final pages', async () => {
  let firstPageVisibleBeforeSecondDownload = false;
  const env = harness({ onDownload: ({ pageNumber, page }) => {
    if (pageNumber === 2) {
      firstPageVisibleBeforeSecondDownload = !!page.data.signedPreviewPages[0].filePath;
      assert.equal(page.data.signedPreviewPages[3].loading, true);
    }
  } });
  await env.page.loadSignedContractPreview();
  assert.equal(firstPageVisibleBeforeSecondDownload, true);
  assert.deepEqual(env.downloads.map(item => item.pageNumber), [1, 2, 3, 4]);
  assert.ok(env.downloads.every(item => item.archiveKey === 'signed-task-1'));
  assert.equal(env.page.data.signedPreviewPages.length, 4);
  assert.equal(env.page.data.signedPreviewLoadedCount, 4);
  assert.equal(env.page.data.signedPreviewReady, true);
  assert.equal(env.page.data.signedPreviewLegacy, false);
  assert.equal(env.page.data.signedPreviewLoading, false);
});

test('a failed middle page leaves the other pages readable and can be retried on its own', async () => {
  let failSecondPage = true;
  const env = harness({ manifest: { pageCount: 3, archiveKey: 'task' },
    onDownload: ({ pageNumber }) => {
      if (pageNumber === 2 && failSecondPage) throw new Error('网络中断');
    } });
  await env.page.loadSignedContractPreview();
  assert.equal(env.page.data.signedPreviewLoadedCount, 2);
  assert.equal(env.page.data.signedPreviewReady, false);
  assert.match(env.page.data.signedPreviewPages[1].error, /网络中断/);
  assert.ok(env.page.data.signedPreviewPages[2].filePath);
  failSecondPage = false;
  await env.page.retrySignedContractPreview({ currentTarget: { dataset: { page: 2 } } });
  assert.deepEqual(env.downloads.map(item => item.pageNumber), [1, 2, 3, 2]);
  assert.equal(env.requests.length, 1);
  assert.equal(env.page.data.signedPreviewReady, true);
});

test('a changed archive version discards obsolete pages and never reuses another version cache', async () => {
  const env = harness({ manifest: { pageCount: 2, archiveKey: 'old-task' }, files: [
    '/user/contract-12-signed-preview.png', '/user/contract-99-signed-old-task-page-1.png'
  ] });
  await env.page.loadSignedContractPreview();
  env.setManifest({ pageCount: 3, archiveKey: 'new/task.2' });
  await env.page.loadSignedContractPreview();
  assert.equal(env.requests.length, 2);
  assert.equal(env.downloads.length, 5);
  assert.ok(env.downloads.slice(2).every(item => item.archiveKey === 'new/task.2'));
  assert.ok(env.downloads.slice(2).every(item => item.filePath.includes('new%2Ftask%2E2-page-')));
  assert.ok(env.removed.includes('/user/contract-12-signed-old-task-page-1.png'));
  assert.ok(env.removed.includes('/user/contract-12-signed-preview.png'));
  assert.ok(env.files.has('/user/contract-99-signed-old-task-page-1.png'));
  assert.equal(env.page.data.signedPreviewLoadedCount, 3);
});

test('all cached pages are reused only after the current archive manifest is read', async () => {
  const env = harness({ manifest: { pageCount: 3, archiveKey: 'task' },
    files: [1, 2, 3].map(number => `/user/contract-12-signed-task-page-${number}.png`) });
  await env.page.loadSignedContractPreview();
  await env.page.loadSignedContractPreview();
  assert.equal(env.requests.length, 2);
  assert.equal(env.downloads.length, 0);
  assert.equal(env.page.data.signedPreviewLoadedCount, 3);
});

test('only an unavailable manifest endpoint falls back to the clearly marked legacy signature page', async () => {
  const error = new Error('接口不存在');
  error.statusCode = 404;
  const env = harness({ manifestError: error });
  await env.page.loadSignedContractPreview();
  assert.equal(env.page.data.signedPreviewLegacy, true);
  assert.equal(env.page.data.signedPreviewPageCount, 0);
  assert.equal(env.downloads.length, 1);
  assert.equal(env.downloads[0].pageNumber, null);
  assert.ok(env.page.data.signedPreviewFilePath);
});

test('permission and network failures never silently show the partial legacy signature page', async () => {
  for (const statusCode of [403, 500, undefined]) {
    const error = new Error('加载失败');
    error.statusCode = statusCode;
    const env = harness({ manifestError: error });
    await env.page.loadSignedContractPreview();
    assert.equal(env.downloads.length, 0);
    assert.equal(env.page.data.signedPreviewLegacy, false);
    assert.equal(env.page.data.signedPreviewReady, false);
    assert.match(env.page.data.signedPreviewError, /加载失败/);
  }
});

test('a version change during download stops loading and clears pages from the obsolete archive', async () => {
  const env = harness({ onDownload: ({ pageNumber }) => {
    if (pageNumber === 2) {
      const error = new Error('合同归档版本已更新，请重新加载完整合同');
      error.code = 409;
      throw error;
    }
  } });
  await env.page.loadSignedContractPreview();
  assert.deepEqual(env.downloads.map(item => item.pageNumber), [1, 2]);
  assert.equal(env.page.data.signedPreviewVersionChanged, true);
  assert.equal(env.page.data.signedPreviewLoadedCount, 0);
  assert.ok(env.page.data.signedPreviewPages.every(item => !item.filePath && !item.loading));
});

test('leaving the contract page prevents an in-flight download from updating the old view', async () => {
  const env = harness({ onDownload: ({ page }) => { page.onUnload(); } });
  await env.page.loadSignedContractPreview();
  assert.equal(env.downloads.length, 1);
  assert.equal(env.page.data.signedPreviewLoadedCount, 0);
  assert.equal(env.page.data.signedPreviewReady, false);
});
