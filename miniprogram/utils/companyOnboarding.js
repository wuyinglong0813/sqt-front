const { USER_ID_KEY } = require('./homeSnapshot');
const { request } = require('./request');

function draftKey() {
  const app = getApp();
  const userId = (app.globalData.userInfo && app.globalData.userInfo.id) || wx.getStorageSync(USER_ID_KEY);
  return userId ? `tradepass_company_draft_${userId}` : '';
}

function readDraft() {
  const key = draftKey();
  const draft = key && wx.getStorageSync(key);
  return draft && typeof draft === 'object' && draft.companyName && draft.creditCode ? draft : null;
}

function saveDraft(data) {
  const key = draftKey();
  if (key) wx.setStorageSync(key, {
    companyName: data.companyName, creditCode: data.creditCode,
    legalPersonName: data.legalPersonName, agreed: !!data.agreed,
    companyId: data.companyId ? String(data.companyId) : ''
  });
}

function clearDraft(creditCode) {
  const draft = readDraft();
  if (draft && draft.creditCode === creditCode) wx.removeStorageSync(draftKey());
}

function returnToCompany(options = {}) {
  const pages = getCurrentPages();
  for (let i = pages.length - 2; i >= 0; i--) {
    if (pages[i].route === 'pages/company-cert/company-cert') {
      wx.navigateBack({ delta: pages.length - 1 - i });
      return;
    }
  }
  const query = options.companyId
    ? `companyId=${encodeURIComponent(options.companyId)}&autoSwitch=1`
    : 'resume=1';
  wx.redirectTo({ url: `/pages/company-cert/company-cert?${query}` });
}

async function loadSummary() {
  const draft = readDraft();
  try {
    const companies = await request({ url: '/me/company-onboarding', withCompany: false });
    return { hasOnboarding: !!(draft || (companies && companies.length)),
      onboardingName: companies && companies.length ? companies[0].name : (draft && draft.companyName) || '',
      onboardingStatus: companies && companies.length ? '企业认证待完成' : '企业创建待完成' };
  } catch (error) {
    return { hasOnboarding: true, onboardingName: draft ? draft.companyName : '',
      onboardingStatus: draft ? '企业创建待完成' : '企业认证状态待确认' };
  }
}

module.exports = { readDraft, saveDraft, clearDraft, returnToCompany, loadSummary };
