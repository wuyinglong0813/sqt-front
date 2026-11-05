'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function harness(storage = {}) {
  let app;
  const modals = [], requests = [], toasts = [], navigations = [];
  let pageStack = [];
  const pageDefinitions = new Map();
  let homeRefreshes = 0;
  const wx = {
    getSystemInfoSync: () => ({ platform: 'ios' }),
    getStorageSync: key => storage[key] || '',
    setStorageSync: (key, value) => { storage[key] = value; },
    removeStorageSync: key => { delete storage[key]; },
    showModal: options => {
      const invalidLabel = ['confirmText', 'cancelText'].find(key => typeof options[key] === 'string'
        && options[key].replace(/[^\x00-\xff]/g, '##').length > 8);
      if (invalidLabel) {
        const error = { errMsg: `showModal:fail ${invalidLabel} length should not larger than 4 Chinese characters` };
        if (options.fail) options.fail(error);
        if (options.complete) options.complete(error);
        return;
      }
      modals.push(options);
    },
    showToast: options => toasts.push(options),
    navigateTo: options => navigations.push(options.url),
    redirectTo: options => navigations.push(options.url),
    switchTab: options => {
      navigations.push(options.url);
      if (options.success) options.success({});
      if (options.complete) options.complete({});
    },
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
      module, exports: module.exports, wx, getApp: () => app, getCurrentPages: () => pageStack,
      setTimeout, clearTimeout, setInterval, clearInterval,
      App: value => { app = value; }, Page: value => { pageDefinitions.set(absolute, value); },
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
    const file = `pages/${name}/${name}.js`;
    load(file);
    const definition = pageDefinitions.get(path.resolve(root, file));
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
    // Invite-preview tests isolate progress polling; separate tests below run
    // the real application loader and its account isolation checks.
    home.loadMemberApplications = async () => {};
    return home;
  }
  return { app, wx, home, page, modals, requests, storage, toasts, navigations,
    refreshes: () => homeRefreshes, invitations: load('utils/invitation.js'),
    memberApplications: load('utils/memberApplications.js'), snapshots: load('utils/homeSnapshot.js'),
    setPageStack: value => { pageStack = value; } };
}

const inviteQuery = { inviteCode: 'cooperation-code', type: 'counterparty' };
const entry = { scene: 1007, query: inviteQuery };

function cancel(modal) {
  modal.success({ confirm: false, cancel: true });
  modal.complete();
}

test('the modal harness rejects labels beyond the native SDK limit before displaying a dialog', () => {
  const env = harness();
  const callbacks = [];
  env.wx.showModal({ confirmText: '去实名认证',
    success: () => callbacks.push('success'),
    fail: error => { callbacks.push('fail'); assert.match(error.errMsg, /confirmText.*4 Chinese characters/); },
    complete: () => callbacks.push('complete') });
  assert.equal(env.modals.length, 0);
  assert.deepEqual(callbacks, ['fail', 'complete']);
  env.wx.showModal({ confirmText: '实名认证' });
  assert.equal(env.modals.length, 1);
});

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

test('member invitation cards reopen after cancellation while the existing home tab is reused', async () => {
  const env = harness();
  env.app.globalData.memberInfo = null;
  env.app.globalData.currentCompanyId = '';
  const query = { inviteCode: 'member-code', type: 'member' };
  const entry = { scene: 1007, query };
  const home = env.home();
  home.onLoad({});

  env.app.onShow(entry);
  env.page('invitation').onLoad(query);
  assert.equal(env.navigations.at(-1), '/pages/index/index');
  await home.onShow();
  assert.equal(env.modals.length, 1);
  assert.equal(env.modals[0].title, '申请加入企业组织');
  cancel(env.modals[0]);

  // An ordinary resume can retain the very same share entry. It must stay quiet.
  env.app.onShow(entry);
  await home.onShow();
  assert.equal(env.modals.length, 1);
  assert.equal(env.app.globalData.pendingInvite, null);

  // Opening the card creates an invitation page even though the home tab exists.
  env.app.onShow(entry);
  env.page('invitation').onLoad(query);
  await home.onShow();
  assert.equal(env.modals.length, 2);
  assert.equal(env.app.globalData.pendingInvite.code, 'member-code');
  assert.equal(home.data.showJoinForm, true);
});

test('the explicit invitation page accepts links independently of an ordinary app entry scene', async () => {
  const env = harness();
  const query = { inviteCode: 'member+code', type: 'member' };
  env.app.onShow({ scene: 1089, query });
  assert.equal(env.app.globalData.pendingInvite, null);
  env.page('invitation').onLoad(query);
  assert.equal(env.app.globalData.pendingInvite.code, 'member+code');
  assert.equal(env.app.globalData.pendingInvite.type, 'member');
  await env.home().onShow();
  assert.equal(env.modals[0].title, '申请加入企业组织');
  assert.match(env.requests[0].url, /member%2Bcode$/);
});

test('an invitation page keeps a failed home navigation visible and can retry the same invitation', () => {
  const env = harness();
  const page = env.page('invitation');
  const successfulSwitch = env.wx.switchTab;
  env.wx.switchTab = options => {
    env.navigations.push(options.url);
    if (options.fail) options.fail({ errMsg: 'switchTab:fail timeout' });
    if (options.complete) options.complete({ errMsg: 'switchTab:fail timeout' });
  };
  page.onLoad({ inviteCode: 'retry-code', type: 'member' });
  assert.ok(page.data.error);
  assert.equal(env.app.globalData.pendingInvite.code, 'retry-code');
  env.wx.switchTab = successfulSwitch;
  page.openInvite();
  assert.equal(env.navigations.length, 2);
  assert.equal(env.navigations.at(-1), '/pages/index/index');
  assert.equal(page.data.error, '');
  assert.equal(env.app.globalData.pendingInvite.code, 'retry-code');
});

test('an invitation page without a code displays an error and offers home without inventing an invitation', () => {
  const env = harness();
  const page = env.page('invitation');
  page.onLoad({ type: 'member' });
  assert.ok(page.data.error);
  assert.equal(env.app.globalData.pendingInvite, null);
  assert.equal(env.navigations.length, 0);
  page.openInvite();
  assert.equal(env.navigations.length, 0);
  page.goHome();
  assert.equal(env.navigations.at(-1), '/pages/index/index');
  assert.equal(env.app.globalData.pendingInvite, null);
});

test('cooperation invitation cards also pass through the explicit invitation page', async () => {
  const env = harness();
  const home = env.home();
  Object.assign(home.data, { counterpartyInviteCode: 'partner+code', inviteCompanyId: 'company-1', inviteRole: home.data.role });
  const share = home.onShareAppMessage({ from: 'button', target: { dataset: { inviteType: 'counterparty' } } });
  assert.equal(share.path, '/pages/invitation/invitation?inviteCode=partner%2Bcode&type=counterparty');
  const query = { inviteCode: 'partner+code', type: 'counterparty' };
  env.app.onShow({ scene: 1007, query });
  env.page('invitation').onLoad(query);
  await home.onShow();
  assert.equal(env.modals[0].title, '接受企业合作邀请');
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

test('explicitly reopened processed invitation cards show their result without another membership write', async () => {
  for (const type of ['member', 'counterparty']) {
    const env = harness();
    const query = { inviteCode: 'processed-code', type };
    env.invitations.markInviteProcessed(env.app, { code: query.inviteCode, type });
    const home = env.home();
    const entry = { scene: 1007, query };
    env.app.onShow(entry);
    env.page('invitation').onLoad(query);
    await home.onShow();
    assert.equal(env.modals.length, 1);
    assert.equal(env.modals[0].title, '邀请已处理');
    assert.match(env.modals[0].content, type === 'member' ? /等待.*管理员审核/ : /企业合作关系/);
    assert.equal(env.app.globalData.pendingInvite, null);
    assert.equal(env.requests.filter(request => request.method === 'POST').length, 0);

    env.app.onShow(entry);
    await home.onShow();
    assert.equal(env.modals.length, 1);

    env.app.onShow(entry);
    env.page('invitation').onLoad(query);
    await home.onShow();
    assert.equal(env.modals.length, 2);
    assert.equal(env.modals[1].title, '邀请已处理');
    assert.equal(env.requests.filter(request => request.method === 'POST').length, 0);
  }
});

test('an explicit processed invitation waits for the restored account before displaying its saved result', async () => {
  const storage = {};
  const previous = harness(storage);
  previous.invitations.markInviteProcessed(previous.app, { code: 'processed-code', type: 'member' });
  const env = harness(storage);
  env.app.globalData.userInfo = null;
  const home = env.home();
  const query = { inviteCode: 'processed-code', type: 'member' };
  env.app.onShow({ scene: 1007, query });
  env.page('invitation').onLoad(query);
  // The token can be present before /me restores the account identity.
  home.scheduleSessionRestore = () => {};
  await home.onShow();
  assert.equal(env.modals.length, 0);
  assert.equal(env.app.globalData.pendingInvite.code, 'processed-code');
  env.app.globalData.userInfo = { id: 'user-1' };
  await home.onShow();
  assert.equal(env.modals[0].title, '邀请已处理');
  assert.equal(env.app.globalData.pendingInvite, null);
  assert.equal(env.requests.filter(request => request.method === 'POST').length, 0);
});

test('an invitation opened before login continues to the member application after login', async () => {
  const env = harness();
  Object.assign(env.app.globalData, { token: '', userInfo: null, memberInfo: null, currentCompanyId: '' });
  const query = { inviteCode: 'login-code', type: 'member' };
  env.app.onShow({ scene: 1007, query });
  env.page('invitation').onLoad(query);
  const home = env.home();
  await home.onShow();
  assert.equal(env.modals.length, 0);
  assert.equal(env.app.globalData.pendingInvite.code, 'login-code');
  assert.equal(env.requests.length, 0);

  Object.assign(env.app.globalData, { token: 'new-login-token', userInfo: { id: 'new-user' } });
  await home.onShow();
  assert.equal(env.modals[0].title, '申请加入企业组织');
  let accepting;
  const processInvite = home.processInvite;
  home.processInvite = (...args) => { accepting = processInvite.apply(home, args); return accepting; };
  env.modals[0].success({ confirm: true });
  env.modals[0].complete();
  await accepting;
  const writes = env.requests.filter(request => request.method === 'POST');
  assert.equal(writes.length, 1);
  assert.match(writes[0].url, /\/companies\/join$/);
  assert.equal(writes[0].data.code, 'login-code');
  assert.equal(env.app.globalData.pendingInvite, null);
});

test('another account is not suppressed by the previous account processing the same invitation', async () => {
  const storage = {};
  const previous = harness(storage);
  previous.invitations.markInviteProcessed(previous.app, { code: 'shared-code', type: 'member' });
  const env = harness(storage);
  env.app.globalData.userInfo = { id: 'another-account' };
  const query = { inviteCode: 'shared-code', type: 'member' };
  env.app.onShow({ scene: 1007, query });
  env.page('invitation').onLoad(query);
  await env.home().onShow();
  assert.equal(env.modals.length, 1);
  assert.equal(env.modals[0].title, '申请加入企业组织');
  assert.equal(env.app.globalData.pendingInvite.code, 'shared-code');
  assert.equal(env.requests.filter(request => request.method === 'POST').length, 0);
});

test('an explicit invitation opening replaces an earlier account identity continuation for the same code', async () => {
  const env = harness();
  const previousInvite = { code: 'shared-code', type: 'member', identityUserId: 'other-user' };
  env.app.globalData.pendingInvite = previousInvite;
  env.page('invitation').onLoad({ inviteCode: 'shared-code', type: 'member' });
  assert.notEqual(env.app.globalData.pendingInvite, previousInvite);
  await env.home().onShow();
  assert.equal(env.modals.length, 1);
  assert.equal(env.modals[0].title, '申请加入企业组织');
  assert.equal(env.app.globalData.pendingInvite.code, 'shared-code');
  assert.equal(env.app.globalData.pendingInvite.identityUserId, undefined);
  assert.equal(env.requests.filter(request => request.method === 'POST').length, 0);
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

test('a new explicit card replaces an in-flight preview without an older response unlocking it', async () => {
  for (const newCode of ['old-code', 'new-code']) for (const oldResult of ['success', 'failure']) {
    const env = harness();
    const home = env.home();
    const previews = [];
    env.wx.request = options => { env.requests.push(options); previews.push(options); };
    env.page('invitation').onLoad({ inviteCode: 'old-code', type: 'member' });
    const oldShowing = home.onShow();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(previews.length, 1);

    env.page('invitation').onLoad({ inviteCode: newCode, type: 'member' });
    const currentInvite = env.app.globalData.pendingInvite;
    const newShowing = home.onShow();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(previews.length, 2);
    await home.onShow();
    assert.equal(previews.length, 2);

    if (oldResult === 'success') previews[0].success({ statusCode: 200, data: { code: 0,
      data: { companyName: '旧邀请企业', type: 'member' } } });
    else previews[0].fail({ errMsg: 'request:fail old preview timeout' });
    await oldShowing;
    assert.equal(env.modals.length, 0);
    assert.equal(env.toasts.length, 0);
    assert.equal(env.app.globalData.pendingInvite, currentInvite);
    await home.onShow();
    assert.equal(previews.length, 2);

    previews[1].success({ statusCode: 200, data: { code: 0,
      data: { companyName: '新邀请企业', type: 'member' } } });
    await newShowing;
    assert.equal(env.modals.length, 1);
    assert.match(env.modals[0].content, /新邀请企业/);
    assert.doesNotMatch(env.modals[0].content, /旧邀请企业/);
  }
});

test('callbacks from a replaced invitation confirmation cannot accept it or unlock the new confirmation', async () => {
  for (const type of ['member', 'counterparty']) for (const newCode of ['old-code', 'new-code']) {
    const env = harness();
    const home = env.home();
    env.page('invitation').onLoad({ inviteCode: 'old-code', type });
    await home.onShow();
    assert.equal(env.modals.length, 1);
    const oldModal = env.modals[0];

    env.page('invitation').onLoad({ inviteCode: newCode, type });
    const currentInvite = env.app.globalData.pendingInvite;
    await home.onShow();
    assert.equal(env.modals.length, 2);
    const newModal = env.modals[1];
    const requestsBeforeCallbacks = env.requests.length;

    oldModal.success({ confirm: true });
    oldModal.complete();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(env.requests.filter(request => request.method === 'POST').length, 0);
    assert.equal(env.app.globalData.pendingInvite, currentInvite);
    await home.onShow();
    assert.equal(env.requests.length, requestsBeforeCallbacks);
    assert.equal(env.modals.length, 2);

    cancel(newModal);
    assert.equal(env.app.globalData.pendingInvite, null);
  }
});

test('a failed invitation dialog remains retryable and provides visible failure feedback', async () => {
  for (const type of ['member', 'counterparty']) {
    const env = harness();
    const home = env.home();
    env.page('invitation').onLoad({ inviteCode: 'retry-modal-code', type });
    const invite = env.app.globalData.pendingInvite;
    const showModal = env.wx.showModal;
    let attempts = 0;
    env.wx.showModal = options => {
      if (attempts++ === 0) {
        if (options.fail) options.fail({ errMsg: 'showModal:fail native dialog unavailable' });
        if (options.complete) options.complete({ errMsg: 'showModal:fail native dialog unavailable' });
        return;
      }
      return showModal(options);
    };
    await home.onShow();
    assert.equal(env.modals.length, 0);
    assert.equal(env.app.globalData.pendingInvite, invite);
    assert.equal(env.toasts.length, 1);
    assert.ok(env.toasts[0].title);
    assert.equal(env.toasts[0].icon, 'none');
    assert.equal(env.requests.filter(request => request.method === 'POST').length, 0);

    await home.onShow();
    assert.equal(attempts, 2);
    assert.equal(env.modals.length, 1);
    assert.equal(env.app.globalData.pendingInvite, invite);
    assert.equal(env.toasts.length, 1);
    assert.equal(env.requests.filter(request => request.method === 'POST').length, 0);
  }
});

test('a stale dialog failure cannot notify about or unlock a newly opened invitation', async () => {
  for (const type of ['member', 'counterparty']) for (const newCode of ['old-code', 'new-code']) {
    const env = harness();
    const home = env.home();
    env.page('invitation').onLoad({ inviteCode: 'old-code', type });
    await home.onShow();
    const oldModal = env.modals[0];
    env.page('invitation').onLoad({ inviteCode: newCode, type });
    const invite = env.app.globalData.pendingInvite;
    await home.onShow();
    assert.equal(env.modals.length, 2);
    const previewCount = env.requests.length;

    assert.equal(typeof oldModal.fail, 'function');
    oldModal.fail({ errMsg: 'showModal:fail stale modal failure' });
    oldModal.complete();
    assert.equal(env.toasts.length, 0);
    assert.equal(env.app.globalData.pendingInvite, invite);
    await home.onShow();
    assert.equal(env.modals.length, 2);
    assert.equal(env.requests.length, previewCount);
    assert.equal(env.requests.filter(request => request.method === 'POST').length, 0);
  }
});

test('an unverified member invitation goes to real-name certification before submitting membership', async () => {
  const env = harness();
  env.app.onShow({ scene: 1007, query: { inviteCode: 'member-code', type: 'member' } });
  env.wx.request = options => options.success({ statusCode: 200, data: { code: 0, data: {
    companyId: 'inviter', companyName: '邀请方企业', type: 'member', personalIdentityRequired: true
  } } });
  await env.home().onShow();
  assert.equal(env.modals[0].confirmText, '实名认证');
  assert.ok([...env.modals[0].confirmText].length <= 4);
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

test('member invitation is prepared without a recipient phone and can be shared after readiness', async () => {
  const env = harness();
  const page = env.page('auth-manage');
  let sending;
  env.wx.request = options => { env.requests.push(options); sending = options; };
  const preparing = page.openMemberInvite();
  assert.equal(sending.data.companyId, 'company-1');
  assert.equal(sending.data.targetPhone, undefined);
  const event = { from: 'button', target: { dataset: { inviteType: 'member' } } };
  assert.equal(page.onShareAppMessage(event).path, '/pages/index/index');
  sending.success({ statusCode: 200, data: { code: 0, data: { code: 'targeted-code' } } });
  await preparing;
  assert.equal(page.onShareAppMessage(event).path, '/pages/invitation/invitation?inviteCode=targeted-code&type=member');
  assert.doesNotMatch(page.onShareAppMessage(event).path, /13800138000/);
  page.closeMemberInvite();
  assert.equal(page.onShareAppMessage(event).path, '/pages/index/index');
});

test('an earlier invitation request or login cannot overwrite the current share card', async () => {
  const env = harness();
  const page = env.page('auth-manage');
  const pending = [];
  env.wx.request = options => pending.push(options);
  const first = page.openMemberInvite();
  page.closeMemberInvite();
  const second = page.openMemberInvite();
  pending[1].success({ statusCode: 200, data: { code: 0, data: { code: 'new-code' } } });
  await second;
  pending[0].success({ statusCode: 200, data: { code: 0, data: { code: 'old-code' } } });
  await first;
  assert.equal(page.data.inviteCode, 'new-code');
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
  assert.equal(env.modals[0].confirmText, '核验号码');
  assert.ok([...env.modals[0].confirmText].length <= 4);
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

test('mini program QR scenes resolve to the same member invitation without exposing a phone', async () => {
  for (const scene of ['ABCD2345', 'i%3DABCD2345']) {
    const env = harness();
    env.page('invitation').onLoad({ scene });
    assert.equal(env.app.globalData.pendingInvite.code, 'ABCD2345');
    assert.equal(env.app.globalData.pendingInvite.type, 'member');
    await env.home().onShow();
    assert.equal(env.modals[0].title, '申请加入企业组织');
  }
});

test('an open invitation saves an unverified application before guiding personal certification', async () => {
  const env = harness();
  env.app.globalData.currentCompanyId = '';
  env.app.globalData.memberInfo = null;
  env.app.globalData.companies = [];
  env.wx.request = options => {
    env.requests.push(options);
    options.success({ statusCode: 200, data: { code: 0, data: options.method === 'POST'
      ? { status: 'PENDING_IDENTITY', applicationId: '9007199254740997', companyId: 'inviter', companyName: '受邀企业' }
      : { companyId: 'inviter', companyName: '受邀企业', type: 'member', invitationMode: 'OPEN', personalIdentityRequired: true,
        phoneBindingRequired: true } } });
  };
  env.page('invitation').onLoad({ inviteCode: 'OPEN1234' });
  const home = env.home();
  await home.onShow();
  assert.equal(env.requests.filter(item => item.method === 'POST').length, 0);
  assert.equal(env.modals[0].confirmText, '提交申请');
  env.modals[0].success({ confirm: true });
  env.modals[0].complete();
  await new Promise(resolve => setImmediate(resolve));
  const write = env.requests.find(item => item.method === 'POST');
  assert.equal(write.url, 'https://sqt.org.cn/api/companies/join');
  assert.equal(write.header['X-Company-Id'], undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(write.data)), { code: 'OPEN1234' });
  assert.deepEqual(env.navigations.slice(-1), ['/pages/personal-cert/personal-cert?flow=member-join&applicationId=9007199254740997']);
  assert.equal(env.app.globalData.currentCompanyId, '');
  assert.equal(env.app.globalData.memberInfo, null);
  assert.deepEqual(env.app.globalData.companies, []);
  assert.equal(env.app.globalData.pendingInvite, null);
  assert.equal(env.refreshes(), 0);
});

test('manual member codes use the same saved application and certification continuation on either tab', async () => {
  for (const name of ['index', 'company']) {
    const env = harness();
    const page = name === 'index' ? env.home() : env.page('company');
    Object.assign(page.data, { joinCompanyId: 'OPEN1234', joinCode: 'OPEN1234', showJoinModal: true });
    env.wx.request = options => {
      env.requests.push(options);
      options.success({ statusCode: 200, data: { code: 0, data: options.method === 'POST'
        ? { status: 'PENDING_IDENTITY', applicationId: 'application-1', companyId: 'company-2', companyName: '申请企业' }
        : [] } });
    };
    await (name === 'index' ? page.joinCompany() : page.submitJoin());
    assert.equal(page.data.showJoinModal, false);
    assert.equal(env.requests.filter(item => item.method === 'POST').length, 1);
    assert.equal(env.navigations.at(-1), '/pages/personal-cert/personal-cert?flow=member-join&applicationId=application-1');
    assert.equal(env.app.globalData.currentCompanyId, 'company-1');
  }
});

test('application progress is loaded without enterprise context and exposes only a safe summary', async () => {
  const env = harness();
  const page = env.home();
  page.loadMemberApplications = env.memberApplications.memberApplicationMethods.loadMemberApplications;
  env.wx.request = options => {
    env.requests.push(options);
    options.success({ statusCode: 200, data: { code: 0, data: [
      { id: '9007199254740997', companyId: 'company-2', companyName: '待认证企业', status: 'PENDING_IDENTITY', bankAccount: 'must-never-render' },
      { id: '2', companyId: 'company-3', companyName: '待审核企业', status: 'PENDING' },
      { id: '3', companyId: 'company-4', companyName: '已加入企业', status: 'ACTIVE' }
    ] } });
  };
  await page.loadMemberApplications();
  assert.equal(env.requests[0].url, 'https://sqt.org.cn/api/me/member-applications');
  assert.equal(env.requests[0].header['X-Company-Id'], undefined);
  assert.equal(page.data.memberApplications.length, 2);
  assert.equal(page.data.memberApplications[0].id, '9007199254740997');
  assert.equal(page.data.memberApplications[0].bankAccount, undefined);
  assert.match(page.data.memberApplications[0].statusText, /实名/);
  assert.match(page.data.memberApplications[1].statusText, /管理员审核/);
  page.continueMemberApplication({ currentTarget: { dataset: { id: '9007199254740997' } } });
  assert.equal(env.navigations.at(-1), '/pages/personal-cert/personal-cert?flow=member-join&applicationId=9007199254740997');
  page.continueMemberApplication({ currentTarget: { dataset: { id: '2' } } });
  assert.equal(env.navigations.length, 1);
  assert.equal(env.app.globalData.currentCompanyId, 'company-1');
});

test('late application lists cannot leak the previous account or restore a page after unload', async () => {
  const env = harness();
  const page = env.home();
  page.loadMemberApplications = env.memberApplications.memberApplicationMethods.loadMemberApplications;
  const requests = [];
  env.wx.request = options => requests.push(options);
  const loading = page.loadMemberApplications();
  env.app.globalData.token = 'token-2';
  env.app.globalData.userInfo = { id: 'user-2' };
  page.resetMemberApplicationContext();
  requests[0].success({ statusCode: 200, data: { code: 0,
    data: [{ id: 'old', companyName: '上一账号的企业', status: 'PENDING' }] } });
  await loading;
  assert.equal(page.data.memberApplications.length, 0);
  const another = page.loadMemberApplications();
  page.onUnload();
  requests[1].success({ statusCode: 200, data: { code: 0,
    data: [{ id: 'late', companyName: '已卸载页面的企业', status: 'PENDING' }] } });
  await another;
  assert.equal(page.data.memberApplications.length, 0);
});

test('successful certification resumes a saved application with a server check instead of reusing its invitation', async () => {
  const env = harness();
  const page = env.page('personal-cert');
  page._memberJoinFlow = true;
  page._memberApplicationId = 'application-1';
  page._flowToken = env.app.globalData.token;
  Object.assign(page.data, { phoneLoading: false, phoneBound: true, identity: { status: 'VERIFIED' } });
  env.wx.request = options => {
    env.requests.push(options);
    options.success({ statusCode: 200, data: { code: 0, data: { id: 'application-1', status: 'PENDING' } } });
  };
  assert.equal(await page.resumeMemberJoinIfReady(), true);
  assert.equal(env.requests.length, 1);
  assert.equal(env.requests[0].url, 'https://sqt.org.cn/api/me/member-applications/application-1/identity-ready');
  assert.equal(env.requests[0].method, 'POST');
  assert.equal(env.requests[0].header['X-Company-Id'], undefined);
  assert.equal(env.navigations.at(-1), '/pages/index/index');
  assert.equal(env.app.globalData.currentCompanyId, 'company-1');
  assert.equal(env.app.globalData.pendingInvite, null);
});

test('saved applications stay recoverable after a server verification failure or changed session', async () => {
  for (const changedSession of [false, true]) {
    const env = harness();
    const page = env.page('personal-cert');
    page._memberJoinFlow = true;
    page._memberApplicationId = 'application-1';
    page._flowToken = env.app.globalData.token;
    Object.assign(page.data, { phoneLoading: false, phoneBound: true, identity: { status: 'VERIFIED' } });
    let pending;
    env.wx.request = options => { pending = options; };
    const syncing = page.resumeMemberJoinIfReady();
    if (changedSession) {
      env.app.globalData.token = 'new-account';
      pending.success({ statusCode: 200, data: { code: 0, data: { status: 'PENDING' } } });
    } else pending.fail({ errMsg: 'request:fail timeout' });
    assert.equal(await syncing, false);
    assert.equal(env.navigations.length, 0);
    if (!changedSession) {
      assert.equal(page._returning, false);
      assert.equal(env.toasts.length, 1);
    }
  }
});

test('member application context survives the provider page and its fixed personal callback', () => {
  const env = harness();
  const personal = env.page('personal-cert');
  personal._memberJoinFlow = true;
  personal._memberApplicationId = 'application-1';
  personal._flowToken = env.app.globalData.token;
  personal._returnOptions = {};
  Object.assign(personal.data, { phoneLoading: false, phoneBound: true, providerEnabled: true });
  personal.startAuth();
  assert.equal(env.navigations.at(-1), '/pages/fadada-auth/fadada-auth?scene=personal&flow=member-join&applicationId=application-1');

  const provider = env.page('fadada-auth');
  Object.assign(provider.data, { scene: 'personal', options: { flow: 'member-join', applicationId: 'application-1' } });
  provider.isPageContextCurrent = () => true;
  provider.stopStatusPolling = () => {};
  provider.pauseWebViewWatchdog = () => {};
  provider.openReturnPage();
  assert.equal(env.navigations.at(-1), '/pages/service-return/service-return?scene=personal&flow=member-join&applicationId=application-1');

  personal.route = 'pages/personal-cert/personal-cert';
  const returned = env.page('service-return');
  returned.syncResult = () => {};
  env.setPageStack([personal, { route: 'pages/service-return/service-return' }]);
  returned.onLoad({ scene: 'personal' });
  assert.equal(returned.data.options.flow, 'member-join');
  assert.equal(returned.data.options.applicationId, 'application-1');
});

test('the personal result page rechecks a saved application only after server-confirmed real-name success', async () => {
  for (const status of ['NOT_STARTED', 'VERIFIED']) {
    const env = harness();
    const page = env.page('service-return');
    page.data.options = { scene: 'personal', flow: 'member-join', applicationId: 'application-1' };
    page.readAuthenticationResult = async () => ({ status });
    page.startCountdown = () => {};
    env.wx.request = options => {
      env.requests.push(options);
      options.success({ statusCode: 200, data: { code: 0, data: { status: 'PENDING' } } });
    };
    await page.syncResult();
    const writes = env.requests.filter(item => item.method === 'POST');
    assert.equal(writes.length, status === 'VERIFIED' ? 1 : 0);
    if (status === 'VERIFIED') {
      assert.equal(writes[0].url, 'https://sqt.org.cn/api/me/member-applications/application-1/identity-ready');
      assert.equal(writes[0].header['X-Company-Id'], undefined);
      assert.match(page.data.message, /等待管理员审核/);
      page.goBusinessPage();
      assert.equal(env.navigations.at(-1), '/pages/index/index');
    } else assert.equal(page.data.failed, true);
    assert.equal(env.app.globalData.currentCompanyId, 'company-1');
  }
});

test('the provider result cannot resume an application after the account changed', async () => {
  const env = harness();
  const page = env.page('service-return');
  page.data.options = { scene: 'personal', flow: 'member-join', applicationId: 'application-1' };
  let finish;
  page.readAuthenticationResult = () => new Promise(resolve => { finish = resolve; });
  const syncing = page.syncResult();
  env.app.globalData.token = 'different-account';
  finish({ status: 'VERIFIED' });
  await syncing;
  assert.equal(env.requests.length, 0);
  assert.equal(env.navigations.length, 0);
});

test('home waits for current server membership before reading or displaying an enterprise snapshot', async () => {
  const env = harness();
  env.app.globalData.userInfo.currentCompanyId = 'company-1';
  env.snapshots.writeHomeSnapshot({ userId: 'user-1', companyId: 'company-1', role: 'supplier', period: 'year' },
    { companyName: '旧企业数据', ranking: [{ companyName: '缓存客户' }] });
  const page = env.page('index');
  page.startApprovalPolling = () => {};
  page.loadOnboardingSummary = () => {};
  page.loadMemberApplications = async () => {};
  page.refreshHomeData = async () => { throw new Error('unapproved user must not load enterprise business'); };
  const restore = page.restoreHomeSnapshot;
  const reads = [];
  page.restoreHomeSnapshot = options => { reads.push(options); return restore.call(page, options); };
  Object.assign(page.data, { companyName: '旧企业数据', ranking: [{ companyName: '缓存客户' }], homeHasSnapshot: true });
  let ready;
  env.app.ensureSessionReady = () => new Promise(resolve => { ready = resolve; });
  const showing = page.onShow();
  assert.equal(reads.length, 0);
  assert.equal(page.data.sessionRestoring, true);
  assert.equal(page.data.homeHasSnapshot, false);
  env.app.globalData.currentCompanyId = '';
  env.app.globalData.userInfo.currentCompanyId = null;
  env.app.globalData.memberInfo = { roleCode: 'GUEST', memberStatus: 'NONE' };
  ready({ user: env.app.globalData.userInfo });
  await showing;
  assert.equal(reads.length, 1);
  assert.equal(reads[0].disabled, true);
  assert.equal(page.data.showJoinForm, true);
  assert.equal(page.data.homeHasSnapshot, false);
  assert.equal(page.data.companyName, '');
  assert.equal(page.data.ranking.length, 0);
});
