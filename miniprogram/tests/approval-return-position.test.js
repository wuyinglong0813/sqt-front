const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function harness() {
  let page;
  const reads = [], scrolls = [];
  const app = { globalData: { companies: [] }, companyId: '3', getCurrentCompanyId() { return this.companyId; } };
  const source = path.join(__dirname, '../pages/contract-approval/contract-approval.js');
  vm.runInNewContext(fs.readFileSync(source, 'utf8'), {
    Page: definition => { page = definition; }, getApp: () => app,
    wx: { nextTick: callback => callback(), pageScrollTo: value => scrolls.push(value), showToast() {} },
    require: id => id.endsWith('/request') ? { request: options => new Promise(resolve => reads.push({ ...options, resolve })) }
      : id.endsWith('/fileTransfer') ? {} : require(path.resolve(path.dirname(source), id))
  });
  page.setData = (values, callback) => { Object.assign(page.data, values); if (callback) callback(); };
  const resolveBatch = (start, results = []) => {
    reads[start].resolve([]); reads[start + 1].resolve([]); reads[start + 2].resolve(results);
  };
  return { page, app, reads, scrolls, resolveBatch };
}
const result = { id: '1', resultType: 'SALES_ORDER', sourceId: '31', sourceCompanyId: '4', sourceCompanyName: '客户', resultStatus: 'APPROVED' };

test('return keeps the current list and filters while refreshing then restores its scroll position', async () => {
  const env = harness();
  const first = env.page.onShow(); env.resolveBatch(0, [result]); await first;
  env.page.data.activeSection = 'RESULT'; env.page.rebuildGroups(false);
  env.page.data.selectedCompanyId = '4'; env.page.rebuildGroups(false);
  env.page.onPageScroll({ scrollTop: 1480 }); env.page.onHide();
  const returning = env.page.onShow();
  assert.equal(env.page.data.visibleGroups.length, 1);
  assert.equal(env.page.data.loading, true);
  env.resolveBatch(3, [{ ...result, isRead: true }]); await returning;
  assert.equal(env.page.data.activeSection, 'RESULT');
  assert.equal(env.page.data.selectedCompanyId, '4');
  assert.equal(env.scrolls.at(-1).scrollTop, 1480);
  assert.equal(env.page.data.results[0].isRead, true);
});

test('a previous company response cannot replace the new company or restore its scroll', async () => {
  const env = harness();
  const old = env.page.onShow(); env.page.onPageScroll({ scrollTop: 900 }); env.page.onHide();
  env.app.companyId = '5'; const current = env.page.onShow();
  env.resolveBatch(3); await current;
  env.resolveBatch(0, [result]); await old;
  assert.equal(env.page.data.results.length, 0);
  assert.equal(env.scrolls.length, 0);
  assert.equal(env.page.data.loading, false);
});

test('returning to a company cannot revive scroll restoration from an older visit', async () => {
  const env = harness();
  const first = env.page.onShow(); env.resolveBatch(0); await first;
  env.page.onPageScroll({ scrollTop: 1200 }); env.page.onHide();
  const oldA = env.page.onShow();
  env.page.onHide(); env.app.companyId = '5'; const companyB = env.page.onShow();
  env.page.onHide(); env.app.companyId = '3'; const newA = env.page.onShow();
  env.resolveBatch(9); await newA;
  env.resolveBatch(3); await oldA;
  env.resolveBatch(6); await companyB;
  assert.equal(env.scrolls.length, 0);
});

test('refreshing never removes an existing list from the rendered page', () => {
  const source = fs.readFileSync(path.join(__dirname, '../pages/contract-approval/contract-approval.wxml'), 'utf8');
  assert.ok(source.includes('class="approval-groups" wx:if="{{visibleGroups.length > 0}}"'));
});
