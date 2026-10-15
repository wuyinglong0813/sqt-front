const { request } = require('../../utils/request');
const { captureCompanyContext, isCompanyContextCurrent } = require('../../utils/companyContext');
const { requirePrivacyAuthorization } = require('../../utils/privacy');

// Fadada's desktop signing page keeps fixed side columns. Below this width the contract collapses.
const DESKTOP_SIGN_WIDTH = 1280;
const WEB_VIEW_LOAD_TIMEOUT = 30000;

const SCENES = {
  personal: { title: '个人认证', loading: '正在打开个人认证', endpoint: '/fadada/users/me/auth-url', withCompany: false },
  company: { title: '企业认证', loading: '正在打开企业认证', withCompany: false },
  legal: { title: '法人身份核验', loading: '正在打开法人身份核验', withCompany: false },
  seal: { title: '电子印章', loading: '正在打开印章管理', withCompany: false },
  contract: { title: '合同签署', loading: '正在打开合同签署' },
  abolish: { title: '合同作废签署', loading: '正在打开作废签署' }
};

Page({
  data: {
    loading: true,
    serviceUrl: '',
    errorMessage: '',
    serviceCancelled: false,
    scene: 'personal',
    pageTitle: '认证服务',
    loadingText: '正在连接安全服务',
    options: {},
    serviceHost: '',
    webViewGeneration: 0
  },

  onLoad(options) {
    this._visible = true;
    this._unloaded = false;
    this._sessionToken = getApp().globalData.token;
    if (options.faceReturnId) {
      this.restoreFaceReturn(options.faceReturnId);
      return;
    }
    const scene = SCENES[options.scene] ? options.scene : 'personal';
    const config = SCENES[scene];
    this.setData({ scene, options, pageTitle: config.title, loadingText: config.loading });
    wx.setNavigationBarTitle({ title: config.title });
    this.ensureDesktopSignWidth();
    this.prepareService();
  },

  onShow() {
    if (this._unloaded || this._faceRemounting) return;
    this._visible = true;
    if (this._pendingFaceReturn) {
      this.remountFaceReturn();
      return;
    }
    this.ensureDesktopSignWidth();
    this.startWebViewWatchdog();
    if (this.data.serviceUrl && !this.data.errorMessage && !this.pollTimer) this.startStatusPolling();
  },

  onResize() { this.ensureDesktopSignWidth(); },

  onHide() { this._visible = false; this.stopStatusPolling(); this.pauseWebViewWatchdog(); },
  onUnload() { this._unloaded = true; this._visible = false; this.stopStatusPolling();
    this.pauseWebViewWatchdog();
    this.restoreDesktopSignWidth(); },

  desktopSignScene() {
    return this.data.scene === 'contract' || this.data.scene === 'abolish';
  },

  readWindowSize() {
    try {
      if (typeof wx.getWindowInfo === 'function') return wx.getWindowInfo();
      if (typeof wx.getSystemInfoSync === 'function') return wx.getSystemInfoSync();
    } catch (e) {}
    return null;
  },

  ensureDesktopSignWidth() {
    if (!getApp().globalData.isDesktopWechat || !this.desktopSignScene()) return;
    if (typeof wx.setWindowSize !== 'function' || this._signWidthPending || this._signWidthAttempts >= 2) return;
    const info = this.readWindowSize();
    const width = info && info.windowWidth;
    const height = info && info.windowHeight;
    if (!width || !height) return;
    const target = Math.max(width, Math.min(DESKTOP_SIGN_WIDTH, (info.screenWidth || DESKTOP_SIGN_WIDTH)));
    if (target - width < 40) return;
    if (!this._previousWindowSize) this._previousWindowSize = { width, height };
    this._signWidthPending = true;
    this._signWidthAttempts = (this._signWidthAttempts || 0) + 1;
    wx.setWindowSize({
      width: target,
      height,
      complete: () => { this._signWidthPending = false; }
    });
  },

  restoreDesktopSignWidth() {
    const previous = this._previousWindowSize;
    this._previousWindowSize = null;
    if (!previous || typeof wx.setWindowSize !== 'function') return;
    wx.setWindowSize({ width: previous.width, height: previous.height, fail() {} });
  },

  async prepareService() {
    if (this._preparing || this._unloaded) return;
    this._preparing = true;
    this.setData({ loading: true, errorMessage: '', serviceCancelled: false });
    const token = getApp().globalData.token;
    const context = captureCompanyContext(getApp());
    try {
      if (this.data.scene === 'contract') {
        const quote = await request({
          url: '/contracts/' + this.data.options.contractId + '/signing/quote',
          token: context.token, companyId: context.companyId
        });
        if (this._unloaded || !isCompanyContextCurrent(getApp(), context)) return;
        if (!quote || !quote.canSign) throw new Error((quote && quote.message) || '当前不能发起签署');
        if (quote.newTask) {
          const accepted = await new Promise(resolve => wx.showModal({
            title: '确认发起电子签',
            content: quote.message + '。\n成功创建签署任务后计入使用量，双方签完后合同生效。',
            confirmText: '确认发起',
            success: result => resolve(!!result.confirm),
            fail: () => resolve(false)
          }));
          if (this._unloaded || !isCompanyContextCurrent(getApp(), context)) return;
          if (!accepted) {
            this.setData({ loading: false, errorMessage: '已取消发起，未创建签署任务' });
            return;
          }
        }
      }
      const result = await this.readAuthStatus(true);
      if (this._unloaded || token !== getApp().globalData.token
          || (this.data.scene === 'contract' && !isCompanyContextCurrent(getApp(), context))) return;
      if (result && (result.status === 'VERIFIED'
          || (this.data.scene === 'legal' && result.status === 'REVIEW_REQUIRED'))) {
        this.openReturnPage();
        return;
      }
      await this.loadServiceUrl();
    } catch (error) {
      if (!this._unloaded && token === getApp().globalData.token) {
        this.setData({ loading: false, errorMessage: error.message || '认证状态暂时无法确认，请重试' });
      }
    } finally {
      this._preparing = false;
    }
  },

  async readAuthStatus(forceSync = false) {
    const { scene, options } = this.data;
    if (!['personal', 'company', 'legal'].includes(scene)) return null;
    const token = getApp().globalData.token;
    if (scene === 'legal') return request({
      url: `/fadada/companies/${options.companyId}/legal-representative/sync`,
      method: 'POST', withCompany: false, token, timeout: 15000
    });
    const url = scene === 'personal' ? '/fadada/users/me/identity'
      : `/fadada/companies/${options.companyId}/identity`;
    const current = await request({ url, withCompany: false, token, timeout: 15000 });
    if (this._unloaded || token !== getApp().globalData.token
        || !current || ['VERIFIED', 'FAILED', 'NOT_STARTED'].includes(current.status)) return current;
    if (!forceSync && this._lastProviderSync && Date.now() - this._lastProviderSync < 30000) return current;
    this._lastProviderSync = Date.now();
    try {
      return await request({ url: `${url}/sync`, method: 'POST', withCompany: false, token, timeout: 15000 });
    } catch (error) {
      // A callback may have completed the identity while the provider query failed.
      const latest = await request({ url, withCompany: false, token, timeout: 15000 });
      if (latest && latest.status === 'VERIFIED') return latest;
      throw error;
    }
  },

  // Contract used by the official Fadada face-verification bridge.
  acceptsReturnUrl(url, sourceUrl = this.data.serviceUrl) {
    const host = this.extractHost(url).toLowerCase();
    return !!host && host === this.extractHost(sourceUrl).toLowerCase()
      && !String(url).includes('\\');
  },

  setIsRedirect() { this.stopStatusPolling(); },

  reloadPage(url) {
    if (!this.acceptsReturnUrl(url) || this._unloaded
        || this._sessionToken !== getApp().globalData.token || this._pendingFaceReturn) return false;
    this.stopStatusPolling();
    // The parent is hidden under the bridge. Wait for navigateBack before recreating it;
    // hidden setData calls can coalesce and leave the old, consumed face flow mounted.
    this._pendingFaceReturn = { url, token: this._sessionToken,
      context: captureCompanyContext(getApp()) };
    return true;
  },

  remountFaceReturn() {
    const pending = this._pendingFaceReturn;
    this._pendingFaceReturn = null;
    const app = getApp();
    if (!pending || pending.token !== app.globalData.token
        || !isCompanyContextCurrent(app, pending.context)) {
      this.setData({ errorMessage: '登录或企业状态已变化，请返回后重新查询认证结果。' });
      return;
    }
    const id = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
    const previousWindowSize = this._previousWindowSize;
    // Keep the provider URL in a one-use in-memory handoff, bound to the current session.
    app._fadadaFaceReturn = { ...pending, id, scene: this.data.scene,
      options: { ...this.data.options }, sourceUrl: this.data.serviceUrl,
      previousWindowSize };
    this._faceRemounting = true;
    this._previousWindowSize = null;
    wx.redirectTo({ url: `/pages/fadada-auth/fadada-auth?faceReturnId=${encodeURIComponent(id)}`,
      fail: () => {
        if (app._fadadaFaceReturn && app._fadadaFaceReturn.id === id) delete app._fadadaFaceReturn;
        if (!this._unloaded && pending.token === app.globalData.token) {
          this._faceRemounting = false;
          this._previousWindowSize = previousWindowSize;
          this.setData({ errorMessage: '刷脸返回页面未能恢复，请刷新认证结果后继续。' });
        }
      } });
  },

  restoreFaceReturn(id) {
    const app = getApp();
    const pending = app._fadadaFaceReturn;
    if (pending && pending.id === id) delete app._fadadaFaceReturn;
    if (!pending || pending.id !== id || pending.token !== app.globalData.token
        || !isCompanyContextCurrent(app, pending.context) || !SCENES[pending.scene]) {
      this.setData({ loading: false, errorMessage: '刷脸返回会话已失效，请返回后重新查询认证结果。' });
      return;
    }
    if (!this.acceptsReturnUrl(pending.url, pending.sourceUrl)) {
      this.setData({ loading: false, serviceUrl: '', errorMessage: '刷脸返回地址无效，请返回后重新查询认证结果。' });
      return;
    }
    const config = SCENES[pending.scene];
    this._previousWindowSize = pending.previousWindowSize;
    this.setData({ scene: pending.scene, options: pending.options, pageTitle: config.title,
      loadingText: config.loading, loading: false, errorMessage: '' });
    this.mountServiceUrl(pending.url, pending.context);
    wx.setNavigationBarTitle({ title: config.title });
    this.ensureDesktopSignWidth();
    this.startStatusPolling();
  },

  async confirmServicePrivacy(context) {
    const consentKey = [context.token, context.companyId || '', this.data.scene].join(':');
    if (this._servicePrivacyConsent === consentKey) return true;
    await requirePrivacyAuthorization();
    const result = await new Promise((resolve, reject) => wx.showModal({
      title: '认证与签署信息处理提示',
      content: '为办理认证、电子印章或合同签署，我们将向电子签服务商提供本次服务所需的手机号、企业资料或合同及签署信息，并接收认证姓名、状态等结果；企业入驻时还需核对本人的企业成员身份和管理权限。证件及人脸核验由服务页面或认证小程序处理。你可在“我的 → 第三方信息共享清单”和服务页面查看具体规则。是否继续？',
      confirmText: '同意继续',
      cancelText: '暂不使用',
      success: resolve,
      fail: () => reject(new Error('信息处理提示未能打开，请重试'))
    }));
    if (!result.confirm) return false;
    if (this._unloaded || !isCompanyContextCurrent(getApp(), context)) {
      throw new Error('登录或企业已变化，请返回后重新发起');
    }
    this._servicePrivacyConsent = consentKey;
    return true;
  },

  async loadServiceUrl() {
    if (this._loadingServiceUrl || this._unloaded) return;
    this._loadingServiceUrl = true;
    const token = getApp().globalData.token;
    const context = captureCompanyContext(getApp());
    const { scene, options } = this.data;
    const config = SCENES[scene];
    this.pauseWebViewWatchdog();
    this._webViewSession = null;
    this.setData({ loading: true, serviceUrl: '', errorMessage: '', serviceCancelled: false });
    try {
      const accepted = await this.confirmServicePrivacy(context);
      if (this._unloaded || !isCompanyContextCurrent(getApp(), context)) return;
      if (!accepted) {
        this.setData({ serviceCancelled: true });
        return;
      }
      let endpoint = config.endpoint;
      if (scene === 'company') endpoint = `/fadada/companies/${options.companyId}/auth-url`;
      if (scene === 'legal') endpoint = `/fadada/companies/${options.companyId}/legal-representative/auth-url`;
      if (scene === 'seal') endpoint = `/fadada/companies/${options.companyId}/seal-manage-url`;
      if (scene === 'contract') endpoint = `/contracts/${options.contractId}/sign-url`;
      if (scene === 'abolish') endpoint = `/contracts/${options.contractId}/abolish-url`;
      if (!endpoint) throw new Error('服务参数不完整');
      const result = await request({
        url: endpoint,
        method: 'POST',
        token,
        data: scene === 'abolish' ? { reason: decodeURIComponent(options.reason || '') } : {},
        withCompany: config.withCompany !== false,
        timeout: 30000
      });
      if (this._unloaded || token !== getApp().globalData.token
          || (scene === 'contract' && !isCompanyContextCurrent(getApp(), context))) return;
      const serviceUrl = result && (result.url || result.authUrl);
      const status = result && (result.status || (result.identity && result.identity.status));
      if (!serviceUrl && status && ['personal', 'company', 'legal'].includes(scene)) {
        this.openReturnPage();
        return;
      }
      if (!serviceUrl) throw new Error('未获取到服务地址');
      this.mountServiceUrl(serviceUrl, context);
      this.startStatusPolling();
    } catch (error) {
      if (!this._unloaded && token === getApp().globalData.token) {
        this.setData({ errorMessage: error.message || '服务页面加载失败' });
      }
    } finally {
      this._loadingServiceUrl = false;
      if (!this._unloaded) this.setData({ loading: false });
    }
  },

  mountServiceUrl(url, context = captureCompanyContext(getApp())) {
    this.pauseWebViewWatchdog();
    const generation = (this._webViewGeneration || 0) + 1;
    this._webViewGeneration = generation;
    this._webViewSession = { generation, url, context, token: getApp().globalData.token,
      remaining: WEB_VIEW_LOAD_TIMEOUT, loaded: false };
    this.setData({ serviceUrl: url, serviceHost: this.extractHost(url), webViewGeneration: generation });
    this.startWebViewWatchdog();
  },

  isWebViewSessionCurrent(session = this._webViewSession) {
    return !!session && !this._unloaded && !this._returning && !this._faceRemounting
      && session === this._webViewSession && session.token === getApp().globalData.token
      && isCompanyContextCurrent(getApp(), session.context) && session.url === this.data.serviceUrl;
  },

  isCurrentWebViewEvent(event) {
    const generation = event && event.currentTarget && event.currentTarget.dataset
      && event.currentTarget.dataset.generation;
    return this.isWebViewSessionCurrent() && Number(generation) === this._webViewSession.generation;
  },

  startWebViewWatchdog() {
    const session = this._webViewSession;
    if (!this.isWebViewSessionCurrent(session) || session.loaded || this.webViewLoadTimer
        || this._visible !== true || this.data.errorMessage) return;
    session.deadline = Date.now() + session.remaining;
    const timer = setTimeout(() => {
      if (this.webViewLoadTimer !== timer) return;
      this.webViewLoadTimer = null;
      if (!this.isWebViewSessionCurrent(session) || this._visible === false || session.loaded) return;
      session.remaining = 0;
      this.showWebViewError('服务页面连接超时，请检查网络后重新加载；已完成认证可直接刷新认证结果。');
    }, session.remaining);
    this.webViewLoadTimer = timer;
  },

  pauseWebViewWatchdog() {
    if (!this.webViewLoadTimer) return;
    clearTimeout(this.webViewLoadTimer);
    this.webViewLoadTimer = null;
    if (this._webViewSession) {
      this._webViewSession.remaining = Math.max(0, this._webViewSession.deadline - Date.now());
    }
  },

  onWebViewLoad(event) {
    if (!this.isCurrentWebViewEvent(event)) return;
    this._webViewSession.loaded = true;
    this.pauseWebViewWatchdog();
  },

  onWebViewError(event) {
    if (!this.isCurrentWebViewEvent(event)) return;
    this.showWebViewError('服务页面暂时无法打开，请检查网络后重试；如仍无法打开，请联系平台客服');
  },

  showWebViewError(message) {
    this.pauseWebViewWatchdog();
    this.stopStatusPolling();
    this.setData({ loading: false, errorMessage: message });
    wx.setNavigationBarTitle({ title: this.data.pageTitle });
  },

  startStatusPolling() {
    const { scene } = this.data;
    // Seal management is an editor: an existing seal does not mean editing is complete.
    if (!['personal', 'company', 'legal'].includes(scene) || this.pollTimer
        || this._visible === false || this._unloaded) return;
    this.pollAttempts = 0;
    const generation = this._pollGeneration = (this._pollGeneration || 0) + 1;
    this.scheduleStatusPoll(generation);
  },

  isPollingCurrent(generation) {
    return !this._unloaded && this._visible !== false
      && generation === (this._pollGeneration || 0);
  },

  scheduleStatusPoll(generation = this._pollGeneration || 0) {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    if (!this.isPollingCurrent(generation)) return;
    // Filling details or choosing a license photo can take several minutes.
    // Back off polling without navigating away from an unfinished provider form.
    const delay = (this.pollAttempts || 0) >= 120 ? 10000 : 2500;
    this.pollTimer = setTimeout(() => this.pollStatus(generation), delay);
  },

  async pollStatus(generation = this._pollGeneration || 0) {
    if (!this.isPollingCurrent(generation) || this.data.scene === 'seal') return;
    this.pollTimer = null;
    const token = getApp().globalData.token;
    try {
      const result = await this.readAuthStatus();
      if (!this.isPollingCurrent(generation) || token !== getApp().globalData.token) return;
      // Missing authorization is expected before the user finishes this form.
      // failureReason can also contain cached query errors; it is not completion.
      const completed = !!(result && (['VERIFIED', 'FAILED'].includes(result.status)
        || (this.data.scene === 'legal' && result.status === 'REVIEW_REQUIRED')));
      if (completed) {
        this.openReturnPage();
        return;
      }
    } catch (error) {
      // Keep the provider page open while transient status queries fail.
    }
    if (!this.isPollingCurrent(generation) || token !== getApp().globalData.token) return;
    this.pollAttempts = Math.min((this.pollAttempts || 0) + 1, 120);
    this.scheduleStatusPoll(generation);
  },

  openReturnPage() {
    if (this._unloaded || this._visible === false || this._returning) return;
    this._returning = true;
    this.stopStatusPolling();
    this.pauseWebViewWatchdog();
    const token = getApp().globalData.token;
    const { scene, options } = this.data;
    const query = [`scene=${scene}`];
    if (options.flow === 'company-create') query.push('flow=company-create');
    if (options.companyId) query.push(`companyId=${encodeURIComponent(options.companyId)}`);
    if (options.contractId) query.push(`contractId=${encodeURIComponent(options.contractId)}`);
    wx.redirectTo({ url: `/pages/service-return/service-return?${query.join('&')}`,
      fail: () => {
        this._returning = false;
        if (!this._unloaded && token === getApp().globalData.token) this.setData({ loading: false,
          errorMessage: '认证结果页暂时无法打开，请刷新认证结果后重试。' });
      } });
  },

  stopStatusPolling() {
    this._pollGeneration = (this._pollGeneration || 0) + 1;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
  },

  extractHost(value) {
    const match = String(value || '').match(/^https:\/\/([^/?#]+)/i);
    return match ? match[1] : '';
  },

  retry() {
    if (this._reloadingWebView) return;
    const session = this._webViewSession;
    if (!this.isWebViewSessionCurrent(session)) { this.prepareService(); return; }
    this._reloadingWebView = true;
    this.pauseWebViewWatchdog();
    // Recreate the failed container with the same URL; another enrollment URL can
    // restart a provider flow and contribute to its request-frequency limit.
    this.setData({ loading: true, serviceUrl: '', errorMessage: '' }, () => {
      this._reloadingWebView = false;
      if (this._unloaded || session !== this._webViewSession
          || session.token !== getApp().globalData.token
          || !isCompanyContextCurrent(getApp(), session.context)) return;
      this.mountServiceUrl(session.url, session.context);
      this.setData({ loading: false });
      this.startStatusPolling();
    });
  },
  checkResult() { this.openReturnPage(); },
  goBack() { wx.navigateBack(); }
});
