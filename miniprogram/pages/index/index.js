const { request } = require('../../utils/request');
const { loadSummary } = require('../../utils/companyOnboarding');
const { setTabBarHidden, syncTabBar } = require('../../utils/tabBar');
const {
  USER_ID_KEY,
  readHomeSnapshot,
  snapshotKey,
  writeHomeSnapshot
} = require('../../utils/homeSnapshot');
const app = getApp();

Page({
  data: {
    role: 'supplier',
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

  onLoad(options) {
    if (!wx.getStorageSync('privacy_agreed')) {
      this.setData({ showPrivacy: true });
      setTabBarHidden(this, true);
    }
    if (options.inviteCode) {
      app.globalData.pendingInvite = { code: options.inviteCode, type: options.type || 'member' };
      this.setData({ joinCompanyId: options.inviteCode, showJoinForm: true });
    }
  },

  async onShow() {
    this.startApprovalPolling();
    syncTabBar(this, 0);
    app.restoreStoredSession();
    const locallyLoggedIn = !!app.globalData.token;
    if (locallyLoggedIn) {
      this.setData({
        isLoggedIn: true,
        currentCompanyId: String(app.getCurrentCompanyId() || '')
      });
      this.restoreHomeSnapshot();
    }
    await app.ensureSessionReady();
    const loggedIn = !!app.globalData.token;
    const user = app.globalData.userInfo;
    if (loggedIn && !user) {
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
    if (!loggedIn) return;
    this.checkMemberStatus();
    this.initRoleFromMember();
    if (this.data.showJoinForm) this.loadOnboardingSummary();
    this.restoreHomeSnapshot({ resetWhenMissing: true });
    this.setData({
      showHomeGuide: !this.data.showJoinForm && !wx.getStorageSync('tradepass_home_guide_done')
    });

    if (loggedIn && user && app.globalData.pendingInvite
        && (app.globalData.pendingInvite.type === 'member' || !this.data.showJoinForm)) {
      const invite = app.globalData.pendingInvite;
      const member = app.globalData.memberInfo;
      if (invite.type === 'counterparty') {
        if (!member || member.roleCode !== 'LEGAL') {
          wx.showModal({
            title: '需要法人身份',
            content: '接受企业合作邀请需要您是公司的法人。请先在“企业”页面完成企业认证。',
            showCancel: false
          });
          return;
        }
      }
      if (invite.type === 'counterparty') {
        if (this._confirmingInvite) return;
        this._confirmingInvite = true;
        const company = (app.globalData.companies || []).find(c => String(c.id) === String(app.getCurrentCompanyId()));
        wx.showModal({
          title: '接受企业合作邀请',
          content: `是否以“${company && company.name || '当前企业'}”建立合作关系？如需使用其他企业，请先取消并切换企业，再打开邀请。`,
          confirmText: '接受邀请',
          success: result => {
            if (result.confirm) this.processInvite(invite.code);
            else app.globalData.pendingInvite = null;
          },
          complete: () => { this._confirmingInvite = false; }
        });
      } else {
        if (this._confirmingInvite) return;
        this._confirmingInvite = true;
        wx.showModal({
          title: '申请加入企业组织',
          content: '是否使用当前账号申请加入邀请方企业？提交后需等待管理员审核并分配角色。',
          confirmText: '申请加入',
          success: result => {
            if (result.confirm) this.processInvite(invite.code);
            else app.globalData.pendingInvite = null;
          },
          complete: () => { this._confirmingInvite = false; }
        });
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
    const snapshot = readHomeSnapshot(context);
    if (!snapshot) {
      if (options.resetWhenMissing) {
        this.homeSnapshotIdentity = null;
        this.setData({
          role: context.role,
          period: context.period,
          periodText: this.periodLabel(context.period),
          companyName: '',
          ranking: [],
          counterparties: [],
          relationCounterparties: [],
          partnerCompanies: [],
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
      partnerCompanies: Array.isArray(payload.partnerCompanies) ? payload.partnerCompanies : [],
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
    this.setData({ homeRefreshing: true, homeRefreshError: '' });
    const results = await Promise.all([
      this.loadHome(),
      this.loadCounterparties(),
      this.loadApprovalIndicator()
    ]);
    if (identity !== snapshotKey(this.homeSnapshotContext())) return;
    const coreUpdated = results[0] === true;
    const fullyUpdated = results.every(result => result === true);
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

  async processInvite(code) {
    if (this._processingInvite) return;
    const user = app.globalData.userInfo;
    if (!user || !user.id) return;
    this._processingInvite = true;
    try {
      const result = await request({
        url: '/companies/join',
        method: 'POST',
        data: { code }
      });
      wx.showToast({ title: result.message || '加入成功', icon: 'success' });
      app.globalData.pendingInvite = null;
      await app.loadMe();
      await this.onShow();
    } catch (e) {
      wx.showToast({ title: e.message, icon: 'none' });
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
    this.setData({ role, period: 'year', periodText: '今年' });
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
    } else if (member.memberStatus === 'PENDING') {
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
    try {
      const result = await request({
        url: '/companies/join',
        method: 'POST',
        data: { code: companyId }
      });
      wx.showToast({ title: result.message, icon: 'success' });
      setTabBarHidden(this, false);
      this.setData({ showJoinModal: false });
      await app.loadMe();
      await this.onShow();
    } catch (e) {
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
    this.homeRequestSeq = (this.homeRequestSeq || 0) + 1;
    const requestSeq = this.homeRequestSeq;
    this.setData({ loading: true });
    try {
      const payload = await request({
        url: `/home/${role}?period=${period}&companyId=${currentCompanyId}`
      });
      if (requestSeq !== this.homeRequestSeq || role !== this.data.role
        || period !== this.data.period
        || String(currentCompanyId) !== String(app.getCurrentCompanyId())) return false;
      const ranking = payload.ranking || [];
      // 计算统计数据
      const totalAmount = ranking.reduce((sum, item) => sum + (item.amount || 0), 0);
      const totalOrders = ranking.reduce((sum, item) => sum + (item.orderCount || 0), 0);
      this.setData({
        companyName: payload.companyName,
        companyDisplayName: payload.companyName || '企业信息加载中',
        ranking,
        rankingTitle: role === 'supplier' ? '客户销售业绩排名' : '采购业绩排名',
        stats: {
          totalAmount: totalAmount.toFixed(0),
          totalOrders,
          counterpartyCount: ranking.length
        }
      });
      this.refreshPartnerCompanies();
      return true;
    } catch (error) {
      if (requestSeq !== this.homeRequestSeq || role !== this.data.role
        || period !== this.data.period) return false;
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
      if (app.globalData.token && app.getCurrentCompanyId() && !this.data.showJoinForm) {
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
    const seen = new Set();
    const partnerCompanies = [];
    relations.forEach(item => {
      const name = item.counterpartyName;
      const counterpartyCompanyId = item.counterpartyCompanyId;
      if (!name || !counterpartyCompanyId || seen.has(String(counterpartyCompanyId))) return;
      seen.add(String(counterpartyCompanyId));
      const rankItem = ranking.find(rank => rank.counterpartyName === name) || {};
      partnerCompanies.push({
        id: item.id,
        counterpartyCompanyId,
        counterpartyName: name,
        initial: name.substring(0, 1),
        status: item.status || 'ACTIVE',
        orderCount: rankItem.orderCount || 0,
        amount: rankItem.amount || 0
      });
    });
    this.setData({
      partnerCompanies,
      'stats.counterpartyCount': partnerCompanies.length
    });
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
    wx.pageScrollTo({ selector: '#partner-section', duration: 260 });
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
  doPrivacyAgree() {
    if (!this.data.privacyAgreed) {
      this.setData({ shaking: true });
      setTimeout(() => this.setData({ shaking: false }), 500);
      return;
    }
    wx.setStorageSync('privacy_agreed', true);
    this.setData({ showPrivacy: false });
    setTabBarHidden(this, false);
  },
  doPrivacyDeny() {
    wx.showModal({
      title: '提示',
      content: '需要同意隐私保护指引才能使用小程序。',
      showCancel: false,
      confirmText: '知道了'
    });
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
      path: `/pages/index/index?inviteCode=${encodeURIComponent(code)}&type=counterparty`
    };
  }
});
