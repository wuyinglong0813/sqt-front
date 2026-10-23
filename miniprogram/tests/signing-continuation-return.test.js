'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const continuation = require('../utils/signingContinuation');
const { captureCompanyContext } = require('../utils/companyContext');

function harness(handler = async () => ({ status: 'VERIFIED', organizationAuthorized: true })) {
  const requests = [], navigation = [], timers = new Map();
  let pages = [], timerId = 0;
  const app = { globalData: { token: 'session', currentCompanyId: '3' }, _companyAccessGeneration: 2,
    switchCompany: async id => { app.switchedCompany = id; app.globalData.currentCompanyId = String(id);
      app._companyAccessGeneration++; }, loadMe: async () => {} };
  const wx = {
    navigateBack: options => { navigation.push({ delta: options.delta }); if (options.success) options.success(); },
    redirectTo: options => { navigation.push({ url: options.url }); if (options.success) options.success(); },
    switchTab: options => { navigation.push({ url: options.url }); if (options.success) options.success(); }
  };
  let page;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../pages/service-return/service-return.js'), 'utf8'), {
    Page: value => { page = value; }, getApp: () => app, getCurrentPages: () => pages, wx,
    setTimeout: callback => { timers.set(++timerId, callback); return timerId; },
    clearTimeout: id => timers.delete(id),
    require: id => {
      if (id.endsWith('/request')) return { request: async options => { requests.push(options); return handler(options); } };
      if (id.endsWith('/companyContext')) return require('../utils/companyContext');
      if (id.endsWith('/signingContinuation')) return continuation;
      if (id.endsWith('/companyOnboarding')) return { returnToCompany: () => navigation.push({ url: 'company-create' }) };
      throw Error(id);
    }
  });
  page.route = 'pages/service-return/service-return';
  page.setData = update => Object.assign(page.data, update);
  function original(scene = 'contract', options = { contractId: '9007199254740993' }) {
    const id = continuation.createSigningContinuation(app, scene, options);
    const context = captureCompanyContext(app);
    return { id, context, route: 'pages/fadada-auth/fadada-auth', _sessionToken: app.globalData.token,
      _signingContext: context, _awaitingSigningPrerequisite: { id, context }, data: { scene, options } };
  }
  function companySource(id, overrides = {}) {
    return { route: 'pages/fadada-auth/fadada-auth', _sessionToken: app.globalData.token,
      _signingContext: captureCompanyContext(app), data: { scene: 'company',
        options: { companyId: '3', renewOrganization: '1', continuationId: id } }, ...overrides };
  }
  return { app, page, wx, requests, navigation, timers, original, companySource,
    stack: values => { pages = values; }, settled: () => new Promise(resolve => setImmediate(resolve)) };
}

for (const [scene, options] of [
  ['contract', { contractId: '9007199254740993' }],
  ['member', { companyId: '3' }],
  ['sealGrant', { companyId: '3', userId: '9007199254740995', contractId: '9007199254740993' }]
]) {
  test(`${scene} resumes the waiting original operation after company consent without changing enterprise`, async () => {
    const h = harness();
    const parent = h.original(scene, options), source = h.companySource(parent.id);
    h.stack([parent, source, h.page]);
    h.page.onLoad({ scene: 'company', companyId: '3', authResult: 'success' });
    await h.settled();
    assert.equal(h.page.data.options.continuationId, parent.id);
    assert.equal(h.page.data.options.renewOrganization, '1');
    assert.deepEqual(h.requests.map(o => [o.url, o.method, o.withCompany]),
      [['/fadada/companies/3/identity/sync', 'POST', false]]);
    assert.equal(h.app.switchedCompany, undefined);
    assert.equal(h.page.data.failed, false);
    assert.equal(h.navigation.length, 1);
    assert.equal(h.navigation[0].delta, 2);
    assert.equal(h.timers.size, 0);
    assert.ok(continuation.signingContinuation(h.app, parent.id));
    h.page.goBusinessPage();
    assert.equal(h.navigation.length, 1);
  });
}

test('nested member authentication retains the original contract operation', () => {
  const h = harness();
  const parent = h.original('contract', { contractId: '9007199254740993' });
  assert.equal(continuation.createSigningContinuation(h.app, 'member', {
    companyId: '3', continuationId: parent.id }), parent.id);
  const destination = continuation.resumeSigningContinuation(h.app, parent.id);
  const query = new URL('https://app.test' + destination.url).searchParams;
  assert.equal(destination.delta, 0);
  assert.equal(query.get('scene'), 'contract');
  assert.equal(query.get('contractId'), '9007199254740993');
  assert.equal(query.get('companyId'), null);
});

for (const result of [
  { status: 'VERIFIED' },
  { status: 'VERIFIED', organizationAuthorized: false },
  { status: 'IN_PROGRESS', organizationAuthorized: true }
]) {
  test(`company consent requires both confirmed identity and organization permission: ${JSON.stringify(result)}`, async () => {
    const h = harness(async () => result), parent = h.original();
    h.stack([parent, h.companySource(parent.id), h.page]);
    h.page.onLoad({ scene: 'company', companyId: '3' });
    await h.settled();
    assert.equal(h.page.data.failed, true);
    assert.equal(h.page.data.title, '企业授权尚未确认');
    assert.equal(h.navigation.length, 0);
    assert.equal(h.timers.size, 0);
    assert.ok(continuation.signingContinuation(h.app, parent.id));
    await h.page.retrySync();
    assert.deepEqual(h.requests.map(o => o.url), Array(2).fill('/fadada/companies/3/identity/sync'));
    assert.equal(h.app.switchedCompany, undefined);
    h.page.goBusinessPage();
    assert.equal(h.navigation[0].delta, 2);
    assert.ok(continuation.signingContinuation(h.app, parent.id));
  });
}

test('a failed real-time organization check never falls back to cached VERIFIED or opens another authorization page', async () => {
  const h = harness(async options => {
    if (options.method === 'POST') throw Error('查询暂时不可用');
    return { status: 'VERIFIED', organizationAuthorized: true };
  });
  const parent = h.original();
  h.stack([parent, h.companySource(parent.id), h.page]);
  h.page.onLoad({ scene: 'company', companyId: '3' });
  await h.settled();
  assert.equal(h.page.data.failed, true);
  assert.equal(h.page.data.message, '查询暂时不可用');
  assert.equal(h.requests.length, 1);
  assert.equal(h.navigation.length, 0);
  assert.ok(continuation.signingContinuation(h.app, parent.id));
});

test('company consent recreates the original operation if its waiting page no longer exists', async () => {
  const h = harness();
  const parent = h.original('contract', { contractId: '9007199254740993' });
  const expected = continuation.signingContinuationUrl(h.app, parent.id);
  h.stack([h.companySource(parent.id), h.page]);
  h.page.onLoad({ scene: 'company', companyId: '3' });
  await h.settled();
  assert.equal(h.navigation[0].url, expected);
  assert.equal(h.app._signingIdentityContinuation, undefined);
  assert.equal(h.app.switchedCompany, undefined);
});

for (const mismatch of ['company', 'session', 'generation']) {
  test(`fixed company callback does not recover a prerequisite from a different ${mismatch}`, () => {
    const h = harness(), parent = h.original(), source = h.companySource(parent.id);
    if (mismatch === 'company') source.data.options.companyId = '4';
    if (mismatch === 'session') source._sessionToken = 'old-session';
    if (mismatch === 'generation') source._signingContext.generation--;
    h.stack([parent, source, h.page]);
    h.page.syncResult = () => {};
    h.page.onLoad({ scene: 'company', companyId: '3' });
    assert.equal(h.page.data.options.renewOrganization, undefined);
    assert.equal(h.page.data.options.continuationId, undefined);
  });
}

for (const mutation of [
  app => { app.globalData.token = 'other-session'; },
  app => { app.globalData.currentCompanyId = '4'; },
  app => { app._companyAccessGeneration += 2; }
]) {
  test(`a stale continuation cannot be rebound through nested authentication: ${mutation.toString()}`, () => {
    const h = harness(), parent = h.original();
    mutation(h.app);
    assert.equal(continuation.resumeSigningContinuation(h.app, parent.id, [parent, h.page]), null);
    assert.equal(continuation.createSigningContinuation(h.app, 'member', {
      companyId: h.app.globalData.currentCompanyId, continuationId: parent.id }), '');
  });
}

test('a company switch during a real-time authorization check prevents old results and navigation', async () => {
  let complete;
  const h = harness(() => new Promise(resolve => { complete = resolve; })), parent = h.original();
  h.stack([parent, h.companySource(parent.id), h.page]);
  h.page.onLoad({ scene: 'company', companyId: '3' });
  h.app._companyAccessGeneration += 2;
  complete({ status: 'VERIFIED', organizationAuthorized: true });
  await h.settled();
  assert.equal(h.navigation.length, 0);
  assert.equal(h.app.switchedCompany, undefined);
  await h.page.retrySync();
  assert.equal(h.page.data.failed, true);
  assert.equal(h.page.data.title, '原办理会话已失效');
  assert.equal(h.requests.length, 1);
});

test('legacy personal continuation still restores the original operation through its fixed callback', async () => {
  const h = harness(), parent = h.original();
  h.stack([{ route: 'pages/personal-cert/personal-cert', _identityContinuationId: parent.id }, h.page]);
  const expected = continuation.signingContinuationUrl(h.app, parent.id);
  h.page.onLoad({ scene: 'personal' });
  await h.settled();
  assert.equal(h.navigation[0].url, expected);
  assert.equal(h.app._signingIdentityContinuation, undefined);
});

test('ordinary enterprise identity prerequisite restores its nonce from the fixed callback and resumes without switching', async () => {
  const h = harness(), parent = h.original(), source = h.companySource(parent.id);
  delete source.data.options.renewOrganization;
  h.stack([parent, source, h.page]);
  h.page.onLoad({ scene: 'company', companyId: '3' });
  await h.settled();
  assert.equal(h.page.data.options.continuationId, parent.id);
  assert.equal(h.page.data.options.renewOrganization, undefined);
  assert.equal(h.page.data.failed, false);
  assert.equal(h.navigation[0].delta, 2);
  assert.equal(h.app.switchedCompany, undefined);
  assert.equal(h.app._companyAccessGeneration, 2);
});

for (const currentCompanyId of ['', '4']) {
  test(`standalone enterprise permission completion can activate its target while current company is '${currentCompanyId}'`, async () => {
    const h = harness();
    h.app.globalData.currentCompanyId = currentCompanyId;
    h.stack([h.companySource(''), h.page]);
    h.page.onLoad({ scene: 'company', companyId: '3' });
    await h.settled();
    assert.equal(h.page.data.failed, false);
    assert.deepEqual(h.requests.map(o => [o.url, o.method]), [['/fadada/companies/3/identity/sync', 'POST']]);
    assert.equal(h.app.switchedCompany, '3');
    assert.equal(h.navigation[0].url, '/pages/company/company');
    assert.equal(h.page.resultContextCurrent(), true);
  });
}

test('a company prerequisite cannot use an original operation from another enterprise', async () => {
  const h = harness(), parent = h.original();
  h.stack([parent, h.page]);
  h.page.onLoad({ scene: 'company', companyId: '4', continuationId: parent.id });
  await h.settled();
  assert.equal(h.page.data.failed, true);
  assert.equal(h.requests.length, 0);
  assert.equal(h.navigation.length, 0);
  assert.equal(h.app.switchedCompany, undefined);
});

test('an expired source nonce does not turn a company prerequisite into standalone onboarding', async () => {
  const h = harness(), parent = h.original(), source = h.companySource(parent.id);
  continuation.clearSigningContinuation(h.app, parent.id);
  h.stack([parent, source, h.page]);
  h.page.onLoad({ scene: 'company', companyId: '3' });
  await h.settled();
  assert.equal(h.page.data.options.continuationId, parent.id);
  assert.equal(h.page.data.failed, true);
  assert.match(h.page.data.message, /会话已失效/);
  assert.equal(h.requests.length, 0);
  assert.equal(h.navigation.length, 0);
});

for (const currentCompanyId of ['', '4']) {
  test(`personal authentication resumes standalone company permission while current enterprise is '${currentCompanyId}'`, async () => {
    const h = harness();
    h.app.globalData.currentCompanyId = currentCompanyId;
    const parent = h.original('company', { companyId: '3', renewOrganization: '1' });
    assert.ok(parent.id);
    h.stack([parent, { route: 'pages/personal-cert/personal-cert', _identityContinuationId: parent.id }, h.page]);
    h.page.onLoad({ scene: 'personal' });
    await h.settled();
    assert.equal(h.navigation[0].delta, 2);
    assert.equal(h.app.switchedCompany, undefined);
    const target = new URL('https://app.test' + continuation.signingContinuationUrl(h.app, parent.id)).searchParams;
    assert.equal(target.get('scene'), 'company');
    assert.equal(target.get('companyId'), '3');
    assert.equal(target.get('renewOrganization'), '1');
    assert.equal(h.app.globalData.currentCompanyId, currentCompanyId);
  });
}

test('standalone company personal authentication can recreate the exact company target without an original page', async () => {
  const h = harness();
  h.app.globalData.currentCompanyId = '';
  const id = continuation.createSigningContinuation(h.app, 'company', { companyId: '9007199254740993', renewOrganization: '1' });
  h.stack([h.page]);
  h.page.onLoad({ scene: 'personal', continuationId: id });
  await h.settled();
  const target = new URL('https://app.test' + h.navigation[0].url).searchParams;
  assert.equal(target.get('scene'), 'company');
  assert.equal(target.get('companyId'), '9007199254740993');
  assert.equal(target.get('renewOrganization'), '1');
  assert.equal(h.app._signingIdentityContinuation, undefined);
});

test('standalone company continuation cannot match an enterprise page for a different authorization action', () => {
  const h = harness();
  h.app.globalData.currentCompanyId = '';
  const parent = h.original('company', { companyId: '3', renewOrganization: '1' });
  parent.data.options = { companyId: '3' };
  const target = continuation.resumeSigningContinuation(h.app, parent.id, [parent, h.page]);
  assert.equal(target.delta, 0);
  assert.match(target.url, /renewOrganization=1/);
});

for (const mutation of [
  app => { app.globalData.token = 'new-session'; },
  app => { app.globalData.currentCompanyId = '4'; },
  app => { app._companyAccessGeneration++; }
]) {
  test(`standalone company continuation still expires when its original context changes: ${mutation.toString()}`, () => {
    const h = harness();
    h.app.globalData.currentCompanyId = '';
    const parent = h.original('company', { companyId: '3', renewOrganization: '1' });
    mutation(h.app);
    assert.equal(continuation.resumeSigningContinuation(h.app, parent.id, [parent, h.page]), null);
    assert.equal(continuation.createSigningContinuation(h.app, 'company', {
      companyId: '3', renewOrganization: '1', continuationId: parent.id }), '');
  });
}

test('company continuation still requires login and other signing operations still require an active company', () => {
  const h = harness();
  h.app.globalData.currentCompanyId = '';
  for (const [scene, options] of [
    ['contract', { contractId: '12' }], ['abolish', { contractId: '12' }],
    ['member', { companyId: '3' }], ['sealGrant', { companyId: '3', userId: '7' }]
  ]) assert.equal(continuation.createSigningContinuation(h.app, scene, options), '');
  assert.equal(continuation.createSigningContinuation(h.app, 'company', {}), '');
  h.app.globalData.token = '';
  assert.equal(continuation.createSigningContinuation(h.app, 'company', { companyId: '3' }), '');
});
