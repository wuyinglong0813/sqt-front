const { request } = require('./request');

const memberApplicationData = {
  memberApplications: [], memberApplicationsLoading: false, memberApplicationsError: ''
};

function startMemberApplicationIdentity(app, applicationId) {
  if (!app.globalData.token || !app.globalData.userInfo || !applicationId) return;
  wx.navigateTo({ url: '/pages/personal-cert/personal-cert?flow=member-join&applicationId='
    + encodeURIComponent(String(applicationId)) });
}

function applicationView(item) {
  if (!item || !item.id || !['PENDING_IDENTITY', 'PENDING'].includes(item.status)) return null;
  return {
    id: String(item.id), companyId: String(item.companyId || ''), companyName: String(item.companyName || '受邀企业'),
    status: item.status, statusText: item.status === 'PENDING_IDENTITY' ? '待完成个人实名' : '等待管理员审核',
    description: item.status === 'PENDING_IDENTITY'
      ? '申请已保存，完成手机号核验和个人实名后进入审核。'
      : '实名已完成，管理员核对身份并分配角色后才能加入企业。'
  };
}

const memberApplicationMethods = {
  resetMemberApplicationContext() {
    const data = getApp().globalData;
    const owner = JSON.stringify([data.token || '', String((data.userInfo || {}).id || '')]);
    if (owner !== this._memberApplicationsOwner) {
      this._memberApplicationsSequence = (this._memberApplicationsSequence || 0) + 1;
      this.setData({ ...memberApplicationData });
      this._memberApplicationsOwner = owner;
    }
  },

  async loadMemberApplications() {
    const app = getApp();
    const token = app.globalData.token;
    const userId = String((app.globalData.userInfo || {}).id || '');
    const owner = JSON.stringify([token, userId]);
    const sequence = this._memberApplicationsSequence = (this._memberApplicationsSequence || 0) + 1;
    if (owner !== this._memberApplicationsOwner || !token || !userId) {
      this.setData({ ...memberApplicationData });
      this._memberApplicationsOwner = owner;
    }
    if (!token || !userId) return;
    const current = () => !this._unloaded && sequence === this._memberApplicationsSequence
      && token === app.globalData.token && userId === String((app.globalData.userInfo || {}).id || '');
    this.setData({ memberApplicationsLoading: true, memberApplicationsError: '' });
    try {
      const result = await request({ url: '/me/member-applications', token, withCompany: false });
      if (!current()) return;
      if (!Array.isArray(result)) throw new Error('入企进度暂时无法读取');
      this.setData({ memberApplications: result.map(applicationView).filter(Boolean) });
    } catch (error) {
      if (current()) this.setData({ memberApplications: [], memberApplicationsError: error.message || '入企进度加载失败，请重试' });
    } finally {
      if (current()) this.setData({ memberApplicationsLoading: false });
    }
  },

  continueMemberApplication(event) {
    const id = String(event.currentTarget.dataset.id || '');
    const application = (this.data.memberApplications || []).find(item => item.id === id);
    if (application && application.status === 'PENDING_IDENTITY') startMemberApplicationIdentity(getApp(), id);
  },

  async refreshMemberApplications() {
    if (this._refreshingMemberApplications) return;
    this._refreshingMemberApplications = true;
    const app = getApp();
    const token = app.globalData.token;
    try {
      await app.loadMe();
      if (!this._unloaded && token === app.globalData.token) await this.onShow();
    } catch (error) {
      if (!this._unloaded && token === app.globalData.token) wx.showToast({ title: error.message || '入企进度刷新失败，请重试', icon: 'none' });
    } finally {
      this._refreshingMemberApplications = false;
    }
  }
};

module.exports = { memberApplicationData, memberApplicationMethods, startMemberApplicationIdentity, applicationView };
