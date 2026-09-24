const { request, clearSession } = require('./utils/request');
const { wechatLogin } = require('./utils/wechatLogin');
const { USER_ID_KEY, clearCompanyHomeSnapshots } = require('./utils/homeSnapshot');
const { captureCompanyContext, isCompanyContextCurrent } = require('./utils/companyContext');

// 默认连接服务器；仅本地联调时设为 true，且只在开发者工具中生效。
const USE_LOCAL_BACKEND = false;
const LOCAL_API = 'http://127.0.0.1:9999/api';
// 业务请求和文件上传共用 HTTPS 网关，需配置 request / uploadFile 合法域名。
const SERVER_API = 'https://sqt.org.cn/api';

function isDeveloperTools() {
  try {
    return wx.getSystemInfoSync().platform === 'devtools';
  } catch (e) {}
  return false;
}

const developerTools = isDeveloperTools();
const localDevelopment = USE_LOCAL_BACKEND && developerTools;

function isDesktopWechat() {
  try {
    const platform = wx.getSystemInfoSync().platform;
    return platform === 'windows' || platform === 'mac';
  } catch (e) {}
  return false;
}

const desktopWechat = isDesktopWechat();

App({
  globalData: {
    baseUrl: localDevelopment ? LOCAL_API : SERVER_API,
    isLocalDevelopment: localDevelopment,
    isDeveloperTools: developerTools,
    isDesktopWechat: desktopWechat,
    token: '',
    currentCompanyId: '',
    userInfo: null,
    memberInfo: null,
    companies: [],
    pendingInvite: null,
    activeTabIndex: null,
    tabBarTransition: null,
    tabBarHidden: false
  },

  onLaunch() {
    this.restoreStoredSession();
    this._sessionReady = this.globalData.token
      ? this.refreshSession() : Promise.resolve(null);
  },

  onShow(options = {}) {
    const query = options.query || {};
    if (query.inviteCode) {
      this.globalData.pendingInvite = { code: query.inviteCode, type: query.type || 'member' };
    }
    this.restoreStoredSession();
    if (this.globalData.token) this._sessionReady = this.refreshSession();
  },

  restoreStoredSession() {
    const token = wx.getStorageSync('tradepass_token');
    const companyId = wx.getStorageSync('tradepass_company_id');
    if (companyId) this.globalData.currentCompanyId = String(companyId);
    if (token) this.globalData.token = token;
  },

  ensureSessionReady() {
    this.restoreStoredSession();
    if (!this.globalData.token) return Promise.resolve(null);
    if (this._sessionRefresh) return this._sessionRefresh;
    if (this.globalData.userInfo) return Promise.resolve(this.globalData.userInfo);
    return this.refreshSession();
  },

  refreshSession() {
    if (!this.globalData.token) return Promise.resolve(null);
    if (this._sessionRefresh) return this._sessionRefresh;
    const refresh = Promise.resolve()
      .then(() => this.loadMe())
      .catch(() => null)
      .finally(() => {
        if (this._sessionRefresh === refresh) this._sessionRefresh = null;
      });
    this._sessionRefresh = refresh;
    this._sessionReady = refresh;
    return refresh;
  },

  getCurrentCompanyId() {
    return this.globalData.currentCompanyId
      || (this.globalData.userInfo && this.globalData.userInfo.currentCompanyId)
      || '';
  },

  setCurrentCompany(companyId) {
    const cid = companyId ? String(companyId) : '';
    this.globalData.currentCompanyId = cid;
    if (cid) wx.setStorageSync('tradepass_company_id', cid);
    else wx.removeStorageSync('tradepass_company_id');
  },

  applyMePayload(payload) {
    if (!payload) return null;
    this.globalData.userInfo = payload.user || null;
    this.globalData.memberInfo = payload.member || null;
    this.globalData.companies = payload.companies || [];
    const cid = payload.user && payload.user.currentCompanyId;
    const userId = payload.user && payload.user.id;
    if (userId) wx.setStorageSync(USER_ID_KEY, String(userId));
    this.setCurrentCompany(cid || '');
    return payload;
  },

  async establishSession(session) {
    if (!session || !session.token) throw new Error('登录响应缺少会话信息');
    this.globalData.token = session.token;
    wx.setStorageSync('tradepass_token', session.token);
    const cid = session.user && session.user.currentCompanyId;
    const userId = session.user && session.user.id;
    if (userId) wx.setStorageSync(USER_ID_KEY, String(userId));
    this.setCurrentCompany(cid || '');
    this._sessionReady = this.loadMe();
    await this._sessionReady;
    return session;
  },

  async logout() {
    const hasToken = !!this.globalData.token;
    try {
      if (hasToken) {
        await request({ url: '/auth/logout', method: 'POST', handleUnauthorized: false });
      }
    } catch (e) {
      // 即使服务端暂时不可达，也必须清理本地会话。
    } finally {
      clearSession(this);
      this._sessionReady = Promise.resolve(null);
      this._sessionRefresh = null;
      wx.reLaunch({ url: '/pages/index/index' });
    }
  },

  doLogin() {
    wx.showLoading({ title: '登录中...' });
    return wechatLogin().then(session => this.establishSession(session))
      .then(() => wx.showToast({ title: '登录成功', icon: 'success' }))
      .catch(error => wx.showToast({ title: error.message || '登录失败', icon: 'none' }))
      .finally(() => wx.hideLoading());
  },

  async loadMe() {
    if (!this.globalData.token) return null;
    const token = this.globalData.token;
    const companyId = this.getCurrentCompanyId();
    let generation = this._companyAccessGeneration || 0;
    let payload;
    let recovered = false;
    try {
      payload = await request({ url: '/me', token, handleCompanyForbidden: false });
    } catch (error) {
      if (token !== this.globalData.token || generation !== (this._companyAccessGeneration || 0)) return null;
      if (!companyId || (error.statusCode !== 403 && error.code !== 403)) throw error;
      this.invalidateCompanyAccess(companyId);
      generation = this._companyAccessGeneration || 0;
      recovered = true;
      try {
        payload = await request({ url: '/me', token, withCompany: false });
      } catch (restoreError) {
        if (token === this.globalData.token) wx.reLaunch({ url: '/pages/index/index' });
        throw restoreError;
      }
    }
    if (token !== this.globalData.token || generation !== (this._companyAccessGeneration || 0)) return null;
    this.applyMePayload(payload);
    if (recovered) wx.reLaunch({ url: '/pages/index/index' });
    this.checkMembershipNotices();
    return payload;
  },

  invalidateCompanyAccess(companyId) {
    const userId = (this.globalData.userInfo && this.globalData.userInfo.id) || wx.getStorageSync(USER_ID_KEY);
    clearCompanyHomeSnapshots(userId, companyId);
    this.globalData.companies = this.globalData.companies.filter(item => String(item.companyId) !== String(companyId));
    if (String(companyId) === String(this.getCurrentCompanyId())) {
      this._companyAccessGeneration = (this._companyAccessGeneration || 0) + 1;
      this.setCurrentCompany('');
      this.globalData.memberInfo = null;
      if (this.globalData.userInfo) {
        this.globalData.userInfo = { ...this.globalData.userInfo, currentCompanyId: null, currentRole: 'GUEST' };
      }
    }
  },

  handleCompanyAccessLost(companyId) {
    if (String(companyId) !== String(this.getCurrentCompanyId()) || this._companyAccessRecovery) return;
    const token = this.globalData.token;
    this.invalidateCompanyAccess(companyId);
    const recovery = Promise.resolve(this._sessionRefresh)
      .then(() => token === this.globalData.token ? this.loadMe() : null)
      .catch(() => null).finally(() => {
      if (this._companyAccessRecovery === recovery) this._companyAccessRecovery = null;
      if (token === this.globalData.token) wx.reLaunch({ url: '/pages/index/index' });
    });
    this._companyAccessRecovery = recovery;
  },

  checkMembershipNotices() {
    if (!this.globalData.token) return Promise.resolve();
    if (this._membershipNoticeCheck) return this._membershipNoticeCheck;
    const token = this.globalData.token;
    const check = this.showMembershipNotices(token).catch(() => {}).finally(() => {
      if (this._membershipNoticeCheck === check) this._membershipNoticeCheck = null;
    });
    this._membershipNoticeCheck = check;
    return check;
  },

  async showMembershipNotices(token) {
    const notices = await request({ url: '/me/membership-notices', token, withCompany: false });
    if (token !== this.globalData.token || !Array.isArray(notices) || !notices.length) return;
    const lostCurrentCompany = notices.some(notice => String(notice.companyId) === String(this.getCurrentCompanyId()));
    notices.forEach(notice => this.invalidateCompanyAccess(notice.companyId));
    if (lostCurrentCompany) {
      const context = captureCompanyContext(this);
      try {
        const payload = await request({ url: '/me', token, withCompany: false });
        if (!isCompanyContextCurrent(this, context)) return;
        this.applyMePayload(payload);
      } catch (error) {
        // The revoked company stays cleared even if restoring another company fails.
      }
      if (token !== this.globalData.token) return;
      wx.reLaunch({ url: '/pages/index/index' });
    }
    const names = notices.map(notice => `「${notice.companyName}」`).join('、');
    const target = notices.length === 1 ? '该企业' : '这些企业';
    const result = await new Promise(resolve => wx.showModal({
      title: '企业成员变更提醒',
      content: `你已被管理员移出${names}，无法再访问${target}的数据。如有疑问，请联系对应企业管理员。`,
      showCancel: false,
      confirmText: '我知道了',
      success: resolve,
      fail: () => resolve({ confirm: false })
    }));
    if (result.confirm && token === this.globalData.token) {
      await request({ url: '/me/membership-notices/acknowledge', method: 'POST',
        token, withCompany: false, data: { ids: notices.map(notice => notice.id) } });
    }
  },

  async switchCompany(companyId) {
    const token = this.globalData.token;
    const sequence = this._companySwitchSequence = (this._companySwitchSequence || 0) + 1;
    this._companyAccessGeneration = (this._companyAccessGeneration || 0) + 1;
    const payload = await request({
      url: '/me/switch-company',
      method: 'POST',
      data: { companyId },
      companyId,
      token
    });
    if (token !== this.globalData.token || sequence !== this._companySwitchSequence) {
      throw new Error('企业切换状态已变化，请重试');
    }
    // Ignore older /me responses that were requested before this company switch completed.
    this._companyAccessGeneration = (this._companyAccessGeneration || 0) + 1;
    return this.applyMePayload(payload);
  },

  async switchUser(userId) {
    const session = await request({
      url: '/dev/switch-user',
      method: 'POST',
      data: { userId },
      withCompany: false
    });
    return this.establishSession(session);
  }
});
