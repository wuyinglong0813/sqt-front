const { request } = require('../../utils/request');

Page({
  data: {
    showInbound: false,
    savingInbound: false,
    inbound: {},
    warehouseIndex: 0,
    loading: false,
    overview: { warehouseCount: 0, productCount: 0, balances: [] },
    warehouses: [],
    showCreate: false,
    warehouseName: '',
    warehouseAddress: '',
    creating: false
  },

  onShow() {
    this.loadData();
  },

  onPullDownRefresh() {
    this.loadData().finally(() => wx.stopPullDownRefresh());
  },

  async loadData() {
    if (this.data.loading) return;
    this.setData({ loading: true });
    try {
      const [overview, warehouses] = await Promise.all([
        request({ url: '/inventory/overview' }),
        request({ url: '/warehouses' })
      ]);
      const nextOverview = overview || this.data.overview;
      nextOverview.balances = (nextOverview.balances || []).map(item => ({
        ...item,
        unitPriceText: Number(item.unitPrice || 0).toFixed(2),
        inventoryAmountText: Number(item.inventoryAmount || 0).toFixed(2)
      }));
      this.setData({ overview: nextOverview, warehouses: warehouses || [] });
    } catch (error) {
      wx.showToast({ title: error.message || '库存加载失败', icon: 'none' });
    } finally {
      this.setData({ loading: false });
    }
  },

  openInbound() {
    if (!this.data.warehouses.length) {
      wx.showToast({ title: '请先新建仓库', icon: 'none' });
      return;
    }
    this.setData({ showInbound: true, warehouseIndex: 0,
      inbound: { requestId: `manual-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        productName: '', specification: '', baseUnit: '', quantity: '', unitPrice: '', remark: '' } });
  },
  closeInbound() { if (!this.data.savingInbound) this.setData({ showInbound: false }); },
  selectInboundWarehouse(e) { this.setData({ warehouseIndex: Number(e.detail.value) }); },
  onInboundInput(e) {
    const field = e.currentTarget.dataset.field;
    if (['productName', 'specification', 'baseUnit', 'quantity', 'unitPrice', 'remark'].includes(field))
      this.setData({ [`inbound.${field}`]: e.detail.value });
  },
  async saveInbound() {
    if (this.data.savingInbound) return;
    const form = this.data.inbound;
    const warehouse = this.data.warehouses[this.data.warehouseIndex];
    if (!warehouse || !form.productName.trim() || !form.baseUnit.trim()
        || !/^\d+(\.\d{1,4})?$/.test(form.quantity) || Number(form.quantity) <= 0
        || !/^\d+(\.\d{1,4})?$/.test(form.unitPrice)) {
      wx.showToast({ title: '请填写商品、单位、正数数量和单价（最多四位小数）', icon: 'none' });
      return;
    }
    this.setData({ savingInbound: true });
    try {
      await request({ url: '/inventory/manual-inbound', method: 'POST',
        data: { ...form, warehouseId: warehouse.id } });
      this.setData({ showInbound: false });
      wx.showToast({ title: '已入库', icon: 'success' });
      await this.loadData();
    } catch (error) {
      wx.showToast({ title: error.message || '入库失败，请重试', icon: 'none' });
    } finally { this.setData({ savingInbound: false }); }
  },

  openCreate() {
    this.setData({ showCreate: true, warehouseName: '', warehouseAddress: '' });
  },

  closeCreate() {
    if (!this.data.creating) this.setData({ showCreate: false });
  },

  onWarehouseInput(e) {
    const field = e.currentTarget.dataset.field;
    if (field === 'warehouseName' || field === 'warehouseAddress') {
      this.setData({ [field]: e.detail.value });
    }
  },

  async createWarehouse() {
    if (!this.data.warehouseName.trim() || this.data.creating) {
      if (!this.data.warehouseName.trim()) wx.showToast({ title: '请输入仓库名称', icon: 'none' });
      return;
    }
    try {
      this.setData({ creating: true });
      await request({
        url: '/warehouses',
        method: 'POST',
        data: { name: this.data.warehouseName.trim(), address: this.data.warehouseAddress.trim() }
      });
      this.setData({ showCreate: false });
      wx.showToast({ title: '仓库已创建', icon: 'success' });
      await this.loadData();
    } catch (error) {
      wx.showToast({ title: error.message || '创建失败', icon: 'none' });
    } finally {
      this.setData({ creating: false });
    }
  },

  noop() {}
});
