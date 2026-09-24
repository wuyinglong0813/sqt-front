const { request } = require('../../utils/request');
const {
  DEFAULT_TEMPLATE,
  calcTableTotal,
  findContractColumn,
  normalizeContractTable,
  reorderClauses,
  toChineseNum
} = require('../../utils/chineseCurrency');

function normalizeNumericText(value) {
  const text = String(value == null ? '' : value).trim();
  return /^0+\d/.test(text) ? text.replace(/^0+(?=\d)/, '') : text;
}

Page({
  data: {
    templateId: '',
    name: '',
    category: '',
    categories: ['采购', '供货', '交易', '物流', '服务', '其他'],
    title: '',
    fields: [],
    tableSection: null,
    tableRows: [],
    quantityColumnIndex: 3,
    priceColumnIndex: 4,
    amountColumnIndex: 5,
    totalAmount: '0',
    totalAmountCn: '零元整',
    clauses: [],
    showDelete: false
  },

  onLoad(options) {
    const id = options.id || '';
    const name = decodeURIComponent(options.name || '');
    this.setData({ templateId: id, name });
    if (id) {
      this.loadTemplate();
    } else {
      this.initFromTemplate(DEFAULT_TEMPLATE);
    }
  },

  async loadTemplate() {
    try {
      const tpl = await request({ url: `/contract-templates/${this.data.templateId}` });
      this.setData({ name: tpl.name || '', category: tpl.category || '' });
      let content;
      try { content = JSON.parse(tpl.content || '{}'); } catch (e) { content = DEFAULT_TEMPLATE; }
      if (!content.fields && !content.sections) { content = DEFAULT_TEMPLATE; }
      this.initFromTemplate(content);
    } catch (e) { wx.showToast({ title: e.message, icon: 'none' }); }
  },

  initFromTemplate(tpl) {
    const tableSection = (tpl.sections || []).find(s => s.type === 'table');
    const rawClauses = (tpl.sections || []).filter(s => s.type === 'clause');
    const normalizedTable = normalizeContractTable(
      tableSection && tableSection.columns,
      tableSection && tableSection.rows
    );
    const result = calcTableTotal(normalizedTable.rows, normalizedTable.columns);
    const clauses = reorderClauses(rawClauses);

    this.setData({
      title: tpl.title || '购销合同',
      fields: (tpl.fields || []).map(f => ({ ...f })),
      tableSection: tableSection ? { title: tableSection.title, columns: normalizedTable.columns } : null,
      tableRows: result.rows,
      quantityColumnIndex: findContractColumn(normalizedTable.columns, ['数量'], 3),
      priceColumnIndex: findContractColumn(normalizedTable.columns, ['单价'], 4),
      amountColumnIndex: findContractColumn(normalizedTable.columns, ['金额'], 5),
      totalAmount: String(result.totalAmount),
      totalAmountCn: result.totalAmountCn,
      clauses
    });
  },

  onNameInput(e) { this.setData({ name: e.detail.value }); },
  onCategoryTap(e) { this.setData({ category: e.currentTarget.dataset.cat }); },

  onFieldChange(e) {
    const index = e.currentTarget.dataset.index;
    this.setData({ [`fields[${index}].value`]: e.detail.value });
  },
  onDateFieldChange(e) {
    const index = e.currentTarget.dataset.index;
    this.setData({ [`fields[${index}].value`]: e.detail.value });
  },

  // ======= 产品表格 =======
  onTableCellChange(e) {
    const { row, col } = e.currentTarget.dataset;
    const rows = [...this.data.tableRows];
    if (!rows[row]) rows[row] = [];
    const value = Number(col) === this.data.quantityColumnIndex || Number(col) === this.data.priceColumnIndex
      ? normalizeNumericText(e.detail.value)
      : e.detail.value;
    rows[row][col] = value;
    this.recalcTable(rows);
    return value;
  },

  onNumberCellFocus(e) {
    const { row, col } = e.currentTarget.dataset;
    const value = String((this.data.tableRows[row] || [])[col] || '').trim();
    if (/^0(?:\.0*)?$/.test(value)) {
      this.setData({ [`tableRows[${row}][${col}]`]: '' });
    }
  },

  onNumberCellBlur(e) {
    const { row, col } = e.currentTarget.dataset;
    if (String(e.detail.value || '').trim()) return;
    const rows = [...this.data.tableRows];
    if (!rows[row]) rows[row] = [];
    rows[row][col] = '0';
    this.recalcTable(rows);
  },

  addTableRow() {
    const cols = this.data.tableSection ? this.data.tableSection.columns.length : 7;
    const newRow = new Array(cols).fill('');
    newRow[this.data.quantityColumnIndex] = '0';
    newRow[this.data.priceColumnIndex] = '0';
    newRow[this.data.amountColumnIndex] = '0';
    this.recalcTable([...this.data.tableRows, newRow]);
  },

  deleteTableRow(e) {
    const index = e.currentTarget.dataset.index;
    if (this.data.tableRows.length <= 1) return;
    this.recalcTable(this.data.tableRows.filter((_, i) => i !== index));
  },

  recalcTable(rows) {
    const result = calcTableTotal(rows, (this.data.tableSection && this.data.tableSection.columns) || []);
    this.setData({ tableRows: result.rows, totalAmount: String(result.totalAmount), totalAmountCn: result.totalAmountCn });
  },

  // ======= 条款 =======
  onClauseTitleChange(e) {
    const index = e.currentTarget.dataset.index;
    this.setData({ [`clauses[${index}].title`]: e.detail.value });
  },

  onClauseContentChange(e) {
    const index = e.currentTarget.dataset.index;
    this.setData({ [`clauses[${index}].content`]: e.detail.value });
  },

  addClause() {
    const nextNum = this.data.clauses.length + 2;
    const clauses = reorderClauses([...this.data.clauses, { title: '', content: '' }]);
    this.setData({ clauses });
  },

  deleteClause(e) {
    const index = e.currentTarget.dataset.index;
    const filtered = this.data.clauses.filter((_, i) => i !== index);
    this.setData({ clauses: reorderClauses(filtered) });
  },

  // ======= 保存 =======
  async save() {
    const { templateId, name, category, title, fields, tableSection, tableRows, clauses } = this.data;
    if (!name.trim()) { wx.showToast({ title: '请输入模板名称', icon: 'none' }); return; }

    const numericColumns = [this.data.quantityColumnIndex, this.data.priceColumnIndex, this.data.amountColumnIndex];
    const saveRows = tableRows.map(r => r.map((value, index) => value || (numericColumns.includes(index) ? '0' : '')));

    const content = JSON.stringify({
      title: title || name,
      fields: fields.map(f => ({ ...f })),
      sections: [
        ...(tableSection ? [{ title: tableSection.title, type: 'table', columns: [...tableSection.columns], rows: saveRows }] : []),
        ...clauses.map(c => ({ title: c.title, type: 'clause', content: c.content }))
      ]
    });

    try {
      wx.showLoading({ title: '保存中...' });
      if (templateId) {
        await request({ url: `/contract-templates/${templateId}`, method: 'POST', data: { name: name.trim(), category, content } });
      } else {
        const result = await request({ url: '/contract-templates', method: 'POST', data: { name: name.trim(), category, content } });
        this.setData({ templateId: String(result.id) });
      }
      wx.hideLoading();
      wx.showToast({ title: '已保存', icon: 'success' });
      setTimeout(() => wx.navigateBack(), 1000);
    } catch (e) {
      wx.hideLoading();
      wx.showToast({ title: e.message, icon: 'none' });
    }
  },

  async deleteTemplate() {
    if (!this.data.templateId) { wx.navigateBack(); return; }
    const res = await new Promise(r => {
      wx.showModal({ title: '确认删除', content: `确定删除模板"${this.data.name}"？删除后不可恢复`, success: r });
    });
    if (!res.confirm) return;
    try {
      wx.showLoading({ title: '删除中...' });
      await request({ url: `/contract-templates/${this.data.templateId}/delete`, method: 'POST' });
      wx.hideLoading();
      wx.showToast({ title: '已删除', icon: 'success' });
      setTimeout(() => wx.navigateBack(), 1000);
    } catch (e) {
      wx.hideLoading();
      wx.showToast({ title: e.message, icon: 'none' });
    }
  }
});
