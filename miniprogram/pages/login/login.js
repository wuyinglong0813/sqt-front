const app = getApp();
const { wechatLogin } = require('../../utils/wechatLogin');

Page({
  data: {
    agreed: false,
    shaking: false,
    quickPhoneEnabled: false,
    desktopMode: false
  },

  onLoad() {
    const desktopMode = !!app.globalData.isDesktopWechat;
    this.setData({
      desktopMode,
      quickPhoneEnabled: !app.globalData.isLocalDevelopment
        && !app.globalData.isDeveloperTools && !desktopMode
    });
  },

  async onShow() {
    await app.ensureSessionReady();
    if (app.globalData.token) wx.switchTab({ url: '/pages/index/index' });
  },

  toggleAgree() { this.setData({ agreed: !this.data.agreed }); },

  remindAgreement() {
    this.setData({ shaking: true });
    setTimeout(() => this.setData({ shaking: false }), 500);
  },

  skipLogin() { wx.switchTab({ url: '/pages/index/index' }); },

  /* PC 微信和开发者工具使用 wx.login；本地后端可使用模拟登录。 */
  onWechatPhoneTap() {
    if (!this.data.agreed) {
      this.remindAgreement();
      return;
    }
    if (this.data.quickPhoneEnabled) return; // 已开通由 open-type 处理
    if (!app.globalData.isLocalDevelopment) {
      return this.loginWithPayload({});
    }
    return this.loginWithPayload({ code: 'dev-openid-001', nickName: '满帅', phone: '18800000001' });
  },

  /* 跳转输入手机号登录页 */
  goPhoneLogin() {
    if (!app.globalData.isLocalDevelopment) {
      wx.showToast({ title: '短信登录服务暂未开放', icon: 'none' });
      return;
    }
    wx.navigateTo({ url: '/pages/phone-login/phone-login' });
  },

  /* 微信手机号快捷登录 */
  quickPhoneLogin(e) {
    if (!this.data.agreed) {
      this.remindAgreement();
      return;
    }
    if (e.detail.errMsg !== 'getPhoneNumber:ok') {
      wx.showToast({ title: '获取手机号失败', icon: 'none' });
      return;
    }
    return this.loginWithPayload({ phoneCode: e.detail.code });
  },

  async loginWithPayload(payload) {
    wx.showLoading({ title: '登录中...' });
    try {
      const session = await wechatLogin(payload);
      await app.establishSession(session);
      wx.showToast({ title: '登录成功', icon: 'success' });
      wx.switchTab({ url: '/pages/index/index' });
    } catch (error) {
      wx.showToast({ title: error.message || '登录失败', icon: 'none' });
    } finally {
      wx.hideLoading();
    }
  },

  openUserAgreement() {
    wx.navigateTo({ url: '/pages/legal-document/legal-document?type=user' });
  },
  openPrivacyAgreement() {
    wx.navigateTo({ url: '/pages/legal-document/legal-document?type=privacy' });
  }
});
