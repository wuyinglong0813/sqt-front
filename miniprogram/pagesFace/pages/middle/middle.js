// Protocol: https://gitee.com/fadada-cloud/pages-face-demo (pagesFace/pages/middle).
// A faceResult only resumes the provider page; our backend verifies certification.
Page({
  data: { ready: false, jumping: false, message: '正在准备人脸认证' },

  onLoad(options = {}) {
    this._token = getApp().globalData.token;
    try {
      const decode = name => decodeURIComponent(options[name] || '');
      this._appId = decode('miniProgramAppId');
      this._path = decode('miniProgramPath');
      this._bizToken = decode('bizToken');
      this._returnUrl = decode('miniProgramCallBackUrl');
      const pages = getCurrentPages();
      this._parent = pages[pages.length - 2];
      if (!this._token || !/^wx[0-9a-f]{16}$/i.test(this._appId)
          || !this._path || !this._bizToken
          || !this._parent || this._parent.route !== 'pages/fadada-auth/fadada-auth'
          || !this._parent.acceptsReturnUrl(this._returnUrl)) {
        throw new Error('人脸认证参数不完整，请返回认证页面重新发起');
      }
      if (options.isRedirect === 'true' || options.isRedirect === '1') this._parent.setIsRedirect();
      this.setData({ ready: true, message: '前往认证小程序完成人脸核验，完成后将自动返回继续办理。' });
    } catch (error) {
      this.setData({ ready: false, message: '人脸认证参数无效，请返回认证页面重试。' });
    }
  },

  onUnload() { this._unloaded = true; },

  onShow() {
    if (!this._launched || this._unloaded) return;
    this._launched = false;
    this.setData({ jumping: false });
    if (this._token !== getApp().globalData.token) {
      this.setData({ ready: false, message: '登录状态已变化，请返回后重新发起认证。' });
      return;
    }
    const entry = wx.getEnterOptionsSync();
    const referrer = entry.referrerInfo || {};
    if (entry.scene === 1038 && referrer.appId === this._appId
        && referrer.extraData && referrer.extraData.faceResult) {
      if (this._parent.reloadPage(this._returnUrl)) {
        wx.navigateBack({ delta: 1 });
        return;
      }
      this.setData({ ready: false, message: '认证页面已失效，请返回后刷新认证结果。' });
    } else {
      this.setData({ message: '尚未收到刷脸返回结果，你可以重新前往认证，或返回上一步。' });
    }
  },

  onJump() {
    if (!this.data.ready || this.data.jumping || this._token !== getApp().globalData.token) return;
    this.setData({ jumping: true });
    wx.navigateToMiniProgram({
      appId: this._appId,
      path: this._path + (this._path.includes('?') ? '&' : '?') + 'bizToken=' + encodeURIComponent(this._bizToken),
      success: () => { this._launched = true; },
      fail: () => {
        if (!this._unloaded) this.setData({ jumping: false, message: '未能打开认证小程序，请点击重试。' });
      }
    });
  },

  goBack() { wx.navigateBack({ delta: 1 }); }
});
