const { context, sameContext, retailRequest, money, documentView } = require('../../utils/retail');
const { downloadApiFile } = require('../../utils/fileTransfer');
Page({
  data: { id: '', detail: null, loading: false, working: false, error: '', warehouses: [], downloading: false },
  onLoad(options) { this.companyContext = context(); this.setData({ id: options.id || '' }); },
  onShow() { this.loadData(); },
  onPullDownRefresh() { this.loadData().finally(() => wx.stopPullDownRefresh()); },
  async loadData() {
    if (!sameContext(this.companyContext)) { this.setData({ detail: null, error: '企业已切换，请返回首页重新进入' }); return; }
    this.setData({ loading: true, error: '' });
    try {
      const doc = await retailRequest(this.companyContext, { url: `/retail/documents/${this.data.id}` });
      const detail = { ...documentView(doc), isReturn: doc.documentType === 'RETURN_ORDER',
        items: doc.items.map(item => ({ ...item, amountText: money(item.amount),
          hasRoundingAdjustment: Number(item.roundingAdjustment || 0) !== 0 })) };
      this.setData({ detail });
      wx.setNavigationBarTitle({ title: detail.isReturn ? '零售退货单' : '零售销售单' });
      if (detail.canProcessStock) this.setData({ warehouses: await retailRequest(this.companyContext, { url: '/warehouses' }).catch(() => []) });
    } catch (e) { this.setData({ error: e.message }); }
    finally { this.setData({ loading: false }); }
  },
  edit() { const d = this.data.detail; wx.navigateTo({ url: `/pages/retail-order-form/retail-order-form?id=${d.id}&customerId=${d.customerId}&type=${d.documentType}` }); },
  async confirm() { await this.mutate('confirm', {}); },
  processStock() {
    if (this.data.working) return;
    if (!this.data.warehouses.length) { wx.showToast({ title: '请先在库存管理创建仓库', icon: 'none' }); return; }
    wx.showActionSheet({ itemList: this.data.warehouses.map(w => w.name), success: result => {
      this.mutate('stock', { warehouseId: this.data.warehouses[result.tapIndex].id });
    } });
  },
  deleteDraft() {
    wx.showModal({ title: '删除草稿', content: '确认删除这张未生效的零售单据？', success: async result => {
      if (!result.confirm || this.data.working) return;
      this.setData({ working: true });
      try { await retailRequest(this.companyContext, { url: `/retail/documents/${this.data.id}/delete`, method: 'POST' }); wx.navigateBack(); }
      catch (e) { this.setData({ error: e.message }); }
      finally { this.setData({ working: false }); }
    } });
  },
  async mutate(action, body) {
    if (this.data.working) return;
    this.setData({ working: true, error: '' });
    try { await retailRequest(this.companyContext, { url: `/retail/documents/${this.data.id}/${action}`, method: 'POST', data: body }); await this.loadData(); }
    catch (e) { this.setData({ error: e.message }); }
    finally { this.setData({ working: false }); }
  },
  createReturn() {
    const d = this.data.detail;
    wx.navigateTo({ url: `/pages/retail-order-form/retail-order-form?customerId=${d.customerId}&type=RETURN_ORDER&originalId=${d.id}` });
  },
  openCustomer() { wx.navigateTo({ url: `/pages/retail-customer-detail/retail-customer-detail?id=${this.data.detail.customerId}` }); },
  async viewPdf(e) {
    if (this.data.downloading || !sameContext(this.companyContext)) return;
    this.setData({ downloading: true });
    try {
      const filePath = `${wx.env.USER_DATA_PATH}/retail-${this.data.id}-${this.data.detail.status}.pdf`;
      const result = await downloadApiFile(`/retail/documents/${this.data.id}/pdf-data`, filePath);
      if (!sameContext(this.companyContext)) throw new Error('企业已切换，请返回首页');
      if (e.currentTarget.dataset.share === '1' && wx.shareFileMessage) wx.shareFileMessage({ filePath, fileName: result.fileName });
      else wx.openDocument({ filePath, fileType: 'pdf', showMenu: true, fail: () => wx.showToast({ title: 'PDF 打开失败，请重试', icon: 'none' }) });
    } catch (err) { wx.showToast({ title: err.message, icon: 'none' }); }
    finally { this.setData({ downloading: false }); }
  }
});
