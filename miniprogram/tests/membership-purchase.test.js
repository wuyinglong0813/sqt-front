'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const contexts = require('../utils/companyContext');
const presentation = require('../utils/membership');
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function harness(handler, { confirm = true, nativeSuccess = true, onNative } = {}) {
  const app = { globalData: { token: 'token', currentCompanyId: 'A' } }, calls = [], toast = [], navigation = [];
  const wx = {
    getDeviceInfo: () => ({ platform: 'android' }),
    showModal: o => o.success({ confirm }),
    showToast: o => toast.push(o.title),
    requestPayment(o) { if (onNative) onNative(app); nativeSuccess ? o.success() : o.fail({ errMsg: 'requestPayment:fail cancel' }); },
    navigateTo: o => navigation.push(o.url), redirectTo: o => navigation.push(o.url)
  };
  function page(name) {
    let definition;
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'pages', name, name + '.js'), 'utf8'), {
      wx, getApp: () => app, Page: v => { definition = v; },
      setTimeout: fn => { Promise.resolve().then(fn); return 1; }, clearTimeout() {},
      require(name) {
        if (name.endsWith('/request')) return { request: async o => { calls.push(o); return handler(o); } };
        if (name.endsWith('/companyContext')) return contexts;
        if (name.endsWith('/membership')) return { ...presentation, paymentPlatform: () => presentation.paymentPlatform(wx) };
        throw new Error(name);
      }
    });
    definition.setData = values => Object.assign(definition.data, values);
    return definition;
  }
  return { app, wx, calls, toast, navigation, page };
}
const order = (status = 'PENDING') => ({ orderNo: 'MP' + 'a'.repeat(30), companyId: 'A', companyName: '企业A',
  productName: '企业VIP', productType: 'VIP', amountFen: 69900, vipDays: 365, signQuota: 100,
  quotaDays: 365, status, statusText: status, canPay: status === 'PENDING', canClose: status === 'PENDING' });
const paymentParams = { timeStamp: '1', nonceStr: 'nonce', package: 'prepay_id=test', signType: 'RSA', paySign: 'signed' };
function orderPage(env) {
  const page = env.page('membership-order'); page._orderNo = order().orderNo;
  page.data.loading = false; page.data.order = presentation.presentOrder(order()); return page;
}
test('client platform and price presentation are exact and unsupported platforms are closed', () => {
  assert.equal(presentation.paymentPlatform({ getDeviceInfo: () => ({ platform: 'ios' }) }), 'ios');
  assert.equal(presentation.paymentPlatform({ getDeviceInfo: () => ({ platform: 'other' }) }), 'unknown');
  assert.equal(presentation.presentProduct({ amountFen: 69900 }).priceText, '699.00');
  const value = { purchaseEnabled: true, purchasePlatforms: ['android'] };
  assert.equal(presentation.presentMembership(value, 'android').canPurchaseHere, true);
  assert.equal(presentation.presentMembership(value, 'ios').canPurchaseHere, false);
});
test('disabled catalogue cannot create orders', async () => {
  const env = harness(async () => { throw new Error('should not request'); }), page = env.page('membership-purchase');
  page.data.catalog = { companyId: 'A', purchaseEnabled: false };
  page.data.products = [{ id: 'vip', canBuy: true }];
  await page.buy({ currentTarget: { dataset: { id: 'vip' } } });
  assert.equal(env.calls.length, 0);
});
test('failed create retries reuse idempotency key and never send an amount or openid', async () => {
  let attempts = 0;
  const env = harness(async () => { if (++attempts === 1) throw new Error('timeout'); return order(); });
  const page = env.page('membership-purchase');
  page.data.catalog = { companyId: 'A', purchaseEnabled: true }; page.data.products = [{ id: 'vip', canBuy: true }];
  const event = { currentTarget: { dataset: { id: 'vip' } } };
  await page.buy(event); await page.buy(event);
  assert.equal(env.calls[0].data.idempotencyKey, env.calls[1].data.idempotencyKey);
  assert.equal(env.calls[0].data.amountFen, undefined); assert.equal(env.calls[0].data.openid, undefined);
  assert.equal(env.navigation.length, 1);
});
test('cancelled confirmation never starts native payment', async () => {
  const env = harness(async () => { throw new Error('unexpected request'); }, { confirm: false });
  await orderPage(env).pay();
  assert.equal(env.calls.length, 0);
});
test('native success alone cannot mark order paid', async () => {
  const env = harness(async o => o.url.includes('/prepay') ? { order: order(), paymentParams } : order());
  const page = orderPage(env); await page.pay();
  assert.equal(page.data.order.status, 'PENDING');
  assert.equal(env.calls.filter(o => o.url.includes('/sync')).length, 4);
  assert.match(env.toast.at(-1), /待确认/);
});
test('server confirmed payment wins over a cancelled native callback', async () => {
  const env = harness(async o => o.url.includes('/prepay') ? { order: order(), paymentParams } : order('PAID'), { nativeSuccess: false });
  const page = orderPage(env); await page.pay();
  assert.equal(page.data.order.status, 'PAID'); assert.match(env.toast.at(-1), /已到账/);
});
test('late unpaid read cannot overwrite confirmed paid state', async () => {
  const slow = deferred();
  const env = harness(o => o.method === 'POST' ? Promise.resolve(order('PAID')) : slow.promise);
  const page = orderPage(env), pending = page.loadOrder();
  await page.syncOrder();
  slow.resolve(order()); await pending;
  assert.equal(page.data.order.status, 'PAID');
});
test('enterprise switch during native payment prevents querying another company', async () => {
  const env = harness(async () => ({ order: order(), paymentParams }), {
    onNative: app => { app.globalData.currentCompanyId = 'B'; app._companyAccessGeneration = 1; }
  });
  await orderPage(env).pay();
  assert.equal(env.calls.length, 1); assert.equal(env.calls[0].companyId, 'A');
  assert.equal(env.toast.length, 0);
});
