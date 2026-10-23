'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const companyId = '9007199254740993';
const claimUrl = `/pages/legal-representative/legal-representative?companyId=${companyId}&claim=1`;
const personalUrl = `/pages/personal-cert/personal-cert?flow=legal-claim&companyId=${companyId}`;

function harness(handler = async () => ({ status: 'VERIFIED' })) {
  const calls = [], navigation = [], switches = [];
  let stack = [], profileLoads = 0;
  const app = {
    globalData: { token: 'claimant-session', currentCompanyId: '', userInfo: { id: '7' }, memberInfo: null },
    getCurrentCompanyId: () => app.globalData.currentCompanyId,
    loadMe: async () => { profileLoads++; },
    switchCompany: async id => { switches.push(id); app.globalData.currentCompanyId = id; }
  };
  const wx = { navigateTo: o => navigation.push(o.url), redirectTo: o => navigation.push(o.url),
    switchTab: o => navigation.push(o.url), showToast() {}, setNavigationBarTitle() {} };
  function page(name) {
    let result;
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../pages', name, `${name}.js`), 'utf8'), {
      Page: value => { result = value; }, wx, getApp: () => app, getCurrentPages: () => stack,
      setTimeout: () => 1, clearTimeout() {},
      require: id => {
        if (id.endsWith('/request')) return { request: async o => { calls.push(o); return handler(o); } };
        if (id.endsWith('/companyContext')) return require('../utils/companyContext');
        if (id.endsWith('/signingContinuation')) return require('../utils/signingContinuation');
        if (id.endsWith('/companyOnboarding')) return { returnToCompany() { throw Error('Legal claim must not create a new enterprise'); } };
        if (id.endsWith('/privacy')) return {};
        throw Error(id);
      }
    });
    result.setData = values => Object.assign(result.data, values);
    result.route = `pages/${name}/${name}`;
    return result;
  }
  return { app, wx, page, calls, navigation, switches, stack: value => { stack = value; },
    profileLoads: () => profileLoads, settled: () => new Promise(resolve => setImmediate(resolve)) };
}

test('a personally verified non-member can claim legal identity before entering the company', async () => {
  const h = harness(async o => o.url.endsWith('/legal-representative/sync')
    ? { status: 'VERIFIED', message: '本人法人身份已确认' } : { status: 'VERIFIED' });
  const p = h.page('legal-representative');
  p.onLoad({ companyId, claim: '1' });
  await p.onShow();
  assert.equal(h.app.globalData.memberInfo, null, 'The flow does not require an existing membership');
  assert.deepEqual(h.calls.map(o => o.url), ['/fadada/users/me/identity', `/fadada/companies/${companyId}/legal-representative/sync`]);
  assert.ok(h.calls.every(o => o.withCompany === false));
  assert.equal(p.data.verified, true);
  assert.equal(h.profileLoads(), 1);
  assert.equal(h.switches.length, 0, 'Identity confirmation precedes the explicit company switch');
  await p.enterClaimedCompany();
  assert.deepEqual(h.switches, [companyId]);
  assert.deepEqual(h.navigation, ['/pages/company/company']);
});

test('an unverified non-member is sent to personal certification with the exact target company', async () => {
  const h = harness(async () => ({ status: 'NOT_STARTED' }));
  const p = h.page('legal-representative');
  p.onLoad({ companyId, claim: '1' });
  await p.onShow();
  assert.equal(p.data.needsPersonalIdentity, true);
  assert.equal(h.calls.length, 1, 'A missing personal identity must not invoke the legal claim yet');
  assert.equal(h.profileLoads(), 0);
  p.openPersonalIdentity();
  p.openPersonalIdentity();
  assert.deepEqual(h.navigation, [personalUrl]);
});

test('insufficient legal evidence remains pending and never launches a fictitious face flow', async () => {
  const message = '尚未确认本人法人身份，请补充核验依据';
  const h = harness(async o => o.url.endsWith('/legal-representative/sync')
    ? { status: 'REVIEW_REQUIRED', message } : { status: 'VERIFIED' });
  const p = h.page('legal-representative');
  p.onLoad({ companyId, claim: '1' });
  await p.onShow();
  assert.equal(p.data.verified, false);
  assert.equal(p.data.reviewRequired, true);
  assert.equal(p.data.message, message);
  assert.equal(h.profileLoads(), 0);
  await p.enterClaimedCompany();
  assert.equal(h.switches.length, 0);
  assert.equal(h.navigation.length, 0);
  assert.ok(h.calls.every(o => !o.url.endsWith('/auth-url')));
  p.openSupport();
  assert.deepEqual(h.navigation, ['/pages/help-center/help-center']);
});

for (const exit of ['logout', 'unload']) {
  test(`a delayed personal prerequisite after ${exit} cannot continue a legal claim`, async () => {
    let finish;
    const h = harness(() => new Promise(resolve => { finish = resolve; }));
    const p = h.page('legal-representative');
    p.onLoad({ companyId, claim: '1' });
    const pending = p.onShow();
    if (exit === 'logout') h.app.globalData.token = 'different-session';
    else p.onUnload();
    finish({ status: 'VERIFIED' });
    await pending;
    assert.equal(h.calls.length, 1);
    assert.equal(p.data.verified, false);
    assert.equal(h.profileLoads(), 0);
  });
}

test('personal certification keeps legal claim context while opening the provider and returning', async () => {
  let verified = false;
  const h = harness(async o => o.url === '/me' ? { user: { id: '7', phone: '18800000000' } }
    : { status: verified ? 'VERIFIED' : 'NOT_STARTED', providerEnabled: true });
  const p = h.page('personal-cert');
  p.onLoad({ flow: 'legal-claim', companyId });
  await h.settled();
  p.startAuth();
  assert.deepEqual(h.navigation, [`/pages/fadada-auth/fadada-auth?scene=personal&flow=legal-claim&companyId=${companyId}`]);
  verified = true;
  await p.loadIdentity(true);
  assert.equal(h.navigation.at(-1), claimUrl);
  assert.equal(h.switches.length, 0, 'Personal verification alone does not confer enterprise membership');
});

test('the native personal return recovers the legal claim from the authenticated source page', async () => {
  const h = harness();
  const p = h.page('service-return');
  h.stack([{ route: 'pages/personal-cert/personal-cert', _legalClaimCompanyId: companyId,
    _flowToken: h.app.globalData.token }, p]);
  p.onLoad({ scene: 'personal' });
  await h.settled();
  assert.equal(p.data.options.flow, 'legal-claim');
  assert.equal(p.data.options.companyId, companyId);
  assert.deepEqual(h.navigation, [claimUrl]);
  assert.equal(h.switches.length, 0);
});

test('a failed personal return preserves the legal claim target for retry', () => {
  const h = harness();
  const p = h.page('service-return');
  p.data.options = { scene: 'personal', flow: 'legal-claim', companyId };
  p.data.loading = false;
  p.data.failed = true;
  p.goBusinessPage();
  assert.deepEqual(h.navigation, [personalUrl]);
});

test('the web-view personal return preserves legal claim context without relying on the old page stack', () => {
  const h = harness();
  const p = h.page('fadada-auth');
  p._visible = true;
  p.data.scene = 'personal';
  p.data.options = { flow: 'legal-claim', companyId };
  p.openReturnPage();
  assert.deepEqual(h.navigation, [`/pages/service-return/service-return?scene=personal&flow=legal-claim&companyId=${companyId}`]);
});
