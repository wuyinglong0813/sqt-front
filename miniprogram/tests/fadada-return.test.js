'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function harness(handler = async () => ({ status: 'IN_PROGRESS' })) {
  const calls = [], navigation = [], timers = new Map();
  const app = { globalData: { token: 'session' }, switchCompany: async id => { app.company = id; } };
  let id = 0, now = 100000, entry = {}, stack = [];
  const wx = {
    redirectTo: o => navigation.push(o.url), switchTab: o => navigation.push(o.url),
    navigateBack: o => navigation.push(o.delta), getEnterOptionsSync: () => entry,
    setNavigationBarTitle() {},
    navigateToMiniProgram: o => { calls.push(o); o.success(); }
  };
  const runtime = { wx, getApp: () => app, getCurrentPages: () => stack,
    Date: { now: () => now },
    setTimeout: (fn, delay) => { timers.set(++id, { fn, delay }); return id; },
    clearTimeout: key => timers.delete(key),
    require: name => {
      if (name.endsWith('/request')) return { request: async o => { calls.push(o); return handler(o); } };
      if (name.endsWith('/companyOnboarding')) return { returnToCompany: o => navigation.push(`company:${o.companyId || 'draft'}`) };
      throw Error(name);
    }
  };
  function page(file) {
    let result;
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'),
      { ...runtime, Page: p => { result = p; } });
    result.setData = values => Object.assign(result.data, values);
    return result;
  }
  return { page, app, wx, calls, navigation, timers,
    advance: ms => { now += ms; }, entry: value => { entry = value; }, stack: value => { stack = value; },
    tick: async () => { const [key, timer] = timers.entries().next().value; timers.delete(key); await timer.fn(); } };
}
const authFile = 'pages/fadada-auth/fadada-auth.js';
const returnFile = 'pages/service-return/service-return.js';
const bridgeFile = 'pagesFace/pages/middle/middle.js';

test('personal authentication recovers a missing callback, throttles provider reads and retains company flow', async () => {
  let status = 'IN_PROGRESS';
  const h = harness(o => ({ status: o.method === 'POST' ? status : 'IN_PROGRESS' }));
  const p = h.page(authFile); p.data.options = { flow: 'company-create', companyId: '9' };
  await p.pollStatus(); await p.pollStatus();
  assert.equal(h.calls.filter(o => o.method === 'POST').length, 1);
  assert.equal(h.navigation.length, 0);
  h.advance(31000); status = 'VERIFIED'; await p.pollStatus();
  assert.equal(h.calls.filter(o => o.method === 'POST').length, 2);
  assert.equal(h.navigation[0], '/pages/service-return/service-return?scene=personal&flow=company-create&companyId=9');
});

for (const scene of ['personal', 'company']) {
  test(`opening completed ${scene} auth checks status without generating another enrollment URL`, async () => {
    const h = harness(() => ({ status: 'VERIFIED' })); const p = h.page(authFile);
    p.data.scene = scene; p.data.options = { companyId: '9' };
    await p.prepareService();
    assert.equal(h.calls.length, 1);
    assert.ok(!h.calls[0].url.endsWith('/auth-url'));
    assert.ok(h.navigation[0].includes(`scene=${scene}`));
  });
}

for (const scene of ['personal', 'company']) {
  test(`${scene} success confirms server state then waits five seconds before home`, async () => {
    const h = harness(() => ({ status: 'VERIFIED' })); const p = h.page(returnFile);
    p.data.options = { scene, companyId: '9' };
    await p.syncResult();
    if (scene === 'company') assert.equal(h.app.company, '9');
    assert.equal(p.data.countdown, 5); assert.equal(h.navigation.length, 0);
    for (let i = 0; i < 4; i++) await h.tick();
    assert.equal(h.navigation.length, 0); assert.equal(p.data.countdown, 1);
    await h.tick(); assert.equal(h.navigation[0], '/pages/index/index');
  });
}

test('personal success during enterprise onboarding continues the draft after countdown', async () => {
  const h = harness(() => ({ status: 'VERIFIED' })); const p = h.page(returnFile);
  p.data.options = { scene: 'personal', flow: 'company-create' };
  await p.syncResult(); for (let i = 0; i < 5; i++) await h.tick();
  assert.deepEqual(h.navigation, ['company:draft']);
});

test('pending result or failed company switch never starts success countdown', async () => {
  for (const status of ['IN_PROGRESS', 'FAILED', 'VERIFIED']) {
    const h = harness(() => ({ status })); const p = h.page(returnFile);
    h.app.switchCompany = async () => { throw Error('not ready'); };
    p.data.options = { scene: 'company', companyId: '9' }; await p.syncResult();
    assert.equal(p.data.failed, true); assert.equal(h.timers.size, 0); assert.equal(h.navigation.length, 0);
  }
});

test('countdown pauses when hidden and never navigates after session changes', async () => {
  const h = harness(() => ({ status: 'VERIFIED' })); const p = h.page(returnFile);
  p.data.options = { scene: 'personal' }; await p.syncResult();
  p.onHide(); assert.equal(h.timers.size, 0); p.onShow(); assert.equal(h.timers.size, 1);
  h.app.globalData.token = 'different'; await h.tick(); assert.equal(h.navigation.length, 0);
});

function faceHarness() {
  const h = harness(); const parent = h.page(authFile);
  parent.route = 'pages/fadada-auth/fadada-auth'; parent.data.serviceUrl = 'https://auth.fadada.com/start';
  const p = h.page(bridgeFile); h.stack([parent, p]);
  const options = { bizToken: 'token%2B1', miniProgramAppId: 'wx1234567890abcdef',
    miniProgramPath: encodeURIComponent('pages/face/index?source=fdd'),
    miniProgramCallBackUrl: encodeURIComponent('https://auth.fadada.com/result'), isRedirect: 'true' };
  p.onLoad(options); return { h, parent, p, options };
}

test('official bridge route is registered and loads the provider return URL without recreating enrollment', async () => {
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, '../app.json')));
  assert.ok(config.subPackages.some(p => p.root === 'pagesFace' && p.pages.includes('pages/middle/middle')));
  const { h, p, parent } = faceHarness(); assert.equal(p.data.ready, true);
  p.onJump(); assert.match(h.calls[0].path, /\?source=fdd&bizToken=token%2B1$/);
  h.entry({ scene: 1038, referrerInfo: { appId: 'wx1234567890abcdef', extraData: { faceResult: { code: 0 } } } });
  p.onShow(); assert.deepEqual(h.navigation, [1]); await h.tick();
  assert.equal(parent.data.serviceUrl, 'https://auth.fadada.com/result');
  assert.equal(h.calls.filter(o => o.url).length, 0);
});

for (const reason of ['cancel', 'wrong-app', 'new-session']) {
  test(`bridge ${reason} cannot claim verification success`, () => {
    const { h, p, parent } = faceHarness(); p.onJump();
    h.entry({ scene: 1038, referrerInfo: { appId: reason === 'wrong-app' ? 'wx0000000000000000' : 'wx1234567890abcdef',
      extraData: reason === 'cancel' ? {} : { faceResult: true } } });
    if (reason === 'new-session') h.app.globalData.token = 'different';
    p.onShow(); assert.equal(h.navigation.length, 0); assert.equal(parent.data.serviceUrl, 'https://auth.fadada.com/start');
  });
}

test('bridge rejects foreign or non-HTTPS callback addresses', () => {
  for (const url of ['http://auth.fadada.com/result', 'https://evil.test/result', 'https://auth.fadada.com@evil.test/']) {
    const { p, options } = faceHarness(); p.onLoad({ ...options, miniProgramCallBackUrl: encodeURIComponent(url) });
    assert.equal(p.data.ready, false);
  }
});


test('already-authorized backend response opens result confirmation without a new provider page', async () => {
  const h = harness(() => ({ url: null, scene: 'company', status: 'IN_PROGRESS' }));
  const p = h.page(authFile); p.data.scene = 'company'; p.data.options = { companyId: '9' };
  await p.loadServiceUrl();
  assert.equal(p.data.errorMessage, '');
  assert.equal(h.navigation[0], '/pages/service-return/service-return?scene=company&companyId=9');
});
