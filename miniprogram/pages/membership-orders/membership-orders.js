const { request } = require('../../utils/request');
const { captureCompanyContext, isCompanyContextCurrent } = require('../../utils/companyContext');
const { paymentPlatform, presentOrder } = require('../../utils/membership');
const app = getApp();
Page({
  data: { loading: true, orders: [], errorMessage: '' },
  onShow() { this._unloaded = false; this.loadOrders(); },
  onUnload() { this._unloaded = true; this._sequence = (this._sequence || 0) + 1; },
  onPullDownRefresh() { this.loadOrders().finally(() => wx.stopPullDownRefresh()); },
  async loadOrders() {
    const context = captureCompanyContext(app), sequence = this._sequence = (this._sequence || 0) + 1;
    this.setData({ loading: true, orders: [], errorMessage: '' });
    if (!context.token || !context.companyId) { this.setData({ loading: false, errorMessage: '请先登录并选择企业' }); return; }
    try {
      const orders = await request({ url: '/membership/orders?platform=' + paymentPlatform(),
        token: context.token, companyId: context.companyId });
      if (this._unloaded || sequence !== this._sequence || !isCompanyContextCurrent(app, context)) return;
      this.setData({ loading: false, orders: (orders || []).map(presentOrder) });
    } catch (e) {
      if (!this._unloaded && sequence === this._sequence && isCompanyContextCurrent(app, context))
        this.setData({ loading: false, errorMessage: e.message || '购买记录加载失败' });
    }
  },
  openOrder(e) { wx.navigateTo({ url: '/pages/membership-order/membership-order?orderNo=' + encodeURIComponent(e.currentTarget.dataset.id) }); },
  retry() { this.loadOrders(); }
});
