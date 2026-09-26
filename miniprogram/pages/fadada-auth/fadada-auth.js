const { request } = require('../../utils/request');

const SCENES = {
  personal: { title: '个人认证', loading: '正在打开个人认证', endpoint: '/fadada/users/me/auth-url', withCompany: false },
  company: { title: '企业认证', loading: '正在打开企业认证', withCompany: false },
  legal: { title: '法人身份核验', loading: '正在打开法人身份核验', withCompany: false },
  seal: { title: '电子印章', loading: '正在打开印章管理', withCompany: false },
  contract: { title: '合同签署', loading: '正在打开合同签署' },
  abolish: { title: '合同作废签署', loading: '正在打开作废签署' }
};

Page({
  data: {
    loading: true,
    serviceUrl: '',
    errorMessage: '',
    scene: 'personal',
    pageTitle: '认证服务',
    loadingText: '正在连接安全服务',
    options: {},
    serviceHost: ''
  },

  onLoad(options) {
    this._visible = true;
    this._unloaded = false;
    const scene = SCENES[options.scene] ? options.scene : 'personal';
    const config = SCENES[scene];
    this.setData({ scene, options, pageTitle: config.title, loadingText: config.loading });
    wx.setNavigationBarTitle({ title: config.title });
    this.prepareService();
  },

  onShow() {
    if (this._unloaded) return;
    this._visible = true;
    if (this.data.serviceUrl && !this.pollTimer) this.startStatusPolling();
  },

  onHide() { this._visible = false; this.stopStatusPolling(); },
  onUnload() { this._unloaded = true; this._visible = false; this.stopStatusPolling();
    if (this._reloadTimer) clearTimeout(this._reloadTimer); },

  async prepareService() {
    if (this._preparing || this._unloaded) return;
    this._preparing = true;
    this.setData({ loading: true, errorMessage: '' });
    const token = getApp().globalData.token;
    try {
      const result = await this.readAuthStatus(true);
      if (this._unloaded || token !== getApp().globalData.token) return;
      if (result && result.status === 'VERIFIED') {
        this.openReturnPage();
        return;
      }
      await this.loadServiceUrl();
    } catch (error) {
      if (!this._unloaded && token === getApp().globalData.token) {
        this.setData({ loading: false, errorMessage: error.message || '认证状态暂时无法确认，请重试' });
      }
    } finally {
      this._preparing = false;
    }
  },

  async readAuthStatus(forceSync = false) {
    const { scene, options } = this.data;
    if (!['personal', 'company', 'legal'].includes(scene)) return null;
    const token = getApp().globalData.token;
    if (scene === 'legal') return request({
      url: `/fadada/companies/${options.companyId}/legal-representative/sync`,
      method: 'POST', withCompany: false, token, timeout: 15000
    });
    const url = scene === 'personal' ? '/fadada/users/me/identity'
      : `/fadada/companies/${options.companyId}/identity`;
    const current = await request({ url, withCompany: false, token, timeout: 15000 });
    if (this._unloaded || token !== getApp().globalData.token
        || !current || ['VERIFIED', 'FAILED', 'NOT_STARTED'].includes(current.status)) return current;
    if (!forceSync && this._lastProviderSync && Date.now() - this._lastProviderSync < 30000) return current;
    this._lastProviderSync = Date.now();
    try {
      return await request({ url: `${url}/sync`, method: 'POST', withCompany: false, token, timeout: 15000 });
    } catch (error) {
      // A callback may have completed the identity while the provider query failed.
      const latest = await request({ url, withCompany: false, token, timeout: 15000 });
      if (latest && latest.status === 'VERIFIED') return latest;
      throw error;
    }
  },

  // Contract used by the official Fadada face-verification bridge.
  acceptsReturnUrl(url) {
    const host = this.extractHost(url).toLowerCase();
    return !!host && host === this.extractHost(this.data.serviceUrl).toLowerCase()
      && !String(url).includes('\\');
  },

  setIsRedirect() { this.stopStatusPolling(); },

  reloadPage(url) {
    if (!this.acceptsReturnUrl(url) || this._unloaded) return false;
    this.stopStatusPolling();
    if (this._reloadTimer) clearTimeout(this._reloadTimer);
    const token = getApp().globalData.token;
    // Remount the web-view without requesting another authentication URL.
    this.setData({ serviceUrl: '', errorMessage: '', loading: true });
    this._reloadTimer = setTimeout(() => {
      if (this._unloaded || token !== getApp().globalData.token) return;
      this.setData({ serviceUrl: url, serviceHost: this.extractHost(url), loading: false });
      this._lastProviderSync = 0;
      this.startStatusPolling();
    }, 0);
    return true;
  },

  async loadServiceUrl() {
    if (this._loadingServiceUrl || this._unloaded) return;
    this._loadingServiceUrl = true;
    const token = getApp().globalData.token;
    const { scene, options } = this.data;
    const config = SCENES[scene];
    this.setData({ loading: true, serviceUrl: '', errorMessage: '' });
    try {
      let endpoint = config.endpoint;
      if (scene === 'company') endpoint = `/fadada/companies/${options.companyId}/auth-url`;
      if (scene === 'legal') endpoint = `/fadada/companies/${options.companyId}/legal-representative/auth-url`;
      if (scene === 'seal') endpoint = `/fadada/companies/${options.companyId}/seal-manage-url`;
      if (scene === 'contract') endpoint = `/contracts/${options.contractId}/sign-url`;
      if (scene === 'abolish') endpoint = `/contracts/${options.contractId}/abolish-url`;
      if (!endpoint) throw new Error('服务参数不完整');
      const result = await request({
        url: endpoint,
        method: 'POST',
        token,
        data: scene === 'abolish' ? { reason: decodeURIComponent(options.reason || '') } : {},
        withCompany: config.withCompany !== false,
        timeout: 30000
      });
      if (this._unloaded || token !== getApp().globalData.token) return;
      const serviceUrl = result && (result.url || result.authUrl);
      const status = result && (result.status || (result.identity && result.identity.status));
      if (!serviceUrl && status && ['personal', 'company'].includes(scene)) {
        this.openReturnPage();
        return;
      }
      if (!serviceUrl) throw new Error('未获取到服务地址');
      this.setData({ serviceUrl, serviceHost: this.extractHost(serviceUrl) });
      this.startStatusPolling();
    } catch (error) {
      if (!this._unloaded && token === getApp().globalData.token) {
        this.setData({ errorMessage: error.message || '服务页面加载失败' });
      }
    } finally {
      this._loadingServiceUrl = false;
      if (!this._unloaded) this.setData({ loading: false });
    }
  },

  onWebViewError() {
    this.stopStatusPolling();
    const host = this.data.serviceHost;
    this.setData({
      errorMessage: host
        ? `服务页面打开失败，请在小程序业务域名中检查：${host}`
        : '服务页面打开失败，请检查网络或小程序业务域名配置。'
    });
  },

  startStatusPolling() {
    const { scene } = this.data;
    // Seal management is an editor: an existing seal does not mean editing is complete.
    if (!['personal', 'company', 'legal'].includes(scene) || this.pollTimer
        || this._visible === false || this._unloaded) return;
    this.pollAttempts = 0;
    const generation = this._pollGeneration = (this._pollGeneration || 0) + 1;
    this.scheduleStatusPoll(generation);
  },

  isPollingCurrent(generation) {
    return !this._unloaded && this._visible !== false
      && generation === (this._pollGeneration || 0);
  },

  scheduleStatusPoll(generation = this._pollGeneration || 0) {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    if (!this.isPollingCurrent(generation)) return;
    if ((this.pollAttempts || 0) >= 120) { this.openReturnPage(); return; }
    this.pollTimer = setTimeout(() => this.pollStatus(generation), 2500);
  },

  async pollStatus(generation = this._pollGeneration || 0) {
    if (!this.isPollingCurrent(generation) || this.data.scene === 'seal') return;
    this.pollTimer = null;
    const { scene, options } = this.data;
    const token = getApp().globalData.token;
    try {
      const result = await this.readAuthStatus();
      if (!this.isPollingCurrent(generation) || token !== getApp().globalData.token) return;
      const completed = !!(result && (['VERIFIED', 'FAILED'].includes(result.status)
        || (scene === 'company' && result.failureReason)));
      if (completed) {
        this.openReturnPage();
        return;
      }
    } catch (error) {
      // Keep the provider page open while transient status queries fail.
    }
    if (!this.isPollingCurrent(generation) || token !== getApp().globalData.token) return;
    this.pollAttempts = (this.pollAttempts || 0) + 1;
    this.scheduleStatusPoll(generation);
  },

  openReturnPage() {
    if (this._unloaded || this._visible === false || this._returning) return;
    this._returning = true;
    this.stopStatusPolling();
    const { scene, options } = this.data;
    const query = [`scene=${scene}`];
    if (options.flow === 'company-create') query.push('flow=company-create');
    if (options.companyId) query.push(`companyId=${encodeURIComponent(options.companyId)}`);
    if (options.contractId) query.push(`contractId=${encodeURIComponent(options.contractId)}`);
    wx.redirectTo({ url: `/pages/service-return/service-return?${query.join('&')}`,
      fail: () => { this._returning = false; } });
  },

  stopStatusPolling() {
    this._pollGeneration = (this._pollGeneration || 0) + 1;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
  },

  extractHost(value) {
    const match = String(value || '').match(/^https:\/\/([^/?#]+)/i);
    return match ? match[1] : '';
  },

  retry() { this.prepareService(); },
  checkResult() { this.openReturnPage(); },
  goBack() { wx.navigateBack(); }
});
