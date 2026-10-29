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
const tick = () => new Promise(resolve => setImmediate(resolve));
const plain = value => JSON.parse(JSON.stringify(value));
function harness({ manifest = () => ({ totalPages: 2, previewKey: 'version-1' }), download, cached = () => false } = {}) {
  const calls = [], downloads = [], updates = [], module = { exports: {} };
  const app = { globalData: { token: 'token-a', currentCompanyId: 'company-a' }, _companyAccessGeneration: 0 };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../utils/pdfPreview.js'), 'utf8'), {
    module, getApp: () => app, wx: { env: { USER_DATA_PATH: '/files' } },
    require: id => id === './request' ? { request: options => { calls.push(options); return Promise.resolve().then(() => manifest(options)); } }
      : id === './fileTransfer' ? { localFileReady: cached, downloadChunkedApiFile: (url, filePath) => {
        const operation = { url, filePath, ...deferred() }; downloads.push(operation);
        return download ? Promise.resolve().then(() => download(operation)) : operation.promise;
      } } : require('../utils/companyContext')
  });
  let visible = true;
  const create = (extra = {}) => module.exports.createPdfPreview({ baseUrl: '/trade-documents/9007199254740993',
    cachePrefix: 'trade-document-9007199254740993', isCurrent: () => visible, onState: state => updates.push(plain(state)), ...extra });
  const preview = create();
  return { preview, create, calls, downloads, updates, app, hide: () => { visible = false; } };
}

test('all real PDF pages stay in reading order while only two page downloads run together', async () => {
  const env = harness({ manifest: () => ({ totalPages: 4, previewKey: 'actual-pdf-hash' }) });
  const load = env.preview.load();
  await tick();
  assert.equal(env.downloads.length, 2);
  assert.deepEqual(Array.from(env.preview.getState().pages, page => page.pageNumber), [1, 2, 3, 4]);
  assert.match(env.downloads[0].url, /^\/trade-documents\/9007199254740993\/preview-chunk-data\?page=1&previewKey=actual-pdf-hash$/);
  env.downloads[1].resolve({ filePath: '/page-2.png' });
  await tick();
  assert.equal(env.downloads.length, 3);
  env.downloads[0].resolve({ filePath: '/page-1.png' });
  await tick();
  assert.equal(env.downloads.length, 4);
  env.downloads[3].resolve({ filePath: '/page-4.png' });
  env.downloads[2].resolve({ filePath: '/page-3.png' });
  await load;
  assert.deepEqual(Array.from(env.preview.getState().pages, page => page.filePath), ['/page-1.png', '/page-2.png', '/page-3.png', '/page-4.png']);
  assert.equal(env.preview.getState().loading, false);
});

test('one failed page does not hide other pages and can be reloaded after a display failure', async () => {
  let firstFailure = true;
  const env = harness({ download: ({ url, filePath }) => {
    if (/page=2&/.test(url) && firstFailure) throw new Error('network failure');
    return { filePath };
  } });
  await env.preview.load();
  assert.ok(env.preview.getState().pages[0].filePath);
  assert.equal(env.preview.getState().pages[1].error, '第 2 页加载失败，请重试');
  firstFailure = false;
  await env.preview.retry(2);
  assert.ok(env.preview.getState().pages[1].filePath);
  env.preview.imageError(2);
  assert.equal(env.preview.getState().pages[1].filePath, '');
  assert.equal(env.preview.getState().pages[1].error, '第 2 页显示失败，请重试');
  await env.preview.retry(2);
  assert.equal(env.downloads.length, 4);
  const before = env.downloads.length;
  await env.preview.retry(0); env.preview.imageError(999);
  assert.equal(env.downloads.length, before);
});

test('a changed PDF key clears every old image and retry obtains a new manifest', async () => {
  let version = 'old';
  const env = harness({ manifest: () => ({ totalPages: 2, previewKey: version }) });
  const old = env.preview.load(); await tick();
  env.downloads[0].resolve({ filePath: '/old-1.png' }); await tick();
  env.downloads[1].reject(Object.assign(new Error('key changed'), { code: 409 }));
  await old;
  assert.deepEqual(plain(env.preview.getState().pages), []);
  assert.equal(env.preview.getState().versionChanged, true);
  assert.equal(env.preview.getState().loading, false);
  version = 'new';
  const latest = env.preview.retry(1); await tick();
  assert.equal(env.calls.length, 2);
  assert.ok(env.downloads[2].url.endsWith('previewKey=new'));
  env.downloads[2].resolve({ filePath: '/new-1.png' });
  env.downloads[3].resolve({ filePath: '/new-2.png' });
  await latest;
  assert.equal(env.preview.getState().versionChanged, false);
  assert.deepEqual(Array.from(env.preview.getState().pages, page => page.filePath), ['/new-1.png', '/new-2.png']);
});

test('malformed or denied manifests never leave stale or fabricated document content', async () => {
  for (const result of [null, { totalPages: 0, previewKey: 'ok' }, { totalPages: 1.5, previewKey: 'ok' },
    { totalPages: 501, previewKey: 'ok' }, { totalPages: 2, previewKey: '../unsafe' }, { totalPages: 2 }]) {
    const env = harness({ manifest: () => result });
    await env.preview.load();
    assert.equal(env.preview.getState().pages.length, 0);
    assert.ok(env.preview.getState().error);
    assert.equal(env.downloads.length, 0);
  }
  let denied = false;
  const env = harness({ manifest: () => { if (denied) throw Object.assign(new Error('Forbidden'), { code: 403 }); return { totalPages: 1, previewKey: 'valid' }; },
    download: ({ filePath }) => ({ filePath }) });
  await env.preview.load();
  assert.equal(env.preview.getState().pages.length, 1);
  denied = true;
  await env.preview.load(true);
  assert.equal(env.preview.getState().pages.length, 0);
  assert.ok(env.preview.getState().error);
});

test('a forced reload wins over a slower manifest and disposed sessions never publish late images', async () => {
  const slow = deferred(); let manifests = 0;
  const env = harness({ manifest: () => ++manifests === 1 ? slow.promise : { totalPages: 1, previewKey: 'latest' } });
  const first = env.preview.load(); await tick();
  const second = env.preview.load(true); await tick();
  assert.equal(env.downloads.length, 1);
  env.downloads[0].resolve({ filePath: '/latest.png' }); await second;
  slow.resolve({ totalPages: 3, previewKey: 'old' }); await first;
  assert.deepEqual(Array.from(env.preview.getState().pages, page => page.filePath), ['/latest.png']);
  const pending = env.preview.load(true); await tick();
  env.preview.dispose();
  const updateCount = env.updates.length;
  env.downloads[1].resolve({ filePath: '/after-close.png' }); await pending;
  assert.equal(env.updates.length, updateCount);
});

test('reopened previews share an immutable page writer and cached pages still require an authorized manifest', async () => {
  const env = harness({ manifest: () => ({ totalPages: 1, previewKey: 'shared' }) });
  const first = env.preview.load(); await tick();
  env.preview.dispose();
  const otherUpdates = [];
  const second = env.create({ onState: state => otherUpdates.push(plain(state)) });
  const secondLoad = second.load(); await tick();
  assert.equal(env.downloads.length, 1);
  env.downloads[0].resolve({ filePath: '/shared.png' });
  await Promise.all([first, secondLoad]);
  assert.equal(second.getState().pages[0].filePath, '/shared.png');
  assert.equal(otherUpdates.at(-1).loading, false);
  const cached = harness({ manifest: () => ({ totalPages: 1, previewKey: 'cache-key' }), cached: () => true });
  await cached.preview.load();
  assert.equal(cached.calls.length, 1);
  assert.equal(cached.downloads.length, 0);
  assert.match(cached.preview.getState().pages[0].filePath, /9007199254740993-cache-key-page-1\.png$/);
});

test('company or login changes invalidate pending pages, including switching away and back', async () => {
  for (const change of [env => { env.app.globalData.token = 'token-b'; },
    env => { env.app.globalData.currentCompanyId = 'company-b'; },
    env => { env.app._companyAccessGeneration += 2; }]) {
    const env = harness({ manifest: () => ({ totalPages: 1, previewKey: 'same-document' }) });
    const load = env.preview.load(); await tick();
    change(env);
    const updateCount = env.updates.length;
    env.downloads[0].resolve({ filePath: '/wrong-context.png' }); await load;
    assert.equal(env.updates.length, updateCount);
    await env.preview.load(true);
    assert.equal(env.calls.length, 1);
  }
});
