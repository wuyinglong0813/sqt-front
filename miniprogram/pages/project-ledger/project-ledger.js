const { request } = require('../../utils/request');
const { downloadApiFile } = require('../../utils/fileTransfer');
const { captureCompanyContext, isCompanyContextCurrent } = require('../../utils/companyContext');

function money(value) {
  const amount = Number(value || 0);
  return Number.isFinite(amount) ? amount.toFixed(2) : '0.00';
}

function decorateProject(item) {
  return {
    ...item,
    purchaseCostText: money(item.purchaseCost),
    salesIncomeText: money(item.salesIncome),
    estimatedProfitText: money(item.estimatedProfit)
  };
}

function decorateContract(item) {
  return { ...item, amountText: money(item.amount), selected: false };
}

function decorateLedger(detail) {
  const fields = ['contractAmount', 'amount', 'paymentAmount', 'unpaidAmount', 'invoiceAmount', 'unbilledAmount'];
  const amounts = row => fields.reduce((result, field) => {
    result[`${field}Text`] = row[field] === null || row[field] === undefined ? '' : money(row[field]);
    return result;
  }, {});
  return {
    ...detail,
    groups: (detail.groups || []).map(group => ({
      ...group,
      rows: (group.rows || []).map(row => ({
        ...row,
        dateText: row.date ? String(row.date).slice(0, 10) : '—',
        ...amounts(row)
      })),
      totals: { ...group.totals, ...amounts(group.totals || {}) }
    }))
  };
}

Page({
  data: {
    loading: false,
    projects: [],
    activeProject: null,
    projectTab: 'ledger',
    ledger: null,
    ledgerLoading: false,
    ledgerError: '',
    exportingLedger: false,
    showCreate: false,
    projectName: '',
    projectNo: '',
    projectDescription: '',
    creating: false,
    showAssign: false,
    availableContracts: [],
    selectedContractIds: [],
    assigning: false,
    pendingContractId: '',
    pendingContractName: '',
    pendingAction: ''
  },

  onLoad(options) {
    const pendingContractId = options.contractId || '';
    this.pendingFlowStarted = false;
    this.setData({
      pendingContractId,
      pendingContractName: decodeURIComponent(options.contractName || ''),
      pendingAction: pendingContractId ? (options.action || 'assign') : ''
    });
  },

  async onShow() {
    await this.refresh();
    this.startPendingContractFlow();
  },

  onPullDownRefresh() {
    this.refresh().finally(() => wx.stopPullDownRefresh());
  },

  async refresh() {
    await this.loadProjects();
    if (this.data.activeProject) await this.loadProject(this.data.activeProject.id);
  },

  async loadProjects() {
    if (this.data.loading) return;
    this.setData({ loading: true });
    try {
      const projects = await request({ url: '/project-ledgers' });
      this.setData({ projects: (projects || []).map(decorateProject) });
    } catch (error) {
      wx.showToast({ title: error.message || '项目加载失败', icon: 'none' });
    } finally {
      this.setData({ loading: false });
    }
  },

  async openProject(e) {
    if (this.data.pendingContractId) {
      const project = this.data.projects.find(
        item => String(item.id) === String(e.currentTarget.dataset.id)
      );
      if (project) this.confirmPendingAssignment(project);
      return;
    }
    await this.loadProject(e.currentTarget.dataset.id);
  },

  startPendingContractFlow() {
    if (this.pendingFlowStarted || !this.data.pendingContractId) return;
    this.pendingFlowStarted = true;
    if (this.data.pendingAction === 'create' || this.data.projects.length === 0) {
      this.openCreate();
    }
  },

  confirmPendingAssignment(project) {
    if (!project || this.data.assigning) return;
    wx.showModal({
      title: '加入已有项目账套',
      content: `确定将合同“${this.data.pendingContractName || this.data.pendingContractId}”加入“${project.name}”吗？`,
      confirmText: '确认加入',
      success: result => {
        if (result.confirm) this.assignPendingContract(project.id);
      }
    });
  },

  async assignPendingContract(projectId) {
    if (!projectId || !this.data.pendingContractId || this.data.assigning) return false;
    try {
      this.setData({ assigning: true });
      await request({
        url: `/project-ledgers/${projectId}/contracts`,
        method: 'POST',
        data: { contractIds: [this.data.pendingContractId] }
      });
      wx.setStorageSync(this.pendingPromptStorageKey(), true);
      wx.showToast({ title: '合同已加入项目', icon: 'success' });
      setTimeout(() => wx.navigateBack({ delta: 1 }), 500);
      return true;
    } catch (error) {
      wx.showToast({ title: error.message || '合同加入项目失败', icon: 'none' });
      return false;
    } finally {
      this.setData({ assigning: false });
    }
  },

  pendingPromptStorageKey() {
    const companyId = getApp().getCurrentCompanyId() || 'unknown';
    return `tradepass_project_prompt_${companyId}_${this.data.pendingContractId}`;
  },

  async loadProject(id) {
    try {
      wx.showLoading({ title: '加载中' });
      const project = await request({ url: `/project-ledgers/${id}` });
      this.setData({
        activeProject: {
          ...decorateProject(project),
          contracts: (project.contracts || []).map(decorateContract)
        },
        ledger: null
      });
    } catch (error) {
      wx.showToast({ title: error.message || '项目加载失败', icon: 'none' });
    } finally {
      wx.hideLoading();
    }
    if (this.data.activeProject && String(this.data.activeProject.id) === String(id)) {
      await this.loadLedger(id);
    }
  },

  async loadLedger(id) {
    const projectId = id || (this.data.activeProject && this.data.activeProject.id);
    if (!projectId) return;
    const sequence = (this.ledgerSequence || 0) + 1;
    this.ledgerSequence = sequence;
    const app = getApp();
    const companyContext = captureCompanyContext(app);
    const current = () => this.ledgerSequence === sequence && isCompanyContextCurrent(app, companyContext)
      && this.data.activeProject && String(this.data.activeProject.id) === String(projectId);
    this.setData({ ledger: null, ledgerLoading: true, ledgerError: '' });
    try {
      const detail = await request({ url: `/project-ledgers/${projectId}/ledger` });
      if (current()) this.setData({ ledger: decorateLedger(detail) });
    } catch (error) {
      if (current()) this.setData({ ledgerError: error.message || '台账明细加载失败' });
    } finally {
      if (current()) this.setData({ ledgerLoading: false });
    }
  },

  retryLedger() { return this.loadLedger(); },

  selectProjectTab(e) {
    this.setData({ projectTab: e.currentTarget.dataset.tab });
  },

  async exportLedger() {
    const project = this.data.activeProject;
    if (!project || this.data.exportingLedger || !this.data.ledger) return;
    this.setData({ exportingLedger: true });
    const app = getApp();
    const context = captureCompanyContext(app);
    const safeName = String(project.name || project.id).replace(/[\\/:*?"<>|\r\n]/g, '_').slice(0, 80);
    wx.showLoading({ title: '生成 Excel' });
    try {
      const result = await downloadApiFile(`/project-ledgers/${project.id}/ledger/workbook-data`,
        `${wx.env.USER_DATA_PATH}/${safeName}-${project.id}-台账明细.xlsx`);
      if (isCompanyContextCurrent(app, context)) wx.openDocument({
        filePath: result.filePath, fileType: 'xlsx', showMenu: true,
        fail: () => wx.showToast({ title: 'Excel 打开失败', icon: 'none' })
      });
    } catch (error) {
      if (isCompanyContextCurrent(app, context)) wx.showToast({ title: error.message || '台账导出失败', icon: 'none' });
    } finally {
      wx.hideLoading();
      this.setData({ exportingLedger: false });
    }
  },

  closeProject() {
    this.ledgerSequence = (this.ledgerSequence || 0) + 1;
    this.setData({ activeProject: null, ledger: null, ledgerLoading: false, ledgerError: '', projectTab: 'ledger' });
  },

  openCreate() {
    this.setData({
      showCreate: true,
      projectName: '',
      projectNo: '',
      projectDescription: ''
    });
  },

  closeCreate() {
    if (!this.data.creating) this.setData({ showCreate: false });
  },

  onProjectInput(e) {
    const field = e.currentTarget.dataset.field;
    if (['projectName', 'projectNo', 'projectDescription'].includes(field)) {
      this.setData({ [field]: e.detail.value });
    }
  },

  async createProject() {
    const name = this.data.projectName.trim();
    if (!name || this.data.creating) {
      if (!name) wx.showToast({ title: '请输入项目名称', icon: 'none' });
      return;
    }
    try {
      this.setData({ creating: true });
      const project = await request({
        url: '/project-ledgers',
        method: 'POST',
        data: {
          name,
          projectNo: this.data.projectNo.trim(),
          description: this.data.projectDescription.trim()
        }
      });
      this.setData({ showCreate: false });
      if (this.data.pendingContractId) {
        const assigned = await this.assignPendingContract(project.id);
        if (!assigned) {
          wx.showToast({ title: '项目已创建，请重新选择加入合同', icon: 'none' });
          await this.loadProjects();
        }
        return;
      }
      wx.showToast({ title: '项目已创建', icon: 'success' });
      await this.loadProjects();
      await this.loadProject(project.id);
    } catch (error) {
      wx.showToast({ title: error.message || '创建失败', icon: 'none' });
    } finally {
      this.setData({ creating: false });
    }
  },

  async openAssign() {
    const project = this.data.activeProject;
    if (!project || this.data.assigning) return;
    try {
      wx.showLoading({ title: '加载合同' });
      const contracts = await request({ url: `/project-ledgers/${project.id}/available-contracts` });
      this.setData({
        showAssign: true,
        availableContracts: (contracts || []).map(decorateContract),
        selectedContractIds: []
      });
    } catch (error) {
      wx.showToast({ title: error.message || '合同加载失败', icon: 'none' });
    } finally {
      wx.hideLoading();
    }
  },

  closeAssign() {
    if (!this.data.assigning) this.setData({ showAssign: false });
  },

  toggleContract(e) {
    const id = String(e.currentTarget.dataset.id);
    const selected = new Set((this.data.selectedContractIds || []).map(String));
    if (selected.has(id)) selected.delete(id);
    else selected.add(id);
    const selectedContractIds = Array.from(selected);
    this.setData({
      selectedContractIds,
      availableContracts: this.data.availableContracts.map(item => ({
        ...item,
        selected: selected.has(String(item.id))
      }))
    });
  },

  async assignContracts() {
    if (this.data.selectedContractIds.length === 0 || this.data.assigning) {
      if (this.data.selectedContractIds.length === 0) {
        wx.showToast({ title: '请选择合同', icon: 'none' });
      }
      return;
    }
    try {
      this.setData({ assigning: true });
      const project = await request({
        url: `/project-ledgers/${this.data.activeProject.id}/contracts`,
        method: 'POST',
        data: { contractIds: this.data.selectedContractIds }
      });
      this.setData({
        showAssign: false,
        projectTab: 'ledger',
        activeProject: {
          ...decorateProject(project),
          contracts: (project.contracts || []).map(decorateContract)
        }
      });
      wx.showToast({ title: '合同已划分', icon: 'success' });
      await this.loadLedger(project.id);
      await this.loadProjects();
    } catch (error) {
      wx.showToast({ title: error.message || '划分失败', icon: 'none' });
    } finally {
      this.setData({ assigning: false });
    }
  },

  removeContract(e) {
    const contractId = e.currentTarget.dataset.id;
    wx.showModal({
      title: '移出项目',
      content: '移出后项目金额将自动重新计算，合同本身不会改变。',
      confirmText: '确认移出',
      success: async result => {
        if (!result.confirm) return;
        try {
          const project = await request({
            url: `/project-ledgers/${this.data.activeProject.id}/contracts/${contractId}/remove`,
            method: 'POST'
          });
          this.setData({
            activeProject: {
              ...decorateProject(project),
              contracts: (project.contracts || []).map(decorateContract)
            }
          });
          wx.showToast({ title: '合同已移出', icon: 'success' });
          await this.loadLedger(project.id);
          await this.loadProjects();
        } catch (error) {
          wx.showToast({ title: error.message || '移出失败', icon: 'none' });
        }
      }
    });
  },

  noop() {}
});

module.exports = { money, decorateProject, decorateContract, decorateLedger };
