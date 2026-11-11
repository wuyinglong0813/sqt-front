const { context, sameContext, retailRequest, customerView, retailTerms } = require('../../utils/retail');
Page({
  data: { customers: [], loading: false, saving: false, error: '', page: 1, hasMore: false, canCreate: false,
    formMode: false, editId: '', showInvoice: false, typeIndex: 0, terms: retailTerms(),
    types: ['企业', '个体工商户', '个人'], typeCodes: ['COMPANY', 'INDIVIDUAL_BUSINESS', 'PERSON'],
    form: { name: '', contact: '', phone: '', address: '', invoiceTitle: '', taxNo: '', remark: '' } },
  onLoad(options) {
    this.companyContext = context();
    const terms = retailTerms(options.direction);
    this.setData({ formMode: options.create === '1' || !!options.editId, editId: options.editId || '', terms });
    const action = options.editId ? '编辑' : options.create === '1' ? '新增' : '';
    wx.setNavigationBarTitle({ title: `${action}${terms.business}${terms.party}` });
  },
  onShow() {
    if (!sameContext(this.companyContext)) { this.setData({ customers: [], error: '企业已切换，请返回首页重新进入' }); return; }
    if (this.data.editId) this.loadCustomer();
    else if (!this.data.formMode) this.loadCustomers(true);
  },
  onPullDownRefresh() {
    const refresh = this.data.formMode ? Promise.resolve() : this.loadCustomers(true);
    refresh.finally(() => wx.stopPullDownRefresh());
  },
  onReachBottom() { if (!this.data.formMode && this.data.hasMore && !this.data.loading) this.loadCustomers(false); },
  async loadCustomers(reset) {
    if (this.data.loading) return;
    this.setData({ loading: true, error: '' });
    try {
      const page = reset ? 1 : this.data.page + 1;
      const result = await retailRequest(this.companyContext, { url: `/retail/customers?page=${page}&size=20${this.data.terms.directionParam}` });
      this.setData({ customers: reset ? result.items.map(customerView) : this.data.customers.concat(result.items.map(customerView)),
        page, hasMore: result.hasMore, canCreate: !!result.canCreate });
    } catch (e) { this.setData({ error: e.message }); }
    finally { this.setData({ loading: false }); }
  },
  async loadCustomer() {
    this.setData({ loading: true, error: '' });
    try {
      const result = await retailRequest(this.companyContext, { url: `/retail/customers/${this.data.editId}` });
      const terms = retailTerms(result.direction);
      this.setData({ form: result, typeIndex: Math.max(0, this.data.typeCodes.indexOf(result.customerType)), canCreate: result.canEdit, terms });
      wx.setNavigationBarTitle({ title: `编辑${terms.business}${terms.party}` });
    } catch (e) { this.setData({ error: e.message }); }
    finally { this.setData({ loading: false }); }
  },
  addCustomer() { wx.navigateTo({ url: `/pages/retail-customers/retail-customers?create=1${this.data.terms.directionParam}` }); },
  openCustomer(e) { wx.navigateTo({ url: `/pages/retail-customer-detail/retail-customer-detail?id=${e.currentTarget.dataset.id}${this.data.terms.directionParam}` }); },
  onInput(e) {
    const field = e.currentTarget.dataset.field;
    if (['name', 'contact', 'phone', 'address', 'invoiceTitle', 'taxNo', 'remark'].includes(field)) this.setData({ [`form.${field}`]: e.detail.value });
  },
  selectType(e) { this.setData({ typeIndex: Number(e.detail.value) }); },
  toggleInvoice() { this.setData({ showInvoice: !this.data.showInvoice }); },
  async save(e) {
    if (this.data.saving) return;
    const { terms, editId } = this.data;
    if (!this.data.form.name.trim()) { wx.showToast({ title: `请填写${terms.party}名称`, icon: 'none' }); return; }
    this.setData({ saving: true, error: '' });
    try {
      const customerPath = editId ? `/${editId}` : terms.directionParam.replace('&', '?');
      const result = await retailRequest(this.companyContext, { url: `/retail/customers${customerPath}`,
        method: 'POST', data: { ...this.data.form, customerType: this.data.typeCodes[this.data.typeIndex] } });
      const openSale = e.currentTarget.dataset.sale === '1';
      wx.redirectTo({ url: openSale ? `/pages/retail-order-form/retail-order-form?customerId=${result.id}&type=${terms.orderType}${terms.directionParam}`
        : `/pages/retail-customer-detail/retail-customer-detail?id=${result.id}${terms.directionParam}` });
    } catch (err) { this.setData({ error: err.message }); }
    finally { this.setData({ saving: false }); }
  }
});
