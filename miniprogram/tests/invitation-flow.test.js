'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function harness(storage = {}) {
  let app, definition;
  const modals = [], requests = [], toasts = [], navigations = [];
  let homeRefreshes = 0;
  const wx = {
    getSystemInfoSync: () => ({ platform: 'ios' }),
    getStorageSync: key => storage[key] || '',
    setStorageSync: (key, value) => { storage[key] = value; },
    removeStorageSync: key => { delete storage[key]; },
    showModal: options => modals.push(options),
    showToast: options => toasts.push(options),
    navigateTo: options => navigations.push(options.url),
    switchTab: options => navigations.push(options.url),
    request: options => {
      requests.push(options);
      options.success({ statusCode: 200, data: { code: 0, data: options.url.includes('/companies/invitations/') ? { companyId: 'inviter', companyName: '被邀请加入的企业全称', type: 'member' } : { message: '已建立客户关系' } } });
    }
  };
  const root = path.join(__dirname, '..');
  const modules = new Map();
  function load(file) {
    const absolute = path.resolve(root, file);
    if (modules.has(absolute)) return modules.get(absolute).exports;
    const module = { exports: {} };
    modules.set(absolute, module);
    vm.runInNewContext(fs.readFileSync(absolute, 'utf8'), {
      module, exports: module.exports, wx, getApp: () => app,
      setTimeout, clearTimeout, setInterval, clearInterval,
      App: value => { app = value; }, Page: value => { definition = value; },
      require: id => load(path.relative(root, path.resolve(path.dirname(absolute), `${id}.js`)))
    }, { filename: absolute });
    return module.exports;
  }
  load('app.js');
  Object.assign(app.globalData, {
    token: 'token-1', userInfo: { id: 'user-1' }, currentCompanyId: 'company-1',
    memberInfo: { roleCode: 'LEGAL' },
    companies: [{ companyId: 'company-1', companyName: '河北云域科技有限公司' }]
  });
  app.restoreStoredSession = () => {};
  app.refreshSession = async () => {};
  app.ensureSessionReady = async () => {};
  app.loadMe = async () => {};
  function page(name) {
    load(`pages/${name}/${name}.js`);
    const page = { ...definition, data: JSON.parse(JSON.stringify(definition.data)) };
    page.setData = values => Object.assign(page.data, values);
    return page;
  }
  function home() {
    const home = page('index');
    home.startApprovalPolling = () => {};
    home.restoreHomeSnapshot = () => {};
    home.initRoleFromMember = () => {};
    home.loadOnboardingSummary = () => {};
    home.refreshHomeData = async () => { homeRefreshes++; };
    return home;
  }
  return { app, wx, home, page, modals, requests, storage, toasts, navigations,
    refreshes: () => homeRefreshes, invitations: load('utils/invitation.js') };
}

const inviteQuery = { inviteCode: 'cooperation-code', type: 'counterparty' };
const entry = { scene: 1007, query: inviteQuery };

function cancel(modal) {
  modal.success({ confirm: false, cancel: true });
  modal.complete();
}

test('cancelled cooperation invitation stays dismissed across resume, company switches and replayed share parameters', async () => {
  const env = harness();
  const page = env.home();
  env.app.onShow(entry);
  page.onLoad(inviteQuery);
  await page.onShow();
  assert.equal(env.modals.length, 1);
  assert.match(env.modals[0].content, /河北云域科技有限公司/);
  cancel(env.modals[0]);
  env.app.onShow(entry); // Some WeChat resumes keep the original share scene too.
  await page.onShow();
  assert.equal(env.modals.length, 1);
  env.app.globalData.currentCompanyId = 'company-2';
  await page.onShow();
  assert.equal(env.modals.length, 1);
  env.app.onShow({ scene: 1089, query: inviteQuery });
  await page.onShow();
  assert.equal(env.modals.length, 1);
  assert.equal(env.app.globalData.pendingInvite, null);
  assert.ok(env.refreshes() >= 3);
});

test('cold start from recent apps ignores a retained invitation query even in page onLoad', async () => {
  for (const scene of [1001, 1089, 1090]) {
    const env = harness();
    env.app.onShow({ scene, query: inviteQuery });
    const page = env.home();
    page.onLoad(inviteQuery);
    await page.onShow();
    assert.equal(env.modals.length, 0);
    assert.equal(env.app.globalData.pendingInvite, null);
    assert.equal(page.data.showJoinForm, false);
  }
});

test('a new page deep link is accepted independently of the previous ordinary entry scene', async () => {
  const env = harness();
  env.app.onShow({ scene: 1089, query: {} });
  const page = env.home();
  page.onLoad(inviteQuery);
  await page.onShow();
  assert.equal(env.modals.length, 1);
});

test('an explicitly reopened invitation page can prompt again after cancellation', async () => {
  const env = harness();
  env.app.onShow(entry);
  const first = env.home();
  first.onLoad(inviteQuery);
  await first.onShow();
  cancel(env.modals[0]);
  env.app.onShow(entry);
  const reopened = env.home();
  reopened.onLoad(inviteQuery);
  await reopened.onShow();
  assert.equal(env.modals.length, 2);
});

test('success is remembered across a new process for the same account and code', async () => {
  const storage = {};
  const env = harness(storage);
  env.app.onShow(entry);
  const page = env.home();
  await page.processInvite(inviteQuery.inviteCode);
  assert.equal(env.app.globalData.pendingInvite, null);
  assert.equal(env.requests.length, 1);
  assert.ok(env.refreshes() > 0);
  const reopened = harness(storage);
  reopened.app.onShow(entry);
  const newPage = reopened.home();
  newPage.onLoad(inviteQuery);
  await newPage.onShow();
  assert.equal(reopened.modals.length, 0);
  reopened.app.globalData.userInfo = { id: 'other-user' };
  reopened.app.onShow({ scene: 1008, query: inviteQuery });
  await newPage.onShow();
  assert.equal(reopened.modals.length, 1);
});

test('member success history does not suppress cooperation invitations with the same code', async () => {
  const env = harness();
  const memberInvite = { code: inviteQuery.inviteCode, type: 'member' };
  env.invitations.markInviteProcessed(env.app, memberInvite);
  env.app.onShow(entry);
  await env.home().onShow();
  assert.equal(env.modals.length, 1);
});

test('confirmation uses the refreshed enterprise name and cannot accept for a changed enterprise', async () => {
  const env = harness();
  let ready;
  env.app.ensureSessionReady = () => new Promise(resolve => { ready = resolve; });
  env.app.globalData.companies = [];
  env.app.onShow(entry);
  const page = env.home();
  const showing = page.onShow();
  assert.equal(env.modals.length, 0);
  env.app.globalData.companies = [{ companyId: 'company-1', companyName: '认证后的企业' }];
  ready();
  await showing;
  assert.match(env.modals[0].content, /认证后的企业/);
  env.app.globalData.currentCompanyId = 'company-2';
  env.modals[0].success({ confirm: true });
  env.modals[0].complete();
  assert.equal(env.requests.filter(r => r.method === 'POST').length, 0);
});

test('a failed acceptance keeps the invitation available and never records success', async () => {
  const env = harness();
  env.app.onShow(entry);
  const invite = env.app.globalData.pendingInvite;
  env.wx.request = options => options.fail({ errMsg: 'request:fail timeout' });
  await env.home().processInvite(invite.code);
  assert.equal(env.app.globalData.pendingInvite, invite);
  assert.equal(env.invitations.wasInviteProcessed(env.app, invite), false);
  assert.equal(env.toasts.length, 1);
});

test('an invitation consumed before this version stops prompting after the server confirms it was used', async () => {
  const env = harness();
  env.app.onShow(entry);
  const page = env.home();
  env.wx.request = options => options.success({ statusCode: 200, data: { code: 400, message: '邀请码已被使用' } });
  await page.processInvite(inviteQuery.inviteCode);
  assert.equal(env.app.globalData.pendingInvite, null);
  env.app.onShow(entry);
  await page.onShow();
  assert.equal(env.modals.length, 0);
});

test('completion of an older invitation cannot dismiss a newly opened invitation', async () => {
  const env = harness();
  env.app.onShow(entry);
  const page = env.home();
  let request;
  env.wx.request = options => { request = options; };
  const accepting = page.processInvite(inviteQuery.inviteCode);
  env.app.onShow({ scene: 1007, query: { ...inviteQuery, inviteCode: 'new-code' } });
  request.success({ statusCode: 200, data: { code: 0, data: {} } });
  await accepting;
  assert.equal(env.app.globalData.pendingInvite.code, 'new-code');
  assert.equal(env.modals.length, 0);
});

test('member invitation still reaches join confirmation when the account has no enterprise', async () => {
  const env = harness();
  env.app.globalData.memberInfo = null;
  env.app.globalData.currentCompanyId = '';
  const query = { inviteCode: 'member-code', type: 'member' };
  env.app.onShow({ scene: 1008, query });
  const page = env.home();
  page.onLoad(query);
  await page.onShow();
  assert.equal(env.modals[0].title, '申请加入企业组织');
  env.app.globalData.token = 'other-token';
  env.modals[0].success({ confirm: true });
  env.modals[0].complete();
  assert.equal(env.requests.filter(r => r.method === 'POST').length, 0);
});


test('member confirmation loads the inviting enterprise rather than the current enterprise', async () => {
  const env = harness();
  env.app.onShow({ scene: 1007, query: { inviteCode: 'member-code', type: 'member' } });
  const page = env.home();
  await page.onShow();
  assert.match(env.modals[0].content, /被邀请加入的企业全称/);
  assert.doesNotMatch(env.modals[0].content, /河北云域科技有限公司/);
  assert.equal(env.requests[0].header['X-Company-Id'], undefined);
  assert.equal(env.requests.filter(r => r.method === 'POST').length, 0);
});

test('member confirmation never accepts an invitation whose company could not be loaded', async () => {
  const env = harness();
  env.app.onShow({ scene: 1007, query: { inviteCode: 'member-code', type: 'member' } });
  env.wx.request = options => options.fail({ errMsg: 'request:fail timeout' });
  await env.home().onShow();
  assert.equal(env.modals.length, 0);
  assert.ok(env.app.globalData.pendingInvite);
  assert.equal(env.toasts.length, 1);
});

test('a stale member invitation preview cannot open a confirmation for a new invitation', async () => {
  const env = harness();
  env.app.onShow({ scene: 1007, query: { inviteCode: 'old-code', type: 'member' } });
  let preview;
  env.wx.request = options => { preview = options; };
  const page = env.home();
  const showing = page.onShow();
  await new Promise(resolve => setImmediate(resolve));
  env.app.onShow({ scene: 1008, query: { inviteCode: 'new-code', type: 'member' } });
  preview.success({ statusCode: 200, data: { code: 0, data: { companyName: '旧企业', type: 'member' } } });
  await showing;
  assert.equal(env.modals.length, 0);
  assert.equal(env.app.globalData.pendingInvite.code, 'new-code');
});

test('an unverified member invitation goes to real-name certification before submitting membership', async () => {
  const env = harness();
  env.app.onShow({ scene: 1007, query: { inviteCode: 'member-code', type: 'member' } });
  env.wx.request = options => options.success({ statusCode: 200, data: { code: 0, data: {
    companyId: 'inviter', companyName: '邀请方企业', type: 'member', personalIdentityRequired: true
  } } });
  await env.home().onShow();
  assert.equal(env.modals[0].confirmText, '去实名认证');
  assert.match(env.modals[0].content, /邀请方企业.*实名认证/);
  env.modals[0].success({ confirm: true });
  env.modals[0].complete();
  assert.deepEqual(env.navigations, ['/pages/personal-cert/personal-cert?flow=member-join']);
  assert.equal(env.requests.filter(request => request.method === 'POST').length, 0);
  assert.equal(env.app.globalData.pendingInvite.code, 'member-code');
  assert.ok(env.storage.tradepass_member_identity_invite);
});

test('server real-name requirement on a manual join preserves its code for certification', async () => {
  for (const name of ['index', 'company']) for (const code of [46103, 46201]) {
    const env = harness();
    env.wx.request = options => options.success({ statusCode: 200,
      data: { code, message: '请先核验手机号并完成个人实名认证，再申请加入企业' } });
    const page = name === 'index' ? env.home() : env.page(name);
    Object.assign(page.data, { joinCompanyId: 'manual-code', joinCode: 'manual-code', showJoinModal: true });
    await (name === 'index' ? page.joinCompany() : page.submitJoin());
    assert.equal(page.data.showJoinModal, false);
    assert.deepEqual(env.navigations, ['/pages/personal-cert/personal-cert?flow=member-join']);
    assert.equal(env.app.globalData.pendingInvite.code, 'manual-code');
  }
});

test('targeted member invitation cannot be prepared or shared without its recipient phone', async () => {
  const env = harness();
  const page = env.page('auth-manage');
  page.openMemberInvite();
  await page.shareInvite();
  assert.equal(env.requests.length, 0);
  assert.match(env.toasts.at(-1).title, /受邀人.*手机号/);
  let sending;
  env.wx.request = options => { env.requests.push(options); sending = options; };
  page.onInvitePhoneInput({ detail: { value: '13800138000' } });
  const preparing = page.shareInvite();
  assert.equal(sending.data.targetPhone, '13800138000');
  const event = { from: 'button', target: { dataset: { inviteType: 'member' } } };
  assert.equal(page.onShareAppMessage(event).path, '/pages/index/index');
  sending.success({ statusCode: 200, data: { code: 0, data: { code: 'targeted-code' } } });
  await preparing;
  assert.equal(page.data.invitePhoneMasked, '138****8000');
  assert.equal(page.onShareAppMessage(event).path, '/pages/index/index?inviteCode=targeted-code&type=member');
  assert.doesNotMatch(page.onShareAppMessage(event).path, /13800138000/);
  page.onInvitePhoneInput({ detail: { value: '13900139000' } });
  assert.equal(page.onShareAppMessage(event).path, '/pages/index/index');
});

test('a prepared invitation for an earlier phone or login cannot overwrite the current recipient', async () => {
  const env = harness();
  const page = env.page('auth-manage');
  const pending = [];
  env.wx.request = options => pending.push(options);
  page.openMemberInvite();
  page.onInvitePhoneInput({ detail: { value: '13800138000' } });
  const first = page.shareInvite();
  page.onInvitePhoneInput({ detail: { value: '13900139000' } });
  const second = page.shareInvite();
  pending[1].success({ statusCode: 200, data: { code: 0, data: { code: 'new-code' } } });
  await second;
  pending[0].success({ statusCode: 200, data: { code: 0, data: { code: 'old-code' } } });
  await first;
  assert.equal(page.data.inviteCode, 'new-code');
  assert.equal(page.data.invitePhone, '13900139000');
  env.app.globalData.token = 'other-login';
  const event = { from: 'button', target: { dataset: { inviteType: 'member' } } };
  assert.equal(page.onShareAppMessage(event).path, '/pages/index/index');
});

test('a recipient without a verified phone is guided to verification before any membership write', async () => {
  const env = harness();
  env.app.onShow({ scene: 1007, query: { inviteCode: 'targeted-code', type: 'member' } });
  env.wx.request = options => options.success({ statusCode: 200, data: { code: 0, data: {
    companyId: 'inviter', companyName: '邀请方企业', type: 'member', phoneBindingRequired: true,
    targetPhoneMasked: '138****8000', personalIdentityRequired: false
  } } });
  await env.home().onShow();
  assert.equal(env.modals[0].confirmText, '核验手机号');
  assert.match(env.modals[0].content, /138\*\*\*\*8000/);
  env.modals[0].success({ confirm: true });
  env.modals[0].complete();
  assert.deepEqual(env.navigations, ['/pages/personal-cert/personal-cert?flow=member-join']);
  assert.equal(env.requests.filter(request => request.method === 'POST').length, 0);
  assert.equal(env.app.globalData.pendingInvite.code, 'targeted-code');
});

for (const code of [46202, 46203, 46204]) {
  test(`an unusable member invitation (${code}) is dismissed without creating a membership`, async () => {
    const env = harness();
    env.app.onShow({ scene: 1007, query: { inviteCode: 'targeted-code', type: 'member' } });
    env.wx.request = options => {
      env.requests.push(options);
      options.success({ statusCode: 200, data: { code, message: '此邀请仅限指定受邀人使用，请联系邀请人重新发送' } });
    };
    await env.home().onShow();
    assert.equal(env.app.globalData.pendingInvite, null);
    assert.equal(env.requests.filter(request => request.method === 'POST').length, 0);
    assert.equal(env.modals[0].showCancel, false);
    assert.match(env.modals[0].content, /指定受邀人/);
    assert.equal(env.navigations.length, 0);
  });
}

test('a previously saved phone is reverified before an already-real-name member resumes its invitation', async () => {
  const env = harness();
  env.invitations.startMemberIdentity(env.app, 'targeted-code');
  env.navigations.length = 0;
  const page = env.page('personal-cert');
  page._memberJoinFlow = true;
  page._flowToken = env.app.globalData.token;
  page.data.phoneLoading = false;
  page.applyPhoneProfile({ id: 'user-1', phone: '13800138000', phoneVerified: false }, env.app.globalData.token);
  assert.equal(page.data.phoneBound, false);
  env.wx.request = options => options.success({ statusCode: 200, data: { code: 0, data:
    options.url.endsWith('/auth/bind-phone')
      ? { id: 'user-1', phone: '13800138000', phoneVerified: true }
      : { status: 'VERIFIED', providerEnabled: true }
  } });
  await page.loadIdentity(false);
  assert.equal(env.navigations.length, 0);
  await page.bindWechatPhone({ detail: { errMsg: 'getPhoneNumber:ok', code: 'server-verifiable-phone-code' } });
  assert.equal(page.data.phoneBound, true);
  assert.deepEqual(env.navigations, ['/pages/index/index']);
  assert.equal(env.app.globalData.pendingInvite.code, 'targeted-code');
});

test('certification invitation survives restart only for its own account and cancellation clears it', async () => {
  const storage = {};
  const original = harness(storage);
  original.invitations.startMemberIdentity(original.app, 'member-code');
  const reopened = harness(storage);
  reopened.invitations.restoreMemberIdentityInvite(reopened.app);
  assert.equal(reopened.app.globalData.pendingInvite.code, 'member-code');
  reopened.app.globalData.userInfo = { id: 'other-account' };
  reopened.invitations.restoreMemberIdentityInvite(reopened.app);
  assert.equal(reopened.app.globalData.pendingInvite, null);
  reopened.app.globalData.userInfo = { id: 'user-1' };
  reopened.invitations.restoreMemberIdentityInvite(reopened.app);
  reopened.invitations.dismissInvite(reopened.app, reopened.app.globalData.pendingInvite);
  assert.equal(storage.tradepass_member_identity_invite, undefined);
  assert.equal(reopened.app.globalData.pendingInvite, null);
});

test('verified personal certification returns to the retained member invitation but ignores a changed login', async () => {
  const env = harness();
  env.invitations.startMemberIdentity(env.app, 'member-code');
  env.navigations.length = 0;
  env.wx.request = options => options.success({ statusCode: 200, data: { code: 0,
    data: { status: 'VERIFIED', providerEnabled: true } } });
  const page = env.page('personal-cert');
  page._flowToken = env.app.globalData.token;
  page._memberJoinFlow = true;
  page.data.phoneLoading = false;
  page.data.phoneBound = true;
  await page.loadIdentity(false);
  assert.deepEqual(env.navigations, ['/pages/index/index']);
  assert.equal(env.app.globalData.pendingInvite.code, 'member-code');
  env.navigations.length = 0;
  page._returning = false;
  env.app.globalData.token = 'another-login';
  await page.loadIdentity(false);
  assert.deepEqual(env.navigations, []);
});
