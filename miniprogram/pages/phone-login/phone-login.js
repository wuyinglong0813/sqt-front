const app = getApp();
const { wechatLogin } = require('../../utils/wechatLogin');

Page({
  data: {
    agreed: false,
    phoneNumber: '',
    smsCode: '',
    codeSending: false,
    countdown: 0
  },

  toggleAgree() { this.setData({ agreed: !this.data.agreed }); },

  onPhoneInput(e) { this.setData({ phoneNumber: e.detail.value }); },

  onCodeInput(e) { this.setData({ smsCode: e.detail.value }); },

  /* 发送验证码 */
  sendSmsCode() {
    if (this.data.codeSending) return;
    if (this.data.phoneNumber.length < 11) {
      wx.showToast({ title: '请输入正确的手机号', icon: 'none' });
      return;
    }
    if (!app.globalData.isLocalDevelopment) {
      wx.showToast({ title: '短信服务暂未开放，请使用微信手机号登录', icon: 'none' });
      return;
    }
    this.setData({ codeSending: true, countdown: 60 });
    this._countdownTimer = setInterval(() => {
      const t = this.data.countdown - 1;
      if (t <= 0) {
        clearInterval(this._countdownTimer);
        this.setData({ codeSending: false, countdown: 0 });
      } else {
        this.setData({ countdown: t });
      }
    }, 1000);
    wx.showToast({ title: '开发环境验证码已发送', icon: 'none' });
  },

  /* 登录 */
  onLogin() {
    if (!this.data.agreed) {
      wx.showToast({ title: '请先阅读并同意协议', icon: 'none' });
      return;
    }
    if (this.data.phoneNumber.length < 11) {
      wx.showToast({ title: '请输入正确的手机号', icon: 'none' });
      return;
    }
    if (this.data.smsCode.length < 4) {
      wx.showToast({ title: '请输入验证码', icon: 'none' });
      return;
    }
    if (!app.globalData.isLocalDevelopment) {
      wx.showToast({ title: '短信服务暂未开放', icon: 'none' });
      return;
    }
    wx.showLoading({ title: '登录中...' });

    return wechatLogin({
      code: `dev-phone-${this.data.phoneNumber.slice(-4)}`,
      phone: this.data.phoneNumber
    }).then(session => app.establishSession(session)).then(() => {
      wx.showToast({ title: '登录成功', icon: 'success' });
      wx.switchTab({ url: '/pages/index/index' });
    }).catch(error => {
      wx.showToast({ title: error.message || '登录失败', icon: 'none' });
    }).finally(() => wx.hideLoading());
  },

  onUnload() {
    if (this._countdownTimer) clearInterval(this._countdownTimer);
  },

  openUserAgreement() {
    wx.navigateTo({ url: '/pages/legal-document/legal-document?type=user' });
  },
  openPrivacyAgreement() {
    wx.navigateTo({ url: '/pages/legal-document/legal-document?type=privacy' });
  }
});
