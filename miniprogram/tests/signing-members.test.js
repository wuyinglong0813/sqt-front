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
    redirectTo: options => navigation.push(options.url),
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
        if (name.endsWith('/invitation')) return require('../utils/invitation');
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
  assert.match(p.data.serviceResultMessage, /继续核验用印权限.*组织成员 → 完成用印授权/);
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
  assert.deepEqual(h.navigation, ['/pages/fadada-auth/fadada-auth?scene=sealGrant&companyId=3&userId=9007199254740993&returnToMembers=1']);
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

test('saving a signing role directly continues the exact member authorization without another consent dialog', async () => {
  const h = harness(async () => null);
  h.app.globalData.userInfo = { id: '99' };
  const p = h.page('pages/auth-manage/auth-manage.js');
  p.data.authorizations = [{ id: '100', companyId: '3', userId: '9007199254740993', status: 'ACTIVE', roleCode: 'SALES' }];
  p.data.approveRoles = [{ code: 'SALES', permissions: [{ code: 'contract_sign' }] }];
  p.loadMembers = async () => {};
  p.showApproveModal({ currentTarget: { dataset: { id: '100', name: '成员' } } });
  await p.confirmApprove();
  assert.equal(h.requests[0].url, '/authorizations/100/role?companyId=3');
  assert.equal(h.modals.length, 0);
  assert.equal(h.app.globalData.userInfo.id, '99');
  assert.equal(h.requests[0].data.userId, undefined);
  assert.deepEqual(h.navigation, ['/pages/fadada-auth/fadada-auth?scene=sealGrant&companyId=3&userId=9007199254740993&returnToMembers=1']);
});

test('member signing status only becomes ready after the server confirms the actual seal grant', async () => {
  const h = harness(async () => ({ items: [
    { id: '1', companyId: '3', userId: '7', status: 'ACTIVE', permissions: ['contract_sign'], signingStatus: 'READY' },
    { id: '2', companyId: '3', userId: '8', status: 'ACTIVE', permissions: ['all'], signingStatus: 'WAITING_SEAL_AUTHORIZATION', signingMessage: '待法人完成用印确认' },
    { id: '3', companyId: '3', userId: '9', status: 'ACTIVE', permissions: ['contract_sign'] },
    { id: '4', companyId: '3', userId: '10', status: 'ACTIVE', permissions: ['supplier_view'], signingStatus: 'NOT_REQUIRED' },
    { id: '5', companyId: '3', userId: '11', status: 'ACTIVE', permissions: ['contract_sign'], signingStatus: 'WAITING_PERSONAL_IDENTITY' }
  ] }));
  const p = h.page('pages/auth-manage/auth-manage.js');
  await p.loadMembers();
  assert.equal(p.data.filtered[0].signingReady, true);
  assert.equal(p.data.filtered[0].signingStatusText, '签署权限已就绪');
  assert.equal(p.data.filtered[1].signingReady, false);
  assert.equal(p.data.filtered[1].signingStatusText, '待完成用印授权');
  assert.equal(p.data.filtered[1].signingMessage, '待法人完成用印确认');
  assert.equal(p.data.filtered[2].signingReady, false);
  assert.equal(p.data.filtered[2].signingStatus, 'PENDING');
  assert.equal(p.data.filtered[3].canAuthorizeSigning, false);
  assert.equal(p.data.filtered[4].signingStatusText, '待本人实名认证');
  assert.equal(p.data.hasPendingSigning, true);
  p.grantSigning({ currentTarget: { dataset: { userId: '7' } } });
  assert.equal(h.navigation.length, 0);
  const template = fs.readFileSync(path.join(__dirname, '../pages/auth-manage/auth-manage.wxml'), 'utf8');
  assert.match(template, /!item.signingReady && canGrantSigning/);
  assert.match(template, /完成用印授权/);
  assert.match(template, /实际用印管理权限/);
  assert.match(template, /bindtap="refreshSigningStatus"/);
});

test('signing status refresh waits for delivery and stops as soon as the confirmed grant is ready', async () => {
  let status = 'WAITING_SEAL_AUTHORIZATION';
  const h = harness(async () => ({ items: [
    { id: '1', companyId: '3', userId: '7', status: 'ACTIVE', permissions: ['contract_sign'], signingStatus: status }
  ] }));
  const p = h.page('pages/auth-manage/auth-manage.js'); p._visible = true;
  await p.loadMembers();
  assert.equal(h.timers.size, 1);
  status = 'READY';
  const [id, tick] = [...h.timers][0]; h.timers.delete(id); await tick();
  assert.equal(h.requests.length, 2);
  assert.ok(h.requests.every(item => item.url.startsWith('/authorizations?')));
  assert.equal(p.data.filtered[0].signingReady, true);
  assert.equal(h.timers.size, 0);
  assert.equal(h.navigation.length, 0);
});

test('pending signing status polling is bounded, pauses when hidden and can be explicitly retried', async () => {
  const h = harness(async () => ({ items: [
    { id: '1', companyId: '3', userId: '7', status: 'ACTIVE', permissions: ['contract_sign'], signingStatus: 'WAITING_SEAL_AUTHORIZATION' }
  ] }));
  const p = h.page('pages/auth-manage/auth-manage.js'); p._visible = true;
  await p.loadMembers();
  p.onHide(); assert.equal(h.timers.size, 0);
  p._visible = true; await p.refreshSigningStatus();
  for (let count = 0; count < 8; count++) {
    const [id, tick] = [...h.timers][0]; h.timers.delete(id); await tick();
  }
  assert.equal(h.timers.size, 0);
  await p.refreshSigningStatus(); assert.equal(h.timers.size, 1);
  p.onUnload(); assert.equal(h.timers.size, 0);
});

test('an old member response cannot replace the current company generation or its signing state', async () => {
  const completions = [];
  const h = harness(() => new Promise(resolve => completions.push(resolve)));
  const p = h.page('pages/auth-manage/auth-manage.js');
  const old = p.loadMembers();
  h.app._companyAccessGeneration = 2;
  const current = p.loadMembers();
  completions[1]({ items: [{ id: '2', userId: '8', companyId: '3', status: 'ACTIVE', permissions: ['contract_sign'], signingStatus: 'WAITING_SEAL_AUTHORIZATION' }] });
  await current;
  completions[0]({ items: [{ id: '1', userId: '7', companyId: '3', status: 'ACTIVE', permissions: ['all'], signingStatus: 'READY' }] });
  await old;
  assert.equal(p.data.filtered[0].userId, '8');
  assert.equal(p.data.filtered[0].signingReady, false);
  assert.equal(p.data.loading, false);
});

test('a failed official-page navigation can be retried for the same user without resaving their role', () => {
  const h = harness(); const p = h.page('pages/auth-manage/auth-manage.js');
  let attempts = 0;
  h.wx.navigateTo = options => { attempts++; if (attempts === 1) options.fail(); else h.navigation.push(options.url); };
  p.openSealGrant('3', '9007199254740993', true);
  assert.equal(p._openingSealGrant, false);
  p.openSealGrant('3', '9007199254740993', true);
  p.openSealGrant('3', '9007199254740993', true);
  assert.equal(attempts, 2);
  assert.equal(h.navigation.length, 1);
  assert.equal(h.requests.length, 0);
  assert.match(h.toasts[0].title, /未打开.*重试/);
});

test('lost management permission after saving a signing role cannot open a grant page under another identity', async () => {
  const h = harness(async () => null); const p = h.page('pages/auth-manage/auth-manage.js');
  p.data.authorizations = [{ id: '100', companyId: '3', userId: '9007199254740993', status: 'ACTIVE', roleCode: 'SALES' }];
  p.data.approveRoles = [{ code: 'SALES', permissions: [{ code: 'contract_sign' }] }];
  p.loadMembers = async () => {};
  h.app.refreshSession = async () => { h.app.globalData.memberInfo.permissions = ['contract_sign']; };
  p.showApproveModal({ currentTarget: { dataset: { id: '100' } } });
  await p.confirmApprove();
  assert.equal(h.requests.length, 1);
  assert.equal(h.navigation.length, 0);
  assert.equal(h.modals.length, 0);
});

test('an assignment official page automatically returns only after its exact default-seal grant is confirmed', async () => {
  let granted = false;
  const h = harness(async options => options.url.endsWith('/seal-grant-status')
    ? { status: granted ? 'READY' : 'AUTHORIZATION_REQUIRED' }
    : { url: 'https://example.test/grant', status: 'AUTHORIZATION_REQUIRED' });
  const p = h.page('pages/fadada-auth/fadada-auth.js'); p._visible = true;
  p.data.scene = 'sealGrant'; p.data.options = { companyId: '3', userId: '9007199254740993', returnToMembers: '1' };
  await p.loadServiceUrl();
  await p.pollMemberGrantStatus();
  assert.equal(h.navigation.length, 0);
  assert.equal(p.data.serviceUrl, 'https://example.test/grant');
  granted = true; await p.pollMemberGrantStatus();
  assert.equal(h.navigation[0], '/pages/auth-manage/auth-manage');
  assert.equal(h.requests.filter(options => options.url.endsWith('/seal-grant-url')).length, 1);
  const checks = h.requests.filter(options => options.url.endsWith('/seal-grant-status'));
  assert.equal(checks.length, 2);
  assert.equal(checks[0].url, '/fadada/companies/3/members/9007199254740993/seal-grant-status');
  assert.equal(checks[0].method, 'POST');
  assert.equal(checks[0].token, 'session');
  assert.equal(p.grantStatusTimer, null);
});

test('a grant-status failure keeps the official page and retries without issuing another grant URL', async () => {
  const h = harness(async options => {
    if (options.url.endsWith('/seal-grant-status')) throw Error('查询暂时不可用');
    return { url: 'https://example.test/grant', status: 'AUTHORIZATION_REQUIRED' };
  });
  const p = h.page('pages/fadada-auth/fadada-auth.js'); p._visible = true;
  p.data.scene = 'sealGrant'; p.data.options = { companyId: '3', userId: '7', returnToMembers: '1' };
  await p.loadServiceUrl(); await p.pollMemberGrantStatus();
  assert.equal(p.data.serviceUrl, 'https://example.test/grant');
  assert.equal(p.data.errorMessage, '');
  assert.equal(h.navigation.length, 0);
  assert.equal(h.requests.filter(options => options.url.endsWith('/seal-grant-url')).length, 1);
  assert.ok(p.grantStatusTimer);
  p.onHide(); assert.equal(p.grantStatusTimer, null);
  const count = h.requests.length; await p.pollMemberGrantStatus();
  assert.equal(h.requests.length, count);
});

test('a grant check completing after a company change cannot return an old member assignment', async () => {
  let complete;
  const h = harness(async options => options.url.endsWith('/seal-grant-status')
    ? new Promise(resolve => { complete = resolve; })
    : { url: 'https://example.test/grant', status: 'AUTHORIZATION_REQUIRED' });
  const p = h.page('pages/fadada-auth/fadada-auth.js'); p._visible = true;
  p.data.scene = 'sealGrant'; p.data.options = { companyId: '3', userId: '7', returnToMembers: '1' };
  await p.loadServiceUrl();
  const check = p.pollMemberGrantStatus();
  h.app._companyAccessGeneration = 2; complete({ status: 'READY' }); await check;
  assert.equal(h.navigation.length, 0);
  assert.equal(p.data.serviceResultReady, false);
});

test('an official grant confirmed while its page is hidden waits for a fresh visible verification', async () => {
  let complete, first = true;
  const h = harness(async options => {
    if (!options.url.endsWith('/seal-grant-status')) return { url: 'https://example.test/grant', status: 'AUTHORIZATION_REQUIRED' };
    if (first) { first = false; return new Promise(resolve => { complete = resolve; }); }
    return { status: 'READY' };
  });
  const p = h.page('pages/fadada-auth/fadada-auth.js'); p._visible = true;
  p.data.scene = 'sealGrant'; p.data.options = { companyId: '3', userId: '7', returnToMembers: '1' };
  await p.loadServiceUrl();
  const check = p.pollMemberGrantStatus(); p.onHide();
  complete({ status: 'READY' }); await check;
  assert.equal(h.navigation.length, 0);
  p.onShow(); await p.pollMemberGrantStatus();
  assert.equal(h.navigation[0], '/pages/auth-manage/auth-manage');
  assert.equal(h.requests.filter(options => options.url.endsWith('/seal-grant-url')).length, 1);
});

test('official-page grant polling stops after a bounded wait without recreating the authorization link', async () => {
  const h = harness(async () => ({ status: 'AUTHORIZATION_REQUIRED' }));
  const p = h.page('pages/fadada-auth/fadada-auth.js'); p._visible = true;
  p.data.scene = 'sealGrant'; p.data.options = { companyId: '3', userId: '7', returnToMembers: '1' };
  p.startMemberGrantPolling();
  let checks = 0;
  while (p.grantStatusTimer) {
    const id = p.grantStatusTimer, tick = h.timers.get(id); h.timers.delete(id); await tick();
    assert.ok(++checks <= 120, 'grant verification must have a finite wait');
  }
  assert.equal(checks, 120);
  assert.equal(h.requests.length, 120);
  assert.ok(h.requests.every(options => options.url.endsWith('/seal-grant-status')));
  assert.equal(h.navigation.length, 0);
});

test('an old-contract seal assignment never uses the default-seal polling endpoint', async () => {
  const h = harness(async () => ({ url: 'https://example.test/grant', status: 'AUTHORIZATION_REQUIRED' }));
  const p = h.page('pages/fadada-auth/fadada-auth.js'); p._visible = true;
  p.data.scene = 'sealGrant';
  p.data.options = { companyId: '3', userId: '7', contractId: '9007199254740993', returnToMembers: '1' };
  await p.loadServiceUrl(); await p.pollMemberGrantStatus();
  assert.equal(h.requests.length, 1);
  assert.equal(p.grantStatusTimer, undefined);
  assert.equal(h.navigation.length, 0);
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
  assert.ok(p.pollTimer);
  await p.pollStatus();
  p.onHide(); p.onShow();
  await p.pollStatus();
  assert.ok(p.pollTimer);
  assert.equal(p.data.serviceUrl, 'https://example.test/add-organization');
  assert.deepEqual(h.requests.map(options => options.url), ['/fadada/companies/3/auth-url', '/fadada/companies/3/identity/sync']);
  assert.equal(h.navigation.length, 0);
  p.checkResult();
  assert.match(h.navigation[0], /service-return.*scene=company&renewOrganization=1&companyId=3/);
  p.onUnload();
});

test('enterprise certification exposes a supplementary consent route without changing enterprise identity', () => {
  const h = harness(); const p = h.page('pages/company-cert/company-cert.js');
  p.data.companyId = '9007199254740993'; p.data.identity = { enabled: true, status: 'VERIFIED' };
  p.renewOrganizationAuthorization();
  assert.equal(h.navigation[0], '/pages/fadada-auth/fadada-auth?scene=company&companyId=9007199254740993&renewOrganization=1');
});
