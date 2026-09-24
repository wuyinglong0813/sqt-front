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

  doAgree() {
    if (!this.data.agreed) {
      this.setData({ shaking: true });
      setTimeout(() => this.setData({ shaking: false }), 500);
      return;
    }
    wx.setStorageSync('privacy_agreed', true);
    wx.reLaunch({ url: '/pages/index/index' });
  },

  doDeny() {
    wx.showModal({
      title: '提示',
      content: '需要同意隐私保护指引才能使用小程序。',
      showCancel: false,
      confirmText: '知道了'
    });
  }
});
