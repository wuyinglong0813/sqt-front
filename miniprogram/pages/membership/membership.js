const { request } = require('../../utils/request');
const { captureCompanyContext, isCompanyContextCurrent } = require('../../utils/companyContext');
const { presentMembership, presentUsage } = require('../../utils/membership');
const app = getApp();

Page({
  data: { loading: true, status: null, usage: [], errorMessage: '', usageError: '' },
  onShow() { this._unloaded = false; this.loadMembership(); },
  onUnload() { this._unloaded = true; this._loadSequence = (this._loadSequence || 0) + 1; },
  onPullDownRefresh() { this.loadMembership().finally(() => wx.stopPullDownRefresh()); },
  async loadMembership() {
    const context = captureCompanyContext(app);
    const sequence = this._loadSequence = (this._loadSequence || 0) + 1;
    const current = () => !this._unloaded && sequence === this._loadSequence && isCompanyContextCurrent(app, context);
    this.setData({ loading: true, status: null, usage: [], errorMessage: '', usageError: '' });
    if (!context.token || !context.companyId) {
      this.setData({ loading: false, errorMessage: '请先登录并选择企业' });
      return;
    }
    const options = { token: context.token, companyId: context.companyId };
    const [status, usage] = await Promise.allSettled([
      request({ ...options, url: '/membership' }),
      request({ ...options, url: '/membership/usage' })
    ]);
    if (!current()) return;
    if (status.status === 'rejected') {
      this.setData({ loading: false, errorMessage: status.reason.message || '会员状态加载失败' });
      return;
    }
    this.setData({
      loading: false, status: presentMembership(status.value),
      usage: usage.status === 'fulfilled' ? presentUsage(usage.value) : [],
      usageError: usage.status === 'rejected' ? '使用记录加载失败，可下拉重试' : ''
    });
  },
  copyCompanyId() {
    if (this.data.status) wx.setClipboardData({ data: String(this.data.status.companyId) });
  },
  openContract(e) {
    const id = e.currentTarget.dataset.id;
    if (id) wx.navigateTo({ url: '/pages/contract-preview/contract-preview?contractId=' + encodeURIComponent(id) });
  },
  openHelp() { wx.navigateTo({ url: '/pages/help-center/help-center' }); },
  openPurchase() { wx.navigateTo({ url: '/pages/membership-purchase/membership-purchase' }); },
  openOrders() { wx.navigateTo({ url: '/pages/membership-orders/membership-orders' }); },
  retry() { this.loadMembership(); }
});
