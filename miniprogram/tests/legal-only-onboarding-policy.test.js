'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function harness(name, handler) {
  let page;
  const calls = [], navigation = [];
  const app = { globalData: { token: 'session' }, getCurrentCompanyId: () => '' };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../pages', name, `${name}.js`), 'utf8'), {
    Page: definition => { page = definition; }, getApp: () => app,
    wx: { redirectTo: options => navigation.push(options.url), showToast() {} },
    require: id => {
      if (id.endsWith('/request')) return { request: async options => { calls.push(options); return handler(options); } };
      if (id.endsWith('/companyOnboarding')) return {};
      throw new Error(id);
    }
  });
  page.setData = values => Object.assign(page.data, values);
  return { page, calls, navigation };
}

for (const name of ['company-bind', 'company-cert']) {
  test(`${name} uses only the server boolean for legal-only onboarding guidance`, async () => {
    let config = { legalOnlyOnboardingEnabled: true };
    const h = harness(name, async () => config);
    assert.equal(h.page.data.legalOnlyOnboardingEnabled, false);
    await h.page.loadOnboardingPolicy();
    assert.equal(h.page.data.legalOnlyOnboardingEnabled, true);
    assert.equal(h.calls[0].url, '/ca/config');
    assert.equal(h.calls[0].withCompany, false);
    for (const value of [false, undefined, 'true', 1]) {
      config = { legalOnlyOnboardingEnabled: value };
      await h.page.loadOnboardingPolicy();
      assert.equal(h.page.data.legalOnlyOnboardingEnabled, false);
    }
  });

  test(`${name} tolerates older servers and does not apply policy after unload`, async () => {
    const unavailable = harness(name, async () => { throw new Error('404'); });
    await unavailable.page.loadOnboardingPolicy();
    assert.equal(unavailable.page.data.legalOnlyOnboardingEnabled, false);
    let finish;
    const late = harness(name, () => new Promise(resolve => { finish = resolve; }));
    const loading = late.page.loadOnboardingPolicy();
    late.page.onUnload();
    finish({ legalOnlyOnboardingEnabled: true });
    await loading;
    assert.equal(late.page.data.legalOnlyOnboardingEnabled, false);
  });
}

test('legal-only guidance cannot promote a pending enterprise or reopen an existing company onboarding', async () => {
  let certificationStatus = 'PENDING_REVIEW';
  const h = harness('company-cert', async options => {
    if (options.url === '/ca/config') return { legalOnlyOnboardingEnabled: true };
    if (options.url === '/companies/9') return { id: '9', name: '企业', certificationStatus };
    return { status: 'IN_PROGRESS', enabled: true, companyAuthorizationReady: true,
      failureReason: '法人本人依据不足，请补充核验', enabledSealCount: 0 };
  });
  h.page.onLoad({ companyId: '9', autoSwitch: '1', legalOnlyOnboardingEnabled: 'false' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.page.data.legalOnlyOnboardingEnabled, true);
  assert.equal(h.page.data.companyVerified, false);
  assert.equal(h.page.data.actions[0].done, false);
  assert.equal(h.page.data.identity.failureReason, '法人本人依据不足，请补充核验');
  assert.equal(h.navigation.length, 0);
  certificationStatus = 'VERIFIED';
  await h.page.loadCompany(false);
  assert.equal(h.page.data.companyVerified, true, 'Existing formal companies use their normal authorization guidance');
  assert.equal(h.navigation.length, 0);
});

test('a verified current identity hides first-onboarding guidance even before the company profile refreshes', async () => {
  const h = harness('company-cert', async options => options.url === '/companies/9'
    ? { id: '9', name: '企业', certificationStatus: 'PENDING_REVIEW' }
    : { status: 'VERIFIED', enabled: true, enabledSealCount: 0 });
  h.page.data.companyId = '9';
  await h.page.loadCompany(false);
  assert.equal(h.page.data.companyVerified, true);
  assert.equal(h.page.data.actions[0].done, true);
});
