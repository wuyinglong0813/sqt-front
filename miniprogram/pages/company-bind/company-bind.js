const { request } = require('../../utils/request');

Page({
  data: {
    mode: 'create',
    companyName: '',
    creditCode: '',
    legalPersonName: '',
    keyword: '',
    results: [],
    searched: false,
    selectedCompany: null
  },

  switchMode(e) {
    this.setData({ mode: e.currentTarget.dataset.mode, selectedCompany: null });
  },

  onCompanyInput(e) {
    const field = e.currentTarget.dataset.field;
    if (!['companyName', 'creditCode', 'legalPersonName'].includes(field)) return;
    this.setData({ [field]: e.detail.value });
  },

  continueCreate() {
    const companyName = this.data.companyName.trim();
    const creditCode = this.data.creditCode.trim().toUpperCase();
    const legalPersonName = this.data.legalPersonName.trim();
    if (!companyName || !creditCode || !legalPersonName) {
      wx.showToast({ title: '请完整填写企业信息', icon: 'none' });
      return;
    }
    if (!/^[0-9A-HJ-NPQRTUWXY]{18}$/.test(creditCode) && !/^\d{15}$/.test(creditCode)) {
      wx.showToast({ title: '请检查信用代码或工商注册号', icon: 'none' });
      return;
    }
    this.setData({ companyName, creditCode, legalPersonName });
    wx.navigateTo({
      url: `/pages/company-cert/company-cert?name=${encodeURIComponent(companyName)}&creditCode=${encodeURIComponent(creditCode)}&legalPersonName=${encodeURIComponent(legalPersonName)}`
    });
  },

  onKeywordInput(e) {
    this.setData({ keyword: e.detail.value });
  },

  clearKeyword() {
    this.setData({ keyword: '', results: [], searched: false });
  },

  // 查询平台内已入驻企业；接口只返回脱敏后的最小信息
  async doSearch() {
    const keyword = this.data.keyword.trim();
    if (!keyword) {
      wx.showToast({ title: '请输入企业名称（与营业执照上一致）', icon: 'none' });
      return;
    }
    if (keyword.length < 2) {
      wx.showToast({ title: '至少输入 2 个字符', icon: 'none' });
      return;
    }
    wx.showLoading({ title: '搜索中...' });
    try {
      const results = await request({
        url: `/companies/search?keyword=${encodeURIComponent(keyword)}`
      });
      this.setData({ results: results || [], searched: true, selectedCompany: null });
    } catch (e) {
      wx.showToast({ title: e.message, icon: 'none' });
    } finally {
      wx.hideLoading();
    }
  },

  // 从搜索结果中选择一家企业
  selectCompany(e) {
    const company = this.data.results[e.currentTarget.dataset.index];
    this.setData({ selectedCompany: company });
  },

  // 确认企业，跳转实名认证
  confirmCompany() {
    const c = this.data.selectedCompany;
    if (!c) return;
    wx.showModal({
      title: '企业已入驻',
      content: `请联系“${c.name}”的企业管理员，通过成员邀请加入。`,
      showCancel: false
    });
  }
});
