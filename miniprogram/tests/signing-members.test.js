'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function harness(handler = async () => ({ url: 'https://example.test/members' })) {
  const requests = [], navigation = [], modals = [], toasts = [], timers = new Map();
  const app = { globalData: { token: 'session', currentCompanyId: '3', isDesktopWechat: false,
    memberInfo: { permissions: ['all'] } },
    getCurrentCompanyId() { return this.globalData.currentCompanyId; },
    refreshSession: async () => {} };
  let timerId = 0;
  const wx = {
    navigateTo: options => navigation.push(options.url),
    switchTab: options => navigation.push(options.url),
    navigateBack: () => navigation.push('back'),
    showToast: options => toasts.push(options),
    showModal: options => { modals.push(options); if (options.success) options.success({ confirm: true }); },
    setNavigationBarTitle() {}
  };
  function page(file) {
    let value;
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), {
      Page: definition => { value = definition; }, getApp: () => app, wx,
      setTimeout: callback => { timers.set(++timerId, callback); return timerId; },
      clearTimeout: id => timers.delete(id),
      require: name => {
        if (name.endsWith('/request')) return { request: async options => {
          requests.push(options);
          return options.url === '/fadada/users/me/identity' ? { status: 'VERIFIED' } : handler(options);
        } };
        if (name.endsWith('/companyContext')) return require('../utils/companyContext');
        if (name.endsWith('/signingContinuation')) return require('../utils/signingContinuation');
        if (name.endsWith('/privacy')) return { requirePrivacyAuthorization: async () => {} };
        if (name.endsWith('/companyOnboarding') || name.endsWith('/dict') || name.endsWith('/tabBar')) return {};
        throw new Error(`Unexpected dependency: ${name}`);
      }
    });
    value.setData = (values, done) => { Object.assign(value.data, values); if (done) done(); };
    return value;
  }
  return { app, wx, page, requests, navigation, modals, toasts, timers };
}

test('mobile members can start syncing their own enterprise membership directly', () => {
  const h = harness(); const p = h.page('pages/company/company.js');
  p.data.currentCompanyId = '3'; p.data.company = { name: '光屿行' }; p.data.canManage = true;
  p.goSigningMembers();
  assert.deepEqual(h.navigation, ['/pages/fadada-auth/fadada-auth?scene=member&companyId=3']);
  assert.equal(h.requests.length, 0);
  assert.equal(h.modals.length, 0);
});

test('desktop managers retain a separate organization editor alongside personal member sync', () => {
  const h = harness(); h.app.globalData.isDesktopWechat = true;
  const p = h.page('pages/company/company.js'); p.data.currentCompanyId = '9007199254740993';
  p.goSigningOrganization(); assert.equal(h.navigation.length, 0);
  p.goSigningMembers();
  p.data.canManage = true; p.goSigningOrganization();
  assert.equal(h.navigation[0], '/pages/fadada-auth/fadada-auth?scene=member&companyId=9007199254740993');
  assert.equal(h.navigation[1], '/pages/fadada-auth/fadada-auth?scene=organization&companyId=9007199254740993');
});

test('ready membership is confirmed by the backend without claiming seal authorization', async () => {
  const h = harness(async () => ({ url: null, status: 'READY' }));
  const p = h.page('pages/fadada-auth/fadada-auth.js');
  p.data.scene = 'member'; p.data.options = { companyId: '3' };
  await p.prepareService();
  assert.deepEqual(h.requests.map(item => item.url), ['/fadada/users/me/identity', '/fadada/companies/3/signing-member/sync']);
  assert.equal(h.requests[1].method, 'POST');
  assert.equal(h.requests[1].withCompany, false);
  assert.equal(p.data.serviceResultReady, true);
  assert.equal(p.data.serviceUrl, '');
  assert.match(p.data.serviceResultMessage, /仍需有效用印授权.*组织成员 → 授权签署/);
  assert.equal(h.navigation.length, 0);
  await p.checkResult();
  assert.equal(h.requests.length, 3);
});

test('inactive membership opens activation and a later explicit check requires backend READY', async () => {
  let active = false;
  const h = harness(async () => active ? { status: 'READY' }
    : { url: 'https://example.test/activate', status: 'ACTIVATION_REQUIRED' });
  const p = h.page('pages/fadada-auth/fadada-auth.js'); p._visible = true;
  p.data.scene = 'member'; p.data.options = { companyId: '3' };
  await p.prepareService();
  assert.equal(p.data.serviceUrl, 'https://example.test/activate');
  assert.equal(p.data.serviceResultReady, false);
  assert.equal(p.pollTimer, undefined);
  await p.pollStatus();
  assert.equal(h.requests.length, 2);
  active = true; await p.checkResult();
  assert.equal(p.data.serviceResultReady, true);
  assert.equal(p.data.serviceUrl, '');
});

test('seal authorization stays in H5 until explicitly rechecked and an effective grant is reused', async () => {
  let granted = false;
  const h = harness(async () => granted ? { status: 'READY' }
    : { url: 'https://example.test/grant', status: 'AUTHORIZATION_REQUIRED' });
  const p = h.page('pages/fadada-auth/fadada-auth.js'); p._visible = true;
  p.data.scene = 'sealGrant'; p.data.options = { companyId: '3', userId: '9007199254740993' };
  await p.prepareService();
  assert.deepEqual(h.requests.map(item => item.url), ['/fadada/companies/3/members/9007199254740993/seal-grant-url']);
  assert.equal(p.data.serviceUrl, 'https://example.test/grant');
  assert.equal(p.data.serviceResultReady, false);
  p.onHide(); p.onShow(); await p.pollStatus();
  assert.equal(h.requests.length, 1);
  assert.equal(h.navigation.length, 0);
  p.goBack(); assert.equal(h.navigation[0], 'back');
  granted = true;
  const reopened = h.page('pages/fadada-auth/fadada-auth.js');
  reopened.data.scene = 'sealGrant'; reopened.data.options = { companyId: '3', userId: '9007199254740993' };
  await reopened.prepareService();
  assert.equal(h.requests.length, 2);
  assert.equal(reopened.data.serviceUrl, '');
  assert.equal(reopened.data.serviceResultReady, true);
  assert.match(reopened.data.serviceResultMessage, /授权有效期内重复签署/);
});

for (const scene of ['member', 'sealGrant']) {
  test(`${scene} discards a response after the enterprise changes`, async () => {
    let resolve;
    const h = harness(() => new Promise(done => { resolve = done; }));
    const p = h.page('pages/fadada-auth/fadada-auth.js');
    p.data.scene = scene; p.data.options = { companyId: '3', userId: '7' };
    const pending = p.prepareService();
    while (!resolve) await Promise.resolve();
    h.app.globalData.currentCompanyId = '4'; resolve({ status: 'READY' });
    await pending;
    assert.equal(p.data.serviceResultReady, false);
    assert.equal(p.data.serviceUrl, '');
    assert.equal(h.navigation.length, 0);
  });
}

test('a stale target enterprise cannot initiate member synchronization in the new company context', async () => {
  const h = harness(); h.app.globalData.currentCompanyId = '4';
  const p = h.page('pages/fadada-auth/fadada-auth.js');
  p.data.scene = 'member'; p.data.options = { companyId: '3' };
  await p.prepareService();
  assert.equal(h.requests.filter(item => item.method === 'POST').length, 0);
  assert.match(p.data.errorMessage, /当前企业已变化/);
});

test('seal authorization uses user IDs and rejects pending members or stale enterprise records', async () => {
  const h = harness(async () => ({ items: [
    { id: '100', companyId: '3', userId: '9007199254740993', status: 'ACTIVE', permissions: ['contract_sign'] },
    { id: '101', companyId: '3', userId: '8', status: 'PENDING', permissions: ['contract_sign'] },
    { id: '102', companyId: '4', userId: '9', status: 'ACTIVE', permissions: ['contract_sign'] }
  ] }));
  const p = h.page('pages/auth-manage/auth-manage.js');
  await p.loadMembers(true);
  assert.equal(p.data.filtered[0].canAuthorizeSigning, true);
  assert.equal(p.data.filtered[1].canAuthorizeSigning, false);
  p.grantSigning({ currentTarget: { dataset: { userId: '9007199254740993' } } });
  assert.deepEqual(h.navigation, ['/pages/fadada-auth/fadada-auth?scene=sealGrant&companyId=3&userId=9007199254740993']);
  p.grantSigning({ currentTarget: { dataset: { userId: '8' } } });
  p.grantSigning({ currentTarget: { dataset: { userId: '9' } } });
  p.grantSigning({ currentTarget: { dataset: { userId: '100' } } });
  assert.equal(h.navigation.length, 1);
});

test('a member manager without seal management cannot initiate another member seal authorization', async () => {
  const h = harness(); h.app.globalData.memberInfo.permissions = ['member_manage'];
  const p = h.page('pages/auth-manage/auth-manage.js');
  p.data.authorizations = [{ id: '100', companyId: '3', userId: '7', status: 'ACTIVE' }];
  p.grantSigning({ currentTarget: { dataset: { userId: '7' } } });
  assert.equal(h.navigation.length, 0);
  assert.equal(h.requests.length, 0);
  assert.match(h.toasts[0].title, /印章管理员/);
});

test('saving a signing role offers the exact member authorization without confusing membership and user IDs', async () => {
  const h = harness(async () => null);
  const p = h.page('pages/auth-manage/auth-manage.js');
  p.data.authorizations = [{ id: '100', companyId: '3', userId: '9007199254740993', status: 'ACTIVE', roleCode: 'SALES' }];
  p.data.approveRoles = [{ code: 'SALES', permissions: [{ code: 'contract_sign' }] }];
  p.loadMembers = async () => {};
  p.showApproveModal({ currentTarget: { dataset: { id: '100', name: '成员' } } });
  await p.confirmApprove();
  assert.equal(h.requests[0].url, '/authorizations/100/role?companyId=3');
  assert.equal(h.modals[0].title, '继续授权签署');
  assert.match(h.modals[0].content, /有效期内可复用/);
  assert.deepEqual(h.navigation, ['/pages/fadada-auth/fadada-auth?scene=sealGrant&companyId=3&userId=9007199254740993']);
});

test('a company switch during role saving cannot offer seal authorization for the old target', async () => {
  let resolve;
  const h = harness(() => new Promise(done => { resolve = done; }));
  const p = h.page('pages/auth-manage/auth-manage.js');
  p.data.authorizations = [{ id: '100', companyId: '3', userId: '7', status: 'ACTIVE', roleCode: 'SALES' }];
  p.data.approveRoles = [{ code: 'SALES', permissions: [{ code: 'contract_sign' }] }];
  p.loadMembers = async () => {};
  p.showApproveModal({ currentTarget: { dataset: { id: '100' } } });
  const pending = p.confirmApprove();
  h.app.globalData.currentCompanyId = '4'; resolve(null); await pending;
  assert.equal(h.navigation.length, 0);
  assert.equal(h.modals.length, 0);
});

test('desktop member management opens its own endpoint and does not infer completion from enterprise certification', async () => {
  const h = harness(); h.app.globalData.isDesktopWechat = true;
  const p = h.page('pages/fadada-auth/fadada-auth.js'); p._visible = true;
  p.data.scene = 'organization'; p.data.options = { companyId: '3' };
  await p.prepareService();
  assert.equal(p.data.serviceUrl, 'https://example.test/members');
  assert.deepEqual(h.requests.map(options => options.url), ['/fadada/companies/3/organization-manage-url']);
  assert.equal(h.requests[0].withCompany, false);
  assert.equal(p.pollTimer, undefined);
  const timersBefore = h.timers.size;
  await p.pollStatus();
  assert.equal(h.timers.size, timersBefore);
  assert.equal(h.navigation.length, 0);
  p.checkResult(); assert.equal(h.navigation[0], '/pages/company/company');
});

test('a direct mobile organization URL is rejected before requesting a PC-only provider page', async () => {
  const h = harness(); const p = h.page('pages/fadada-auth/fadada-auth.js');
  p.data.scene = 'organization'; p.data.options = { companyId: '3' };
  await p.loadServiceUrl();
  assert.equal(h.requests.length, 0);
  assert.match(p.data.errorMessage, /仅支持电脑端/);
  assert.equal(p.data.serviceUrl, '');
});

test('switching enterprise while a member editor URL is loading discards the old response', async () => {
  let resolve;
  const h = harness(() => new Promise(done => { resolve = done; }));
  h.app.globalData.isDesktopWechat = true;
  const p = h.page('pages/fadada-auth/fadada-auth.js'); p.data.scene = 'organization'; p.data.options = { companyId: '3' };
  const pending = p.loadServiceUrl();
  while (!resolve) await Promise.resolve();
  h.app.globalData.currentCompanyId = '4'; resolve({ url: 'https://example.test/old-company' });
  await pending; assert.equal(p.data.serviceUrl, '');
});

test('explicit supplementary organization consent reaches the authorization endpoint for a verified enterprise', async () => {
  const h = harness(); const p = h.page('pages/fadada-auth/fadada-auth.js');
  p.data.scene = 'company'; p.data.options = { companyId: '3', renewOrganization: '1' };
  await p.prepareService();
  assert.deepEqual(h.requests.map(options => options.url), ['/fadada/companies/3/auth-url']);
  assert.equal(p.data.serviceUrl, 'https://example.test/members');
  assert.equal(h.navigation.length, 0);
  p.onUnload();
});

test('legacy VERIFIED polling cannot close supplementary consent before organization permission is confirmed', async () => {
  const h = harness(async options => options.url.endsWith('/auth-url')
    ? { url: 'https://example.test/add-organization' }
    : { status: 'VERIFIED', enabledSealCount: 1 });
  const p = h.page('pages/fadada-auth/fadada-auth.js'); p._visible = true;
  p.data.scene = 'company'; p.data.options = { companyId: '3', renewOrganization: '1' };
  await p.prepareService();
  assert.equal(p.pollTimer, null);
  await p.pollStatus();
  p.onHide(); p.onShow();
  await p.pollStatus();
  assert.equal(p.pollTimer, null);
  assert.equal(p.data.serviceUrl, 'https://example.test/add-organization');
  assert.deepEqual(h.requests.map(options => options.url), ['/fadada/companies/3/auth-url']);
  assert.equal(h.navigation.length, 0);
  p.checkResult();
  assert.deepEqual(h.navigation, ['/pages/company/company']);
  p.onUnload();
});

test('enterprise certification exposes a supplementary consent route without changing enterprise identity', () => {
  const h = harness(); const p = h.page('pages/company-cert/company-cert.js');
  p.data.companyId = '9007199254740993'; p.data.identity = { enabled: true, status: 'VERIFIED' };
  p.renewOrganizationAuthorization();
  assert.equal(h.navigation[0], '/pages/fadada-auth/fadada-auth?scene=company&companyId=9007199254740993&renewOrganization=1');
});
