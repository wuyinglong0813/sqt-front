const { request } = require('../../utils/request');
const { downloadApiFile } = require('../../utils/fileTransfer');

const app = getApp();

Page({
  data: {
    counterpartyName: '',
    counterpartyCompanyId: '',
    isGlobal: false,
    role: 'supplier',
    pageTitle: '客户对账',
    currentCompanyName: '',
    loading: false,
    accounts: [],
    visibleAccounts: [],
    companyOptions: [{ id: '', name: '全部往来公司' }],
    companyIndex: 0
  },

  onLoad(options) {
    const counterpartyName = decodeURIComponent(options.counterpartyName || '');
    const counterpartyCompanyId = decodeURIComponent(options.counterpartyCompanyId || '');
    const role = options.role === 'buyer' ? 'buyer' : 'supplier';
    const currentCompanyId = String(app.getCurrentCompanyId() || '');
    const currentCompany = (app.globalData.companies || [])
      .find(item => String(item.companyId) === currentCompanyId);
    this.setData({
      counterpartyName,
      counterpartyCompanyId,
      isGlobal: !counterpartyCompanyId,
      role,
      pageTitle: role === 'buyer' ? '供应商对账' : '客户对账',
      currentCompanyName: (currentCompany && currentCompany.companyName) || '当前企业'
    });
    wx.setNavigationBarTitle({ title: role === 'buyer' ? '供应商对账' : '客户对账' });
    this.loadAccounts();
  },

  onPullDownRefresh() {
    this.loadAccounts().finally(() => wx.stopPullDownRefresh());
  },

  mapAccount(item) {
    return {
      ...item,
      entryCount: Number(item.entryCount || 0),
      updatedText: item.updatedAt
        ? String(item.updatedAt).replace('T', ' ').slice(0, 16)
        : '暂无已确认单据'
    };
  },

  async loadAccounts() {
    if (this.data.loading) return;
    this.setData({ loading: true });
    try {
      const raw = this.data.isGlobal
        ? await request({ url: `/reconciliation-accounts?role=${this.data.role}` })
        : [await request({ url: `/reconciliation-accounts/${encodeURIComponent(this.data.counterpartyCompanyId)}?role=${this.data.role}` })];
      const accounts = (raw || []).map(item => this.mapAccount(item));
      const companyOptions = [
        { id: '', name: `全部往来公司（${accounts.length}）` },
        ...accounts.map(item => ({
          id: String(item.counterpartyCompanyId),
          name: item.counterpartyName
        }))
      ];
      this.setData({ accounts, visibleAccounts: accounts, companyOptions, companyIndex: 0 });
    } catch (error) {
      wx.showToast({ title: error.message || '对账单加载失败', icon: 'none' });
    } finally {
      this.setData({ loading: false });
    }
  },

  selectCompany(e) {
    const companyIndex = Number(e.detail.value || 0);
    const selected = this.data.companyOptions[companyIndex] || this.data.companyOptions[0];
    const visibleAccounts = selected.id
      ? this.data.accounts.filter(item => String(item.counterpartyCompanyId) === String(selected.id))
      : this.data.accounts;
    this.setData({ companyIndex, visibleAccounts });
  },

  viewPdf(e) {
    this.downloadPdfFile(e.currentTarget.dataset.account, false);
  },

  downloadPdf(e) {
    this.downloadPdfFile(e.currentTarget.dataset.account, true);
  },

  async downloadPdfFile(account, download) {
    if (!account || !account.counterpartyCompanyId) return;
    const safeName = String(account.counterpartyName || account.counterpartyCompanyId)
      .replace(/[\\/:*?"<>|\r\n]/g, '_');
    const filePath = `${wx.env.USER_DATA_PATH}/对账单-${safeName}.pdf`;
    wx.showLoading({ title: download ? '下载 PDF 中...' : '打开明细中...' });
    try {
      const result = await downloadApiFile(
        `/reconciliation-accounts/${account.counterpartyCompanyId}/pdf-data?role=${this.data.role}`, filePath
      );
      wx.openDocument({
        filePath: result.filePath,
        fileType: 'pdf',
        showMenu: download,
        success: () => {
          if (download) wx.showToast({ title: 'PDF 已下载', icon: 'success' });
        },
        fail: () => wx.showToast({ title: 'PDF 打开失败', icon: 'none' })
      });
    } catch (error) {
      wx.showToast({ title: error.message || '对账 PDF 获取失败', icon: 'none' });
    } finally {
      wx.hideLoading();
    }
  }
});
