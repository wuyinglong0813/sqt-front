let redirecting = false;
const { USER_ID_KEY, clearHomeSnapshots } = require('./homeSnapshot');

function currentApp() {
  return getApp();
}

function clearSession(app) {
  clearHomeSnapshots();
  app._companyAccessGeneration = (app._companyAccessGeneration || 0) + 1;
  app.globalData.token = '';
  app.globalData.currentCompanyId = '';
  app.globalData.userInfo = null;
  app.globalData.memberInfo = null;
  app.globalData.companies = [];
  wx.removeStorageSync('tradepass_token');
  wx.removeStorageSync('tradepass_company_id');
  wx.removeStorageSync(USER_ID_KEY);
}

function request(options) {
  return new Promise((resolve, reject) => {
    const app = currentApp();
    const header = {
      'content-type': 'application/json',
      ...(options.header || {})
    };
    const token = options.token !== undefined
      ? options.token
      : (app.globalData.token || wx.getStorageSync('tradepass_token') || '');
    if (options.auth !== false && token) header.Authorization = token;

    const companyId = options.companyId !== undefined
      ? (options.companyId ? String(options.companyId) : '')
      : (app.globalData.currentCompanyId || '');
    if (options.withCompany !== false && companyId) header['X-Company-Id'] = companyId;

    const callbacks = {
      method: options.method || 'GET',
      data: options.data || {},
      header,
      timeout: options.timeout || 15000,
      success: ({ statusCode, data }) => {
        if (statusCode === 401 || (data && data.code === 401)) {
          if (options.handleUnauthorized !== false && token === app.globalData.token) handleUnauthorized(app);
          reject(new Error('登录已失效'));
          return;
        }
        if (statusCode >= 200 && statusCode < 300 && data && data.code === 0) {
          resolve(data.data);
          return;
        }
        const error = new Error((data && data.message) || `请求失败（${statusCode || '未知状态'}）`);
        error.statusCode = statusCode;
        error.code = data && data.code;
        if ((statusCode === 403 || error.code === 403) && options.withCompany !== false
          && options.handleCompanyForbidden !== false && companyId
          && token === app.globalData.token && typeof app.handleCompanyAccessLost === 'function') {
          app.handleCompanyAccessLost(companyId);
        }
        reject(error);
      },
      fail: error => reject(new Error((error && error.errMsg) || (error && error.message) || '网络请求失败'))
    };

    wx.request({
      ...callbacks,
      url: `${app.globalData.baseUrl}${options.url}`
    });
  });
}

function handleUnauthorized(app) {
  clearSession(app);
  if (redirecting) return;
  redirecting = true;
  wx.reLaunch({
    url: '/pages/index/index',
    complete: () => { setTimeout(() => { redirecting = false; }, 1000); }
  });
}

module.exports = {
  request,
  clearSession
};
