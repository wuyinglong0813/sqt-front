const { context, sameContext, retailRequest, customerView, documentView } = require('../../utils/retail');
Page({
  data: { id: '', customer: null, documents: [], activeTab: 'SALES_ORDER', loading: false, error: '', page: 1, hasMore: false },
  onLoad(options) { this.companyContext = context(); this.setData({ id: options.id || '' }); },
  onShow() { this.loadData(true); },
  onPullDownRefresh() { this.loadData(true).finally(() => wx.stopPullDownRefresh()); },
  onReachBottom() { if (this.data.hasMore && !this.data.loading) this.loadData(false); },
  async loadData(reset = true) {
    if (!sameContext(this.companyContext)) { this.setData({ customer: null, documents: [], error: '企业已切换，请返回首页重新进入' }); return; }
    const seq = this.requestSeq = (this.requestSeq || 0) + 1;
    const type = this.data.activeTab, page = reset ? 1 : this.data.page + 1;
    this.setData({ loading: true, error: '' });
    try {
      const [customer, docs] = await Promise.all([
        reset ? retailRequest(this.companyContext, { url: `/retail/customers/${this.data.id}` }) : Promise.resolve(this.data.customer),
        retailRequest(this.companyContext, { url: `/retail/customers/${this.data.id}/documents?documentType=${type}&page=${page}&size=20` })
      ]);
      if (seq !== this.requestSeq) return;
      const rows = reset ? docs.items.map(documentView) : this.data.documents.concat(docs.items.map(documentView));
      const unique = new Map(rows.map(row => [row.id, row]));
      this.setData({ customer: customerView(customer), documents: Array.from(unique.values()), page, hasMore: docs.hasMore });
    } catch (e) { if (seq === this.requestSeq) this.setData({ error: e.message }); }
    finally { if (seq === this.requestSeq) this.setData({ loading: false }); }
  },
  switchTab(e) { this.setData({ activeTab: e.currentTarget.dataset.type, documents: [], page: 1 }); this.loadData(true); },
  editCustomer() { wx.navigateTo({ url: `/pages/retail-customers/retail-customers?editId=${this.data.id}` }); },
  createDocument(e) { wx.navigateTo({ url: `/pages/retail-order-form/retail-order-form?customerId=${this.data.id}&type=${e.currentTarget.dataset.type}` }); },
  openDocument(e) { wx.navigateTo({ url: `/pages/retail-order-detail/retail-order-detail?id=${e.currentTarget.dataset.id}` }); }
});
