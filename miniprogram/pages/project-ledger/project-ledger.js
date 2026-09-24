const { request } = require('../../utils/request');

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

Page({
  data: {
    loading: false,
    projects: [],
    activeProject: null,
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
    await this.loadProjects();
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
        }
      });
    } catch (error) {
      wx.showToast({ title: error.message || '项目加载失败', icon: 'none' });
    } finally {
      wx.hideLoading();
    }
  },

  closeProject() {
    this.setData({ activeProject: null });
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
        activeProject: {
          ...decorateProject(project),
          contracts: (project.contracts || []).map(decorateContract)
        }
      });
      wx.showToast({ title: '合同已划分', icon: 'success' });
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
          await this.loadProjects();
        } catch (error) {
          wx.showToast({ title: error.message || '移出失败', icon: 'none' });
        }
      }
    });
  },

  noop() {}
});

module.exports = { money, decorateProject, decorateContract };
