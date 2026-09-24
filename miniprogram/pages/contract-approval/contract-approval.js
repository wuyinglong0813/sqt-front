const { request } = require('../../utils/request');
const {
  downloadChunkedApiFile,
  localFileReady,
  uploadMultipartApiFile
} = require('../../utils/fileTransfer');

const app = getApp();

function money(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number.toFixed(2) : '0.00';
}

function currentCompanyName() {
  const companyId = String(app.getCurrentCompanyId() || '');
  const company = (app.globalData.companies || [])
    .find(item => String(item.companyId) === companyId);
  return (company && company.companyName) || '当前企业';
}

function resultIcon(type) {
  if (type === 'CONTRACT') return '合';
  if (type === 'SALES_ORDER') return '销';
  if (type === 'RETURN_ORDER') return '退';
  if (type === 'INVOICE') return '票';
  if (type === 'BILATERAL_ACTION') return '废';
  return '款';
}

function formatResultTime(value) {
  const text = String(value || '').replace('T', ' ');
  return text ? text.substring(0, 19) : '';
}

Page({
  data: {
    currentCompanyName: '',
    activeSection: 'PENDING',
    sectionTabs: [
      { key: 'PENDING', label: '待我处理', count: 0 },
      { key: 'RESULT', label: '处理记录', count: 0 }
    ],
    activeTab: 'CONTRACT',
    tabs: [
      { key: 'CONTRACT', label: '合同', count: 0 },
      { key: 'FULFILLMENT', label: '履约资料', count: 0 }
    ],
    contracts: [],
    fulfillmentItems: [],
    results: [],
    visibleGroups: [],
    companyOptions: [{ id: '', name: '全部往来公司' }],
    companyIndex: 0,
    selectedCompanyId: '',
    loading: false,
    showAttachmentSignature: false,
    attachmentSignatureItem: null,
    attachmentSignatureSignerName: '',
    attachmentDecisionLoading: false
  },

  onShow() {
    this.setData({ currentCompanyName: currentCompanyName() });
    this.loadPending();
  },

  onPullDownRefresh() {
    this.loadPending().finally(() => wx.stopPullDownRefresh());
  },

  async loadPending() {
    if (this.data.loading) return;
    this.setData({ loading: true });
    try {
      const [contractList, fulfillmentList, resultList] = await Promise.all([
        request({ url: '/contracts/pending' }),
        request({ url: '/approvals/fulfillment' }),
        request({ url: '/approvals/results' })
      ]);
      const contracts = (contractList || []).map(item => ({
        ...item,
        id: String(item.id),
        companyId: String(item.viewerCounterpartyCompanyId || item.companyId || ''),
        companyName: item.viewerCounterpartyName || item.counterpartyName || '往来公司',
        amountText: money(item.amount),
        createdDate: String(item.createdAt || '').substring(0, 10)
      }));
      const fulfillmentItems = (fulfillmentList || []).map(item => ({
        ...item,
        id: String(item.id),
        contractId: String(item.contractId),
        companyId: String(item.sourceCompanyId || ''),
        companyName: item.sourceCompanyName || '往来公司',
        amountText: item.amount == null ? '' : money(item.amount),
        dateText: item.businessDate || String(item.createdAt || '').substring(0, 10),
        iconText: item.approvalType === 'BILATERAL_ACTION' ? '审'
          : (item.approvalType === 'SALES_ORDER' ? '销'
          : (item.approvalType === 'RETURN_ORDER' ? '退'
            : (item.approvalType === 'INVOICE' ? '票' : '款'))),
        typeClass: String(item.approvalType || '').toLowerCase()
      }));
      const results = (resultList || []).map(item => ({
        ...item,
        id: String(item.id),
        sourceId: String(item.sourceId),
        contractId: item.contractId == null ? null : String(item.contractId),
        companyId: String(item.sourceCompanyId || ''),
        companyName: item.sourceCompanyName || '往来公司',
        iconText: resultIcon(item.resultType),
        typeClass: String(item.resultType || '').toLowerCase(),
        statusClass: item.resultStatus === 'REJECTED'
          ? 'rejected' : (item.resultStatus === 'CANCELLED' ? 'cancelled' : 'approved'),
        canOpen: item.resultType === 'SALES_ORDER' || item.resultType === 'RETURN_ORDER' || !!item.contractId,
        isRead: !!item.isRead,
        timeText: formatResultTime(item.createdAt)
      }));
      const unreadResultCount = results.filter(item => !item.isRead).length;
      this.setData({
        contracts,
        fulfillmentItems,
        results,
        sectionTabs: [
          { key: 'PENDING', label: '待我处理', count: contracts.length + fulfillmentItems.length },
          { key: 'RESULT', label: '处理记录', count: unreadResultCount }
        ],
        tabs: [
          { key: 'CONTRACT', label: '合同', count: contracts.length },
          { key: 'FULFILLMENT', label: '履约资料', count: fulfillmentItems.length }
        ]
      });
      this.rebuildGroups(false);
    } catch (error) {
      wx.showToast({ title: error.message || '审批中心加载失败', icon: 'none' });
    } finally {
      this.setData({ loading: false });
    }
  },

  switchSection(e) {
    const activeSection = e.currentTarget.dataset.key;
    if (!activeSection || activeSection === this.data.activeSection) return;
    this.setData({ activeSection, selectedCompanyId: '', companyIndex: 0 });
    this.rebuildGroups(true);
  },

  switchTab(e) {
    const activeTab = e.currentTarget.dataset.key;
    if (!activeTab || activeTab === this.data.activeTab) return;
    this.setData({ activeTab, selectedCompanyId: '', companyIndex: 0 });
    this.rebuildGroups(true);
  },

  selectCompany(e) {
    const companyIndex = Number(e.detail.value || 0);
    const selected = this.data.companyOptions[companyIndex] || this.data.companyOptions[0];
    this.setData({ companyIndex, selectedCompanyId: selected.id || '' });
    this.rebuildGroups(false);
  },

  rebuildGroups(resetCompany) {
    const viewingResults = this.data.activeSection === 'RESULT';
    const source = viewingResults
      ? this.data.results
      : (this.data.activeTab === 'CONTRACT' ? this.data.contracts : this.data.fulfillmentItems);
    const companies = [];
    const seen = new Set();
    source.forEach(item => {
      const id = String(item.companyId || '');
      if (!id || seen.has(id)) return;
      seen.add(id);
      companies.push({ id, name: item.companyName || '往来公司' });
    });
    const companyOptions = [
      { id: '', name: `全部往来公司（${companies.length}）` },
      ...companies
    ];
    let selectedCompanyId = resetCompany ? '' : this.data.selectedCompanyId;
    if (selectedCompanyId && !seen.has(String(selectedCompanyId))) selectedCompanyId = '';
    const companyIndex = Math.max(0,
      companyOptions.findIndex(item => String(item.id) === String(selectedCompanyId)));
    const grouped = new Map();
    source
      .filter(item => !selectedCompanyId || String(item.companyId) === String(selectedCompanyId))
      .forEach(item => {
        const id = String(item.companyId || 'unknown');
        if (!grouped.has(id)) {
          grouped.set(id, {
            companyId: id,
            companyName: item.companyName || '往来公司',
            initial: String(item.companyName || '企').substring(0, 1),
            unreadCount: 0,
            items: []
          });
        }
        const group = grouped.get(id);
        group.items.push(item);
        if (viewingResults && !item.isRead) group.unreadCount += 1;
      });
    const visibleGroups = Array.from(grouped.values()).map(group => ({
      ...group,
      countText: viewingResults
        ? (group.unreadCount > 0 ? `${group.unreadCount} 条未读结果` : `${group.items.length} 条结果通知`)
        : `${group.items.length} 项待处理`
    }));
    this.setData({
      companyOptions,
      companyIndex,
      selectedCompanyId,
      visibleGroups
    });
  },

  async openResult(e) {
    const item = e.currentTarget.dataset.item;
    if (!item || !item.id) return;
    if (!item.isRead) {
      try {
        await request({ url: `/approvals/results/${item.id}/read`, method: 'POST' });
        const results = this.data.results.map(result => (
          result.id === item.id ? { ...result, isRead: true } : result
        ));
        const unreadResultCount = results.filter(result => !result.isRead).length;
        this.setData({
          results,
          sectionTabs: this.data.sectionTabs.map(tab => (
            tab.key === 'RESULT' ? { ...tab, count: unreadResultCount } : tab
          ))
        });
        this.rebuildGroups(false);
      } catch (error) {
        wx.showToast({ title: error.message || '通知状态更新失败', icon: 'none' });
      }
    }
    if (item.resultType === 'SALES_ORDER' || item.resultType === 'RETURN_ORDER') {
      wx.navigateTo({ url: `/pages/sales-order-detail/sales-order-detail?id=${item.sourceId}` });
      return;
    }
    if (item.contractId) {
      wx.navigateTo({ url: `/pages/contract-preview/contract-preview?contractId=${item.contractId}` });
    }
  },

  viewContract(e) {
    const contract = e.currentTarget.dataset.contract;
    if (!contract || !contract.id) return;
    wx.navigateTo({ url: `/pages/contract-preview/contract-preview?contractId=${contract.id}` });
  },

  approve(e) {
    const contract = e.currentTarget.dataset.contract;
    if (!contract || !contract.id) return;
    wx.showModal({
      title: '进入合同签署',
      content: `即将签署合同“${contract.name}”\n金额：¥${contract.amountText}\n\n双方完成电子签署后合同才会生效。`,
      confirmText: '去签署',
      success: res => {
        if (!res.confirm) return;
        wx.navigateTo({
          url: `/pages/fadada-auth/fadada-auth?scene=contract&contractId=${contract.id}`
        });
      }
    });
  },

  reject(e) {
    const contract = e.currentTarget.dataset.contract;
    if (!contract || !contract.id) return;
    wx.showModal({
      title: '拒绝合同',
      content: `确定拒绝合同“${contract.name}”？`,
      success: async res => {
        if (!res.confirm) return;
        try {
          wx.showLoading({ title: '处理中...' });
          await request({ url: `/contracts/${contract.id}/reject`, method: 'POST' });
          wx.showToast({ title: '已拒绝', icon: 'none' });
          await this.loadPending();
        } catch (error) {
          wx.showToast({ title: error.message || '操作失败', icon: 'none' });
        } finally {
          wx.hideLoading();
        }
      }
    });
  },

  openFulfillment(e) {
    const item = e.currentTarget.dataset.item;
    if (!item) return;
    if (item.approvalType === 'SALES_ORDER' || item.approvalType === 'RETURN_ORDER') {
      wx.navigateTo({ url: `/pages/sales-order-detail/sales-order-detail?id=${item.id}` });
    } else if (item.approvalType === 'BILATERAL_ACTION') {
      if (item.bizType === 'BUSINESS_DOCUMENT') {
        wx.navigateTo({ url: `/pages/sales-order-detail/sales-order-detail?id=${item.bizId}` });
      } else {
        wx.navigateTo({ url: `/pages/contract-preview/contract-preview?contractId=${item.contractId}` });
      }
    }
  },

  reviewBilateralAction(e) {
    const item = e.currentTarget.dataset.item;
    const decision = e.currentTarget.dataset.decision;
    if (!item || !item.actionId) return;
    if (decision === 'REJECT') {
      wx.showModal({
        title: `拒绝${item.typeText}申请`, editable: true,
        placeholderText: '请输入拒绝原因', confirmText: '确认拒绝',
        success: result => {
          const reason = String(result.content || '').trim();
          if (result.confirm && reason) this.submitBilateralDecision(item, 'REJECT', reason);
        }
      });
      return;
    }
    wx.showModal({
      title: `确认${item.typeText}`,
      content: item.actionType === 'END'
        ? '确认后合同及履约资料永久只读，不能恢复。'
        : (item.actionType === 'RESUME'
          ? '同意取消作废。系统将核实作废签署已终止且原合同仍有效，再恢复履约；核验失败时继续保持只读。'
          : item.bizType === 'CONTRACT'
          ? '确认后将进入作废协议签署，双方签署完成后合同才会作废。'
          : '确认后将保留原记录并冲销相关对账和库存影响。'),
      confirmText: '确认同意', confirmColor: '#d94848',
      success: result => {
        if (result.confirm) this.submitBilateralDecision(item, 'APPROVE', '');
      }
    });
  },

  async submitBilateralDecision(item, decision, reason) {
    try {
      wx.showLoading({ title: '处理中...' });
      await request({
        url: `/bilateral-actions/${item.actionId}/decision`,
        method: 'POST', data: { decision, reason }
      });
      if (decision === 'APPROVE' && item.bizType === 'CONTRACT' && item.actionType === 'VOID') {
        wx.navigateTo({
          url: `/pages/fadada-auth/fadada-auth?scene=abolish&contractId=${item.contractId}`
        });
        return;
      }
      wx.showToast({ title: decision === 'APPROVE' ? '已确认' : '已拒绝', icon: 'success' });
      await this.loadPending();
    } catch (error) {
      wx.showToast({ title: error.message || '处理失败', icon: 'none' });
    } finally {
      wx.hideLoading();
    }
  },

  viewAttachment(e) {
    const item = e.currentTarget.dataset.item;
    if (!item || !item.id) return;
    const originalName = String(item.documentNo || '').trim();
    const matched = originalName.match(/\.([a-zA-Z0-9]{1,8})$/);
    const extensionByType = {
      'image/jpeg': 'jpg',
      'image/png': 'png',
      'image/gif': 'gif',
      'image/webp': 'webp',
      'application/pdf': 'pdf',
      'application/msword': 'doc',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx'
    };
    const extension = matched
      ? matched[1].toLowerCase()
      : (extensionByType[item.contentType] || 'bin');
    const safeName = (matched ? originalName.slice(0, -matched[0].length) : originalName)
      .replace(/[\\/:*?"<>|\r\n]/g, '_').replace(/^\.+/, '').trim().slice(0, 80) || '履约资料';
    const filePath = `${wx.env.USER_DATA_PATH}/${safeName}-${item.id}.${extension}`;
    const fileSize = Number(item.fileSize || 0);
    const cached = localFileReady(filePath, fileSize);
    if (!cached) {
      try {
        wx.getFileSystemManager().unlinkSync(filePath);
      } catch (error) {
        // 首次查看资料时本地文件不存在。
      }
      wx.showLoading({ title: '打开中...' });
    }
    const downloadPromise = cached
      ? Promise.resolve({ filePath })
      : downloadChunkedApiFile(
        `/contract-attachments/${item.id}/content-chunk-data`,
        filePath,
        fileSize > 0 ? fileSize : undefined
      );
    downloadPromise
      .then(result => {
        if (item.isImage) {
          wx.previewImage({ current: result.filePath, urls: [result.filePath] });
          return;
        }
        wx.openDocument({
          filePath: result.filePath,
          fileType: ['pdf', 'doc', 'docx'].includes(extension) ? extension : undefined,
          showMenu: true,
          fail: () => wx.showToast({ title: '文件打开失败', icon: 'none' })
        });
      })
      .catch(error => wx.showToast({ title: error.message || '文件获取失败', icon: 'none' }))
      .finally(() => {
        if (!cached) wx.hideLoading();
      });
  },

  approveAttachment(e) {
    const item = e.currentTarget.dataset.item;
    if (!item || !item.id) return;
    if (item.approvalType === 'PAYMENT_VOUCHER') {
      this.openAttachmentSignature(item);
      return;
    }
    wx.showModal({
      title: `确认${item.typeText}`,
      content: '通过后将计入双方对账。',
      confirmText: '确认通过',
      success: result => {
        if (result.confirm) this.submitAttachmentDecision(item, 'APPROVE', '');
      }
    });
  },

  openAttachmentSignature(item) {
    const member = app.globalData.memberInfo || {};
    const user = app.globalData.userInfo || {};
    this.attachmentSignatureHasInk = false;
    this.attachmentSignatureStrokeLength = 0;
    this.attachmentSignatureLastPoint = null;
    this.setData({
      showAttachmentSignature: true,
      attachmentSignatureItem: item,
      attachmentSignatureSignerName: user.nickname || member.userName || '当前用户'
    }, () => this.initializeAttachmentSignatureCanvas());
  },

  closeAttachmentSignature() {
    if (this.data.attachmentDecisionLoading) return;
    this.attachmentSignatureCanvas = null;
    this.attachmentSignatureContext = null;
    this.attachmentSignatureHasInk = false;
    this.attachmentSignatureLastPoint = null;
    this.setData({ showAttachmentSignature: false, attachmentSignatureItem: null });
  },

  initializeAttachmentSignatureCanvas() {
    wx.createSelectorQuery().select('#paymentVoucherSignatureCanvas')
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
        this.attachmentSignatureCanvas = canvas;
        this.attachmentSignatureContext = context;
        this.attachmentSignatureCanvasWidth = target.width;
        this.attachmentSignatureCanvasHeight = target.height;
      });
  },

  attachmentSignaturePoint(e) {
    const touch = e.touches && e.touches[0];
    if (!touch) return null;
    return {
      x: Number(touch.x !== undefined ? touch.x : touch.clientX),
      y: Number(touch.y !== undefined ? touch.y : touch.clientY)
    };
  },

  onAttachmentSignatureTouchStart(e) {
    const point = this.attachmentSignaturePoint(e);
    if (!point || !this.attachmentSignatureContext) return;
    this.attachmentSignatureContext.beginPath();
    this.attachmentSignatureContext.moveTo(point.x, point.y);
    this.attachmentSignatureLastPoint = point;
  },

  onAttachmentSignatureTouchMove(e) {
    const point = this.attachmentSignaturePoint(e);
    if (!point || !this.attachmentSignatureContext) return;
    const last = this.attachmentSignatureLastPoint;
    if (last) {
      this.attachmentSignatureStrokeLength += Math.hypot(point.x - last.x, point.y - last.y);
      this.attachmentSignatureHasInk = this.attachmentSignatureStrokeLength >= 12;
    }
    this.attachmentSignatureContext.lineTo(point.x, point.y);
    this.attachmentSignatureContext.stroke();
    this.attachmentSignatureLastPoint = point;
  },

  onAttachmentSignatureTouchEnd() {
    if (this.attachmentSignatureContext) this.attachmentSignatureContext.closePath();
    this.attachmentSignatureLastPoint = null;
  },

  clearAttachmentSignature() {
    if (!this.attachmentSignatureContext) return;
    this.attachmentSignatureContext.clearRect(
      0, 0,
      this.attachmentSignatureCanvasWidth || 0,
      this.attachmentSignatureCanvasHeight || 0
    );
    this.attachmentSignatureHasInk = false;
    this.attachmentSignatureStrokeLength = 0;
    this.attachmentSignatureLastPoint = null;
  },

  attachmentSignatureTempFile() {
    return new Promise((resolve, reject) => {
      wx.canvasToTempFilePath({
        canvas: this.attachmentSignatureCanvas,
        fileType: 'png',
        destWidth: Math.round((this.attachmentSignatureCanvasWidth || 320) * 2),
        destHeight: Math.round((this.attachmentSignatureCanvasHeight || 150) * 2),
        success: result => resolve(result.tempFilePath),
        fail: error => reject(new Error((error && error.errMsg) || '签名图片生成失败'))
      });
    });
  },

  async confirmAttachmentSignature() {
    const item = this.data.attachmentSignatureItem;
    if (!item || this.data.attachmentDecisionLoading) return;
    if (!this.attachmentSignatureHasInk || !this.attachmentSignatureCanvas) {
      wx.showToast({ title: '请先手写签名', icon: 'none' });
      return;
    }
    try {
      this.setData({ attachmentDecisionLoading: true });
      wx.showLoading({ title: '正在确认...' });
      const filePath = await this.attachmentSignatureTempFile();
      await uploadMultipartApiFile(
        `/contract-attachments/${item.id}/decision`,
        filePath,
        { decision: 'APPROVE', reason: '' },
        'signature'
      );
      this.attachmentSignatureCanvas = null;
      this.attachmentSignatureContext = null;
      this.attachmentSignatureHasInk = false;
      this.setData({ showAttachmentSignature: false, attachmentSignatureItem: null });
      wx.showToast({ title: '已签字确认并更新对账', icon: 'success' });
      await this.loadPending();
    } catch (error) {
      wx.showToast({ title: error.message || '签字确认失败', icon: 'none' });
    } finally {
      wx.hideLoading();
      this.setData({ attachmentDecisionLoading: false });
    }
  },

  rejectAttachment(e) {
    const item = e.currentTarget.dataset.item;
    if (!item || !item.id) return;
    wx.showModal({
      title: '驳回资料',
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
        this.submitAttachmentDecision(item, 'REJECT', reason);
      }
    });
  },

  async submitAttachmentDecision(item, decision, reason) {
    try {
      wx.showLoading({ title: '处理中...' });
      await request({
        url: `/contract-attachments/${item.id}/decision`,
        method: 'POST',
        data: { decision, reason }
      });
      wx.showToast({ title: decision === 'APPROVE' ? '已通过并更新对账' : '已驳回', icon: 'success' });
      await this.loadPending();
    } catch (error) {
      wx.showToast({ title: error.message || '确认失败', icon: 'none' });
    } finally {
      wx.hideLoading();
    }
  },

  noop() {}
});
