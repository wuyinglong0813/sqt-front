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
    requirePrivacyAuthorize: o => o.success(),
    showModal: o => o.success({ confirm: true }),
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
      if (name.endsWith('/privacy')) return require('./privacy-fixture')(wx, () => app);
      if (name.endsWith('/request')) return { request: async o => { calls.push(o); return handler(o); } };
      if (name.endsWith('/companyContext')) return require('../utils/companyContext');
      if (name.endsWith('/signingContinuation')) return require('../utils/signingContinuation');
      if (name.endsWith('/companyOnboarding')) return { returnToCompany: o => navigation.push(`company:${o.companyId || 'draft'}`) };
      throw Error(name);
    }
  };
  function page(file) {
    let result;
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'),
      { ...runtime, Page: p => { result = p; } });
    result.setData = (values, done) => { Object.assign(result.data, values); if (done) done(); };
    return result;
  }
  return { page, app, wx, calls, navigation, timers,
    advance: ms => { now += ms; }, entry: value => { entry = value; }, stack: value => { stack = value; },
    tick: async () => {
      const [key, timer] = [...timers.entries()].sort((a, b) => a[1].delay - b[1].delay)[0];
      timers.delete(key); await timer.fn();
    } };
}
const authFile = 'pages/fadada-auth/fadada-auth.js';
const returnFile = 'pages/service-return/service-return.js';
const bridgeFile = 'pagesFace/pages/middle/middle.js';
const webViewEvent = generation => ({ currentTarget: { dataset: { generation } } });

test('a provider page with no load event stops at a bounded actionable error', async () => {
  const h = harness(() => ({ url: 'https://auth.fadada.com/company-form' }));
  const p = h.page(authFile); p._visible = true;
  p.data.scene = 'company'; p.data.options = { companyId: '9' };
  await p.loadServiceUrl();
  const timeout = [...h.timers.values()].find(timer => timer.delay === 30000);
  h.advance(30000); await timeout.fn();
  assert.match(p.data.errorMessage, /连接超时/);
  assert.equal(p.pollTimer, null);
  assert.equal(h.navigation.length, 0);
  assert.equal(h.calls.length, 1);
});

test('a loaded provider form has no later automatic load timeout or reload', async () => {
  const h = harness(() => ({ url: 'https://auth.fadada.com/company-form' }));
  const p = h.page(authFile); p._visible = true;
  p.data.scene = 'company'; p.data.options = { companyId: '9' };
  await p.loadServiceUrl();
  const timeout = [...h.timers.values()].find(timer => timer.delay === 30000);
  p.onWebViewLoad(webViewEvent(p.data.webViewGeneration));
  h.advance(60000); await timeout.fn();
  assert.equal(p.data.errorMessage, '');
  assert.equal(p.webViewLoadTimer, null);
  assert.equal(h.navigation.length, 0);
  assert.equal(h.calls.length, 1);
  p.onUnload();
});

test('provider load timeout pauses while hidden and resumes its remaining visible time', () => {
  const h = harness(); const p = h.page(authFile); p._visible = true; p.data.loading = false;
  p.mountServiceUrl('https://auth.fadada.com/company-form');
  const initial = [...h.timers.values()][0];
  h.advance(10000); p.onHide();
  assert.equal(h.timers.size, 0);
  h.advance(60000); initial.fn();
  assert.equal(p.data.errorMessage, '');
  p.onShow();
  assert.equal([...h.timers.values()].find(timer => timer.delay === 20000).delay, 20000);
  p.onUnload();
  assert.equal(h.timers.size, 0);
});

test('manual provider-load retry recreates the same URL without issuing another enrollment', async () => {
  const h = harness(() => ({ url: 'https://auth.fadada.com/company-form?ticket=original' }));
  const p = h.page(authFile); p._visible = true;
  p.data.scene = 'company'; p.data.options = { companyId: '9' };
  await p.loadServiceUrl();
  const generation = p.data.webViewGeneration;
  p.onWebViewError(webViewEvent(generation));
  assert.match(p.data.errorMessage, /暂时无法打开/);
  p.retry();
  assert.equal(p.data.serviceUrl, 'https://auth.fadada.com/company-form?ticket=original');
  assert.ok(p.data.webViewGeneration > generation);
  assert.equal(p.data.errorMessage, '');
  assert.equal(h.calls.length, 1);
  p.onUnload();
});

test('queued double taps during asynchronous container removal cannot issue another enrollment', async () => {
  const h = harness(() => ({ url: 'https://auth.fadada.com/company-form?ticket=original' }));
  const p = h.page(authFile); p._visible = true;
  p.data.scene = 'company'; p.data.options = { companyId: '9' };
  await p.loadServiceUrl();
  p.onWebViewError(webViewEvent(p.data.webViewGeneration));
  const renderingCallbacks = [];
  p.setData = (values, done) => {
    Object.assign(p.data, values);
    if (done) renderingCallbacks.push(done);
  };
  p.retry();
  assert.equal(p.data.serviceUrl, '');
  assert.equal(renderingCallbacks.length, 1);
  p.retry();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.calls.length, 1);
  assert.equal(renderingCallbacks.length, 1);
  assert.equal(p._preparing, undefined);
  renderingCallbacks[0]();
  assert.equal(p.data.serviceUrl, 'https://auth.fadada.com/company-form?ticket=original');
  assert.equal(p.data.loading, false);
  assert.equal(p._reloadingWebView, false);
  assert.equal(h.calls.length, 1);
  p.onUnload();
});

test('late old-container load, error and timeout events cannot affect a remounted page', () => {
  const h = harness(); const p = h.page(authFile); p._visible = true; p.data.loading = false;
  p.mountServiceUrl('https://auth.fadada.com/company-form');
  const oldGeneration = p.data.webViewGeneration;
  const oldTimeout = [...h.timers.values()][0];
  p.onWebViewError(webViewEvent(oldGeneration)); p.retry();
  const currentTimer = p.webViewLoadTimer;
  p.onWebViewLoad(webViewEvent(oldGeneration));
  p.onWebViewError(webViewEvent(oldGeneration)); oldTimeout.fn();
  assert.equal(p.data.errorMessage, '');
  assert.equal(p.webViewLoadTimer, currentTimer);
  assert.equal(p._webViewSession.loaded, false);
  p.onUnload();
});

for (const changed of ['session', 'company', 'unload']) {
  test(`provider callbacks and load timeout ignore ${changed} changes`, () => {
    const h = harness(); const p = h.page(authFile); p._visible = true; p.data.loading = false;
    p.mountServiceUrl('https://auth.fadada.com/company-form');
    const generation = p.data.webViewGeneration;
    const timeout = [...h.timers.values()][0];
    if (changed === 'session') h.app.globalData.token = 'another-session';
    else if (changed === 'company') h.app.globalData.currentCompanyId = 'another-company';
    else p.onUnload();
    p.onWebViewLoad(webViewEvent(generation));
    p.onWebViewError(webViewEvent(generation)); timeout.fn();
    assert.equal(p.data.errorMessage, '');
    assert.equal(p._webViewSession.loaded, false);
    assert.equal(h.navigation.length, 0);
    p.onUnload();
  });
}

test('a failed result-page redirect displays recovery instead of an empty provider URL', async () => {
  const h = harness(() => ({ status: 'IN_PROGRESS' }));
  h.wx.redirectTo = o => o.fail();
  const p = h.page(authFile); p.data.scene = 'company'; p.data.options = { companyId: '9' };
  await p.loadServiceUrl();
  assert.equal(p.data.loading, false);
  assert.equal(p.data.serviceUrl, '');
  assert.match(p.data.errorMessage, /刷新认证结果/);
  assert.equal(h.calls.length, 1);
});

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
  test(`${scene} success confirms server state and immediately continues`, async () => {
    const h = harness(() => ({ status: 'VERIFIED' })); const p = h.page(returnFile);
    p.data.options = { scene, companyId: '9' };
    await p.syncResult();
    if (scene === 'company') assert.equal(h.app.company, '9');
    assert.equal(h.timers.size, 0);
    assert.equal(h.navigation[0], scene === 'company' ? '/pages/company/company' : '/pages/index/index');
  });
}

test('personal success during enterprise onboarding immediately continues the draft', async () => {
  const h = harness(() => ({ status: 'VERIFIED' })); const p = h.page(returnFile);
  p.data.options = { scene: 'personal', flow: 'company-create' };
  await p.syncResult(); assert.equal(h.timers.size, 0);
  assert.deepEqual(h.navigation, ['company:draft']);
});

test('pending result or failed company switch never starts success countdown', async () => {
  for (const status of ['IN_PROGRESS', 'FAILED', 'VERIFIED']) {
    const h = harness(() => ({ status })); const p = h.page(returnFile);
    h.app.switchCompany = async () => { throw Error('not ready'); };
    p.data.options = { scene: 'company', companyId: '9' }; p._syncAttempts = 24; await p.syncResult();
    assert.equal(p.data.failed, true); assert.equal(h.timers.size, 0); assert.equal(h.navigation.length, 0);
  }
});

for (const scene of ['personal', 'company']) {
  test(`${scene} completion while hidden waits for visibility and respects session changes`, async () => {
    for (const changed of [false, true]) {
      let resolve;
      const h = harness(() => new Promise(r => { resolve = r; }));
      const p = h.page(returnFile); p.data.options = { scene, companyId: '9' };
      const syncing = p.syncResult(); p.onHide();
      resolve({ status: 'VERIFIED' }); await syncing;
      assert.equal(h.navigation.length, 0); assert.equal(h.timers.size, 0);
      if (changed) h.app.globalData.token = 'different';
      p.onShow();
      assert.equal(h.navigation.length, changed ? 0 : 1);
      p.onShow(); assert.equal(h.navigation.length, changed ? 0 : 1);
    }
  });
}

function faceHarness() {
  const h = harness(); const parent = h.page(authFile);
  parent.route = 'pages/fadada-auth/fadada-auth'; parent.data.serviceUrl = 'https://auth.fadada.com/start';
  parent._sessionToken = h.app.globalData.token;
  parent.onHide();
  const p = h.page(bridgeFile); h.stack([parent, p]);
  const options = { bizToken: 'token%2B1', miniProgramAppId: 'wx1234567890abcdef',
    miniProgramPath: encodeURIComponent('pages/face/index?source=fdd'),
    miniProgramCallBackUrl: encodeURIComponent('https://auth.fadada.com/result'), isRedirect: 'true' };
  p.onLoad(options); return { h, parent, p, options };
}

test('official bridge restores the callback in a fresh visible page without recreating enrollment', () => {
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, '../app.json')));
  assert.ok(config.subPackages.some(p => p.root === 'pagesFace' && p.pages.includes('pages/middle/middle')));
  const { h, p, parent } = faceHarness(); assert.equal(p.data.ready, true);
  p.onJump(); assert.match(h.calls[0].path, /\?source=fdd&bizToken=token%2B1$/);
  h.entry({ scene: 1038, referrerInfo: { appId: 'wx1234567890abcdef', extraData: { faceResult: { code: 0 } } } });
  p.onShow(); assert.deepEqual(h.navigation, [1]);
  // No hidden web-view src toggle: wx may batch all hidden setData calls together.
  assert.equal(parent.data.serviceUrl, 'https://auth.fadada.com/start');
  assert.equal(h.timers.size, 0);
  parent.onShow();
  const redirect = new URL(h.navigation[1], 'https://example.test');
  assert.equal(redirect.pathname, '/pages/fadada-auth/fadada-auth');
  assert.equal(redirect.searchParams.has('url'), false);
  const restored = h.page(authFile);
  restored.onLoad({ faceReturnId: redirect.searchParams.get('faceReturnId') });
  assert.equal(restored.data.serviceUrl, 'https://auth.fadada.com/result');
  assert.equal(restored.data.loading, false);
  assert.equal(h.timers.size, 2); // Initial web-view load timeout plus server-status polling.
  assert.equal(h.app._fadadaFaceReturn, undefined);
  assert.equal(h.calls.filter(o => o.url).length, 0);
  p.onJump(); p.onShow(); parent.onShow();
  assert.equal(h.calls.filter(o => o.appId).length, 1);
  assert.equal(h.navigation.length, 2);
});

for (const scene of ['personal', 'company', 'legal', 'contract']) {
  test(`face return preserves ${scene} context and its result still comes from the backend`, async () => {
    const { h, parent, p } = faceHarness();
    parent.data.scene = scene;
    parent.data.options = { scene, flow: 'company-create', companyId: '9007199254740993', contractId: '17' };
    p.onJump();
    h.entry({ scene: 1038, referrerInfo: { appId: 'wx1234567890abcdef', extraData: { faceResult: true } } });
    p.onShow(); parent.onShow();
    const id = h.app._fadadaFaceReturn.id;
    const restored = h.page(authFile); restored.onLoad({ faceReturnId: id });
    assert.equal(restored.data.scene, scene);
    assert.equal(restored.data.options.companyId, '9007199254740993');
    assert.equal(restored.data.options.contractId, '17');
    assert.equal(restored.data.options.flow, 'company-create');
    assert.equal(h.calls.filter(o => o.url).length, 0);
    if (['personal', 'company', 'legal'].includes(scene)) {
      await h.tick();
      assert.equal(h.navigation.length, 2); // IN_PROGRESS remains pending after a successful face return.
    }
    const replay = h.page(authFile); replay.onLoad({ faceReturnId: id });
    assert.equal(replay.data.serviceUrl, '');
    assert.match(replay.data.errorMessage, /失效/);
    assert.equal(h.calls.filter(o => o.url && o.url.endsWith('/auth-url')).length, 0);
  });
}

for (const changed of ['session', 'company']) {
  test(`a changed ${changed} cannot restore an old face session`, () => {
    const { h, parent, p } = faceHarness();
    p.onJump();
    h.entry({ scene: 1038, referrerInfo: { appId: 'wx1234567890abcdef', extraData: { faceResult: true } } });
    p.onShow(); parent.onShow();
    const id = h.app._fadadaFaceReturn.id;
    if (changed === 'session') h.app.globalData.token = 'new-session';
    else h.app.globalData.currentCompanyId = 'different-company';
    const restored = h.page(authFile); restored.onLoad({ faceReturnId: id });
    assert.equal(restored.data.serviceUrl, '');
    assert.match(restored.data.errorMessage, /失效/);
    assert.equal(h.app._fadadaFaceReturn, undefined);
    assert.equal(h.calls.filter(o => o.url).length, 0);
  });
}

test('the restored face callback is rechecked against the original provider host before mounting', () => {
  const { h, parent, p } = faceHarness();
  p.onJump();
  h.entry({ scene: 1038, referrerInfo: { appId: 'wx1234567890abcdef', extraData: { faceResult: true } } });
  p.onShow(); parent.onShow();
  const id = h.app._fadadaFaceReturn.id;
  h.app._fadadaFaceReturn.url = 'https://foreign.test/result';
  const restored = h.page(authFile); restored.onLoad({ faceReturnId: id });
  assert.equal(restored.data.serviceUrl, '');
  assert.match(restored.data.errorMessage, /地址无效/);
  assert.equal(h.calls.filter(o => o.url).length, 0);
});

test('face return redirect failure leaves a result recovery action and clears the handoff', () => {
  const { h, parent, p } = faceHarness();
  h.wx.redirectTo = o => o.fail();
  p.onJump();
  h.entry({ scene: 1038, referrerInfo: { appId: 'wx1234567890abcdef', extraData: { faceResult: true } } });
  p.onShow(); parent.onShow();
  assert.equal(h.app._fadadaFaceReturn, undefined);
  assert.match(parent.data.errorMessage, /刷新认证结果/);
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

test('reusable company authorization keeps missing applicant evidence in a native review state', async () => {
  const message = '企业已有有效授权，尚需核对当前本人企业身份';
  const h = harness(options => options.url.endsWith('/auth-url')
    ? { url: null, scene: 'company', status: 'IDENTITY_VERIFICATION_REQUIRED' }
    : { status: 'IN_PROGRESS', failureReason: message });
  const p = h.page(authFile); p.data.scene = 'company'; p.data.options = { companyId: '9' };
  await p.loadServiceUrl();
  assert.equal(p.data.serviceUrl, '');
  assert.equal(p.data.serviceResultReady, false);
  assert.equal(p.data.preparationAction, 'identityReview');
  assert.equal(p.data.preparationCanProceed, false);
  assert.equal(p.data.preparationTitle, '企业已授权，待核对本人身份');
  assert.equal(p.data.preparationMessage, message);
  assert.equal(h.navigation.length, 0);
  assert.equal(h.app.company, undefined);
  assert.equal(h.timers.size, 0);
  h.wx.navigateTo = options => h.navigation.push(options.url);
  p.openIdentitySupport();
  assert.deepEqual(h.navigation, ['/pages/help-center/help-center']);
});

test('first company onboarding checks reusable company consent before separate identity polling', async () => {
  const h = harness(options => options.url.endsWith('/auth-url')
    ? { url: null, scene: 'company', status: 'IDENTITY_VERIFICATION_REQUIRED' }
    : { status: 'IN_PROGRESS', companyAuthorizationReady: false, failureReason: '企业已有有效授权，本人身份待核对' });
  const p = h.page(authFile); p.data.scene = 'company';
  p.data.options = { companyId: '9', onboarding: '1' };
  await p.prepareService();
  assert.deepEqual(h.calls.map(call => call.url), [
    '/fadada/companies/9/auth-url', '/fadada/companies/9/identity'
  ]);
  assert.equal(p.data.preparationAction, 'identityReview');
  assert.equal(p.data.serviceUrl, '');
  assert.equal(h.app.company, undefined);
  assert.equal(h.timers.size, 0);
});

test('first company onboarding reuses sufficient consent and applicant evidence without a provider page', async () => {
  const h = harness(() => ({ url: null, status: 'VERIFIED' }));
  const p = h.page(authFile); p.data.scene = 'company';
  p.data.options = { companyId: '9', onboarding: '1' };
  await p.prepareService();
  assert.deepEqual(h.calls.map(call => call.url), ['/fadada/companies/9/auth-url']);
  assert.deepEqual(h.navigation, ['/pages/service-return/service-return?scene=company&companyId=9']);
  assert.equal(p.data.serviceUrl, '');
  assert.equal(h.timers.size, 0);
});

test('a company identity detail outage cannot turn the review state into a new authorization page', async () => {
  const h = harness(options => {
    if (options.url.endsWith('/auth-url')) return { url: null, status: 'IDENTITY_VERIFICATION_REQUIRED' };
    throw new Error('status temporarily unavailable');
  });
  const p = h.page(authFile); p.data.scene = 'company'; p.data.options = { companyId: '9' };
  await p.loadServiceUrl();
  assert.equal(p.data.preparationAction, 'identityReview');
  assert.match(p.data.preparationMessage, /已有有效授权已确认/);
  assert.equal(p.data.errorMessage, '');
  assert.equal(p.data.serviceUrl, '');
  assert.equal(h.navigation.length, 0);
  assert.equal(h.calls.filter(call => call.url.endsWith('/auth-url')).length, 1);
});

test('an explicit identity recheck continues after the server confirms the applicant evidence', async () => {
  let verified = false;
  const h = harness(options => options.url.endsWith('/auth-url')
    ? { url: null, status: 'IDENTITY_VERIFICATION_REQUIRED' }
    : { status: verified ? 'VERIFIED' : 'IN_PROGRESS' });
  const p = h.page(authFile); p.data.scene = 'company'; p.data.options = { companyId: '9' };
  await p.loadServiceUrl();
  verified = true;
  await p.continueSigningPreparation();
  assert.deepEqual(h.navigation, ['/pages/service-return/service-return?scene=company&companyId=9']);
  assert.equal(h.calls.filter(call => call.url.endsWith('/auth-url')).length, 1);
  assert.equal(h.timers.size, 0);
});

test('a session change while reading applicant evidence cannot expose the old review state', async () => {
  let finish;
  const h = harness(options => options.url.endsWith('/auth-url')
    ? { url: null, status: 'IDENTITY_VERIFICATION_REQUIRED' }
    : new Promise(resolve => { finish = resolve; }));
  const p = h.page(authFile); p._sessionToken = 'session';
  p.data.scene = 'company'; p.data.options = { companyId: '9' };
  const pending = p.loadServiceUrl();
  while (!finish) await Promise.resolve();
  h.app.globalData.token = 'new-session';
  finish({ status: 'IN_PROGRESS', failureReason: 'old company evidence' });
  await pending;
  assert.equal(p.data.preparationAction, '');
  assert.equal(h.navigation.length, 0);
  h.wx.navigateTo = () => assert.fail('a stale session cannot open the identity support action');
  p.openIdentitySupport();
});

for (const sameSession of [true, false]) {
  test(`native personal redirect restores only the current session company flow: ${sameSession}`, async () => {
    const h = harness(() => ({ status: 'VERIFIED' })); const p = h.page(returnFile);
    h.stack([{ route: 'pages/personal-cert/personal-cert', _companyFlow: true,
      _flowToken: sameSession ? 'session' : 'old-session', _returnOptions: { companyId: '9007199254740993' } }, p]);
    p.syncResult = () => {};
    p.onLoad({ scene: 'personal', authResult: 'success' });
    assert.equal(p.data.options.flow, sameSession ? 'company-create' : undefined);
    if (sameSession) assert.equal(p.data.options.companyId, '9007199254740993');
  });
}

test('pending company evidence preserves the form and is shown only after an explicit result check', async () => {
  const h = harness(() => ({ status: 'IN_PROGRESS', failureReason: '尚未返回经办人身份' }));
  const auth = h.page(authFile); auth.data.scene = 'company'; auth.data.options = { companyId: '9' };
  await auth.pollStatus();
  assert.equal(h.navigation.length, 0);
  auth.checkResult();
  assert.equal(h.navigation[0], '/pages/service-return/service-return?scene=company&companyId=9');
  const result = h.page(returnFile); result.data.options = { scene: 'company', companyId: '9' };
  await result.syncResult();
  assert.equal(result.data.failed, true); assert.equal(result.data.message, '尚未返回经办人身份');
  assert.equal(h.app.company, undefined); assert.equal(h.timers.size, 0);
});

test('a legal identity requiring review returns without requesting a new authentication URL', async () => {
  const h = harness(() => ({ status: 'REVIEW_REQUIRED', message: '需补充核验' }));
  const p = h.page(authFile); p.data.scene = 'legal'; p.data.options = { companyId: '9' };
  await p.prepareService();
  assert.deepEqual(h.calls.map(call => call.url), ['/fadada/companies/9/legal-representative/sync']);
  assert.deepEqual(h.navigation, ['/pages/service-return/service-return?scene=legal&companyId=9']);
  assert.equal(h.timers.size, 0);
});

test('a legal identity requiring review stops provider polling and guides the user to the saved records', async () => {
  const h = harness(() => ({ status: 'REVIEW_REQUIRED', message: '企业管理员身份已确认，请联系平台支持补充法人核验' }));
  const p = h.page(authFile); p.data.scene = 'legal'; p.data.options = { companyId: '9' };
  p.startStatusPolling(); await h.tick();
  assert.equal(h.timers.size, 0);
  assert.deepEqual(h.navigation, ['/pages/service-return/service-return?scene=legal&companyId=9']);
  const result = h.page(returnFile); result.data.options = { scene: 'legal', companyId: '9' };
  await result.syncResult();
  assert.equal(result.data.loading, false);
  assert.equal(result.data.reviewRequired, true);
  assert.equal(result.data.title, '需补充法人身份核验');
  assert.match(result.data.message, /平台支持/);
  assert.equal(h.timers.size, 0);
  result.onShow();
  assert.equal(h.timers.size, 0);
  result.goBusinessPage();
  assert.equal(h.navigation[1], '/pages/legal-representative/legal-representative?companyId=9');
});

test('native redirect waits for a delayed callback then immediately continues', async () => {
  let status = 'IN_PROGRESS';
  const h = harness(() => ({ status })); const p = h.page(returnFile);
  p.data.options = { scene: 'company', companyId: '9', authResult: 'success' };
  await p.syncResult();
  assert.equal(p.data.loading, true); assert.equal(h.app.company, undefined);
  status = 'VERIFIED'; await h.tick(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.app.company, '9'); assert.equal(p.data.countdown, 1);
  assert.deepEqual(h.navigation, ['/pages/company/company']);
    assert.equal(h.timers.size, 0);
});

test('pending callback wait is bounded and pauses while hidden', async () => {
  const h = harness(); const p = h.page(returnFile); p.data.options = { scene: 'personal' };
  await p.syncResult(); p.onHide(); assert.equal(h.timers.size, 0);
  p.onShow(); assert.equal(h.timers.size, 1);
  p._syncAttempts = 24; await p.syncResult();
  assert.equal(p.data.failed, true); assert.equal(h.timers.size, 0); assert.equal(h.navigation.length, 0);
});

for (const failureReason of ['尚未查询到个人授权，请完成认证页面的全部步骤后再刷新', '认证查询过于频繁，请稍后再刷新']) {
  test(`personal success survives a cached provider-query error: ${failureReason}`, async () => {
    let elapsed = 0;
    const h = harness(() => elapsed < 32500
      ? { status: 'IN_PROGRESS', failureReason } : { status: 'VERIFIED' });
    const p = h.page(returnFile); p.data.options = { scene: 'personal', flow: 'company-create' };
    await p.syncResult();
    for (let i = 0; i < 13; i++) {
      assert.equal(p.data.loading, true); assert.equal(p.data.failed, false);
      assert.equal(h.navigation.length, 0);
      elapsed += 2500; h.advance(2500); await h.tick();
    }
    assert.equal(p.data.title, '个人认证成功'); assert.equal(p.data.countdown, 1);
    assert.deepEqual(h.navigation, ['company:draft']);
    assert.equal(h.timers.size, 0);
    assert.equal(h.calls.filter(o => o.url.endsWith('/auth-url')).length, 0);
  });
}

test('unresolved personal authorization stops with actionable text and manual retry starts a fresh wait', async () => {
  const h = harness(() => ({ status: 'IN_PROGRESS',
    failureReason: '尚未查询到个人授权，请完成认证页面的全部步骤后再刷新' }));
  const p = h.page(returnFile); p.data.options = { scene: 'personal' };
  await p.syncResult();
  for (let i = 0; i < 24; i++) await h.tick();
  assert.equal(h.timers.size, 0); assert.equal(p.data.failed, true);
  assert.match(p.data.message, /无需反复提交认证/); assert.equal(h.navigation.length, 0);
  await p.retrySync();
  assert.equal(p.data.loading, true); assert.equal(p.data.failed, false);
  assert.equal(h.timers.size, 1);
});

test('personal terminal failure is never retried even with a transient-looking reason', async () => {
  const h = harness(() => ({ status: 'FAILED', failureReason: '认证查询过于频繁，请稍后再刷新' }));
  const p = h.page(returnFile); p.data.options = { scene: 'personal' };
  await p.syncResult();
  assert.equal(p.data.failed, true); assert.equal(h.timers.size, 0); assert.equal(h.navigation.length, 0);
});

const companyQueryPending = [
  '尚未查询到当前企业的授权记录，请稍后刷新；如已开通，请联系管理员核对授权关联',
  '认证查询过于频繁，请至少等待30秒后刷新'
];

for (const failureReason of companyQueryPending) {
  test(`company confirmation waits through cached provider-query errors: ${failureReason}`, async () => {
    let elapsed = 0;
    const h = harness(() => elapsed < 32500
      ? { status: 'IN_PROGRESS', failureReason } : { status: 'VERIFIED' });
    const p = h.page(returnFile);
    p.data.options = { scene: 'company', companyId: '9007199254740993', authResult: 'success' };
    await p.syncResult();
    for (let i = 0; i < 13; i++) {
      assert.equal(p.data.loading, true); assert.equal(p.data.failed, false);
      assert.equal(h.app.company, undefined); assert.equal(h.navigation.length, 0);
      elapsed += 2500; h.advance(2500); await h.tick();
    }
    assert.equal(p.data.title, '企业认证成功');
    assert.equal(h.app.company, '9007199254740993');
    assert.deepEqual(h.navigation, ['/pages/company/company']);
    assert.equal(h.timers.size, 0);
    assert.ok(h.calls.every(o => !o.url.endsWith('/auth-url')));
  });
}

test('unresolved company authorization has a bounded wait and can resume manually', async () => {
  const h = harness(() => ({ status: 'IN_PROGRESS', failureReason: companyQueryPending[0] }));
  const p = h.page(returnFile); p.data.options = { scene: 'company', companyId: '9' };
  await p.syncResult();
  p.onHide(); assert.equal(h.timers.size, 0);
  p.onShow(); assert.equal(h.timers.size, 1);
  for (let i = 0; i < 24; i++) await h.tick();
  assert.equal(h.timers.size, 0); assert.equal(p.data.failed, true);
  assert.match(p.data.message, /企业授权结果仍未同步/);
  assert.equal(h.app.company, undefined); assert.equal(h.navigation.length, 0);
  await p.retrySync();
  assert.equal(p.data.loading, true); assert.equal(p.data.failed, false);
  h.app.globalData.token = 'another-session'; await h.tick();
  assert.equal(h.timers.size, 0); assert.equal(h.app.company, undefined);
});

for (const result of [
  { status: 'FAILED', failureReason: companyQueryPending[0] },
  { status: 'IN_PROGRESS', failureReason: '企业实名已通过，但经办人标识与当前账号的个人实名标识不一致' }
]) {
  test(`company verification failures still stop confirmation: ${result.failureReason}`, async () => {
    const h = harness(() => result); const p = h.page(returnFile);
    p.data.options = { scene: 'company', companyId: '9', authResult: 'success' };
    await p.syncResult();
    assert.equal(p.data.failed, true); assert.equal(p.data.message, result.failureReason);
    assert.equal(h.timers.size, 0); assert.equal(h.app.company, undefined);
    assert.equal(h.navigation.length, 0);
  });
}

for (const status of ['IN_PROGRESS', 'VERIFIED']) {
  test(`personal auth response with nested identity ${status} returns to server confirmation`, async () => {
    const h = harness(() => ({ authUrl: null, identity: { status } }));
    const p = h.page(authFile); p.data.scene = 'personal';
    p.data.options = { flow: 'company-create' };
    await p.loadServiceUrl();
    assert.equal(p.data.errorMessage, '');
    assert.equal(h.navigation[0], '/pages/service-return/service-return?scene=personal&flow=company-create');
    assert.equal(h.calls.length, 1);
  });
}

for (const failureReason of [
  '尚未查询到当前企业的授权记录，请稍后刷新；如已开通，请联系管理员核对授权关联',
  '认证查询过于频繁，请至少等待30秒后刷新',
  '企业实名已通过，但经办人标识与当前账号的个人实名标识不一致'
]) {
  test(`pending company query cannot interrupt provider input: ${failureReason}`, async () => {
    const h = harness(() => ({ status: 'IN_PROGRESS', failureReason }));
    const p = h.page(authFile); p.data.scene = 'company'; p.data.options = { companyId: '9' };
    p.data.serviceUrl = 'https://auth.fadada.com/company-form';
    p.startStatusPolling();
    for (let i = 0; i < 4; i++) { h.advance(31000); await h.tick(); }
    assert.equal(h.navigation.length, 0);
    assert.equal(p.data.serviceUrl, 'https://auth.fadada.com/company-form');
    assert.ok(h.calls.every(o => !o.url.endsWith('/auth-url')));
    p.onHide(); assert.equal(h.timers.size, 0);
    p.onShow(); await h.tick();
    assert.equal(h.navigation.length, 0);
    assert.equal(p.data.serviceUrl, 'https://auth.fadada.com/company-form');
  });
}

test('desktop signing opens the provider page directly', async () => {
  const h = harness(() => ({ url: 'https://80005620.uat-e.fadada.com/connect?ticket=one-time' }));
  const p = h.page(authFile);
  p.data.scene = 'contract';
  p.data.options = { contractId: '12' };
  await p.loadServiceUrl();
  assert.equal(p.data.serviceUrl, 'https://80005620.uat-e.fadada.com/connect?ticket=one-time');
  assert.equal(p.data.serviceHost, '80005620.uat-e.fadada.com');
});

test('desktop signing widens a narrow window and restores it on leave', () => {
  const h = harness();
  h.app.globalData.isDesktopWechat = true;
  const sizes = [];
  let width = 420;
  h.wx.getWindowInfo = () => ({ windowWidth: width, windowHeight: 700, screenWidth: 1440, screenHeight: 900 });
  h.wx.setWindowSize = options => { sizes.push({ width: options.width, height: options.height }); if (options.complete) options.complete(); };
  const p = h.page(authFile);
  p.onLoad({ scene: 'contract', contractId: '12' });
  assert.equal(sizes[0].width, 1280);
  assert.equal(sizes[0].height, 700);
  width = 1280;
  p.onResize();
  assert.equal(sizes.length, 1);
  p.onUnload();
  assert.equal(sizes[1].width, 420);
  assert.equal(sizes[1].height, 700);
});

for (const finalStatus of ['VERIFIED', 'FAILED']) {
  test(`long-running company input stays open beyond polling limit and still handles ${finalStatus}`, async () => {
    let status = 'IN_PROGRESS';
    const h = harness(() => ({ status })); const p = h.page(authFile);
    p.data.scene = 'company'; p.data.options = { companyId: '9' }; p.pollAttempts = 119;
    await p.pollStatus();
    assert.equal(h.navigation.length, 0);
    assert.equal(p.pollAttempts, 120);
    assert.equal([...h.timers.values()][0].delay, 10000);
    await h.tick(); assert.equal(h.navigation.length, 0);
    assert.equal(p.pollAttempts, 120);
    status = finalStatus; await h.tick();
    assert.equal(h.navigation[0], '/pages/service-return/service-return?scene=company&companyId=9');
    assert.equal(h.timers.size, 0);
  });
}


test('legacy abolish callback directs the user to local contract handling without provider synchronization', async () => {
  const h = harness(() => { throw Error('Provider synchronization is retired for local void'); });
  const p = h.page(returnFile); p.data.options = { scene: 'abolish', contractId: '12' };
  await p.syncResult();
  assert.equal(p.data.loading, false);
  assert.equal(p.data.failed, false);
  assert.equal(p.data.title, '合同作废流程已更新');
  assert.match(p.data.message, /返回合同详情/);
  assert.equal(h.calls.length, 0);
  assert.equal(p._awaitingResult, false);
  p.goBusinessPage();
  assert.equal(h.navigation[0], '/pages/contract-preview/contract-preview?contractId=12');
});
