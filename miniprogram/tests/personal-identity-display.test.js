'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function personalPage(request) {
  let definition;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,
    '../pages/personal-cert/personal-cert.js'), 'utf8'), {
    Page: value => { definition = value; },
    require: name => name.endsWith('/request') ? { request } : {},
    wx: { showToast() {} }
  });
  return {
    ...definition,
    data: structuredClone(definition.data),
    setData(values) { Object.assign(this.data, values); }
  };
}

for (const method of ['face', 'mobile', 'unknown_provider_method', null]) {
  test(`verified identity shows its channel without claiming the current session used ${method}`, async () => {
    const identity = { providerEnabled: true, status: 'VERIFIED', statusText: '已认证',
      verifiedName: '测试用户', identMethod: method, verifiedAt: '2026-10-20T13:45:00' };
    const page = personalPage(async () => identity);

    await page.loadIdentity(false);

    assert.equal(page.data.identity.verificationChannel, '电子签实名认证');
    assert.equal(page.data.identity.identMethod, undefined);
    assert.equal(page.data.identity.verifiedName, '测试用户');
    assert.equal(page.data.identity.verifiedAt, '2026-10-20 13:45:00');
    assert.equal(page.data.statusView.title, '个人认证已完成');
    assert.equal(identity.identMethod, method);
  });
}

test('a pending identity does not present a successful certification channel', async () => {
  const page = personalPage(async () => ({ providerEnabled: true, status: 'IN_PROGRESS', identMethod: 'face' }));
  await page.loadIdentity(false);
  assert.equal(page.data.identity.verificationChannel, '');
  assert.equal(page.data.identity.identMethod, undefined);
  assert.equal(page.data.statusView.title, '个人认证进行中');
});

test('a failed continuation recheck also keeps raw identity method out of display data', async () => {
  const page = personalPage(async ({ method }) => {
    if (method === 'POST') throw new Error('暂时无法核验');
    return { providerEnabled: true, status: 'VERIFIED', identMethod: 'face' };
  });
  page._identityContinuationId = 'original-signing-flow';

  await page.loadIdentity(true);

  assert.equal(page.data.identity.identMethod, undefined);
  assert.equal(page.data.identity.failureReason, '暂时无法核验');
  assert.equal(page.data.statusView.title, '个人认证进行中');
});

test('the personal certification template renders the channel instead of raw provider methods', () => {
  const template = fs.readFileSync(path.join(__dirname, '../pages/personal-cert/personal-cert.wxml'), 'utf8');
  assert.match(template, /认证渠道/);
  assert.match(template, /identity\.verificationChannel/);
  assert.doesNotMatch(template, /identMethod|认证方式/);
});
