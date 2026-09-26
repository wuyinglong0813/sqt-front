const { request } = require('./request');

function getLoginCode() {
  return new Promise((resolve, reject) => {
    wx.login({
      success: result => {
        if (result && result.code) resolve(result.code);
        else reject(new Error('未获取到微信登录凭证，请重试'));
      },
      fail: result => {
        const error = new Error((result && result.errMsg) || '微信登录失败，请重试');
        error.errCode = result && result.errCode;
        reject(error);
      }
    });
  });
}

async function wechatLogin(payload = {}) {
  // 自建服务器需要 wx.login 的 code；手机号授权的 phoneCode 是另一份凭证。
  // 只有显式启用的本地开发环境才能沿用模拟 code。
  let code;
  try {
    code = getApp().globalData.isLocalDevelopment && payload.code
      ? payload.code : await getLoginCode();
  } catch (error) {
    error.loginStage = '微信登录';
    throw error;
  }
  return request({
    url: '/auth/wechat-login',
    method: 'POST',
    data: { ...payload, code },
    auth: false,
    // A rejected login must stay on the login page and show its actual reason.
    handleUnauthorized: false,
    withCompany: false
  }).catch(error => {
    error.loginStage = '服务器登录';
    throw error;
  });
}

module.exports = { wechatLogin };
