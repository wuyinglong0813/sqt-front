const { request } = require('../../utils/request');
const { captureCompanyContext, isCompanyContextCurrent } = require('../../utils/companyContext');
const dict = require('../../utils/dict');
const app = getApp();

Page({
  data: { loading: true, errorMessage: '', company: {}, member: {}, companyId: '',
    certificationText: '', canVerifyLegal: false },
  onShow() { return this.loadInfo(); },
  onUnload() { this._unloaded = true; },
  onPullDownRefresh() { return this.loadInfo().finally(() => wx.stopPullDownRefresh()); },
  async loadInfo() {
    const context = captureCompanyContext(app);
    const sequence = this._loadSequence = (this._loadSequence || 0) + 1;
    const current = () => !this._unloaded && sequence === this._loadSequence && isCompanyContextCurrent(app, context);
    this.setData({ loading: true, errorMessage: '', canVerifyLegal: false });
    try {
      if (!context.companyId) throw new Error('请先选择企业');
      const payload = await request({ url: '/me', token: context.token, companyId: context.companyId });
      if (!current()) return;
      const company = payload.company || {};
      const member = payload.member || {};
      const isLegal = member.roleCode === 'LEGAL'
        || (member.roles || []).some(role => role.code === 'LEGAL');
      this._infoContext = context;
      this.setData({ company, member, companyId: context.companyId,
        certificationText: dict.certification(company.certificationStatus).text,
        canVerifyLegal: member.memberStatus === 'ACTIVE' && !isLegal });
    } catch (error) {
      if (current()) this.setData({ errorMessage: error.message || '企业资料暂时无法读取，请重试。' });
    } finally {
      if (current()) this.setData({ loading: false });
    }
  },
  goLegalVerification() {
    if (!this.data.canVerifyLegal || !this._infoContext || !isCompanyContextCurrent(app, this._infoContext)) return;
    wx.navigateTo({ url: `/pages/legal-representative/legal-representative?companyId=${encodeURIComponent(this.data.companyId)}` });
  }
});
