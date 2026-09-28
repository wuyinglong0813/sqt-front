const { request } = require('../../utils/request');
const { returnToCompany } = require('../../utils/companyOnboarding');

// Existing identity responses put temporary provider-query errors in failureReason.
// They can remain cached for 30 seconds after successful provider authorization.
const AUTH_QUERY_PENDING = {
  personal: [
    '尚未查询到个人授权，请完成认证页面的全部步骤后再刷新',
    '认证查询过于频繁，请稍后再刷新'
  ],
  company: [
    '尚未查询到当前企业的授权记录，请稍后刷新；如已开通，请联系管理员核对授权关联',
    '认证查询过于频繁，请至少等待30秒后刷新'
  ]
};
const MAX_SYNC_ATTEMPTS = 24;

Page({
  data: {
    title: '正在继续办理',
    message: '请稍候',
    loading: true,
    failed: false,
    countdown: 1,
    options: {}
  },

  onLoad(options) {
    // Fadada returns to a fixed personal result route. Recover company continuation
    // from our own page stack, never from the provider's claimed auth result.
    if (options.scene === 'personal' && !options.flow) {
      const source = getCurrentPages().slice(0, -1).reverse().find(page =>
        page.route === 'pages/personal-cert/personal-cert');
      if (source && source._companyFlow && source._flowToken === getApp().globalData.token) {
        options = { ...options, flow: 'company-create',
          companyId: (source._returnOptions || {}).companyId || '' };
      }
    }
    this.setData({ options });
    this.syncResult();
  },

  onUnload() {
    this._unloaded = true;
    if (this.returnTimer) clearTimeout(this.returnTimer);
    if (this.syncTimer) clearTimeout(this.syncTimer);
  },

  onHide() {
    this._hidden = true;
    if (this.returnTimer) clearTimeout(this.returnTimer);
    if (this.syncTimer) clearTimeout(this.syncTimer);
  },

  onShow() {
    this._hidden = false;
    if (this._successReady && !this._navigating) this.startCountdown();
    if (this._awaitingResult) this.scheduleResultSync();
  },

  scheduleResultSync() {
    if (this.syncTimer) clearTimeout(this.syncTimer);
    if (this._hidden || this._unloaded || this._resultToken !== getApp().globalData.token) return;
    this.syncTimer = setTimeout(() => {
      if (this._hidden || this._unloaded || this._resultToken !== getApp().globalData.token) return;
      return this.syncResult();
    }, 2500);
  },

  retrySync() {
    if (this._syncing || this._unloaded) return;
    this._syncAttempts = 0;
    return this.syncResult();
  },

  startCountdown() {
    if (this.returnTimer) clearTimeout(this.returnTimer);
    this._successReady = true;
    if (this._hidden || this._unloaded || this._resultToken !== getApp().globalData.token) return;
    if (['personal', 'company'].includes((this.data.options || {}).scene)) {
      // The server has confirmed the result; continue without a second success screen.
      this._successReady = false;
      this.goBusinessPage();
      return;
    }
    this.returnTimer = setTimeout(() => {
      if (this._hidden || this._unloaded || this._resultToken !== getApp().globalData.token) return;
      const countdown = this.data.countdown - 1;
      this.setData({ countdown });
      if (countdown <= 0) this.goBusinessPage();
      else this.startCountdown();
    }, 1000);
  },

  async syncResult() {
    if (this._syncing || this._unloaded) return;
    this._syncing = true;
    const token = this._resultToken = getApp().globalData.token;
    const current = () => !this._unloaded && token === getApp().globalData.token;
    this._successReady = false;
    this._awaitingResult = false;
    if (this.returnTimer) clearTimeout(this.returnTimer);
    if (this.syncTimer) clearTimeout(this.syncTimer);
    const options = this.data.options || {};
    this.setData({ loading: true, countdown: ['personal', 'company'].includes(options.scene) ? 1 : 5 });
    try {
      let result;
      if (options.scene === 'personal') {
        result = await this.readAuthenticationResult('/fadada/users/me/identity', options.scene, token);
      } else if (options.scene === 'legal') {
        if (!options.companyId) throw new Error('缺少本次核验的企业信息，请返回重试');
        result = await request({ url: `/fadada/companies/${options.companyId}/legal-representative/sync`,
          method: 'POST', withCompany: false, token });
      } else if (options.scene === 'company' || options.scene === 'seal') {
        if (!options.companyId) throw new Error('缺少本次认证的企业信息，请返回企业认证页面重试');
        result = await this.readAuthenticationResult(
          `/fadada/companies/${options.companyId}/identity`, options.scene, token);
      } else if (options.scene === 'contract' || options.scene === 'abolish') {
        result = await request({ url: `/contracts/${options.contractId}/signing/sync`, method: 'POST', token });
      }
      if (!current()) return;
      if (['personal', 'company', 'seal', 'legal'].includes(options.scene)
          && !this.authenticationCompleted(result, options.scene)) {
        // The native redirect may arrive before the signed callback has been applied.
        // Wait briefly for server confirmation; query parameters never prove success.
        const queryPending = result && result.status === 'IN_PROGRESS'
          && (AUTH_QUERY_PENDING[options.scene] || []).includes(result.failureReason);
        if (['personal', 'company'].includes(options.scene) && result
            && result.status === 'IN_PROGRESS' && (!result.failureReason || queryPending)
            && (this._syncAttempts || 0) < MAX_SYNC_ATTEMPTS) {
          this._syncAttempts = (this._syncAttempts || 0) + 1;
          this._awaitingResult = true;
          this.setData({ loading: true, failed: false, title: '正在接收认证结果',
            message: '收到结果后将自动继续，无需重复认证' });
          this.scheduleResultSync();
          return;
        }
        this.setData({ loading: false, failed: true,
          title: result && result.status === 'FAILED' ? '认证未通过' : '处理结果待确认',
          message: queryPending
            ? `${options.scene === 'company' ? '企业' : '个人'}授权结果仍未同步。如法大大已显示开通成功，请稍后重新同步，无需反复提交认证；持续未恢复请联系管理员核验`
            : (result && (result.failureReason || result.message || result.statusText)) || '结果尚未更新，请稍后刷新' });
        return;
      }
      if (options.scene === 'company') {
        await getApp().switchCompany(options.companyId);
        if (!current()) return;
        this._companyCompleted = true;
        this.setData({ loading: false, failed: false, title: '企业认证成功', message: '已切换到本次认证企业，即将进入企业中心' });
        this.startCountdown();
        return;
      }
      if (options.scene === 'legal') {
        await getApp().loadMe();
        if (!current()) return;
      }
      this.setData({
        loading: false,
        failed: false,
        title: options.scene === 'personal' ? '个人认证成功' : '处理结果已同步',
        message: options.scene === 'personal' ? (options.flow === 'company-create'
          ? '实名身份已确认，即将继续企业开通流程' : '实名身份已确认，即将进入首页') : (result && (result.statusText || result.status)) || '你可以返回业务页面继续操作'
      });
      if (current()) this.startCountdown();
    } catch (error) {
      if (!current()) return;
      this.setData({
        loading: false,
        failed: true,
        title: '结果同步暂未完成',
        message: error.message || '稍后返回业务页面刷新即可'
      });
    } finally {
      this._syncing = false;
    }
  },

  authenticationCompleted(result, scene) {
    return scene === 'seal'
      ? Number(result && result.enabledSealCount || 0) > 0
      : !!result && result.status === 'VERIFIED';
  },

  async readAuthenticationResult(url, scene, token = getApp().globalData.token) {
    // These endpoints authorize the user against the company in the URL, including pending claims.
    const options = { url, withCompany: false, token };
    const current = await request(options);
    if (this._unloaded || token !== getApp().globalData.token) return null;
    if (this.authenticationCompleted(current, scene)) return current;
    try {
      return await request({ ...options, url: `${url}/sync`, method: 'POST' });
    } catch (error) {
      if (this._unloaded || token !== getApp().globalData.token) return null;
      // A callback or another request may have committed success while this sync failed.
      try {
        const latest = await request(options);
        if (this.authenticationCompleted(latest, scene)) return latest;
      } catch (readError) {}
      throw error;
    }
  },

  goBusinessPage() {
    if (this.data.loading || this._unloaded) return;
    if (this._resultToken !== undefined && this._resultToken !== getApp().globalData.token) return;
    if (this.returnTimer) clearTimeout(this.returnTimer);
    const options = this.data.options || {};
    if (options.scene === 'legal') {
      wx.redirectTo({ url: `/pages/legal-representative/legal-representative?companyId=${encodeURIComponent(options.companyId || '')}` });
      return;
    }
    if (options.scene === 'personal') {
      if (!this.data.failed && options.flow !== 'company-create') {
        wx.switchTab({ url: '/pages/index/index' });
        return;
      }
      if (options.flow === 'company-create' && !this.data.failed) {
        returnToCompany(options);
        return;
      }
      const query = options.flow === 'company-create'
        ? `?flow=company-create${options.companyId ? '&companyId=' + encodeURIComponent(options.companyId) : ''}` : '';
      wx.redirectTo({ url: `/pages/personal-cert/personal-cert${query}` });
      return;
    }
    if (options.scene === 'company' || options.scene === 'seal') {
      if (this._companyCompleted) {
        wx.switchTab({ url: '/pages/company/company' });
        return;
      }
      if (!options.companyId) {
        wx.switchTab({ url: '/pages/index/index' });
        return;
      }
      const query = `companyId=${encodeURIComponent(options.companyId)}`;
      wx.redirectTo({ url: `/pages/company-cert/company-cert?${query}${options.scene === 'company' ? '&autoSwitch=1' : ''}` });
      return;
    }
    if (options.contractId) {
      wx.redirectTo({ url: `/pages/contract-preview/contract-preview?contractId=${options.contractId}` });
      return;
    }
    wx.switchTab({ url: '/pages/index/index' });
  }
});
