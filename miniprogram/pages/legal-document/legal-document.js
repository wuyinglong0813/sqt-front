const DOCUMENTS = {
  user: {
    title: '用户服务协议',
    subtitle: '服务边界、账号使用与企业协作规则',
    templateName: 'userAgreementContent'
  },
  privacy: {
    title: '隐私保护指引',
    subtitle: '了解商签通如何处理和保护个人信息',
    templateName: 'privacyContent'
  },
  collection: {
    title: '个人信息收集清单',
    subtitle: '按功能查看信息内容、用途与触发场景',
    templateName: 'collectionListContent'
  },
  sharing: {
    title: '第三方信息共享清单',
    subtitle: '查看受托服务、必要数据范围与触发场景',
    templateName: 'sharingListContent'
  }
};

Page({
  data: {
    title: DOCUMENTS.user.title,
    subtitle: DOCUMENTS.user.subtitle,
    templateName: DOCUMENTS.user.templateName
  },

  onLoad(query) {
    const document = DOCUMENTS[query.type] || DOCUMENTS.user;
    this.setData(document);
    wx.setNavigationBarTitle({ title: document.title });
  },

  openHelp() {
    wx.navigateTo({ url: '/pages/help-center/help-center' });
  }
});

module.exports = { DOCUMENTS };
