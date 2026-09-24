const { request } = require('../../utils/request');
const app = getApp();

function currentCompanyId() {
  const cid = app.getCurrentCompanyId();
  if (!cid) wx.showToast({ title: '请先选择企业', icon: 'none' });
  return cid;
}

Page({
  data: {
    roles: [],
    showModal: false,
    editRoleId: '',
    roleName: '',
    systemRole: false,
    deletable: false,
    saving: false,
    allPerms: []
  },

  onShow() { this.loadRoles(); },

  onLoad(options = {}) { this._copyRoleId = options.copyRoleId || ''; },

  async loadRoles() {
    const cid = currentCompanyId();
    if (!cid) return;
    try {
      const [permDefs, list] = await Promise.all([
        request({ url: '/permissions' }),
        request({ url: `/roles?companyId=${cid}` })
      ]);
      // 缓存权限定义供后续使用
      this._permDefs = permDefs || [];
      this.setData({ roles: (list || []).map(r => ({
        ...r,
        permsDisplay: this.formatPerms(r.permissions)
      })) });
      if (this._copyRoleId) {
        const id = this._copyRoleId;
        this._copyRoleId = '';
        this.copyRole({ currentTarget: { dataset: { id } } });
      }
    } catch (e) {}
  },

  formatPerms(permissions) {
    if (!permissions) return '无';
    let arr = Array.isArray(permissions) ? permissions : [];
    if (!Array.isArray(permissions)) {
      try { arr = JSON.parse(permissions); } catch (e) { arr = String(permissions).split(','); }
    }
    if (arr.length === 0) return '无';
    if (arr.includes('all')) return '全部权限';
    const defs = this._permDefs || [];
    return arr.map(v => {
      const def = defs.find(p => p.code === v.trim());
      return def ? def.label : v;
    }).join('、');
  },

  showAddRole() {
    const defs = this._permDefs || [];
    this.setData({
      showModal: true, editRoleId: '', roleName: '', systemRole: false, deletable: false,
      allPerms: defs.map(p => ({ code: p.code, label: p.label, checked: false }))
    });
  },

  editRole(e) {
    const { id } = e.currentTarget.dataset;
    const role = this.data.roles.find(item => String(item.id) === String(id));
    if (!role || !role.editable) return;
    const selected = role.permissions || [];
    const defs = this._permDefs || [];
    this.setData({
      showModal: true, editRoleId: id, roleName: role.name, systemRole: role.systemRole, deletable: role.deletable,
      allPerms: defs.map(p => ({ code: p.code, label: p.label, checked: selected.includes(p.code) }))
    });
  },

  copyRole(e) {
    const role = this.data.roles.find(item => String(item.id) === String(e.currentTarget.dataset.id));
    if (!role || !role.editable) return;
    this.setData({
      showModal: true, editRoleId: '', roleName: `${role.name}副本`, systemRole: false, deletable: false,
      allPerms: (this._permDefs || []).map(p => ({ ...p, checked: (role.permissions || []).includes(p.code) }))
    });
  },

  hideModal() { if (!this.data.saving) this.setData({ showModal: false }); },
  noop() {},

  onNameInput(e) { this.setData({ roleName: e.detail.value }); },

  togglePerm(e) {
    const code = e.currentTarget.dataset.code;
    const allPerms = this.data.allPerms.map(p =>
      p.code === code ? { ...p, checked: !p.checked } : p
    );
    this.setData({ allPerms });
  },

  async saveRole() {
    if (this.data.saving) return;
    const name = this.data.roleName.trim();
    if (!name) { wx.showToast({ title: '请输入角色名', icon: 'none' }); return; }
    const perms = this.data.allPerms.filter(p => p.checked).map(p => p.code);
    const cid = currentCompanyId();
    if (!cid) return;
    this.setData({ saving: true });
    try {
      if (this.data.editRoleId) {
        await request({ url: `/roles/${this.data.editRoleId}`, method: 'PUT', data: { companyId: cid, name, permissions: perms } });
      } else {
        await request({ url: '/roles', method: 'POST', data: { companyId: cid, name, permissions: perms } });
      }
      wx.showToast({ title: '已保存', icon: 'success' });
      this.setData({ showModal: false });
      await app.refreshSession();
      await this.loadRoles();
    } catch (e) { wx.showToast({ title: e.message, icon: 'none' }); }
    finally { this.setData({ saving: false }); }
  },

  async deleteRole() {
    if (!this.data.deletable || this.data.saving) return;
    const res = await new Promise(r => wx.showModal({ title: '确认删除', content: '删除后不可恢复', success: r }));
    if (!res.confirm) return;
    try {
      await request({ url: `/roles/${this.data.editRoleId}`, method: 'DELETE' });
      wx.showToast({ title: '已删除', icon: 'success' });
      this.hideModal();
      this.loadRoles();
    } catch (e) { wx.showToast({ title: e.message, icon: 'none' }); }
  }
});
