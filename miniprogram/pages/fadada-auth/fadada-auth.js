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
    this.loadServiceUrl();
  },

  onShow() {
    if (this._unloaded) return;
    this._visible = true;
    if (this.data.serviceUrl && !this.pollTimer) this.startStatusPolling();
  },

  onHide() { this._visible = false; this.stopStatusPolling(); },
  onUnload() { this._unloaded = true; this._visible = false; this.stopStatusPolling(); },

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
    if (!this.isPollingCurrent(generation) || (this.pollAttempts || 0) >= 120) return;
    this.pollTimer = setTimeout(() => this.pollStatus(generation), 2500);
  },

  async pollStatus(generation = this._pollGeneration || 0) {
    if (!this.isPollingCurrent(generation) || this.data.scene === 'seal') return;
    this.pollTimer = null;
    const { scene, options } = this.data;
    const token = getApp().globalData.token;
    try {
      let result;
      if (scene === 'personal') {
        result = await request({
          url: '/fadada/users/me/identity', withCompany: false, token,
          timeout: 15000
        });
      } else {
        result = await request({
          url: scene === 'legal'
            ? `/fadada/companies/${options.companyId}/legal-representative/sync`
            : `/fadada/companies/${options.companyId}/identity/sync`, method: 'POST', token,
          withCompany: false,
          timeout: 15000
        });
      }
      if (!this.isPollingCurrent(generation) || token !== getApp().globalData.token) return;
      const completed = !!(result && ['VERIFIED', 'FAILED'].includes(result.status));
      if (completed) {
        this.openReturnPage();
        return;
      }
    } catch (error) {
      // Personal auth reads callback-updated local state; explicit refresh/return syncs the provider.
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

  retry() { this.loadServiceUrl(); },
  goBack() { wx.navigateBack(); }
});
