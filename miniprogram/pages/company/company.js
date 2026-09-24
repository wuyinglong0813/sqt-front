const { request } = require('../../utils/request');
const { readDraft } = require('../../utils/companyOnboarding');
const { captureCompanyContext, isCompanyContextCurrent } = require('../../utils/companyContext');
const dict = require('../../utils/dict');
const { setTabBarHidden, syncTabBar } = require('../../utils/tabBar');
const app = getApp();

function hasPerm(perm) {
  const member = app.globalData.memberInfo;
  if (!member || !member.permissions) return false;
  const perms = member.permissions;
  if (perms.includes('all')) return true;
  return perms.includes(perm);
}

function companyAbbr(name) {
  const clean = (name || '企业').replace(/有限公司|有限责任公司|股份有限公司/g, '');
  return clean.slice(0, 2) || '企业';
}

function maskCreditCode(code) {
  const value = code || '';
  if (!value) return '暂未录入';
  if (value.length <= 8) return value;
  return `${value.slice(0, 4)}••••${value.slice(-4)}`;
}

Page({
  data: {
    isLoggedIn: false,
    hasCompany: false,
    company: {},
    companyAbbr: '企业',
    maskedCreditCode: '暂未录入',
    certBadge: { text: '', color: '' },
    certCompleted: false,
    member: {},
    canManage: false,
    canCompanyManage: false,
    canVerifyLegal: false,
    canContractTemplate: false,
    canInventory: false,
    memberCount: 0,
    roleCount: 0,
    templateCount: 0,
    companies: [],
    certificationApplications: [],
    onboardingCompanies: [],
    onboardingError: false,
    companyDraft: null,
    currentCompanyId: '',
    todos: [],
    showJoinModal: false,
    joinCode: '',
    showCompanySwitcher: false,
    switchingCompanyId: '',
    companySwitcherListHeight: 0
  },

  onShow() {
    syncTabBar(this, 1);
    const loggedIn = !!(app.globalData.token || wx.getStorageSync('tradepass_token'));
    this.setData({ isLoggedIn: loggedIn });
    if (!loggedIn) return;
    this.loadData();
  },

  onPullDownRefresh() {
    if (!this.data.isLoggedIn) {
      wx.stopPullDownRefresh();
      return;
    }
    this.loadData().finally(() => wx.stopPullDownRefresh());
  },

  async loadData() {
    const sequence = this._loadSequence = (this._loadSequence || 0) + 1;
    let context = captureCompanyContext(app);
    const current = () => sequence === this._loadSequence && isCompanyContextCurrent(app, context);
    this.setData({ companyDraft: readDraft() });
    try {
      const payload = await request({ url: '/me', token: context.token, companyId: context.companyId });
      if (!current()) return;
      app.applyMePayload(payload);
      context = captureCompanyContext(app);
      const certificationApplications = await request({ url: '/me/company-certification-applications',
        token: context.token, withCompany: false }).catch(() => []);
      if (!current()) return;
      await this.loadOnboarding();
      if (!current()) return;
      const company = payload.company || {};
      const member = payload.member || {};
      const companies = payload.companies || [];
      const hasCompany = !!(member && member.roleCode && member.roleCode !== 'GUEST') && companies.length > 0;
      const certStatus = company.certificationStatus || '';
      const permissions = member.permissions || [];
      const canManage = permissions.includes('all') || permissions.includes('member_manage') || permissions.includes('auth_manage');
      const canCompanyManage = permissions.includes('all') || permissions.includes('company_manage');
      const canContractTemplate = permissions.includes('all') || permissions.includes('contract_template');
      const canInventory = permissions.includes('all') || permissions.includes('inventory_view') || hasPerm('inventory_view');
      const currentCompanyId = (payload.user && payload.user.currentCompanyId) || '';
      const companyItems = companies.map(item => ({ ...item, initial: companyAbbr(item.companyName) }));

      this.setData({
        hasCompany,
        company,
        companyAbbr: companyAbbr(company.name),
        maskedCreditCode: maskCreditCode(company.creditCode),
        canContractTemplate,
        canInventory,
        certBadge: dict.certification(certStatus),
        certCompleted: certStatus === 'VERIFIED',
        member,
        canManage,
        canCompanyManage,
        canVerifyLegal: member.memberStatus === 'ACTIVE' && member.roleCode !== 'LEGAL',
        companies: companyItems,
        certificationApplications: (certificationApplications || []).map(item => ({
          ...item,
          statusText: item.status === 'APPROVED' ? '已通过' : item.status === 'REJECTED' ? '已驳回' : '审核中'
        })),
        currentCompanyId
      });
      await Promise.all([
        this.loadTodos(),
        this.loadEnterpriseMetrics(currentCompanyId || company.id, canManage, canContractTemplate)
      ]);
    } catch (e) {}
  },

  async loadOnboarding() {
    const context = captureCompanyContext(app);
    try {
      const companies = await request({ url: '/me/company-onboarding', token: context.token, withCompany: false });
      if (!isCompanyContextCurrent(app, context)) return;
      const draft = readDraft();
      this.setData({
        onboardingError: false,
        companyDraft: draft && !(companies || []).some(item => item.creditCode === draft.creditCode) ? draft : null,
        onboardingCompanies: (companies || []).map(item => ({ ...item,
          statusText: item.certificationStatus === 'REJECTED' ? '认证未通过，点击重新办理'
            : item.certificationStatus === 'PENDING_REVIEW' ? '认证结果待确认，点击继续' : '企业资料已保存，点击继续认证'
        }))
      });
    } catch (error) {
      if (isCompanyContextCurrent(app, context)) this.setData({ onboardingError: true });
    }
  },

  resumeCompany(e) {
    const id = e.currentTarget.dataset.companyId;
    wx.navigateTo({ url: `/pages/company-cert/company-cert?companyId=${encodeURIComponent(id)}&autoSwitch=1&resumePending=1` });
  },

  resumeDraft() { wx.navigateTo({ url: '/pages/company-cert/company-cert?resume=1' }); },

  async loadEnterpriseMetrics(companyId, canManage, canContractTemplate) {
    const context = captureCompanyContext(app);
    if (!companyId) {
      this.setData({ memberCount: 0, roleCount: 0, templateCount: 0 });
      return;
    }
    const safe = (promise, fallback) => promise.catch(() => fallback);
    const [members, roles, templates] = await Promise.all([
      canManage ? safe(request({ url: `/authorizations?companyId=${companyId}&status=ACTIVE&page=1&size=1`, token: context.token, companyId }), { total: 0 }) : Promise.resolve({ total: 0 }),
      canManage ? safe(request({ url: `/roles?companyId=${companyId}`, token: context.token, companyId }), []) : Promise.resolve([]),
      canContractTemplate ? safe(request({ url: '/contract-templates?page=1&size=1', token: context.token, companyId }), { total: 0 }) : Promise.resolve({ total: 0 })
    ]);
    if (!isCompanyContextCurrent(app, context)) return;
    this.setData({
      memberCount: Number(members.total || 0),
      roleCount: (roles || []).length,
      templateCount: Number(templates.total || 0)
    });
  },

  async loadTodos() {
    const context = captureCompanyContext(app);
    try {
      const todos = await request({ url: '/me/todos', token: context.token, companyId: context.companyId });
      if (!isCompanyContextCurrent(app, context)) return;
      const iconMap = {
        APPROVAL: '/images/icons/team.svg',
        CERT: '/images/icons/company.svg',
        CONTRACT: '/images/icons/approval.svg',
        SALES_ORDER: '/images/icons/order.svg'
      };
      const enhanced = (todos || []).map(t => ({ ...t, iconPath: iconMap[t.type] || '/images/icons/contracts.svg' }));
      this.setData({ todos: enhanced });
    } catch (e) {
      if (isCompanyContextCurrent(app, context)) this.setData({ todos: [] });
    }
  },

  goTodo(e) {
    const target = e.currentTarget.dataset.target;
    if (String(target || '').startsWith('sales-order-detail:')) {
      const id = String(target).split(':')[1];
      if (id) wx.navigateTo({ url: `/pages/sales-order-detail/sales-order-detail?id=${id}` });
      return;
    }
    const map = {
      'auth-manage': '/pages/auth-manage/auth-manage',
      'company-cert': '/pages/company-cert/company-cert',
      'contract-approval': '/pages/contract-approval/contract-approval'
    };
    if (map[target]) wx.navigateTo({ url: map[target] });
  },

  switchCompany() {
    const companies = this.data.companies;
    if (companies.length === 0) return;
    setTabBarHidden(this, true);
    this.setData({
      showCompanySwitcher: true,
      switchingCompanyId: '',
      companySwitcherListHeight: Math.min(companies.length, 4) * 150 + 22
    });
  },

  closeCompanySwitcher() {
    if (this.data.switchingCompanyId) return;
    setTabBarHidden(this, false);
    this.setData({ showCompanySwitcher: false });
  },

  async selectCompanyFromSwitcher(e) {
    const companyId = String(e.currentTarget.dataset.companyId || '');
    const company = this.data.companies.find(item => String(item.companyId) === companyId);
    if (!company || this.data.switchingCompanyId) return;
    if (companyId === String(this.data.currentCompanyId)) {
      setTabBarHidden(this, false);
      this.setData({ showCompanySwitcher: false });
      return;
    }
    try {
      this.setData({ switchingCompanyId: companyId });
      await app.switchCompany(companyId);
      setTabBarHidden(this, false);
      this.setData({ showCompanySwitcher: false, switchingCompanyId: '' });
      wx.showToast({ title: '企业已切换', icon: 'success' });
      await this.loadData();
    } catch (error) {
      this.setData({ switchingCompanyId: '' });
      wx.showToast({ title: '切换失败', icon: 'none' });
    }
  },

  goCreateCompany() {
    setTabBarHidden(this, false);
    this.setData({ showCompanySwitcher: false });
    wx.navigateTo({ url: '/pages/company-bind/company-bind' });
  },
  goPhoneLogin() { wx.navigateTo({ url: '/pages/login/login' }); },
  goCert() { wx.navigateTo({ url: '/pages/company-cert/company-cert' }); },
  goLegalVerification() {
    if (!this.data.canVerifyLegal || !this.data.currentCompanyId) return;
    wx.navigateTo({ url: `/pages/legal-representative/legal-representative?companyId=${encodeURIComponent(this.data.currentCompanyId)}` });
  },
  goAuthManage() { wx.navigateTo({ url: '/pages/auth-manage/auth-manage' }); },
  goRoleManage() { wx.navigateTo({ url: '/pages/role-manage/role-manage' }); },
  goContractTemplate() { wx.navigateTo({ url: '/pages/contract-template/contract-template' }); },
  goDocumentTemplate() { wx.navigateTo({ url: '/pages/document-template/document-template' }); },
  goInventory() { wx.navigateTo({ url: '/pages/inventory/inventory' }); },
  goProjectLedger() { wx.navigateTo({ url: '/pages/project-ledger/project-ledger' }); },

  openJoin() { this.setData({ showCompanySwitcher: false, showJoinModal: true, joinCode: '' }); },
  closeJoin() {
    setTabBarHidden(this, false);
    this.setData({ showJoinModal: false });
  },
  onJoinInput(e) { this.setData({ joinCode: e.detail.value }); },
  noop() {},

  async submitJoin() {
    const code = this.data.joinCode.trim();
    if (!code) { wx.showToast({ title: '请输入邀请码', icon: 'none' }); return; }
    try {
      const result = await request({ url: '/companies/join', method: 'POST', data: { code } });
      wx.showToast({ title: result.message || '已提交', icon: 'none' });
      setTabBarHidden(this, false);
      this.setData({ showJoinModal: false });
      app.loadMe().then(() => this.loadData());
    } catch (e) {
      wx.showToast({ title: e.message, icon: 'none' });
    }
  }
});
