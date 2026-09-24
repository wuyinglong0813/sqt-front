const FAQS = [
  {
    category: '账号与企业',
    question: '如何创建或加入企业？',
    answer: '进入“企业”页，可以创建企业；如果已有企业邀请码，在首页输入邀请码申请加入。加入后需要根据企业设置完成成员确认或授权。'
  },
  {
    category: '账号与企业',
    question: '为什么个人认证完成后仍显示待认证？',
    answer: '请在“设置—账号与个人信息”中刷新认证结果。如果第三方认证刚完成，结果同步可能需要短暂时间；仍未更新时，请将认证时间和页面截图发给平台支持。'
  },
  {
    category: '合同签署',
    question: '合同签署完成后在哪里查看真实电子章？',
    answer: '进入合同详情的“合同”页签，打开真实签署归档文件。电子章以签署服务商生成并归档的 PDF 为准，页面不会使用模拟印章替代。'
  },
  {
    category: '合同签署',
    question: '合同为什么暂时不能继续签署？',
    answer: '请依次确认个人认证、企业认证、电子签账号、合同相对方和签署顺序是否完成。待审批或已作废的合同也不能继续签署。'
  },
  {
    category: '履约资料',
    question: '发票、物流单和其它资料如何查看？',
    answer: '进入合同详情的“履约资料”页签，找到对应分类后点击“查看”或“下载”。较大的 PDF 首次打开需要下载，完成后会优先复用本地文件。'
  },
  {
    category: '审批与对账',
    question: '为什么资料上传后没有进入对账？',
    answer: '部分资料需要合同对方确认。请在审批中心查看待处理状态；发票、转款凭证等通过后，才会按照业务规则计入对账。'
  }
];

Page({
  data: {
    activeCategory: '全部',
    categories: ['全部', '账号与企业', '合同签署', '履约资料', '审批与对账'],
    faqs: FAQS.map((item, index) => ({ ...item, id: index, open: index === 0 }))
  },

  selectCategory(e) {
    const activeCategory = e.currentTarget.dataset.category;
    const faqs = FAQS
      .map((item, index) => ({ ...item, id: index, open: false }))
      .filter(item => activeCategory === '全部' || item.category === activeCategory);
    this.setData({ activeCategory, faqs });
  },

  toggleFaq(e) {
    const index = Number(e.currentTarget.dataset.index);
    this.setData({
      faqs: this.data.faqs.map((item, current) => ({
        ...item,
        open: current === index ? !item.open : false
      }))
    });
  },

  goCompany() {
    wx.switchTab({ url: '/pages/company/company' });
  },

  goContracts() {
    wx.navigateTo({ url: '/pages/contract-center/contract-center' });
  },

  goApprovals() {
    wx.navigateTo({ url: '/pages/contract-approval/contract-approval' });
  }
});

module.exports = { FAQS };
