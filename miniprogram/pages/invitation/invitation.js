const { captureInviteLink } = require('../../utils/invitation');
const app = getApp();

Page({
  data: { error: '', canRetry: false },

  onLoad(options = {}) {
    this._inviteQuery = options;
    this.openInvite();
  },

  openInvite() {
    if (this._opening) return;
    if (!captureInviteLink(app, this._inviteQuery)) {
      this.setData({ error: '邀请链接缺少邀请码，请联系邀请人重新发送。', canRetry: false });
      return;
    }
    this._opening = true;
    this.setData({ error: '', canRetry: false });
    // A separate page makes repeated card openings observable even when
    // WeChat reuses the home tab. Home retains the login and approval flow.
    wx.switchTab({
      url: '/pages/index/index',
      fail: () => {
        this.setData({ error: '邀请暂未打开，请重试。', canRetry: true });
      },
      complete: () => { this._opening = false; }
    });
  },

  goHome() {
    wx.switchTab({ url: '/pages/index/index' });
  }
});
