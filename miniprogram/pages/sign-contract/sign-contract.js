const {
  calcTableTotal,
  calcFeeTotal,
  findContractColumn,
  normalizeContractTable,
  numberToChineseCurrency,
  reorderClauses
} = require('../../utils/chineseCurrency');

const FEE_TYPE_OPTIONS = ['运费', '装卸费', '包装费', '服务费', '其他费用'];

function newClientRequestId() {
  return `contract-${Date.now()}-${Math.random().toString(16).slice(2, 14)}`;
}

function normalizeNumericText(value) {
  const text = String(value == null ? '' : value).trim();
  return /^0+\d/.test(text) ? text.replace(/^0+(?=\d)/, '') : text;
}

function contractTotalChanges(productTotal, feeItems) {
  const normalizedProductTotal = Math.round((parseFloat(productTotal) || 0) * 100) / 100;
  const feeTotal = calcFeeTotal(feeItems);
  const grandTotal = Math.round((normalizedProductTotal + feeTotal) * 100) / 100;
  return {
    productTotalAmount: String(normalizedProductTotal),
    feeTotalAmount: String(feeTotal),
    totalAmount: String(grandTotal),
    totalAmountCn: numberToChineseCurrency(grandTotal)
  };
}

Page({
  data: {
    counterpartyName: '',
    counterpartyCompanyId: '',
    myCompanyName: '',
    role: 'supplier',
    contractActionText: '发起销售合同',
    // 合同名称
    contractName: '',
    // 模板
    templates: [],
    templateIndex: -1,
    // 合同编号（签订时自动生成）
    contractNo: '',
    // 头部字段（供方/需方/日期/地点）
    fields: [],
    // 产品表格
    tableSection: null,
    tableRows: [],
    productColumnIndex: 0,
    quantityColumnIndex: 3,
    priceColumnIndex: 4,
    amountColumnIndex: 5,
    feeTypeOptions: FEE_TYPE_OPTIONS,
    feeItems: [],
    activeFeeTypeIndex: -1,
    productTotalAmount: '0',
    feeTotalAmount: '0',
    totalAmount: '0',
    totalAmountCn: '零元整',
    tableScrollLeft: 0,
    tableScrollbarVisible: false,
    tableScrollbarThumbWidth: 100,
    tableScrollbarThumbLeft: 0,
    // 条款
    clauses: [],
    // 是否已选择模板
    hasTemplate: false,
    clientRequestId: '',
    editMode: false,
    contractId: '',
    originalContractNo: '',
    inventoryProducts: [],
    productSuggestions: [],
    specificationSuggestions: [],
    suggestionRow: -1,
    submitting: false
  },

  async onLoad(options) {
    const name = decodeURIComponent(options.counterpartyName || '');
    const counterpartyCompanyId = decodeURIComponent(options.counterpartyCompanyId || '');
    const role = options.role === 'buyer' ? 'buyer' : 'supplier';
    const editMode = options.mode === 'edit' && !!options.contractId;
    const app = getApp();
    const companies = app.globalData.companies || [];
    const cid = (app.globalData.userInfo && app.globalData.userInfo.currentCompanyId) || '';
    const cur = companies.find(c => c.companyId === cid);
    this.setData({
      counterpartyName: name,
      counterpartyCompanyId,
      myCompanyName: (cur && cur.companyName) || '我的企业',
      role,
      contractActionText: role === 'supplier' ? '发起销售合同' : '发起采购合同',
      clientRequestId: newClientRequestId(),
      editMode,
      contractId: options.contractId || ''
    });
    await Promise.all([this.loadTemplates(), this.loadInventoryProducts()]);
    if (editMode) await this.loadExistingContract();
  },

  async loadTemplates() {
    const { request } = require('../../utils/request');
    try {
      const payload = await request({ url: '/contract-templates?page=1&size=100' });
      const list = Array.isArray(payload) ? payload : (payload.items || []);
      const templates = (list || []).map(t => ({ id: t.id, name: t.name, content: t.content }));
      this.setData({ templates });
      // 默认选中第一个模板
      if (!this.data.editMode && templates.length > 0) {
        this.selectTemplate(0);
      }
      return templates;
    } catch (e) {
      // 静默
      return [];
    }
  },

  async loadExistingContract() {
    const { request } = require('../../utils/request');
    try {
      const contract = await request({ url: `/contracts/${this.data.contractId}` });
      if (contract.perspective !== 'OUTGOING'
        || !['PENDING', 'REJECTED', 'CANCELLED'].includes(contract.status)) {
        throw new Error('当前合同不能修改');
      }
      let content;
      try {
        content = JSON.parse(contract.terms || '{}');
      } catch (error) {
        throw new Error('合同正文格式异常，无法修改');
      }
      const tableSection = (content.sections || []).find(section => section.type === 'table');
      const feeSection = (content.sections || []).find(section => section.type === 'fees');
      const clauses = reorderClauses((content.sections || []).filter(section => section.type === 'clause'));
      const normalizedTable = normalizeContractTable(
        tableSection && tableSection.columns,
        tableSection && tableSection.rows
      );
      const total = calcTableTotal(normalizedTable.rows, normalizedTable.columns);
      const feeItems = feeSection && Array.isArray(feeSection.items)
        ? feeSection.items.map(item => ({
          feeType: String(item.feeType || item.name || '运费'),
          amount: String(item.amount || '0'),
          remark: String(item.remark || '')
        }))
        : [];
      const feeTotal = calcFeeTotal(feeItems);
      const grandTotal = Math.round((total.totalAmount + feeTotal) * 100) / 100;
      let templateIndex = this.data.templates.findIndex(item => item.name === contract.templateName);
      if (templateIndex < 0) {
        const templates = this.data.templates.concat([{
          id: `contract-${contract.id}`,
          name: contract.templateName || '原合同模板',
          content: contract.terms
        }]);
        templateIndex = templates.length - 1;
        this.setData({ templates });
      }
      this.setData({
        counterpartyName: contract.viewerCounterpartyName || contract.counterpartyName || '',
        counterpartyCompanyId: String(contract.viewerCounterpartyCompanyId || contract.counterpartyCompanyId || ''),
        role: (contract.viewerDirection || contract.direction) === 'PURCHASE' ? 'buyer' : 'supplier',
        contractActionText: '保存修改并重新发起',
        contractName: contract.name || content.title || '',
        originalContractNo: contract.contractNo || '',
        templateIndex,
        fields: (content.fields || []).map(field => ({ ...field })),
        tableSection: tableSection ? {
          title: tableSection.title,
          columns: normalizedTable.columns
        } : null,
        tableRows: total.rows,
        ...this.tableColumnMetadata(normalizedTable.columns),
        feeItems,
        productTotalAmount: String(total.totalAmount),
        feeTotalAmount: String(feeTotal),
        totalAmount: String(grandTotal),
        totalAmountCn: numberToChineseCurrency(grandTotal),
        clauses: clauses.map(clause => ({ title: clause.title || '', content: clause.content || '' })),
        hasTemplate: true
      }, () => this.measureTableScrollbar());
      wx.setNavigationBarTitle({ title: '修改合同' });
    } catch (error) {
      wx.showToast({ title: error.message || '合同加载失败', icon: 'none' });
    }
  },

  selectTemplate(idx) {
    const tpl = this.data.templates[idx];
    if (!tpl) return;
    let content;
    try {
      content = JSON.parse(tpl.content || '{}');
    } catch (e) {
      wx.showToast({ title: '模板格式异常', icon: 'none' });
      return;
    }
    if (!content.fields && !content.sections) {
      wx.showToast({ title: '模板内容为空', icon: 'none' });
      return;
    }

    const myName = this.data.myCompanyName;
    const cpName = this.data.counterpartyName;
    const role = this.data.role;

    // 自动填充字段
    const fields = (content.fields || []).map(f => {
      let value = f.value || '';
      if (f.key === 'supplier') value = role === 'supplier' ? myName : cpName;
      else if (f.key === 'buyer') value = role === 'supplier' ? cpName : myName;
      else if (f.key === 'signDate') value = new Date().toISOString().slice(0, 10);
      return { ...f, value };
    });

    const tableSection = (content.sections || []).find(s => s.type === 'table');
    const rawClauses = (content.sections || []).filter(s => s.type === 'clause');
    const clauses = reorderClauses(rawClauses);
    const normalizedTable = normalizeContractTable(
      tableSection && tableSection.columns,
      tableSection && tableSection.rows
    );
    const result = calcTableTotal(normalizedTable.rows, normalizedTable.columns);

    this.setData({
      templateIndex: idx,
      contractName: this.data.contractName || (content.title || '购销合同'),
      fields,
      tableSection: tableSection ? { title: tableSection.title, columns: normalizedTable.columns } : null,
      tableRows: result.rows,
      ...this.tableColumnMetadata(normalizedTable.columns),
      feeItems: [],
      productTotalAmount: String(result.totalAmount),
      feeTotalAmount: '0',
      totalAmount: String(result.totalAmount),
      totalAmountCn: result.totalAmountCn,
      clauses: clauses.map(c => ({ title: c.title || '', content: c.content || '' })),
      hasTemplate: true
    }, () => this.measureTableScrollbar());
  },

  tableColumnMetadata(columns) {
    return {
      productColumnIndex: findContractColumn(columns, ['品名', '名称', '产品'], 0),
      quantityColumnIndex: findContractColumn(columns, ['数量'], 3),
      priceColumnIndex: findContractColumn(columns, ['单价'], 4),
      amountColumnIndex: findContractColumn(columns, ['金额'], 5)
    };
  },

  onContractNameInput(e) { this.setData({ contractName: e.detail.value }); },

  onTemplateChange(e) {
    const idx = parseInt(e.detail.value);
    if (idx >= 0) {
      this.selectTemplate(idx);
    }
  },

  // ======= 字段编辑 =======
  onFieldChange(e) {
    const index = e.currentTarget.dataset.index;
    this.setData({ [`fields[${index}].value`]: e.detail.value });
  },

  onDateFieldChange(e) {
    const index = e.currentTarget.dataset.index;
    this.setData({ [`fields[${index}].value`]: e.detail.value });
  },

  async loadInventoryProducts() {
    const { request } = require('../../utils/request');
    try {
      const products = await request({ url: '/inventory/products?limit=200' });
      this.setData({ inventoryProducts: products || [] });
    } catch (error) {
      this.setData({ inventoryProducts: [] });
    }
  },

  tableColumnIndex(kind) {
    const columns = (this.data.tableSection && this.data.tableSection.columns) || [];
    const aliases = {
      product: ['品名', '名称', '产品'],
      specification: ['规格', '型号'],
      unit: ['单位'],
      quantity: ['数量'],
      price: ['单价'],
      amount: ['金额']
    }[kind] || [];
    return columns.findIndex(column => aliases.some(alias => String(column || '').includes(alias)));
  },

  // ======= 产品表格编辑 =======
  onTableCellChange(e) {
    const { row, col } = e.currentTarget.dataset;
    const rowIndex = Number(row);
    const columnIndex = Number(col);
    const quantityIndex = this.tableColumnIndex('quantity');
    const priceIndex = this.tableColumnIndex('price');
    const amountIndex = this.tableColumnIndex('amount');
    const productIndex = this.tableColumnIndex('product');
    const specificationIndex = this.tableColumnIndex('specification');
    const value = columnIndex === quantityIndex || columnIndex === priceIndex
      ? normalizeNumericText(e.detail.value)
      : e.detail.value;
    const targetRow = (this.data.tableRows[rowIndex] || []).slice();
    targetRow[columnIndex] = value;
    this.data.tableRows[rowIndex] = targetRow;
    const changes = { [`tableRows[${rowIndex}][${columnIndex}]`]: value };
    if ((columnIndex === quantityIndex || columnIndex === priceIndex)
      && quantityIndex >= 0 && priceIndex >= 0 && amountIndex >= 0) {
      const amount = Math.round(((parseFloat(targetRow[quantityIndex]) || 0)
        * (parseFloat(targetRow[priceIndex]) || 0)) * 100) / 100;
      targetRow[amountIndex] = String(amount);
      changes[`tableRows[${rowIndex}][${amountIndex}]`] = String(amount);
      const productTotal = this.data.tableRows.reduce((sum, item) =>
        sum + (parseFloat((item || [])[amountIndex]) || 0), 0);
      Object.assign(changes, contractTotalChanges(productTotal, this.data.feeItems));
    }
    if (columnIndex === productIndex) {
      const keyword = String(value || '').trim().toLowerCase();
      const products = this.data.inventoryProducts || [];
      const seen = new Set();
      changes.suggestionRow = rowIndex;
      changes.productSuggestions = keyword ? products.filter(item => {
        const name = String(item.productName || '');
        if (!name.toLowerCase().includes(keyword) || seen.has(name)) return false;
        seen.add(name);
        return true;
      }).slice(0, 8) : [];
      changes.specificationSuggestions = [];
    } else if (columnIndex === specificationIndex) {
      const productName = String(targetRow[productIndex] || '').trim();
      const keyword = String(value || '').trim().toLowerCase();
      changes.suggestionRow = rowIndex;
      changes.productSuggestions = [];
      changes.specificationSuggestions = (this.data.inventoryProducts || [])
        .filter(item => item.productName === productName
          && (!keyword || String(item.specification || '').toLowerCase().includes(keyword)))
        .slice(0, 8);
    }
    this.setData(changes);
    return value;
  },

  selectInventoryProduct(e) {
    const rowIndex = Number(e.currentTarget.dataset.row);
    const productName = String(e.currentTarget.dataset.name || '');
    const products = (this.data.inventoryProducts || []).filter(item => item.productName === productName);
    if (!this.data.tableRows[rowIndex] || products.length === 0) return;
    const productIndex = this.tableColumnIndex('product');
    const specificationIndex = this.tableColumnIndex('specification');
    const unitIndex = this.tableColumnIndex('unit');
    const changes = {
      [`tableRows[${rowIndex}][${productIndex}]`]: productName,
      productSuggestions: [],
      specificationSuggestions: products.slice(0, 8),
      suggestionRow: rowIndex
    };
    this.data.tableRows[rowIndex][productIndex] = productName;
    if (products.length === 1) {
      const selected = products[0];
      if (specificationIndex >= 0) {
        this.data.tableRows[rowIndex][specificationIndex] = selected.specification || '';
        changes[`tableRows[${rowIndex}][${specificationIndex}]`] = selected.specification || '';
      }
      if (unitIndex >= 0) {
        this.data.tableRows[rowIndex][unitIndex] = selected.baseUnit || '';
        changes[`tableRows[${rowIndex}][${unitIndex}]`] = selected.baseUnit || '';
      }
      changes.specificationSuggestions = [];
    } else if (specificationIndex >= 0) {
      this.data.tableRows[rowIndex][specificationIndex] = '';
      changes[`tableRows[${rowIndex}][${specificationIndex}]`] = '';
    }
    this.setData(changes);
  },

  selectInventorySpecification(e) {
    const rowIndex = Number(e.currentTarget.dataset.row);
    const productId = String(e.currentTarget.dataset.id || '');
    const selected = (this.data.inventoryProducts || [])
      .find(item => String(item.id) === productId);
    if (!selected || !this.data.tableRows[rowIndex]) return;
    const productIndex = this.tableColumnIndex('product');
    const specificationIndex = this.tableColumnIndex('specification');
    const unitIndex = this.tableColumnIndex('unit');
    const changes = { productSuggestions: [], specificationSuggestions: [], suggestionRow: -1 };
    [
      [productIndex, selected.productName || ''],
      [specificationIndex, selected.specification || ''],
      [unitIndex, selected.baseUnit || '']
    ].forEach(([index, value]) => {
      if (index < 0) return;
      this.data.tableRows[rowIndex][index] = value;
      changes[`tableRows[${rowIndex}][${index}]`] = value;
    });
    this.setData(changes);
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
    const amountIndex = this.tableColumnIndex('amount');
    if (amountIndex >= 0) newRow[amountIndex] = '0';
    const rows = [...this.data.tableRows, newRow];
    this.recalcTable(rows);
  },

  deleteTableRow(e) {
    const index = e.currentTarget.dataset.index;
    if (this.data.tableRows.length <= 1) return;
    const rows = this.data.tableRows.filter((_, i) => i !== index);
    this.recalcTable(rows);
  },

  recalcTable(rows) {
    const columns = (this.data.tableSection && this.data.tableSection.columns) || [];
    const result = calcTableTotal(rows, columns);
    this.setData({
      tableRows: result.rows,
      ...contractTotalChanges(result.totalAmount, this.data.feeItems)
    });
  },

  addFeeItem() {
    const feeItems = this.data.feeItems.concat([{ feeType: '运费', amount: '0', remark: '' }]);
    this.setData({
      feeItems,
      activeFeeTypeIndex: feeItems.length - 1,
      ...contractTotalChanges(this.data.productTotalAmount, feeItems)
    });
  },

  toggleFeeTypeMenu(e) {
    const index = Number(e.currentTarget.dataset.index);
    this.setData({
      activeFeeTypeIndex: this.data.activeFeeTypeIndex === index ? -1 : index
    });
  },

  selectFeeType(e) {
    const index = Number(e.currentTarget.dataset.index);
    const feeType = String(e.currentTarget.dataset.type || '运费');
    if (!this.data.feeItems[index]) return;
    this.setData({
      [`feeItems[${index}].feeType`]: feeType,
      activeFeeTypeIndex: -1
    });
  },

  onFeeFieldInput(e) {
    const index = Number(e.currentTarget.dataset.index);
    const field = e.currentTarget.dataset.field;
    if (!this.data.feeItems[index] || !['amount', 'remark'].includes(field)) return;
    const value = field === 'amount' ? normalizeNumericText(e.detail.value) : e.detail.value;
    const feeItems = this.data.feeItems.map((item, itemIndex) => (
      itemIndex === index ? { ...item, [field]: value } : item
    ));
    this.setData({ feeItems, ...contractTotalChanges(this.data.productTotalAmount, feeItems) });
    return value;
  },

  deleteFeeItem(e) {
    const index = Number(e.currentTarget.dataset.index);
    const feeItems = this.data.feeItems.filter((_, itemIndex) => itemIndex !== index);
    this.setData({
      feeItems,
      activeFeeTypeIndex: -1,
      ...contractTotalChanges(this.data.productTotalAmount, feeItems)
    });
  },

  onProductCellBlur(e) {
    const rowIndex = Number(e.currentTarget.dataset.row);
    const value = String(e.detail.value || '').trim();
    if (!['运费', '装卸费', '包装费', '服务费'].includes(value)) return;
    wx.showModal({
      title: '检测到费用项目',
      content: `${value}不是库存商品，是否移动到“其他费用”？`,
      confirmText: '转为费用',
      success: result => {
        if (!result.confirm || !this.data.tableRows[rowIndex]) return;
        const amountIndex = this.tableColumnIndex('amount');
        const remarkIndex = ((this.data.tableSection && this.data.tableSection.columns) || [])
          .findIndex(column => String(column).includes('备注'));
        const row = this.data.tableRows[rowIndex];
        const feeItems = this.data.feeItems.concat([{
          feeType: value,
          amount: amountIndex >= 0 ? String(row[amountIndex] || '0') : '0',
          remark: remarkIndex >= 0 ? String(row[remarkIndex] || '') : ''
        }]);
        const rows = this.data.tableRows.length > 1
          ? this.data.tableRows.filter((_, index) => index !== rowIndex)
          : [new Array(((this.data.tableSection && this.data.tableSection.columns) || []).length).fill('')];
        const resultRows = calcTableTotal(rows,
          (this.data.tableSection && this.data.tableSection.columns) || []);
        this.setData({
          tableRows: resultRows.rows,
          feeItems,
          productSuggestions: [],
          ...contractTotalChanges(resultRows.totalAmount, feeItems)
        });
      }
    });
  },

  measureTableScrollbar() {
    setTimeout(() => {
      const query = wx.createSelectorQuery().in(this);
      query.select('.table-scroll').boundingClientRect();
      query.select('.table-wrap').boundingClientRect();
      query.select('.table-scrollbar').boundingClientRect();
      query.exec(result => {
        const viewport = result && result[0];
        const content = result && result[1];
        const track = result && result[2];
        if (!viewport || !content || !content.width) return;
        this.tableScrollMetrics = {
          viewportWidth: viewport.width,
          contentWidth: content.width,
          trackWidth: track ? track.width : viewport.width
        };
        this.tableScrollOffset = 0;
        const width = Math.min(100, Math.max(28, viewport.width / content.width * 100));
        this.setData({
          tableScrollbarVisible: content.width > viewport.width + 1,
          tableScrollbarThumbWidth: width,
          tableScrollbarThumbLeft: 0
        });
      });
    }, 30);
  },

  onTableScroll(e) {
    const metrics = this.tableScrollMetrics;
    if (!metrics || metrics.contentWidth <= metrics.viewportWidth) return;
    const scrollLeft = Number(e.detail.scrollLeft || 0);
    this.tableScrollOffset = scrollLeft;
    const maxScroll = metrics.contentWidth - metrics.viewportWidth;
    const maxLeft = 100 - this.data.tableScrollbarThumbWidth;
    const left = Math.max(0, Math.min(maxLeft,
      (scrollLeft / maxScroll) * maxLeft));
    this.setData({
      tableScrollLeft: scrollLeft,
      tableScrollbarThumbLeft: left
    });
  },

  onTableScrollbarTouchStart(e) {
    const touch = e.touches && e.touches[0];
    const metrics = this.tableScrollMetrics;
    if (!touch || !metrics || metrics.contentWidth <= metrics.viewportWidth) return;
    this.tableScrollbarDrag = {
      startX: Number(touch.clientX == null ? touch.pageX : touch.clientX),
      startScrollLeft: Number(this.tableScrollOffset || 0)
    };
  },

  onTableScrollbarTouchMove(e) {
    const touch = e.touches && e.touches[0];
    const drag = this.tableScrollbarDrag;
    const metrics = this.tableScrollMetrics;
    if (!touch || !drag || !metrics) return;
    const currentX = Number(touch.clientX == null ? touch.pageX : touch.clientX);
    const maxScroll = metrics.contentWidth - metrics.viewportWidth;
    const thumbRatio = this.data.tableScrollbarThumbWidth / 100;
    const trackTravel = Math.max(1, metrics.trackWidth * (1 - thumbRatio));
    const scrollLeft = Math.max(0, Math.min(maxScroll,
      drag.startScrollLeft + (currentX - drag.startX) / trackTravel * maxScroll));
    const maxLeft = 100 - this.data.tableScrollbarThumbWidth;
    this.tableScrollOffset = scrollLeft;
    this.setData({
      tableScrollLeft: scrollLeft,
      tableScrollbarThumbLeft: maxScroll > 0 ? scrollLeft / maxScroll * maxLeft : 0
    });
  },

  onTableScrollbarTouchEnd() {
    this.tableScrollbarDrag = null;
  },

  onClauseTitleInput(e) {
    const index = Number(e.currentTarget.dataset.index);
    this.setData({ [`clauses[${index}].title`]: e.detail.value });
  },

  onClauseContentInput(e) {
    const index = Number(e.currentTarget.dataset.index);
    this.setData({ [`clauses[${index}].content`]: e.detail.value });
  },

  addClause() {
    this.setData({ clauses: this.data.clauses.concat([{ title: '', content: '' }]) });
  },

  deleteClause(e) {
    const index = Number(e.currentTarget.dataset.index);
    this.setData({ clauses: this.data.clauses.filter((_, itemIndex) => itemIndex !== index) });
  },

  // ======= 提交 =======
  async onSubmit() {
    const { templates, templateIndex, contractName, fields, tableSection, tableRows, feeItems,
      productTotalAmount, feeTotalAmount, totalAmount, clauses,
      counterpartyName, counterpartyCompanyId, role, clientRequestId, editMode, contractId,
      submitting } = this.data;
    if (submitting) return;
    if (templateIndex < 0) { wx.showToast({ title: '请选择合同模板', icon: 'none' }); return; }
    if (!contractName.trim()) { wx.showToast({ title: '请输入合同名称', icon: 'none' }); return; }

    const total = parseFloat(totalAmount) || 0;
    // 构建完整合同 JSON 存入 terms
    const contractContent = JSON.stringify({
      title: contractName.trim(),
      fields: fields.map(f => ({ ...f })),
      sections: [
        ...(tableSection ? [{
          title: tableSection.title,
          type: 'table',
          columns: [...tableSection.columns],
          rows: tableRows.map(row => tableSection.columns.map((column, index) => {
            const value = row[index];
            return value == null ? '' : String(value);
          })),
          summary: {
            totalAmount: productTotalAmount,
            totalAmountCn: numberToChineseCurrency(parseFloat(productTotalAmount) || 0)
          }
        }] : []),
        ...(feeItems.length > 0 ? [{
          title: '其他费用',
          type: 'fees',
          items: feeItems.map(item => ({
            feeType: String(item.feeType || '其他费用'),
            amount: String(item.amount || '0'),
            remark: String(item.remark || '')
          })),
          summary: { totalAmount: feeTotalAmount }
        }] : []),
        ...clauses.map(c => ({ title: c.title, type: 'clause', content: c.content }))
      ]
    });

    const res = await new Promise(r => {
      wx.showModal({
        title: editMode ? '确认重新发起' : '确认签订',
        content: `即将与 ${counterpartyName} ${editMode ? '重新发起' : '签订'}合同\n金额：¥${totalAmount}\n模板：${templates[templateIndex].name}\n\n提交后由双方依次完成电子签署，全部签完后生效`,
        success: r
      });
    });
    if (!res.confirm) return;

    const { request } = require('../../utils/request');
    try {
      this.setData({ submitting: true });
      wx.showLoading({ title: editMode ? '提交中...' : '发起中...' });
      const result = await request({
        url: editMode ? `/contracts/${contractId}/resubmit` : '/contracts',
        method: 'POST',
        data: {
          counterpartyName,
          counterpartyCompanyId: String(counterpartyCompanyId),
          direction: role === 'supplier' ? 'SALE' : 'PURCHASE',
          clientRequestId,
          name: contractName.trim(),
          templateName: templates[templateIndex].name,
          amount: total,
          startDate: (fields.find(f => f.key === 'signDate') || {}).value || null,
          endDate: null,
          terms: contractContent
        }
      });
      const resultContractId = String(result.id);
      wx.showToast({
        title: editMode ? '合同已更新，请继续签署' : '合同已发起，请继续签署',
        icon: 'success', duration: 1500
      });
      // 签订成功后跳转到合同预览页查看完整合同
      setTimeout(() => {
        wx.redirectTo({
          url: `/pages/contract-preview/contract-preview?contractId=${resultContractId}&contractName=${encodeURIComponent(contractName.trim())}&counterpartyName=${encodeURIComponent(counterpartyName)}`
        });
      }, 1500);
    } catch (e) {
      wx.showToast({ title: e.message, icon: 'none' });
    } finally {
      wx.hideLoading();
      this.setData({ submitting: false });
    }
  }
});
