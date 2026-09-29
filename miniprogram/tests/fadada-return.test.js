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
