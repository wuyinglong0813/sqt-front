const { request } = require('../../utils/request');
const app = getApp();

Page({
  data: { companyId: '', loading: false, verified: false, reviewRequired: false, messageTitle: '', message: '' },
  onLoad(options) {
    this._token = app.globalData.token;
    this.setData({ companyId: String(options.companyId || app.getCurrentCompanyId() || '') });
  },
  onShow() {
    return this.refreshStatus();
  },
  onUnload() { this._unloaded = true; },
  isCurrent() { return !this._unloaded && this._token === app.globalData.token; },
  startVerification() {
    if (this.data.verified) return;
    return this.refreshStatus();
  },
  async syncLegalIdentity() {
    const result = await request({ url: `/fadada/companies/${this.data.companyId}/legal-representative/sync`, method: 'POST', withCompany: false });
    if (!this.isCurrent()) return;
    const verified = result && result.status === 'VERIFIED';
    const reviewRequired = result && result.status === 'REVIEW_REQUIRED';
    this.setData({ verified, reviewRequired,
      messageTitle: verified ? '本人法人身份已确认' : reviewRequired ? '需补充法人身份核验' : '本人法人身份尚未确认',
      message: (result && result.message) || '尚未确认本人法人身份，请联系平台支持人工核验。' });
    if (verified) await app.loadMe();
  },
  openSupport() {
    if (this.isCurrent()) wx.navigateTo({ url: '/pages/help-center/help-center' });
  },
  async refreshStatus() {
    if (this.data.loading || !this.data.companyId || !this.isCurrent()) return;
    this.setData({ loading: true });
    try {
      await this.syncLegalIdentity();
    } catch (error) {
      if (this.isCurrent()) this.setData({ message: error.message || '最新结果暂未同步，请稍后刷新' });
    } finally {
      if (this.isCurrent()) this.setData({ loading: false });
    }
  }
});
