const { request } = require('../../utils/request');
const { captureCompanyContext, isCompanyContextCurrent } = require('../../utils/companyContext');
const { paymentPlatform, presentProduct } = require('../../utils/membership');
const app = getApp();
Page({
  data: { loading: true, catalog: null, products: [], errorMessage: '', creating: false },
  onLoad(options) { this._signingContinuationId = options.continuationId || ''; },
  onShow() { this._unloaded = false; this.loadCatalog(); },
  onUnload() {
    this._unloaded = true;
    this._sequence = (this._sequence || 0) + 1;
    this._createdOrders = [];
    this._openingOrder = null;
  },
  onPullDownRefresh() { this.loadCatalog().finally(() => wx.stopPullDownRefresh()); },
  async loadCatalog() {
    const context = captureCompanyContext(app);
    this._createdOrders = (this._createdOrders || []).filter(order => isCompanyContextCurrent(app, order.context));
    const sequence = this._sequence = (this._sequence || 0) + 1;
    this.setData({ loading: true, catalog: null, products: [], errorMessage: '' });
    if (!context.token || !context.companyId) {
      this.setData({ loading: false, errorMessage: '请先登录并选择企业' }); return;
    }
    try {
      const catalog = await request({ url: '/membership/products?platform=' + paymentPlatform(),
        token: context.token, companyId: context.companyId });
      if (this._unloaded || sequence !== this._sequence || !isCompanyContextCurrent(app, context)) return;
      this.setData({ catalog, products: (catalog.products || []).map(presentProduct), loading: false });
    } catch (e) {
      if (!this._unloaded && sequence === this._sequence && isCompanyContextCurrent(app, context))
        this.setData({ loading: false, errorMessage: e.message || '套餐加载失败' });
    }
  },
  async buy(e) {
    if (this._creating || this._openingOrder || !this.data.catalog || !this.data.catalog.purchaseEnabled) return;
    const product = this.data.products.find(item => item.id === e.currentTarget.dataset.id);
    if (!product || !product.canBuy) return;
    const context = captureCompanyContext(app);
    if (!context.token || !context.companyId || String(this.data.catalog.companyId) !== context.companyId) {
      this.loadCatalog(); return;
    }
    this._createdOrders = (this._createdOrders || []).filter(order => isCompanyContextCurrent(app, order.context));
    const created = this._createdOrders.find(order => order.productId === product.id);
    if (created) { this.openCreatedOrder(created); return; }
    const keyScope = context.companyId + ':' + product.id;
    if (!this._requestKey || this._requestKey.scope !== keyScope
        || !isCompanyContextCurrent(app, this._requestKey.context)) this._requestKey = {
      scope: keyScope, context, value: Date.now().toString(36) + '-' + Math.random().toString(36).slice(2) + '-' + Math.random().toString(36).slice(2)
    };
    this._creating = true; this.setData({ creating: true });
    try {
      const order = await request({ url: '/membership/orders', method: 'POST',
        token: context.token, companyId: context.companyId,
        data: { productId: product.id, idempotencyKey: this._requestKey.value, platform: paymentPlatform() } });
      if (this._unloaded || !isCompanyContextCurrent(app, context)) return;
      this._requestKey = null;
      const created = { productId: product.id, orderNo: order.orderNo, context,
        continuationId: this._signingContinuationId || '' };
      this._createdOrders.push(created);
      this.openCreatedOrder(created);
    } catch (error) {
      if (!this._unloaded && isCompanyContextCurrent(app, context))
        wx.showToast({ title: error.message || '订单创建失败，可重试', icon: 'none' });
    } finally { this._creating = false; if (!this._unloaded) this.setData({ creating: false }); }
  },
  openCreatedOrder(order) {
    if (this._unloaded || this._openingOrder || !isCompanyContextCurrent(app, order.context)) return;
    this._openingOrder = order;
    const continuation = order.continuationId ? '&continuationId=' + encodeURIComponent(order.continuationId) : '';
    const finish = () => { if (this._openingOrder === order) this._openingOrder = null; };
    wx.navigateTo({ url: '/pages/membership-order/membership-order?orderNo=' + encodeURIComponent(order.orderNo) + continuation,
      success: () => {
        finish();
        this._createdOrders = (this._createdOrders || []).filter(item => item !== order);
      },
      fail: () => {
        finish();
        if (!this._unloaded && isCompanyContextCurrent(app, order.context))
          wx.showToast({ title: '订单已创建，页面暂未打开，请再次点击重试', icon: 'none' });
      } });
  },
  openOrders() { wx.navigateTo({ url: '/pages/membership-orders/membership-orders' }); },
  retry() { this.loadCatalog(); }
});
