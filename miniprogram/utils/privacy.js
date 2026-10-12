const PRIVACY_VERSION = '2026-10-12';

function hasPrivacyConsent() {
  return wx.getStorageSync('privacy_agreed') === true
    && wx.getStorageSync('privacy_agreed_version') === PRIVACY_VERSION;
}

// Local acknowledgement is only for our supplementary notice. WeChat owns the
// authorization state and rechecks it when the platform policy changes.
function requirePrivacyAuthorization() {
  return new Promise((resolve, reject) => {
    if (typeof wx.requirePrivacyAuthorize !== 'function') {
      if (getApp().globalData.isLocalDevelopment) { resolve(); return; }
      reject(new Error('当前微信版本不支持隐私授权，请更新微信后重试'));
      return;
    }
    wx.requirePrivacyAuthorize({
      success: () => resolve(),
      fail: () => reject(new Error('未完成隐私授权，本次操作已取消'))
    });
  });
}

async function acceptPrivacyConsent() {
  await requirePrivacyAuthorization();
  wx.setStorageSync('privacy_agreed', true);
  wx.setStorageSync('privacy_agreed_version', PRIVACY_VERSION);
}

async function runPrivacyAction(action) {
  try {
    await requirePrivacyAuthorization();
  } catch (error) {
    wx.showToast({ title: error.message, icon: 'none' });
    return false;
  }
  return action();
}

module.exports = { PRIVACY_VERSION, hasPrivacyConsent, requirePrivacyAuthorization, acceptPrivacyConsent, runPrivacyAction };
