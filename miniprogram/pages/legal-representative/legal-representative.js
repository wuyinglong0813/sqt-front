const { request } = require('../../utils/request');
const app = getApp();

Page({
  data: { companyId: '', claimFlow: false, needsPersonalIdentity: false, enteringCompany: false,
    loading: false, verified: false, reviewRequired: false, messageTitle: '', message: '' },
  onLoad(options) {
    this._token = app.globalData.token;
    this.setData({ companyId: String(options.companyId || app.getCurrentCompanyId() || ''), claimFlow: options.claim === '1' });
  },
  onShow() {
    this._openingPersonalIdentity = false;
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
    this.setData({ verified, reviewRequired: reviewRequired || (this.data.claimFlow && !verified),
      messageTitle: verified ? (this.data.claimFlow ? '法人认领已完成' : '本人法人身份已确认')
        : reviewRequired ? '需补充法人身份核验' : '本人法人身份尚未确认',
      message: (result && result.message) || '尚未确认本人法人身份，请联系平台支持人工核验。' });
    if (verified) await app.loadMe();
  },
  openSupport() {
    if (this.isCurrent()) wx.navigateTo({ url: '/pages/help-center/help-center' });
  },
  openPersonalIdentity() {
    if (!this.isCurrent() || this.data.loading || this._openingPersonalIdentity || !this.data.companyId) return;
    this._openingPersonalIdentity = true;
    wx.navigateTo({ url: `/pages/personal-cert/personal-cert?flow=legal-claim&companyId=${encodeURIComponent(this.data.companyId)}`,
      fail: () => { this._openingPersonalIdentity = false; } });
  },
  async enterClaimedCompany() {
    if (!this.isCurrent() || !this.data.verified || this.data.enteringCompany) return;
    this.setData({ enteringCompany: true });
    try {
      await app.switchCompany(this.data.companyId);
      if (this.isCurrent()) wx.switchTab({ url: '/pages/company/company' });
    } catch (error) {
      if (this.isCurrent()) this.setData({ message: error.message || '企业切换暂未完成，请重试' });
    } finally {
      if (this.isCurrent()) this.setData({ enteringCompany: false });
    }
  },
  async refreshStatus() {
    if (this.data.loading || !this.data.companyId || !this.isCurrent()) return;
    this.setData({ loading: true });
    try {
      if (this.data.claimFlow) {
        const identity = await request({ url: '/fadada/users/me/identity', withCompany: false });
        if (!this.isCurrent()) return;
        const needsPersonalIdentity = !identity || identity.status !== 'VERIFIED';
        this.setData({ needsPersonalIdentity });
        if (needsPersonalIdentity) {
          this.setData({ verified: false, reviewRequired: false, messageTitle: '请先完成个人实名认证',
            message: '请法人本人使用自己的账号完成个人实名认证，完成后将返回本企业继续核验认领。无需先取得成员邀请。' });
          return;
        }
      }
      await this.syncLegalIdentity();
    } catch (error) {
      if (this.isCurrent()) this.setData({ message: error.message || '最新结果暂未同步，请稍后刷新' });
    } finally {
      if (this.isCurrent()) this.setData({ loading: false });
    }
  }
});
