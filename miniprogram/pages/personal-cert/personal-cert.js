const { request } = require('../../utils/request');
const { returnToCompany } = require('../../utils/companyOnboarding');
const { signingContinuation } = require('../../utils/signingContinuation');

const STATUS_VIEW = {
  NOT_STARTED: { title: '待完成个人认证', desc: '完成实名认证后，可建立可信的个人身份。', tone: 'pending', button: '开始认证' },
  IN_PROGRESS: { title: '个人认证进行中', desc: '如已完成认证，请返回后刷新认证结果。', tone: 'processing', button: '继续认证' },
  VERIFIED: { title: '个人认证已完成', desc: '你的实名身份已通过认证。', tone: 'success', button: '' },
  FAILED: { title: '个人认证未通过', desc: '请查看失败原因并重新发起认证。', tone: 'failed', button: '重新认证' }
};

const EMPTY_IDENTITY = {
  providerEnabled: false,
  status: 'NOT_STARTED',
  statusText: '待认证',
  verifiedName: '',
  verificationChannel: '',
  failureReason: '',
  verifiedAt: ''
};

function formatBeijingTime(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const matched = text.match(/^(\d{4}-\d{2}-\d{2})[T\s]+(\d{2}:\d{2}:\d{2})/);
  return matched ? `${matched[1]} ${matched[2]}` : text.replace(/T\s*/, ' ');
}

function identityForDisplay(value) {
  const identity = value || EMPTY_IDENTITY;
  const display = {
    ...identity,
    verificationChannel: identity.status === 'VERIFIED' ? '电子签实名认证' : '',
    verifiedAt: formatBeijingTime(identity.verifiedAt)
  };
  // Provider identity metadata does not establish which method completed this session.
  // Keep it in the backend record instead of presenting it as the user's latest choice.
  delete display.identMethod;
  return display;
}

Page({
  data: {
    loading: true,
    syncing: false,
    identity: EMPTY_IDENTITY,
    statusView: STATUS_VIEW.NOT_STARTED,
    providerEnabled: false,
    refreshAfterAuth: false,
    phoneLoading: true,
    phoneBound: false,
    maskedPhone: '',
    bindingPhone: false,
    desktopMode: false
  },

  onLoad(options = {}) {
    this._flowToken = getApp().globalData.token;
    this._companyFlow = options.flow === 'company-create';
    this._legalClaimCompanyId = options.flow === 'legal-claim' ? String(options.companyId || '') : '';
    this._returnOptions = options;
    this._identityContinuationId = options.continuationId && signingContinuation(getApp(), options.continuationId)
      ? options.continuationId : '';
    this.setData({ desktopMode: !!getApp().globalData.isDesktopWechat });
    this.loadPhoneStatus();
    this.loadIdentity(!!this._identityContinuationId);
  },

  onUnload() { this._unloaded = true; },

  onShow() {
    this.loadPhoneStatus();
    if (!this.data.refreshAfterAuth) return;
    this._completedAuthReturn = true;
    this.setData({ refreshAfterAuth: false });
    this.loadIdentity(true);
  },

  onPullDownRefresh() {
    Promise.all([this.loadPhoneStatus(), this.loadIdentity(true)]).finally(() => wx.stopPullDownRefresh());
  },

  applyPhoneProfile(user, token) {
    const app = getApp();
    if (this._unloaded || app.globalData.token !== token || !user) return false;
    const current = app.globalData.userInfo;
    if (current && String(current.id) !== String(user.id)) return false;
    // A phone refresh must not change the currently selected company or member roles.
    if (current) app.globalData.userInfo = { ...current, phone: user.phone || '' };
    const phone = String(user.phone || '');
    this.setData({ phoneBound: !!phone, maskedPhone: phone.length >= 11
      ? `${phone.slice(0, 3)}****${phone.slice(-4)}` : phone });
    return true;
  },

  async loadPhoneStatus() {
    const app = getApp();
    const token = app.globalData.token;
    if (!token || this._phoneLoading) return;
    this._phoneLoading = true;
    try {
      const payload = await request({ url: '/me', withCompany: false });
      this.applyPhoneProfile(payload && payload.user, token);
    } catch (error) {
      wx.showToast({ title: error.message || '手机号状态加载失败', icon: 'none' });
    } finally {
      this._phoneLoading = false;
      if (!this._unloaded) this.setData({ phoneLoading: false });
    }
  },

  async bindWechatPhone(e) {
    if (this.data.bindingPhone || this.data.desktopMode) return;
    const detail = e.detail || {};
    if (detail.errMsg !== 'getPhoneNumber:ok' || !detail.code) {
      wx.showToast({ title: '请允许微信提供手机号后重试', icon: 'none' });
      return;
    }
    const app = getApp();
    const token = app.globalData.token;
    this.setData({ bindingPhone: true });
    try {
      const user = await request({ url: '/auth/bind-phone', method: 'POST',
        withCompany: false, data: { phoneCode: detail.code } });
      if (this.applyPhoneProfile(user, token)) {
        wx.showToast({ title: '手机号已绑定，可继续认证', icon: 'success' });
      }
    } catch (error) {
      wx.showToast({ title: error.message || '手机号绑定失败，请重试', icon: 'none' });
    } finally {
      if (!this._unloaded) this.setData({ bindingPhone: false });
    }
  },

  async loadIdentity(sync, notify) {
    if (!this.data.identity || !this.data.identity.status) this.setData({ loading: true });
    if (sync) this.setData({ syncing: true });
    let identity;
    try {
      identity = await request({ url: '/fadada/users/me/identity', withCompany: false });
      if (sync && identity && identity.status !== 'NOT_STARTED'
        && (identity.status !== 'VERIFIED' || this._identityContinuationId) && identity.providerEnabled) {
        identity = await request({
          url: '/fadada/users/me/identity/sync',
          method: 'POST',
          withCompany: false
        });
      }
      if (this._legalClaimCompanyId && (this._unloaded || this._flowToken !== getApp().globalData.token)) return;
      const status = identity && STATUS_VIEW[identity.status] ? identity.status : 'NOT_STARTED';
      const displayIdentity = identityForDisplay(identity);
      this.setData({
        identity: displayIdentity,
        providerEnabled: !!(identity && identity.providerEnabled),
        statusView: STATUS_VIEW[status]
      });
      if (status === 'VERIFIED' && this._legalClaimCompanyId && !this._unloaded && !this._returning
          && this._flowToken === getApp().globalData.token) {
        this._returning = true;
        wx.redirectTo({ url: `/pages/legal-representative/legal-representative?companyId=${encodeURIComponent(this._legalClaimCompanyId)}&claim=1` });
        return;
      }
      if (status === 'VERIFIED' && this._completedAuthReturn && !this._unloaded && !this._returning) {
        this._returning = true;
        const query = this._companyFlow ? '&flow=company-create' : '';
        const company = this._returnOptions && this._returnOptions.companyId
          ? '&companyId=' + encodeURIComponent(this._returnOptions.companyId) : '';
        const continuation = this._identityContinuationId ? '&continuationId=' + encodeURIComponent(this._identityContinuationId) : '';
        wx.redirectTo({ url: `/pages/service-return/service-return?scene=personal${query}${company}${continuation}` });
        return;
      }
      if (status === 'VERIFIED' && this._identityContinuationId && !this._unloaded && !this._returning) {
        this._returning = true;
        wx.redirectTo({ url: `/pages/service-return/service-return?scene=personal&continuationId=${encodeURIComponent(this._identityContinuationId)}` });
        return;
      }
      if (status === 'VERIFIED' && this._companyFlow && !this._unloaded && !this._returning) {
        this._returning = true;
        returnToCompany(this._returnOptions);
        return;
      }
      if (notify) {
        wx.showToast({
          title: status === 'VERIFIED' ? '认证结果已更新'
            : (identity && identity.failureReason ? '请查看页面上的认证提示' : '认证状态已刷新'),
          icon: identity && identity.failureReason ? 'none' : 'success'
        });
      }
    } catch (error) {
      if (identity && this._identityContinuationId) this.setData({
        identity: { ...identityForDisplay(identity), failureReason: error.message || '认证状态待重新核验' },
        providerEnabled: !!identity.providerEnabled,
        statusView: { ...STATUS_VIEW.IN_PROGRESS, desc: '认证状态暂未确认，请刷新结果或重新核验后继续原业务。' }
      });
      wx.showToast({ title: error.message || '认证状态加载失败', icon: 'none' });
    } finally {
      this.setData({ loading: false, syncing: false });
    }
  },

  startAuth() {
    if (this.data.phoneLoading || !this.data.phoneBound) {
      wx.showToast({ title: this.data.desktopMode ? '请在手机微信完成手机号绑定' : '请先授权绑定手机号', icon: 'none' });
      return;
    }
    if (!this.data.providerEnabled) {
      wx.showModal({
        title: '认证服务未启用',
        content: '个人认证参数尚未配置完成，请联系管理员。',
        showCancel: false
      });
      return;
    }
    this.setData({ refreshAfterAuth: true });
    const flow = this._companyFlow ? 'company-create' : this._legalClaimCompanyId ? 'legal-claim' : '';
    const query = flow ? `&flow=${flow}${this._returnOptions.companyId ? '&companyId=' + encodeURIComponent(this._returnOptions.companyId) : ''}` : '';
    const continuation = this._identityContinuationId ? '&continuationId=' + encodeURIComponent(this._identityContinuationId) : '';
    wx.navigateTo({ url: `/pages/fadada-auth/fadada-auth?scene=personal${query}${continuation}` });
  },

  refreshStatus() {
    if (this.data.syncing) return;
    this.loadIdentity(true, true);
  }
});
