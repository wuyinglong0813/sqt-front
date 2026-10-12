'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const loadPrivacy = require('./privacy-fixture');

function harness() {
  const storage = {}, calls = [], toasts = [];
  const app = { globalData: { token: 'session', currentCompanyId: 'A' } };
  const wx = {
    env: { USER_DATA_PATH: '/wx-user-data' },
    getStorageSync: key => storage[key],
    setStorageSync: (key, value) => { storage[key] = value; },
    requirePrivacyAuthorize: options => options.success(),
    showToast: options => toasts.push(options.title),
    showModal: options => options.success({ confirm: true }),
    showTabBar: () => calls.push('show-tab-bar'),
    chooseMedia: () => calls.push('choose-media'),
    chooseMessageFile: () => calls.push('choose-file'),
    setClipboardData: () => calls.push('clipboard'),
    saveImageToPhotosAlbum: () => calls.push('save-image')
  };
  const privacy = loadPrivacy(wx, () => app);
  function page(file) {
    let result;
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), {
      Page: value => { result = value; }, wx, getApp: () => app, setTimeout, clearTimeout,
      require: id => {
        if (id.endsWith('/privacy')) return privacy;
        if (id.endsWith('/companyContext')) return require('../utils/companyContext');
        if (id.endsWith('/tabBar')) return require('../utils/tabBar');
        if (id.endsWith('/request')) return { request: async options => { calls.push(options); return { url: 'https://provider.test' }; } };
        if (id.endsWith('/fileTransfer')) return {
          localFileReady: () => true,
          downloadChunkedApiFile: () => assert.fail('cached file must not be downloaded')
        };
        return {};
      }
    });
    result.setData = values => Object.assign(result.data, values);
    return result;
  }
  return { app, wx, privacy, storage, calls, toasts, page };
}

test('legacy local boolean cannot authorize the current privacy notice', async () => {
  const h = harness();
  h.storage.privacy_agreed = true;
  assert.equal(h.privacy.hasPrivacyConsent(), false);
  h.wx.requirePrivacyAuthorize = o => o.fail({});
  await assert.rejects(h.privacy.acceptPrivacyConsent(), /未完成隐私授权/);
  assert.equal(h.storage.privacy_agreed_version, undefined);
  h.wx.requirePrivacyAuthorize = o => o.success();
  await h.privacy.acceptPrivacyConsent();
  assert.equal(h.privacy.hasPrivacyConsent(), true);
});

test('local acknowledgement never substitutes for WeChat reauthorization', async () => {
  const h = harness();
  await h.privacy.acceptPrivacyConsent();
  h.wx.requirePrivacyAuthorize = o => o.fail({});
  await h.privacy.runPrivacyAction(() => h.calls.push('private-action'));
  assert.deepEqual(h.calls, []);
});

test('missing privacy API fails closed in production but supports explicit local development', async () => {
  const h = harness();
  delete h.wx.requirePrivacyAuthorize;
  await assert.rejects(h.privacy.requirePrivacyAuthorization(), /更新微信/);
  h.app.globalData.isLocalDevelopment = true;
  await h.privacy.requirePrivacyAuthorization();
  h.wx.requirePrivacyAuthorize = o => o.fail({});
  await assert.rejects(h.privacy.requirePrivacyAuthorization(), /未完成隐私授权/);
});

for (const [file, method, args] of [
  ['pages/contract-preview/contract-preview.js', 'chooseLogisticsImage', []],
  ['pages/contract-preview/contract-preview.js', 'chooseAttachmentImage', ['INVOICE']],
  ['pages/contract-preview/contract-preview.js', 'chooseAttachmentFile', ['OTHER']],
  ['pages/document-template/document-template.js', 'chooseTemplateFile', ['SALES_ORDER']],
  ['pages/membership/membership.js', 'copyCompanyId', []]
]) {
  test(`privacy refusal blocks ${method} and a later consent permits it`, async () => {
    const h = harness();
    const p = h.page(file);
    p.data.status = { companyId: 'A' };
    h.wx.requirePrivacyAuthorize = o => o.fail({});
    await p[method](...args);
    assert.deepEqual(h.calls, []);
    assert.equal(h.toasts.length, 1);
    h.wx.requirePrivacyAuthorize = o => o.success();
    await p[method](...args);
    assert.equal(h.calls.length, 1);
  });
}

test('refusing a notice releases the public homepage without recording consent', () => {
  const h = harness();
  const p = h.page('pages/index/index.js');
  p.data.showPrivacy = true;
  // tabBar helpers access the app through the native module's global scope.
  const previousApp = global.getApp, previousWx = global.wx;
  global.getApp = () => h.app; global.wx = h.wx;
  try { p.doPrivacyDeny(); }
  finally { global.getApp = previousApp; global.wx = previousWx; }
  assert.equal(p.data.showPrivacy, false);
  assert.equal(h.app.globalData.tabBarHidden, false);
  assert.equal(h.storage.privacy_agreed, undefined);
});

test('refusing service disclosure prevents the Fadada authorization request', async () => {
  const h = harness();
  const p = h.page('pages/fadada-auth/fadada-auth.js');
  h.wx.showModal = o => o.success({ confirm: false });
  await p.loadServiceUrl();
  assert.deepEqual(h.calls, []);
  assert.equal(p.data.serviceUrl, '');
  assert.match(p.data.errorMessage, /已取消法大大服务/);
});

test('changing enterprise while disclosure is pending cannot transmit another enterprise data', async () => {
  const h = harness();
  const p = h.page('pages/fadada-auth/fadada-auth.js');
  let confirm;
  h.wx.showModal = o => { confirm = o.success; };
  const pending = p.loadServiceUrl();
  await new Promise(resolve => setImmediate(resolve));
  h.app.globalData.currentCompanyId = 'B';
  confirm({ confirm: true });
  await pending;
  assert.deepEqual(h.calls, []);
});

test('refusing platform authorization prevents any provider disclosure or request', async () => {
  const h = harness();
  const p = h.page('pages/fadada-auth/fadada-auth.js');
  h.wx.requirePrivacyAuthorize = o => o.fail({});
  h.wx.showModal = () => assert.fail('provider prompt must follow platform authorization');
  await p.loadServiceUrl();
  assert.deepEqual(h.calls, []);
});

test('refusing album authorization cannot save an already downloaded image', async () => {
  const h = harness();
  const p = h.page('pages/contract-preview/contract-preview.js');
  h.wx.requirePrivacyAuthorize = o => o.fail({});
  await p.downloadAttachmentFile({ id: '1', originalName: '凭证.jpg', isImage: true }, true);
  assert.deepEqual(h.calls, []);
});
