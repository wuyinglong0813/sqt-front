'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function harness(handler) {
  const calls = [], navigation = [];
  const app = { globalData: { token: 'session', currentCompanyId: '3', userInfo: { id: '7' } },
    getCurrentCompanyId() { return this.globalData.currentCompanyId; },
    applyMePayload(payload) { this.globalData.currentCompanyId = payload.user.currentCompanyId; } };
  function page(name = 'company') {
    let value;
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../pages', name, `${name}.js`), 'utf8'), {
      Page: definition => { value = definition; }, getApp: () => app,
      wx: { navigateTo: options => navigation.push(options.url), stopPullDownRefresh() {} },
      require: id => {
        if (id.endsWith('/request')) return { request: async options => { calls.push(options); return handler(options); } };
        if (id.endsWith('/companyContext')) return require('../utils/companyContext');
        if (id.endsWith('/signingContinuation')) return require('../utils/signingContinuation');
        if (id.endsWith('/companyOnboarding')) return { readDraft: () => null };
        if (id.endsWith('/dict')) return { certification: status => ({ text: status === 'VERIFIED' ? '已认证' : '待认证' }) };
        if (id.endsWith('/tabBar')) return {};
        throw new Error(id);
      }
    });
    value.setData = update => Object.assign(value.data, update);
    value.data.currentCompanyId = '3';
    value.data.member = { roleCode: 'SALES', memberStatus: 'ACTIVE', permissions: ['contract_sign'] };
    return value;
  }
  return { app, calls, navigation, page };
}

test('company readiness loads through GET and hides ready or non-signing members', async () => {
  let status = 'READY';
  const h = harness(async () => ({ status, action: 'none' }));
  const p = h.page();
  for (status of ['READY', 'NOT_REQUIRED']) {
    await p.loadSigningReadiness();
    assert.equal(p.data.signingReadiness, null);
  }
  assert.ok(h.calls.every(call => call.url === '/fadada/companies/3/signing-readiness'
    && (!call.method || call.method === 'GET') && call.withCompany === false));
  p.data.member.permissions = ['supplier_view'];
  await p.loadSigningReadiness();
  assert.equal(h.calls.length, 2, 'No invitation or synchronization is issued for non-signing members');
});

test('background preparation stays out of todos while failed preparation keeps a read-only retry', async () => {
  let result;
  const h = harness(async () => result);
  const p = h.page();
  for (result of [{ status: 'PENDING', action: 'none' }, { status: 'SYNCING', action: 'none' }]) {
    await p.loadSigningReadiness();
    assert.equal(p.data.signingReadiness, null);
  }
  result = { status: 'PENDING', action: 'recheck', message: '签署准备暂未完成，可重新检查' };
  await p.loadSigningReadiness();
  assert.equal(p.data.signingReadiness.title, '签署状态待确认');
  assert.equal(p.data.signingReadiness.actionText, '重新检查');
  await p.handleSigningReadiness();
  assert.equal(h.calls.length, 4);
  assert.ok(h.calls.every(call => !call.method || call.method === 'GET'));
  assert.equal(h.navigation.length, 0);
});

test('company show reads readiness without creating links or invitations', async () => {
  const h = harness(async options => {
    if (options.url === '/me') return { user: { currentCompanyId: '3' }, company: { id: '3', certificationStatus: 'VERIFIED' },
      companies: [{ companyId: '3' }], member: { roleCode: 'SALES', memberStatus: 'ACTIVE', permissions: ['contract_sign'] } };
    if (options.url.endsWith('/signing-readiness')) return { status: 'ACTIVATION_REQUIRED', action: 'member', message: '请本人确认加入' };
    return [];
  });
  const p = h.page();
  p.loadTodos = async () => {};
  p.loadEnterpriseMetrics = async () => {};
  await p.loadData();
  assert.equal(p.data.signingReadiness.status, 'ACTIVATION_REQUIRED');
  assert.ok(h.calls.every(call => !call.method || call.method === 'GET'));
  assert.equal(h.navigation.length, 0);
  p.handleSigningReadiness();
  assert.deepEqual(h.navigation, ['/pages/fadada-auth/fadada-auth?scene=member&companyId=3']);
});

test('personal prerequisites route only the current person and recheck remains read-only', async () => {
  let result = { status: 'WAITING_PERSONAL_IDENTITY', action: 'personal', message: '请本人实名' };
  const h = harness(async () => result);
  const p = h.page();
  await p.loadSigningReadiness();
  assert.equal(p.data.signingReadiness.actionText, '本人去实名');
  p.handleSigningReadiness();
  assert.deepEqual(h.navigation, ['/pages/personal-cert/personal-cert']);
  result = { status: 'WAITING_SEAL_AUTHORIZATION', action: 'none', message: '待管理员完成用印授权' };
  await p.loadSigningReadiness();
  await p.handleSigningReadiness();
  p.manageSigningReadiness();
  assert.equal(h.navigation.length, 1, 'A signer cannot issue their own seal grant');
  assert.ok(h.calls.every(call => !call.method || call.method === 'GET'));
});

test('authorized managers continue the existing official grant flow for their own user ID', async () => {
  const h = harness(async () => ({ status: 'WAITING_SEAL_AUTHORIZATION', action: 'sealGrant',
    message: '请用印管理员办理', canManageSealAuthorization: true, userId: 'someone-else', url: 'https://example.invalid' }));
  const p = h.page();
  p.data.member.permissions = ['all'];
  await p.loadSigningReadiness();
  assert.equal(p.data.signingReadiness.title, '完成用印授权');
  assert.equal(p.data.signingReadiness.actionText, '去授权');
  p.handleSigningReadiness();
  assert.deepEqual(h.navigation, ['/pages/fadada-auth/fadada-auth?scene=sealGrant&companyId=3&userId=7&returnToMembers=1']);
  p.data.member.permissions = ['contract_sign'];
  p.handleSigningReadiness();
  assert.equal(h.navigation.length, 1);
});

test('seal authorization remains a waiting item without current local management permissions', async () => {
  const h = harness(async () => ({ status: 'WAITING_SEAL_AUTHORIZATION', action: 'sealGrant',
    canManageSealAuthorization: true }));
  const p = h.page();
  await p.loadSigningReadiness();
  assert.equal(p.data.signingReadiness.title, '待管理员用印授权');
  assert.equal(p.data.signingReadiness.actionText, '重新检查');
  await p.handleSigningReadiness();
  assert.equal(h.navigation.length, 0);
  assert.ok(h.calls.every(call => !call.method || call.method === 'GET'));
});

test('an administrator can explicitly continue enterprise consent without restarting legal onboarding', async () => {
  const h = harness(async () => ({ status: 'WAITING_COMPANY_AUTHORIZATION', action: 'company', message: '待超管补授权' }));
  const p = h.page(); p.data.canCompanyManage = true;
  await p.loadSigningReadiness();
  assert.equal(p.data.signingReadiness.actionText, '去授权');
  p.handleSigningReadiness();
  assert.deepEqual(h.navigation, ['/pages/fadada-auth/fadada-auth?scene=company&companyId=3&renewOrganization=1']);
});

test('stale company, overlapping reads, lost permissions and unload cannot restore old readiness', async () => {
  for (const change of ['company', 'overlap', 'permissions', 'unload']) {
    let finish, reads = 0;
    const h = harness(() => ++reads === 1 ? new Promise(resolve => { finish = resolve; })
      : Promise.resolve({ status: 'READY', action: 'none' }));
    const p = h.page();
    const pending = p.loadSigningReadiness();
    if (change === 'company') h.app.globalData.currentCompanyId = 'other';
    if (change === 'overlap') await p.loadSigningReadiness();
    if (change === 'permissions') { p.data.member.permissions = []; await p.loadSigningReadiness(); }
    if (change === 'unload') p.onUnload();
    finish({ status: 'ACTIVATION_REQUIRED', action: 'member', message: '旧企业' });
    await pending;
    assert.equal(p.data.signingReadiness, null, change);
    p.handleSigningReadiness();
    assert.equal(h.navigation.length, 0, change);
  }
});

test('readiness failure exposes only a retry and does not start synchronization', async () => {
  const h = harness(async () => { throw new Error('状态暂不可用'); });
  const p = h.page();
  await p.loadSigningReadiness();
  assert.equal(p.data.signingReadiness.status, 'READ_ERROR');
  assert.equal(p.data.signingReadiness.message, '状态暂不可用');
  await p.handleSigningReadiness();
  assert.equal(h.calls.length, 2);
  assert.ok(h.calls.every(call => !call.method || call.method === 'GET'));
  assert.equal(h.navigation.length, 0);
});

test('historical legal verification stays in secondary company identity information', async () => {
  let roleCode = 'ADMIN';
  const h = harness(async () => ({ company: { id: '3', name: '历史企业', certificationStatus: 'VERIFIED' },
    member: { roleCode, memberStatus: 'ACTIVE', roleText: '管理员', permissions: ['all'] } }));
  const p = h.page('company-info');
  await p.onShow();
  assert.equal(p.data.canVerifyLegal, true);
  assert.equal(p.data.certificationText, '已认证');
  assert.ok(h.calls.every(call => call.url === '/me' && !call.method));
  p.goLegalVerification();
  assert.deepEqual(h.navigation, ['/pages/legal-representative/legal-representative?companyId=3']);
  roleCode = 'LEGAL'; await p.loadInfo();
  assert.equal(p.data.canVerifyLegal, false);
  p.goLegalVerification(); assert.equal(h.navigation.length, 1);
  roleCode = 'ADMIN'; await p.loadInfo();
  h.app.globalData.currentCompanyId = 'other';
  p.goLegalVerification(); assert.equal(h.navigation.length, 1);
});

test('company homepage removes permanent technical identity actions and registers its secondary page', () => {
  const homepage = fs.readFileSync(path.join(__dirname, '../pages/company/company.wxml'), 'utf8');
  assert.ok(!homepage.includes('bindtap="goSigningMembers"'));
  assert.ok(!homepage.includes('bindtap="goLegalVerification"'));
  assert.ok(!homepage.includes('由法人或授权经办人创建企业'));
  assert.ok(homepage.includes('创建企业工作空间，或通过邀请码加入已有企业'));
  assert.ok(homepage.includes('wx:if="{{signingReadiness}}"'));
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../app.json'), 'utf8'));
  assert.ok(manifest.pages.includes('pages/company-info/company-info'));
});
