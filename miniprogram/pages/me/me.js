const { request } = require('../../utils/request');
const { loadSummary } = require('../../utils/companyOnboarding');
const { captureCompanyContext, isCompanyContextCurrent } = require('../../utils/companyContext');
const dict = require('../../utils/dict');
const { syncTabBar } = require('../../utils/tabBar');
const app = getApp();

function companyAbbr(name) {
  const clean = (name || '企业').replace(/有限公司|有限责任公司|股份有限公司/g, '');
  return clean.slice(0, 2) || '企业';
}

Page({
  data: {
    isLoggedIn: false,
    user: {},
    userDisplayName: '用户',
    userNameFirst: '用',
    maskedPhone: '',
    memberRoleText: '加载中',
    company: {},
    companyAbbr: '企业',
    companyVerified: false,
    companyStatusText: '未认证',
    realNameVerified: false,
    personalIdentityStatusText: '待实名',
    canManageAuth: false,
    companies: [],
    hasOnboarding: false,
    onboardingName: '',
    onboardingStatus: '',
    currentCompanyId: '',
    devUsers: [{ label: '加载中...' }],
    devUserIndex: 0,
    devOpen: false
  },

  onShow() {
    syncTabBar(this, 2);
    const loggedIn = !!(app.globalData.token || wx.getStorageSync('tradepass_token'));
    const isDev = !!app.globalData.isLocalDevelopment;
    this.setData({ isLoggedIn: loggedIn, isDev });
    if (!loggedIn) return;
    this.loadMe();
    if (isDev) this.loadDevUsers();
  },

  onPullDownRefresh() {
    if (!this.data.isLoggedIn) {
      wx.stopPullDownRefresh();
      return;
    }
    this.loadMe().finally(() => wx.stopPullDownRefresh());
  },

  goLogin() {
    wx.navigateTo({ url: '/pages/login/login' });
  },

  toggleDev() {
    this.setData({ devOpen: !this.data.devOpen });
  },

  async loadMe() {
    const sequence = this._loadSequence = (this._loadSequence || 0) + 1;
    let context = captureCompanyContext(app);
    const current = () => sequence === this._loadSequence && isCompanyContextCurrent(app, context);
    try {
      const payload = await request({ url: '/me', token: context.token, companyId: context.companyId });
      if (!current()) return;
      app.applyMePayload(payload);
      context = captureCompanyContext(app);
      const personalIdentity = await request({ url: '/fadada/users/me/identity', token: context.token, withCompany: false }).catch(() => null);
      if (!current()) return;
      const company = payload.company || {};
      const member = payload.member || {};
      const canManage = member.roleCode === 'LEGAL' || member.roleCode === 'ADMIN';
      const companies = payload.companies || [];
      const onboarding = companies.length ? { hasOnboarding: false } : await loadSummary();
      if (!current()) return;
      const user = payload.user || {};
      const nickname = user.nickname || '用户';
      const phone = user.phone || '';

      // 手机号掩码：188****0001
      let maskedPhone = '';
      if (phone && phone.length >= 11) {
        maskedPhone = phone.substring(0, 3) + '****' + phone.substring(7);
      } else if (phone) {
        maskedPhone = phone;
      }

      this.setData({
        ...onboarding,
        user,
        userDisplayName: nickname,
        userNameFirst: nickname[0] || '用',
        maskedPhone: maskedPhone || '未绑定手机号',
        memberRoleText: member.roleText || '未分配角色',
        company,
        companyAbbr: companyAbbr(company.name),
        companyVerified: company.certificationStatus === 'VERIFIED',
        companyStatusText: dict.certification(company.certificationStatus).text,
        realNameVerified: !!(personalIdentity && personalIdentity.status === 'VERIFIED'),
        personalIdentityStatusText: personalIdentity
          ? (personalIdentity.statusText || '待认证')
          : '待认证',
        companies,
        currentCompanyId: user.currentCompanyId || '',
        canManageAuth: canManage
      });
    } catch (e) {}
  },

  openPersonalInfo() {
    if (!this.data.isLoggedIn) {
      this.goLogin();
      return;
    }
    wx.navigateTo({ url: '/pages/personal-cert/personal-cert' });
  },
  openLegalDocument(e) {
    const type = e.currentTarget.dataset.type || 'user';
    wx.navigateTo({ url: `/pages/legal-document/legal-document?type=${type}` });
  },
  openHelp() {
    wx.navigateTo({ url: '/pages/help-center/help-center' });
  },
  openAbout() {
    wx.navigateTo({ url: '/pages/about/about' });
  },
  openAccountCancel() {
    if (!this.data.isLoggedIn) {
      this.goLogin();
      return;
    }
    wx.navigateTo({ url: '/pages/account-cancel/account-cancel' });
  },
  logout() {
    wx.showModal({
      title: '退出登录',
      content: '退出后不会删除账号、企业或合同数据，确定退出当前账号吗？',
      confirmColor: '#d54d4d',
      success: res => {
        if (res.confirm) app.logout();
      }
    });
  },
  showProfileCode() {
    wx.showModal({
      title: '我的商签通身份',
      content: `用户：${this.data.userDisplayName}\n当前身份：${this.data.memberRoleText}\n企业：${this.data.company.name || '暂未加入企业'}`,
      showCancel: false,
      confirmText: '我知道了'
    });
  },
  goCompanyCenter() {
    wx.switchTab({ url: '/pages/company/company' });
  },

  goAuthManage() {
    wx.navigateTo({ url: '/pages/auth-manage/auth-manage' });
  },
  goRoleManage() {
    wx.navigateTo({ url: '/pages/role-manage/role-manage' });
  },
  goCompanyCert() {
    wx.navigateTo({ url: '/pages/company-cert/company-cert' });
  },

  // ---- Dev ----
  async loadDevUsers() {
    try {
      const list = await request({ url: '/dev/users' });
      const users = (list || []).map(u => ({ label: `${u.name}（${u.roleText}）`, value: u.id }));
      const cur = app.globalData.memberInfo;
      const idx = users.findIndex(u => u.value === (cur && cur.userId));
      this.setData({ devUsers: users, devUserIndex: idx >= 0 ? idx : 0 });
    } catch (e) {}
  },

  async onSwitchUser(e) {
    const user = this.data.devUsers[parseInt(e.detail.value)];
    try {
      await app.switchUser(user.value);
      wx.showToast({ title: '已切换', icon: 'success' });
      this.loadMe();
    } catch (e) { wx.showToast({ title: '切换失败', icon: 'none' }); }
  }
});
