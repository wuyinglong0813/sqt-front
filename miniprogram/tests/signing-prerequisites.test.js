'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const continuation = require('../utils/signingContinuation');

function harness(handler) {
  const requests = [], navigation = [], modals = [], timers = new Map();
  let now = 100000, timerId = 0, stack = [];
  const app = { globalData: { token: 'session', currentCompanyId: '3', userInfo: { id: '7', phone: '13800000000' },
    memberInfo: { permissions: ['all'] } }, getCurrentCompanyId: () => app.globalData.currentCompanyId,
    ensureSessionReady: async () => {} };
  const wx = { setNavigationBarTitle() {}, showToast() {},
    showModal: o => { modals.push(o); o.success({ confirm: true }); },
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
  return { page, app, wx, requests, navigation, modals, timers, advance: ms => { now += ms; }, stack: values => { stack = values; } };
}

function preparationHarness(code) {
  return harness(async o => {
    if (o.url === '/fadada/users/me/identity') return { status: 'VERIFIED' };
    if (o.url.endsWith('/prerequisites')) {
      if (code) throw Object.assign(new Error('需要完成签署准备'), { code });
      return { status: 'READY' };
    }
    if (o.url.endsWith('/quote')) return { canSign: true, newTask: false };
    if (o.url.endsWith('/sign-url')) return { url: 'https://provider.test/sign' };
    throw Error('Unexpected endpoint: ' + o.url);
  });
}

test('an existing enterprise missing organization consent gets one relevant action before any debit confirmation', async () => {
  const h = preparationHarness(46101);
  const p = h.page('fadada-auth'); p.data.scene = 'contract'; p.data.options = { contractId: '9007199254740993' };
  await p.prepareService();
  assert.equal(p.data.preparationAction, 'company');
  assert.equal(p.data.preparationCanProceed, true);
  assert.equal(p.data.preparationActionText, '授权后重新检查');
  assert.match(p.data.preparationMessage, /无需重新注册.*与个人实名分开.*超管办理一次.*同企业.*可复用/);
  assert.match(p.data.preparationMessage, /统一页面可能仍显示“开通电子签”.*商签通管理员与电子签企业超管是两个身份/);
  assert.equal(p.data.canRecoverPersonalIdentity, false);
  assert.equal(h.requests.some(o => /quote|sign-url/.test(o.url)), false);
  assert.equal(h.modals.some(o => o.title === '确认发起电子签'), false);
  await p.recheckSigningPreparation();
  assert.equal(h.navigation.length, 0);
  assert.equal(h.requests.some(o => o.url.endsWith('/auth-url')), false);
  p.continueSigningPreparation(); p.continueSigningPreparation();
  assert.equal(h.navigation.length, 1);
  const target = new URL('https://app.test' + h.navigation[0]).searchParams;
  assert.equal(target.get('scene'), 'company');
  assert.equal(target.get('companyId'), '3');
  assert.equal(target.get('renewOrganization'), '1');
  assert.equal(continuation.signingContinuation(h.app, target.get('continuationId')).target.contractId, '9007199254740993');
});

test('a colleague resumes the same contract after company consent without personally reopening company authorization', async () => {
  let authorized = false;
  const h = harness(async o => {
    if (o.url === '/fadada/users/me/identity') return { status: 'VERIFIED' };
    if (o.url.endsWith('/prerequisites')) {
      if (!authorized) throw Object.assign(new Error('等待企业超管授权'), { code: 46101 });
      return { status: 'READY' };
    }
    if (o.url.endsWith('/quote')) return { canSign: true, newTask: false };
    if (o.url.endsWith('/sign-url')) return { url: 'https://provider.test/employee-sign' };
    throw Error('Unexpected endpoint: ' + o.url);
  });
  h.app.globalData.memberInfo = { roleCode: 'ADMIN', permissions: ['company_manage', 'contract_sign'] };
  const p = h.page('fadada-auth'); p.data.scene = 'contract'; p.data.options = { contractId: '12' };
  await p.prepareService();
  assert.equal(p.data.preparationCanProceed, true);
  assert.equal(h.navigation.length, 0);
  authorized = true;
  await p.recheckSigningPreparation();
  assert.equal(p.data.serviceUrl, 'https://provider.test/employee-sign');
  assert.equal(p.data.options.contractId, '12');
  assert.equal(h.requests.some(o => o.url.endsWith('/auth-url')), false);
  assert.equal(h.navigation.length, 0);
});

test('ordinary members keep their contract and recheck after administrator authorization without opening management', async () => {
  const h = preparationHarness(46101); h.app.globalData.memberInfo.permissions = ['contract_sign'];
  const p = h.page('fadada-auth'); p.data.scene = 'contract'; p.data.options = { contractId: '12' };
  await p.prepareService();
  assert.equal(p.data.preparationCanProceed, false);
  await p.continueSigningPreparation();
  assert.equal(h.navigation.length, 0);
  assert.equal(h.requests.some(o => o.url.endsWith('/auth-url')), false);
  assert.equal(p.data.options.contractId, '12');
});

test('a parent rechecks and continues the same contract after returning from an enterprise prerequisite', async () => {
  const h = preparationHarness();
  const p = h.page('fadada-auth'); p.data.scene = 'contract'; p.data.options = { contractId: '12' };
  p.showServiceError({ code: 46101 }); p.continueSigningPreparation();
  p.onHide(); await p.onShow();
  assert.equal(p.data.serviceUrl, 'https://provider.test/sign');
  assert.equal(h.app._signingIdentityContinuation, undefined);
  assert.equal(h.requests.filter(o => o.url.endsWith('/sign-url')).length, 1);
  assert.equal(h.navigation.length, 1);
});

test('a switch away and back invalidates the parent before it can resume a prerequisite', async () => {
  const h = preparationHarness();
  const p = h.page('fadada-auth'); p.data.scene = 'contract'; p.data.options = { contractId: '12' };
  p.showServiceError({ code: 46101 }); p.continueSigningPreparation(); p.onHide();
  h.app._companyAccessGeneration = 2;
  await p.onShow();
  assert.equal(h.requests.length, 0);
  assert.match(p.data.errorMessage, /登录或企业已变化/);
});

test('a signing manager authorizes their own user against the original contract seal', () => {
  const h = preparationHarness();
  const p = h.page('fadada-auth'); p.data.scene = 'contract'; p.data.options = { contractId: '9007199254740993' };
  p.showServiceError({ code: 46104 }); p.continueSigningPreparation();
  const query = new URL('https://app.test' + h.navigation[0]).searchParams;
  assert.equal(query.get('scene'), 'sealGrant');
  assert.equal(query.get('userId'), '7');
  assert.equal(query.get('contractId'), '9007199254740993');
  assert.equal(query.has('sealId'), false);
});

test('the activation child restores its original operation as soon as activated membership is proven', async () => {
  const h = harness(async () => ({ status: 'READY' }));
  const id = continuation.createSigningContinuation(h.app, 'contract', { contractId: '12' });
  const p = h.page('fadada-auth'); p.data.scene = 'member'; p.data.options = { companyId: '3', continuationId: id };
  await p.loadServiceUrl();
  assert.equal(p.data.serviceResultReady, false);
  assert.match(h.navigation[0], /scene=contract&contractId=12/);
});

test('nested personal certification keeps the original contract nonce on native return to the activation child', async () => {
  const h = harness(async () => ({ status: 'NOT_STARTED' }));
  const id = continuation.createSigningContinuation(h.app, 'contract', { contractId: '12' });
  const p = h.page('fadada-auth'); p.data.scene = 'member'; p.data.options = { companyId: '3', continuationId: id };
  p.continuePersonalIdentity(); p.onHide(); await p.onShow();
  assert.ok(continuation.signingContinuation(h.app, id));
  p.continuePersonalIdentity();
  assert.equal(h.navigation.length, 2);
  assert.equal(new URL('https://app.test' + h.navigation[1]).searchParams.get('continuationId'), id);
});

test('a no-URL enterprise authorization requirement is never presented as successful certification', async () => {
  const h = harness(async () => ({ status: 'AUTHORIZATION_REQUIRED', scene: 'company' }));
  const p = h.page('fadada-auth'); p.data.scene = 'company'; p.data.options = { companyId: '3' };
  await p.loadServiceUrl();
  assert.equal(h.navigation.length, 0);
  assert.equal(p.data.preparationAction, 'company');
  assert.equal(p.data.options.renewOrganization, '1');
  const before = h.requests.length;
  p.recheckSigningPreparation();
  assert.equal(h.requests.length, before);
  assert.match(h.navigation[0], /service-return.*renewOrganization=1/);
});

test('network failures keep a retry action instead of claiming that authorization is missing', async () => {
  const h = harness(async o => {
    if (o.url === '/fadada/users/me/identity') return { status: 'VERIFIED' };
    throw Error('网络连接超时');
  });
  const p = h.page('fadada-auth'); p.data.scene = 'contract'; p.data.options = { contractId: '12' };
  await p.prepareService();
  assert.equal(p.data.preparationAction, '');
  assert.equal(p.data.canRecoverPersonalIdentity, false);
  assert.match(p.data.errorMessage, /网络连接超时/);
  assert.equal(h.navigation.length, 0);
});

test('supplementary polling waits for explicit organization authorization before continuing', async () => {
  let granted = false;
  const h = harness(async o => o.url.endsWith('/auth-url') ? { url: 'https://provider.test/organization' }
    : { status: 'VERIFIED', organizationAuthorized: granted });
  const id = continuation.createSigningContinuation(h.app, 'contract', { contractId: '12' });
  const p = h.page('fadada-auth'); p.data.scene = 'company';
  p.data.options = { companyId: '3', renewOrganization: '1', continuationId: id };
  await p.prepareService(); await p.pollStatus();
  assert.equal(h.navigation.length, 0);
  assert.equal(p.data.serviceUrl, 'https://provider.test/organization');
  granted = true; h.advance(30001); await p.pollStatus();
  assert.match(h.navigation[0], /service-return.*renewOrganization=1/);
  assert.equal(new URL('https://app.test' + h.navigation[0]).searchParams.get('continuationId'), id);
  assert.equal(h.requests.filter(o => o.url.endsWith('/auth-url')).length, 1);
});

test('a failed nested prerequisite navigation preserves its original contract continuation for retry', () => {
  const h = harness(async () => ({ status: 'READY' }));
  const id = continuation.createSigningContinuation(h.app, 'contract', { contractId: '12' });
  const p = h.page('fadada-auth'); p.data.scene = 'member'; p.data.options = { companyId: '3', continuationId: id };
  h.wx.navigateTo = o => o.fail();
  p.showServiceError({ code: 46101 }); p.continueSigningPreparation();
  assert.ok(continuation.signingContinuation(h.app, id));
  assert.equal(p._openingPrerequisite, false);
});

test('a retired abolish operation does not request identity, quotas or a provider task', async () => {
  const h = harness(async o => { throw Error('Unexpected side effect: ' + o.url); });
  const p = h.page('fadada-auth'); p.data.scene = 'abolish'; p.data.options = { contractId: '12' };
  await p.prepareService();
  await p.loadServiceUrl();
  assert.equal(p.data.serviceUrl, '');
  assert.equal(p.data.serviceResultReady, true);
  assert.match(p.data.serviceResultTitle, /作废流程已更新/);
  assert.equal(h.requests.length, 0);
  assert.equal(h.navigation.length, 0);
});

for (const scene of ['contract', 'member']) {
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
    : o.url.endsWith('/prerequisites') ? { status: 'READY' }
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
    : o.url.endsWith('/prerequisites') ? { status: 'READY' }
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
