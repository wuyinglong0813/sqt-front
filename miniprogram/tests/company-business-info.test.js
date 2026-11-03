'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function harness() {
  const store = new Map(), calls = [], toasts = [], navigations = [];
  const app = { globalData: { token: 'session-7', currentCompanyId: '3', userInfo: { id: '7' } } };
  const wx = { getStorageSync: key => store.get(key), setStorageSync: (key, value) => store.set(key, value),
    removeStorageSync: key => store.delete(key), showToast: value => toasts.push(value), navigateTo: options => navigations.push(options.url) };
  const state = { handler: async () => ({}) };
  const request = async options => { calls.push(options); return state.handler(options); };
  const exports = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../utils/companyOnboarding.js'), 'utf8'), {
    getApp: () => app, wx, module: exports,
    require: id => id.endsWith('/homeSnapshot') ? { USER_ID_KEY: 'userId' } : { request }
  });
  const drafts = exports.exports;
  function page(name) {
    let definition;
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../pages', name, `${name}.js`), 'utf8'), {
      Page: value => { definition = value; }, getApp: () => app, wx,
      require: id => {
        if (id.endsWith('/request')) return { request };
        if (id.endsWith('/companyOnboarding')) return drafts;
        if (id.endsWith('/companyContext')) return require('../utils/companyContext');
        if (id.endsWith('/dict')) return { certification: () => ({ text: '已认证' }) };
        throw new Error(id);
      }
    });
    definition.setData = values => Object.assign(definition.data, values);
    return definition;
  }
  return { app, state, page, drafts, calls, toasts, navigations };
}

const details = { registeredAddress: '河北省测试路 1 号', contactPhone: '0311-12345678',
  bankName: '测试银行营业部', bankAccount: '001234567890123456' };

const companyFields = { companyName: '测试企业', creditCode: '91130100MA12345678', legalPersonName: '张三' };
const input = (page, field, value) => page.onCompanyInput({ currentTarget: { dataset: { field } }, detail: { value } });
const confirmationOptions = url => Object.fromEntries(
  [...new URL(url, 'https://example.test').searchParams].map(([key, value]) => [key, encodeURIComponent(value)])
);

test('entry details pass through read-only confirmation and personal authentication to company creation', async () => {
  const h = harness();
  const entry = h.page('company-bind');
  for (const [field, value] of Object.entries({ ...companyFields, ...details })) input(entry, field, value);
  entry.continueCreate();
  assert.equal(h.navigations.length, 1);
  const options = confirmationOptions(h.navigations[0]);
  assert.deepEqual(Object.keys(options).sort(), ['creditCode', 'legalPersonName', 'name']);
  assert.ok(!h.navigations[0].includes(details.bankAccount), 'Bank information stays out of navigation URLs');
  const confirmation = h.page('company-cert');
  confirmation.loadOnboardingPolicy = () => {};
  confirmation.onLoad(options);
  for (const [field, value] of Object.entries(details)) assert.equal(confirmation.data[field], value);
  assert.equal(confirmation.onBusinessInfoInput, undefined, 'Confirmation does not own a second editable form');
  confirmation.toggleAgree();
  const resumed = h.page('company-cert');
  resumed.loadOnboardingPolicy = () => {};
  resumed.onLoad({ resume: '1' });
  h.state.handler = async options => options.url.endsWith('/identity') ? { status: 'VERIFIED' }
    : options.url === '/companies' ? { id: '3', name: companyFields.companyName,
      creditCode: companyFields.creditCode, legalPersonName: companyFields.legalPersonName, ...details } : {};
  resumed.loadCompany = () => {};
  resumed.openService = () => {};
  await resumed.createAndAuthenticate(true);
  const created = h.calls.find(options => options.url === '/companies');
  for (const [field, value] of Object.entries(details)) assert.equal(created.data[field], value);
  assert.equal(created.data.bankAccount[0], '0', 'Accounts retain leading zeroes');
  assert.equal(h.drafts.readDraft(), null, 'Successful creation clears the local draft');
});

test('entry requires an address and allows an empty phone, bank and account', () => {
  const h = harness();
  const entry = h.page('company-bind');
  entry.setData({ ...companyFields, registeredAddress: '   ' });
  entry.continueCreate();
  assert.equal(h.navigations.length, 0);
  assert.equal(h.toasts.at(-1).title, '请填写企业地址');
  entry.setData({ registeredAddress: '  河北省测试路 1 号  ' });
  entry.continueCreate();
  assert.equal(h.navigations.length, 1);
  const confirmation = h.page('company-cert');
  confirmation.loadOnboardingPolicy = () => {};
  confirmation.onLoad(confirmationOptions(h.navigations[0]));
  assert.equal(confirmation.data.registeredAddress, details.registeredAddress);
  for (const field of ['contactPhone', 'bankName', 'bankAccount']) assert.equal(confirmation.data[field], '');
});

test('returning to entry restores unfinished details but an already-created company draft is isolated', async () => {
  const h = harness();
  const first = h.page('company-bind');
  for (const [field, value] of Object.entries({ ...companyFields, ...details })) input(first, field, value);
  first.continueCreate();
  const reopened = h.page('company-bind');
  await reopened.onLoad();
  for (const [field, value] of Object.entries({ ...companyFields, ...details })) assert.equal(reopened.data[field], value);
  input(reopened, 'registeredAddress', '修改后的企业地址');
  reopened.continueCreate();
  const confirmation = h.page('company-cert');
  confirmation.loadOnboardingPolicy = () => {};
  confirmation.onLoad(confirmationOptions(h.navigations.at(-1)));
  assert.equal(confirmation.data.registeredAddress, '修改后的企业地址');
  assert.equal(confirmation.data.bankAccount, details.bankAccount);
  h.drafts.saveDraft({ ...companyFields, ...details, companyId: 'existing-company' });
  const fresh = h.page('company-bind');
  await fresh.onLoad();
  for (const field of Object.keys({ ...companyFields, ...details })) assert.equal(fresh.data[field], '');
});

test('unknown bank details stay empty and a different account cannot read the draft', () => {
  const h = harness();
  h.drafts.saveDraft({ companyName: '新企业', creditCode: 'CODE-3', legalPersonName: '张三', registeredAddress: details.registeredAddress });
  assert.equal(h.drafts.readDraft().bankName, '');
  assert.equal(h.drafts.readDraft().bankAccount, '');
  h.app.globalData.userInfo = { id: '8' };
  assert.equal(h.drafts.readDraft(), null);
});

test('reopening confirmation restores only the matching unsubmitted company details', () => {
  const h = harness();
  h.drafts.saveDraft({ companyName: '测试企业', creditCode: 'CODE-3', legalPersonName: '张三', ...details });
  const page = h.page('company-cert');
  page.loadOnboardingPolicy = () => {};
  page.onLoad({ name: encodeURIComponent('测试企业'), creditCode: 'CODE-3' });
  assert.equal(page.data.bankAccount, details.bankAccount);
  const different = h.page('company-cert');
  different.loadOnboardingPolicy = () => {};
  different.onLoad({ name: encodeURIComponent('另一企业'), creditCode: 'CODE-4' });
  assert.equal(different.data.bankAccount, '');
});

test('current legal representative can save contact details without changing the certified identity', async () => {
  const h = harness();
  const company = { id: '3', name: '认证企业', creditCode: 'CODE-3', legalPersonName: '认证法人', ...details };
  h.state.handler = async options => options.url === '/me'
    ? { company, member: { roleCode: 'LEGAL', memberStatus: 'ACTIVE' } }
    : { ...company, ...options.data };
  const page = h.page('company-info');
  await page.loadInfo();
  assert.equal(page.data.canEditCompany, true);
  page.editBusinessInfo();
  page.onBusinessInfoInput({ currentTarget: { dataset: { field: 'contactPhone' } }, detail: { value: ' 0311-88888888 ' } });
  await page.saveBusinessInfo();
  const write = h.calls.find(options => options.method === 'POST');
  assert.equal(write.data.name, company.name);
  assert.equal(write.data.legalPersonName, company.legalPersonName);
  assert.equal(write.data.contactPhone, '0311-88888888');
  assert.equal(write.data.bankAccount, details.bankAccount);
  assert.equal(page.data.company.contactPhone, '0311-88888888');
  assert.equal(page.data.editing, false);
});

test('ordinary members and stale company contexts cannot save enterprise bank information', async () => {
  const h = harness();
  let roleCode = 'ADMIN';
  h.state.handler = async () => ({ company: { id: '3', name: '认证企业', ...details }, member: { roleCode, memberStatus: 'ACTIVE' } });
  const page = h.page('company-info');
  await page.loadInfo();
  page.editBusinessInfo();
  await page.saveBusinessInfo();
  assert.equal(page.data.editing, false);
  roleCode = 'LEGAL';
  await page.loadInfo();
  page.editBusinessInfo();
  h.app.globalData.currentCompanyId = '4';
  await page.saveBusinessInfo();
  assert.ok(h.calls.every(options => !options.method));
});
