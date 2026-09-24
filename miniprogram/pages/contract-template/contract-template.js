const { request } = require('../../utils/request');
const { DEFAULT_TEMPLATE } = require('../../utils/chineseCurrency');

Page({
  data: {
    templates: [],
    keyword: '',
    activeCategory: 'all',
    categories: [],
    loading: false,
    page: 1,
    size: 20,
    hasMore: false,
    // 分类管理弹窗
    showCatModal: false,
    newCatName: '',
    // 模板创建弹窗
    showAdd: false,
    newName: '',
    newCategory: ''
  },

  onShow() {
    this.loadTemplates(true);
    this.loadCategories();
  },

  onReachBottom() {
    if (this.data.hasMore && !this.data.loading) this.loadTemplates(false);
  },

  async loadCategories() {
    try {
      const list = await request({ url: '/contract-template-categories' });
      this.setData({ categories: (list || []).map(c => c.name) });
    } catch (e) { /* 静默 */ }
  },

  async loadTemplates(reset = true) {
    if (this.data.loading) return;
    this.setData({ loading: true });
    try {
      const { keyword, activeCategory } = this.data;
      const page = reset ? 1 : this.data.page + 1;
      let url = `/contract-templates?page=${page}&size=${this.data.size}&`;
      if (keyword) url += `keyword=${encodeURIComponent(keyword)}&`;
      if (activeCategory !== 'all') url += `category=${encodeURIComponent(activeCategory)}&`;
      const payload = await request({ url });
      const list = Array.isArray(payload) ? payload : (payload.items || []);
      const templates = (list || []).map(t => ({
        id: String(t.id),
        name: t.name,
        category: t.category || '通用',
        createdBy: t.createdByName || '',
        updatedAt: String(t.updatedAt || t.createdAt || '').substring(0, 10)
      }));
      this.setData({
        templates: reset ? templates : this.data.templates.concat(templates),
        page,
        hasMore: !!payload.hasMore
      });
    } catch (e) {
      wx.showToast({ title: e.message || '模板加载失败', icon: 'none' });
    } finally {
      this.setData({ loading: false });
    }
  },

  onSearchInput(e) { this.setData({ keyword: e.detail.value }); },

  onSearch() { this.loadTemplates(true); },

  clearSearch() { this.setData({ keyword: '' }); this.loadTemplates(true); },

  filterCategory(e) {
    const cat = e.currentTarget.dataset.cat;
    if (cat === this.data.activeCategory) return;
    this.setData({ activeCategory: cat });
    this.loadTemplates(true);
  },

  /* 分类管理 */
  showCatManager() { this.setData({ showCatModal: true, newCatName: '' }); },
  hideCatModal() { this.setData({ showCatModal: false }); },
  onCatNameInput(e) { this.setData({ newCatName: e.detail.value }); },

  async addCategory() {
    const name = this.data.newCatName.trim();
    if (!name) { wx.showToast({ title: '请输入分类名', icon: 'none' }); return; }
    try {
      await request({ url: '/contract-template-categories', method: 'POST', data: { name } });
      wx.showToast({ title: '已添加', icon: 'success' });
      this.loadCategories();
      this.setData({ newCatName: '' });
    } catch (e) { wx.showToast({ title: e.message, icon: 'none' }); }
  },

  async delCategory(e) {
    const cat = e.currentTarget.dataset.cat;
    // 通过名称找到ID
    const list = await request({ url: '/contract-template-categories' });
    const found = (list || []).find(c => c.name === cat);
    if (!found) return;
    const res = await new Promise(r => wx.showModal({ title: '删除分类', content: `确定删除"${cat}"？`, success: r }));
    if (!res.confirm) return;
    try {
      await request({ url: `/contract-template-categories/${found.id}/delete`, method: 'POST' });
      wx.showToast({ title: '已删除', icon: 'success' });
      if (this.data.activeCategory === cat) this.setData({ activeCategory: 'all' });
      this.loadCategories();
      this.loadTemplates(true);
    } catch (e) { wx.showToast({ title: e.message, icon: 'none' }); }
  },

  /* 点击模板 → 进入详情编辑页 */
  onTemplateTap(e) {
    const tpl = e.currentTarget.dataset.template;
    wx.navigateTo({
      url: `/pages/contract-template-detail/contract-template-detail?id=${tpl.id}&name=${encodeURIComponent(tpl.name)}`
    });
  },

  showAddForm() {
    // 直接跳转到编辑页新建，跳过弹窗
    wx.navigateTo({
      url: '/pages/contract-template-detail/contract-template-detail'
    });
  },
  onCategoryTap(e) {
    this.setData({ newCategory: e.currentTarget.dataset.cat });
  },
  noop() {}
});
