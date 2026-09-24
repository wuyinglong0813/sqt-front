const { request } = require('../../utils/request');
const app = getApp();

Page({
  data: {
    loading: false,
    activeTab: 'ALL',
    tabs: [
      { key: 'ALL', label: '全部' },
      { key: 'PENDING', label: '待签署' },
      { key: 'ACTIVE', label: '履约中' },
      { key: 'COMPLETED', label: '已结束' },
      { key: 'VOIDED', label: '已作废' }
    ],
    contracts: [],
    visibleContracts: [],
    contractGroups: [],
    currentCompanyName: '',
    companyOptions: [{ id: '', name: '全部往来公司' }],
    companyIndex: 0,
    selectedCompanyId: '',
    signatureMode: false,
    page: 1,
    size: 20,
    hasMore: false,
    summary: { total: 0, pending: 0, active: 0, amount: '0' }
  },

  onLoad(options) {
    if (options.mode === 'signature') this.setData({ activeTab: 'PENDING', signatureMode: true });
  },

  onShow() {
    const currentCompanyId = String(app.getCurrentCompanyId() || '');
    const company = (app.globalData.companies || [])
      .find(item => String(item.companyId) === currentCompanyId);
    this.setData({ currentCompanyName: (company && company.companyName) || '当前企业' });
    this.loadContracts(true);
  },

  onPullDownRefresh() {
    this.loadContracts(true).finally(() => wx.stopPullDownRefresh());
  },

  onReachBottom() {
    if (this.data.hasMore && !this.data.loading) this.loadContracts(false);
  },

  async loadContracts(reset = true) {
    this.setData({ loading: true });
    try {
      const page = reset ? 1 : this.data.page + 1;
      const signatureMode = this.data.signatureMode;
      const status = this.data.activeTab === 'ALL' ? '' : `&status=${this.data.activeTab}`;
      const endpoint = signatureMode ? '/contracts/pending' : `/contracts?page=${page}&size=${this.data.size}${status}`;
      const [payload, summaryPayload] = await Promise.all([
        request({ url: endpoint }),
        reset && !signatureMode ? request({ url: '/contracts/summary' }) : Promise.resolve(null)
      ]);
      const list = Array.isArray(payload) ? payload : (payload.items || []);
      const statusText = { PENDING: '待签署', ACTIVE: '履约中', COMPLETED: '已结束', VOIDED: '已作废', REJECTED: '已拒绝', CANCELLED: '已撤回' };
      const nextContracts = (list || []).map(item => {
        const counterpartyName = item.viewerCounterpartyName || item.counterpartyName || '往来公司';
        return {
          ...item,
          counterpartyName,
          companyId: String(item.viewerCounterpartyCompanyId || item.counterpartyCompanyId
            || `name:${counterpartyName}`),
          direction: item.viewerDirection || item.direction,
          id: String(item.id),
          amount: Number(item.amount || 0),
          statusText: statusText[item.status] || item.status,
          createdDate: (item.createdAt || '').substring(0, 10)
        };
      });
      const contracts = reset ? nextContracts : this.data.contracts.concat(nextContracts);
      const localAmount = contracts.reduce((sum, item) => sum + item.amount, 0);
      const summary = summaryPayload ? {
        total: Number(summaryPayload.total || 0),
        pending: Number(summaryPayload.pending || 0),
        active: Number(summaryPayload.active || 0),
        amount: Number(summaryPayload.amount || 0).toFixed(0)
      } : {
        total: contracts.length,
        pending: contracts.filter(item => item.status === 'PENDING').length,
        active: contracts.filter(item => item.status === 'ACTIVE').length,
        amount: localAmount.toFixed(0)
      };
      this.setData({
        contracts,
        page,
        hasMore: signatureMode ? false : !!payload.hasMore,
        summary: reset ? summary : this.data.summary
      });
      this.applyFilter();
    } catch (error) {
      wx.showToast({ title: error.message || '合同加载失败', icon: 'none' });
    } finally {
      this.setData({ loading: false });
    }
  },

  switchTab(event) {
    this.setData({
      activeTab: event.currentTarget.dataset.key,
      selectedCompanyId: '',
      companyIndex: 0
    });
    if (this.data.signatureMode) this.applyFilter();
    else this.loadContracts(true);
  },

  applyFilter() {
    const activeTab = this.data.activeTab;
    const visibleContracts = activeTab === 'ALL'
      ? this.data.contracts
      : this.data.contracts.filter(item => item.status === activeTab);
    const companies = [];
    const seen = new Set();
    visibleContracts.forEach(item => {
      if (!item.companyId || seen.has(item.companyId)) return;
      seen.add(item.companyId);
      companies.push({ id: item.companyId, name: item.counterpartyName || '往来公司' });
    });
    const companyOptions = [
      { id: '', name: `全部往来公司（${companies.length}）` },
      ...companies
    ];
    let selectedCompanyId = this.data.selectedCompanyId;
    if (selectedCompanyId && !seen.has(String(selectedCompanyId))) selectedCompanyId = '';
    const companyIndex = Math.max(0,
      companyOptions.findIndex(item => String(item.id) === String(selectedCompanyId)));
    const grouped = new Map();
    visibleContracts
      .filter(item => !selectedCompanyId || item.companyId === String(selectedCompanyId))
      .forEach(item => {
        if (!grouped.has(item.companyId)) {
          grouped.set(item.companyId, {
            companyId: item.companyId,
            companyName: item.counterpartyName || '往来公司',
            initial: String(item.counterpartyName || '企').substring(0, 1),
            items: []
          });
        }
        grouped.get(item.companyId).items.push(item);
      });
    this.setData({
      visibleContracts,
      companyOptions,
      companyIndex,
      selectedCompanyId,
      contractGroups: Array.from(grouped.values())
    });
  },

  selectCompany(event) {
    const companyIndex = Number(event.detail.value || 0);
    const selected = this.data.companyOptions[companyIndex] || this.data.companyOptions[0];
    this.setData({ companyIndex, selectedCompanyId: selected.id || '' });
    this.applyFilter();
  },

  openContract(event) {
    const item = event.currentTarget.dataset.item;
    wx.navigateTo({
      url: `/pages/contract-preview/contract-preview?contractId=${item.id}&contractName=${encodeURIComponent(item.name || '')}&counterpartyName=${encodeURIComponent(item.counterpartyName || '')}`
    });
  }
});
