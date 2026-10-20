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
    emptyText: TYPE_META.SALES_ORDER.empty
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
      const decorate = list => (list || []).map(item => ({
        ...item,
        dateText: formatDateTime(item.updatedAt || item.createdAt),
        sourceText: item.sourceFileName || '标准版式'
      }));
      const salesTemplates = decorate(sales);
      const returnTemplates = decorate(returns);
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
    const meta = TYPE_META[documentType];
    wx.showActionSheet({
      itemList: [`使用标准${meta.label}模板（推荐）`, '上传自定义模板文件'],
      success: result => {
        if (result.tapIndex === 0) this.restoreStandardTemplate(documentType);
        if (result.tapIndex === 1) this.explainTemplateUpload(documentType);
      }
    });
  },

  restoreActiveTemplate() {
    this.restoreStandardTemplate(this.data.activeType);
  },

  restoreStandardTemplate(documentType) {
    if (this.data.loading || this.data.saving) return;
    const meta = TYPE_META[documentType];
    const templates = documentType === 'RETURN_ORDER' ? this.data.returnTemplates : this.data.salesTemplates;
    const standardContent = JSON.stringify({ columns: meta.columns, blankRows: meta.blankRows });
    const standardExists = templates.some(template => {
      try {
        const content = JSON.parse(template.content);
        return template.name === `标准${meta.label}模板`
          && JSON.stringify(content.columns) === JSON.stringify(meta.columns)
          && content.blankRows === meta.blankRows;
      } catch (error) {
        return false;
      }
    });
    if (standardExists) {
      this.setData({ activeType: documentType, templates, emptyText: meta.empty });
      wx.showToast({ title: '标准模板已在列表中', icon: 'none' });
      return;
    }
    wx.showModal({
      title: `使用标准${meta.label}模板`,
      content: `无需准备或上传文件，即可添加标准版式。\n包含：${meta.columns.join('、')}。创建单据时会自动带入合同产品，提交前可修改。`,
      confirmText: '使用模板',
      success: result => {
        if (result.confirm) this.saveTemplate({
          documentType,
          name: `标准${meta.label}模板`,
          sourceFileName: '',
          content: standardContent
        }, true);
      }
    });
  },

  explainTemplateUpload(documentType) {
    wx.showModal({
      title: '上传自定义模板',
      content: '仅支持商签通 JSON 模板文件，不能上传 Word、PDF、Excel 或单据照片。\n请先将已有模板文件发送到微信聊天，下一步从聊天中选择。没有模板文件时，取消后选择“使用标准模板”即可。',
      confirmText: '选择文件',
      success: result => {
        if (result.confirm) this.chooseTemplateFile(documentType);
      }
    });
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
            resolve(JSON.stringify(parsed));
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
    wx.showModal({
      title: `上传${meta.label}模板`,
      editable: true,
      placeholderText: '请输入模板名称',
      content: baseName,
      success: async result => {
        if (!result.confirm) return;
        const name = String(result.content || baseName).trim();
        if (!name) {
          wx.showToast({ title: '模板名称不能为空', icon: 'none' });
          return;
        }
        await this.saveTemplate({ documentType, name, sourceFileName: fileName, content });
      }
    });
  },

  async saveTemplate(payload, isStandard = false) {
    if (this.data.saving) return;
    this.setData({ saving: true });
    try {
      wx.showLoading({ title: isStandard ? '添加中...' : '上传中...', mask: true });
      await request({ url: '/document-templates', method: 'POST', data: payload });
      this.setData({ activeType: payload.documentType });
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
