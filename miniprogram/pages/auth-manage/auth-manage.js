const { request } = require('../../utils/request');
const app = getApp();

const ROLE_META = {
  LEGAL: { label: '法人', description: '企业最高管理权限', tone: 'legal' },
  ADMIN: { label: '管理员', description: '成员与业务配置管理', tone: 'admin' },
  SALES: { label: '销售员', description: '销售合同与客户业务', tone: 'sales' },
  PURCHASER: { label: '采购员', description: '采购合同与供应商业务', tone: 'purchase' },
  FINANCE: { label: '财务', description: '对账与财务数据查看', tone: 'finance' },
  GUEST: { label: '访客', description: '基础查看权限', tone: 'guest' }
};

function currentCompanyId() {
  const cid = app.getCurrentCompanyId();
  if (!cid) wx.showToast({ title: '请先选择企业', icon: 'none' });
  return cid;
}

function roleMeta(code, fallback) {
  return ROLE_META[code] || {
    label: fallback || code || '未分配角色',
    description: '按企业角色配置权限',
    tone: 'guest'
  };
}

function memberInitial(name) {
  const value = String(name || '成员').trim();
  if (!value) return '员';
  const words = value.split(/\s+/).filter(Boolean);
  if (words.length > 1) return words.slice(0, 2).map(word => word[0]).join('').toUpperCase();
  return value.slice(0, 2);
}

function maskPhone(phone) {
  const value = String(phone || '');
  if (value.length < 7) return value || '未绑定手机号';
  return `${value.slice(0, 3)}****${value.slice(-4)}`;
}

function decorateMembers(list) {
  return (list || []).map((member, index) => {
    const meta = roleMeta(member.roleCode, member.roleText);
    const roles = (member.roles && member.roles.length ? member.roles
      : [{ code: member.roleCode, name: member.roleText || meta.label }])
      .map(role => ({ code: role.code, label: role.name || roleMeta(role.code).label, tone: roleMeta(role.code).tone }));
    const pending = member.status === 'PENDING';
    return {
      ...member,
      avatarText: memberInitial(member.memberName),
      avatarTone: `tone-${index % 5}`,
      maskedPhone: maskPhone(member.phone),
      roleLabel: roles.map(role => role.label).join('、'),
      roles,
      roleTone: meta.tone,
      statusText: pending ? '待审批' : '正常',
      canRemove: !pending && member.roleCode !== 'LEGAL'
    };
  });
}

Page({
  data: {
    authorizations: [],
    filtered: [],
    keyword: '',
    companyName: '当前企业',
    companyAbbr: '企业',
    activeStatusFilter: 'ALL',
    memberStats: { total: 0, active: 0, pending: 0, managers: 0 },
    statusFilters: [
      { key: 'ALL', label: '全部成员', count: 0 },
      { key: 'ACTIVE', label: '正常', count: 0 },
      { key: 'PENDING', label: '待审批', count: 0 }
    ],
    showApproveModal: false,
    approveTargetId: '',
    approveTargetName: '',
    approveRoles: [],
    selectedRoleCodes: [],
    selectedRoles: [],
    combinedPermissions: [],
    editingMember: false,
    savingRole: false,
    inviteCode: '',
    inviteCompanyId: '',
    preparingInvite: false,
    loading: false,
    page: 1,
    size: 20,
    hasMore: false
  },

  noop() {},

  onSearch(e) {
    const keyword = (e.detail.value || '').trim().toLowerCase();
    this.setData({ keyword });
    this.refreshMemberView(this.data.authorizations, keyword, this.data.activeStatusFilter);
  },

  onStatusFilterTap(e) {
    const key = e.currentTarget.dataset.key || 'ALL';
    this.setData({ activeStatusFilter: key });
    this.refreshMemberView(this.data.authorizations, this.data.keyword, key);
  },

  async onShow() {
    await app.ensureSessionReady();
    const cid = app.getCurrentCompanyId();
    if (String(cid) !== this.data.inviteCompanyId) this.setData({ inviteCode: '', inviteCompanyId: '' });
    const companies = app.globalData.companies || [];
    const current = companies.find(company => String(company.companyId) === String(cid));
    const companyName = (current && current.companyName) || '当前企业';
    this.setData({
      companyName,
      companyAbbr: companyName.length > 4 ? companyName.slice(0, 2) : companyName
    });
    this.shareInvite();
    this.loadMembers(true);
    this.loadRoles();
  },

  onReachBottom() {
    if (this.data.hasMore && !this.data.loading) this.loadMembers(false);
  },

  async loadRoles() {
    const cid = currentCompanyId();
    if (!cid) return;
    try {
      const [list, permissions] = await Promise.all([
        request({ url: `/roles?companyId=${cid}` }), request({ url: '/permissions' })
      ]);
      if (String(cid) !== String(app.getCurrentCompanyId())) return;
      this.setData({
        approveRoles: (list || []).filter(r => !['LEGAL', 'LEGAL_CANDIDATE'].includes(r.code)).map(r => {
          const meta = roleMeta(r.code, r.name);
          return {
            id: r.id,
            label: r.name || meta.label,
            value: r.code,
            code: r.code,
            description: (r.permissions || []).length ? `已配置 ${r.permissions.length} 项权限` : '无业务权限',
            permissions: (r.permissions || []).map(code => {
              const def = (permissions || []).find(p => p.code === code);
              return { code, label: def ? def.label : code };
            }),
            tone: meta.tone
          };
        })
      });
      this.refreshSelectedRoles();
    } catch (e) {}
  },

  async loadMembers(reset = true) {
    const cid = currentCompanyId();
    if (!cid || this.data.loading) return;
    this.setData({ loading: true });
    try {
      const page = reset ? 1 : this.data.page + 1;
      const payload = await request({ url: `/authorizations?companyId=${cid}&page=${page}&size=${this.data.size}` });
      const list = Array.isArray(payload) ? payload : (payload.items || []);
      const rawMembers = reset ? list : this.data.authorizations.concat(list);
      const authorizations = decorateMembers(rawMembers);
      this.setData({
        page,
        hasMore: !!payload.hasMore
      });
      this.refreshMemberView(authorizations, this.data.keyword, this.data.activeStatusFilter);
    } catch (e) {
      wx.showToast({ title: e.message || '成员加载失败', icon: 'none' });
    } finally {
      this.setData({ loading: false });
    }
  },

  refreshMemberView(authorizations, keyword = '', status = 'ALL') {
    const normalizedKeyword = String(keyword || '').trim().toLowerCase();
    const active = authorizations.filter(member => member.status === 'ACTIVE').length;
    const pending = authorizations.filter(member => member.status === 'PENDING').length;
    const managers = authorizations.filter(member => (member.roles || [{ code: member.roleCode }])
      .some(role => role.code === 'LEGAL' || role.code === 'ADMIN')).length;
    const filtered = authorizations.filter(member => {
      const statusMatched = status === 'ALL' || member.status === status;
      const keywordMatched = !normalizedKeyword
        || String(member.memberName || '').toLowerCase().includes(normalizedKeyword)
        || String(member.phone || '').includes(normalizedKeyword)
        || String(member.roleLabel || '').toLowerCase().includes(normalizedKeyword);
      return statusMatched && keywordMatched;
    });
    this.setData({
      authorizations,
      filtered,
      memberStats: { total: authorizations.length, active, pending, managers },
      statusFilters: [
        { key: 'ALL', label: '全部成员', count: authorizations.length },
        { key: 'ACTIVE', label: '正常', count: active },
        { key: 'PENDING', label: '待审批', count: pending }
      ]
    });
  },

  async shareInvite() {
    if (this.data.preparingInvite) return;
    const cid = currentCompanyId();
    if (!cid) return;
    this.setData({ preparingInvite: true, inviteCode: '', inviteCompanyId: '' });
    try {
      const result = await request({ url: '/companies/invite', method: 'POST', data: { companyId: cid } });
      if (String(cid) !== String(app.getCurrentCompanyId())) return;
      if (!result || !result.code) throw new Error('邀请生成失败，请重试');
      this.setData({ inviteCode: result.code, inviteCompanyId: String(cid) });
    } catch (e) { wx.showToast({ title: e.message || '邀请生成失败', icon: 'none' }); }
    finally { this.setData({ preparingInvite: false }); }
  },

  onShareAppMessage(event) {
    const code = this.data.inviteCode;
    if (!code || !event || event.from !== 'button'
        || !event.target || event.target.dataset.inviteType !== 'member'
        || this.data.inviteCompanyId !== String(app.getCurrentCompanyId())) {
      return { title: '商签通', imageUrl: '/images/member-invite-cover.png', path: '/pages/index/index' };
    }
    return {
      title: '邀请你加入商签通企业组织',
      imageUrl: '/images/member-invite-cover.png',
      path: `/pages/index/index?inviteCode=${encodeURIComponent(code)}&type=member`
    };
  },

  showApproveModal(e) {
    const member = this.data.authorizations.find(item => String(item.id) === String(e.currentTarget.dataset.id));
    const editingMember = !!member && member.status === 'ACTIVE';
    const selectedRoleCodes = editingMember
      ? (member.roles && member.roles.length ? member.roles.map(role => role.code) : [member.roleCode]) : [];
    this.setData({
      showApproveModal: true,
      editingMember,
      selectedRoleCodes,
      approveTargetId: e.currentTarget.dataset.id,
      approveTargetName: e.currentTarget.dataset.name || '该成员'
    });
    this.refreshSelectedRoles();
  },
  hideApproveModal() {
    if (this.data.savingRole) return;
    this.setData({ showApproveModal: false, approveTargetId: '', approveTargetName: '' });
  },

  selectRole(e) {
    if (this.data.savingRole) return;
    const code = e.currentTarget.dataset.role;
    if (!this.data.approveRoles.some(role => role.code === code)) return;
    const selectedRoleCodes = this.data.selectedRoleCodes.includes(code)
      ? this.data.selectedRoleCodes.filter(value => value !== code) : [...this.data.selectedRoleCodes, code];
    this.setData({ selectedRoleCodes });
    this.refreshSelectedRoles();
  },

  refreshSelectedRoles() {
    const codes = this.data.selectedRoleCodes;
    const approveRoles = this.data.approveRoles.map(role => ({ ...role, selected: codes.includes(role.code) }));
    const selectedRoles = codes.map(code => approveRoles.find(role => role.code === code)).filter(Boolean);
    const permissions = new Map();
    selectedRoles.forEach(role => (role.permissions || []).forEach(permission => permissions.set(permission.code, permission)));
    const combinedPermissions = permissions.has('all')
      ? [{ code: 'all', label: '全部权限' }] : Array.from(permissions.values());
    this.setData({ approveRoles, selectedRoles, combinedPermissions });
  },

  manageRoles() { wx.navigateTo({ url: '/pages/role-manage/role-manage' }); },

  async confirmApprove() {
    if (this.data.savingRole) return;
    const roleCodes = this.data.selectedRoleCodes;
    if (!roleCodes.length) { wx.showToast({ title: '请至少选择一个角色', icon: 'none' }); return; }
    if (this.data.selectedRoles.length !== roleCodes.length) { wx.showToast({ title: '角色信息已变化，请重新打开后选择', icon: 'none' }); return; }
    const memberId = this.data.approveTargetId;
    const cid = currentCompanyId();
    if (!cid) return;
    const editing = this.data.editingMember;
    this.setData({ savingRole: true });
    try {
      await request({ url: `/authorizations/${memberId}/${editing ? 'role' : 'approve'}?companyId=${cid}`, method: editing ? 'PUT' : 'POST', data: { roleCode: roleCodes[0], roleCodes, customPermissions: [] } });
      wx.showToast({ title: editing ? '权限已更新' : '已通过', icon: 'success' });
      this.setData({ showApproveModal: false, approveTargetId: '', approveTargetName: '' });
      await app.refreshSession();
      await this.loadMembers(true);
    } catch (e) { wx.showToast({ title: e.message, icon: 'none' }); }
    finally { this.setData({ savingRole: false }); }
  },

  async rejectMember(e) {
    const id = e.currentTarget.dataset.id;
    const cid = currentCompanyId();
    if (!cid) return;
    const res = await new Promise(r => wx.showModal({ title: '确认拒绝', success: r }));
    if (!res.confirm) return;
    try {
      await request({ url: `/authorizations/${id}/reject?companyId=${cid}`, method: 'POST' });
      wx.showToast({ title: '已拒绝', icon: 'success' });
      this.loadMembers(true);
    } catch (e) { wx.showToast({ title: e.message, icon: 'none' }); }
  },

  async revokeAuth(e) {
    const id = e.currentTarget.dataset.id;
    const cid = currentCompanyId();
    if (!cid) return;
    const res = await new Promise(r => wx.showModal({ title: '确认移除', success: r }));
    if (!res.confirm) return;
    try {
      await request({ url: `/authorizations/${id}?companyId=${cid}`, method: 'DELETE' });
      wx.showToast({ title: '已移除', icon: 'success' });
      this.loadMembers(true);
    } catch (e) { wx.showToast({ title: e.message, icon: 'none' }); }
  }
});
