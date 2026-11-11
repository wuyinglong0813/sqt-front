const { request } = require('../../utils/request');
const { loadSummary } = require('../../utils/companyOnboarding');
const { setTabBarHidden, syncTabBar } = require('../../utils/tabBar');
const { hasPrivacyConsent, acceptPrivacyConsent } = require('../../utils/privacy');
const { captureInviteEntry, dismissInvite, markInviteProcessed, processedInviteKey,
  wasInviteProcessed, restoreMemberIdentityInvite, startMemberIdentity,
  isMemberInviteRejected, memberInvitePrerequisite } = require('../../utils/invitation');
const { captureCompanyContext, isCompanyContextCurrent } = require('../../utils/companyContext');
const { memberApplicationData, memberApplicationMethods, startMemberApplicationIdentity } = require('../../utils/memberApplications');
const {
  USER_ID_KEY,
  readHomeSnapshot,
  snapshotKey,
  writeHomeSnapshot
} = require('../../utils/homeSnapshot');
const app = getApp();
const { context: retailContext, sameContext: sameRetailContext, retailRequest, customerView, money } = require('../../utils/retail');

const emptyStandaloneCounterparties = {
  standaloneCounterparties: [],
  standaloneCanCreate: false,
  standaloneLoading: false,
  standaloneError: ''
};

Page({
  ...memberApplicationMethods,
  data: {
    ...memberApplicationData,
    role: 'supplier',
    businessMode: 'partner',
    ...emptyStandaloneCounterparties,
    roleIndex: 0,
    roleOptions: [
      { value: 'supplier', text: '供应商' },
      { value: 'buyer', text: '采购商' }
    ],
    period: 'year',
    periodText: '今年',
    periods: [
      { key: 'year', text: '今年' },
      { key: 'month', text: '本月' },
      { key: 'last12', text: '近12个月' }
    ],
    companyName: '',
    companyDisplayName: '企业信息加载中',
    ranking: [],
    rankingTitle: '客户销售业绩排名',
    loading: false,
    counterparties: [],
    relationCounterparties: [],
    partnerCompanies: [],
    partnerContractCounts: [],
    partnerNetSales: [],
    counterpartiesLoading: false,
    counterpartiesLoaded: false,
    counterpartiesError: '',
    showJoinForm: false,
    hasOnboarding: false,
    onboardingName: '',
    onboardingStatus: '',
    showHomeGuide: false,
    joinCompanyId: '',
    companies: [],
    currentCompanyId: '',
    showCompanySwitcher: false,
    showJoinModal: false,
    switchingCompanyId: '',
    companySwitcherListHeight: 0,
    isLegalPerson: false,
    counterpartyInviteCode: '',
    preparingInvite: false,
    inviteCompanyId: '',
    inviteRole: '',
    counterpartyEmptyBtn: '',
    isLoggedIn: false,
    sessionRestoring: false,
    sessionRestoreError: '',
    homeHasSnapshot: false,
    homeUsingSnapshot: false,
    homeRefreshing: false,
    homeRefreshError: '',
    homeSnapshotTimeText: '',
    userName: '',
    approvalHasMessage: false,

    // 数据统计
    stats: { totalAmount: 0, totalOrders: 0, counterpartyCount: 0 },

    // 隐私协议弹窗
    showPrivacy: false,
    privacyAgreed: false,
    showPrivacyDetail: false,
    shaking: false
  },

  onLoad(options = {}) {
    if (!hasPrivacyConsent()) {
      this.setData({ showPrivacy: true });
      setTabBarHidden(this, true);
    }
    captureInviteEntry(app, options, true);
  },

  async onShow() {
    this._unloaded = false;
    this.startApprovalPolling();
    syncTabBar(this, 0);
    app.restoreStoredSession();
    this.resetMemberApplicationContext();
    const locallyLoggedIn = !!app.globalData.token;
    if (locallyLoggedIn) {
      this.setData({
        isLoggedIn: true,
        currentCompanyId: String(app.getCurrentCompanyId() || ''),
        sessionRestoring: true,
        homeHasSnapshot: false,
        homeUsingSnapshot: false,
        showJoinForm: false
      });
    }
    const awaitingRefresh = !!app._sessionRefresh;
    const restoredSession = await app.ensureSessionReady();
    const loggedIn = !!app.globalData.token;
    const user = app.globalData.userInfo;
    if (loggedIn && !user || loggedIn && awaitingRefresh && !restoredSession) {
      this.setData({
        isLoggedIn: true,
        sessionRestoring: true,
        sessionRestoreError: '',
        showJoinForm: false
      });
      this.scheduleSessionRestore();
      return;
    }
    this.clearSessionRestoreTimer();
    this.setData({
      isLoggedIn: loggedIn,
      sessionRestoring: false,
      sessionRestoreError: '',
      companies: app.globalData.companies || [],
      currentCompanyId: String(app.getCurrentCompanyId() || ''),
      userName: (user && user.nickname) || ''
    });
    if (!loggedIn) {
      this.loadMemberApplications();
      return;
    }
    this.loadMemberApplications();
    this.checkMemberStatus();
    this.initRoleFromMember();
    if (this.data.showJoinForm) this.loadOnboardingSummary();
    this.restoreHomeSnapshot({ resetWhenMissing: true, disabled: this.data.showJoinForm });
    this.setData({
      showHomeGuide: !this.data.showJoinForm && !wx.getStorageSync('tradepass_home_guide_done')
    });

    restoreMemberIdentityInvite(app);
    if (wasInviteProcessed(app, app.globalData.pendingInvite)) {
      const invite = app.globalData.pendingInvite;
      dismissInvite(app, invite);
      if (invite.explicitEntry) wx.showModal({
        title: '邀请已处理',
        content: invite.type === 'member'
          ? '你已处理过此邀请。如已提交加入申请，请等待企业管理员审核。'
          : '你已处理过此邀请，可在首页查看企业合作关系。',
        showCancel: false
      });
    }
    if (!this._processingInvite && loggedIn && user && app.globalData.pendingInvite
        && (app.globalData.pendingInvite.type === 'member' || !this.data.showJoinForm)) {
      const invite = app.globalData.pendingInvite;
      const member = app.globalData.memberInfo;
      const context = captureCompanyContext(app);
      if (invite.type === 'counterparty') {
        if (!member || member.roleCode !== 'LEGAL') {
          wx.showModal({
            title: '需要法人身份',
            content: '接受企业合作邀请需要您是公司的法人。请先在“企业”页面完成企业认证。',
            showCancel: false,
            success: () => dismissInvite(app, invite)
          });
          return;
        }
      }
      if (invite.type === 'counterparty') {
        if (this._confirmingInvite === invite) return;
        this._confirmingInvite = invite;
        const company = (app.globalData.companies || []).find(c => String(c.companyId) === String(app.getCurrentCompanyId()));
        wx.showModal({
          title: '接受企业合作邀请',
          content: `是否以“${company && company.companyName || '当前企业'}”建立合作关系？如需使用其他企业，请先取消并切换企业，再打开邀请。`,
          confirmText: '接受邀请',
          success: result => {
            if (app.globalData.pendingInvite !== invite) return;
            if (result.confirm && isCompanyContextCurrent(app, context)) this.processInvite(invite.code, invite);
            else dismissInvite(app, invite);
          },
          fail: () => this.inviteModalFailed(invite, context),
          complete: () => { if (this._confirmingInvite === invite) this._confirmingInvite = null; }
        });
      } else {
        if (this._confirmingInvite === invite) return;
        this._confirmingInvite = invite;
        try {
          const preview = await request({ url: `/companies/invitations/${encodeURIComponent(invite.code)}`, withCompany: false });
          if (!isCompanyContextCurrent(app, context) || app.globalData.pendingInvite !== invite) {
            if (this._confirmingInvite === invite) this._confirmingInvite = null;
            return;
          }
          if (!preview || !preview.companyName || preview.type !== 'member') throw new Error('邀请信息已变化，请联系邀请人重新发送邀请');
          wx.showModal({
            title: '申请加入企业组织',
            content: preview.invitationMode === 'OPEN'
              ? `申请加入“${preview.companyName}”。提交后请完成个人实名认证，管理员审核并分配角色后才能访问企业业务。`
              : preview.phoneBindingRequired
              ? `此邀请仅供绑定手机号 ${preview.targetPhoneMasked || '受邀号码'} 的账号使用。请先通过微信核验手机号，完成实名后继续申请加入“${preview.companyName}”。`
              : preview.personalIdentityRequired
              ? `加入“${preview.companyName}”前需要完成个人实名认证。邀请码已保留，认证后可继续提交加入申请。`
              : `是否使用当前账号（${preview.targetPhoneMasked || '已核验的受邀手机号'}）申请加入“${preview.companyName}”？提交后需等待该企业管理员审核并分配角色。`,
            confirmText: preview.invitationMode === 'OPEN' ? '提交申请'
              : preview.phoneBindingRequired ? '核验号码' : preview.personalIdentityRequired ? '实名认证' : '申请加入',
            success: result => {
              if (app.globalData.pendingInvite !== invite) return;
              if (result.confirm && isCompanyContextCurrent(app, context)) {
                if (preview.invitationMode === 'OPEN') this.processInvite(invite.code, invite);
                else if (preview.personalIdentityRequired || preview.phoneBindingRequired) startMemberIdentity(app, invite.code);
                else this.processInvite(invite.code, invite);
              }
              else dismissInvite(app, invite);
            },
            fail: () => this.inviteModalFailed(invite, context),
            complete: () => { if (this._confirmingInvite === invite) this._confirmingInvite = null; }
          });
        } catch (error) {
          if (this._confirmingInvite === invite) this._confirmingInvite = null;
          if (!isCompanyContextCurrent(app, context) || app.globalData.pendingInvite !== invite) return;
          if (isMemberInviteRejected(error) || ['邀请码无效', '邀请码已被使用', '邀请码已过期'].includes(error.message)) dismissInvite(app, invite);
          if (isMemberInviteRejected(error)) {
            wx.showModal({ title: '此邀请无法使用', content: error.message || '此邀请仅限指定受邀人使用，请联系邀请人。', showCancel: false });
            return;
          }
          wx.showToast({ title: error.message || '邀请企业加载失败，请重新打开邀请', icon: 'none' });
        }
      }
      return;
    }

    if (!this.data.showJoinForm) {
      this.refreshHomeData();
    }
  },

  homeSnapshotContext(overrides = {}) {
    const user = app.globalData.userInfo || {};
    const userId = String(overrides.userId || user.id || wx.getStorageSync(USER_ID_KEY) || '');
    const companyId = String(overrides.companyId || app.getCurrentCompanyId()
      || wx.getStorageSync('tradepass_company_id') || '');
    const storedRole = companyId ? wx.getStorageSync(`tradepass_role_${companyId}`) : '';
    const role = overrides.role
      || (storedRole === 'supplier' || storedRole === 'buyer' ? storedRole : this.data.role);
    const periodKey = `tradepass_home_period_${userId}_${companyId}_${role}`;
    const storedPeriod = wx.getStorageSync(periodKey);
    const period = overrides.period
      || (['year', 'month', 'last12'].includes(storedPeriod) ? storedPeriod : this.data.period);
    return { userId, companyId, role, period };
  },

  async loadOnboardingSummary() {
    const token = app.globalData.token;
    const summary = await loadSummary();
    if (token === app.globalData.token) this.setData(summary);
  },

  goOnboardingCenter() { wx.switchTab({ url: '/pages/company/company' }); },

  periodLabel(period) {
    return { year: '今年', month: '本月', last12: '近12个月' }[period] || '今年';
  },

  snapshotTimeText(updatedAt) {
    const value = new Date(Number(updatedAt));
    if (Number.isNaN(value.getTime())) return '';
    const pad = number => String(number).padStart(2, '0');
    const now = new Date();
    const time = `${pad(value.getHours())}:${pad(value.getMinutes())}`;
    return value.toDateString() === now.toDateString()
      ? `今天 ${time}` : `${pad(value.getMonth() + 1)}-${pad(value.getDate())} ${time}`;
  },

  restoreHomeSnapshot(options = {}) {
    const context = this.homeSnapshotContext(options);
    const keepStandalone = !options.disabled && this.data.businessMode === 'standalone'
      && context.role === this.standaloneRole && sameRetailContext(this.standaloneCompany);
    const businessMode = keepStandalone ? 'standalone' : 'partner';
    const snapshot = options.disabled ? null : readHomeSnapshot(context);
    this.standaloneRequestSeq = (this.standaloneRequestSeq || 0) + 1;
    if (!snapshot) {
      if (options.resetWhenMissing) {
        this.homeSnapshotIdentity = null;
        this.setData({
          role: context.role,
          businessMode,
          period: context.period,
          periodText: this.periodLabel(context.period),
          companyName: '',
          companyDisplayName: '企业信息加载中',
          ranking: [],
          counterparties: [],
          relationCounterparties: [],
          partnerCompanies: [],
          partnerContractCounts: [],
          partnerNetSales: [],
          ...emptyStandaloneCounterparties,
          counterpartiesLoaded: false,
          counterpartiesError: '',
          stats: { totalAmount: 0, totalOrders: 0, counterpartyCount: 0 },
          approvalHasMessage: false,
          homeHasSnapshot: false,
          homeUsingSnapshot: false,
          homeSnapshotTimeText: ''
        });
      }
      return false;
    }
    const payload = snapshot.payload || {};
    this.homeSnapshotIdentity = snapshotKey(context);
    this.setData({
      role: context.role,
      businessMode,
      period: context.period,
      periodText: this.periodLabel(context.period),
      companyName: payload.companyName || '',
      companyDisplayName: payload.companyDisplayName || this.data.companyDisplayName,
      ranking: Array.isArray(payload.ranking) ? payload.ranking : [],
      rankingTitle: payload.rankingTitle
        || (context.role === 'supplier' ? '客户销售业绩排名' : '采购业绩排名'),
      stats: payload.stats || { totalAmount: 0, totalOrders: 0, counterpartyCount: 0 },
      counterparties: Array.isArray(payload.counterparties) ? payload.counterparties : [],
      relationCounterparties: Array.isArray(payload.relationCounterparties)
        ? payload.relationCounterparties : [],
      partnerCompanies: (Array.isArray(payload.partnerCompanies) ? payload.partnerCompanies : [])
        .map(item => ({ ...item, netAmountText: item.netAmountText || '—' })),
      partnerContractCounts: Array.isArray(payload.partnerContractCounts) ? payload.partnerContractCounts : [],
      partnerNetSales: Array.isArray(payload.partnerNetSales) ? payload.partnerNetSales : [],
      ...emptyStandaloneCounterparties,
      counterpartiesLoaded: true,
      approvalHasMessage: !!payload.approvalHasMessage,
      loading: false,
      showJoinForm: false,
      homeHasSnapshot: true,
      homeUsingSnapshot: true,
      homeRefreshError: '',
      homeSnapshotTimeText: this.snapshotTimeText(snapshot.updatedAt)
    });
    return true;
  },

  saveHomeSnapshot() {
    const context = this.homeSnapshotContext();
    const snapshot = writeHomeSnapshot(context, {
      companyName: this.data.companyName,
      companyDisplayName: this.data.companyDisplayName,
      ranking: this.data.ranking || [],
      rankingTitle: this.data.rankingTitle,
      stats: this.data.stats,
      counterparties: this.data.counterparties || [],
      relationCounterparties: this.data.relationCounterparties || [],
      partnerCompanies: this.data.partnerCompanies || [],
      partnerContractCounts: this.data.partnerContractCounts || [],
      partnerNetSales: this.data.partnerNetSales || [],
      approvalHasMessage: !!this.data.approvalHasMessage
    });
    if (!snapshot) return;
    this.homeSnapshotIdentity = snapshotKey(context);
    this.setData({
      homeHasSnapshot: true,
      homeSnapshotTimeText: this.snapshotTimeText(snapshot.updatedAt)
    });
  },

  async refreshHomeData() {
    const identity = snapshotKey(this.homeSnapshotContext());
    if (!identity) return;
    const companyContext = captureCompanyContext(app);
    const refreshSeq = this.homeRefreshSeq = (this.homeRefreshSeq || 0) + 1;
    this.setData({ homeRefreshing: true, homeRefreshError: '' });
    const results = await Promise.all([
      this.loadHome(),
      this.loadCounterparties(),
      this.loadApprovalIndicator(),
      this.data.businessMode === 'standalone' ? this.loadStandaloneCounterparties() : true
    ]);
    if (refreshSeq !== this.homeRefreshSeq || identity !== snapshotKey(this.homeSnapshotContext())
      || !isCompanyContextCurrent(app, companyContext)) return;
    const coreUpdated = results[0] === true;
    const fullyUpdated = results.slice(0, 3).every(result => result === true);
    if (coreUpdated && results[1] === true) this.saveHomeSnapshot();
    this.setData({
      homeRefreshing: false,
      homeUsingSnapshot: !fullyUpdated && this.data.homeHasSnapshot,
      homeRefreshError: fullyUpdated ? '' : (this.data.homeHasSnapshot
        ? '部分数据暂未更新，当前显示上次成功数据'
        : '首页数据加载失败，请点击重试')
    });
  },

  scheduleSessionRestore() {
    if (this.sessionRestoreTimer || this.sessionRestoreInFlight) return;
    this.sessionRestoreTimer = setTimeout(() => {
      this.sessionRestoreTimer = null;
      this.retrySessionRestore();
    }, 1200);
  },

  clearSessionRestoreTimer() {
    if (!this.sessionRestoreTimer) return;
    clearTimeout(this.sessionRestoreTimer);
    this.sessionRestoreTimer = null;
  },

  async retrySessionRestore() {
    if (this.sessionRestoreInFlight || !app.globalData.token) return;
    this.sessionRestoreInFlight = true;
    this.setData({ sessionRestoring: true, sessionRestoreError: '' });
    const payload = await app.refreshSession();
    this.sessionRestoreInFlight = false;
    if (payload && app.globalData.userInfo) {
      await this.onShow();
      return;
    }
    this.setData({
      sessionRestoring: true,
      sessionRestoreError: '企业信息恢复失败，请检查网络后重新加载',
      homeUsingSnapshot: this.data.homeHasSnapshot,
      homeRefreshError: this.data.homeHasSnapshot ? '网络暂不可用，当前显示上次成功数据' : ''
    });
  },

  onHide() {
    this.stopApprovalPolling();
    this.clearSessionRestoreTimer();
  },

  onUnload() {
    this._unloaded = true;
    this.stopApprovalPolling();
    this.clearSessionRestoreTimer();
  },

  /* 下拉刷新 */
  onPullDownRefresh() {
    if (!this.data.isLoggedIn) {
      wx.stopPullDownRefresh();
      return;
    }
    if (!this.data.showJoinForm) {
      this.refreshHomeData().finally(() => wx.stopPullDownRefresh());
    } else {
      wx.stopPullDownRefresh();
    }
  },

  inviteModalFailed(invite, context) {
    if (this._confirmingInvite === invite) this._confirmingInvite = null;
    if (app.globalData.pendingInvite === invite && isCompanyContextCurrent(app, context)) {
      wx.showToast({ title: '邀请提示未打开，请重试', icon: 'none' });
    }
  },

  async processInvite(code, invite = app.globalData.pendingInvite) {
    if (this._processingInvite) return;
    const user = app.globalData.userInfo;
    if (!user || !user.id) return;
    const context = captureCompanyContext(app);
    const historyKey = processedInviteKey(app, invite);
    this._processingInvite = true;
    try {
      const result = await request({
        url: '/companies/join',
        method: 'POST',
        withCompany: !invite || invite.type !== 'member',
        data: { code }
      });
      markInviteProcessed(app, invite, historyKey);
      if (!isCompanyContextCurrent(app, context)) return;
      if (result.status === 'PENDING_IDENTITY' && result.applicationId) {
        this.loadMemberApplications();
        startMemberApplicationIdentity(app, result.applicationId);
        return;
      }
      wx.showToast({ title: result.message || '加入成功', icon: 'success' });
      await app.loadMe();
      await this.onShow();
    } catch (e) {
      if (memberInvitePrerequisite(e) && invite && invite.type === 'member' && isCompanyContextCurrent(app, context)) {
        startMemberIdentity(app, code);
        return;
      }
      if (isMemberInviteRejected(e) || ['邀请码无效', '邀请码已被使用', '邀请码已过期', '你已是该企业成员', '申请已提交，等待审批'].includes(e.message)) {
        dismissInvite(app, invite);
      }
      if (isCompanyContextCurrent(app, context)) wx.showToast({ title: e.message, icon: 'none' });
      // Keep the invitation available after a transient request failure.
    } finally {
      this._processingInvite = false;
    }
  },

  /* 公司切换 */
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

  openJoin() {
    this.setData({ showCompanySwitcher: false, showJoinModal: true, joinCompanyId: '' });
  },

  closeJoin() {
    setTabBarHidden(this, false);
    this.setData({ showJoinModal: false });
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
      const meData = await app.switchCompany(company.companyId);
      this.setData({
        companyDisplayName: (meData.company && meData.company.name) || company.companyName,
        companies: meData.companies || [],
        currentCompanyId: companyId,
        role: meData.member && meData.member.roleCode === 'PURCHASER' ? 'buyer' : 'supplier',
        businessMode: 'partner',
        showCompanySwitcher: false,
        switchingCompanyId: ''
      });
      setTabBarHidden(this, false);
      this.initRoleFromMember();
      this.restoreHomeSnapshot({ resetWhenMissing: true });
      await this.refreshHomeData();
      wx.showToast({ title: '企业已切换', icon: 'success' });
    } catch (e) {
      this.setData({ switchingCompanyId: '' });
      wx.showToast({ title: '切换失败', icon: 'none' });
    }
  },

  /* 角色切换（Tab 点击）*/
  switchRole(e) {
    const role = e.currentTarget.dataset.role;
    if (role === this.data.role) return;
    this.setData({ role, businessMode: 'partner', period: 'year', periodText: '今年' });
    const companyId = app.getCurrentCompanyId() || 'unbound';
    wx.setStorageSync(`tradepass_role_${companyId}`, role);
    const context = this.homeSnapshotContext({ role, period: 'year' });
    wx.setStorageSync(
      `tradepass_home_period_${context.userId}_${context.companyId}_${context.role}`,
      'year'
    );
    this.restoreHomeSnapshot({ role, period: 'year', resetWhenMissing: true });
    this.refreshHomeData();
  },

  /* 时期切换 */
  switchPeriod(e) {
    const period = e.currentTarget.dataset.period;
    if (period === this.data.period) return;
    const periodTextMap = { year: '今年', month: '本月', last12: '近12个月' };
    this.setData({ period, periodText: periodTextMap[period] || '' });
    const context = this.homeSnapshotContext({ period });
    wx.setStorageSync(
      `tradepass_home_period_${context.userId}_${context.companyId}_${context.role}`,
      period
    );
    this.restoreHomeSnapshot({ period, resetWhenMissing: true });
    this.refreshHomeData();
  },

  checkMemberStatus() {
    const member = app.globalData.memberInfo;
    const isLegal = member && member.roleCode === 'LEGAL';
    this.setData({ isLegalPerson: !!isLegal, counterpartyEmptyBtn: isLegal ? '邀请供方' : '' });
    if (!member || member.memberStatus === 'NONE' || !member.roleCode || member.roleCode === 'GUEST') {
      this.setData({ showJoinForm: true });
    } else if (member.memberStatus === 'PENDING' || member.memberStatus === 'PENDING_IDENTITY') {
      this.setData({ showJoinForm: true });
    } else {
      this.setData({ showJoinForm: false });
    }
  },

  onJoinIdInput(event) {
    this.setData({ joinCompanyId: event.detail.value });
  },

  async joinCompany() {
    const companyId = this.data.joinCompanyId.trim();
    if (!companyId) { wx.showToast({ title: '请输入邀请码', icon: 'none' }); return; }
    const user = app.globalData.userInfo;
    if (!user || !user.id) {
      setTabBarHidden(this, false);
      this.setData({ showJoinModal: false });
      this.goLogin();
      return;
    }
    const joinToken = app.globalData.token;
    try {
      const result = await request({
        url: '/companies/join',
        method: 'POST',
        data: { code: companyId }
      });
      if (joinToken !== app.globalData.token) return;
      wx.showToast({ title: result.message, icon: 'success' });
      setTabBarHidden(this, false);
      this.setData({ showJoinModal: false });
      if (result.status === 'PENDING_IDENTITY' && result.applicationId) {
        this.loadMemberApplications();
        startMemberApplicationIdentity(app, result.applicationId);
        return;
      }
      await app.loadMe();
      await this.onShow();
    } catch (e) {
      if (memberInvitePrerequisite(e) && joinToken === app.globalData.token) {
        setTabBarHidden(this, false);
        this.setData({ showJoinModal: false });
        startMemberIdentity(app, companyId);
        return;
      }
      wx.showToast({ title: e.message, icon: 'none' });
    }
  },

  initRoleFromMember() {
    const companyId = app.getCurrentCompanyId() || 'unbound';
    const savedRole = wx.getStorageSync(`tradepass_role_${companyId}`);
    if (savedRole === 'supplier' || savedRole === 'buyer') {
      this.setData({ role: savedRole });
      return;
    }
    const member = app.globalData.memberInfo;
    if (!member) return;
    if (member.roleCode === 'SALES') this.setData({ role: 'supplier' });
    else if (member.roleCode === 'PURCHASER') this.setData({ role: 'buyer' });
  },

  async loadHome() {
    const role = this.data.role;
    const period = this.data.period;
    const currentCompanyId = app.getCurrentCompanyId();
    if (!currentCompanyId) return false;
    const companyContext = captureCompanyContext(app);
    this.homeRequestSeq = (this.homeRequestSeq || 0) + 1;
    const requestSeq = this.homeRequestSeq;
    const isCurrent = () => requestSeq === this.homeRequestSeq && role === this.data.role
      && period === this.data.period && String(currentCompanyId) === String(app.getCurrentCompanyId())
      && isCompanyContextCurrent(app, companyContext);
    this.setData({ loading: true });
    try {
      const payload = await request({
        url: `/home/${role}?period=${period}&companyId=${currentCompanyId}`
      });
      if (!isCurrent()) return false;
      const ranking = payload.ranking || [];
      // 计算统计数据
      const totalAmount = ranking.reduce((sum, item) => sum + Number(item.amount || 0), 0);
      const totalOrders = ranking.reduce((sum, item) => sum + (item.orderCount || 0), 0);
      this.setData({
        companyName: payload.companyName,
        companyDisplayName: payload.companyName || '企业信息加载中',
        ranking,
        partnerContractCounts: payload.partnerContractCounts || [],
        partnerNetSales: (payload.stats && payload.stats.partnerNetSales) || [],
        rankingTitle: role === 'supplier' ? '客户销售业绩排名' : '采购业绩排名',
        stats: {
          totalAmount: money(payload.stats && payload.stats.totalAmount !== undefined ? payload.stats.totalAmount : totalAmount.toFixed(2)),
          totalOrders: payload.stats ? Number(payload.stats.totalOrders || 0) : totalOrders,
          counterpartyCount: ranking.length,
          partnerAmount: money(payload.stats ? payload.stats.partnerAmount : totalAmount.toFixed(2)),
          retailAmount: money(payload.stats ? payload.stats.retailAmount : 0),
          quickPurchaseAmount: money(payload.stats ? payload.stats.quickPurchaseAmount : 0),
          returnAmount: money(payload.stats ? payload.stats.returnAmount : 0),
          netSalesAmount: money(payload.stats ? payload.stats.netSalesAmount : totalAmount.toFixed(2)),
          retailCustomerCount: payload.stats ? Number(payload.stats.retailCustomerCount || 0) : 0,
          quickPurchaseSupplierCount: payload.stats ? Number(payload.stats.quickPurchaseSupplierCount || 0) : 0
        }
      });
      this.refreshPartnerCompanies();
      return true;
    } catch (error) {
      if (!isCurrent()) return false;
      if (!this.data.homeHasSnapshot) {
        wx.showToast({ title: error.message, icon: 'none' });
      }
      return false;
    } finally {
      if (requestSeq === this.homeRequestSeq) this.setData({ loading: false });
    }
  },

  async loadCounterparties() {
    const role = this.data.role;
    const companyId = app.getCurrentCompanyId();
    if (!companyId) return false;
    this.counterpartyRequestSeq = (this.counterpartyRequestSeq || 0) + 1;
    const requestSeq = this.counterpartyRequestSeq;
    this.setData({ counterpartiesLoading: true, counterpartiesError: '' });
    try {
      const list = await request({ url: `/counterparties?companyId=${companyId}&role=${role}` });
      if (requestSeq !== this.counterpartyRequestSeq || role !== this.data.role
        || String(companyId) !== String(app.getCurrentCompanyId())) return false;
      this.setData({ counterparties: list || [], relationCounterparties: list || [], counterpartiesLoaded: true });
      this.refreshPartnerCompanies();
      return true;
    } catch (error) {
      if (requestSeq !== this.counterpartyRequestSeq || role !== this.data.role
        || String(companyId) !== String(app.getCurrentCompanyId())) return false;
      this.setData({ counterparties: [], relationCounterparties: [],
        counterpartiesError: error.message || '合作企业加载失败，请重试' });
      this.refreshPartnerCompanies();
      return false;
    } finally {
      if (requestSeq === this.counterpartyRequestSeq) this.setData({ counterpartiesLoading: false });
    }
  },

  startApprovalPolling() {
    this.stopApprovalPolling();
    this.approvalPageVisible = true;
    const generation = this.approvalPollGeneration;
    const tick = async () => {
      if (!this.approvalPageVisible || generation !== this.approvalPollGeneration) return;
      if (app.globalData.token && app.getCurrentCompanyId() && !this.data.showJoinForm && !this.data.sessionRestoring) {
        await this.loadApprovalIndicator();
      }
      if (this.approvalPageVisible && generation === this.approvalPollGeneration) this.approvalTimer = setTimeout(tick, 10000);
    };
    this.approvalTimer = setTimeout(tick, 10000);
  },

  stopApprovalPolling() {
    this.approvalPageVisible = false;
    this.approvalPollGeneration = (this.approvalPollGeneration || 0) + 1;
    clearTimeout(this.approvalTimer);
    this.approvalTimer = null;
    this.approvalRequestSeq = (this.approvalRequestSeq || 0) + 1;
  },

  async loadApprovalIndicator() {
    const companyId = app.getCurrentCompanyId();
    if (!companyId) {
      this.setData({ approvalHasMessage: false });
      return false;
    }
    this.approvalRequestSeq = (this.approvalRequestSeq || 0) + 1;
    const requestSeq = this.approvalRequestSeq;
    try {
      const summary = await request({ url: '/approvals/summary' });
      if (requestSeq !== this.approvalRequestSeq
        || String(companyId) !== String(app.getCurrentCompanyId())) return false;
      this.setData({ approvalHasMessage: !!(summary && summary.hasMessage) });
      return true;
    } catch (error) {
      if (requestSeq !== this.approvalRequestSeq) return false;
      if (!this.data.homeHasSnapshot) this.setData({ approvalHasMessage: false });
      return false;
    }
  },

  refreshPartnerCompanies() {
    const ranking = this.data.ranking || [];
    const relations = this.data.relationCounterparties || [];
    const netSales = new Map((this.data.partnerNetSales || [])
      .map(item => [String(item.counterpartyCompanyId), item.netAmount]));
    const contractCounts = new Map((this.data.partnerContractCounts || [])
      .map(item => [String(item.counterpartyCompanyId), Number(item.contractCount) || 0]));
    const seen = new Set();
    const partnerCompanies = [];
    relations.forEach(item => {
      const name = item.counterpartyName;
      const counterpartyCompanyId = item.counterpartyCompanyId;
      if (!name || !counterpartyCompanyId || seen.has(String(counterpartyCompanyId))) return;
      seen.add(String(counterpartyCompanyId));
      const rankItem = ranking.find(rank => rank.counterpartyCompanyId
        ? String(rank.counterpartyCompanyId) === String(counterpartyCompanyId) : rank.counterpartyName === name) || {};
      partnerCompanies.push({
        id: item.id,
        counterpartyCompanyId,
        counterpartyName: name,
        initial: name.substring(0, 1),
        status: item.status || 'ACTIVE',
        contractCount: contractCounts.get(String(counterpartyCompanyId)) || 0,
        orderCount: rankItem.orderCount || 0,
        amount: rankItem.amount || 0,
        netAmount: netSales.get(String(counterpartyCompanyId)) || 0
      });
    });
    partnerCompanies.sort((a, b) => Number(b.netAmount) - Number(a.netAmount));
    partnerCompanies.forEach(item => { item.netAmountText = money(item.netAmount); });
    this.setData({
      partnerCompanies,
      'stats.counterpartyCount': partnerCompanies.length
    });
  },

  async loadStandaloneCounterparties() {
    const company = retailContext();
    if (!company.companyId || !company.token) return false;
    const role = this.data.role;
    this.standaloneCompany = company;
    this.standaloneRole = role;
    const seq = this.standaloneRequestSeq = (this.standaloneRequestSeq || 0) + 1;
    const isCurrent = () => !this._unloaded && seq === this.standaloneRequestSeq
      && this.data.role === role && this.data.businessMode === 'standalone' && sameRetailContext(company);
    this.setData({ standaloneLoading: true, standaloneError: '' });
    try {
      const payload = await retailRequest(company, { url: `/retail/customers?page=1&size=5${this.standaloneDirectionQuery('&')}` });
      if (!isCurrent()) return false;
      this.setData({
        standaloneCounterparties: (payload.items || []).map(customerView),
        standaloneCanCreate: !!payload.canCreate
      });
      return true;
    } catch (e) {
      if (isCurrent()) this.setData({
        standaloneCounterparties: [],
        standaloneCanCreate: false,
        standaloneError: e.message
      });
      return false;
    } finally {
      if (isCurrent()) this.setData({ standaloneLoading: false });
    }
  },
  switchBusinessMode(e) {
    const businessMode = e.currentTarget.dataset.mode === 'standalone' ? 'standalone' : 'partner';
    if (businessMode === this.data.businessMode) return;
    this.setData({ businessMode });
    if (businessMode === 'standalone') return this.loadStandaloneCounterparties();
  },
  standaloneDirectionQuery(separator) {
    return this.data.role === 'buyer' ? `${separator}direction=PURCHASE` : '';
  },
  addStandaloneCounterparty() {
    wx.navigateTo({ url: `/pages/retail-customers/retail-customers?create=1${this.standaloneDirectionQuery('&')}` });
  },
  allStandaloneCounterparties() {
    wx.navigateTo({ url: `/pages/retail-customers/retail-customers${this.standaloneDirectionQuery('?')}` });
  },
  openStandaloneCounterparty(e) {
    const id = encodeURIComponent(e.currentTarget.dataset.id);
    wx.navigateTo({ url: `/pages/retail-customer-detail/retail-customer-detail?id=${id}${this.standaloneDirectionQuery('&')}` });
  },

  goLogin() {
    wx.navigateTo({ url: '/pages/login/login' });
  },

  requireLogin() {
    const loggedIn = !!(app.globalData.token || wx.getStorageSync('tradepass_token'));
    if (loggedIn) return true;
    this.goLogin();
    return false;
  },

  openCounterparty(e) {
    if (!this.requireLogin()) return;
    const name = e.currentTarget.dataset.name;
    const requestedCompanyId = e.currentTarget.dataset.companyId || '';
    const matched = (this.data.partnerCompanies || []).find(item => item.counterpartyName === name);
    const counterpartyCompanyId = requestedCompanyId || (matched && matched.counterpartyCompanyId) || '';
    wx.navigateTo({
      url: `/pages/order-detail/order-detail?counterpartyName=${encodeURIComponent(name)}&counterpartyCompanyId=${encodeURIComponent(counterpartyCompanyId)}&role=${this.data.role}`
    });
  },

  openWorkbench(e) {
    if (!this.requireLogin()) return;
    const key = e.currentTarget.dataset.key;
    const routes = {
      approval: '/pages/contract-approval/contract-approval',
      inventory: '/pages/inventory/inventory',
      contracts: '/pages/contract-center/contract-center',
      reconciliation: '/pages/reconciliation/reconciliation'
    };
    if (routes[key]) wx.navigateTo({ url: routes[key] });
  },

  completeHomeGuide() {
    wx.setStorageSync('tradepass_home_guide_done', true);
    this.setData({ showHomeGuide: false });
    wx.pageScrollTo({ selector: '#home-business-tabs', duration: 260 });
  },

  goCreateCompany() {
    if (!this.requireLogin()) return;
    setTabBarHidden(this, false);
    this.setData({ showCompanySwitcher: false });
    wx.navigateTo({ url: '/pages/company-bind/company-bind' });
  },

  addCounterparty() {
    if (this.data.preparingInvite) return;
    if (!this.requireLogin()) return;
    const member = app.globalData.memberInfo;
    if (!member || member.roleCode !== 'LEGAL') {
      wx.showToast({ title: '仅法人可邀请合作企业', icon: 'none' });
      return;
    }
    const cid = app.getCurrentCompanyId();
    if (!cid) {
      wx.showToast({ title: '请先选择企业', icon: 'none' });
      return;
    }
    const role = this.data.role;
    this.setData({ preparingInvite: true, counterpartyInviteCode: '' });
    return request({
      url: '/companies/counterparty-invite',
      method: 'POST',
      data: { companyId: cid, relationRole: this.data.role }
    }).then(result => {
      this.setData({ counterpartyInviteCode: result.code, inviteCompanyId: String(cid), inviteRole: role });
      wx.showToast({ title: '邀请已生成，请点击发送', icon: 'none' });
    }).catch(e => {
      wx.showToast({ title: e.message, icon: 'none' });
    }).finally(() => this.setData({ preparingInvite: false }));
  },

  // ===== 隐私协议弹窗 =====
  togglePrivacyAgree() {
    this.setData({ privacyAgreed: !this.data.privacyAgreed });
  },
  async doPrivacyAgree() {
    if (!this.data.privacyAgreed) {
      this.setData({ shaking: true });
      setTimeout(() => this.setData({ shaking: false }), 500);
      return;
    }
    try {
      await acceptPrivacyConsent();
    } catch (error) {
      wx.showToast({ title: error.message, icon: 'none' });
      return;
    }
    this.setData({ showPrivacy: false });
    setTabBarHidden(this, false);
  },
  doPrivacyDeny() {
    this.setData({ showPrivacy: false, showPrivacyDetail: false, privacyAgreed: false });
    setTabBarHidden(this, false);
  },
  showPrivacyDetail() {
    this.setData({ showPrivacyDetail: true });
  },
  closePrivacyDetail() {
    this.setData({ showPrivacyDetail: false });
  },
  noop() {},

  onShareAppMessage(event) {
    const code = this.data.counterpartyInviteCode;
    if (!code || !event || event.from !== 'button'
        || !event.target || !event.target.dataset || event.target.dataset.inviteType !== 'counterparty'
        || this.data.inviteCompanyId !== String(app.getCurrentCompanyId())
        || this.data.inviteRole !== this.data.role) return { title: '商签通', path: '/pages/index/index' };
    return {
      title: '邀请你在商签通建立企业合作关系',
      imageUrl: '/images/company-invite-cover.png',
      path: `/pages/invitation/invitation?inviteCode=${encodeURIComponent(code)}&type=counterparty`
    };
  }
});
