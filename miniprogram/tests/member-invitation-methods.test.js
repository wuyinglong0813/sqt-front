const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function harness() {
  const requests = [], copies = [], writes = [], previews = [], toasts = [];
  const app = { globalData: { token: 'session', currentCompanyId: 'company-1', userInfo: { id: 'user' } },
    getCurrentCompanyId() { return this.globalData.currentCompanyId; } };
  const wx = { env: { USER_DATA_PATH: '/tmp/test-invite' },
    requirePrivacyAuthorize: options => options.success(),
    getStorageSync: () => '', showToast: options => toasts.push(options.title),
    setClipboardData: options => copies.push(options.data),
    previewImage: options => previews.push(options.current),
    getFileSystemManager: () => ({ writeFile: options => { writes.push(options); options.success(); } }),
    request: options => {
      requests.push(options);
      let data = { code: 'ABCD2345', expiresAt: '2026-11-05T16:17:09' };
      if (options.url.endsWith('/qrcode')) data = { imageBase64: 'cG5n', mimeType: 'image/png' };
      if (options.url.endsWith('/share-link')) data = { url: 'https://wxaurl.cn/example' };
      options.success({ statusCode: 200, data: { code: 0, data } });
    }
  };
  let definition;
  const root = path.join(__dirname, '..'), modules = new Map();
  function load(file) {
    const full = path.resolve(root, file);
    if (modules.has(full)) return modules.get(full).exports;
    const module = { exports: {} }; modules.set(full, module);
    vm.runInNewContext(fs.readFileSync(full, 'utf8'), { module, exports: module.exports,
      wx, getApp: () => app, Page: page => { definition = page; }, setTimeout, clearTimeout,
      require: id => load(path.relative(root, path.resolve(path.dirname(full), `${id}.js`))) }, { filename: full });
    return module.exports;
  }
  load('pages/auth-manage/auth-manage.js');
  const page = { ...definition, data: JSON.parse(JSON.stringify(definition.data)) };
  page.setData = data => Object.assign(page.data, data);
  return { page, app, wx, requests, copies, writes, previews, toasts };
}

test('one prepared invitation supplies a code, WeChat card, QR code and https link without a recipient phone', async () => {
  const env = harness();
  await env.page.openMemberInvite();
  assert.equal(env.requests[0].method, 'POST');
  assert.equal(env.requests[0].data.companyId, 'company-1');
  assert.equal(env.requests[0].data.targetPhone, undefined);
  assert.equal(env.page.data.inviteExpiresAt, '2026-11-05 16:17');
  const event = { from: 'button', target: { dataset: { inviteType: 'member' } } };
  assert.equal(env.page.onShareAppMessage(event).path, '/pages/invitation/invitation?inviteCode=ABCD2345&type=member');
  await env.page.copyMemberInviteCode();
  await env.page.showMemberInviteQr();
  assert.equal(env.writes[0].encoding, 'base64');
  assert.match(env.page.data.inviteQrPath, /member-invite-ABCD2345\.png$/);
  env.page.previewMemberInviteQr();
  assert.equal(env.previews[0], env.page.data.inviteQrPath);
  await env.page.copyMemberInviteLink();
  assert.deepEqual(env.copies, ['ABCD2345', 'https://wxaurl.cn/example']);
  assert.equal(env.requests.length, 3);
});

test('obsolete media and links never update or copy after the inviting company changes', async () => {
  const env = harness();
  await env.page.openMemberInvite();
  const pending = [];
  env.wx.request = options => pending.push(options);
  const qr = env.page.showMemberInviteQr(), link = env.page.copyMemberInviteLink();
  env.app.globalData.currentCompanyId = 'company-2';
  pending[0].success({ statusCode: 200, data: { code: 0, data: { imageBase64: 'cG5n', mimeType: 'image/png' } } });
  pending[1].success({ statusCode: 200, data: { code: 0, data: { url: 'https://wxaurl.cn/stale' } } });
  await Promise.all([qr, link]);
  assert.equal(env.writes.length, 0);
  assert.equal(env.copies.length, 0);
  assert.equal(env.page.data.inviteQrPath, '');
});

test('media generation errors stay visible and a failed image does not become a fake QR code', async () => {
  const env = harness();
  await env.page.openMemberInvite();
  env.wx.request = options => options.success({ statusCode: 400, data: { code: 400, message: '小程序页面尚未发布' } });
  await env.page.showMemberInviteQr();
  assert.equal(env.page.data.inviteQrLoading, false);
  assert.equal(env.page.data.inviteQrPath, '');
  assert.deepEqual(env.toasts, ['小程序页面尚未发布']);
});

test('unverified applicants are shown separately and cannot open role approval', () => {
  const env = harness();
  const applicant = { id: 'application', status: 'PENDING_IDENTITY', realNameVerified: false, roleCode: 'GUEST' };
  env.page.refreshMemberView([applicant]);
  assert.equal(env.page.data.memberStats.waitingIdentity, 1);
  assert.equal(env.page.data.memberStats.active, 0);
  env.page.showApproveModal({ currentTarget: { dataset: { id: applicant.id } } });
  assert.equal(env.page.data.showApproveModal, false);
  assert.match(env.toasts[0], /实名认证/);
});

test('invitation management keeps revocation behind a menu and the existing confirmation', async () => {
  const env = harness();
  const menus = [], confirmations = [];
  env.wx.showActionSheet = options => menus.push(options);
  env.wx.showModal = options => confirmations.push(options);
  await env.page.openMemberInvite();
  env.page.manageMemberInvite();
  assert.deepEqual(Array.from(menus[0].itemList), ['作废当前邀请']);
  assert.equal(env.requests.filter(item => item.method === 'DELETE').length, 0);
  const revoking = menus[0].success({ tapIndex: 0 });
  assert.equal(confirmations[0].confirmText, '确认作废');
  assert.equal(env.requests.filter(item => item.method === 'DELETE').length, 0);
  confirmations[0].success({ confirm: true });
  await revoking;
  assert.equal(env.requests.at(-1).method, 'DELETE');
  assert.match(env.requests.at(-1).url, /invitations\/ABCD2345$/);
  assert.equal(env.page.data.showInviteModal, false);
});

test('an old invitation management menu cannot revoke a new invitation or a different company', async () => {
  for (const change of ['code', 'company', 'close']) {
    const env = harness();
    let menu;
    const confirmations = [];
    env.wx.showActionSheet = options => { menu = options; };
    env.wx.showModal = options => confirmations.push(options);
    await env.page.openMemberInvite();
    env.page.manageMemberInvite();
    if (change === 'code') env.page.setData({ inviteCode: 'NEXT2345' });
    else if (change === 'company') env.app.globalData.currentCompanyId = 'company-2';
    else env.page.closeMemberInvite();
    await menu.success({ tapIndex: 0 });
    assert.equal(confirmations.length, 0);
    assert.equal(env.requests.filter(item => item.method === 'DELETE').length, 0);
  }
});
