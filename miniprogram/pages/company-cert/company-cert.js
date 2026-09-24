const { request } = require('../../utils/request');
const { readDraft, saveDraft, clearDraft } = require('../../utils/companyOnboarding');
const app = getApp();

Page({
  data: {
    companyId: '',
    companyName: '',
    creditCode: '',
    legalPersonName: '',
    hasCompany: false,
    agreed: false,
    loading: false,
    submitting: false,
    identity: null,
    actions: []
  },

  onLoad(options) {
    if (options.resume === '1') {
      const draft = readDraft();
      if (!draft) {
        wx.redirectTo({ url: '/pages/company-bind/company-bind' });
        return;
      }
      this.setData({ ...draft, hasCompany: false });
      if (draft.companyId) {
        this.setData({ hasCompany: true });
        this._awaitingCompanyAuth = true;
        this._resumingClaim = true;
        this.resumePendingCompany();
        return;
      }
      this._awaitingPersonal = true;
      return;
    }
    if (options.name) {
      this.setData({
        hasCompany: false,
        companyName: decodeURIComponent(options.name),
        creditCode: decodeURIComponent(options.creditCode || ''),
        legalPersonName: decodeURIComponent(options.legalPersonName || '')
      });
      return;
    }
    this._awaitingCompanyAuth = options.autoSwitch === '1';
    this.setData({ hasCompany: true, companyId: options.companyId || '' });
    if (options.resumePending === '1') {
      this._resumingClaim = true;
      this.resumePendingCompany();
      return;
    }
    this.loadCompany(this._awaitingCompanyAuth);
  },

  onShow() {
    if (this._resumingClaim) return;
    if (this._awaitingPersonal) {
      this._awaitingPersonal = false;
      if (!this.data.hasCompany) return this.createAndAuthenticate(true);
      return this.handleAction({ currentTarget: { dataset: { key: 'company' } } }, true);
    }
    if (this.data.hasCompany && this.data.companyId) this.loadCompany(true);
  },

  onPullDownRefresh() {
    if (!this.data.hasCompany) { wx.stopPullDownRefresh(); return; }
    this.loadCompany(true).finally(() => wx.stopPullDownRefresh());
  },

  onUnload() { this._unloaded = true; },

  async resumePendingCompany() {
    const token = app.globalData.token;
    try {
      const companies = await request({ url: '/me/company-onboarding', withCompany: false });
      if (this._unloaded || token !== app.globalData.token) return;
      const company = (companies || []).find(item => String(item.id) === String(this.data.companyId));
      if (company) {
        // Also recover a creation whose separate claim request was interrupted.
        await request({ url: '/me/company', method: 'POST', withCompany: false,
          data: { id: company.id, name: company.name, creditCode: company.creditCode,
            legalPersonName: company.legalPersonName } });
        if (this._unloaded || token !== app.globalData.token) return;
        clearDraft(company.creditCode);
      }
      this._resumingClaim = false;
      await this.loadCompany(true);
    } catch (error) {
      this._resumingClaim = false;
      this._claimRetry = true;
      wx.showToast({ title: error.message || '企业认证恢复失败，请刷新重试', icon: 'none' });
    }
  },

  async loadCompany(sync) {
    if (this._unloaded) return;
    if (this.data.loading) {
      if (sync) this._syncAfterLoad = true;
      return;
    }
    this.setData({ loading: true });
    try {
      const targetCompanyId = this.data.companyId;
      const company = targetCompanyId
        ? await request({ url: `/companies/${targetCompanyId}`, withCompany: false })
        : (await request({ url: '/me' })).company || {};
      const companyId = targetCompanyId || company.id || app.getCurrentCompanyId();
      if (!companyId) throw new Error('请先选择企业');
      let identity = await request({ url: `/fadada/companies/${companyId}/identity`, withCompany: false });
      if (sync && identity && identity.status !== 'NOT_STARTED' && identity.enabled
          && !(this._awaitingCompanyAuth && identity.status === 'VERIFIED')) {
        try {
          identity = await request({
            url: `/fadada/companies/${companyId}/identity/sync`, method: 'POST', withCompany: false
          });
        } catch (error) {
          // Keep the saved company and its continuation actions visible when the provider is unavailable.
          wx.showToast({ title: error.message || '最新结果暂未同步，请刷新重试', icon: 'none' });
        }
      }
      const companyDone = identity && identity.status === 'VERIFIED';
      const sealDone = identity && Number(identity.enabledSealCount || 0) > 0;
      this.setData({
        companyId: String(companyId),
        companyName: company.name || '',
        creditCode: company.creditCode || '',
        legalPersonName: company.legalPersonName || '',
        identity,
        actions: [
          {
            key: 'company', title: '企业认证', desc: '核验企业主体和经办人身份',
            done: companyDone, statusText: identity.statusText || '待认证',
            statusColor: companyDone ? '#20a66a' : '#f59e0b'
          },
          {
            key: 'seal', title: '电子印章', desc: '管理合同签署使用的企业印章',
            done: sealDone, statusText: sealDone ? '已启用' : (companyDone ? '待设置' : '完成企业认证后设置'),
            statusColor: sealDone ? '#20a66a' : '#f59e0b'
          }
        ]
      });
      if (companyDone && this._awaitingCompanyAuth && !this._unloaded) {
        await app.switchCompany(companyId);
        if (this._unloaded) return;
        this._awaitingCompanyAuth = false;
        wx.switchTab({ url: '/pages/index/index' });
      }
    } catch (error) {
      wx.showToast({ title: error.message || '认证状态加载失败', icon: 'none' });
    } finally {
      this.setData({ loading: false });
      if (this._syncAfterLoad && !this._unloaded) {
        this._syncAfterLoad = false;
        this.loadCompany(true);
      }
    }
  },

  toggleAgree() {
    this.setData({ agreed: !this.data.agreed });
    saveDraft(this.data);
  },

  openAgreement(e) {
    const type = e.currentTarget.dataset.type === 'privacy' ? 'privacy' : 'user';
    wx.navigateTo({ url: `/pages/legal-document/legal-document?type=${type}` });
  },

  async createAndAuthenticate(resuming) {
    resuming = resuming === true;
    if (!this.data.agreed) {
      wx.showToast({ title: '请先阅读并同意相关协议', icon: 'none' });
      return;
    }
    if (this.data.submitting) return;
    const token = app.globalData.token;
    this.setData({ submitting: true });
    saveDraft(this.data);
    try {
      const personalIdentity = await request({
        url: '/fadada/users/me/identity', withCompany: false
      });
      if (this._unloaded || token !== app.globalData.token) return;
      if (!personalIdentity || personalIdentity.status !== 'VERIFIED') {
        if (resuming) return;
        wx.showModal({
          title: '请先完成个人认证',
          content: '先完成个人实名认证，完成后将继续创建本企业。企业资料已保存。',
          confirmText: '去认证',
          success: result => {
            if (result.confirm) {
              this._awaitingPersonal = true;
              wx.navigateTo({ url: '/pages/personal-cert/personal-cert?flow=company-create' });
            }
          }
        });
        return;
      }
      const created = await request({
        url: '/companies', method: 'POST', withCompany: false,
        data: {
          name: this.data.companyName,
          creditCode: this.data.creditCode,
          legalPersonName: this.data.legalPersonName
        }
      });
      if (this._unloaded || token !== app.globalData.token) return;
      saveDraft({ ...this.data, companyId: created.id });
      await request({
        url: '/me/company', method: 'POST', withCompany: false,
        data: {
          id: created.id,
          name: created.name,
          creditCode: created.creditCode,
          legalPersonName: created.legalPersonName
        }
      });
      if (this._unloaded || token !== app.globalData.token) return;
      clearDraft(created.creditCode);
      this.setData({ companyId: String(created.id), hasCompany: true });
      // A profile refresh failure must not discard the successfully created company.
      this.loadCompany(false);
      this.openService('company', created.id);
    } catch (error) {
      wx.showToast({ title: error.message || '企业创建失败', icon: 'none' });
    } finally {
      this.setData({ submitting: false });
    }
  },

  async handleAction(e, resuming) {
    const key = e.currentTarget.dataset.key;
    const identity = this.data.identity || {};
    if (!identity.enabled) {
      wx.showModal({ title: '认证服务未启用', content: '请联系管理员完成服务配置。', showCancel: false });
      return;
    }
    if (key === 'seal' && identity.status !== 'VERIFIED') {
      wx.showToast({ title: '请先完成企业认证', icon: 'none' });
      return;
    }
    if (key === 'company') {
      try {
        const personalIdentity = await request({
          url: '/fadada/users/me/identity', withCompany: false
        });
        if (!personalIdentity || personalIdentity.status !== 'VERIFIED') {
          if (resuming === true) return;
          wx.showModal({
            title: '请先完成个人认证',
            content: '企业认证前，需要先确认当前申请人的实名身份。',
            confirmText: '去认证',
            success: result => {
              if (result.confirm) {
                this._awaitingPersonal = true;
                wx.navigateTo({ url: `/pages/personal-cert/personal-cert?flow=company-create&companyId=${this.data.companyId}` });
              }
            }
          });
          return;
        }
      } catch (error) {
        wx.showToast({ title: error.message || '个人认证状态获取失败', icon: 'none' });
        return;
      }
    }
    this.openService(key, this.data.companyId);
  },

  openService(scene, companyId) {
    if (scene === 'company') this._awaitingCompanyAuth = true;
    wx.navigateTo({
      url: `/pages/fadada-auth/fadada-auth?scene=${scene}&companyId=${companyId}`
    });
  },

  refreshStatus() {
    if (this._claimRetry) {
      this._claimRetry = false;
      this._resumingClaim = true;
      this.resumePendingCompany();
    } else this.loadCompany(true);
  }
});
