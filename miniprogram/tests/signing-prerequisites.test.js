'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const continuation = require('../utils/signingContinuation');

function harness(handler) {
  const requests = [], navigation = [], timers = new Map();
  let now = 100000, timerId = 0, stack = [];
  const app = { globalData: { token: 'session', currentCompanyId: '3', userInfo: { id: '7', phone: '13800000000' },
    memberInfo: { permissions: ['all'] } }, getCurrentCompanyId: () => app.globalData.currentCompanyId,
    ensureSessionReady: async () => {} };
  const wx = { setNavigationBarTitle() {}, showToast() {},
    showModal: o => o.success({ confirm: true }),
    navigateTo: o => { navigation.push(o.url); if (o.success) o.success(); },
    redirectTo: o => { navigation.push(o.url); if (o.success) o.success(); },
    switchTab: o => navigation.push(o.url), navigateBack: () => navigation.push('back') };
  function page(name) {
    let value;
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', `pages/${name}/${name}.js`), 'utf8'), {
      Page: p => { value = p; }, wx, getApp: () => app, getCurrentPages: () => stack,
      Date: { now: () => now },
      setTimeout: callback => { timers.set(++timerId, callback); return timerId; }, clearTimeout: id => timers.delete(id),
      require: id => {
        if (id.endsWith('/request')) return { request: async o => { requests.push(o); return handler(o); } };
        if (id.endsWith('/companyContext')) return require('../utils/companyContext');
        if (id.endsWith('/signingContinuation')) return continuation;
        if (id.endsWith('/privacy')) return { requirePrivacyAuthorization: async () => {} };
        if (id.endsWith('/companyOnboarding')) return { returnToCompany() {} };
        if (id.endsWith('/tabBar')) return { syncTabBar() {} };
        if (id.endsWith('/dict')) return {};
        throw Error(id);
      }
    });
    value.setData = (values, callback) => { Object.assign(value.data, values); if (callback) callback(); };
    value.route = `pages/${name}/${name}`; value._visible = true; value._sessionToken = app.globalData.token;
    return value;
  }
  return { page, app, wx, requests, navigation, timers, advance: ms => { now += ms; }, stack: values => { stack = values; } };
}

for (const scene of ['contract', 'abolish', 'member']) {
  test(`${scene} completes the employee's personal prerequisite and resumes the exact original operation`, async () => {
    let verified = false;
    const h = harness(async o => {
      if (o.url === '/me') return { user: { id: '7', phone: '13800000000' } };
      if (o.url === '/fadada/users/me/identity') return { providerEnabled: true, status: verified ? 'VERIFIED' : 'NOT_STARTED' };
      throw Error('Unexpected side effect: ' + o.url);
    });
    const p = h.page('fadada-auth'); p.data.scene = scene;
    p.data.options = scene === 'member' ? { companyId: '3' } : { contractId: '9007199254740993', reason: '双方协商' };
    await p.prepareService();
    assert.equal(p.data.needsPersonalIdentity, true);
    assert.deepEqual(h.requests.map(o => o.url), ['/fadada/users/me/identity']);
    p.continuePersonalIdentity();
    const id = new URL('https://app.test' + h.navigation[0]).searchParams.get('continuationId');
    const personal = h.page('personal-cert'); personal.onLoad({ continuationId: id });
    await new Promise(resolve => setImmediate(resolve));
    personal.startAuth();
    assert.equal(h.navigation.at(-1), '/pages/fadada-auth/fadada-auth?scene=personal&continuationId=' + id);
    verified = true;
    const expected = continuation.signingContinuationUrl(h.app, id);
    h.stack([personal, { route: 'pages/service-return/service-return' }]);
    const result = h.page('service-return'); result.onLoad({ scene: 'personal' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.navigation.at(-1), expected);
    assert.equal(h.app._signingIdentityContinuation, undefined);
    assert.match(expected, scene === 'member' ? /scene=member&companyId=3/ : /contractId=9007199254740993/);
  });
}

test('a changed session or company cannot resume an older personal-certification operation', () => {
  for (const mutation of [app => { app.globalData.token = 'other-user'; }, app => { app.globalData.currentCompanyId = '4'; }]) {
    const h = harness(async () => ({ status: 'VERIFIED' }));
    const id = continuation.createSigningContinuation(h.app, 'contract', { contractId: '12', returnUrl: 'https://evil.test' });
    mutation(h.app);
    const result = h.page('service-return'); result.data.loading = false;
    result.data.options = { scene: 'personal', continuationId: id };
    result.goBusinessPage();
    assert.equal(h.navigation.length, 0);
    assert.equal(result.data.failed, true);
  }
});

test('an incomplete or cancelled personal result retains the original business continuation for retry', () => {
  const h = harness(async () => ({ status: 'IN_PROGRESS' }));
  const id = continuation.createSigningContinuation(h.app, 'contract', { contractId: '12' });
  const result = h.page('service-return');
  Object.assign(result.data, { loading: false, failed: true, options: { scene: 'personal', continuationId: id } });
  result.goBusinessPage();
  assert.equal(h.navigation[0], '/pages/personal-cert/personal-cert?continuationId=' + id);
  assert.ok(continuation.signingContinuation(h.app, id));
});

test('revoked personal authorization is refreshed before any quota or signing operation', async () => {
  const h = harness(async o => o.url.endsWith('/sync')
    ? { providerEnabled: true, status: 'IN_PROGRESS' } : { providerEnabled: true, status: 'VERIFIED' });
  const p = h.page('fadada-auth'); p.data.scene = 'contract'; p.data.options = { contractId: '12' };
  await p.prepareService();
  assert.equal(p.data.needsPersonalIdentity, true);
  assert.deepEqual(h.requests.map(o => o.url), ['/fadada/users/me/identity', '/fadada/users/me/identity/sync']);
});

test('a manager authorizing an unverified target is never sent to certify in place of that target', async () => {
  const h = harness(async () => { throw Error('目标成员尚未完成个人实名认证，请本人完成后重试'); });
  const p = h.page('fadada-auth'); p.data.scene = 'sealGrant'; p.data.options = { companyId: '3', userId: '9' };
  await p.prepareService();
  assert.equal(p.data.needsPersonalIdentity, false);
  assert.equal(h.app._signingIdentityContinuation, undefined);
  assert.deepEqual(h.requests.map(o => o.url), ['/fadada/companies/3/members/9/seal-grant-url']);
  assert.match(p.data.errorMessage, /目标成员.*请本人/);
});

test('a failed refresh of an existing VERIFIED identity keeps a self-service recovery action', async () => {
  const h = harness(async o => {
    if (o.url.endsWith('/sync')) throw Error('认证查询暂时失败，请稍后重试');
    return { status: 'VERIFIED', providerEnabled: true };
  });
  const p = h.page('fadada-auth'); p.data.scene = 'contract'; p.data.options = { contractId: '12' };
  await p.prepareService();
  assert.equal(p.data.canRecoverPersonalIdentity, true);
  assert.equal(p.data.needsPersonalIdentity, false);
  assert.match(p.data.errorMessage, /查询暂时失败/);
  p.continuePersonalIdentity();
  assert.match(h.navigation[0], /personal-cert.*continuationId=/);
  assert.equal(h.requests.filter(o => o.url.endsWith('/quote')).length, 0);
});

for (const scene of ['member', 'sealGrant']) {
  test(`${scene} obtains a new provider URL after its short ticket expires`, async () => {
    let tickets = 0;
    const h = harness(async o => o.url === '/fadada/users/me/identity' ? { status: 'VERIFIED' }
      : { url: `https://provider.test/${scene}?ticket=${++tickets}`, status: 'REQUIRED' });
    const p = h.page('fadada-auth'); p.data.scene = scene; p.data.options = { companyId: '3', userId: '9' };
    await p.loadServiceUrl();
    h.advance(10 * 60 * 1000 + 1); p.onWebViewError({ currentTarget: { dataset: { generation: p.data.webViewGeneration } } });
    await p.retry();
    assert.equal(tickets, 2);
    assert.equal(p.data.serviceUrl, `https://provider.test/${scene}?ticket=2`);
  });
}

test('an unused valid signing ticket is retained while a consumed ticket is fetched anew', async () => {
  let tickets = 0;
  const h = harness(async o => o.url === '/fadada/users/me/identity' ? { status: 'VERIFIED' }
    : o.url.endsWith('/quote') ? { canSign: true, newTask: false }
      : { url: 'https://provider.test/sign?ticket=' + (++tickets) });
  const p = h.page('fadada-auth'); p.data.scene = 'contract'; p.data.options = { contractId: '12' };
  await p.prepareService();
  p.onWebViewError({ currentTarget: { dataset: { generation: p.data.webViewGeneration } } });
  await p.retry(); assert.equal(tickets, 1);
  p.onWebViewLoad({ currentTarget: { dataset: { generation: p.data.webViewGeneration } } });
  p.onWebViewError({ currentTarget: { dataset: { generation: p.data.webViewGeneration } } });
  await p.retry(); assert.equal(tickets, 2);
});

test('a valid face-return continuation is preserved instead of creating another signing URL', async () => {
  let tickets = 0;
  const h = harness(async o => o.url === '/fadada/users/me/identity' ? { status: 'VERIFIED' }
    : o.url.endsWith('/quote') ? { canSign: true, newTask: false }
      : { url: 'https://provider.test/sign?ticket=' + (++tickets) });
  const p = h.page('fadada-auth'); p.data.scene = 'contract'; p.data.options = { contractId: '12' };
  await p.prepareService();
  h.advance(15 * 60 * 1000);
  assert.equal(p.reloadPage('https://provider.test/face-continuation'), true);
  await p.retry(); assert.equal(tickets, 1);
  p.onShow();
  const face = h.page('fadada-auth'); face.onLoad({ faceReturnId: h.app._fadadaFaceReturn.id });
  h.advance(60 * 1000);
  face.onWebViewLoad({ currentTarget: { dataset: { generation: face.data.webViewGeneration } } });
  face.onWebViewError({ currentTarget: { dataset: { generation: face.data.webViewGeneration } } });
  await face.retry();
  assert.equal(tickets, 1);
  assert.equal(face.data.serviceUrl, 'https://provider.test/face-continuation');
});

test('a provider-expiry page can be left for a visible native recovery action without an error event', async () => {
  const h = harness(async () => ({ url: 'https://provider.test/grant', status: 'AUTHORIZATION_REQUIRED' }));
  const grant = h.page('fadada-auth'); grant.data.scene = 'sealGrant'; grant.data.options = { companyId: '3', userId: '9' };
  await grant.loadServiceUrl();
  grant.onWebViewLoad({ currentTarget: { dataset: { generation: grant.data.webViewGeneration } } });
  h.advance(11 * 60 * 1000); grant.onUnload();
  const members = h.page('auth-manage'); members.onLoad({});
  members.shareInvite = async () => {}; members.loadMembers = async () => {}; members.loadRoles = async () => {};
  await members.onShow();
  assert.equal(members.data.serviceRecoveryAvailable, true);
  assert.equal(h.navigation.length, 0);
  members.renewServiceLink();
  assert.equal(h.navigation[0], '/pages/fadada-auth/fadada-auth?scene=sealGrant&companyId=3&userId=9');
  assert.equal(h.requests.length, 1);
});

test('member activation recovery is exposed on its native company page and never automatically reopened', async () => {
  const h = harness(async () => ({ url: 'https://provider.test/activate', status: 'ACTIVATION_REQUIRED' }));
  const activation = h.page('fadada-auth'); activation.data.scene = 'member'; activation.data.options = { companyId: '3' };
  await activation.loadServiceUrl(); activation.onUnload();
  const company = h.page('company'); company.loadData = async () => {};
  company.onShow();
  assert.equal(company.data.serviceRecoveryAvailable, true);
  assert.equal(h.navigation.length, 0);
  company.renewServiceLink();
  assert.equal(h.navigation[0], '/pages/fadada-auth/fadada-auth?scene=member&companyId=3');
  h.app.globalData.currentCompanyId = '4';
  company.renewServiceLink(); assert.equal(h.navigation.length, 1);
});

test('contract authorization carries the original contract and exact target user through the manager selector', async () => {
  const h = harness(async () => ({ status: 'READY' }));
  const members = h.page('auth-manage'); members.onLoad({ contractId: '9007199254740993' });
  members.data.authorizations = [{ id: '100', userId: '9', companyId: '3', status: 'ACTIVE' }];
  members.grantSigning({ currentTarget: { dataset: { userId: '9' } } });
  const query = Object.fromEntries(new URL('https://app.test' + h.navigation.at(-1)).searchParams);
  const grant = h.page('fadada-auth'); grant.data.scene = query.scene; grant.data.options = query;
  await grant.prepareService();
  assert.equal(h.requests[0].url, '/contracts/9007199254740993/members/9/seal-grant-url');
  assert.equal(h.requests[0].withCompany, true);
  assert.equal(h.requests[0].companyId, '3');
  assert.equal(h.requests[0].data.sealId, undefined);
  assert.equal(grant.data.serviceResultReady, true);
  assert.match(grant.data.serviceResultMessage, /这份合同所用印章.*返回原合同/);
  members.returnToContract();
  assert.equal(h.navigation.at(-1), '/pages/contract-preview/contract-preview?contractId=9007199254740993');
  h.app.globalData.currentCompanyId = '4';
  const count = h.navigation.length; members.openSealGrant('4', '9');
  assert.equal(h.navigation.length, count);
});
