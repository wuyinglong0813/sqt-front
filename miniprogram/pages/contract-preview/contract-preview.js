const {
  downloadApiFile,
  downloadChunkedApiFile,
  localFileReady,
  uploadMultipartApiFile
} = require('../../utils/fileTransfer');
const { normalizeContractTable } = require('../../utils/chineseCurrency');

function today() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

Page({
  data: {
    contractId: '',
    contractName: '',
    counterpartyName: '',
    // 合同详情
    contract: null,
    canViewContractContent: false,
    canViewPayments: false,
    canViewInvoices: false,
    canViewOtherAttachments: false,
    canUploadAttachments: false,
    fulfillmentErrors: {},
    // Tab
    tabs: [
      { key: 'detail', label: '合同' },
      { key: 'fulfillment', label: '履约资料' }
    ],
    activeTab: 'detail',
    // 列表
    logisticsList: [],
    logisticsLoading: false,
    logisticsUploading: false,
    salesDocuments: [],
    returnDocuments: [],
    paymentAttachments: [],
    otherAttachments: [],
    attachmentLoading: false,
    attachmentUploading: false,
    showPaymentConfirmationSignature: false,
    paymentConfirmationAttachment: null,
    paymentConfirmationSignerName: '',
    showPaymentAmountEditor: false,
    paymentAmount: '',
    paymentDate: today(),
    paymentAmountError: '',
    pendingPaymentAttachment: null,
    showInvoiceEditor: false,
    invoiceDate: today(),
    invoiceAmount: '',
    invoiceError: '',
    pendingInvoiceAttachment: null,
    fulfillmentLoading: false,
    fulfillmentCount: 0,
    invoiceList: [],
    loading: false,
    pdfLoading: false,
    pdfReady: false,
    pdfFilePath: '',
    pdfTitle: '购销合同',
    pdfSupplier: '',
    pdfBuyer: '',
    pdfDate: '',
    // 结构化合同
    hasStructured: false,
    sData: null,
    contractTableTitle: '商品明细',
    contractTableColumns: [],
    contractTableRows: [],
    contractFees: [],
    contractFeeTotal: '0',
    contractClauses: [],
    contractTotalAmount: '',
    contractTotalAmountCn: '',
    canCancelContract: false,
    canEditContract: false,
    canDeleteContract: false,
    canRequestEnd: false,
    canRequestVoid: false,
    canResumeContract: false,
    contractReadOnly: false,
    activeContractAction: null,
    contractActionLoading: false,
    signing: null,
    signedContractArchived: false,
    signedPreviewLoading: false,
    signedPreviewReady: false,
    signedPreviewFilePath: '',
    signedPreviewError: '',
    canSignContract: false,
    signButtonText: '签署合同',
    electronicAbolishing: false,
    canCreateSalesOrder: false,
    canCreateReturnOrder: false,
    createAsDraft: false,
    salesOrderCreateText: '创建销售单',
    salesOrderEmptyHint: '等待合同供方创建销售单',
    personalMemo: '',
    memoDraft: '',
    memoPreview: '尚未记录，点击添加',
    memoUpdatedAt: '',
    memoSaving: false,
    showMemoEditor: false,
    showProjectLedgerPrompt: false,
    projectLedgerHasProjects: false,
    projectLedgerProjectCount: 0,
    projectLedgerContractId: '',
    projectLedgerContractName: '',
    projectLedgerPromptStorageKey: '',
    projectLedgerPromptLoading: false,
    // 详情面板
    showDetail: false,
    detailTitle: '',
    detailFields: [],
    // 销售单创建编辑器
    showDocumentEditor: false,
    documentEditorType: '',
    documentEditorLabel: '',
    documentTemplates: [],
    documentTemplateIndex: -1,
    documentTitle: '',
    documentCompanyName: '',
    documentCounterpartyName: '',
    documentContractNo: '',
    documentDate: '',
    documentColumns: [],
    documentRows: [],
    documentRowTypes: [],
    documentHasFees: false,
    documentBlankRows: 1,
    documentTotalAmount: '0',
    documentEditorReady: false,
    documentEditorSubmitting: false
  },

  onLoad(options) {
    const contractId = options.contractId || '';
    const contractName = decodeURIComponent(options.contractName || '');
    const counterpartyName = decodeURIComponent(options.counterpartyName || '');
    this.setData({ contractId, contractName, counterpartyName });
    wx.setNavigationBarTitle({ title: '合同详情' });
    this.loadContractDetail();
  },

  onShow() {
    if (!this.hasLoadedContract) return;
    this.loadContractDetail();
    this.syncContractSigningInBackground();
  },

  onPullDownRefresh() {
    const tasks = [this.loadContractDetail()];
    if (this.data.activeTab === 'fulfillment') {
      tasks.push(
        this.loadBusinessDocuments('SALES_ORDER'),
        this.loadBusinessDocuments('RETURN_ORDER'),
        this.loadFulfillmentData()
      );
    }
    Promise.all(tasks).finally(() => wx.stopPullDownRefresh());
  },

  switchTab(e) {
    const tab = e.currentTarget.dataset.tab;
    if (tab === this.data.activeTab) return;
    this.setData({ activeTab: tab });
    if (tab === 'fulfillment') {
      this.loadBusinessDocuments('SALES_ORDER');
      this.loadBusinessDocuments('RETURN_ORDER');
      this.loadFulfillmentData();
    }
  },

  /* 加载合同详情 */
  hasAnyPermission(...required) {
    const app = getApp();
    const member = app.globalData.memberInfo || {};
    let permissions = member.permissions || [];
    if (!Array.isArray(permissions)) {
      try { permissions = JSON.parse(permissions); } catch (error) { permissions = []; }
    }
    return permissions.includes('all') || required.some(value => permissions.includes(value));
  },

  async loadContractDetail() {
    const { request } = require('../../utils/request');
    try {
      const canViewContractContent = this.hasAnyPermission('contract_view', 'contract_sign');
      const canViewPayments = this.hasAnyPermission('contract_view', 'contract_sign', 'reconciliation', 'contract_attachment_upload');
      const canViewInvoices = canViewPayments || this.hasAnyPermission('invoice_view');
      const canManageContract = this.hasAnyPermission('contract_sign');
      const canCreateDocument = this.hasAnyPermission('contract_sign', 'order_create');
      this.setData({
        canViewContractContent, canViewPayments, canViewInvoices,
        canViewOtherAttachments: canViewPayments,
        canUploadAttachments: this.hasAnyPermission('contract_attachment_upload', 'contract_sign', 'order_create', 'reconciliation'),
        tabs: canViewContractContent
          ? [{ key: 'detail', label: '合同' }, { key: 'fulfillment', label: '履约资料' }]
          : [{ key: 'fulfillment', label: '履约资料' }],
        activeTab: canViewContractContent ? this.data.activeTab : 'fulfillment'
      });
      const [contract, activeContractAction, signing] = await Promise.all([
        request({ url: `/contracts/${this.data.contractId}` }),
        request({
          url: `/bilateral-actions/active?bizType=CONTRACT&bizId=${this.data.contractId}`
        }).catch(() => ({})),
        canViewContractContent ? request({
          url: `/contracts/${this.data.contractId}/signing`
        }).catch(() => null) : Promise.resolve(null)
      ]);
      const statusMap = {
        PENDING: '待签署',
        ACTIVE: '履行中',
        REJECTED: '已拒绝',
        CANCELLED: '已撤回',
        COMPLETED: '已结束',
        VOIDED: '已作废'
      };
      // 尝试解析结构化合同数据
      let sData = null;
      try {
        sData = JSON.parse(contract.terms || '');
        if (!sData || (!sData.fields && !sData.sections)) sData = null;
      } catch (e) { /* 非 JSON，使用旧版显示 */ }

      const structuredFields = (sData && sData.fields) || [];
      const structuredSections = (sData && Array.isArray(sData.sections)) ? sData.sections : [];
      const contractTable = structuredSections.find(item => item && item.type === 'table') || {};
      const normalizedContractTable = Array.isArray(contractTable.columns) && contractTable.columns.length > 0
        ? normalizeContractTable(contractTable.columns, contractTable.rows)
        : { columns: [], rows: [] };
      const contractTableRows = normalizedContractTable.rows
        .filter(row => Array.isArray(row) && row.some(value => String(value == null ? '' : value).trim()));
      const contractClauses = structuredSections
        .filter(item => item && item.type === 'clause')
        .map((item, index) => ({
          ...item,
          label: `${index + 2}、${item.title || `合同条款${index + 1}`}`
        }));
      const feeSection = structuredSections.find(item => item && item.type === 'fees') || {};
      const contractFees = (Array.isArray(feeSection.items) ? feeSection.items : []).map(item => ({
        feeType: String(item.feeType || item.name || '其他费用'),
        amount: String(item.amount || '0'),
        remark: String(item.remark || '')
      }));
      const contractFeeTotal = Math.round(contractFees.reduce(
        (sum, item) => sum + (parseFloat(item.amount) || 0), 0) * 100) / 100;
      const fieldValue = key => {
        const field = structuredFields.find(item => item.key === key);
        return (field && field.value) || '';
      };
      const isPurchase = (contract.viewerDirection || contract.direction) === 'PURCHASE';
      const currentCompany = this.currentCompanyName();
      const viewerCounterpartyName = contract.viewerCounterpartyName || contract.counterpartyName;
      const pdfTitle = contract.name || (sData && sData.title) || this.data.contractName || '购销合同';
      const pdfSupplier = contract.supplierCompanyName || fieldValue('supplier')
        || (isPurchase ? viewerCounterpartyName : currentCompany);
      const pdfBuyer = contract.buyerCompanyName || fieldValue('buyer')
        || (isPurchase ? currentCompany : viewerCounterpartyName);
      const pdfDate = fieldValue('signDate')
        || contract.startDate
        || String(contract.createdAt || '').slice(0, 10);
      const viewerDirection = contract.viewerDirection || contract.direction;
      const isSupplier = viewerDirection === 'SALE';
      const actionPending = !!(activeContractAction && activeContractAction.id);
      const signingStatus = String((signing && signing.status) || '');
      const electronicAbolishing = !!(signing && signing.abolishApproved)
        || signingStatus === 'abolishing' || signingStatus.startsWith('ABOLISH_');
      const contractReadOnly = actionPending || electronicAbolishing
        || ['COMPLETED', 'VOIDED'].includes(contract.status);
      const canCreateSalesOrder = canCreateDocument && isSupplier
        && !contractReadOnly && (contract.status === 'PENDING' || contract.status === 'ACTIVE');
      const canCreateReturnOrder = canCreateDocument && !contractReadOnly
        && (contract.status === 'PENDING' || contract.status === 'ACTIVE');
      const outgoing = contract.perspective === 'OUTGOING';
      const createAsDraft = true;

      this.setData({
        contract: {
          ...contract,
          statusText: actionPending
            ? (activeContractAction.bizType === 'CONTRACT'
              ? (activeContractAction.actionType === 'END' ? '结束待确认'
                : (activeContractAction.actionType === 'RESUME' ? '恢复履约待确认' : '作废待确认'))
              : `${activeContractAction.targetText || '履约资料'}作废待确认`)
            : (statusMap[contract.status] || contract.status),
          amount: contract.amount || 0
        },
        contractName: contract.name || this.data.contractName,
        counterpartyName: viewerCounterpartyName || this.data.counterpartyName,
        hasStructured: !!sData,
        sData,
        contractTableTitle: contractTable.title || '商品明细',
        contractTableColumns: normalizedContractTable.columns,
        contractTableRows,
        contractFees,
        contractFeeTotal: String(contractFeeTotal),
        contractClauses,
        contractTotalAmount: contractTable.summary && contractTable.summary.totalAmount
          ? String(contractTable.summary.totalAmount) : String(contract.amount || ''),
        contractTotalAmountCn: contractTable.summary && contractTable.summary.totalAmountCn
          ? String(contractTable.summary.totalAmountCn) : '',
        canCancelContract: canManageContract && !contractReadOnly && outgoing && contract.status === 'PENDING',
        canEditContract: canManageContract && !contractReadOnly && outgoing && ['PENDING', 'REJECTED', 'CANCELLED'].includes(contract.status),
        canDeleteContract: canManageContract && !contractReadOnly && outgoing && ['REJECTED', 'CANCELLED'].includes(contract.status),
        canRequestEnd: canManageContract && !contractReadOnly && contract.status === 'ACTIVE',
        canRequestVoid: canManageContract && !contractReadOnly && contract.status === 'ACTIVE'
          && !!(signing && signing.canAbolish && !signing.abolishApproved),
        contractReadOnly,
        activeContractAction: actionPending ? activeContractAction : null,
        canResumeContract: canManageContract && !actionPending && contract.status === 'ACTIVE'
          && !!(signing && signing.abolishApproved) && signingStatus !== 'ABOLISH_CREATION_UNCERTAIN',
        signing,
        signedContractArchived: !!(signing && signing.signedFileArchived),
        canSignContract: canManageContract && !!(signing && signing.canSign)
          && !(actionPending && activeContractAction.actionType === 'RESUME')
          && signingStatus !== 'ABOLISH_CREATION_UNCERTAIN',
        signButtonText: signing && (signing.abolishApproved
          || String(signing.status || '').startsWith('ABOLISH_') || signing.status === 'abolishing')
          ? '签署作废协议' : '签署合同',
        electronicAbolishing,
        canCreateSalesOrder,
        canCreateReturnOrder,
        createAsDraft,
        salesOrderCreateText: '创建草稿',
        salesOrderEmptyHint: canCreateSalesOrder
          ? (contract.status === 'PENDING'
            ? '合同待签署，可先按合同产品准备销售单草稿'
            : '先创建销售单草稿，确认内容后再提交给需方')
          : '等待合同供方创建销售单',
        pdfTitle,
        pdfSupplier: pdfSupplier || '—',
        pdfBuyer: pdfBuyer || '—',
        pdfDate: pdfDate || '—'
      }, () => {
        if (this.data.signedContractArchived) {
          this.loadSignedContractPreview();
        } else if (this.data.signedPreviewFilePath || this.data.signedPreviewError) {
          this.setData({
            signedPreviewReady: false,
            signedPreviewFilePath: '',
            signedPreviewError: ''
          });
        }
        if (canViewContractContent) this.loadContractMemo();
        if (this.data.activeTab === 'fulfillment') {
          this.loadBusinessDocuments('SALES_ORDER');
          this.loadBusinessDocuments('RETURN_ORDER');
          this.loadFulfillmentData();
        }
        this.promptProjectLedgerIfNeeded(contract);
      });
      this.hasLoadedContract = true;
      wx.setNavigationBarTitle({ title: '合同详情' });
    } catch (e) {
      wx.showToast({ title: '加载合同失败', icon: 'none' });
    }
  },

  async syncContractSigningInBackground() {
    if (this.signingSyncInFlight || !this.data.contractId) return;
    this.signingSyncInFlight = true;
    const { request } = require('../../utils/request');
    try {
      await request({
        url: `/contracts/${this.data.contractId}/signing/sync`,
        method: 'POST'
      });
      await this.loadContractDetail();
    } catch (error) {
      // 页面先使用本地签署状态，远程同步失败不阻塞合同详情展示。
    } finally {
      this.signingSyncInFlight = false;
    }
  },

  editContract() {
    if (!this.data.canEditContract || this.data.contractActionLoading) return;
    wx.navigateTo({
      url: `/pages/sign-contract/sign-contract?mode=edit&contractId=${this.data.contractId}`
    });
  },

  signContract() {
    if (!this.data.canSignContract || this.data.contractActionLoading) return;
    const signing = this.data.signing || {};
    const scene = signing.abolishApproved || String(signing.status || '').startsWith('ABOLISH_')
      || signing.status === 'abolishing'
      ? 'abolish' : 'contract';
    wx.navigateTo({
      url: `/pages/fadada-auth/fadada-auth?scene=${scene}&contractId=${this.data.contractId}`
    });
  },

  cancelContract() {
    if (!this.data.canCancelContract || this.data.contractActionLoading) return;
    wx.showModal({
      title: '撤回合同审批',
      content: '撤回后对方将不能继续签署，你可以修改合同后重新发起。',
      confirmText: '确认撤回',
      success: result => {
        if (result.confirm) this.submitContractAction('cancel');
      }
    });
  },

  deleteContract() {
    if (!this.data.canDeleteContract || this.data.contractActionLoading) return;
    wx.showModal({
      title: '从我方列表删除',
      content: '仅从我方合同列表移除。对方仍会保留拒绝或撤回的处理记录，删除后无法在列表中恢复。',
      confirmText: '确认删除',
      confirmColor: '#d94848',
      success: result => {
        if (result.confirm) this.submitContractAction('delete');
      }
    });
  },

  requestContractEnd() {
    if (!this.data.canRequestEnd || this.data.contractActionLoading) return;
    wx.showModal({
      title: '结束合同风险提示',
      content: '对方确认后，合同及销售单、退货单、发票、凭证、物流资料将永久只读，不能再上传、编辑、删除、作废或重新开启。请先确认双方业务、库存和账务均已处理完成。',
      confirmText: '我已了解',
      confirmColor: '#d97706',
      success: riskResult => {
        if (!riskResult.confirm) return;
        wx.showModal({
          title: '填写结束原因',
          editable: true,
          placeholderText: '请输入合同结束原因',
          confirmText: '下一步',
          success: reasonResult => {
            const reason = String(reasonResult.content || '').trim();
            if (!reasonResult.confirm) return;
            if (!reason) {
              wx.showToast({ title: '请输入结束原因', icon: 'none' });
              return;
            }
            wx.showModal({
              title: '最终确认',
              editable: true,
              placeholderText: '请输入“确认结束”',
              confirmText: '提交申请',
              confirmColor: '#d94848',
              success: confirmResult => {
                if (!confirmResult.confirm) return;
                if (String(confirmResult.content || '').trim() !== '确认结束') {
                  wx.showToast({ title: '请输入“确认结束”', icon: 'none' });
                  return;
                }
                this.submitBilateralAction('CONTRACT', this.data.contractId, 'END', reason, true);
              }
            });
          }
        });
      }
    });
  },

  requestContractVoid() {
    if (!this.data.canRequestVoid || this.data.contractActionLoading) return;
    wx.showModal({
      title: '申请作废合同',
      content: '',
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
        this.submitBilateralAction('CONTRACT', this.data.contractId, 'VOID', reason, false);
      }
    });
  },

  requestContractResume() {
    if (!this.data.canResumeContract || this.data.contractActionLoading) return;
    wx.showModal({
      title: '取消作废并恢复履约',
      editable: true,
      placeholderText: '请输入恢复履约原因',
      content: '对方同意后，将先终止未完成的作废签署，确认原合同仍有效后恢复履约。',
      confirmText: '提交申请',
      success: result => {
        if (!result.confirm) return;
        const reason = String(result.content || '').trim();
        if (!reason) {
          wx.showToast({ title: '请输入恢复履约原因', icon: 'none' });
          return;
        }
        this.submitBilateralAction('CONTRACT', this.data.contractId, 'RESUME', reason, false);
      }
    });
  },

  async submitBilateralAction(bizType, bizId, actionType, reason, riskConfirmed) {
    if (this.data.contractActionLoading) return;
    const { request } = require('../../utils/request');
    try {
      this.setData({ contractActionLoading: true });
      await request({
        url: '/bilateral-actions',
        method: 'POST',
        data: { bizType, bizId, actionType, reason, riskConfirmed }
      });
      wx.showToast({ title: '申请已提交，等待对方确认', icon: 'success' });
      await this.loadContractDetail();
    } catch (error) {
      wx.showToast({ title: error.message || '申请提交失败', icon: 'none' });
    } finally {
      this.setData({ contractActionLoading: false });
    }
  },

  reviewContractAction(e) {
    const decision = e.currentTarget.dataset.decision;
    const action = this.data.activeContractAction;
    if (!action || !action.id || !action.canReview) return;
    if (decision === 'REJECT') {
      wx.showModal({
        title: `拒绝${action.actionText || '合同操作'}申请`,
        editable: true,
        placeholderText: '请输入拒绝原因',
        confirmText: '确认拒绝',
        success: result => {
          if (result.confirm && String(result.content || '').trim()) {
            this.submitContractActionDecision(action.id, 'REJECT', String(result.content).trim());
          }
        }
      });
      return;
    }
    wx.showModal({
      title: `同意${action.actionText || '合同操作'}`,
      content: action.actionType === 'END'
        ? '确认后合同永久只读，不能恢复或继续履约。'
        : (action.actionType === 'RESUME'
          ? '同意取消作废。系统将先确认作废签署已经安全终止、原合同仍有效，再恢复履约；核验失败时继续保持只读。'
          : '确认后将进入作废协议签署，双方签署完成后合同才会作废。'),
      confirmText: '确认同意',
      confirmColor: '#d94848',
      success: result => {
        if (result.confirm) this.submitContractActionDecision(action.id, 'APPROVE', '');
      }
    });
  },

  async submitContractActionDecision(actionId, decision, reason) {
    const { request } = require('../../utils/request');
    try {
      this.setData({ contractActionLoading: true });
      await request({
        url: `/bilateral-actions/${actionId}/decision`,
        method: 'POST',
        data: { decision, reason }
      });
      if (decision === 'APPROVE' && this.data.activeContractAction
        && this.data.activeContractAction.bizType === 'CONTRACT'
        && this.data.activeContractAction.actionType === 'VOID') {
        wx.navigateTo({
          url: `/pages/fadada-auth/fadada-auth?scene=abolish&contractId=${this.data.contractId}`
        });
        return;
      }
      wx.showToast({ title: decision === 'APPROVE' ? '已确认' : '已拒绝', icon: 'success' });
      await this.loadContractDetail();
    } catch (error) {
      wx.showToast({ title: error.message || '处理失败', icon: 'none' });
    } finally {
      this.setData({ contractActionLoading: false });
    }
  },

  async cancelContractBilateralAction() {
    const action = this.data.activeContractAction;
    if (!action || !action.id || !action.canCancel || this.data.contractActionLoading) return;
    const { request } = require('../../utils/request');
    try {
      this.setData({ contractActionLoading: true });
      await request({ url: `/bilateral-actions/${action.id}/cancel`, method: 'POST', data: {} });
      wx.showToast({ title: '申请已撤回', icon: 'success' });
      await this.loadContractDetail();
    } catch (error) {
      wx.showToast({ title: error.message || '撤回失败', icon: 'none' });
    } finally {
      this.setData({ contractActionLoading: false });
    }
  },

  async submitContractAction(action) {
    const { request } = require('../../utils/request');
    try {
      this.setData({ contractActionLoading: true });
      await request({
        url: `/contracts/${this.data.contractId}/${action}`,
        method: 'POST',
        data: {}
      });
      if (action === 'delete') {
        wx.showToast({ title: '已从我方列表删除', icon: 'success' });
        setTimeout(() => wx.navigateBack({ delta: 1 }), 500);
        return;
      }
      wx.showToast({ title: '合同审批已撤回', icon: 'success' });
      await this.loadContractDetail();
    } catch (error) {
      wx.showToast({ title: error.message || '操作失败', icon: 'none' });
    } finally {
      this.setData({ contractActionLoading: false });
    }
  },

  currentCompanyName() {
    const app = getApp();
    const companies = app.globalData.companies || [];
    const currentCompanyId = String(
      app.globalData.currentCompanyId
      || (app.globalData.userInfo && app.globalData.userInfo.currentCompanyId)
      || ''
    );
    const company = companies.find(item => String(item.companyId) === currentCompanyId);
    return (company && company.companyName) || '本方企业';
  },

  canManageProjectLedger() {
    const member = getApp().globalData.memberInfo || {};
    let permissions = member.permissions || [];
    if (!Array.isArray(permissions)) {
      try { permissions = JSON.parse(permissions); } catch (e) {
        permissions = String(permissions).split(',').map(item => item.trim());
      }
    }
    return ['LEGAL', 'ADMIN'].includes(member.roleCode)
      || permissions.includes('all')
      || permissions.includes('member_manage')
      || permissions.includes('auth_manage');
  },

  projectPromptStorageKey(contractId) {
    const companyId = getApp().getCurrentCompanyId() || 'unknown';
    return `tradepass_project_prompt_${companyId}_${contractId}`;
  },

  async promptProjectLedgerIfNeeded(contract) {
    if (!contract || contract.status !== 'ACTIVE' || !this.canManageProjectLedger()) return;
    if (this.projectLedgerPromptChecked) return;
    const storageKey = this.projectPromptStorageKey(contract.id || this.data.contractId);
    if (wx.getStorageSync(storageKey)) return;
    this.projectLedgerPromptChecked = true;
    const { request } = require('../../utils/request');
    try {
      const assignment = await request({
        url: `/project-ledgers/contracts/${contract.id || this.data.contractId}/assignment`
      });
      if (assignment && (assignment.assigned || assignment.dismissed)) {
        wx.setStorageSync(storageKey, true);
        return;
      }
      const projects = await request({ url: '/project-ledgers' });
      const hasProjects = Array.isArray(projects) && projects.length > 0;
      this.setData({
        showProjectLedgerPrompt: true,
        projectLedgerHasProjects: hasProjects,
        projectLedgerProjectCount: hasProjects ? projects.length : 0,
        projectLedgerContractId: String(contract.id || this.data.contractId),
        projectLedgerContractName: contract.name || this.data.contractName || '当前合同',
        projectLedgerPromptStorageKey: storageKey,
        projectLedgerPromptLoading: false
      });
    } catch (error) {
      // 项目账套是签约后的可选归集动作，失败不影响合同详情和电子签署结果。
      this.projectLedgerPromptChecked = false;
    }
  },

  async dismissProjectLedgerPrompt(contractId, storageKey) {
    const { request } = require('../../utils/request');
    this.setData({ projectLedgerPromptLoading: true });
    try {
      await request({
        url: `/project-ledgers/contracts/${contractId}/dismiss`,
        method: 'POST',
        data: {}
      });
      wx.setStorageSync(storageKey, true);
      this.setData({ showProjectLedgerPrompt: false, projectLedgerPromptLoading: false });
      wx.showToast({ title: '本合同不再提醒', icon: 'none' });
    } catch (error) {
      wx.showToast({ title: error.message || '设置失败，请重试', icon: 'none' });
      this.projectLedgerPromptChecked = false;
      this.setData({ projectLedgerPromptLoading: false });
    }
  },

  closeProjectLedgerPrompt() {
    if (this.data.projectLedgerPromptLoading) return;
    this.setData({ showProjectLedgerPrompt: false });
  },

  chooseProjectLedgerAction(e) {
    if (this.data.projectLedgerPromptLoading) return;
    const action = e.currentTarget.dataset.action;
    const contractId = this.data.projectLedgerContractId;
    if (action === 'dismiss') {
      this.dismissProjectLedgerPrompt(contractId, this.data.projectLedgerPromptStorageKey);
      return;
    }
    if (action !== 'assign' && action !== 'create') return;
    this.setData({ showProjectLedgerPrompt: false });
    wx.navigateTo({
      url: `/pages/project-ledger/project-ledger?action=${action}`
        + `&contractId=${encodeURIComponent(contractId)}`
        + `&contractName=${encodeURIComponent(this.data.projectLedgerContractName || '')}`
    });
  },

  async loadSignedContractPreview(force) {
    if (!this.data.signedContractArchived || this.data.signedPreviewLoading) return;
    if (this.data.signedPreviewReady && this.data.signedPreviewFilePath && !force) return;
    const filePath = `${wx.env.USER_DATA_PATH}/contract-${this.data.contractId}-signed-preview.png`;
    if (!force && localFileReady(filePath)) {
      this.setData({
        signedPreviewLoading: false,
        signedPreviewReady: true,
        signedPreviewFilePath: filePath,
        signedPreviewError: ''
      });
      return;
    }
    try {
      wx.getFileSystemManager().unlinkSync(filePath);
    } catch (error) {
      // 首次加载签章页时文件不存在。
    }
    this.setData({
      signedPreviewLoading: true,
      signedPreviewReady: false,
      signedPreviewError: ''
    });
    try {
      const result = await downloadChunkedApiFile(
        `/contracts/${this.data.contractId}/signed-preview-chunk-data`, filePath
      );
      this.setData({
        signedPreviewLoading: false,
        signedPreviewReady: true,
        signedPreviewFilePath: result.filePath,
        signedPreviewError: ''
      });
    } catch (error) {
      this.setData({
        signedPreviewLoading: false,
        signedPreviewReady: false,
        signedPreviewFilePath: '',
        signedPreviewError: error.message || '真实签章页加载失败'
      });
    }
  },

  retrySignedContractPreview() {
    this.loadSignedContractPreview(true);
  },

  onSignedPreviewError() {
    this.setData({
      signedPreviewReady: false,
      signedPreviewFilePath: '',
      signedPreviewError: '真实签章页显示失败，请重新加载或查看归档 PDF'
    });
  },

  openContractPdf() {
    if (!this.data.contract || this.data.pdfLoading) return;
    if (this.data.pdfFilePath) {
      this.openPdfDocument(this.data.pdfFilePath);
      return;
    }
    this.downloadContractPdfFile(false);
  },

  downloadContractPdf() {
    if (!this.data.contract || this.data.pdfLoading) return;
    this.downloadContractPdfFile(true);
  },

  async downloadContractPdfFile(showDownloadedToast) {
    const safeName = String(this.data.pdfTitle || '购销合同')
      .replace(/[\\/:*?"<>|\r\n]/g, '_')
      .trim() || '购销合同';
    const filePath = `${wx.env.USER_DATA_PATH}/${safeName}.pdf`;
    try {
      wx.getFileSystemManager().unlinkSync(filePath);
    } catch (e) {
      // 首次下载时文件不存在。
    }

    this.setData({ pdfLoading: true });
    wx.showLoading({ title: '生成PDF中...' });
    try {
      const result = await downloadApiFile(
        `/contracts/${this.data.contractId}/pdf-data`, filePath
      );
      this.setData({ pdfReady: true, pdfFilePath: result.filePath });
      if (showDownloadedToast) wx.showToast({ title: 'PDF已下载', icon: 'success' });
      this.openPdfDocument(result.filePath);
    } catch (error) {
      wx.showToast({ title: `PDF下载失败：${error.message || '网络异常'}`, icon: 'none' });
    } finally {
      wx.hideLoading();
      this.setData({ pdfLoading: false });
    }
  },

  openPdfDocument(filePath) {
    wx.openDocument({
      filePath,
      fileType: 'pdf',
      showMenu: true,
      fail: () => {
        this.setData({ pdfReady: false, pdfFilePath: '' });
        wx.showToast({ title: 'PDF打开失败，请重新下载', icon: 'none' });
      }
    });
  },

  async loadLogisticsDocuments() {
    if (this.data.logisticsLoading) return;
    const { request } = require('../../utils/request');
    this.setData({ logisticsLoading: true });
    try {
      const list = await request({
        url: `/contracts/${this.data.contractId}/logistics-documents`
      });
      const logisticsList = (list || []).map(item => ({
        ...item,
        dateText: String(item.createdAt || '').slice(0, 10),
        fileSizeText: this.formatFileSize(item.fileSize)
      }));
      this.setData({ logisticsList }, () => this.updateFulfillmentCount());
    } catch (error) {
      wx.showToast({ title: error.message || '物流单加载失败', icon: 'none' });
    } finally {
      this.setData({ logisticsLoading: false });
    }
  },

  chooseLogisticsImage() {
    if (this.data.logisticsUploading) return;
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      sizeType: ['compressed'],
      success: result => {
        const file = result.tempFiles && result.tempFiles[0];
        if (!file || !file.tempFilePath) return;
        if (file.size && file.size > 10 * 1024 * 1024) {
          wx.showToast({ title: '物流单图片不能超过10MB', icon: 'none' });
          return;
        }
        this.uploadLogisticsImage(file.tempFilePath);
      }
    });
  },

  async uploadLogisticsImage(filePath) {
    const originalName = this.buildLogisticsFileName(filePath);

    this.setData({ logisticsUploading: true });
    wx.showLoading({ title: '上传图片中...' });
    try {
      await uploadMultipartApiFile(
        `/contracts/${this.data.contractId}/logistics-documents`,
        filePath,
        { originalName }
      );
      wx.showToast({ title: '物流单已上传', icon: 'success' });
      await this.loadLogisticsDocuments();
    } catch (error) {
      wx.showToast({ title: error.message || '物流单上传失败', icon: 'none' });
    } finally {
      wx.hideLoading();
      this.setData({ logisticsUploading: false });
    }
  },

  buildLogisticsFileName(filePath) {
    const matched = String(filePath || '').match(/\.([a-zA-Z0-9]+)$/);
    const candidate = matched ? matched[1].toLowerCase() : 'jpg';
    const extension = ['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(candidate)
      ? candidate
      : 'jpg';
    const now = new Date();
    const pad = value => String(value).padStart(2, '0');
    const timestamp = [
      now.getFullYear(),
      pad(now.getMonth() + 1),
      pad(now.getDate()),
      '-',
      pad(now.getHours()),
      pad(now.getMinutes()),
      pad(now.getSeconds())
    ].join('');
    return `物流单-${timestamp}.${extension}`;
  },

  async previewLogisticsImage(e) {
    const document = e.currentTarget.dataset.document;
    if (!document || !document.id) return;
    const extensionMap = {
      'image/png': 'png',
      'image/gif': 'gif',
      'image/webp': 'webp'
    };
    const extension = extensionMap[document.contentType] || 'jpg';
    const filePath = `${wx.env.USER_DATA_PATH}/logistics-${document.id}.${extension}`;
    const fileSize = Number(document.fileSize || 0);
    const cached = localFileReady(filePath, fileSize);
    if (!cached) {
      try {
        wx.getFileSystemManager().unlinkSync(filePath);
      } catch (error) {
        // 首次查看时文件不存在。
      }
      wx.showLoading({ title: '加载图片中...' });
    }
    try {
      const result = cached
        ? { filePath }
        : await downloadChunkedApiFile(
          `/logistics-documents/${document.id}/image-chunk-data`,
          filePath,
          fileSize > 0 ? fileSize : undefined
        );
      wx.previewImage({
        current: result.filePath,
        urls: [result.filePath],
        fail: () => wx.showToast({ title: '图片打开失败', icon: 'none' })
      });
    } catch (error) {
      wx.showToast({ title: error.message || '图片加载失败', icon: 'none' });
    } finally {
      if (!cached) wx.hideLoading();
    }
  },

  deleteLogisticsDocument(e) {
    const document = e.currentTarget.dataset.document;
    if (!document || !document.id || !document.canDelete) return;
    wx.showModal({
      title: '删除物流单',
      content: `确定删除“${document.originalName}”吗？删除后双方列表中都不再显示。`,
      confirmText: '确认删除',
      confirmColor: '#d94848',
      success: result => {
        if (result.confirm) this.submitDeleteLogistics(document.id);
      }
    });
  },

  async submitDeleteLogistics(id) {
    const { request } = require('../../utils/request');
    try {
      await request({ url: `/logistics-documents/${id}/delete`, method: 'POST', data: {} });
      wx.showToast({ title: '物流单已删除', icon: 'success' });
      await this.loadFulfillmentData();
    } catch (error) {
      wx.showToast({ title: error.message || '删除失败', icon: 'none' });
    }
  },

  formatFileSize(size) {
    const bytes = Number(size || 0);
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  },

  async loadFulfillmentData() {
    if (this.data.fulfillmentLoading || !this.data.contractId) return;
    const { request } = require('../../utils/request');
    this.setData({ fulfillmentLoading: true });
    try {
      const fulfillmentErrors = {};
      const loadSection = async (key, allowed, path) => {
        if (!allowed) return [];
        try { return await request({ url: `/contracts/${this.data.contractId}/${path}` }); }
        catch (error) {
          fulfillmentErrors[key] = error.message || '加载失败，请下拉刷新重试';
          return [];
        }
      };
      const [logistics, payments, invoices, others] = await Promise.all([
        loadSection('logistics', this.data.canViewContractContent, 'logistics-documents'),
        loadSection('payments', this.data.canViewPayments, 'attachments?category=PAYMENT_VOUCHER'),
        loadSection('invoices', this.data.canViewInvoices, 'attachments?category=INVOICE'),
        loadSection('others', this.data.canViewOtherAttachments, 'attachments?category=OTHER')
      ]);
      const logisticsList = (logistics || []).map(item => ({
        ...item,
        dateText: String(item.createdAt || '').slice(0, 10),
        fileSizeText: this.formatFileSize(item.fileSize)
      }));
      const mapAttachment = item => ({
        ...item,
        fileSizeText: this.formatFileSize(item.fileSize),
        dateText: String(item.createdAt || '').replace('T', ' ').slice(0, 16),
        isImage: String(item.contentType || '').indexOf('image/') === 0,
        voucherAmountText: item.voucherAmount === null || item.voucherAmount === undefined
          ? '金额未填写'
          : `转款金额 ¥${Number(item.voucherAmount).toFixed(2)}`,
        invoiceAmountText: item.invoiceAmount === null || item.invoiceAmount === undefined
          ? '金额未填写'
          : `发票金额 ¥${Number(item.invoiceAmount).toFixed(2)}`
      });
      const paymentAttachments = (payments || []).map(mapAttachment);
      const invoiceList = (invoices || []).map(mapAttachment);
      const otherAttachments = (others || []).map(mapAttachment);
      this.setData({
        fulfillmentErrors,
        logisticsList,
        paymentAttachments,
        invoiceList,
        otherAttachments
      }, () => this.updateFulfillmentCount());
    } catch (error) {
      wx.showToast({ title: error.message || '履约资料加载失败', icon: 'none' });
    } finally {
      this.setData({ fulfillmentLoading: false });
    }
  },

  updateFulfillmentCount() {
    this.setData({
      fulfillmentCount: this.data.logisticsList.length
        + this.data.salesDocuments.length
        + this.data.returnDocuments.length
        + this.data.paymentAttachments.length
        + this.data.otherAttachments.length
        + this.data.invoiceList.length
    });
  },

  async loadContractMemo() {
    if (!this.data.contractId) return;
    const { request } = require('../../utils/request');
    try {
      const memo = await request({ url: `/contracts/${this.data.contractId}/memo` });
      this.setData({
        personalMemo: (memo && memo.content) || '',
        memoDraft: (memo && memo.content) || '',
        memoPreview: this.memoPreviewText((memo && memo.content) || ''),
        memoUpdatedAt: memo && memo.updatedAt ? String(memo.updatedAt).replace('T', ' ').slice(0, 16) : ''
      });
    } catch (error) {
      wx.showToast({ title: error.message || '备忘录加载失败', icon: 'none' });
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
    if (this.data.contractReadOnly) {
      wx.showToast({ title: '合同当前仅允许查看', icon: 'none' });
      return;
    }
    this.setData({ showMemoEditor: true, memoDraft: this.data.personalMemo });
  },

  closeMemoEditor() {
    if (this.data.memoSaving) return;
    this.setData({ showMemoEditor: false, memoDraft: this.data.personalMemo });
  },

  async saveContractMemo() {
    if (this.data.memoSaving || this.data.contractReadOnly) return;
    const { request } = require('../../utils/request');
    try {
      this.setData({ memoSaving: true });
      const memo = await request({
        url: `/contracts/${this.data.contractId}/memo`,
        method: 'POST',
        data: { content: this.data.memoDraft }
      });
      this.setData({
        personalMemo: (memo && memo.content) || '',
        memoDraft: (memo && memo.content) || '',
        memoPreview: this.memoPreviewText((memo && memo.content) || ''),
        showMemoEditor: false,
        memoUpdatedAt: memo && memo.updatedAt ? String(memo.updatedAt).replace('T', ' ').slice(0, 16) : ''
      });
      wx.showToast({ title: '个人备忘录已保存', icon: 'success' });
    } catch (error) {
      wx.showToast({ title: error.message || '备忘录保存失败', icon: 'none' });
    } finally {
      this.setData({ memoSaving: false });
    }
  },

  async loadAttachments(category) {
    if (this.data.attachmentLoading) return;
    const { request } = require('../../utils/request');
    this.setData({ attachmentLoading: true });
    try {
      const list = await request({
        url: `/contracts/${this.data.contractId}/attachments?category=${category}`
      });
      const attachments = (list || []).map(item => ({
        ...item,
        fileSizeText: this.formatFileSize(item.fileSize),
        dateText: String(item.createdAt || '').replace('T', ' ').slice(0, 16),
        isImage: String(item.contentType || '').indexOf('image/') === 0,
        voucherAmountText: item.voucherAmount === null || item.voucherAmount === undefined
          ? '金额未填写'
          : `转款金额 ¥${Number(item.voucherAmount).toFixed(2)}`,
        invoiceAmountText: item.invoiceAmount === null || item.invoiceAmount === undefined
          ? '金额未填写'
          : `发票金额 ¥${Number(item.invoiceAmount).toFixed(2)}`
      }));
      const dataKey = {
        PAYMENT_VOUCHER: 'paymentAttachments',
        INVOICE: 'invoiceList',
        OTHER: 'otherAttachments'
      }[category];
      this.setData({
        [dataKey]: attachments
      }, () => this.updateFulfillmentCount());
    } catch (error) {
      wx.showToast({ title: error.message || '资料加载失败', icon: 'none' });
    } finally {
      this.setData({ attachmentLoading: false });
    }
  },

  chooseAttachment(e) {
    if (this.data.attachmentUploading) return;
    const category = e.currentTarget.dataset.category;
    wx.showActionSheet({
      itemList: ['拍照或从相册选择图片', '从聊天文件选择'],
      success: result => {
        if (result.tapIndex === 0) {
          this.chooseAttachmentImage(category);
        } else {
          this.chooseAttachmentFile(category);
        }
      }
    });
  },

  chooseAttachmentImage(category) {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      sizeType: ['compressed'],
      success: result => {
        const file = result.tempFiles && result.tempFiles[0];
        if (!file || !file.tempFilePath) return;
        if (file.size && file.size > 10 * 1024 * 1024) {
          wx.showToast({ title: '文件不能超过10MB', icon: 'none' });
          return;
        }
        this.prepareAttachmentUpload(
          category,
          file.tempFilePath,
          this.attachmentFileName(file.tempFilePath, 'jpg', category)
        );
      }
    });
  },

  chooseAttachmentFile(category) {
    wx.chooseMessageFile({
      count: 1,
      type: 'file',
      extension: category === 'OTHER' ? ['pdf', 'doc', 'docx'] : ['pdf'],
      success: result => {
        const file = result.tempFiles && result.tempFiles[0];
        if (!file || !file.path) return;
        if (file.size && file.size > 10 * 1024 * 1024) {
          wx.showToast({ title: '文件不能超过10MB', icon: 'none' });
          return;
        }
        this.prepareAttachmentUpload(
          category,
          file.path,
          file.name || this.attachmentFileName(file.path, 'pdf', category)
        );
      }
    });
  },

  attachmentFileName(filePath, fallbackExtension, category) {
    const matched = String(filePath || '').match(/\.([a-zA-Z0-9]+)$/);
    const extension = matched ? matched[1].toLowerCase() : fallbackExtension;
    const prefix = {
      PAYMENT_VOUCHER: '转款凭证',
      INVOICE: '发票',
      OTHER: '其它资料'
    }[category] || '合同资料';
    return `${prefix}-${Date.now()}.${extension}`;
  },

  prepareAttachmentUpload(category, filePath, originalName) {
    if (category === 'OTHER') {
      this.uploadAttachment(category, filePath, originalName);
      return;
    }
    if (category === 'INVOICE') {
      this.setData({
        showInvoiceEditor: true,
        invoiceDate: today(),
        invoiceAmount: '',
        invoiceError: '',
        pendingInvoiceAttachment: { filePath, originalName }
      });
      return;
    }
    this.setData({
      showPaymentAmountEditor: true,
      paymentAmount: '',
      paymentDate: today(),
      paymentAmountError: '',
      pendingPaymentAttachment: { filePath, originalName }
    });
  },

  onPaymentAmountInput(e) {
    this.setData({
      paymentAmount: e.detail.value,
      paymentAmountError: ''
    });
  },

  onPaymentDateChange(e) {
    this.setData({ paymentDate: e.detail.value });
  },

  closePaymentAmountEditor() {
    if (this.data.attachmentUploading) return;
    this.setData({
      showPaymentAmountEditor: false,
      paymentAmount: '',
      paymentDate: today(),
      paymentAmountError: '',
      pendingPaymentAttachment: null
    });
  },

  confirmPaymentAttachmentUpload() {
    if (this.data.attachmentUploading) return;
    const amount = String(this.data.paymentAmount || '').trim();
    if (!/^\d{1,16}(\.\d{1,2})?$/.test(amount)) {
      this.setData({ paymentAmountError: '请输入正确金额，最多保留两位小数' });
      return;
    }
    const attachment = this.data.pendingPaymentAttachment;
    if (!attachment || !attachment.filePath) return;
    const paymentDate = this.data.paymentDate;
    const [integerPart, decimalPart = ''] = amount.split('.');
    const normalizedAmount = `${integerPart}.${decimalPart.padEnd(2, '0')}`;
    this.setData({
      showPaymentAmountEditor: false,
      paymentAmount: '',
      paymentDate: today(),
      paymentAmountError: '',
      pendingPaymentAttachment: null
    }, () => {
      this.uploadAttachment(
        'PAYMENT_VOUCHER',
        attachment.filePath,
        attachment.originalName,
        { voucherAmount: normalizedAmount, voucherDate: paymentDate }
      );
    });
  },

  onInvoiceAmountInput(e) {
    this.setData({ invoiceAmount: e.detail.value, invoiceError: '' });
  },

  onInvoiceDateChange(e) {
    this.setData({ invoiceDate: e.detail.value, invoiceError: '' });
  },

  closeInvoiceEditor() {
    if (this.data.attachmentUploading) return;
    this.setData({
      showInvoiceEditor: false,
      invoiceDate: today(),
      invoiceAmount: '',
      invoiceError: '',
      pendingInvoiceAttachment: null
    });
  },

  confirmInvoiceUpload() {
    if (this.data.attachmentUploading) return;
    const amount = String(this.data.invoiceAmount || '').trim();
    if (!/^\d{1,16}(\.\d{1,2})?$/.test(amount)) {
      this.setData({ invoiceError: '请输入正确金额，最多保留两位小数' });
      return;
    }
    const attachment = this.data.pendingInvoiceAttachment;
    if (!attachment || !attachment.filePath) return;
    const [integerPart, decimalPart = ''] = amount.split('.');
    const normalizedAmount = `${integerPart}.${decimalPart.padEnd(2, '0')}`;
    const metadata = {
      invoiceDate: this.data.invoiceDate,
      invoiceAmount: normalizedAmount
    };
    this.setData({
      showInvoiceEditor: false,
      invoiceDate: today(),
      invoiceAmount: '',
      invoiceError: '',
      pendingInvoiceAttachment: null
    }, () => this.uploadAttachment('INVOICE', attachment.filePath, attachment.originalName, metadata));
  },

  async uploadAttachment(category, filePath, originalName, metadata = {}) {
    this.setData({ attachmentUploading: true });
    wx.showLoading({ title: '上传资料中...' });
    try {
      await uploadMultipartApiFile(
        `/contracts/${this.data.contractId}/attachments`,
        filePath,
        { category, originalName, ...metadata }
      );
      const label = category === 'PAYMENT_VOUCHER'
        ? '转款凭证'
        : category === 'INVOICE' ? '发票' : '资料';
      wx.showToast({
        title: category === 'OTHER' ? `${label}已上传` : `${label}已提交确认`,
        icon: 'success'
      });
      await this.loadAttachments(category);
    } catch (error) {
      wx.showToast({ title: error.message || '资料上传失败', icon: 'none' });
    } finally {
      wx.hideLoading();
      this.setData({ attachmentUploading: false });
    }
  },

  approveAttachment(e) {
    const attachment = e.currentTarget.dataset.attachment;
    if (!attachment || !attachment.id) return;
    if (attachment.category === 'PAYMENT_VOUCHER') {
      this.openPaymentConfirmationSignature(attachment);
      return;
    }
    wx.showModal({
      title: `确认${attachment.category === 'INVOICE' ? '发票' : '转款凭证'}`,
      content: '通过后将正式共享给双方，并立即更新客户对账。',
      confirmText: '确认通过',
      success: result => {
        if (result.confirm) this.submitAttachmentDecision(attachment, 'APPROVE', '');
      }
    });
  },

  openPaymentConfirmationSignature(attachment) {
    const app = getApp();
    const member = app.globalData.memberInfo || {};
    const user = app.globalData.userInfo || {};
    this.paymentSignatureHasInk = false;
    this.paymentSignatureStrokeLength = 0;
    this.paymentSignatureLastPoint = null;
    this.setData({
      showPaymentConfirmationSignature: true,
      paymentConfirmationAttachment: attachment,
      paymentConfirmationSignerName: user.nickname || member.userName || '当前用户'
    }, () => this.initializePaymentSignatureCanvas());
  },

  closePaymentConfirmationSignature() {
    if (this.data.attachmentLoading) return;
    this.paymentSignatureCanvas = null;
    this.paymentSignatureContext = null;
    this.paymentSignatureHasInk = false;
    this.paymentSignatureLastPoint = null;
    this.setData({
      showPaymentConfirmationSignature: false,
      paymentConfirmationAttachment: null
    });
  },

  initializePaymentSignatureCanvas() {
    wx.createSelectorQuery().select('#contractPaymentSignatureCanvas')
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
        this.paymentSignatureCanvas = canvas;
        this.paymentSignatureContext = context;
        this.paymentSignatureCanvasWidth = target.width;
        this.paymentSignatureCanvasHeight = target.height;
      });
  },

  paymentSignaturePoint(e) {
    const touch = e.touches && e.touches[0];
    if (!touch) return null;
    return {
      x: Number(touch.x !== undefined ? touch.x : touch.clientX),
      y: Number(touch.y !== undefined ? touch.y : touch.clientY)
    };
  },

  onPaymentSignatureTouchStart(e) {
    const point = this.paymentSignaturePoint(e);
    if (!point || !this.paymentSignatureContext) return;
    this.paymentSignatureContext.beginPath();
    this.paymentSignatureContext.moveTo(point.x, point.y);
    this.paymentSignatureLastPoint = point;
  },

  onPaymentSignatureTouchMove(e) {
    const point = this.paymentSignaturePoint(e);
    if (!point || !this.paymentSignatureContext) return;
    const last = this.paymentSignatureLastPoint;
    if (last) {
      this.paymentSignatureStrokeLength += Math.hypot(point.x - last.x, point.y - last.y);
      this.paymentSignatureHasInk = this.paymentSignatureStrokeLength >= 12;
    }
    this.paymentSignatureContext.lineTo(point.x, point.y);
    this.paymentSignatureContext.stroke();
    this.paymentSignatureLastPoint = point;
  },

  onPaymentSignatureTouchEnd() {
    if (this.paymentSignatureContext) this.paymentSignatureContext.closePath();
    this.paymentSignatureLastPoint = null;
  },

  clearPaymentSignature() {
    if (!this.paymentSignatureContext) return;
    this.paymentSignatureContext.clearRect(
      0, 0, this.paymentSignatureCanvasWidth || 0, this.paymentSignatureCanvasHeight || 0
    );
    this.paymentSignatureHasInk = false;
    this.paymentSignatureStrokeLength = 0;
    this.paymentSignatureLastPoint = null;
  },

  paymentSignatureTempFile() {
    return new Promise((resolve, reject) => {
      wx.canvasToTempFilePath({
        canvas: this.paymentSignatureCanvas,
        fileType: 'png',
        destWidth: Math.round((this.paymentSignatureCanvasWidth || 320) * 2),
        destHeight: Math.round((this.paymentSignatureCanvasHeight || 150) * 2),
        success: result => resolve(result.tempFilePath),
        fail: error => reject(new Error((error && error.errMsg) || '签名图片生成失败'))
      });
    });
  },

  async confirmPaymentSignature() {
    const attachment = this.data.paymentConfirmationAttachment;
    if (!attachment || this.data.attachmentLoading) return;
    if (!this.paymentSignatureHasInk || !this.paymentSignatureCanvas) {
      wx.showToast({ title: '请先手写签名', icon: 'none' });
      return;
    }
    try {
      this.setData({ attachmentLoading: true });
      wx.showLoading({ title: '正在确认...' });
      const filePath = await this.paymentSignatureTempFile();
      await uploadMultipartApiFile(
        `/contract-attachments/${attachment.id}/decision`,
        filePath,
        { decision: 'APPROVE', reason: '' },
        'signature'
      );
      this.paymentSignatureCanvas = null;
      this.paymentSignatureContext = null;
      this.paymentSignatureHasInk = false;
      this.setData({
        showPaymentConfirmationSignature: false,
        paymentConfirmationAttachment: null
      });
      wx.showToast({ title: '已签字确认并更新对账', icon: 'success' });
      await this.loadAttachments(attachment.category);
    } catch (error) {
      wx.showToast({ title: error.message || '签字确认失败', icon: 'none' });
    } finally {
      wx.hideLoading();
      this.setData({ attachmentLoading: false });
    }
  },

  rejectAttachment(e) {
    const attachment = e.currentTarget.dataset.attachment;
    if (!attachment || !attachment.id) return;
    wx.showModal({
      title: '驳回资料',
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
        this.submitAttachmentDecision(attachment, 'REJECT', reason);
      }
    });
  },

  async submitAttachmentDecision(attachment, decision, reason) {
    if (this.data.attachmentLoading) return;
    const { request } = require('../../utils/request');
    try {
      this.setData({ attachmentLoading: true });
      await request({
        url: `/contract-attachments/${attachment.id}/decision`,
        method: 'POST',
        data: { decision, reason }
      });
      wx.showToast({ title: decision === 'APPROVE' ? '已通过并更新对账' : '已驳回', icon: 'success' });
      this.setData({ attachmentLoading: false });
      await this.loadAttachments(attachment.category);
    } catch (error) {
      wx.showToast({ title: error.message || '确认失败', icon: 'none' });
    } finally {
      this.setData({ attachmentLoading: false });
    }
  },

  withdrawAttachment(e) {
    const attachment = e.currentTarget.dataset.attachment;
    if (!attachment || !attachment.canWithdraw) return;
    wx.showModal({
      title: '撤回待确认资料',
      content: '撤回后，对方待办将移除并保留“上传方已撤回”的处理记录。',
      confirmText: '确认撤回',
      success: result => {
        if (result.confirm) this.submitAttachmentRemoval(attachment, 'withdraw');
      }
    });
  },

  deleteAttachment(e) {
    const attachment = e.currentTarget.dataset.attachment;
    if (!attachment || !attachment.canDelete) return;
    wx.showModal({
      title: '删除资料',
      content: `确定删除“${attachment.originalName}”吗？`,
      confirmText: '确认删除',
      confirmColor: '#d94848',
      success: result => {
        if (result.confirm) this.submitAttachmentRemoval(attachment, 'delete');
      }
    });
  },

  async submitAttachmentRemoval(attachment, action) {
    const { request } = require('../../utils/request');
    try {
      await request({
        url: `/contract-attachments/${attachment.id}/${action}`,
        method: 'POST',
        data: {}
      });
      wx.showToast({ title: action === 'withdraw' ? '资料已撤回' : '资料已删除', icon: 'success' });
      await this.loadAttachments(attachment.category);
    } catch (error) {
      wx.showToast({ title: error.message || '操作失败', icon: 'none' });
    }
  },

  requestAttachmentVoid(e) {
    const attachment = e.currentTarget.dataset.attachment;
    if (!attachment || !attachment.canRequestVoid) return;
    wx.showModal({
      title: `申请作废${attachment.category === 'INVOICE' ? '发票' : '转款凭证'}`,
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
        this.submitBilateralAction('ATTACHMENT', attachment.id, 'VOID', reason, false);
      }
    });
  },

  reviewAttachmentVoid(e) {
    const attachment = e.currentTarget.dataset.attachment;
    const decision = e.currentTarget.dataset.decision;
    if (!attachment || !attachment.pendingActionId || !attachment.canReviewAction) return;
    if (decision === 'REJECT') {
      wx.showModal({
        title: '拒绝作废申请', editable: true, placeholderText: '请输入拒绝原因',
        confirmText: '确认拒绝',
        success: result => {
          const reason = String(result.content || '').trim();
          if (result.confirm && reason) {
            this.submitContractActionDecision(attachment.pendingActionId, 'REJECT', reason);
          }
        }
      });
      return;
    }
    wx.showModal({
      title: '确认作废资料',
      content: '确认后原资料保留为“已作废”，相关对账金额将生成冲销记录。',
      confirmText: '确认作废',
      confirmColor: '#d94848',
      success: result => {
        if (result.confirm) this.submitContractActionDecision(attachment.pendingActionId, 'APPROVE', '');
      }
    });
  },

  viewAttachment(e) {
    this.downloadAttachmentFile(e.currentTarget.dataset.attachment, false);
  },

  downloadAttachment(e) {
    this.downloadAttachmentFile(e.currentTarget.dataset.attachment, true);
  },

  attachmentDownloadPath(attachment) {
    const originalName = String(attachment.originalName || '').trim();
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
      : (extensionByType[attachment.contentType] || 'bin');
    const rawBaseName = matched ? originalName.slice(0, -matched[0].length) : originalName;
    const safeBaseName = rawBaseName
      .replace(/[\\/:*?"<>|\r\n]/g, '_')
      .replace(/^\.+/, '')
      .trim()
      .slice(0, 80) || '合同资料';
    return `${wx.env.USER_DATA_PATH}/${safeBaseName}-${attachment.id}.${extension}`;
  },

  async downloadAttachmentFile(attachment, download) {
    if (!attachment || !attachment.id) return;
    const localFilePath = this.attachmentDownloadPath(attachment);
    const fileSize = Number(attachment.fileSize || 0);
    const cached = localFileReady(localFilePath, fileSize);
    if (!cached) {
      try {
        wx.getFileSystemManager().unlinkSync(localFilePath);
      } catch (error) {
        // 首次下载时目标文件不存在。
      }
      wx.showLoading({ title: download ? '下载中...' : '打开中...' });
    }
    try {
      const result = cached
        ? { filePath: localFilePath }
        : await downloadChunkedApiFile(
          `/contract-attachments/${attachment.id}/content-chunk-data`,
          localFilePath,
          fileSize > 0 ? fileSize : undefined
        );
      const path = result.filePath;
      if (attachment.isImage) {
        if (download) {
          wx.saveImageToPhotosAlbum({
            filePath: path,
            success: () => wx.showToast({ title: '图片已保存到相册', icon: 'success' }),
            fail: () => wx.showToast({ title: '图片保存失败，请检查相册权限', icon: 'none' })
          });
          return;
        }
        wx.previewImage({ current: path, urls: [path] });
        return;
      }
      const extension = String(attachment.originalName || '').split('.').pop().toLowerCase();
      wx.openDocument({
        filePath: path,
        fileType: ['pdf', 'doc', 'docx'].includes(extension) ? extension : undefined,
        showMenu: true,
        success: () => {
          if (download) wx.showToast({ title: '文件已下载', icon: 'success' });
        },
        fail: () => wx.showToast({ title: '文件打开失败', icon: 'none' })
      });
    } catch (error) {
      wx.showToast({ title: error.message || '文件获取失败', icon: 'none' });
    } finally {
      if (!cached) wx.hideLoading();
    }
  },

  async loadBusinessDocuments(documentType) {
    if (!this.data.canViewContractContent) return;
    const { request } = require('../../utils/request');
    this.documentRequestSeq = this.documentRequestSeq || {};
    const requestSeq = (this.documentRequestSeq[documentType] || 0) + 1;
    this.documentRequestSeq[documentType] = requestSeq;
    try {
      const list = await request({
        url: `/contracts/${this.data.contractId}/documents?type=${documentType}`
      });
      const documents = (list || []).map(item => ({
        ...item,
        dateText: String(item.createdAt || '').slice(0, 10)
      }));
      if (requestSeq !== this.documentRequestSeq[documentType]) return;
      const key = documentType === 'RETURN_ORDER' ? 'returnDocuments' : 'salesDocuments';
      this.setData({ [key]: documents }, () => this.updateFulfillmentCount());
    } catch (error) {
      wx.showToast({ title: error.message || '单据加载失败', icon: 'none' });
    }
  },

  async createBusinessDocument(e) {
    const documentType = e.currentTarget.dataset.type;
    const label = documentType === 'RETURN_ORDER' ? '退货单' : '销售单';
    const { request } = require('../../utils/request');
    try {
      wx.showLoading({ title: '加载模板中...' });
      const templates = await request({
        url: `/document-templates?type=${documentType}`
      });
      if (!templates || templates.length === 0) {
        wx.showModal({
          title: `暂无${label}模板`,
          content: `请先到“企业 - 交易单据模板”上传${label}模板。`,
          showCancel: false
        });
        return;
      }
      const contract = this.data.contract || {};
      const defaultTemplate = {
        ...templates[0],
        name: `合同默认${label}（${contract.contractNo || contract.id || this.data.contractId}）`,
        sourceType: 'CONTRACT_DEFAULT'
      };
      const selectableTemplates = [defaultTemplate].concat(templates.map(item => ({
        ...item,
        sourceType: 'TEMPLATE'
      })));
      this.setData({
        showDocumentEditor: true,
        documentEditorType: documentType,
        documentEditorLabel: label,
        documentTemplates: selectableTemplates,
        documentTemplateIndex: -1,
        documentTitle: label,
        documentCompanyName: this.currentCompanyName(),
        documentCounterpartyName: '',
        documentContractNo: '',
        documentDate: this.todayText(),
        documentColumns: [],
        documentRows: [],
        documentRowTypes: [],
        documentHasFees: false,
        documentBlankRows: 8,
        documentTotalAmount: '0',
        documentEditorReady: false,
        documentEditorSubmitting: false
      }, () => this.applyDocumentTemplate(0));
    } catch (error) {
      wx.showToast({ title: error.message || '模板加载失败', icon: 'none' });
    } finally {
      wx.hideLoading();
    }
  },

  onDocumentTemplateChange(e) {
    const index = Number(e.detail.value);
    if (!Number.isInteger(index) || index < 0) return;
    this.applyDocumentTemplate(index);
  },

  applyDocumentTemplate(index) {
    const template = this.data.documentTemplates[index];
    if (!template) return;
    try {
      const templateContent = JSON.parse(template.content || '{}');
      const columns = Array.isArray(templateContent.columns)
        ? templateContent.columns.map(item => String(item || '').trim()).filter(Boolean)
        : [];
      if (columns.length === 0) {
        wx.showToast({ title: '模板内容为空', icon: 'none' });
        return;
      }
      const contract = this.data.contract || {};
      const rows = this.buildDocumentRows(columns);
      const rowTypes = this.builtDocumentRowTypes || rows.map(() => 'PRODUCT');
      const totalAmount = this.calculateDocumentTotal(
        columns,
        rows,
        contract.amount || 0
      );
      this.setData({
        documentTemplateIndex: index,
        documentTitle: this.data.documentEditorLabel,
        documentCompanyName: this.currentCompanyName(),
        documentCounterpartyName: contract.viewerCounterpartyName
          || this.data.counterpartyName
          || contract.counterpartyName
          || '',
        documentContractNo: contract.contractNo || String(contract.id || this.data.contractId || ''),
        documentDate: this.todayText(),
        documentColumns: columns,
        documentRows: rows,
        documentRowTypes: rowTypes,
        documentHasFees: rowTypes.some(type => type === 'FEE'),
        documentBlankRows: Math.max(
          rows.length,
          Number(templateContent.blankRows) || 8
        ),
        documentTotalAmount: totalAmount,
        documentEditorReady: true
      });
    } catch (error) {
      wx.showToast({ title: '模板格式异常', icon: 'none' });
    }
  },

  todayText() {
    const now = new Date();
    const pad = value => String(value).padStart(2, '0');
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  },

  buildDocumentRows(columns) {
    const sections = (this.data.sData && this.data.sData.sections) || [];
    const table = sections.find(item => item && item.type === 'table') || {};
    const sourceColumns = Array.isArray(table.columns) ? table.columns : [];
    const sourceRows = (Array.isArray(table.rows) ? table.rows : []).filter(row =>
      Array.isArray(row) && row.some(value => {
        const text = String(value == null ? '' : value).trim();
        return text && text !== '0' && text !== '0.00';
      })
    );
    const rows = sourceRows.map((row, rowIndex) => columns.map(column =>
      this.valueForDocumentColumn(column, rowIndex, sourceColumns, row)
    ));
    const rowTypes = rows.map(() => 'PRODUCT');
    const feeSection = sections.find(item => item && item.type === 'fees') || {};
    (Array.isArray(feeSection.items) ? feeSection.items : []).forEach(item => {
      const rowIndex = rows.length;
      rows.push(columns.map(column => this.valueForDocumentFeeColumn(column, rowIndex, item)));
      rowTypes.push('FEE');
    });
    if (rows.length === 0) {
      rows.push(columns.map(column => String(column).includes('序号') ? '1' : ''));
      rowTypes.push('PRODUCT');
    }
    this.builtDocumentRowTypes = rowTypes;
    return rows;
  },

  valueForDocumentFeeColumn(targetColumn, rowIndex, item) {
    const target = String(targetColumn || '').trim();
    if (target.includes('序号')) return String(rowIndex + 1);
    if (target.includes('品名') || target === '名称' || target.includes('产品')) {
      return String(item.feeType || item.name || '其他费用');
    }
    if (target.includes('单位')) return '项';
    if (target.includes('数量')) return '1';
    if (target.includes('单价') || target.includes('金额')) return String(item.amount || '0');
    if (target.includes('备注')) return String(item.remark || '');
    return '';
  },

  valueForDocumentColumn(targetColumn, rowIndex, sourceColumns, sourceRow) {
    const target = String(targetColumn || '').trim();
    if (target.includes('序号')) return String(rowIndex + 1);
    let aliases = [target];
    if (target.includes('品名') || target === '名称' || target.includes('产品')) {
      aliases = ['品名', '名称', '产品'];
    } else if (target.includes('规格')) {
      aliases = ['规格', '型号'];
    } else if (target.includes('单位')) {
      aliases = ['单位'];
    } else if (target.includes('数量')) {
      aliases = ['数量'];
    } else if (target.includes('单价')) {
      aliases = ['单价'];
    } else if (target.includes('金额')) {
      aliases = ['金额'];
    } else if (target.includes('备注')) {
      aliases = ['备注'];
    }
    const sourceIndex = sourceColumns.findIndex(column =>
      aliases.some(alias => String(column || '').includes(alias))
    );
    return sourceIndex >= 0 && sourceIndex < sourceRow.length
      ? String(sourceRow[sourceIndex] == null ? '' : sourceRow[sourceIndex])
      : '';
  },

  onDocumentFieldInput(e) {
    const field = e.currentTarget.dataset.field;
    const editableFields = [
      'documentTitle', 'documentCompanyName', 'documentCounterpartyName',
      'documentContractNo', 'documentTotalAmount'
    ];
    if (!editableFields.includes(field)) return;
    this.setData({ [field]: e.detail.value });
  },

  onDocumentDateChange(e) {
    this.setData({ documentDate: e.detail.value });
  },

  onDocumentCellInput(e) {
    const rowIndex = Number(e.currentTarget.dataset.row);
    const columnIndex = Number(e.currentTarget.dataset.col);
    const rows = this.data.documentRows.map(row => row.slice());
    if (!rows[rowIndex] || columnIndex < 0) return;
    rows[rowIndex][columnIndex] = e.detail.value;

    const columns = this.data.documentColumns;
    const quantityIndex = columns.findIndex(column => String(column).includes('数量'));
    const priceIndex = columns.findIndex(column => String(column).includes('单价'));
    const amountIndex = columns.findIndex(column => String(column).includes('金额'));
    const changesCalculatedAmount = (columnIndex === quantityIndex || columnIndex === priceIndex)
      && quantityIndex >= 0 && priceIndex >= 0 && amountIndex >= 0;
    if (changesCalculatedAmount) {
      const amount = (parseFloat(rows[rowIndex][quantityIndex]) || 0)
        * (parseFloat(rows[rowIndex][priceIndex]) || 0);
      rows[rowIndex][amountIndex] = this.formatDocumentAmount(amount);
    }
    const shouldRecalculateTotal = changesCalculatedAmount || columnIndex === amountIndex;
    this.setData({
      documentRows: rows,
      documentTotalAmount: shouldRecalculateTotal
        ? this.calculateDocumentTotal(columns, rows, 0)
        : this.data.documentTotalAmount
    });
  },

  addDocumentRow() {
    const columns = this.data.documentColumns;
    if (columns.length === 0) return;
    const rows = this.data.documentRows.map(row => row.slice());
    const rowTypes = this.data.documentRowTypes.slice();
    rows.push(columns.map(column => String(column).includes('序号') ? String(rows.length + 1) : ''));
    rowTypes.push('PRODUCT');
    this.setData({
      documentRows: rows,
      documentRowTypes: rowTypes,
      documentHasFees: rowTypes.some(type => type === 'FEE'),
      documentBlankRows: Math.max(this.data.documentBlankRows, rows.length)
    });
  },

  deleteDocumentRow(e) {
    if (this.data.documentRows.length <= 1) return;
    const index = Number(e.currentTarget.dataset.index);
    const sequenceIndex = this.data.documentColumns.findIndex(column => String(column).includes('序号'));
    const rows = this.data.documentRows
      .filter((_, rowIndex) => rowIndex !== index)
      .map((row, rowIndex) => {
        const next = row.slice();
        if (sequenceIndex >= 0) next[sequenceIndex] = String(rowIndex + 1);
        return next;
      });
    const rowTypes = this.data.documentRowTypes.filter((_, rowIndex) => rowIndex !== index);
    this.setData({
      documentRows: rows,
      documentRowTypes: rowTypes,
      documentHasFees: rowTypes.some(type => type === 'FEE'),
      documentTotalAmount: this.calculateDocumentTotal(
        this.data.documentColumns,
        rows,
        0
      )
    });
  },

  calculateDocumentTotal(columns, rows, fallback) {
    const amountIndex = (columns || []).findIndex(column => String(column).includes('金额'));
    if (amountIndex < 0) return this.formatDocumentAmount(fallback);
    const values = (rows || []).map(row => String(row[amountIndex] == null ? '' : row[amountIndex]).trim());
    if (!values.some(Boolean)) return this.formatDocumentAmount(fallback);
    return this.formatDocumentAmount(values.reduce((sum, value) => sum + (parseFloat(value) || 0), 0));
  },

  formatDocumentAmount(value) {
    const amount = Math.round((parseFloat(value) || 0) * 100) / 100;
    return String(amount);
  },

  closeDocumentEditor() {
    if (this.data.documentEditorSubmitting) return;
    this.setData({ showDocumentEditor: false });
  },

  async submitBusinessDocument() {
    const {
      documentEditorType, documentEditorLabel, documentTemplates, documentTemplateIndex,
      documentTitle, documentCompanyName, documentCounterpartyName, documentContractNo,
      documentDate, documentColumns, documentRows, documentRowTypes, documentBlankRows,
      documentTotalAmount, createAsDraft
    } = this.data;
    if (documentTemplateIndex < 0 || !documentTemplates[documentTemplateIndex]) {
      wx.showToast({ title: `请选择${documentEditorLabel}模板`, icon: 'none' });
      return;
    }
    if (!documentTitle.trim()) {
      wx.showToast({ title: '请输入单据标题', icon: 'none' });
      return;
    }
    const confirmed = await new Promise(resolve => {
      wx.showModal({
        title: `确认保存${documentEditorLabel}草稿`,
        content: `模板：${documentTemplates[documentTemplateIndex].name}\n保存后可继续编辑，提交并经需方确认后才会进入对账。`,
        success: result => resolve(!!result.confirm),
        fail: () => resolve(false)
      });
    });
    if (!confirmed) return;

    const { request } = require('../../utils/request');
    try {
      this.setData({ documentEditorSubmitting: true });
      wx.showLoading({ title: '创建中...' });
      await request({
        url: `/contracts/${this.data.contractId}/documents`,
        method: 'POST',
        data: {
          documentType: documentEditorType,
          templateId: documentTemplates[documentTemplateIndex].id,
          sourceType: documentTemplates[documentTemplateIndex].sourceType || 'TEMPLATE',
          content: {
            title: documentTitle.trim(),
            companyName: documentCompanyName.trim(),
            counterpartyName: documentCounterpartyName.trim(),
            contractNo: documentContractNo.trim(),
            date: documentDate,
            columns: documentColumns,
            rows: documentRows,
            rowTypes: documentRowTypes,
            blankRows: documentBlankRows,
            totalAmount: documentTotalAmount
          }
        }
      });
      await this.loadBusinessDocuments(documentEditorType);
      this.setData({ showDocumentEditor: false });
      wx.showToast({ title: `${documentEditorLabel}草稿已保存`, icon: 'success' });
    } catch (error) {
      wx.showToast({ title: error.message || '单据生成失败', icon: 'none' });
    } finally {
      wx.hideLoading();
      this.setData({ documentEditorSubmitting: false });
    }
  },

  viewBusinessDocument(e) {
    this.downloadBusinessDocumentFile(e.currentTarget.dataset.document, false);
  },

  downloadBusinessDocument(e) {
    this.downloadBusinessDocumentFile(e.currentTarget.dataset.document, true);
  },

  async downloadBusinessDocumentFile(document, showDownloadedToast) {
    if (!document || !document.id) return;
    const label = document.documentType === 'RETURN_ORDER' ? '退货单' : '销售单';
    const safeNo = String(document.documentNo || document.id).replace(/[\\/:*?"<>|\r\n]/g, '_');
    const filePath = `${wx.env.USER_DATA_PATH}/${label}-${safeNo}.pdf`;
    try {
      wx.getFileSystemManager().unlinkSync(filePath);
    } catch (error) {
      // 首次生成时目标文件不存在。
    }
    wx.showLoading({ title: '下载PDF中...' });
    try {
      const result = await downloadApiFile(
        `/trade-documents/${document.id}/pdf-data`, filePath
      );
      if (showDownloadedToast) wx.showToast({ title: 'PDF已下载', icon: 'success' });
      this.openPdfDocument(result.filePath);
    } catch (error) {
      wx.showToast({ title: error.message || 'PDF下载失败', icon: 'none' });
    } finally {
      wx.hideLoading();
    }
  },

  openSalesOrderDetail(e) {
    const document = e.currentTarget.dataset.document;
    if (!document || !document.id) return;
    wx.navigateTo({
      url: `/pages/sales-order-detail/sales-order-detail?id=${document.id}&documentNo=${encodeURIComponent(document.documentNo || '')}`
    });
  },

  /* 列表项点击 → 显示详情面板 */
  onItemTap(e) {
    const { type, item } = e.currentTarget.dataset;
    if (type === '发票') {
      this.showInvoiceDetail(item);
    }
  },

  showInvoiceDetail(inv) {
    this.setData({
      showDetail: true,
      detailTitle: '发票详情',
      detailFields: [
        { label: '系统编号', value: inv.invoiceNo },
        { label: '发票类型', value: inv.type },
        { label: '开票状态', value: inv.status, highlight: true },
        { label: '发票金额', value: `¥${inv.amount}`, amount: true },
        { label: '税率', value: inv.taxRate },
        { label: '开票日期', value: inv.date || '--' }
      ]
    });
  },

  closeDetail() {
    this.setData({ showDetail: false, detailSteps: [] });
  },

  noop() {}
});
