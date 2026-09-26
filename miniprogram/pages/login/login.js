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
    const detail = (e && e.detail) || {};
    if (detail.errMsg !== 'getPhoneNumber:ok' || !detail.code) {
      if (/user deny|user cancel/i.test(detail.errMsg || '')) {
        wx.showToast({ title: '已取消手机号授权', icon: 'none' });
        return;
      }
      this.showLoginError('手机号授权', {
        message: detail.errMsg === 'getPhoneNumber:ok'
          ? '微信未返回手机号授权凭证，请重试' : (detail.errMsg || '微信未返回手机号授权结果'),
        errCode: detail.errCode
      });
      return;
    }
    return this.loginWithPayload({ phoneCode: detail.code });
  },

  showLoginError(stage, error) {
    const lines = [`失败步骤：${stage}`, error.message || '登录失败，请重试'];
    if (error.errCode !== undefined) lines.push(`微信错误码：${error.errCode}`);
    if (error.statusCode !== undefined) lines.push(`HTTP 状态：${error.statusCode}`);
    if (error.code !== undefined) lines.push(`业务错误码：${error.code}`);
    if (stage === '手机号授权' || stage === '微信登录') {
      lines.push('此步骤尚未向业务服务器发起登录请求。');
    }
    const content = lines.join('\n');
    wx.showModal({
      title: '登录未完成', content,
      confirmText: '复制详情', cancelText: '关闭',
      success: result => {
        if (result.confirm) wx.setClipboardData({ data: content });
      }
    });
  },

  async loginWithPayload(payload) {
    let stage = '服务器登录';
    let failure;
    wx.showLoading({ title: '登录中...' });
    try {
      const session = await wechatLogin(payload);
      stage = '读取登录用户信息';
      await app.establishSession(session);
      wx.showToast({ title: '登录成功', icon: 'success' });
      wx.switchTab({ url: '/pages/index/index' });
    } catch (error) {
      failure = error;
    } finally {
      wx.hideLoading();
    }
    if (failure) this.showLoginError(failure.loginStage || stage, failure);
  },

  openUserAgreement() {
    wx.navigateTo({ url: '/pages/legal-document/legal-document?type=user' });
  },
  openPrivacyAgreement() {
    wx.navigateTo({ url: '/pages/legal-document/legal-document?type=privacy' });
  }
});
