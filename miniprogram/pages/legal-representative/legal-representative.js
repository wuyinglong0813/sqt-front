const { request } = require('../../utils/request');
const app = getApp();

Page({
  data: { companyId: '', loading: false, verified: false, message: '' },
  onLoad(options) {
    this._token = app.globalData.token;
    this.setData({ companyId: String(options.companyId || app.getCurrentCompanyId() || '') });
  },
  onShow() {
    return this.refreshStatus();
  },
  onUnload() { this._unloaded = true; },
  isCurrent() { return !this._unloaded && this._token === app.globalData.token; },
  async startVerification() {
    if (this.data.loading || this.data.verified || !this.data.companyId || !this.isCurrent()) return;
    this.setData({ loading: true });
    try {
      const identity = await request({ url: '/fadada/users/me/identity', withCompany: false });
      if (!this.isCurrent()) return;
      if (!identity || identity.status !== 'VERIFIED') {
        wx.showModal({ title: '请先完成个人认证', content: '请法人本人使用自己的账号完成实名认证，再返回本页核验法人身份。', confirmText: '去认证', success: result => {
          if (result.confirm && this.isCurrent()) wx.navigateTo({ url: '/pages/personal-cert/personal-cert' });
        } });
        return;
      }
      await this.syncLegalIdentity();
    } catch (error) {
      if (this.isCurrent()) this.setData({ message: error.message || '暂时无法打开核验，请稍后重试' });
    } finally {
      if (this.isCurrent()) this.setData({ loading: false });
    }
  },
  async syncLegalIdentity() {
    const result = await request({ url: `/fadada/companies/${this.data.companyId}/legal-representative/sync`, method: 'POST', withCompany: false });
    if (!this.isCurrent()) return;
    const verified = result && result.status === 'VERIFIED';
    this.setData({ verified, message: (result && result.message) || '尚未确认本人法人身份，请联系平台管理员核验。' });
    if (verified) await app.loadMe();
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
