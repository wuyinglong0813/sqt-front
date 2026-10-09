'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const contexts = require('../utils/companyContext');
const presentation = require('../utils/membership');

function fixture(handler, confirm = true) {
  const app = { globalData: { token: 'token', currentCompanyId: 'A' } };
  const calls = [], modals = [];
  const wx = { showModal(o) { modals.push(o); o.success({ confirm }); }, setNavigationBarTitle() {} };
  const page = file => {
    let definition;
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), {
      getApp: () => app, wx, setTimeout, clearTimeout,
      require(name) {
        if (name.endsWith('/request')) return { request: async options => { calls.push(options); return handler(options); } };
        if (name.endsWith('/companyContext')) return contexts;
        if (name.endsWith('/membership')) return presentation;
        throw new Error(name);
      },
      Page(value) { definition = value; }
    });
    definition.setData = update => Object.assign(definition.data, update);
    return definition;
  };
  return { app, calls, modals, page };
}
test('unlimited and blocked membership states are unambiguous', () => {
  assert.equal(presentation.presentMembership({ unlimited: true, vip: true }).quotaText, '不限份数');
  assert.equal(presentation.presentMembership({ signingMode: 'BLOCKED', remaining: 20 }).quotaText, '暂停新发起');
  assert.match(presentation.presentMembership({ validUntil: '2026-11-08 23:59:59' }).validityText, /北京时间/);
});
test('membership response from an old company cannot replace the current company', async () => {
  let finish;
  const slow = new Promise(resolve => { finish = resolve; });
  const env = fixture(options => options.url === '/membership' ? slow : Promise.resolve([]));
  const page = env.page('pages/membership/membership.js');
  const pending = page.loadMembership();
  env.app.globalData.currentCompanyId = 'B'; env.app._companyAccessGeneration = 1;
  finish({ companyId: 'A', membershipText: 'A 的权益' });
  await pending;
  assert.equal(page.data.status, null);
});
test('cancelled signature confirmation never creates a provider task', async () => {
  const env = fixture(() => ({ canSign: true, newTask: true, message: '使用专属额度 1 份' }), false);
  const page = env.page('pages/fadada-auth/fadada-auth.js');
  page.data.scene = 'contract'; page.data.options = { contractId: '12' };
  await page.prepareService();
  assert.equal(env.calls.length, 1);
  assert.equal(env.modals.length, 1);
  assert.match(page.data.errorMessage, /取消/);
});
test('blocked enterprise cannot call sign-url even if user tries the signing page', async () => {
  const env = fixture(() => ({ canSign: false, newTask: true, message: '当前企业暂停新发起' }));
  const page = env.page('pages/fadada-auth/fadada-auth.js');
  page.data.scene = 'contract'; page.data.options = { contractId: '12' };
  await page.prepareService();
  assert.equal(env.calls.length, 1); assert.equal(env.modals.length, 0);
  assert.match(page.data.errorMessage, /暂停/);
});
test('recipient and existing tasks skip debit confirmation and continue signing', async () => {
  const env = fixture(options => options.url.endsWith('/quote')
    ? { canSign: true, newTask: false, message: '接收方免费' } : { url: 'https://example.test/sign' });
  const page = env.page('pages/fadada-auth/fadada-auth.js');
  page.data.scene = 'contract'; page.data.options = { contractId: '12' };
  await page.prepareService();
  assert.equal(env.modals.length, 0);
  assert.equal(env.calls.at(-1).url, '/contracts/12/sign-url');
  assert.equal(page.data.serviceUrl, 'https://example.test/sign');
});
test('switching companies while confirming cannot issue sign-url for the new company', async () => {
  const env = fixture(async () => {
    env.app.globalData.currentCompanyId = 'B';
    return { canSign: true, newTask: true, message: '使用额度' };
  });
  const page = env.page('pages/fadada-auth/fadada-auth.js');
  page.data.scene = 'contract'; page.data.options = { contractId: '12' };
  await page.prepareService();
  assert.equal(env.calls.length, 1); assert.equal(env.modals.length, 0);
});
