const { request } = require('../../utils/request');
const { formatDateTime } = require('../../utils/datetime');
const { runPrivacyAction } = require('../../utils/privacy');

const TYPE_META = {
  SALES_ORDER: {
    label: '销售单',
    empty: '暂无销售单模板',
    columns: ['序号', '品名', '规格', '单位', '数量', '单价', '金额', '备注'],
    blankRows: 8
  },
  RETURN_ORDER: {
    label: '退货单',
    empty: '暂无退货单模板',
    columns: ['序号', '品名', '规格', '单位', '数量', '单价', '金额', '退货原因'],
    blankRows: 8
  }
};

Page({
  data: {
    activeType: 'SALES_ORDER',
    templates: [],
    salesTemplates: [],
    returnTemplates: [],
    salesCount: 0,
    returnCount: 0,
    loading: false,
    saving: false,
    emptyText: TYPE_META.SALES_ORDER.empty,
    addType: '',
    addLabel: '',
    uploadGuideType: '',
    uploadGuideLabel: '',
    uploadExample: '',
    preview: null
  },

  onShow() {
    this.loadTemplates();
  },

  onPullDownRefresh() {
    this.loadTemplates().finally(() => wx.stopPullDownRefresh());
  },

  async loadTemplates() {
    if (this.data.loading) return;
    this.setData({ loading: true });
    try {
      const [sales, returns] = await Promise.all([
        request({ url: '/document-templates?type=SALES_ORDER' }),
        request({ url: '/document-templates?type=RETURN_ORDER' })
      ]);
      const decorate = (list, documentType) => (list || []).map(item => ({
        ...item,
        documentType: item.documentType || documentType,
        dateText: formatDateTime(item.updatedAt || item.createdAt),
        sourceText: item.sourceFileName || (item.name === `标准${TYPE_META[documentType].label}模板` ? '标准版式' : '自定义版式')
      }));
      const salesTemplates = decorate(sales, 'SALES_ORDER');
      const returnTemplates = decorate(returns, 'RETURN_ORDER');
      this.setData({
        salesTemplates,
        returnTemplates,
        templates: this.data.activeType === 'RETURN_ORDER' ? returnTemplates : salesTemplates,
        salesCount: salesTemplates.length,
        returnCount: returnTemplates.length,
        emptyText: TYPE_META[this.data.activeType].empty
      });
    } catch (error) {
      wx.showToast({ title: error.message || '模板加载失败', icon: 'none' });
    } finally {
      this.setData({ loading: false });
    }
  },

  uploadSalesTemplate() {
    this.showTemplateOptions('SALES_ORDER');
  },

  uploadReturnTemplate() {
    this.showTemplateOptions('RETURN_ORDER');
  },

  showTemplateOptions(documentType) {
    if (this.data.loading || this.data.saving) return;
    this.setData({ addType: documentType, addLabel: TYPE_META[documentType].label });
  },

  closeTemplateOptions() {
    this.setData({ addType: '' });
  },

  previewStandardOption() {
    this.restoreStandardTemplate(this.data.addType);
  },

  restoreActiveTemplate() {
    this.restoreStandardTemplate(this.data.activeType);
  },

  restoreStandardTemplate(documentType) {
    if (this.data.loading || this.data.saving) return;
    const meta = TYPE_META[documentType];
    if (!meta) return;
    this.openTemplatePreview({
      documentType,
      name: `标准${meta.label}模板`,
      sourceFileName: '',
      content: JSON.stringify({ columns: meta.columns, blankRows: meta.blankRows })
    }, 'standard');
  },

  standardTemplateExists(documentType) {
    const meta = TYPE_META[documentType];
    const templates = documentType === 'RETURN_ORDER' ? this.data.returnTemplates : this.data.salesTemplates;
    return templates.some(template => {
      try {
        const content = JSON.parse(template.content);
        return template.name === `标准${meta.label}模板`
          && JSON.stringify(content.columns) === JSON.stringify(meta.columns)
          && content.blankRows === meta.blankRows;
      } catch (error) {
        return false;
      }
    });
  },

  explainTemplateUpload() {
    const documentType = this.data.addType;
    const meta = TYPE_META[documentType];
    if (!meta) return;
    this.setData({
      addType: '',
      uploadGuideType: documentType,
      uploadGuideLabel: meta.label,
      uploadExample: JSON.stringify({ columns: meta.columns, blankRows: meta.blankRows }, null, 2)
    });
  },

  closeUploadGuide() {
    this.setData({ uploadGuideType: '' });
  },

  copyUploadExample() {
    wx.setClipboardData({ data: this.data.uploadExample });
  },

  shareUploadExample() {
    if (!wx.shareFileMessage) {
      wx.showToast({ title: '当前微信版本请使用复制示例', icon: 'none' });
      return;
    }
    const fileName = `${this.data.uploadGuideLabel}模板示例.json`;
    const filePath = `${wx.env.USER_DATA_PATH}/${fileName}`;
    wx.getFileSystemManager().writeFile({
      filePath,
      data: this.data.uploadExample,
      encoding: 'utf8',
      success: () => wx.shareFileMessage({
        filePath,
        fileName,
        fail: error => {
          if (!String(error && error.errMsg || '').includes('cancel')) {
            wx.showToast({ title: '示例发送失败，可复制示例', icon: 'none' });
          }
        }
      }),
      fail: () => wx.showToast({ title: '示例文件生成失败，可复制示例', icon: 'none' })
    });
  },

  chooseUploadFile() {
    if (this.data.uploadGuideType) this.chooseTemplateFile(this.data.uploadGuideType);
  },

  useStandardFromGuide() {
    this.restoreStandardTemplate(this.data.uploadGuideType);
  },

  previewTemplate(e) {
    const template = e.currentTarget.dataset.template;
    this.openTemplatePreview({ ...template, documentType: template.documentType || this.data.activeType }, 'existing');
  },

  openTemplatePreview(template, mode) {
    try {
      const parsed = JSON.parse(template.content);
      if (!parsed || !Array.isArray(parsed.columns) || parsed.columns.length === 0
          || parsed.columns.some(column => typeof column !== 'string' || !column.trim())) {
        throw new Error('invalid');
      }
      const blankRows = Math.max(8, Number(parsed.blankRows) || 8);
      const sampleValue = column => {
        if (column.includes('序号')) return '1';
        if (['品名', '名称', '产品', '商品'].some(key => column.includes(key))) return '示例商品';
        if (column.includes('规格') || column.includes('型号')) return '标准型';
        if (column.includes('数量')) return '2';
        if (column.includes('单价')) return '100.00';
        if (column.includes('金额')) return '200.00';
        if (column.includes('单位')) return '件';
        if (column.includes('原因')) return '示例退货原因';
        return '—';
      };
      this.setData({
        addType: '',
        uploadGuideType: '',
        preview: {
          ...template,
          mode,
          sourceText: template.sourceFileName || (template.name === `标准${TYPE_META[template.documentType].label}模板` ? '标准版式，无需上传文件' : '自定义表格版式'),
          label: TYPE_META[template.documentType].label,
          columns: parsed.columns,
          rows: Array.from({ length: Math.min(blankRows, 8) }, (_, index) => parsed.columns.map(column => index === 0 ? sampleValue(column) : '')),
          blankRows,
          tableWidth: Math.max(640, parsed.columns.length * 120),
          alreadyAdded: mode === 'standard' && this.standardTemplateExists(template.documentType)
        }
      });
    } catch (error) {
      wx.showModal({ title: '模板无法预览', content: '模板内容不完整，请重新导入有效的 JSON 模板，或使用标准模板。', showCancel: false });
    }
  },

  closeTemplatePreview() {
    if (!this.data.saving) this.setData({ preview: null });
  },

  onPreviewNameInput(e) {
    this.setData({ 'preview.name': e.detail.value });
  },

  async applyPreviewTemplate() {
    const preview = this.data.preview;
    if (!preview || preview.mode === 'existing' || this.data.saving) return;
    if (preview.mode === 'standard' && this.standardTemplateExists(preview.documentType)) {
      const templates = preview.documentType === 'RETURN_ORDER' ? this.data.returnTemplates : this.data.salesTemplates;
      this.setData({ activeType: preview.documentType, templates, emptyText: TYPE_META[preview.documentType].empty, preview: null });
      wx.showToast({ title: '标准模板已在列表中', icon: 'none' });
      return;
    }
    const name = String(preview.name || '').trim();
    if (!name) {
      wx.showToast({ title: '模板名称不能为空', icon: 'none' });
      return;
    }
    await this.saveTemplate({ documentType: preview.documentType, name, sourceFileName: preview.sourceFileName, content: preview.content }, preview.mode === 'standard');
  },

  switchType(e) {
    const type = e.currentTarget.dataset.type;
    if (!TYPE_META[type] || type === this.data.activeType) return;
    this.setData({
      activeType: type,
      templates: type === 'RETURN_ORDER' ? this.data.returnTemplates : this.data.salesTemplates,
      emptyText: TYPE_META[type].empty
    });
  },

  openContractTemplates() {
    wx.navigateTo({ url: '/pages/contract-template/contract-template' });
  },

  chooseTemplateFile(documentType) {
    return runPrivacyAction(() => wx.chooseMessageFile({
      count: 1,
      type: 'file',
      extension: ['json'],
      success: async result => {
        const file = result.tempFiles && result.tempFiles[0];
        if (!file) return;
        try {
          if (file.size > 256 * 1024) throw new Error('模板文件需小于 256 KB。请上传只包含表格列名和行数的 JSON 文件。');
          const content = await this.readTemplateContent(file.path, file.name);
          this.confirmUpload(documentType, file.name, content);
        } catch (error) {
          wx.showModal({ title: '模板文件无法使用', content: error.message, showCancel: false });
        }
      },
      fail: error => {
        if (error && error.errMsg && !error.errMsg.includes('cancel')) {
          wx.showToast({ title: '文件选择失败', icon: 'none' });
        }
      }
    }));
  },

  readTemplateContent(filePath, fileName) {
    if (!String(fileName || '').toLowerCase().endsWith('.json')) {
      return Promise.reject(new Error('请选择 JSON 模板文件。没有文件时，可返回使用标准模板。'));
    }
    return new Promise((resolve, reject) => {
      wx.getFileSystemManager().readFile({
        filePath,
        encoding: 'utf8',
        success: result => {
          try {
            const parsed = JSON.parse(result.data);
            if (!parsed || !Array.isArray(parsed.columns) || parsed.columns.length === 0
                || parsed.columns.some(column => typeof column !== 'string' || !column.trim())) {
              throw new Error('invalid');
            }
            if (parsed.columns.length > 20 || parsed.columns.some(column => column.length > 60)
                || (parsed.blankRows !== undefined && (!Number.isInteger(parsed.blankRows) || parsed.blankRows < 8 || parsed.blankRows > 50))) {
              reject(new Error('模板最多 20 列，每个列名最多 60 字；blankRows 需为 8 到 50 的整数。可复制格式示例后调整。'));
              return;
            }
            const unsupported = Object.keys(parsed).some(key => key !== 'columns' && key !== 'blankRows');
            if (unsupported) {
              reject(new Error('模板仅支持 columns（表格列名）和 blankRows（最少展示行数），不支持导入商品、图片或其他版式。请参考格式示例。'));
              return;
            }
            resolve(JSON.stringify({ columns: parsed.columns.map(column => column.trim()), blankRows: parsed.blankRows || 8 }));
          } catch (error) {
            reject(new Error('文件不是有效的单据模板，请联系模板提供者检查文件，或返回使用标准模板。'));
          }
        },
        fail: () => reject(new Error('无法读取模板文件，请重新选择，或返回使用标准模板。'))
      });
    });
  },

  confirmUpload(documentType, fileName, content) {
    const meta = TYPE_META[documentType];
    const baseName = String(fileName || `${meta.label}模板`)
      .replace(/\.[^.]+$/, '')
      .slice(0, 60);
    this.openTemplatePreview({ documentType, name: baseName, sourceFileName: fileName, content }, 'upload');
  },

  async saveTemplate(payload, isStandard = false) {
    if (this.data.saving) return;
    this.setData({ saving: true });
    try {
      wx.showLoading({ title: isStandard ? '添加中...' : '上传中...', mask: true });
      await request({ url: '/document-templates', method: 'POST', data: payload });
      this.setData({ activeType: payload.documentType, preview: null });
      await this.loadTemplates();
      wx.showToast({ title: isStandard ? '标准模板已添加' : '模板已上传', icon: 'success' });
    } catch (error) {
      wx.showToast({ title: error.message || (isStandard ? '模板添加失败' : '上传失败'), icon: 'none' });
    } finally {
      wx.hideLoading();
      this.setData({ saving: false });
    }
  },

  deleteTemplate(e) {
    if (this.data.loading || this.data.saving) return;
    const template = e.currentTarget.dataset.template;
    const documentType = template.documentType || this.data.activeType;
    const meta = TYPE_META[documentType];
    const templates = documentType === 'RETURN_ORDER' ? this.data.returnTemplates : this.data.salesTemplates;
    const lastTemplateNotice = templates.length === 1
      ? `\n这是最后一个${meta.label}模板。删除后需重新添加；可恢复标准版式，自定义内容无法恢复。`
      : '\n自定义内容删除后无法恢复。';
    wx.showModal({
      title: '删除单据模板',
      content: `确定删除“${template.name}”吗？${lastTemplateNotice}\n已生成的单据不受影响。`,
      confirmText: '确认删除',
      confirmColor: '#d94a4a',
      success: async result => {
        if (!result.confirm) return;
        try {
          await request({ url: `/document-templates/${template.id}/delete`, method: 'POST' });
          wx.showToast({ title: '已删除', icon: 'success' });
          this.loadTemplates();
        } catch (error) {
          wx.showToast({ title: error.message || '删除失败', icon: 'none' });
        }
      }
    });
  },

  noop() {}
});
