'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function page(relativePath, request, app) {
  let definition;
  const notices = [];
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, relativePath), 'utf8'), {
    Page: value => { definition = value; },
    getApp: () => app,
    require: name => name.endsWith('/request') ? { request } : {},
    wx: { showToast: value => notices.push(value), navigateTo: value => notices.push(value) },
    setTimeout, clearTimeout
  });
  const instance = { ...definition, data: structuredClone(definition.data),
    setData(value, callback) { Object.assign(this.data, value); if (callback) callback(); } };
  return { instance, notices };
}

test('finance loads its authorized attachments without requesting logistics', async () => {
  const paths = [];
  const { instance } = page('../pages/contract-preview/contract-preview.js', async ({ url }) => {
    paths.push(url);
    return [{ id: url, voucherAmount: 10, invoiceAmount: 10 }];
  }, { globalData: {} });
  Object.assign(instance.data, { contractId: '12', canViewPayments: true,
    canViewInvoices: true, canViewOtherAttachments: true, canViewContractContent: false });
  await instance.loadFulfillmentData();
  assert.equal(paths.some(url => url.includes('logistics')), false);
  assert.equal(instance.data.paymentAttachments.length, 1);
  assert.equal(instance.data.invoiceList.length, 1);
});

test('failure of one fulfillment section preserves other successful sections and reports its error', async () => {
  const { instance } = page('../pages/contract-preview/contract-preview.js', async ({ url }) => {
    if (url.includes('logistics')) throw new Error('物流暂无权限');
    return [{ id: url, invoiceAmount: 100 }];
  }, { globalData: {} });
  Object.assign(instance.data, { contractId: '12', canViewPayments: true,
    canViewInvoices: true, canViewOtherAttachments: true, canViewContractContent: true });
  await instance.loadFulfillmentData();
  assert.equal(instance.data.invoiceList.length, 1);
  assert.equal(instance.data.paymentAttachments.length, 1);
  assert.equal(instance.data.fulfillmentErrors.logistics, '物流暂无权限');
  assert.equal(instance.data.fulfillmentLoading, false);
});

test('an existing guest session binds using phoneCode and retains company context', async () => {
  const calls = [];
  const app = { globalData: { token: 'session', userInfo: {
    id: '7', currentCompanyId: '3', currentRole: 'FINANCE', phone: ''
  } } };
  const { instance } = page('../pages/personal-cert/personal-cert.js', async request => {
    calls.push(request);
    return { id: '7', phone: '13800000000', currentCompanyId: null, currentRole: 'GUEST' };
  }, app);
  await instance.bindWechatPhone({ detail: { errMsg: 'getPhoneNumber:ok', code: 'trusted-code' } });
  assert.equal(calls[0].url, '/auth/bind-phone');
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0].data)), { phoneCode: 'trusted-code' });
  assert.equal(calls[0].withCompany, false);
  assert.equal(app.globalData.userInfo.phone, '13800000000');
  assert.equal(app.globalData.userInfo.currentCompanyId, '3');
  assert.equal(app.globalData.userInfo.currentRole, 'FINANCE');
  assert.equal(instance.data.phoneBound, true);
  assert.equal(instance.data.maskedPhone, '138****0000');
});

test('desktop guides continuation on mobile and cannot submit arbitrary phone binding', async () => {
  let calls = 0;
  const { instance, notices } = page('../pages/personal-cert/personal-cert.js', async () => { calls++; },
    { globalData: { token: 'session' } });
  Object.assign(instance.data, { desktopMode: true, phoneLoading: false });
  await instance.bindWechatPhone({ detail: { errMsg: 'getPhoneNumber:ok', code: 'code' } });
  instance.startAuth();
  assert.equal(calls, 0);
  assert.match(notices[0].title, /手机微信/);
  const template = fs.readFileSync(path.join(__dirname, '../pages/personal-cert/personal-cert.wxml'), 'utf8');
  assert.match(template, /同一微信账号/);
});

test('phone binding failures remain retryable without changing current user', async () => {
  const app = { globalData: { token: 'session', userInfo: { id: '7', phone: '' } } };
  const { instance, notices } = page('../pages/personal-cert/personal-cert.js',
    async () => { throw new Error('该手机号已绑定其他账号'); }, app);
  await instance.bindWechatPhone({ detail: { errMsg: 'getPhoneNumber:ok', code: 'code' } });
  assert.equal(instance.data.bindingPhone, false);
  assert.equal(instance.data.phoneBound, false);
  assert.equal(app.globalData.userInfo.phone, '');
  assert.match(notices[0].title, /其他账号/);
});

test('late phone binding results do not overwrite another session', async () => {
  let resolve;
  const app = { globalData: { token: 'old-session', userInfo: { id: '7', phone: '' } } };
  const { instance } = page('../pages/personal-cert/personal-cert.js',
    () => new Promise(done => { resolve = done; }), app);
  const pending = instance.bindWechatPhone({ detail: { errMsg: 'getPhoneNumber:ok', code: 'code' } });
  app.globalData.token = 'new-session';
  app.globalData.userInfo = { id: '8', phone: '' };
  resolve({ id: '7', phone: '13800000000' });
  await pending;
  assert.equal(app.globalData.userInfo.id, '8');
  assert.equal(app.globalData.userInfo.phone, '');
  assert.equal(instance.data.phoneBound, false);
});
