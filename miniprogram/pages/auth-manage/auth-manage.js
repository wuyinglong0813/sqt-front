const { request } = require('../../utils/request');
const { captureCompanyContext, isCompanyContextCurrent } = require('../../utils/companyContext');
const { serviceRecovery, serviceRecoveryUrl } = require('../../utils/signingContinuation');
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

function canManageSigning() {
  const permissions = ((app.globalData || {}).memberInfo || {}).permissions || [];
  return permissions.includes('all') || (permissions.includes('seal_manage')
    && (permissions.includes('member_manage') || permissions.includes('auth_manage')));
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

function signingStatusView(member) {
  const status = String(member.signingStatus || 'PENDING');
  const titles = {
    READY: '签署权限已就绪',
    WAITING_SEAL_AUTHORIZATION: '待完成用印授权',
    WAITING_PERSONAL_IDENTITY: '待本人实名认证',
    ACTIVATION_REQUIRED: '待本人确认加入电子签企业',
    WAITING_COMPANY_AUTHORIZATION: '待完成企业签署授权',
    ADMIN_REVIEW_REQUIRED: '签署权限待核验',
    SYNCING: '签署权限同步中',
    PENDING: '签署权限同步中'
  };
  return {
    signingStatus: status,
    signingReady: status === 'READY',
    signingStatusText: titles[status] || '签署权限待交付',
    signingMessage: member.signingMessage || (status === 'WAITING_SEAL_AUTHORIZATION'
      ? '角色已保存，待授权人完成用印确认后自动核验生效。'
      : status === 'READY' ? '' : '系统将继续核验，角色已保存不代表用印授权已生效。')
  };
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
      ...signingStatusView(member),
      avatarText: memberInitial(member.memberName),
      avatarTone: `tone-${index % 5}`,
      maskedPhone: maskPhone(member.phone),
      roleLabel: roles.map(role => role.label).join('、'),
      roles,
      roleTone: meta.tone,
      statusText: pending ? '待审批' : '正常',
      canAuthorizeSigning: member.status === 'ACTIVE' && !!member.userId
        && (member.permissions || []).some(code => code === 'all' || code === 'contract_sign'),
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
    canGrantSigning: false,
    hasPendingSigning: false,
    contractId: '',
    serviceRecoveryAvailable: false,
    inviteCode: '',
    inviteCompanyId: '',
    showInviteModal: false,
    targetPhone: '',
    invitePhone: '',
    invitePhoneMasked: '',
    preparingInvite: false,
    loading: false,
    page: 1,
    size: 20,
    hasMore: false
  },

  noop() {},

  onLoad(options = {}) {
    this._contractContext = captureCompanyContext(app);
    this._signingManagementContext = captureCompanyContext(app);
    this.setData({ contractId: String(options.contractId || '') });
  },

  returnToContract() {
    if (!this.data.contractId || !isCompanyContextCurrent(app, this._contractContext)) {
      wx.showToast({ title: '企业已变化，请重新打开合同', icon: 'none' });
      return;
    }
    wx.redirectTo({ url: `/pages/contract-preview/contract-preview?contractId=${encodeURIComponent(this.data.contractId)}` });
  },

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
    this._visible = true;
    this._openingSealGrant = false;
    this._signingPollAttempts = 0;
    await app.ensureSessionReady();
    if (this._unloaded || !this._visible) return;
    if (this._signingManagementContext && !isCompanyContextCurrent(app, this._signingManagementContext)) {
      this.refreshMemberView([], this.data.keyword, this.data.activeStatusFilter);
    }
    this._signingManagementContext = captureCompanyContext(app);
    const cid = app.getCurrentCompanyId();
    if ((this._inviteContext && !isCompanyContextCurrent(app, this._inviteContext))
        || (this.data.inviteCompanyId && String(cid) !== this.data.inviteCompanyId)) this.clearMemberInvite();
    const companies = app.globalData.companies || [];
    const current = companies.find(company => String(company.companyId) === String(cid));
    const companyName = (current && current.companyName) || '当前企业';
    const recovery = serviceRecovery(app);
    this.setData({
      serviceRecoveryAvailable: !!(recovery && recovery.target.scene === 'sealGrant'
        && String(recovery.target.contractId || '') === this.data.contractId),
      canGrantSigning: canManageSigning(),
      companyName,
      companyAbbr: companyName.length > 4 ? companyName.slice(0, 2) : companyName
    });
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

  async loadMembers(reset = true, force = false) {
    const cid = currentCompanyId();
    if (!cid || this._unloaded) return;
    const context = captureCompanyContext(app);
    if (!force && this._membersLoad && isCompanyContextCurrent(app, this._membersLoad.context)) {
      return this._membersLoad.promise.then(() => undefined, () => undefined);
    }
    const load = this._membersLoad = { context };
    this.setData({ loading: true });
    try {
      const page = reset ? 1 : this.data.page + 1;
      load.promise = request({ url: `/authorizations?companyId=${cid}&page=${page}&size=${this.data.size}` });
      const payload = await load.promise;
      if (this._unloaded || this._membersLoad !== load || !isCompanyContextCurrent(app, context)) return;
      const list = Array.isArray(payload) ? payload : (payload.items || []);
      const rawMembers = reset ? list : this.data.authorizations.concat(list);
      const authorizations = decorateMembers(rawMembers);
      this.setData({
        canGrantSigning: canManageSigning(),
        page,
        hasMore: !!payload.hasMore
      });
      this.refreshMemberView(authorizations, this.data.keyword, this.data.activeStatusFilter);
      this.scheduleSigningPoll();
    } catch (e) {
      if (!this._unloaded && this._membersLoad === load && isCompanyContextCurrent(app, context)) {
        wx.showToast({ title: e.message || '成员加载失败', icon: 'none' });
        this.scheduleSigningPoll();
      }
    } finally {
      if (this._membersLoad === load) {
        this._membersLoad = null;
        if (!this._unloaded) this.setData({ loading: false });
      }
    }
  },

  onHide() { this._visible = false; this.stopSigningPoll(); },

  onUnload() { this._unloaded = true; this._visible = false; this.stopSigningPoll(); },

  refreshSigningStatus() {
    this._signingPollAttempts = 0;
    return this.loadMembers(true, true);
  },

  stopSigningPoll() {
    if (this.signingPollTimer) clearTimeout(this.signingPollTimer);
    this.signingPollTimer = null;
  },

  scheduleSigningPoll() {
    this.stopSigningPoll();
    if (this._visible !== true || this._unloaded || (this._signingPollAttempts || 0) >= 8
        || !this.data.authorizations.some(member => member.canAuthorizeSigning && !member.signingReady)) return;
    const context = captureCompanyContext(app);
    this.signingPollTimer = setTimeout(() => {
      this.signingPollTimer = null;
      if (this._visible !== true || this._unloaded || !isCompanyContextCurrent(app, context)) return;
      this._signingPollAttempts = (this._signingPollAttempts || 0) + 1;
      return this.loadMembers(true);
    }, 5000);
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
      hasPendingSigning: authorizations.some(member => member.canAuthorizeSigning && !member.signingReady),
      memberStats: { total: authorizations.length, active, pending, managers },
      statusFilters: [
        { key: 'ALL', label: '全部成员', count: authorizations.length },
        { key: 'ACTIVE', label: '正常', count: active },
        { key: 'PENDING', label: '待审批', count: pending }
      ]
    });
  },

  clearMemberInvite() {
    this._inviteLoad = null;
    this._inviteContext = null;
    this.setData({ showInviteModal: false, targetPhone: '', invitePhone: '', invitePhoneMasked: '',
      inviteCode: '', inviteCompanyId: '', preparingInvite: false });
  },

  openMemberInvite() {
    if (!currentCompanyId()) return;
    this.clearMemberInvite();
    this._inviteContext = captureCompanyContext(app);
    this.setData({ showInviteModal: true });
  },

  closeMemberInvite() {
    this.clearMemberInvite();
  },

  onInvitePhoneInput(e) {
    this._inviteLoad = null;
    this.setData({ targetPhone: String(e.detail.value || '').replace(/\D/g, '').slice(0, 11),
      inviteCode: '', inviteCompanyId: '', invitePhone: '', invitePhoneMasked: '', preparingInvite: false });
  },

  async shareInvite() {
    if (this.data.preparingInvite) return;
    const cid = currentCompanyId();
    if (!cid) return;
    const phone = String(this.data.targetPhone || '').trim();
    if (!/^1[3-9]\d{9}$/.test(phone)) {
      wx.showToast({ title: '请输入受邀人的11位手机号', icon: 'none' });
      return;
    }
    const load = this._inviteLoad = { context: captureCompanyContext(app), phone };
    this._inviteContext = load.context;
    this.setData({ preparingInvite: true, inviteCode: '', inviteCompanyId: '' });
    try {
      const result = await request({ url: '/companies/invite', method: 'POST', data: { companyId: cid, targetPhone: phone } });
      if (this._unloaded || this._inviteLoad !== load || !isCompanyContextCurrent(app, load.context)
          || String(cid) !== String(app.getCurrentCompanyId())) return;
      if (!result || !result.code) throw new Error('邀请生成失败，请重试');
      this.setData({ inviteCode: result.code, inviteCompanyId: String(cid), invitePhone: phone,
        invitePhoneMasked: maskPhone(phone) });
    } catch (e) {
      if (!this._unloaded && this._inviteLoad === load && isCompanyContextCurrent(app, load.context)) {
        wx.showToast({ title: e.message || '邀请生成失败', icon: 'none' });
      }
    } finally {
      if (!this._unloaded && this._inviteLoad === load) this.setData({ preparingInvite: false });
    }
  },

  onShareAppMessage(event) {
    const code = this.data.inviteCode;
    if (!code || !event || event.from !== 'button'
        || !event.target || event.target.dataset.inviteType !== 'member'
        || this.data.inviteCompanyId !== String(app.getCurrentCompanyId())
        || !this._inviteContext || !isCompanyContextCurrent(app, this._inviteContext)
        || this.data.targetPhone !== this.data.invitePhone) {
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

  grantSigning(e) {
    const cid = currentCompanyId();
    if (!cid) return;
    if (!canManageSigning()) {
      wx.showToast({ title: '请由印章管理员授权', icon: 'none' });
      return;
    }
    const userId = String(e.currentTarget.dataset.userId || '');
    const member = this.data.authorizations.find(item => String(item.userId) === userId
      && item.status === 'ACTIVE' && String(item.companyId) === String(cid));
    if (!member) {
      wx.showToast({ title: '成员信息已变化，请刷新后重试', icon: 'none' });
      return;
    }
    if (member.signingReady || member.signingStatus === 'READY') return;
    this.openSealGrant(cid, userId, true);
  },

  openSealGrant(companyId, userId, returnToMembers = false) {
    if (this._openingSealGrant || !canManageSigning() || !userId
        || String(companyId) !== String(app.getCurrentCompanyId())) return;
    if (this._signingManagementContext && !isCompanyContextCurrent(app, this._signingManagementContext)) {
      wx.showToast({ title: '登录或企业已变化，请刷新成员后重试', icon: 'none' });
      return;
    }
    if (this.data.contractId && !isCompanyContextCurrent(app, this._contractContext)) {
      wx.showToast({ title: '企业已变化，请重新打开合同', icon: 'none' });
      return;
    }
    const contract = this.data.contractId ? `&contractId=${encodeURIComponent(this.data.contractId)}` : '';
    const continuation = returnToMembers ? '&returnToMembers=1' : '';
    this._openingSealGrant = true;
    wx.navigateTo({ url: `/pages/fadada-auth/fadada-auth?scene=sealGrant&companyId=${encodeURIComponent(companyId)}&userId=${encodeURIComponent(userId)}${contract}${continuation}`,
      fail: () => {
        this._openingSealGrant = false;
        wx.showToast({ title: '用印授权页面未打开，请重试', icon: 'none' });
      } });
  },
  renewServiceLink() {
    const recovery = serviceRecovery(app);
    if (!canManageSigning() || !recovery || recovery.target.scene !== 'sealGrant'
        || String(recovery.target.contractId || '') !== this.data.contractId) return;
    wx.navigateTo({ url: serviceRecoveryUrl(app) });
  },

  async confirmApprove() {
    if (this.data.savingRole) return;
    const roleCodes = this.data.selectedRoleCodes;
    if (!roleCodes.length) { wx.showToast({ title: '请至少选择一个角色', icon: 'none' }); return; }
    if (this.data.selectedRoles.length !== roleCodes.length) { wx.showToast({ title: '角色信息已变化，请重新打开后选择', icon: 'none' }); return; }
    const memberId = this.data.approveTargetId;
    const cid = currentCompanyId();
    if (!cid) return;
    const context = captureCompanyContext(app);
    const target = this.data.authorizations.find(item => String(item.id) === String(memberId));
    const canOfferSigning = canManageSigning() && !!(target && target.userId && String(target.companyId) === String(cid))
      && this.data.combinedPermissions.some(permission => ['contract_sign', 'all'].includes(permission.code));
    const editing = this.data.editingMember;
    this.setData({ savingRole: true });
    try {
      await request({ url: `/authorizations/${memberId}/${editing ? 'role' : 'approve'}?companyId=${cid}`, method: editing ? 'PUT' : 'POST', data: { roleCode: roleCodes[0], roleCodes, customPermissions: [] } });
      if (this._unloaded || !isCompanyContextCurrent(app, context)) return;
      wx.showToast({ title: editing ? '角色已保存' : '已通过', icon: 'success' });
      this.setData({ showApproveModal: false, approveTargetId: '', approveTargetName: '' });
      await app.refreshSession();
      if (this._unloaded || !isCompanyContextCurrent(app, context)) return;
      await this.loadMembers(true, true);
      if (!this._unloaded && canOfferSigning && canManageSigning() && isCompanyContextCurrent(app, context)) {
        this.openSealGrant(cid, target.userId, true);
      }
    } catch (e) {
      if (this._unloaded || !isCompanyContextCurrent(app, context)) return;
      wx.showModal({
        title: editing ? '角色权限操作未完成' : '成员审批操作未完成',
        content: (e && e.message) || '暂时无法完成操作，请稍后重试。',
        showCancel: false,
        confirmText: '我知道了'
      });
    }
    finally { if (!this._unloaded) this.setData({ savingRole: false }); }
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
