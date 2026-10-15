'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const source = fs.readFileSync(path.join(__dirname, '../pages/legal-representative/legal-representative.js'), 'utf8');

function fixture(responder) {
  const calls = [], navigations = [];
  let profileLoads = 0, definition;
  const app = { globalData: { token: 'account-a' }, getCurrentCompanyId: () => '3', loadMe: async () => { profileLoads++; } };
  vm.runInNewContext(source, {
    Page: value => { definition = value; }, getApp: () => app,
    require: () => ({ request: options => { calls.push(options); return responder(options); } }),
    wx: { navigateTo: options => navigations.push(options.url) }
  });
  const page = Object.assign({}, definition, { data: JSON.parse(JSON.stringify(definition.data)), setData(values) { Object.assign(this.data, values); } });
  page.onLoad({ companyId: '3' });
  return { page, app, calls, navigations, profileLoads: () => profileLoads };
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
    const f = fixture(async () => ({ status: 'IN_PROGRESS', message: '尚未确认法人身份，请联系平台支持人工核验' }));
    await f.page.startVerification();
    assert.strictEqual(f.navigations.length, 0);
    assert.strictEqual(f.calls[0].url, '/fadada/companies/3/legal-representative/sync');
    assert.strictEqual(f.calls.length, 1);
    assert.strictEqual(f.page.data.verified, false, 'An unconfirmed identity never confers legal status');
    assert.strictEqual(f.profileLoads(), 0);
    count++;
  }
  {
    const message = '当前账号企业管理员身份已确认，尚无可确认的本人法人身份关联，请联系平台支持人工核验';
    const f = fixture(async () => ({ status: 'REVIEW_REQUIRED', message }));
    await f.page.onShow();
    assert.strictEqual(f.page.data.reviewRequired, true);
    assert.strictEqual(f.page.data.messageTitle, '需补充法人身份核验');
    assert.strictEqual(f.page.data.message, message);
    await f.page.startVerification();
    assert.strictEqual(f.page.data.verified, false, 'An administrator needing review is not a verified legal representative');
    assert.strictEqual(f.profileLoads(), 0);
    assert.ok(f.calls.every(options => options.url.endsWith('/legal-representative/sync')));
    f.page.openSupport();
    assert.strictEqual(f.navigations[0], '/pages/help-center/help-center');
    f.app.globalData.token = 'account-b';
    f.page.openSupport();
    assert.strictEqual(f.navigations.length, 1);
    count++;
  }
  {
    const f = fixture(async () => ({ status: 'REVIEW_REQUIRED', message: '请人工核验' }));
    await f.page.onShow();
    await f.page.refreshStatus();
    await f.page.startVerification();
    assert.deepStrictEqual(f.calls.map(options => options.url), Array(3).fill('/fadada/companies/3/legal-representative/sync'),
      'Opening, refreshing and manually checking records must only synchronize existing evidence');
    assert.ok(f.calls.every(options => options.method === 'POST' && options.withCompany === false));
    assert.strictEqual(f.profileLoads(), 0);
    count++;
  }
  {
    const f = fixture(async () => ({ status: 'VERIFIED', message: '法人身份已确认' }));
    await f.page.startVerification();
    assert.strictEqual(f.calls.length, 1);
    assert.strictEqual(f.calls[0].url, '/fadada/companies/3/legal-representative/sync');
    assert.strictEqual(f.page.data.verified, true);
    assert.strictEqual(f.profileLoads(), 1);
    assert.strictEqual(f.navigations.length, 0);
    await f.page.startVerification();
    assert.strictEqual(f.calls.length, 1, 'A confirmed identity is not checked again by double taps');
    count++;
  }
  {
    const message = '已有法人身份记录暂时无法读取，请稍后刷新；仍未恢复时联系平台支持';
    const f = fixture(async () => { throw new Error(message); });
    await f.page.startVerification();
    assert.strictEqual(f.page.data.message, message, 'The full failure reason stays visible');
    assert.strictEqual(f.page.data.verified, false);
    assert.strictEqual(f.page.data.loading, false);
    assert.strictEqual(f.profileLoads(), 0);
    await f.page.refreshStatus();
    assert.strictEqual(f.calls.length, 2);
    assert.ok(f.calls.every(options => options.url.endsWith('/legal-representative/sync')));
    count++;
  }
  {
    let finish;
    const f = fixture(() => new Promise(resolve => { finish = resolve; }));
    const pending = f.page.startVerification();
    await f.page.startVerification();
    assert.strictEqual(f.calls.length, 1, 'Double taps cannot start overlapping record checks');
    finish({ status: 'VERIFIED' });
    await pending;
    assert.strictEqual(f.page.data.verified, true);
    assert.strictEqual(f.profileLoads(), 1);
    count++;
  }
  for (const exit of ['logout', 'unload']) {
    let finish;
    const f = fixture(() => new Promise(resolve => { finish = resolve; }));
    const pending = f.page.startVerification();
    if (exit === 'logout') f.app.globalData.token = 'account-b';
    else f.page.onUnload();
    finish({ status: 'VERIFIED' });
    await pending;
    assert.strictEqual(f.calls.length, 1);
    assert.strictEqual(f.page.data.verified, false, 'An old session response must not confirm the current identity');
    assert.strictEqual(f.profileLoads(), 0);
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
    const f = fixture(async () => { throw new Error('本企业已有法人，请联系现法人'); });
    await f.page.onShow();
    assert.strictEqual(f.page.data.verified, false);
    assert.match(f.page.data.message, /已有法人/);
    assert.strictEqual(f.page.data.loading, false);
    count++;
  }
  console.log('Legal representative flow: ' + count + ' passed');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
