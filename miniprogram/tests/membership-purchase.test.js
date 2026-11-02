'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const contexts = require('../utils/companyContext');
const presentation = require('../utils/membership');
const signing = require('../utils/signingContinuation');
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function harness(handler, { confirm = true, nativeSuccess = true, onNative } = {}) {
  let stack = [];
  const app = { globalData: { token: 'token', currentCompanyId: 'A' } }, calls = [], toast = [], navigation = [];
  const wx = {
    getDeviceInfo: () => ({ platform: 'android' }),
    showModal: o => o.success({ confirm }),
    showToast: o => toast.push(o.title),
    requestPayment(o) { if (onNative) onNative(app); nativeSuccess ? o.success() : o.fail({ errMsg: 'requestPayment:fail cancel' }); },
    navigateTo: o => navigation.push(o.url), redirectTo: o => { navigation.push(o.url); if (o.success) o.success(); },
    navigateBack: o => navigation.push('back:' + o.delta)
  };
  function page(name) {
    let definition;
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'pages', name, name + '.js'), 'utf8'), {
      wx, getApp: () => app, getCurrentPages: () => stack, Page: v => { definition = v; },
      setTimeout: fn => { Promise.resolve().then(fn); return 1; }, clearTimeout() {},
      require(name) {
        if (name.endsWith('/request')) return { request: async o => { calls.push(o); return handler(o); } };
        if (name.endsWith('/companyContext')) return contexts;
        if (name.endsWith('/membership')) return { ...presentation, paymentPlatform: () => presentation.paymentPlatform(wx) };
        if (name.endsWith('/signingContinuation')) return signing;
        throw new Error(name);
      }
    });
    definition.setData = values => Object.assign(definition.data, values);
    return definition;
  }
  return { app, wx, calls, toast, navigation, page, stack: pages => { stack = pages; } };
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

function attachSigningPurchase(env, page) {
  const id = signing.createSigningContinuation(env.app, 'contract', { contractId: '12' });
  const context = contexts.captureCompanyContext(env.app);
  const original = { route: 'pages/fadada-auth/fadada-auth', _sessionToken: 'token', _signingContext: context,
    _awaitingSigningPrerequisite: { id, context }, data: { scene: 'contract', options: { contractId: '12' } } };
  page.onLoad({ orderNo: order().orderNo, continuationId: id });
  env.stack([original, { route: 'pages/membership-purchase/membership-purchase' }, page]);
  return id;
}

test('a purchase from signing passes only its continuation to the order page', async () => {
  const env = harness(async () => order()), page = env.page('membership-purchase');
  page.onLoad({ continuationId: 'signing-ticket' });
  page.data.catalog = { companyId: 'A', purchaseEnabled: true };
  page.data.products = [{ id: 'vip', canBuy: true }];
  await page.buy({ currentTarget: { dataset: { id: 'vip' } } });
  assert.match(env.navigation[0], /&continuationId=signing-ticket$/);
  assert.equal(env.calls[0].data.continuationId, undefined);
});

test('server-confirmed payment automatically returns to the exact waiting contract once', async () => {
  const env = harness(async o => o.url.includes('/prepay') ? { order: order(), paymentParams } : order('PAID'));
  const page = orderPage(env);
  attachSigningPurchase(env, page);
  await page.pay();
  assert.equal(page.data.order.status, 'PAID');
  assert.deepEqual(env.navigation, ['back:2']);
  page.applyOrder(order('PAID'));
  assert.deepEqual(env.navigation, ['back:2']);
});

test('an unconfirmed or cancelled payment keeps its purchase and does not resume signing', async () => {
  for (const nativeSuccess of [true, false]) {
    const env = harness(async o => o.url.includes('/prepay') ? { order: order(), paymentParams } : order(), { nativeSuccess });
    const page = orderPage(env); attachSigningPurchase(env, page);
    await page.pay();
    assert.equal(page.data.order.status, 'PENDING');
    assert.equal(env.navigation.length, 0);
  }
});

test('a confirmed payment restored by an order read also returns to the waiting contract', async () => {
  const env = harness(async () => order('PAID')), page = orderPage(env);
  attachSigningPurchase(env, page);
  await page.loadOrder();
  assert.deepEqual(env.navigation, ['back:2']);
});

test('a valid paid signing purchase without its original page restores only the trusted contract route', () => {
  const env = harness(async () => order('PAID')), page = orderPage(env);
  attachSigningPurchase(env, page); env.stack([page]);
  page.applyOrder(order('PAID'));
  assert.deepEqual(env.navigation, ['/pages/fadada-auth/fadada-auth?scene=contract&contractId=12']);
  assert.equal(env.app._signingIdentityContinuation, undefined);
});

for (const changed of ['session', 'company', 'unload']) {
  test(`a delayed return failure cannot redirect the old contract after ${changed} changes`, () => {
    const env = harness(async () => order('PAID')), page = orderPage(env);
    attachSigningPurchase(env, page);
    let failedReturn;
    env.wx.navigateBack = options => { failedReturn = options.fail; };
    page.applyOrder(order('PAID'));
    if (changed === 'session') env.app.globalData.token = 'other';
    if (changed === 'company') env.app.globalData.currentCompanyId = 'B';
    if (changed === 'unload') page.onUnload();
    failedReturn();
    assert.equal(env.navigation.length, 0);
  });
}

for (const changed of ['session', 'company', 'company-returned', 'order-company', 'nonce', 'unload']) {
  test(`a paid order cannot resume a stale signing purchase after ${changed} changes`, () => {
    const env = harness(async () => order('PAID')), page = orderPage(env);
    attachSigningPurchase(env, page);
    const paid = order('PAID');
    if (changed === 'session') env.app.globalData.token = 'other';
    if (changed === 'company') env.app.globalData.currentCompanyId = 'B';
    if (changed === 'company-returned') env.app._companyAccessGeneration = 1;
    if (changed === 'order-company') paid.companyId = 'B';
    if (changed === 'nonce') page._signingContinuationId = 'other-ticket';
    if (changed === 'unload') page.onUnload();
    page.applyOrder(paid);
    assert.equal(env.navigation.length, 0);
  });
}
