'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture(editing) {
  const calls = [], modals = [], toasts = [];
  const message = '当前账号未获“供方首页”权限，无法授予；请由法人或已获该权限的成员操作';
  let definition, rejectSave = true, profileRefreshes = 0, memberRefreshes = 0;
  const app = { getCurrentCompanyId: () => '3', refreshSession: async () => { profileRefreshes++; } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../pages/auth-manage/auth-manage.js'), 'utf8'), {
    Page: value => { definition = value; }, getApp: () => app,
    require: () => ({ request: async options => {
      calls.push(options);
      if (rejectSave) throw new Error(message);
      return null;
    } }),
    wx: { showModal: options => modals.push(options), showToast: options => toasts.push(options) }
  });
  const page = { ...definition, data: JSON.parse(JSON.stringify(definition.data)),
    setData(values) { Object.assign(this.data, values); },
    loadMembers: async () => { memberRefreshes++; } };
  page.data.authorizations = [{ id: '7', status: editing ? 'ACTIVE' : 'PENDING', roleCode: 'SALES' }];
  page.data.approveRoles = [{ code: 'SALES', permissions: [{ code: 'supplier_view', label: '供方首页' }] }];
  page.showApproveModal({ currentTarget: { dataset: { id: '7', name: '成员' } } });
  if (!editing) page.selectRole({ currentTarget: { dataset: { role: 'SALES' } } });
  return { page, calls, modals, toasts, message,
    allowSave: () => { rejectSave = false; },
    profileRefreshes: () => profileRefreshes, memberRefreshes: () => memberRefreshes };
}

for (const editing of [true, false]) {
  test(`${editing ? 'role editing' : 'member approval'} preserves failed selections and shows the full permission error until acknowledged`, async () => {
    const f = fixture(editing);
    await f.page.confirmApprove();
    assert.equal(f.modals.length, 1);
    assert.equal(f.modals[0].content, f.message);
    assert.equal(f.modals[0].showCancel, false);
    assert.equal(f.modals[0].confirmText, '我知道了');
    assert.equal(f.toasts.length, 0);
    assert.equal(f.page.data.showApproveModal, true);
    assert.equal(f.page.data.approveTargetId, '7');
    assert.deepEqual(Array.from(f.page.data.selectedRoleCodes), ['SALES']);
    assert.equal(f.page.data.savingRole, false);
    assert.equal(f.profileRefreshes(), 0);
    assert.equal(f.memberRefreshes(), 0);

    f.allowSave();
    await f.page.confirmApprove();
    assert.equal(f.calls.length, 2);
    assert.equal(f.calls[1].method, editing ? 'PUT' : 'POST');
    assert.equal(f.page.data.showApproveModal, false);
    assert.equal(f.toasts[0].icon, 'success');
    assert.equal(f.profileRefreshes(), 1);
    assert.equal(f.memberRefreshes(), 1);
  });
}
