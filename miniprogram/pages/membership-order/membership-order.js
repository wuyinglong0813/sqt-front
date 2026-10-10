const { request } = require('../../utils/request');
const { captureCompanyContext, isCompanyContextCurrent } = require('../../utils/companyContext');
const { paymentPlatform, presentOrder } = require('../../utils/membership');
const app = getApp();
Page({
  data: { loading: true, order: null, errorMessage: '', paying: false, updating: false },
  onLoad(options) { this._orderNo = options.orderNo || ''; },
  onShow() { this._unloaded = false; this.loadOrder(); },
  onUnload() {
    this._unloaded = true;
    if (this._wait) { clearTimeout(this._wait.timer); this._wait.resolve(); this._wait = null; }
  },
  onPullDownRefresh() { this.loadOrder().finally(() => wx.stopPullDownRefresh()); },
  current(context) { return !this._unloaded && isCompanyContextCurrent(app, context); },
  applyOrder(order) {
    if (this.data.order && this.data.order.orderNo === order.orderNo
        && this.data.order.status === 'PAID' && order.status !== 'PAID') return;
    this.setData({ loading: false, order: presentOrder(order) });
  },
  endpoint(action = '') { return '/membership/orders/' + encodeURIComponent(this._orderNo) + action + '?platform=' + paymentPlatform(); },
  async loadOrder() {
    const context = captureCompanyContext(app), sequence = this._sequence = (this._sequence || 0) + 1;
    this.setData({ loading: true, order: null, errorMessage: '' });
    if (!context.token || !context.companyId) { this.setData({ loading: false, errorMessage: '请先登录并选择企业' }); return; }
    try {
      const order = await request({ url: this.endpoint(), token: context.token, companyId: context.companyId });
      if (this.current(context) && sequence === this._sequence) this.applyOrder(order);
    } catch (e) {
      if (this.current(context) && sequence === this._sequence) this.setData({ loading: false, errorMessage: e.message || '订单加载失败' });
    }
  },
  async syncOrder(context = captureCompanyContext(app)) {
    const order = await request({ url: this.endpoint('/sync'), method: 'POST', token: context.token, companyId: context.companyId });
    if (this.current(context)) this.applyOrder(order);
    return order;
  },
  async pay() {
    if (this._paying || !this.data.order || !this.data.order.canPay) return;
    const context = captureCompanyContext(app), order = this.data.order;
    if (String(order.companyId) !== context.companyId) { this.loadOrder(); return; }
    this._paying = true; this.setData({ paying: true });
    try {
      const accepted = await new Promise(resolve => wx.showModal({
        title: '确认购买企业权益', content: order.companyName + '\n' + order.productName + '\n合计 ¥' + order.priceText + '\n' + order.rightsText,
        confirmText: '去支付', success: result => resolve(!!result.confirm), fail: () => resolve(false)
      }));
      if (!accepted || !this.current(context)) return;
      if (typeof wx.requestPayment !== 'function') throw new Error('当前环境暂不支持支付');
      const checkout = await request({ url: this.endpoint('/prepay'), method: 'POST', token: context.token, companyId: context.companyId });
      if (!this.current(context)) return;
      if (checkout.order.status === 'PAID') { this.applyOrder(checkout.order); return; }
      const params = checkout.paymentParams;
      if (!params || !params.paySign) throw new Error('支付会话暂不可用，请刷新订单');
      const result = await new Promise(resolve => wx.requestPayment({
        timeStamp: params.timeStamp, nonceStr: params.nonceStr, package: params.package, signType: params.signType, paySign: params.paySign,
        success: () => resolve({ success: true }), fail: e => resolve({ success: false, cancelled: /cancel/i.test(e.errMsg || '') })
      }));
      if (!this.current(context)) return;
      let latest;
      for (let attempt = 0; attempt < (result.success ? 4 : 1); attempt++) {
        if (!this.current(context)) return;
        latest = await this.syncOrder(context);
        if (latest.status !== 'PENDING') break;
        if (attempt < 3 && result.success) await new Promise(resolve => {
          this._wait = { resolve, timer: setTimeout(() => { this._wait = null; resolve(); }, 1500) };
        });
      }
      if (!this.current(context)) return;
      wx.showToast({ title: latest && latest.status === 'PAID' ? '支付已确认，权益已到账'
        : result.cancelled ? '支付已取消，订单保留' : '支付结果待确认，请刷新订单', icon: latest && latest.status === 'PAID' ? 'success' : 'none' });
    } catch (e) {
      if (this.current(context)) wx.showToast({ title: e.message || '请刷新订单核对支付结果', icon: 'none' });
    } finally { this._paying = false; if (!this._unloaded) this.setData({ paying: false }); }
  },
  async refreshPayment() {
    if (this._updating) return;
    const context = captureCompanyContext(app);
    this._updating = true; this.setData({ updating: true });
    try { await this.syncOrder(context); }
    catch (e) { if (this.current(context)) wx.showToast({ title: e.message || '查询失败，请稍后重试', icon: 'none' }); }
    finally { this._updating = false; if (!this._unloaded) this.setData({ updating: false }); }
  },
  async closeOrder() {
    if (this._updating || this._paying || !this.data.order || !this.data.order.canClose) return;
    const context = captureCompanyContext(app);
    const confirmed = await new Promise(resolve => wx.showModal({ title: '关闭未支付订单', content: '确认关闭当前订单？系统会先核对实际支付状态。',
      success: result => resolve(!!result.confirm), fail: () => resolve(false) }));
    if (!confirmed || !this.current(context)) return;
    this._updating = true; this.setData({ updating: true });
    try {
      const order = await request({ url: this.endpoint('/close'), method: 'POST', token: context.token, companyId: context.companyId });
      if (this.current(context)) this.applyOrder(order);
    } catch (e) { if (this.current(context)) wx.showToast({ title: e.message || '关闭未完成，请刷新订单', icon: 'none' }); }
    finally { this._updating = false; if (!this._unloaded) this.setData({ updating: false }); }
  },
  openMembership() { wx.redirectTo({ url: '/pages/membership/membership' }); },
  retry() { this.loadOrder(); }
});
