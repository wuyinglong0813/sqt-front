const app = getApp();

Page({
  data: { isLoggedIn: false },

  onShow() {
    this.setData({
      isLoggedIn: !!(app.globalData.token || wx.getStorageSync('tradepass_token'))
    });
  },

  goLogin() {
    wx.navigateTo({ url: '/pages/login/login' });
  },

  openPrivacy() {
    wx.navigateTo({ url: '/pages/legal-document/legal-document?type=privacy' });
  }
});
