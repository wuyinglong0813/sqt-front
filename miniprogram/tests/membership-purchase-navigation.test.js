'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const contexts = require('../utils/companyContext');

function harness() {
  let page;
  const requests = [], navigation = [], toasts = [];
  const app = { globalData: { token: 'session-A', currentCompanyId: 'A' } };
  const state = { navigate: options => options.fail({ errMsg: 'navigateTo:fail page limit' }) };
  state.request = async options => {
    if (options.method === 'POST') return { orderNo: `ORDER-${requests.filter(item => item.method === 'POST').length}`,
      companyId: options.companyId };
    return { companyId: app.globalData.currentCompanyId, purchaseEnabled: true,
      products: [{ id: 'vip', canBuy: true }, { id: 'quota', canBuy: true }] };
  };
  const wx = { navigateTo: options => { navigation.push(options); state.navigate(options); },
    showToast: options => toasts.push(options.title) };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../pages/membership-purchase/membership-purchase.js'), 'utf8'), {
    Page: definition => { page = definition; }, wx, getApp: () => app,
    require: id => {
      if (id.endsWith('/request')) return { request: options => { requests.push(options); return state.request(options); } };
      if (id.endsWith('/companyContext')) return contexts;
      if (id.endsWith('/membership')) return { paymentPlatform: () => 'android', presentProduct: product => product };
      throw new Error(`Unexpected require ${id}`);
    }
  });
  page.setData = patch => Object.assign(page.data, patch);
  page.onLoad({ continuationId: 'trusted-signing-ticket' });
  page.data.catalog = { companyId: 'A', purchaseEnabled: true };
  page.data.products = [{ id: 'vip', canBuy: true }, { id: 'quota', canBuy: true }];
  return { page, app, state, requests, navigation, toasts,
    buy: (productId = 'vip') => page.buy({ currentTarget: { dataset: { id: productId } } }) };
}

test('navigation failure retains the created order and retries that exact order with its signing continuation', async () => {
  const h = harness();
  await h.buy();
  assert.equal(h.requests.length, 1);
  assert.match(h.toasts[0], /订单已创建.*再次点击重试/);
  assert.equal(h.page.data.creating, false);
  const originalUrl = h.navigation[0].url;
  assert.match(originalUrl, /orderNo=ORDER-1&continuationId=trusted-signing-ticket$/);
  h.state.navigate = options => options.success();
  await h.buy();
  assert.equal(h.requests.length, 1);
  assert.equal(h.navigation[1].url, originalUrl);
  assert.equal(h.page._createdOrders.length, 0);
});

test('successful navigation clears recovery so a later deliberate purchase can create a fresh order', async () => {
  const h = harness();
  h.state.navigate = options => options.success();
  await h.buy();
  await h.buy();
  assert.equal(h.requests.length, 2);
  assert.notEqual(h.navigation[0].url, h.navigation[1].url);
  assert.equal(h.toasts.length, 0);
});

test('failed navigation for different products preserves each already-created order', async () => {
  const h = harness();
  await h.buy('vip');
  await h.buy('quota');
  await h.buy('vip');
  await h.buy('quota');
  assert.equal(h.requests.length, 2);
  assert.equal(h.navigation[0].url, h.navigation[2].url);
  assert.equal(h.navigation[1].url, h.navigation[3].url);
});

test('repeated clicks while navigation is pending do not create or open duplicate orders', async () => {
  const h = harness();
  let fail;
  h.state.navigate = options => { fail = options.fail; };
  await h.buy();
  await h.buy();
  assert.equal(h.requests.length, 1);
  assert.equal(h.navigation.length, 1);
  fail();
  h.state.navigate = options => options.success();
  await h.buy();
  assert.equal(h.requests.length, 1);
  assert.equal(h.navigation.length, 2);
});

for (const changed of ['account', 'company', 'company-returned']) {
  test(`navigation recovery cannot open the old order after ${changed} changes`, async () => {
    const h = harness();
    await h.buy();
    const originalUrl = h.navigation[0].url;
    if (changed === 'account') h.app.globalData.token = 'session-B';
    if (changed === 'company') h.app.globalData.currentCompanyId = 'B';
    if (changed === 'company-returned') h.app._companyAccessGeneration = 1;
    await h.page.loadCatalog();
    assert.equal(h.page._createdOrders.length, 0);
    await h.buy();
    assert.equal(h.requests.filter(item => item.method === 'POST').length, 2);
    assert.notEqual(h.navigation[1].url, originalUrl);
    assert.equal(h.requests.at(-1).companyId, h.app.globalData.currentCompanyId);
    assert.equal(h.requests.at(-1).token, h.app.globalData.token);
  });
}

test('logout removes navigation recovery and cannot open or create an order from the old catalogue', async () => {
  const h = harness();
  await h.buy();
  h.app.globalData.token = '';
  await h.buy();
  assert.equal(h.navigation.length, 1);
  assert.equal(h.requests.length, 1);
  assert.equal(h.page._createdOrders.length, 0);
  assert.match(h.page.data.errorMessage, /请先登录/);
});

test('late navigation failure after account switch or unload does not notify the new screen', async () => {
  for (const changed of ['account', 'unload']) {
    const h = harness();
    let fail;
    h.state.navigate = options => { fail = options.fail; };
    await h.buy();
    if (changed === 'account') h.app.globalData.token = 'session-B';
    else h.page.onUnload();
    fail();
    assert.equal(h.toasts.length, 0);
    assert.equal(h.page._openingOrder, null);
  }
});

test('a failed create reuses its key only within the same account and company context', async () => {
  const h = harness();
  h.state.request = async () => { throw new Error('timeout'); };
  await h.buy();
  await h.buy();
  assert.equal(h.requests[0].data.idempotencyKey, h.requests[1].data.idempotencyKey);
  h.app.globalData.token = 'session-B';
  await h.buy();
  assert.notEqual(h.requests[2].data.idempotencyKey, h.requests[0].data.idempotencyKey);
  assert.equal(h.navigation.length, 0);
});

test('ordinary purchases recover their order without attaching a signing continuation', async () => {
  const h = harness();
  h.page.onLoad({});
  await h.buy();
  await h.buy();
  assert.equal(h.requests.length, 1);
  assert.equal(h.navigation[0].url, h.navigation[1].url);
  assert.doesNotMatch(h.navigation[0].url, /continuationId/);
  assert.equal(h.requests[0].data.platform, 'android');
  assert.equal(h.requests[0].data.amountFen, undefined);
});
