const { request } = require('../../utils/request');
const { formatDateTime } = require('../../utils/datetime');
const { downloadApiFile, uploadSignatureApiFile } = require('../../utils/fileTransfer');
const { createPdfPreview } = require('../../utils/pdfPreview');

Page({
  data: {
    id: '',
    documentNo: '',
    documentLabel: '销售单',
    isReturnOrder: false,
    detail: null,
    items: [],
    warehouses: [],
    warehousesLoading: false,
    warehousesError: '',
    showWarehousePicker: false,
    warehousePickerTitle: '',
    warehousePickerTip: '',
    selectedWarehouseId: '',
    memo: '',
    memoDraft: '',
    memoPreview: '尚未记录，点击添加',
    memoUpdatedAt: '',
    memoSaving: false,
    memoLoading: false,
    memoError: '',
    showMemoEditor: false,
    receiving: false,
    publishing: false,
    deleting: false,
    showDraftEditor: false,
    draftSaving: false,
    draftTitle: '',
    draftCompanyName: '',
    draftCounterpartyName: '',
    draftContractNo: '',
    draftDate: '',
    draftColumns: [],
    draftRows: [],
    draftRowTypes: [],
    draftBlankRows: 8,
    draftTotalAmount: '0',
    showSignatureEditor: false,
    signatureDecision: '',
    signatureWarehouseId: '',
    signatureSignerName: '',
    signatureActionText: '确认签字并通过',
    loading: false,
    pdfLoading: false,
    pdfPreviewPages: [],
    pdfPreviewLoading: false,
    pdfPreviewError: '',
    pdfPreviewVersionChanged: false,
    loadError: '',
    activeAction: null,
    actionLoading: false,
    showDocumentMore: false,
    documentMoreActions: []
  },

  onLoad(options) {
    this._unloaded = false;
    this.setData({
      id: options.id || '',
      documentNo: decodeURIComponent(options.documentNo || '')
    });
    this.loadAll();
  },

  onPullDownRefresh() {
    this.loadAll().finally(() => wx.stopPullDownRefresh());
  },

  onShow() {
    if (this._hasShown) this.loadWarehouses();
    this._hasShown = true;
  },

  onUnload() {
    this._unloaded = true;
    if (this._documentPdfPreview) this._documentPdfPreview.dispose();
    if (this.data.pdfLoading) wx.hideLoading();
    this._loadSequence = (this._loadSequence || 0) + 1;
  },

  isCurrentLoad(sequence) {
    return !this._unloaded && sequence === this._loadSequence;
  },

  async loadAll() {
    if (this._unloaded) return;
    if (!this.data.id) {
      this.setData({ loading: false, loadError: '未找到单据，请返回后重试' });
      return;
    }
    const sequence = this._loadSequence = (this._loadSequence || 0) + 1;
    if (this._documentPdfPreview) this._documentPdfPreview.dispose();
    this._documentPdfPreview = null;
    this.setData({ loading: true, loadError: '', activeAction: null,
      showDocumentMore: false, documentMoreActions: [], pdfPreviewPages: [],
      pdfPreviewLoading: true, pdfPreviewError: '', pdfPreviewVersionChanged: false });
    try {
      const detailRequest = request({ url: `/trade-documents/${this.data.id}` });
      this.loadSupportingData(sequence);
      const detail = await detailRequest;
      if (!this.isCurrentLoad(sequence)) return;
      if (!detail) throw new Error('单据加载失败，请重试');
      const content = (detail && detail.content) || {};
      const isReturnOrder = detail.documentType === 'RETURN_ORDER';
      const documentLabel = isReturnOrder ? '退货单' : '销售单';
      this.setData({
        detail: {
          ...detail,
          title: content.title || documentLabel,
          companyName: content.companyName || '—',
          counterpartyName: content.counterpartyName || '—',
          contractNo: content.contractNo || '—',
          date: content.date || String(detail.createdAt || '').slice(0, 10),
          totalAmount: content.totalAmount || '0',
          preparedByName: content.preparedByName || '—',
          reviewedByName: content.reviewedByName || ''
        },
        documentNo: detail.documentNo || this.data.documentNo,
        documentLabel,
        isReturnOrder,
        items: detail.items || []
      });
      wx.setNavigationBarTitle({ title: `${documentLabel}详情` });
      this.loadDocumentPreview(sequence);
    } catch (error) {
      if (!this.isCurrentLoad(sequence)) return;
      const message = (error && (error.message || error.errMsg)) || '单据加载失败，请重试';
      this.setData({ loadError: /timeout/i.test(message) ? '单据加载超时，请重试' : message,
        pdfPreviewLoading: false });
    } finally {
      if (this.isCurrentLoad(sequence)) this.setData({ loading: false });
    }
  },

  loadDocumentPreview(sequence = this._loadSequence) {
    const id = String(this.data.id);
    if (!id || this._unloaded || !this.data.detail) return Promise.resolve();
    if (this._documentPdfPreview) this._documentPdfPreview.dispose();
    const preview = createPdfPreview({
      baseUrl: `/trade-documents/${id}`,
      cachePrefix: `trade-document-${id}`,
      isCurrent: () => this.isCurrentLoad(sequence) && String(this.data.id) === id && !!this.data.detail,
      onState: state => this.setData({ pdfPreviewPages: state.pages, pdfPreviewLoading: state.loading,
        pdfPreviewError: state.error, pdfPreviewVersionChanged: state.versionChanged })
    });
    this._documentPdfPreview = preview;
    return preview.load();
  },

  retryDocumentPreview(e) {
    const page = Number(e && e.currentTarget && e.currentTarget.dataset.page);
    if (!this._documentPdfPreview) return this.loadDocumentPreview();
    return page ? this._documentPdfPreview.retry(page) : this._documentPdfPreview.load(true);
  },

  onDocumentPreviewImageError(e) {
    if (this._documentPdfPreview) this._documentPdfPreview.imageError(e.currentTarget.dataset.page);
  },

  downloadDocumentPdf() {
    return this.downloadPdf(true);
  },

  loadSupportingData(sequence) {
    this.loadMemo(sequence);
    this.loadWarehouses(sequence);
    request({
      url: `/bilateral-actions/active?bizType=BUSINESS_DOCUMENT&bizId=${this.data.id}`
    }).then(activeAction => {
      if (this.isCurrentLoad(sequence)) {
        this.setData({ activeAction: activeAction && activeAction.id ? activeAction : null });
      }
    }).catch(() => {});
  },

  async loadWarehouses(sequence = this._loadSequence) {
    const warehouseSequence = this._warehouseSequence = (this._warehouseSequence || 0) + 1;
    const current = () => this.isCurrentLoad(sequence) && warehouseSequence === this._warehouseSequence;
    this.setData({ warehousesLoading: true, warehousesError: '' });
    try {
      const result = await request({ url: '/warehouses' });
      if (!current()) return;
      const warehouses = Array.isArray(result) ? result : [];
      this.setData({ warehouses, selectedWarehouseId: warehouses.some(item =>
        String(item.id) === this.data.selectedWarehouseId) ? this.data.selectedWarehouseId : '' });
    } catch (error) {
      if (current()) this.setData({ warehousesError: '仓库加载失败，请点击重试' });
    } finally {
      if (current()) this.setData({ warehousesLoading: false });
    }
  },

  retryWarehouses() {
    return this.loadWarehouses();
  },

  async loadMemo(sequence = this._loadSequence) {
    if (this.data.showMemoEditor || this.data.memoSaving) return;
    const memoVersion = this._memoVersion || 0;
    const isCurrent = () => this.isCurrentLoad(sequence) && memoVersion === (this._memoVersion || 0);
    this.setData({ memoLoading: true, memoError: '' });
    try {
      const memo = await request({ url: `/trade-documents/${this.data.id}/memo` });
      if (!isCurrent()) return;
      const content = (memo && memo.content) || '';
      this.setData({
        memo: content,
        memoDraft: content,
        memoPreview: this.memoPreviewText(content),
        memoUpdatedAt: memo && memo.updatedAt ? formatDateTime(memo.updatedAt) : ''
      });
    } catch (error) {
      if (isCurrent()) this.setData({ memoError: '进展加载失败，点击重试' });
    } finally {
      if (isCurrent()) this.setData({ memoLoading: false });
    }
  },

  onMemoInput(e) {
    if (this.data.memoSaving || (this.data.detail && this.data.detail.contractReadOnly)) return;
    this.setData({ memoDraft: e.detail.value });
  },

  memoPreviewText(content) {
    const text = String(content || '').replace(/\s+/g, ' ').trim();
    if (!text) return '尚未记录，点击添加';
    return text.length > 54 ? `${text.slice(0, 54)}…` : text;
  },

  openMemoEditor() {
    if (this.data.memoLoading) {
      wx.showToast({ title: '进展加载中，请稍候', icon: 'none' });
      return;
    }
    if (this.data.memoError) {
      this.loadMemo();
      return;
    }
    this.setData({ showMemoEditor: true, memoDraft: this.data.memo });
  },

  documentActionBusy() {
    return this._unloaded || this.data.loading || this.data.loadError || this.data.actionLoading || this.data.publishing
      || this.data.deleting || this.data.receiving || this.data.draftSaving
      || this.data.memoSaving || this.data.pdfLoading;
  },

  canCancelPendingDocumentVoid() {
    const detail = this.data.detail;
    const action = this.data.activeAction;
    return Boolean(detail && !['COMPLETED', 'VOIDED'].includes(detail.contractStatus)
      && action && action.id && action.canCancel && action.status === 'PENDING'
      && action.actionType === 'VOID' && action.bizType === 'BUSINESS_DOCUMENT'
      && String(action.bizId) === String(this.data.id));
  },

  canReviewPendingDocumentVoid() {
    const detail = this.data.detail;
    const action = this.data.activeAction;
    return Boolean(detail && !['COMPLETED', 'VOIDED'].includes(detail.contractStatus)
      && action && action.id && action.canReview && action.status === 'PENDING'
      && action.actionType === 'VOID' && action.bizType === 'BUSINESS_DOCUMENT'
      && String(action.bizId) === String(this.data.id));
  },

  availableDocumentMoreActions() {
    const detail = this.data.detail;
    if (!detail) return [];
    const actions = [];
    const memo = { key: 'memo', label: '我的进展', tip: '仅自己可见' };
    if (['COMPLETED', 'VOIDED'].includes(detail.contractStatus)) return [memo];
    if (this.canReviewPendingDocumentVoid()) actions.push({ key: 'voidApprove', label: '同意作废', tone: 'caution' }, { key: 'voidReject', label: '拒绝作废' });
    if (detail.contractReadOnly) {
      if (this.canCancelPendingDocumentVoid()) actions.push({ key: 'cancelVoid', label: '撤回作废申请' });
      return [...actions, memo];
    }
    if (detail.canPublish) actions.push({ key: 'publish', label: '提交给对方确认', tone: 'primary' });
    if (detail.canReceive && (!this.data.isReturnOrder || (detail.buyerCompanyId
        && String(detail.viewerCompanyId) === String(detail.buyerCompanyId)))) {
      actions.push({ key: 'receive', label: this.data.isReturnOrder ? '同意并退货出库' : '同意，暂不入库', tone: 'primary' });
    }
    if (detail.canInbound) actions.push({ key: 'inbound', label: this.data.isReturnOrder ? '同意并退货入库'
      : detail.status === 'ACKNOWLEDGED' ? '选择仓库入库' : '同意并入库', tone: 'primary' });
    if (detail.canReject) actions.push({ key: 'reject', label: '驳回', tone: 'caution' });
    actions.push(memo);
    if (detail.canEditDraft) actions.push({ key: 'edit', label: '编辑草稿' });
    if (detail.canSelectOutboundWarehouse) actions.push({ key: 'warehouse',
      label: detail.outboundWarehouseName ? '修改出库仓库' : '设置出库仓库' });
    if (detail.canWithdraw) actions.push({ key: 'withdraw', label: '撤回单据' });
    if (this.canCancelPendingDocumentVoid()) {
      actions.push({ key: 'cancelVoid', label: '撤回作废申请' });
    }
    if (detail.canRequestVoid) actions.push({ key: 'void', label: '申请作废', tone: 'caution' });
    if (detail.canDeleteDraft) actions.push({ key: 'delete',
      label: detail.status === 'REJECTED' ? '删除已驳回单据' : '删除草稿', tone: 'danger' });
    return actions;
  },

  toggleDocumentMore() {
    if (!this.data.detail || this.documentActionBusy()) return;
    if (this.data.showDocumentMore) return this.closeDocumentMore();
    this._documentMenuId = String(this.data.id);
    this._documentMenuActionId = String(this.data.activeAction && this.data.activeAction.id || '');
    this.setData({ showDocumentMore: true, documentMoreActions: this.availableDocumentMoreActions() });
  },

  closeDocumentMore() {
    this._documentMenuId = '';
    this._documentMenuActionId = '';
    this.setData({ showDocumentMore: false, documentMoreActions: [] });
  },

  runDocumentMoreAction(e) {
    const action = e.currentTarget.dataset.action;
    if (!this.data.showDocumentMore || this.documentActionBusy()) return;
    if (this._documentMenuId !== String(this.data.id)
        || (['cancelVoid', 'voidApprove', 'voidReject'].includes(action) && this._documentMenuActionId !== String(this.data.activeAction && this.data.activeAction.id || ''))
        || !this.availableDocumentMoreActions().some(item => item.key === action)) {
      this.closeDocumentMore();
      return;
    }
    if (action === 'voidApprove' || action === 'voidReject') {
      this.closeDocumentMore();
      return this.reviewDocumentVoid({ currentTarget: { dataset: { decision: action === 'voidApprove' ? 'APPROVE' : 'REJECT' } } });
    }
    const method = { memo: 'openMemoEditor', publish: 'publishDraft', receive: 'receiveOnly',
      inbound: 'chooseWarehouse', reject: 'rejectSalesOrder',
      edit: 'openDraftEditor', warehouse: 'chooseOutboundWarehouse', withdraw: 'withdrawDocument',
      cancelVoid: 'cancelDocumentVoid', void: 'requestDocumentVoid', delete: 'deleteDraft' }[action];
    if (!method) return;
    this.closeDocumentMore();
    return this[method]();
  },

  closeMemoEditor() {
    if (this.data.memoSaving) return;
    this.setData({ showMemoEditor: false, memoDraft: this.data.memo });
  },

  async saveMemo() {
    if (this.data.memoSaving || (this.data.detail && this.data.detail.contractReadOnly)) return;
    this._memoVersion = (this._memoVersion || 0) + 1;
    try {
      this.setData({ memoSaving: true, memoLoading: false, memoError: '' });
      const memo = await request({
        url: `/trade-documents/${this.data.id}/memo`,
        method: 'POST',
        data: { content: this.data.memoDraft }
      });
      this.setData({
        memo: (memo && memo.content) || '',
        memoDraft: (memo && memo.content) || '',
        memoPreview: this.memoPreviewText((memo && memo.content) || ''),
        showMemoEditor: false,
        memoUpdatedAt: memo && memo.updatedAt ? formatDateTime(memo.updatedAt) : ''
      });
      wx.showToast({ title: '个人备忘录已保存', icon: 'success' });
    } catch (error) {
      wx.showToast({ title: error.message || '保存失败', icon: 'none' });
    } finally {
      this.setData({ memoSaving: false });
    }
  },

  openDraftEditor() {
    const detail = this.data.detail || {};
    if (!detail.canEditDraft) return;
    const content = detail.content || {};
    const columns = Array.isArray(content.columns) ? content.columns.map(item => String(item || '')) : [];
    const rows = Array.isArray(content.rows)
      ? content.rows.map(row => Array.isArray(row) ? row.map(item => String(item == null ? '' : item)) : [])
      : [];
    const rowTypes = rows.map((_, index) => (
      Array.isArray(content.rowTypes) && content.rowTypes[index] === 'FEE' ? 'FEE' : 'PRODUCT'
    ));
    this.setData({
      showDraftEditor: true,
      draftTitle: content.title || this.data.documentLabel,
      draftCompanyName: content.companyName || '',
      draftCounterpartyName: content.counterpartyName || '',
      draftContractNo: content.contractNo || '',
      draftDate: content.date || '',
      draftColumns: columns,
      draftRows: rows.length > 0 ? rows : [columns.map(column => String(column).includes('序号') ? '1' : '')],
      draftRowTypes: rows.length > 0 ? rowTypes : ['PRODUCT'],
      draftBlankRows: Math.max(Number(content.blankRows) || 8, rows.length),
      draftTotalAmount: String(content.totalAmount || '0')
    });
  },

  closeDraftEditor() {
    if (this.data.draftSaving) return;
    this.setData({ showDraftEditor: false });
  },

  onDraftFieldInput(e) {
    const field = e.currentTarget.dataset.field;
    if (!['draftTitle', 'draftCompanyName', 'draftCounterpartyName', 'draftContractNo'].includes(field)) return;
    this.setData({ [field]: e.detail.value });
  },

  onDraftDateChange(e) {
    this.setData({ draftDate: e.detail.value });
  },

  onDraftCellInput(e) {
    const rowIndex = Number(e.currentTarget.dataset.row);
    const columnIndex = Number(e.currentTarget.dataset.col);
    const rows = this.data.draftRows.map(row => row.slice());
    if (!rows[rowIndex] || columnIndex < 0) return;
    rows[rowIndex][columnIndex] = e.detail.value;
    const columns = this.data.draftColumns;
    const quantityIndex = columns.findIndex(column => String(column).includes('数量'));
    const priceIndex = columns.findIndex(column => String(column).includes('单价'));
    const amountIndex = columns.findIndex(column => String(column).includes('金额'));
    if ((columnIndex === quantityIndex || columnIndex === priceIndex)
      && quantityIndex >= 0 && priceIndex >= 0 && amountIndex >= 0) {
      rows[rowIndex][amountIndex] = this.formatAmount(
        (parseFloat(rows[rowIndex][quantityIndex]) || 0) * (parseFloat(rows[rowIndex][priceIndex]) || 0)
      );
    }
    this.setData({
      draftRows: rows,
      draftTotalAmount: this.calculateDraftTotal(columns, rows)
    });
  },

  addDraftRow() {
    const columns = this.data.draftColumns;
    if (columns.length === 0) return;
    const rows = this.data.draftRows.map(row => row.slice());
    const rowTypes = this.data.draftRowTypes.slice();
    rows.push(columns.map(column => String(column).includes('序号') ? String(rows.length + 1) : ''));
    rowTypes.push('PRODUCT');
    this.setData({ draftRows: rows, draftRowTypes: rowTypes,
      draftBlankRows: Math.max(this.data.draftBlankRows, rows.length) });
  },

  deleteDraftRow(e) {
    if (this.data.draftRows.length <= 1) return;
    const index = Number(e.currentTarget.dataset.index);
    const sequenceIndex = this.data.draftColumns.findIndex(column => String(column).includes('序号'));
    const rows = this.data.draftRows.filter((_, rowIndex) => rowIndex !== index).map((row, rowIndex) => {
      const next = row.slice();
      if (sequenceIndex >= 0) next[sequenceIndex] = String(rowIndex + 1);
      return next;
    });
    const rowTypes = this.data.draftRowTypes.filter((_, rowIndex) => rowIndex !== index);
    this.setData({ draftRows: rows, draftRowTypes: rowTypes,
      draftTotalAmount: this.calculateDraftTotal(this.data.draftColumns, rows) });
  },

  calculateDraftTotal(columns, rows) {
    const amountIndex = columns.findIndex(column => String(column).includes('金额'));
    if (amountIndex < 0) return this.data.draftTotalAmount || '0';
    return this.formatAmount(rows.reduce((sum, row) => sum + (parseFloat(row[amountIndex]) || 0), 0));
  },

  formatAmount(value) {
    return String(Math.round((parseFloat(value) || 0) * 100) / 100);
  },

  async saveDraft() {
    if (this.data.draftSaving) return;
    if (!this.data.draftTitle.trim()) {
      wx.showToast({ title: `请输入${this.data.documentLabel}名称`, icon: 'none' });
      return;
    }
    try {
      this.setData({ draftSaving: true });
      await request({
        url: `/trade-documents/${this.data.id}/draft`,
        method: 'POST',
        data: { content: {
          title: this.data.draftTitle.trim(),
          companyName: this.data.draftCompanyName.trim(),
          counterpartyName: this.data.draftCounterpartyName.trim(),
          contractNo: this.data.draftContractNo.trim(),
          date: this.data.draftDate,
          columns: this.data.draftColumns,
          rows: this.data.draftRows,
          rowTypes: this.data.draftRowTypes,
          blankRows: this.data.draftBlankRows,
          totalAmount: this.data.draftTotalAmount
        } }
      });
      this.setData({ showDraftEditor: false });
      wx.showToast({ title: `${this.data.documentLabel}草稿已保存`, icon: 'success' });
      await this.loadAll();
    } catch (error) {
      wx.showToast({ title: error.message || '草稿保存失败', icon: 'none' });
    } finally {
      this.setData({ draftSaving: false });
    }
  },

  publishDraft() {
    if (!this.data.detail || !this.data.detail.canPublish || this.data.publishing) return;
    if (this.data.isReturnOrder) {
      this.chooseReturnWarehouseForPublish();
      return;
    }
    this.openWarehousePicker('PUBLISH_SALES', '选择销售出库仓库', '对方确认收货后，将从此仓库扣减商品数量；库存不足时可记为负数。');
  },

  chooseReturnWarehouseForPublish() {
    const detail = this.data.detail || {};
    const isBuyer = String(detail.viewerCompanyId) === String(detail.buyerCompanyId);
    this.openWarehousePicker('PUBLISH_RETURN', isBuyer ? '选择退货出库仓库' : '选择退货入库仓库',
      isBuyer ? '对方确认后，将从此仓库扣减退货数量。' : '对方确认后，退回的商品将计入此仓库。');
  },

  confirmPublishDraft(warehouseId) {
    wx.showModal({
      title: `提交${this.data.documentLabel}确认`,
      content: `提交后将等待对方确认；通过后${this.data.isReturnOrder ? '退货方库存减少、供方库存增加，并冲减' : '自动更新'}双方对账。`,
      confirmText: '提交确认',
      success: result => {
        if (result.confirm) this.submitPublishDraft(warehouseId);
      }
    });
  },

  deleteDraft() {
    if (!this.data.detail || !this.data.detail.canDeleteDraft || this.data.deleting) return;
    wx.showModal({
      title: `删除${this.data.documentLabel}`,
      content: `确定删除“${this.data.documentNo}”吗？删除后无法恢复。`,
      confirmText: '确认删除',
      confirmColor: '#d94848',
      success: result => {
        if (result.confirm) this.submitDeleteDraft();
      }
    });
  },

  async submitDeleteDraft() {
    try {
      this.setData({ deleting: true });
      await request({ url: `/trade-documents/${this.data.id}/delete`, method: 'POST', data: {} });
      wx.showToast({ title: '单据已删除', icon: 'success' });
      setTimeout(() => wx.navigateBack({ delta: 1 }), 500);
    } catch (error) {
      wx.showToast({ title: error.message || '删除失败', icon: 'none' });
    } finally {
      this.setData({ deleting: false });
    }
  },

  withdrawDocument() {
    if (!this.data.detail || !this.data.detail.canWithdraw || this.data.actionLoading) return;
    wx.showModal({
      title: `撤回${this.data.documentLabel}`,
      content: '撤回后对方待办会移除，并保留“发起方已撤回”的处理记录。',
      confirmText: '确认撤回',
      success: result => {
        if (result.confirm) this.submitWithdrawDocument();
      }
    });
  },

  async submitWithdrawDocument() {
    try {
      this.setData({ actionLoading: true });
      await request({ url: `/trade-documents/${this.data.id}/withdraw`, method: 'POST', data: {} });
      wx.showToast({ title: '单据已撤回', icon: 'success' });
      setTimeout(() => wx.navigateBack({ delta: 1 }), 500);
    } catch (error) {
      wx.showToast({ title: error.message || '撤回失败', icon: 'none' });
    } finally {
      this.setData({ actionLoading: false });
    }
  },

  requestDocumentVoid() {
    if (!this.data.detail || !this.data.detail.canRequestVoid || this.data.actionLoading) return;
    wx.showModal({
      title: `申请作废${this.data.documentLabel}`,
      editable: true,
      placeholderText: '请输入作废原因',
      confirmText: '提交申请',
      confirmColor: '#d94848',
      success: result => {
        if (!result.confirm) return;
        const reason = String(result.content || '').trim();
        if (!reason) {
          wx.showToast({ title: '请输入作废原因', icon: 'none' });
          return;
        }
        this.submitDocumentVoidRequest(reason);
      }
    });
  },

  async submitDocumentVoidRequest(reason) {
    try {
      this.setData({ actionLoading: true });
      await request({
        url: '/bilateral-actions', method: 'POST',
        data: { bizType: 'BUSINESS_DOCUMENT', bizId: this.data.id,
          actionType: 'VOID', reason, riskConfirmed: false }
      });
      wx.showToast({ title: '作废申请已提交', icon: 'success' });
      await this.loadAll();
    } catch (error) {
      wx.showToast({ title: error.message || '申请失败', icon: 'none' });
    } finally {
      this.setData({ actionLoading: false });
    }
  },

  reviewDocumentVoid(e) {
    const decision = e.currentTarget.dataset.decision;
    const action = this.data.activeAction;
    if (!this.canReviewPendingDocumentVoid()) return;
    if (decision === 'REJECT') {
      wx.showModal({
        title: '拒绝作废申请', editable: true, placeholderText: '请输入拒绝原因',
        confirmText: '确认拒绝',
        success: result => {
          const reason = String(result.content || '').trim();
          if (result.confirm && reason) this.submitDocumentActionDecision('REJECT', reason, action.id);
        }
      });
      return;
    }
    wx.showModal({
      title: `确认作废${this.data.documentLabel}`,
      content: '确认后将冲销对账和已产生的库存流水，原记录仍保留为已作废。',
      confirmText: '确认作废', confirmColor: '#d94848',
      success: result => {
        if (result.confirm) this.submitDocumentActionDecision('APPROVE', '', action.id);
      }
    });
  },

  async submitDocumentActionDecision(decision, reason, expectedActionId) {
    const action = this.data.activeAction;
    if (!this.canReviewPendingDocumentVoid() || this.data.actionLoading
        || (expectedActionId && String(action.id) !== String(expectedActionId))) return;
    try {
      this.setData({ actionLoading: true });
      await request({
        url: `/bilateral-actions/${action.id}/decision`, method: 'POST', data: { decision, reason }
      });
      wx.showToast({ title: decision === 'APPROVE' ? '已作废' : '已拒绝', icon: 'success' });
      await this.loadAll();
    } catch (error) {
      wx.showToast({ title: error.message || '处理失败', icon: 'none' });
    } finally {
      this.setData({ actionLoading: false });
    }
  },

  async cancelDocumentVoid() {
    const action = this.data.activeAction;
    if (!this.canCancelPendingDocumentVoid() || this.data.actionLoading) return;
    try {
      this.setData({ actionLoading: true });
      await request({ url: `/bilateral-actions/${action.id}/cancel`, method: 'POST', data: {} });
      wx.showToast({ title: '申请已撤回', icon: 'success' });
      await this.loadAll();
    } catch (error) {
      wx.showToast({ title: error.message || '撤回失败', icon: 'none' });
    } finally {
      this.setData({ actionLoading: false });
    }
  },

  async submitPublishDraft(warehouseId) {
    try {
      this.setData({ publishing: true });
      await request({
        url: `/trade-documents/${this.data.id}/publish`,
        method: 'POST',
        data: { warehouseId: warehouseId || null }
      });
      wx.showToast({ title: '已提交，等待对方确认', icon: 'success' });
      await this.loadAll();
    } catch (error) {
      wx.showToast({ title: error.message || '发布失败', icon: 'none' });
    } finally {
      this.setData({ publishing: false });
    }
  },

  receiveOnly() {
    const detail = this.data.detail || {};
    const buyerConfirmingReturn = this.data.isReturnOrder
      && String(detail.viewerCompanyId) === String(detail.buyerCompanyId);
    if (buyerConfirmingReturn) {
      this.openWarehousePicker('RECEIVE_RETURN', '选择退货出库仓库', '确认后，将从此仓库扣减退货数量。');
      return;
    }
    this.openSignatureEditor('RECEIVE_ONLY');
  },

  rejectSalesOrder() {
    wx.showModal({
      title: `驳回${this.data.documentLabel}`,
      content: '',
      editable: true,
      placeholderText: '请输入驳回原因',
      confirmText: '确认驳回',
      success: result => {
        if (!result.confirm) return;
        const reason = String(result.content || '').trim();
        if (!reason) {
          wx.showToast({ title: '请输入驳回原因', icon: 'none' });
          return;
        }
        this.submitReceive('REJECT', null, reason);
      }
    });
  },

  warehousesReady() {
    const message = this.data.warehousesLoading ? '仓库加载中，请稍候' : this.data.warehousesError;
    if (!message) return true;
    wx.showToast({ title: message, icon: 'none' });
    return false;
  },

  chooseWarehouse() {
    this.openWarehousePicker('INBOUND', this.data.isReturnOrder ? '选择退货入库仓库' : '选择收货仓库',
      this.data.isReturnOrder ? '确认后，退回的商品将计入此仓库。' : '销售单商品将计入所选仓库，并同步扣减供方库存。');
  },

  chooseOutboundWarehouse() {
    if (!this.data.detail || !this.data.detail.canSelectOutboundWarehouse) return;
    return this.openWarehousePicker('SET_OUTBOUND', '设置销售出库仓库', '对方入库时，将从此仓库扣减商品数量；库存不足时可记为负数。');
  },

  async saveOutboundWarehouse(warehouseId) {
    if (this.data.actionLoading) return;
    this.setData({ actionLoading: true });
    try {
      await request({ url: `/trade-documents/${this.data.id}/outbound-warehouse`, method: 'POST',
        data: { warehouseId } });
      wx.showToast({ title: '出库仓库已设置', icon: 'success' });
      await this.loadAll();
    } catch (error) {
      wx.showToast({ title: error.message || '设置失败，请重试', icon: 'none' });
    } finally {
      this.setData({ actionLoading: false });
    }
  },

  openWarehousePicker(mode, title, tip) {
    if (this.data.receiving || this.data.publishing) return;
    this._warehouseMode = mode;
    this.setData({ showWarehousePicker: true, warehousePickerTitle: title,
      warehousePickerTip: tip, selectedWarehouseId: '' });
    return this.loadWarehouses();
  },

  closeWarehousePicker() {
    this.setData({ showWarehousePicker: false });
    this._warehouseMode = '';
  },

  selectWarehouse(e) {
    if (this.data.warehousesLoading || this.data.warehousesError) return;
    this.setData({ selectedWarehouseId: String(e.currentTarget.dataset.id) });
  },

  createWarehouse() {
    wx.navigateTo({ url: '/pages/inventory/inventory' });
  },

  confirmWarehouse() {
    if (!this.warehousesReady()) return;
    const warehouse = this.data.warehouses.find(item => String(item.id) === this.data.selectedWarehouseId);
    if (!warehouse) return;
    const mode = this._warehouseMode;
    this.closeWarehousePicker();
    if (mode === 'SET_OUTBOUND') {
      this.saveOutboundWarehouse(warehouse.id);
    } else if (mode === 'PUBLISH_RETURN' || mode === 'PUBLISH_SALES') {
      this.confirmPublishDraft(warehouse.id);
    } else if (mode === 'RECEIVE_RETURN') {
      this.openSignatureEditor('RECEIVE_ONLY', warehouse.id);
    } else if (mode === 'INBOUND') {
      if (this.data.detail && this.data.detail.status === 'ACKNOWLEDGED') {
        this.submitReceive('INBOUND', warehouse.id);
      } else this.openSignatureEditor('INBOUND', warehouse.id);
    }
  },

  openSignatureEditor(decision, warehouseId = '') {
    const app = getApp();
    const member = app.globalData.memberInfo || {};
    const user = app.globalData.userInfo || {};
    const signerName = user.nickname || member.userName || '当前用户';
    this.signatureHasInk = false;
    this.signatureStrokeLength = 0;
    this.signatureLastPoint = null;
    this.setData({
      showSignatureEditor: true,
      signatureDecision: decision,
      signatureWarehouseId: warehouseId || '',
      signatureSignerName: signerName,
      signatureActionText: decision === 'INBOUND' ? '确认签字并入库' : '确认签字并通过'
    }, () => this.initializeSignatureCanvas());
  },

  closeSignatureEditor() {
    if (this.data.receiving) return;
    this.signatureCanvas = null;
    this.signatureContext = null;
    this.signatureHasInk = false;
    this.signatureStrokeLength = 0;
    this.signatureLastPoint = null;
    this.setData({
      showSignatureEditor: false,
      signatureDecision: '',
      signatureWarehouseId: ''
    });
  },

  initializeSignatureCanvas() {
    wx.createSelectorQuery().select('#salesOrderSignatureCanvas')
      .fields({ node: true, size: true })
      .exec(result => {
        const target = result && result[0];
        if (!target || !target.node) {
          wx.showToast({ title: '签名板加载失败，请重试', icon: 'none' });
          return;
        }
        const canvas = target.node;
        const ratio = Math.max(1, wx.getSystemInfoSync().pixelRatio || 1);
        canvas.width = Math.round(target.width * ratio);
        canvas.height = Math.round(target.height * ratio);
        const context = canvas.getContext('2d');
        context.scale(ratio, ratio);
        context.lineWidth = 3;
        context.lineCap = 'round';
        context.lineJoin = 'round';
        context.strokeStyle = '#172536';
        this.signatureCanvas = canvas;
        this.signatureContext = context;
        this.signatureCanvasWidth = target.width;
        this.signatureCanvasHeight = target.height;
      });
  },

  signaturePoint(e) {
    const touch = e.touches && e.touches[0];
    if (!touch) return null;
    return {
      x: Number(touch.x !== undefined ? touch.x : touch.clientX),
      y: Number(touch.y !== undefined ? touch.y : touch.clientY)
    };
  },

  onSignatureTouchStart(e) {
    const point = this.signaturePoint(e);
    if (!point || !this.signatureContext) return;
    this.signatureContext.beginPath();
    this.signatureContext.moveTo(point.x, point.y);
    this.signatureLastPoint = point;
  },

  onSignatureTouchMove(e) {
    const point = this.signaturePoint(e);
    if (!point || !this.signatureContext) return;
    const last = this.signatureLastPoint;
    if (last) {
      this.signatureStrokeLength += Math.hypot(point.x - last.x, point.y - last.y);
      this.signatureHasInk = this.signatureStrokeLength >= 12;
    }
    this.signatureContext.lineTo(point.x, point.y);
    this.signatureContext.stroke();
    this.signatureLastPoint = point;
  },

  onSignatureTouchEnd() {
    if (this.signatureContext) this.signatureContext.closePath();
    this.signatureLastPoint = null;
  },

  clearSignature() {
    if (!this.signatureContext) return;
    this.signatureContext.clearRect(
      0, 0, this.signatureCanvasWidth || 0, this.signatureCanvasHeight || 0
    );
    this.signatureHasInk = false;
    this.signatureStrokeLength = 0;
    this.signatureLastPoint = null;
  },

  signatureTempFile() {
    return new Promise((resolve, reject) => {
      wx.canvasToTempFilePath({
        canvas: this.signatureCanvas,
        fileType: 'png',
        destWidth: Math.round((this.signatureCanvasWidth || 320) * 2),
        destHeight: Math.round((this.signatureCanvasHeight || 150) * 2),
        success: result => resolve(result.tempFilePath),
        fail: error => reject(new Error((error && error.errMsg) || '签名图片生成失败'))
      });
    });
  },

  async confirmSignature() {
    if (this.data.receiving) return;
    if (!this.signatureHasInk || !this.signatureCanvas) {
      wx.showToast({ title: '请先手写签名', icon: 'none' });
      return;
    }
    try {
      this.setData({ receiving: true });
      wx.showLoading({ title: '正在确认...' });
      const filePath = await this.signatureTempFile();
      const detail = await uploadSignatureApiFile(
        `/trade-documents/${this.data.id}/receive`,
        filePath,
        {
          decision: this.data.signatureDecision,
          warehouseId: this.data.signatureWarehouseId
        }
      );
      this.signatureCanvas = null;
      this.signatureContext = null;
      this.signatureHasInk = false;
      this.signatureStrokeLength = 0;
      this.signatureLastPoint = null;
      this.setData({
        showSignatureEditor: false,
        signatureDecision: '',
        signatureWarehouseId: '',
        detail: { ...this.data.detail, ...detail },
        items: detail.items || this.data.items
      });
      wx.showToast({
        title: detail.status === 'INBOUNDED' ? '已签字并入库' : '已签字并通过',
        icon: 'success'
      });
      await this.loadAll();
    } catch (error) {
      wx.showToast({ title: error.message || '签字确认失败', icon: 'none' });
    } finally {
      wx.hideLoading();
      this.setData({ receiving: false });
    }
  },

  async submitReceive(decision, warehouseId, reason = '') {
    if (this.data.receiving) return;
    try {
      this.setData({ receiving: true });
      const detail = await request({
        url: `/trade-documents/${this.data.id}/receive`,
        method: 'POST',
        data: { decision, warehouseId, reason }
      });
      this.setData({ detail: { ...this.data.detail, ...detail }, items: detail.items || this.data.items });
      wx.showToast({
        title: decision === 'REJECT' ? `${this.data.documentLabel}已驳回`
          : decision === 'INBOUND' ? '已通过并入库' : '已通过并更新对账',
        icon: 'success'
      });
      await this.loadAll();
    } catch (error) {
      wx.showToast({ title: error.message || '操作失败', icon: 'none' });
    } finally {
      this.setData({ receiving: false });
    }
  },

  viewPdf() {
    return this.downloadPdf(false);
  },

  async downloadPdf(showToast) {
    if (!this.data.id || this._unloaded || this.data.pdfLoading) return;
    this.setData({ pdfLoading: true });
    const safeId = String(this.data.detail && this.data.detail.documentNo || this.data.id)
      .replace(/[\\/:*?"<>|\r\n]/g, '_');
    const filePath = `${wx.env.USER_DATA_PATH}/${this.data.documentLabel}-${safeId}.pdf`;
    wx.showLoading({ title: '下载PDF中...', mask: true });
    try {
      const result = await downloadApiFile(`/trade-documents/${this.data.id}/pdf-data`, filePath,
        { shouldContinue: () => !this._unloaded });
      if (this._unloaded) return;
      if (showToast) wx.showToast({ title: 'PDF已下载', icon: 'success' });
      wx.openDocument({
        filePath: result.filePath,
        fileType: 'pdf',
        showMenu: true,
        fail: () => wx.showToast({ title: 'PDF打开失败', icon: 'none' })
      });
    } catch (error) {
      if (this._unloaded) return;
      wx.showToast({ title: error.message || 'PDF下载失败', icon: 'none' });
    } finally {
      if (!this._unloaded) {
        wx.hideLoading();
        this.setData({ pdfLoading: false });
      }
    }
  },

  noop() {}
});
