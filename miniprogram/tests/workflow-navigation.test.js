'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const contextHelpers = require('../utils/companyContext');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness(request) {
  let app;
  const storage = {};
  const redirects = [];
  const timers = new Map();
  let timerId = 0;
  const wx = {
    getSystemInfoSync: () => ({ platform: 'devtools' }),
    getStorageSync: key => storage[key] || '',
    setStorageSync: (key, value) => { storage[key] = value; },
    removeStorageSync: key => { delete storage[key]; },
    redirectTo: options => redirects.push(options.url),
    setNavigationBarTitle() {}
  };
  const runtime = {
    wx, getApp: () => app,
    setTimeout: callback => { timers.set(++timerId, callback); return timerId; },
    clearTimeout: id => timers.delete(id),
    require: id => {
      if (id.endsWith('/request')) return { request };
      if (id.endsWith('/wechatLogin')) return { wechatLogin: () => { throw new Error('Unexpected login'); } };
      if (id.endsWith('/companyContext')) return contextHelpers;
      if (id.endsWith('/homeSnapshot')) return { USER_ID_KEY: 'user-id', clearCompanyHomeSnapshots() {} };
      if (id.endsWith('/companyOnboarding')) return { readDraft: () => null, loadSummary: async () => ({}) };
      if (id.endsWith('/dict')) return { certification: () => ({}) };
      if (id.endsWith('/tabBar')) return {};
      throw new Error(`Unstubbed module: ${id}`);
    }
  };
  const source = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  vm.runInNewContext(source('app.js'), { ...runtime, App: value => { app = value; } });
  app.globalData.token = 'user-session';
  app.setCurrentCompany('A');
  function page(file) {
    let value;
    vm.runInNewContext(source(file), { ...runtime, Page: definition => { value = definition; } });
    value.setData = update => Object.assign(value.data, update);
    return value;
  }
  return { app, storage, redirects, timers, page };
}

const payload = companyId => ({ user: { id: 'user', currentCompanyId: companyId },
  member: { roleCode: 'LEGAL', permissions: ['all'] }, companies: [{ companyId }] });

for (const [file, method] of [
  ['pages/company/company.js', 'loadData'], ['pages/me/me.js', 'loadMe']
]) {
  test(`${file} discards a /me response from before an enterprise switch`, async () => {
    const oldRead = deferred();
    const env = harness(options => options.url === '/me' ? oldRead.promise : Promise.resolve(payload(options.companyId)));
    const page = env.page(file);
    const pending = page[method]();
    await env.app.switchCompany('B');
    oldRead.resolve(payload('A'));
    await pending;
    assert.equal(env.app.getCurrentCompanyId(), 'B');
    assert.equal(env.storage.tradepass_company_id, 'B');
    assert.equal(page.data.currentCompanyId, '');
  });
}

test('A to B to A does not resurrect the first A response or its old permissions', async () => {
  const oldRead = deferred();
  const env = harness(options => options.url === '/me' ? oldRead.promise : Promise.resolve(payload(options.companyId)));
  const page = env.page('pages/company/company.js');
  const pending = page.loadData();
  await env.app.switchCompany('B');
  await env.app.switchCompany('A');
  oldRead.resolve({ ...payload('A'), member: { roleCode: 'REMOVED' } });
  await pending;
  assert.equal(env.app.globalData.memberInfo.roleCode, 'LEGAL');
});

test('two concurrent enterprise switches only apply the latest requested destination', async () => {
  const first = deferred(), second = deferred();
  const env = harness(options => options.companyId === 'B' ? first.promise : second.promise);
  const one = env.app.switchCompany('B');
  const two = env.app.switchCompany('C');
  second.resolve(payload('C'));
  await two;
  first.resolve(payload('B'));
  await assert.rejects(one, /企业切换状态已变化/);
  assert.equal(env.app.getCurrentCompanyId(), 'C');
});

test('an old forbidden /me response cannot invalidate a newer enterprise selection', async () => {
  const oldRead = deferred();
  const env = harness(options => options.url === '/me' ? oldRead.promise : Promise.resolve(payload('B')));
  const pending = env.app.loadMe();
  await env.app.switchCompany('B');
  oldRead.reject(Object.assign(new Error('forbidden'), { statusCode: 403 }));
  assert.equal(await pending, null);
  assert.equal(env.app.getCurrentCompanyId(), 'B');
});

test('seal management stays open even when an enabled seal already exists', async () => {
  let requests = 0;
  const env = harness(async () => { requests++; return { status: 'VERIFIED', enabledSealCount: 1 }; });
  const page = env.page('pages/fadada-auth/fadada-auth.js');
  page.data.scene = 'seal';
  page.startStatusPolling();
  await page.pollStatus();
  assert.equal(requests, 0);
  assert.equal(env.timers.size, 0);
  assert.equal(env.redirects.length, 0);
});

for (const exit of ['onHide', 'onUnload']) {
  test(`authentication in-flight response after ${exit} neither redirects nor schedules another poll`, async () => {
    const response = deferred();
    const env = harness(() => response.promise);
    const page = env.page('pages/fadada-auth/fadada-auth.js');
    page.data.scene = 'company'; page.data.options = { companyId: 'A' };
    const pending = page.pollStatus();
    page[exit]();
    response.resolve({ status: 'VERIFIED' });
    await pending;
    assert.equal(env.redirects.length, 0);
    assert.equal(env.timers.size, 0);
  });
}

test('leaving while auth URL loads prevents the detached page from starting polling', async () => {
  const response = deferred();
  const env = harness(() => response.promise);
  const page = env.page('pages/fadada-auth/fadada-auth.js');
  const pending = page.loadServiceUrl();
  page.onUnload();
  response.resolve({ url: 'https://example.test/auth' });
  await pending;
  assert.equal(page.data.serviceUrl, '');
  assert.equal(env.timers.size, 0);
});

test('returning to auth starts a fresh poll and ignores the earlier hidden request', async () => {
  const oldResponse = deferred();
  let calls = 0;
  const env = harness(() => ++calls === 1 ? oldResponse.promise : Promise.resolve({ status: 'VERIFIED' }));
  const page = env.page('pages/fadada-auth/fadada-auth.js');
  page.data.serviceUrl = 'https://example.test/auth';
  const pending = page.pollStatus();
  page.onHide(); page.onShow();
  const newPoll = [...env.timers.values()][0];
  oldResponse.resolve({ status: 'VERIFIED' });
  await pending;
  assert.equal(env.redirects.length, 0);
  env.timers.clear();
  await newPoll();
  assert.equal(env.redirects.length, 1);
});

test('legal identity polling requires its own verified-person endpoint', async () => {
  const urls = [];
  const env = harness(async options => { urls.push(options.url); return { status: 'IN_PROGRESS' }; });
  const page = env.page('pages/fadada-auth/fadada-auth.js');
  page.data.scene = 'legal'; page.data.options = { companyId: 'A' };
  await page.pollStatus();
  assert.deepEqual(urls, ['/fadada/companies/A/legal-representative/sync']);
  assert.equal(env.redirects.length, 0);
});
