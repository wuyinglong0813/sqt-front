const app = getApp();

function hasPerm(perm) {
  const member = app.globalData.memberInfo;
  if (!member || !member.permissions) return false;
  const perms = member.permissions;
  if (perms.includes('all')) return true;
  return perms.includes(perm);
}

function formatAmount(value) {
  const amount = Number(value || 0);
  const parts = amount.toFixed(Number.isInteger(amount) ? 0 : 2).split('.');
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return parts.join('.');
}

function contractPeriod(startDate, endDate) {
  if (startDate && endDate) return `${startDate} 至 ${endDate}`;
  if (startDate) return `${startDate} 起`;
  if (endDate) return `至 ${endDate}`;
  return '未设置期限';
}

Page({
  data: {
    counterpartyName: '',
    counterpartyCompanyId: '',
    myCompanyName: '',
    role: 'supplier',
    relationText: '客户企业',
    trendTitle: '月销售额趋势',
    signLabel: '签订销售合同',
    reconciliationLabel: '客户对账',
    // 快捷操作（带权限控制）
    canSignContract: false,
    canReconciliation: false,
    // 合同列表（我方与该公司签订的所有合同）
    contracts: [],
    filteredContracts: [],
    activeContractFilter: 'ALL',
    contractLoading: true,
    contractStats: {
      total: 0,
      pending: 0,
      active: 0,
      closed: 0,
      totalAmountText: '0'
    },
    contractFilters: [
      { key: 'ALL', label: '全部', count: 0 },
      { key: 'PENDING', label: '待签署', count: 0 },
      { key: 'ACTIVE', label: '履行中', count: 0 },
      { key: 'CLOSED', label: '已结束', count: 0 }
    ],
    // 月销售趋势
    monthlySales: [],
    // 弹窗
    showModal: false,
    modalTitle: '',
    modalContent: ''
  },

  onLoad(options) {
    const name = decodeURIComponent(options.counterpartyName || '');
    const counterpartyCompanyId = decodeURIComponent(options.counterpartyCompanyId || '');
    const role = options.role === 'buyer' ? 'buyer' : 'supplier';
    // 获取我方当前企业名
    const companies = app.globalData.companies || [];
    const cid = (app.globalData.userInfo && app.globalData.userInfo.currentCompanyId) || '';
    const cur = companies.find(c => c.companyId === cid);
    this.setData({
      counterpartyName: name,
      counterpartyCompanyId,
      myCompanyName: (cur && cur.companyName) || '我的企业',
      role,
      relationText: role === 'supplier' ? '客户企业' : '供应商企业',
      trendTitle: role === 'supplier' ? '月销售额趋势' : '月采购额趋势',
      signLabel: role === 'supplier' ? '签订销售合同' : '签订采购合同',
      reconciliationLabel: role === 'supplier' ? '客户对账' : '供应商对账',
      canSignContract: !!counterpartyCompanyId && hasPerm('contract_sign'),
      canReconciliation: hasPerm('reconciliation')
    });
    this.loadMonthlySales(name);
  },

  onShow() {
    // 每次回到页面时刷新合同列表（例如从签订合同页返回）
    if (this.data.counterpartyName) {
      this.loadContracts(this.data.counterpartyName);
    }
    this.startStatusPolling();
  },

  onHide() {
    this.stopStatusPolling();
  },

  onUnload() {
    this.stopStatusPolling();
  },

  onPullDownRefresh() {
    Promise.all([
      this.loadContracts(this.data.counterpartyName),
      this.loadMonthlySales(this.data.counterpartyName)
    ]).finally(() => wx.stopPullDownRefresh());
  },

  startStatusPolling() {
    this.stopStatusPolling();
    this.contractStatusTimer = setInterval(() => {
      if (this.data.counterpartyName) this.loadContracts(this.data.counterpartyName, true);
    }, 8000);
  },

  stopStatusPolling() {
    if (!this.contractStatusTimer) return;
    clearInterval(this.contractStatusTimer);
    this.contractStatusTimer = null;
  },

  /* 加载合同列表 */
  async loadContracts(counterpartyName, silent = false) {
    const { request } = require('../../utils/request');
    this.contractRequestSeq = (this.contractRequestSeq || 0) + 1;
    const requestSeq = this.contractRequestSeq;
    if (!silent) this.setData({ contractLoading: true });
    try {
      const payload = await request({
        url: `/contracts?counterpartyName=${encodeURIComponent(counterpartyName)}&page=1&size=100`
      });
      const list = Array.isArray(payload) ? payload : (payload.items || []);
      if (requestSeq !== this.contractRequestSeq) return;
      const statusMap = { ACTIVE: '履行中', PENDING: '待签署', REJECTED: '已拒绝', CANCELLED: '已撤回', COMPLETED: '已结束', VOIDED: '已作废' };
      const total = list.length;
      const contracts = (list || []).map((c, index) => ({
        id: String(c.id),
        name: c.name,
        startDate: c.startDate || '',
        endDate: c.endDate || '',
        amount: c.amount || 0,
        amountText: formatAmount(c.amount),
        templateName: c.templateName || '',
        templateText: c.templateName ? `模板：${c.templateName}` : '双方自定义合同',
        contractNo: c.contractNo || `TP-${String(c.id).padStart(6, '0')}`,
        sequenceText: `合同 ${String(index + 1).padStart(2, '0')} / ${String(total).padStart(2, '0')}`,
        periodText: contractPeriod(c.startDate, c.endDate),
        status: c.status,
        statusText: statusMap[c.status] || c.status
      }));
      const pending = contracts.filter(item => item.status === 'PENDING').length;
      const active = contracts.filter(item => item.status === 'ACTIVE').length;
      const closed = contracts.filter(item => ['COMPLETED', 'VOIDED', 'REJECTED', 'CANCELLED'].includes(item.status)).length;
      const totalAmount = contracts.reduce((sum, item) => sum + Number(item.amount || 0), 0);
      this.setData({
        contracts,
        contractLoading: false,
        contractStats: {
          total,
          pending,
          active,
          closed,
          totalAmountText: formatAmount(totalAmount)
        },
        contractFilters: [
          { key: 'ALL', label: '全部', count: total },
          { key: 'PENDING', label: '待签署', count: pending },
          { key: 'ACTIVE', label: '履行中', count: active },
          { key: 'CLOSED', label: '已结束', count: closed }
        ]
      });
      this.applyContractFilter(this.data.activeContractFilter);
    } catch (e) {
      if (requestSeq !== this.contractRequestSeq || silent) return;
      this.setData({ contractLoading: false, contracts: [], filteredContracts: [] });
    }
  },

  onContractFilterTap(e) {
    this.applyContractFilter(e.currentTarget.dataset.key || 'ALL');
  },

  applyContractFilter(key) {
    const filteredContracts = key === 'ALL'
      ? this.data.contracts
      : this.data.contracts.filter(item => key === 'CLOSED'
        ? ['COMPLETED', 'VOIDED', 'REJECTED', 'CANCELLED'].includes(item.status)
        : item.status === key);
    this.setData({ activeContractFilter: key, filteredContracts });
  },

  async loadMonthlySales(counterpartyName) {
    const { request } = require('../../utils/request');
    try {
      const list = await request({
        url: `/orders/monthly-summary?counterpartyName=${encodeURIComponent(counterpartyName)}&direction=${this.data.role === 'supplier' ? 'SALE' : 'PURCHASE'}`
      });
      const now = new Date();
      const buckets = [];
      const byKey = {};
      for (let offset = 11; offset >= 0; offset--) {
        const date = new Date(now.getFullYear(), now.getMonth() - offset, 1);
        const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
        const item = { key, month: String(date.getMonth() + 1), amount: 0, percent: 0 };
        buckets.push(item);
        byKey[key] = item;
      }
      (list || []).forEach(summary => {
        const key = String(summary.period || '');
        if (byKey[key]) byKey[key].amount = Number(summary.amount || 0);
      });
      const max = Math.max(...buckets.map(item => item.amount), 0);
      this.setData({
        monthlySales: buckets.map(item => ({
          ...item,
          percent: max > 0 && item.amount > 0 ? Math.max(8, Math.round(item.amount / max * 100)) : 0
        }))
      });
    } catch (error) {
      this.setData({ monthlySales: [] });
    }
  },

  /* 点击合同 → 进入合同预览页 */
  onContractTap(e) {
    const contract = e.currentTarget.dataset.contract;
    wx.navigateTo({
      url: `/pages/contract-preview/contract-preview?contractId=${contract.id}&contractName=${encodeURIComponent(contract.name)}&counterpartyName=${encodeURIComponent(this.data.counterpartyName)}`
    });
  },

  /* 功能区点击 */
  onAction(e) {
    const key = e.currentTarget.dataset.key;
    const name = this.data.counterpartyName;
    switch (key) {
      case 'sign':
        if (!this.data.counterpartyCompanyId) {
          wx.showToast({ title: '请先建立有效的企业合作关系', icon: 'none' });
          return;
        }
        wx.navigateTo({
          url: `/pages/sign-contract/sign-contract?counterpartyName=${encodeURIComponent(name)}&counterpartyCompanyId=${encodeURIComponent(this.data.counterpartyCompanyId)}&role=${this.data.role}`
        });
        break;
      case 'reconciliation':
        wx.navigateTo({
          url: `/pages/reconciliation/reconciliation?counterpartyName=${encodeURIComponent(name)}&counterpartyCompanyId=${encodeURIComponent(this.data.counterpartyCompanyId)}&role=${this.data.role}`
        });
        break;
    }
  },

  closeModal() { this.setData({ showModal: false }); },
  noop() {}
});
