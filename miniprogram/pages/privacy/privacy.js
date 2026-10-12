const { acceptPrivacyConsent } = require('../../utils/privacy');

Page({
  data: {
    agreed: false,
    showAgreementModal: false,
    shaking: false
  },

  onLoad() {},

  toggleAgree() {
    this.setData({ agreed: !this.data.agreed });
  },

  showAgreement() {
    this.setData({ showAgreementModal: true });
  },

  closeAgreement() {
    this.setData({ showAgreementModal: false });
  },

  noop() {},

  async doAgree() {
    if (!this.data.agreed) {
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
    wx.reLaunch({ url: '/pages/index/index' });
  },

  doDeny() {
    wx.switchTab({ url: '/pages/index/index' });
  }
});
