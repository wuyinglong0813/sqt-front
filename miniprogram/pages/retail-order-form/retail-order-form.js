const { context, sameContext, retailRequest, today, documentView, lineCents, addCents, centsMoney, refundCents } = require('../../utils/retail');
const blankItem = () => ({ key: `item-${Date.now()}-${Math.random().toString(36).slice(2)}`, lineType: 'PRODUCT', productName: '', specification: '', baseUnit: '', quantity: '', unitPrice: '', remark: '' });
Page({
  data: { id: '', customerId: '', customer: null, documentType: 'SALES_ORDER', isReturn: false,
    orderDate: '', remark: '', items: [], totalText: '0.00', originalDocumentId: '', originalDocumentNo: '',
    originals: [], originalPage: 1, originalHasMore: false, warehouses: [], warehouseIndex: 0, processStock: false,
    loading: false, saving: false, error: '', requestId: '' },
  onLoad(options) {
    this.companyContext = context();
    const type = options.type === 'RETURN_ORDER' ? 'RETURN_ORDER' : 'SALES_ORDER';
    this.setData({ id: options.id || '', customerId: options.customerId || '', documentType: type, isReturn: type === 'RETURN_ORDER',
      originalDocumentId: options.originalId || '', orderDate: today(), items: type === 'SALES_ORDER' ? [blankItem()] : [],
      requestId: `retail-${Date.now()}-${Math.random().toString(36).slice(2, 12)}` });
    wx.setNavigationBarTitle({ title: type === 'RETURN_ORDER' ? '开零售退货单' : '开零售销售单' });
    this.loadData();
  },
  onShow() { if (!sameContext(this.companyContext)) this.setData({ customer: null, items: [], originals: [], error: '企业已切换，请返回首页重新进入' }); },
  async loadData() {
    this.setData({ loading: true, error: '' });
    try {
      const customer = await retailRequest(this.companyContext, { url: `/retail/customers/${this.data.customerId}` });
      this.setData({ customer });
      if (customer.canManageStock) {
        const warehouses = await retailRequest(this.companyContext, { url: '/warehouses' }).catch(() => []);
        this.setData({ warehouses });
      }
      if (this.data.id) {
        const doc = await retailRequest(this.companyContext, { url: `/retail/documents/${this.data.id}` });
        if (doc.status !== 'DRAFT') { wx.redirectTo({ url: `/pages/retail-order-detail/retail-order-detail?id=${doc.id}` }); return; }
        this.setData({ originalDocumentId: doc.originalDocumentId || '', originalDocumentNo: doc.originalDocumentNo || '',
          orderDate: doc.orderDate, remark: doc.remark || '', items: doc.items.map(item => ({ ...item, key: String(item.id),
            quantity: String(item.quantity), unitPrice: String(item.unitPrice) })) });
        if (this.data.isReturn) {
          const original = await retailRequest(this.companyContext, { url: `/retail/documents/${doc.originalDocumentId}` });
          this.setData({ items: this.data.items.map(item => {
            const source = original.items.find(row => String(row.id) === String(item.originalItemId)) || {};
            return { ...item, returnableQuantity: source.returnableQuantity || '0',
              returnedQuantity: source.returnedQuantity || '0', returnedAmount: source.returnedAmount || '0' };
          }) });
        }
      } else if (this.data.isReturn) {
        if (this.data.originalDocumentId) await this.loadOriginal(this.data.originalDocumentId);
        else await this.loadOriginals(true);
      }
      this.recalculate();
    } catch (e) { this.setData({ error: e.message }); }
    finally { this.setData({ loading: false }); }
  },
  async loadOriginals(reset) {
    const page = reset ? 1 : this.data.originalPage + 1;
    const result = await retailRequest(this.companyContext, { url: `/retail/customers/${this.data.customerId}/documents?documentType=SALES_ORDER&status=CONFIRMED&page=${page}&size=20` });
    this.setData({ originals: reset ? result.items.map(documentView) : this.data.originals.concat(result.items.map(documentView)),
      originalPage: page, originalHasMore: result.hasMore });
  },
  async moreOriginals() {
    if (this.data.loading) return;
    this.setData({ loading: true });
    try { await this.loadOriginals(false); } catch (e) { this.setData({ error: e.message }); }
    finally { this.setData({ loading: false }); }
  },
  async selectOriginal(e) {
    if (this.data.loading) return;
    this.setData({ loading: true, error: '' });
    try { await this.loadOriginal(e.currentTarget.dataset.id); }
    catch (err) { this.setData({ error: err.message }); }
    finally { this.setData({ loading: false }); }
  },
  async loadOriginal(id) {
    const doc = await retailRequest(this.companyContext, { url: `/retail/documents/${id}` });
    const rows = doc.items.filter(item => Number(item.returnableQuantity) > 0).map(item => ({ ...item,
      key: String(item.id), originalItemId: String(item.id), quantity: '', unitPrice: String(item.unitPrice) }));
    if (!rows.length) throw new Error('这张销售单已全部退货，请选择其他销售单');
    this.setData({ originalDocumentId: String(id), originalDocumentNo: doc.documentNo, items: rows }); this.recalculate();
  },
  changeOriginal() {
    this.setData({ originalDocumentId: '', originalDocumentNo: '', items: [], totalText: '0.00' });
    this.loadOriginals(true).catch(e => this.setData({ error: e.message }));
  },
  onInput(e) {
    const field = e.currentTarget.dataset.field;
    if (['remark', 'orderDate'].includes(field)) this.setData({ [field]: e.detail.value });
  },
  onItemInput(e) {
    const index = Number(e.currentTarget.dataset.index), field = e.currentTarget.dataset.field;
    const allowed = this.data.isReturn ? ['quantity', 'remark'] : ['productName', 'specification', 'baseUnit', 'quantity', 'unitPrice', 'remark'];
    if (!allowed.includes(field) || !this.data.items[index]) return;
    this.setData({ [`items[${index}].${field}`]: e.detail.value }); this.recalculate();
  },
  addItem(e) {
    if (this.data.items.length >= 100) { wx.showToast({ title: '最多 100 条明细', icon: 'none' }); return; }
    const fee = e.currentTarget.dataset.fee === '1';
    this.setData({ items: this.data.items.concat(fee ? { ...blankItem(), lineType: 'FEE', baseUnit: '项', quantity: '1' } : blankItem()) });
  },
  removeItem(e) { this.setData({ items: this.data.items.filter((item, i) => i !== Number(e.currentTarget.dataset.index)) }); this.recalculate(); },
  recalculate() {
    let cents = '0';
    const items = this.data.items.map(item => {
      const amountCents = this.data.isReturn ? refundCents(item) : lineCents(item.quantity, item.unitPrice);
      cents = addCents(cents, amountCents); return { ...item, amountText: centsMoney(amountCents) };
    });
    this.setData({ items, totalText: centsMoney(cents) });
  },
  toggleStock(e) { this.setData({ processStock: !!e.detail.value }); },
  selectWarehouse(e) { this.setData({ warehouseIndex: Number(e.detail.value) }); },
  async save(e) {
    if (this.data.saving || this.data.loading) return;
    const confirm = e.currentTarget.dataset.confirm === '1';
    const items = this.data.isReturn ? this.data.items.filter(item => String(item.quantity).trim() && Number(item.quantity) !== 0) : this.data.items;
    if (!items.length) { wx.showToast({ title: '请填写商品明细和数量', icon: 'none' }); return; }
    for (const item of items) {
      if (!/^\d+(\.\d{1,4})?$/.test(String(item.quantity)) || Number(item.quantity) <= 0
          || !/^\d+(\.\d{1,6})?$/.test(String(item.unitPrice))
          || !item.productName.trim() || !item.baseUnit.trim()) {
        wx.showToast({ title: '请填写商品名称、单位、数量和单价', icon: 'none' }); return;
      }
      if (this.data.isReturn && Number(item.quantity) > Number(item.returnableQuantity)) {
        wx.showToast({ title: '退货数量超过可退数量', icon: 'none' }); return;
      }
    }
    if (this.data.isReturn && !this.data.remark.trim()) { wx.showToast({ title: '请填写退货原因', icon: 'none' }); return; }
    const warehouse = this.data.processStock ? this.data.warehouses[this.data.warehouseIndex] : null;
    if (confirm && this.data.processStock && !warehouse) { wx.showToast({ title: '请选择仓库', icon: 'none' }); return; }
    const body = { requestId: this.data.requestId, documentType: this.data.documentType, originalDocumentId: this.data.originalDocumentId || null,
      orderDate: this.data.orderDate, remark: this.data.remark,
      items: items.map(item => ({ originalItemId: item.originalItemId || null, lineType: item.lineType,
        productName: item.productName, specification: item.specification, baseUnit: item.baseUnit,
        quantity: item.quantity, unitPrice: item.unitPrice, remark: item.remark || '' })) };
    this.setData({ saving: true, error: '' });
    try {
      let doc;
      if (this.data.id) {
        const current = await retailRequest(this.companyContext, { url: `/retail/documents/${this.data.id}` });
        if (current.status === 'CONFIRMED') { this.openDetail(current.id); return; }
        doc = await retailRequest(this.companyContext, { url: `/retail/documents/${this.data.id}/draft`, method: 'POST', data: body });
      } else doc = await retailRequest(this.companyContext, { url: `/retail/customers/${this.data.customerId}/documents`, method: 'POST', data: body });
      this.setData({ id: String(doc.id) });
      if (confirm) await retailRequest(this.companyContext, { url: `/retail/documents/${doc.id}/confirm`, method: 'POST', data: { warehouseId: warehouse ? warehouse.id : null } });
      this.openDetail(doc.id);
    } catch (err) { this.setData({ error: err.message + (this.data.id ? '；草稿已保留，可继续修改或重试' : '') }); }
    finally { this.setData({ saving: false }); }
  },
  openDetail(id) { wx.redirectTo({ url: `/pages/retail-order-detail/retail-order-detail?id=${id}` }); }
});
