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
    visibleBalances: [],
    searchKeyword: '',
    filterWarehouseId: '',
    filterWarehouseAddress: '',
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
      const nextOverview = { ...(overview || this.data.overview) };
      nextOverview.balances = (nextOverview.balances || []).map(item => ({
        ...item,
        unitPriceText: Number(item.unitPrice || 0).toFixed(2),
        inventoryAmountText: Number(item.inventoryAmount || 0).toFixed(2)
      }));
      const nextWarehouses = warehouses || [];
      const filterWarehouseId = nextWarehouses.some(item => String(item.id) === this.data.filterWarehouseId)
        ? this.data.filterWarehouseId : '';
      this.applyInventoryFilters({ overview: nextOverview, warehouses: nextWarehouses, filterWarehouseId });
    } catch (error) {
      wx.showToast({ title: error.message || '库存加载失败', icon: 'none' });
    } finally {
      this.setData({ loading: false });
    }
  },

  applyInventoryFilters(patch = {}) {
    const state = { ...this.data, ...patch };
    const keyword = state.searchKeyword.trim().toLowerCase();
    const warehouse = state.warehouses.find(item => String(item.id) === state.filterWarehouseId);
    const visibleBalances = state.overview.balances.filter(item => {
      if (state.filterWarehouseId && String(item.warehouseId) !== state.filterWarehouseId) return false;
      return !keyword || [item.productName, item.model, item.specification, item.warehouseName]
        .some(value => String(value || '').toLowerCase().includes(keyword));
    });
    this.setData({ ...patch, visibleBalances, filterWarehouseAddress: warehouse && warehouse.address || '' });
  },

  selectFilterWarehouse(e) {
    this.applyInventoryFilters({ filterWarehouseId: String(e.currentTarget.dataset.id || '') });
  },

  onSearchInput(e) {
    this.applyInventoryFilters({ searchKeyword: e.detail.value });
  },

  clearSearch() {
    this.applyInventoryFilters({ searchKeyword: '' });
  },

  clearFilters() {
    this.applyInventoryFilters({ searchKeyword: '', filterWarehouseId: '' });
  },

  showBalanceDetail(e) {
    const item = this.data.visibleBalances[Number(e.currentTarget.dataset.index)];
    if (!item) return;
    wx.showModal({ title: '库存明细', showCancel: false, confirmText: '知道了',
      content: `商品：${item.productName}\n型号：${item.model || '无型号'}\n规格：${item.specification || '无规格'}\n仓库：${item.warehouseName}\n库存数量：${item.quantity} ${item.baseUnit}\n库存单价：¥${item.unitPriceText} / ${item.baseUnit}\n库存金额：¥${item.inventoryAmountText}\n备注：${item.remark || '—'}` });
  },

  openInbound() {
    if (!this.data.warehouses.length) {
      wx.showToast({ title: '请先新建仓库', icon: 'none' });
      return;
    }
    const selectedIndex = this.data.warehouses.findIndex(item => String(item.id) === this.data.filterWarehouseId);
    this.setData({ showInbound: true, warehouseIndex: Math.max(0, selectedIndex),
      inbound: { requestId: `manual-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        productName: '', model: '', specification: '', baseUnit: '', quantity: '', unitPrice: '', remark: '' } });
  },
  closeInbound() { if (!this.data.savingInbound) this.setData({ showInbound: false }); },
  selectInboundWarehouse(e) { this.setData({ warehouseIndex: Number(e.detail.value) }); },
  onInboundInput(e) {
    const field = e.currentTarget.dataset.field;
    if (['productName', 'model', 'specification', 'baseUnit', 'quantity', 'unitPrice', 'remark'].includes(field))
      this.setData({ [`inbound.${field}`]: e.detail.value });
  },
  async saveInbound() {
    if (this.data.savingInbound) return;
    const form = { ...this.data.inbound };
    ['productName', 'model', 'specification', 'baseUnit', 'remark'].forEach(field => {
      form[field] = String(form[field] || '').trim();
    });
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
