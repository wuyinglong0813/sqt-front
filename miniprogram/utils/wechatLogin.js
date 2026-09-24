const { request } = require('./request');

function getLoginCode() {
  return new Promise((resolve, reject) => {
    wx.login({
      success: result => {
        if (result && result.code) resolve(result.code);
        else reject(new Error('未获取到微信登录凭证，请重试'));
      },
      fail: () => reject(new Error('微信登录失败，请重试'))
    });
  });
}

async function wechatLogin(payload = {}) {
  // 自建服务器需要 wx.login 的 code；手机号授权的 phoneCode 是另一份凭证。
  // 只有显式启用的本地开发环境才能沿用模拟 code。
  const code = getApp().globalData.isLocalDevelopment && payload.code
    ? payload.code : await getLoginCode();
  return request({
    url: '/auth/wechat-login',
    method: 'POST',
    data: { ...payload, code },
    auth: false,
    withCompany: false
  });
}

module.exports = { wechatLogin };
