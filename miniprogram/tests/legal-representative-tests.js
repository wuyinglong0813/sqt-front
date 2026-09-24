'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const source = fs.readFileSync(path.join(__dirname, '../pages/legal-representative/legal-representative.js'), 'utf8');

function fixture(responder) {
  const calls = [], navigations = [], modals = [];
  let profileLoads = 0, definition;
  const app = { globalData: { token: 'account-a' }, getCurrentCompanyId: () => '3', loadMe: async () => { profileLoads++; } };
  vm.runInNewContext(source, {
    Page: value => { definition = value; }, getApp: () => app,
    require: () => ({ request: options => { calls.push(options); return responder(options); } }),
    wx: { navigateTo: options => navigations.push(options.url), showModal: options => modals.push(options) }
  });
  const page = Object.assign({}, definition, { data: JSON.parse(JSON.stringify(definition.data)), setData(values) { Object.assign(this.data, values); } });
  page.onLoad({ companyId: '3' });
  return { page, app, calls, navigations, modals, profileLoads: () => profileLoads };
}

async function run() {
  let count = 0;
  {
    const f = fixture(async () => ({ status: 'VERIFIED', message: '本人法人核验已通过' }));
    await f.page.onShow();
    assert.strictEqual(f.calls[0].url, '/fadada/companies/3/legal-representative/sync');
    assert.strictEqual(f.page.data.verified, true);
    assert.strictEqual(f.profileLoads(), 1);
    await f.page.startVerification();
    assert.strictEqual(f.calls.length, 1);
    count++;
  }
  {
    const f = fixture(async () => ({ status: 'IN_PROGRESS', message: '认证经办人与当前账号不一致' }));
    await f.page.onShow();
    assert.strictEqual(f.page.data.verified, false);
    assert.strictEqual(f.profileLoads(), 0);
    assert.match(f.page.data.message, /不一致/);
    count++;
  }
  {
    const f = fixture(async () => ({ status: 'NOT_STARTED' }));
    await f.page.startVerification();
    assert.strictEqual(f.navigations.length, 0);
    f.modals[0].success({ confirm: true });
    assert.strictEqual(f.navigations[0], '/pages/personal-cert/personal-cert');
    count++;
  }
  {
    const f = fixture(async () => ({ status: 'VERIFIED' }));
    await f.page.startVerification();
    assert.strictEqual(f.navigations[0], '/pages/fadada-auth/fadada-auth?scene=legal&companyId=3');
    assert.strictEqual(f.page.data.verified, false, 'Personal verification does not confer legal status');
    count++;
  }
  {
    let finish;
    const f = fixture(() => new Promise(resolve => { finish = resolve; }));
    const pending = f.page.refreshStatus();
    f.app.globalData.token = 'account-b';
    finish({ status: 'VERIFIED' });
    await pending;
    assert.strictEqual(f.page.data.verified, false);
    assert.strictEqual(f.profileLoads(), 0);
    count++;
  }
  {
    let finish;
    const f = fixture(() => new Promise(resolve => { finish = resolve; }));
    const pending = f.page.startVerification();
    f.page.onUnload();
    finish({ status: 'VERIFIED' });
    await pending;
    assert.strictEqual(f.navigations.length, 0);
    count++;
  }
  {
    const f = fixture(async () => { throw new Error('本企业已有法人，请联系现法人'); });
    await f.page.onShow();
    assert.strictEqual(f.page.data.verified, false);
    assert.match(f.page.data.message, /已有法人/);
    assert.strictEqual(f.page.data.loading, false);
    count++;
  }
  console.log(`Legal representative flow: ${count} passed`);
}
run().catch(error => { console.error(error); process.exitCode = 1; });
