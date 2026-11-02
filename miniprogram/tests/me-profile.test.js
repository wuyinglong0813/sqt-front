'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function profile(id = '7', nickname = '微信用户') {
  return { user: { id, nickname, phone: '13800001234', currentCompanyId: '3' },
    company: { name: '测试企业', certificationStatus: 'VERIFIED', legalPerson: '企业法人' },
    member: { roleText: '业务员', realName: '其他企业成员' }, companies: [{ companyId: '3' }] };
}

function harness() {
  let page;
  const calls = [], navigations = [];
  const state = { payload: profile(), identity: { status: 'VERIFIED', statusText: '已认证', verifiedName: ' 张三 ' } };
  const app = { globalData: { token: 'session-7', currentCompanyId: '3', userInfo: { id: '7' } },
    applyMePayload: payload => {
      app.globalData.userInfo = payload.user;
      app.globalData.currentCompanyId = String(payload.user.currentCompanyId || '');
    } };
  const wx = { getStorageSync: () => '', navigateTo: options => navigations.push(options.url),
    stopPullDownRefresh() {} };
  state.request = async options => {
    if (options.url === '/me') return state.payload;
    if (options.url === '/fadada/users/me/identity') {
      if (state.identity instanceof Error) throw state.identity;
      return state.identity;
    }
    throw new Error(`Unexpected request ${options.url}`);
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../pages/me/me.js'), 'utf8'), {
    Page: definition => { page = definition; }, wx, getApp: () => app,
    require: id => {
      if (id.endsWith('/request')) return { request: options => { calls.push(options); return state.request(options); } };
      if (id.endsWith('/companyContext')) return require('../utils/companyContext');
      if (id.endsWith('/companyOnboarding')) return { loadSummary: async () => ({ hasOnboarding: false }) };
      if (id.endsWith('/dict')) return { certification: () => ({ text: '已认证' }) };
      if (id.endsWith('/tabBar')) return { syncTabBar() {} };
      throw new Error(`Unexpected require ${id}`);
    }
  });
  page.setData = patch => Object.assign(page.data, patch);
  return { page, app, wx, state, calls, navigations };
}

test('verified current personal name replaces the WeChat nickname and supplies the avatar initial', async () => {
  const { page, calls } = harness();
  await page.onShow();
  assert.equal(page.data.userDisplayName, '张三');
  assert.equal(page.data.userNameFirst, '张');
  assert.equal(page.data.realNameVerified, true);
  assert.equal(page.data.personalIdentityStatusText, '已认证');
  assert.equal(page.data.maskedPhone, '138****1234');
  assert.equal(page.data.user.nickname, '微信用户');
  const identityRead = calls.find(options => options.url === '/fadada/users/me/identity');
  assert.equal(identityRead.withCompany, false);
  assert.equal(identityRead.token, 'session-7');
});

for (const identity of [
  { status: 'IN_PROGRESS', verifiedName: '旧实名' },
  { status: 'FAILED', verifiedName: '旧实名' },
  { status: 'NOT_STARTED', verifiedName: '旧实名' },
  { status: 'VERIFIED', verifiedName: '  ' },
  new Error('offline')
]) {
  test(`unconfirmed or missing personal names keep the current nickname: ${identity.status || 'offline'}`, async () => {
    const { page, state } = harness();
    state.identity = identity;
    state.payload = profile('7', ' 小李 ');
    await page.onShow();
    assert.equal(page.data.userDisplayName, '小李');
    assert.equal(page.data.userNameFirst, '小');
    assert.notEqual(page.data.userDisplayName, '企业法人');
    assert.notEqual(page.data.userDisplayName, '其他企业成员');
  });
}

test('a missing nickname has a useful fallback and avatar initials retain complete Unicode characters', async () => {
  const { page, state } = harness();
  state.payload = profile('7', '  ');
  state.identity = { status: 'NOT_STARTED' };
  await page.onShow();
  assert.equal(page.data.userDisplayName, '用户');
  assert.equal(page.data.userNameFirst, '用');
  state.identity = { status: 'VERIFIED', verifiedName: '𠮷田' };
  await page.onShow();
  assert.equal(page.data.userNameFirst, '𠮷');
});

test('returning from personal certification refreshes the name without requiring login again', async () => {
  const { page, state, navigations } = harness();
  state.identity = { status: 'NOT_STARTED' };
  await page.onShow();
  assert.equal(page.data.userDisplayName, '微信用户');
  page.openPersonalInfo();
  assert.deepEqual(navigations, ['/pages/personal-cert/personal-cert']);
  state.identity = { status: 'VERIFIED', verifiedName: '张三' };
  await page.onShow();
  assert.equal(page.data.userDisplayName, '张三');
  assert.equal(page.data.userNameFirst, '张');
});

test('temporary identity failures retain a confirmed name only until a successful non-verified response', async () => {
  const { page, state } = harness();
  await page.onShow();
  state.identity = new Error('offline');
  await page.onShow();
  assert.equal(page.data.userDisplayName, '张三');
  assert.equal(page.data.realNameVerified, true);
  state.identity = { status: 'IN_PROGRESS', statusText: '认证中', verifiedName: '张三' };
  await page.onShow();
  assert.equal(page.data.userDisplayName, '微信用户');
  assert.equal(page.data.realNameVerified, false);
  state.identity = new Error('offline');
  await page.onShow();
  assert.equal(page.data.userDisplayName, '微信用户');
});

test('account switches clear the old name before loading and cannot reuse its verified cache', async () => {
  const { page, app, state } = harness();
  await page.onShow();
  const pendingProfile = deferred();
  app.globalData.token = 'session-8';
  app.globalData.userInfo = { id: '8' };
  state.request = options => options.url === '/me' ? pendingProfile.promise : Promise.reject(new Error('offline'));
  const pending = page.onShow();
  assert.equal(page.data.userDisplayName, '用户');
  assert.equal(page.data.userNameFirst, '用');
  assert.equal(page.data.realNameVerified, false);
  assert.equal(page.data.maskedPhone, '');
  pendingProfile.resolve(profile('8', '小王'));
  await pending;
  assert.equal(page.data.userDisplayName, '小王');
  assert.equal(page.data.userNameFirst, '小');
  assert.equal(page.data.realNameVerified, false);
});

test('a delayed old identity response cannot overwrite another account profile', async () => {
  const { page, app, state } = harness();
  const pendingIdentity = deferred();
  state.request = options => options.url === '/me' ? Promise.resolve(state.payload) : pendingIdentity.promise;
  const oldRead = page.onShow();
  await Promise.resolve();
  app.globalData.token = 'session-8';
  app.globalData.userInfo = { id: '8' };
  state.payload = profile('8', '小王');
  state.identity = { status: 'VERIFIED', verifiedName: '王五' };
  state.request = async options => options.url === '/me' ? state.payload : state.identity;
  await page.onShow();
  pendingIdentity.resolve({ status: 'VERIFIED', verifiedName: '张三' });
  await oldRead;
  assert.equal(page.data.userDisplayName, '王五');
  assert.equal(page.data.userNameFirst, '王');
  assert.equal(app.globalData.userInfo.id, '8');
});

test('same-session refresh races keep the latest successful personal identity', async () => {
  const { page, state } = harness();
  const pendingIdentity = deferred();
  state.request = options => options.url === '/me' ? Promise.resolve(state.payload) : pendingIdentity.promise;
  const oldRead = page.onShow();
  await Promise.resolve();
  state.request = async options => options.url === '/me' ? state.payload : { status: 'VERIFIED', verifiedName: '最新实名' };
  await page.onShow();
  pendingIdentity.resolve({ status: 'VERIFIED', verifiedName: '旧实名' });
  await oldRead;
  assert.equal(page.data.userDisplayName, '最新实名');
});

test('logout clears confirmed identity immediately and discards unfinished requests', async () => {
  const { page, app, state } = harness();
  await page.onShow();
  const pendingIdentity = deferred();
  state.request = options => options.url === '/me' ? Promise.resolve(state.payload) : pendingIdentity.promise;
  const pending = page.onShow();
  await Promise.resolve();
  app.globalData.token = '';
  app.globalData.userInfo = null;
  page.onShow();
  assert.equal(page.data.isLoggedIn, false);
  assert.equal(page.data.userDisplayName, '用户');
  assert.equal(page.data.realNameVerified, false);
  assert.equal(page._verifiedProfileIdentity, null);
  pendingIdentity.resolve({ status: 'VERIFIED', verifiedName: '张三' });
  await pending;
  assert.equal(page.data.userDisplayName, '用户');
});

test('unloaded pages ignore a pending personal identity response', async () => {
  const { page, state } = harness();
  const pendingIdentity = deferred();
  state.request = options => options.url === '/me' ? Promise.resolve(state.payload) : pendingIdentity.promise;
  const pending = page.onShow();
  await Promise.resolve();
  page.onUnload();
  pendingIdentity.resolve({ status: 'VERIFIED', verifiedName: '张三' });
  await pending;
  assert.equal(page.data.userDisplayName, '用户');
});
