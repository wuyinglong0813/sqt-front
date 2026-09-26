'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function harness(platform = 'ios', local = false) {
  let app, page;
  const requests = [], toasts = [], sessions = [], modals = [], clipboard = [];
  const storage = {};
  const wx = {
    getSystemInfoSync: () => ({ platform }),
    getStorageSync: key => storage[key] || '',
    setStorageSync: (key, value) => { storage[key] = value; },
    removeStorageSync: key => { delete storage[key]; },
    login: options => options.success({ code: 'fresh-wechat-code' }),
    request: options => {
      requests.push(options);
      options.success({ statusCode: 200, data: { code: 0, data: { token: 'server-session' } } });
    },
    showLoading() {}, hideLoading() {}, switchTab() {},
    showToast: options => toasts.push(options.title),
    showModal: options => modals.push(options),
    setClipboardData: options => clipboard.push(options.data)
  };
  const modules = new Map();
  const root = path.join(__dirname, '..');
  function load(file) {
    const absolute = path.resolve(root, file);
    if (modules.has(absolute)) return modules.get(absolute).exports;
    const module = { exports: {} };
    modules.set(absolute, module);
    let source = fs.readFileSync(absolute, 'utf8');
    if (local && file === 'app.js') source = source.replace('USE_LOCAL_BACKEND = false', 'USE_LOCAL_BACKEND = true');
    vm.runInNewContext(source, {
      module, exports: module.exports, wx, getApp: () => app, setTimeout,
      App: value => { app = value; }, Page: value => { page = value; },
      require: id => load(path.relative(root, path.resolve(path.dirname(absolute), `${id}.js`)))
    }, { filename: absolute });
    return module.exports;
  }
  load('app.js');
  app.establishSession = async session => sessions.push(session);
  load('pages/login/login.js');
  page.setData = update => Object.assign(page.data, update);
  page.onLoad();
  page.data.agreed = true;
  return { app, page, wx, requests, toasts, sessions, modals, clipboard, load };
}

for (const platform of ['ios', 'android', 'windows', 'mac', 'devtools']) {
  test(`${platform} uses the server HTTPS gateway by default`, async () => {
    const env = harness(platform);
    assert.equal(env.app.globalData.baseUrl, 'https://sqt.org.cn/api');
    assert.equal(env.app.globalData.isLocalDevelopment, false);
    env.app.globalData.token = 'existing-session';
    env.app.globalData.currentCompanyId = 'company-12';
    await env.load('utils/request.js').request({ url: '/me' });
    const sent = env.requests[0];
    assert.equal(sent.url, 'https://sqt.org.cn/api/me');
    assert.equal(sent.header.Authorization, 'existing-session');
    assert.equal(sent.header['X-Company-Id'], 'company-12');
    assert.equal(sent.header['X-WX-SERVICE'], undefined);
  });
}

test('phone authorization sends distinct login and phone codes without an existing session', async () => {
  const env = harness();
  env.app.globalData.token = 'old-session';
  env.app.globalData.currentCompanyId = 'old-company';
  assert.equal(env.page.data.quickPhoneEnabled, true);
  await env.page.quickPhoneLogin({ detail: { errMsg: 'getPhoneNumber:ok', code: 'phone-code' } });
  const sent = env.requests[0];
  assert.equal(sent.url, 'https://sqt.org.cn/api/auth/wechat-login');
  assert.equal(sent.method, 'POST');
  assert.equal(sent.data.code, 'fresh-wechat-code');
  assert.equal(sent.data.phoneCode, 'phone-code');
  assert.equal(sent.header.Authorization, undefined);
  assert.equal(sent.header['X-Company-Id'], undefined);
  assert.equal(env.sessions[0].token, 'server-session');
});

for (const platform of ['windows', 'mac', 'devtools']) {
  test(`${platform} login obtains a real WeChat code instead of sending empty or simulated credentials`, async () => {
    const env = harness(platform);
    assert.equal(env.page.data.quickPhoneEnabled, false);
    await env.page.onWechatPhoneTap();
    assert.equal(env.requests[0].data.code, 'fresh-wechat-code');
    assert.equal(env.requests[0].data.phone, undefined);
    assert.equal(env.sessions.length, 1);
  });
}

test('app login also exchanges a fresh WeChat code', async () => {
  const env = harness();
  await env.app.doLogin();
  assert.equal(env.requests[0].data.code, 'fresh-wechat-code');
  assert.equal(env.sessions.length, 1);
});

test('failed or empty WeChat login prevents the backend request', async () => {
  for (const login of [options => options.fail({}), options => options.success({ code: '' })]) {
    const env = harness('windows');
    env.wx.login = login;
    await env.page.onWechatPhoneTap();
    assert.equal(env.requests.length, 0);
    assert.equal(env.sessions.length, 0);
    assert.match(env.modals[0].content, /失败步骤：微信登录/);
    assert.match(env.modals[0].content, /尚未向业务服务器/);
  }
});

test('phone authorization refusal does not attempt login', async () => {
  const env = harness();
  env.wx.login = () => assert.fail('must not exchange a code');
  await env.page.quickPhoneLogin({ detail: { errMsg: 'getPhoneNumber:fail user deny' } });
  assert.equal(env.requests.length, 0);
  assert.equal(env.modals.length, 0);
});

test('phone authorization failure exposes only error details and allows copying', async () => {
  const env = harness();
  env.wx.login = () => assert.fail('must not exchange a code');
  await env.page.quickPhoneLogin({ detail: {
    errMsg: 'getPhoneNumber:fail no permission', errCode: 1400001,
    code: 'private-phone-code', encryptedData: 'private-phone-data'
  } });
  assert.equal(env.requests.length, 0);
  const modal = env.modals[0];
  assert.match(modal.content, /失败步骤：手机号授权/);
  assert.match(modal.content, /getPhoneNumber:fail no permission/);
  assert.match(modal.content, /1400001/);
  assert.doesNotMatch(modal.content, /private-phone/);
  modal.success({ confirm: true });
  assert.equal(env.clipboard[0], modal.content);
});

test('missing phone code does not silently fall back to login without a phone', async () => {
  const env = harness();
  await env.page.quickPhoneLogin({ detail: { errMsg: 'getPhoneNumber:ok' } });
  assert.equal(env.requests.length, 0);
  assert.match(env.modals[0].content, /未返回手机号授权凭证/);
});

test('wx.login failure retains its original message and error code', async () => {
  const env = harness();
  env.wx.login = options => options.fail({ errMsg: 'login:fail test failure', errCode: 123 });
  await env.page.quickPhoneLogin({ detail: { errMsg: 'getPhoneNumber:ok', code: 'phone-code' } });
  assert.equal(env.requests.length, 0);
  assert.match(env.modals[0].content, /失败步骤：微信登录/);
  assert.match(env.modals[0].content, /login:fail test failure/);
  assert.match(env.modals[0].content, /123/);
});

test('backend transport failure is distinguished from phone authorization failure', async () => {
  const env = harness();
  env.wx.request = options => options.fail({ errMsg: 'request:fail test connection', errCode: 456 });
  await env.page.quickPhoneLogin({ detail: { errMsg: 'getPhoneNumber:ok', code: 'phone-code' } });
  assert.match(env.modals[0].content, /失败步骤：服务器登录/);
  assert.match(env.modals[0].content, /request:fail test connection/);
  assert.match(env.modals[0].content, /456/);
  assert.doesNotMatch(env.modals[0].content, /尚未向业务服务器/);
});

test('backend login rejection retains the server message and HTTP status', async () => {
  const env = harness();
  env.wx.reLaunch = () => assert.fail('a rejected login must not redirect away from its error');
  env.wx.request = options => options.success({ statusCode: 401,
    data: { code: 401, message: '微信凭证无效' } });
  await env.page.quickPhoneLogin({ detail: { errMsg: 'getPhoneNumber:ok', code: 'phone-code' } });
  assert.match(env.modals[0].content, /微信凭证无效/);
  assert.match(env.modals[0].content, /HTTP 状态：401/);
});

test('failure after token exchange identifies user information loading', async () => {
  const env = harness();
  env.app.establishSession = async () => { throw new Error('读取用户失败'); };
  await env.page.quickPhoneLogin({ detail: { errMsg: 'getPhoneNumber:ok', code: 'phone-code' } });
  assert.match(env.modals[0].content, /失败步骤：读取登录用户信息/);
  assert.match(env.modals[0].content, /读取用户失败/);
});

test('explicit local development retains simulated login only in developer tools', async () => {
  const env = harness('devtools', true);
  env.wx.login = () => assert.fail('local simulation should not call WeChat');
  await env.page.onWechatPhoneTap();
  assert.equal(env.requests[0].url, 'http://127.0.0.1:9999/api/auth/wechat-login');
  assert.equal(env.requests[0].data.code, 'dev-openid-001');
  const mobile = harness('ios', true);
  assert.equal(mobile.app.globalData.isLocalDevelopment, false);
  await mobile.load('utils/wechatLogin.js').wechatLogin({ code: 'dev-injected' });
  assert.equal(mobile.requests[0].data.code, 'fresh-wechat-code');
});
