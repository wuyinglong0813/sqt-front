const { request } = require('../../utils/request');
const { returnToCompany } = require('../../utils/companyOnboarding');

Page({
  data: {
    title: '正在确认处理结果',
    message: '请稍候，正在同步最新状态',
    loading: true,
    failed: false,
    options: {}
  },

  onLoad(options) {
    this.setData({ options });
    this.syncResult();
  },

  onUnload() {
    this._unloaded = true;
    if (this.returnTimer) clearTimeout(this.returnTimer);
  },

  async syncResult() {
    if (this._syncing || this._unloaded) return;
    this._syncing = true;
    const token = this._resultToken = getApp().globalData.token;
    const current = () => !this._unloaded && token === getApp().globalData.token;
    this.setData({ loading: true });
    const options = this.data.options || {};
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
        this.setData({ loading: false, failed: true,
          title: result && result.status === 'FAILED' ? '认证未通过' : '处理结果待确认',
          message: (result && (result.failureReason || result.message || result.statusText)) || '结果尚未更新，请稍后刷新' });
        return;
      }
      if (options.scene === 'company') {
        await getApp().switchCompany(options.companyId);
        if (!current()) return;
        this._companyCompleted = true;
        this.setData({ loading: false, failed: false, title: '企业认证成功', message: '已切换到本次认证企业，正在进入首页' });
        this.goBusinessPage();
        return;
      }
      if (options.scene === 'legal') {
        await getApp().loadMe();
        if (!current()) return;
      }
      this.setData({
        loading: false,
        failed: false,
        title: '处理结果已同步',
        message: (result && (result.statusText || result.status)) || '你可以返回业务页面继续操作'
      });
      if (current()) this.returnTimer = setTimeout(() => { if (current()) this.goBusinessPage(); }, 700);
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
        wx.switchTab({ url: '/pages/index/index' });
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
