const { request } = require('../../utils/request');
const { captureCompanyContext, isCompanyContextCurrent } = require('../../utils/companyContext');
const dict = require('../../utils/dict');
const app = getApp();

Page({
  data: { loading: true, errorMessage: '', company: {}, member: {}, companyId: '',
    certificationText: '', canVerifyLegal: false, canEditCompany: false, editing: false, saving: false,
    businessInfo: { registeredAddress: '', contactPhone: '', bankName: '', bankAccount: '' } },
  onShow() { return this.loadInfo(); },
  onUnload() { this._unloaded = true; },
  onPullDownRefresh() { return this.loadInfo().finally(() => wx.stopPullDownRefresh()); },
  async loadInfo() {
    this._saveSequence = (this._saveSequence || 0) + 1;
    const context = captureCompanyContext(app);
    const sequence = this._loadSequence = (this._loadSequence || 0) + 1;
    const current = () => !this._unloaded && sequence === this._loadSequence && isCompanyContextCurrent(app, context);
    this.setData({ loading: true, errorMessage: '', canVerifyLegal: false, canEditCompany: false, editing: false, saving: false });
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
        canEditCompany: member.memberStatus === 'ACTIVE' && isLegal,
        businessInfo: { registeredAddress: company.registeredAddress || '', contactPhone: company.contactPhone || '',
          bankName: company.bankName || '', bankAccount: company.bankAccount || '' },
        canVerifyLegal: member.memberStatus === 'ACTIVE' && !isLegal });
    } catch (error) {
      if (current()) this.setData({ errorMessage: error.message || '企业资料暂时无法读取，请重试。' });
    } finally {
      if (current()) this.setData({ loading: false });
    }
  },
  editBusinessInfo() {
    if (!this.data.canEditCompany || !this._infoContext || !isCompanyContextCurrent(app, this._infoContext)) return;
    this.setData({ editing: true });
  },
  cancelBusinessInfo() {
    if (this.data.saving) return;
    const company = this.data.company;
    this.setData({ editing: false, businessInfo: {
      registeredAddress: company.registeredAddress || '', contactPhone: company.contactPhone || '',
      bankName: company.bankName || '', bankAccount: company.bankAccount || '' } });
  },
  onBusinessInfoInput(e) {
    const field = e.currentTarget.dataset.field;
    if (!['registeredAddress', 'contactPhone', 'bankName', 'bankAccount'].includes(field)) return;
    this.setData({ businessInfo: { ...this.data.businessInfo, [field]: e.detail.value } });
  },
  async saveBusinessInfo() {
    const context = this._infoContext;
    if (!this.data.canEditCompany || !this.data.editing || this.data.saving || !context || !isCompanyContextCurrent(app, context)) return;
    const sequence = this._saveSequence = (this._saveSequence || 0) + 1;
    const current = () => !this._unloaded && sequence === this._saveSequence && isCompanyContextCurrent(app, context);
    const company = this.data.company;
    const details = {};
    Object.keys(this.data.businessInfo).forEach(field => { details[field] = this.data.businessInfo[field].trim(); });
    this.setData({ saving: true });
    try {
      const saved = await request({ url: '/companies', method: 'POST', token: context.token, companyId: context.companyId,
        data: { id: context.companyId, name: company.name, creditCode: company.creditCode,
          legalPersonName: company.legalPersonName, ...details } });
      if (!current()) return;
      this.setData({ company: { ...company, ...saved }, editing: false });
      wx.showToast({ title: '企业资料已保存', icon: 'success' });
    } catch (error) {
      if (current()) wx.showToast({ title: error.message || '保存失败，请重试', icon: 'none' });
    } finally {
      if (current()) this.setData({ saving: false });
    }
  },
  goLegalVerification() {
    if (!this.data.canVerifyLegal || !this._infoContext || !isCompanyContextCurrent(app, this._infoContext)) return;
    wx.navigateTo({ url: `/pages/legal-representative/legal-representative?companyId=${encodeURIComponent(this.data.companyId)}` });
  }
});
