const { request } = require('../../utils/request');
const { downloadApiFile, uploadSignatureApiFile } = require('../../utils/fileTransfer');

Page({
  data: {
    id: '',
    documentNo: '',
    documentLabel: '销售单',
    isReturnOrder: false,
    detail: null,
    items: [],
    warehouses: [],
    memo: '',
    memoDraft: '',
    memoPreview: '尚未记录，点击添加',
    memoUpdatedAt: '',
    memoSaving: false,
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
    activeAction: null,
    actionLoading: false
  },

  onLoad(options) {
    this.setData({
      id: options.id || '',
      documentNo: decodeURIComponent(options.documentNo || '')
    });
    this.loadAll();
  },

  onPullDownRefresh() {
    this.loadAll().finally(() => wx.stopPullDownRefresh());
  },

  async loadAll() {
    if (!this.data.id || this.data.loading) return;
    this.setData({ loading: true });
    try {
      const [detail, memo, warehouses, activeAction] = await Promise.all([
        request({ url: `/trade-documents/${this.data.id}` }),
        request({ url: `/trade-documents/${this.data.id}/memo` }),
        request({ url: '/warehouses' }).catch(() => []),
        request({
          url: `/bilateral-actions/active?bizType=BUSINESS_DOCUMENT&bizId=${this.data.id}`
        }).catch(() => ({}))
      ]);
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
          preparedByName: content.preparedByName || '—'
        },
        documentNo: detail.documentNo || this.data.documentNo,
        documentLabel,
        isReturnOrder,
        items: detail.items || [],
        warehouses: warehouses || [],
        activeAction: activeAction && activeAction.id ? activeAction : null,
        memo: (memo && memo.content) || '',
        memoDraft: (memo && memo.content) || '',
        memoPreview: this.memoPreviewText((memo && memo.content) || ''),
        memoUpdatedAt: memo && memo.updatedAt ? String(memo.updatedAt).replace('T', ' ').slice(0, 16) : ''
      });
      wx.setNavigationBarTitle({ title: detail.documentNo || `${documentLabel}详情` });
    } catch (error) {
      wx.showToast({ title: error.message || '单据加载失败', icon: 'none' });
    } finally {
      this.setData({ loading: false });
    }
  },

  onMemoInput(e) {
    this.setData({ memoDraft: e.detail.value });
  },

  memoPreviewText(content) {
    const text = String(content || '').replace(/\s+/g, ' ').trim();
    if (!text) return '尚未记录，点击添加';
    return text.length > 54 ? `${text.slice(0, 54)}…` : text;
  },

  openMemoEditor() {
    if (this.data.detail && this.data.detail.contractReadOnly) {
      wx.showToast({ title: '合同当前仅允许查看', icon: 'none' });
      return;
    }
    this.setData({ showMemoEditor: true, memoDraft: this.data.memo });
  },

  closeMemoEditor() {
    if (this.data.memoSaving) return;
    this.setData({ showMemoEditor: false, memoDraft: this.data.memo });
  },

  async saveMemo() {
    if (this.data.memoSaving || (this.data.detail && this.data.detail.contractReadOnly)) return;
    try {
      this.setData({ memoSaving: true });
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
        memoUpdatedAt: memo && memo.updatedAt ? String(memo.updatedAt).replace('T', ' ').slice(0, 16) : ''
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
    this.confirmPublishDraft(null);
  },

  chooseReturnWarehouseForPublish() {
    if (this.data.warehouses.length === 0) {
      wx.showToast({ title: '请先在库存管理中创建仓库', icon: 'none' });
      return;
    }
    const detail = this.data.detail || {};
    const isBuyer = String(detail.viewerCompanyId) === String(detail.buyerCompanyId);
    wx.showActionSheet({
      itemList: this.data.warehouses.map(item => `${item.name}（${isBuyer ? '退货出库' : '退货入库'}）`),
      success: result => {
        const warehouse = this.data.warehouses[result.tapIndex];
        if (warehouse) this.confirmPublishDraft(warehouse.id);
      }
    });
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
    if (!action || !action.id || !action.canReview) return;
    if (decision === 'REJECT') {
      wx.showModal({
        title: '拒绝作废申请', editable: true, placeholderText: '请输入拒绝原因',
        confirmText: '确认拒绝',
        success: result => {
          const reason = String(result.content || '').trim();
          if (result.confirm && reason) this.submitDocumentActionDecision('REJECT', reason);
        }
      });
      return;
    }
    wx.showModal({
      title: `确认作废${this.data.documentLabel}`,
      content: '确认后将冲销对账和已产生的库存流水，原记录仍保留为已作废。',
      confirmText: '确认作废', confirmColor: '#d94848',
      success: result => {
        if (result.confirm) this.submitDocumentActionDecision('APPROVE', '');
      }
    });
  },

  async submitDocumentActionDecision(decision, reason) {
    const action = this.data.activeAction;
    if (!action || !action.id || this.data.actionLoading) return;
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
    if (!action || !action.id || !action.canCancel || this.data.actionLoading) return;
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
      if (this.data.warehouses.length === 0) {
        wx.showToast({ title: '请先创建退货出库仓库', icon: 'none' });
        return;
      }
      wx.showActionSheet({
        itemList: this.data.warehouses.map(item => `${item.name}（退货出库）`),
        success: result => {
          const warehouse = this.data.warehouses[result.tapIndex];
          if (warehouse) this.openSignatureEditor('RECEIVE_ONLY', warehouse.id);
        }
      });
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

  chooseWarehouse() {
    if (this.data.warehouses.length === 0) {
      wx.showModal({
        title: '请先创建仓库',
        content: '直接入库前，需要在库存管理中至少创建一个仓库。',
        confirmText: '去创建',
        success: result => {
          if (result.confirm) wx.navigateTo({ url: '/pages/inventory/inventory' });
        }
      });
      return;
    }
    wx.showActionSheet({
      itemList: this.data.warehouses.map(item => item.name),
      success: result => {
        const warehouse = this.data.warehouses[result.tapIndex];
        if (!warehouse) return;
        if (this.data.detail && this.data.detail.status === 'ACKNOWLEDGED') {
          this.submitReceive('INBOUND', warehouse.id);
          return;
        }
        this.openSignatureEditor('INBOUND', warehouse.id);
      }
    });
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
    this.downloadPdf(false);
  },

  async downloadPdf(showToast) {
    const safeId = String(this.data.detail && this.data.detail.documentNo || this.data.id)
      .replace(/[\\/:*?"<>|\r\n]/g, '_');
    const filePath = `${wx.env.USER_DATA_PATH}/${this.data.documentLabel}-${safeId}.pdf`;
    wx.showLoading({ title: '下载PDF中...' });
    try {
      const result = await downloadApiFile(`/trade-documents/${this.data.id}/pdf-data`, filePath);
      if (showToast) wx.showToast({ title: 'PDF已下载', icon: 'success' });
      wx.openDocument({
        filePath: result.filePath,
        fileType: 'pdf',
        showMenu: true,
        fail: () => wx.showToast({ title: 'PDF打开失败', icon: 'none' })
      });
    } catch (error) {
      wx.showToast({ title: error.message || 'PDF下载失败', icon: 'none' });
    } finally {
      wx.hideLoading();
    }
  },

  noop() {}
});
