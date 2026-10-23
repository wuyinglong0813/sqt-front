const { request } = require('../../utils/request');
const { captureCompanyContext, isCompanyContextCurrent } = require('../../utils/companyContext');
const { requirePrivacyAuthorization } = require('../../utils/privacy');
const { createSigningContinuation, resumeSigningContinuation, clearSigningContinuation,
  rememberServiceRecovery, clearServiceRecovery } = require('../../utils/signingContinuation');

// Fadada's desktop signing page keeps fixed side columns. Below this width the contract collapses.
const DESKTOP_SIGN_WIDTH = 1280;
const WEB_VIEW_LOAD_TIMEOUT = 30000;
const SHORT_TICKET_LIFETIME = 10 * 60 * 1000;

const SCENES = {
  personal: { title: '个人认证', loading: '正在打开个人认证', endpoint: '/fadada/users/me/auth-url', withCompany: false },
  company: { title: '企业认证', loading: '正在打开企业认证', withCompany: false },
  legal: { title: '法人身份核验', loading: '正在打开法人身份核验', withCompany: false },
  seal: { title: '电子印章', loading: '正在打开印章管理', withCompany: false },
  member: { title: '同步电子签成员', loading: '正在同步电子签成员', withCompany: false },
  sealGrant: { title: '授权签署', loading: '正在核验签署授权', withCompany: false },
  organization: { title: '电子签成员', loading: '正在打开电子签成员管理', withCompany: false },
  contract: { title: '合同签署', loading: '正在打开合同签署' },
  abolish: { title: '合同作废', loading: '正在返回合同' }
};

Page({
  data: {
    loading: true,
    serviceUrl: '',
    errorMessage: '',
    serviceCancelled: false,
    serviceResultReady: false,
    serviceResultTitle: '',
    serviceResultMessage: '',
    needsPersonalIdentity: false,
    canRecoverPersonalIdentity: false,
    preparationAction: '',
    preparationTitle: '',
    preparationMessage: '',
    preparationActionText: '',
    preparationCanProceed: false,
    contractSealAuthorizationAvailable: false,
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
    this._signingContext = captureCompanyContext(getApp());
    if (options.faceReturnId) {
      this.restoreFaceReturn(options.faceReturnId);
      return;
    }
    if (options.reason) {
      // Normalize route input once; a literal percent sign in a business reason is valid.
      let reason = String(options.reason);
      try { reason = decodeURIComponent(reason); } catch (error) {}
      options = { ...options, reason };
    }
    const scene = SCENES[options.scene] ? options.scene : 'personal';
    const config = scene === 'company' && options.renewOrganization === '1'
      ? { ...SCENES.company, title: '企业签署授权', loading: '正在核验企业签署授权' }
      : SCENES[scene];
    this.setData({ scene, options, pageTitle: config.title, loadingText: config.loading });
    this.setData({ contractSealAuthorizationAvailable: !!options.contractId && this.canManageContractSeal() });
    wx.setNavigationBarTitle({ title: config.title });
    if (scene === 'abolish') return this.showLocalVoidNotice();
    this.ensureDesktopSignWidth();
    this.prepareService();
  },

  onShow() {
    if (this._unloaded || this._faceRemounting) return;
    this._visible = true;
    this._openingPrerequisite = false;
    if (this.data.scene === 'abolish') return this.showLocalVoidNotice();
    if (this._awaitingSigningPrerequisite) {
      const pending = this._awaitingSigningPrerequisite;
      this._awaitingSigningPrerequisite = null;
      // Intermediate prerequisites share the original operation's nonce.
      if (this.data.options.continuationId !== pending.id) clearSigningContinuation(getApp(), pending.id);
      if (!isCompanyContextCurrent(getApp(), pending.context)) {
        this.showServiceError(new Error('登录或企业已变化，请返回当前企业重新发起'));
        return;
      }
      return this.prepareService();
    }
    if (!this.isPageContextCurrent()) {
      this.showServiceError(new Error('登录或企业已变化，请返回当前企业重新发起'));
      return;
    }
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
    return ['contract', 'organization'].includes(this.data.scene);
  },

  showLocalVoidNotice() {
    this.pauseWebViewWatchdog();
    this.stopStatusPolling();
    this._webViewSession = null;
    clearServiceRecovery(getApp(), 'abolish', this.data.options);
    if (this.data.options.continuationId) clearSigningContinuation(getApp(), this.data.options.continuationId);
    this.setData({ loading: false, serviceUrl: '', errorMessage: '', serviceCancelled: false,
      preparationAction: '', needsPersonalIdentity: false, canRecoverPersonalIdentity: false,
      serviceResultReady: true, serviceResultTitle: '合同作废流程已更新',
      serviceResultMessage: '请返回合同详情提交作废申请，对方确认后在商签通内作废。' });
  },

  supplementaryOrganizationScene() {
    return this.data.scene === 'company' && this.data.options.renewOrganization === '1';
  },

  isPageContextCurrent() {
    return (!this._sessionToken || this._sessionToken === getApp().globalData.token)
      && (!this._signingContext || isCompanyContextCurrent(getApp(), this._signingContext));
  },

  canAuthorizeCompany() {
    const member = getApp().globalData.memberInfo || {};
    const permissions = member.permissions || [];
    return permissions.includes('all') || permissions.includes('company_manage') || member.roleCode === 'LEGAL';
  },

  showServiceError(error = {}) {
    this.pauseWebViewWatchdog();
    this.stopStatusPolling();
    const code = Number(error.code);
    const targetIsSelf = this.data.scene !== 'sealGrant'
      || String(this.data.options.userId || '') === String((getApp().globalData.userInfo || {}).id || '');
    let view;
    if (code === 46101) {
      const canProceed = this.canAuthorizeCompany();
      view = {
        preparationAction: 'company',
        preparationTitle: '企业需完成一次签署授权',
        preparationMessage: '这是企业对商签通的授权，与个人实名分开。请电子签平台企业超管办理一次，完成后同企业有签署权限的同事可复用，无需逐人重复办理企业授权。商签通管理员与电子签平台企业超管是两个身份。',
        preparationActionText: '授权后重新检查',
        preparationCanProceed: canProceed
      };
    } else if (code === 46106) {
      const canProceed = this.canAuthorizeCompany() || this.data.scene === 'company';
      view = {
        preparationAction: 'companyIdentity',
        preparationTitle: '完成企业认证',
        preparationMessage: canProceed
          ? '由企业电子签管理员确认授权。'
          : '请企业电子签管理员完成授权。',
        preparationActionText: canProceed ? '下一步' : '重新检查',
        preparationCanProceed: canProceed
      };
    } else if (code === 46102 && targetIsSelf) {
      view = { preparationAction: 'member', preparationTitle: '确认加入电子签企业',
        preparationMessage: '请本人确认加入电子签企业。',
        preparationActionText: '下一步', preparationCanProceed: true };
    } else if (code === 46103 && targetIsSelf) {
      view = { preparationAction: 'personal', preparationTitle: '完成本人认证',
        preparationMessage: '请本人完成实名认证。',
        preparationActionText: '下一步', preparationCanProceed: true };
    } else if (code === 46104) {
      const canProceed = this.canManageContractSeal() && !!(getApp().globalData.userInfo || {}).id;
      view = { preparationAction: 'sealGrant', preparationTitle: '完成用印授权',
        preparationMessage: canProceed
          ? '确认本合同印章的使用权限。'
          : '请企业印章管理员为你授权用印。',
        preparationActionText: canProceed ? '下一步' : '重新检查', preparationCanProceed: canProceed };
    } else if (code === 46107) {
      const permissions = (getApp().globalData.memberInfo || {}).permissions || [];
      const canProceed = permissions.includes('all') || permissions.includes('seal_manage');
      view = { preparationAction: 'seal', preparationTitle: '设置企业签署印章',
        preparationMessage: '请企业印章管理员设置合同印章。',
        preparationActionText: canProceed ? '下一步' : '重新检查', preparationCanProceed: canProceed };
    } else if (code === 46105 || ([46102, 46103].includes(code) && !targetIsSelf)) {
      view = { preparationAction: 'review', preparationTitle: '签署条件待确认',
        preparationMessage: error.message || '请企业管理员核对当前成员身份和签署权限。',
        preparationActionText: '重新检查', preparationCanProceed: false };
    }
    this.setData({ loading: false, serviceUrl: '', preparationAction: '',
      errorMessage: error.message || '签署状态暂未确认，请重新检查后继续', ...(view || {}) });
  },

  showCompanyIdentityReview(identity = {}) {
    this.pauseWebViewWatchdog();
    this.stopStatusPolling();
    this.setData({ loading: false, serviceUrl: '', errorMessage: '', serviceResultReady: false,
      preparationAction: 'identityReview', preparationTitle: '企业已授权，待核对本人身份',
      preparationMessage: identity.failureReason || '企业对商签通的已有有效授权已确认，尚需核对当前申请人本人的法人或经办依据。可联系平台支持补充核验，确认后重新核对。企业资料已保存。',
      preparationActionText: '重新核对本人身份', preparationCanProceed: false });
  },

  openIdentitySupport() {
    if (!this.isPageContextCurrent()) return;
    wx.navigateTo({ url: '/pages/help-center/help-center' });
  },

  continueSigningPreparation() {
    if (this._openingPrerequisite || !this.isPageContextCurrent()) return;
    const action = this.data.preparationAction;
    if (!this.data.preparationCanProceed) return this.prepareService();
    if (action === 'personal') return this.continuePersonalIdentity();
    // An authorization response without a URL is a pending result, never success.
    if (this.supplementaryOrganizationScene() && action === 'company') return this.prepareService();
    const app = getApp();
    const id = createSigningContinuation(app, this.data.scene, this.data.options);
    if (!id) return this.showServiceError(new Error('原办理会话已失效，请返回当前企业重新发起'));
    const query = { scene: action === 'companyIdentity' ? 'company' : action,
      companyId: app.globalData.currentCompanyId, continuationId: id };
    if (action === 'company') query.renewOrganization = '1';
    if (action === 'sealGrant') {
      query.userId = (app.globalData.userInfo || {}).id;
      if (this.data.options.contractId) query.contractId = this.data.options.contractId;
    }
    this._awaitingSigningPrerequisite = { id, context: captureCompanyContext(app) };
    this._openingPrerequisite = true;
    wx.navigateTo({ url: '/pages/fadada-auth/fadada-auth?' + Object.keys(query)
      .map(key => `${key}=${encodeURIComponent(query[key])}`).join('&'),
      fail: () => {
        this._openingPrerequisite = false;
        this._awaitingSigningPrerequisite = null;
        if (this.data.options.continuationId !== id) clearSigningContinuation(app, id);
        this.showServiceError(new Error('办理页面暂未打开，请重试'));
      } });
  },

  recheckSigningPreparation() {
    if (this.supplementaryOrganizationScene()) return this.checkResult();
    return this.prepareService();
  },

  finishSigningPrerequisite() {
    const id = this.data.options.continuationId;
    if (!id) return false;
    const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : [];
    const destination = resumeSigningContinuation(getApp(), id, pages);
    if (!destination) { this.showServiceError(new Error('原办理会话已失效，请返回当前企业重新发起')); return true; }
    if (this._returning) return true;
    this._returning = true;
    this.stopStatusPolling();
    const redirect = () => wx.redirectTo({ url: destination.url,
      success: () => clearSigningContinuation(getApp(), id),
      fail: () => { this._returning = false; this.showServiceError(new Error('继续原操作暂未完成，请返回后重试')); } });
    if (destination.delta > 0) wx.navigateBack({ delta: destination.delta, fail: redirect });
    else redirect();
    return true;
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
    if (this.data.scene === 'abolish') return this.showLocalVoidNotice();
    if (this._preparing || this._unloaded) return;
    this._preparing = true;
    this.setData({ loading: true, errorMessage: '', serviceCancelled: false, preparationAction: '', canRecoverPersonalIdentity: false });
    const token = getApp().globalData.token;
    const context = captureCompanyContext(getApp());
    try {
      if (!this.isPageContextCurrent()) throw new Error('登录或企业已变化，请返回当前企业重新发起');
      if (['contract', 'member'].includes(this.data.scene)) {
        this.setData({ canRecoverPersonalIdentity: true });
        let identity = await request({ url: '/fadada/users/me/identity', withCompany: false, token });
        if (this._unloaded || !isCompanyContextCurrent(getApp(), context)) return;
        if (identity && identity.providerEnabled && identity.status !== 'NOT_STARTED') {
          identity = await request({ url: '/fadada/users/me/identity/sync', method: 'POST', withCompany: false, token });
          if (this._unloaded || !isCompanyContextCurrent(getApp(), context)) return;
        }
        if (identity && identity.status && identity.status !== 'VERIFIED') {
          this.setData({ needsPersonalIdentity: true });
          this.showServiceError({ code: 46103 });
          return;
        }
        this.setData({ canRecoverPersonalIdentity: false });
      }
      this.setData({ needsPersonalIdentity: false });
      if (this.data.scene === 'contract') {
        const acceptedPrivacy = await this.confirmServicePrivacy(context);
        if (this._unloaded || !isCompanyContextCurrent(getApp(), context)) return;
        if (!acceptedPrivacy) { this.setData({ loading: false, serviceCancelled: true }); return; }
        await request({ url: `/contracts/${this.data.options.contractId}/signing/prerequisites`, method: 'POST',
          token: context.token, companyId: context.companyId, timeout: 30000 });
        if (this._unloaded || !isCompanyContextCurrent(getApp(), context)) return;
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
      // First onboarding must let the server check reusable enterprise consent
      // before asking the new applicant to enter the provider's grant flow.
      const companyOnboarding = this.data.scene === 'company' && this.data.options.onboarding === '1';
      const result = this.supplementaryOrganizationScene() || companyOnboarding ? null : await this.readAuthStatus(true);
      if (this._unloaded || token !== getApp().globalData.token
          || !isCompanyContextCurrent(getApp(), context)) return;
      if (result && (result.status === 'VERIFIED'
          || (this.data.scene === 'legal' && result.status === 'REVIEW_REQUIRED'))) {
        this.openReturnPage();
        return;
      }
      await this.loadServiceUrl();
    } catch (error) {
      if (!this._unloaded && isCompanyContextCurrent(getApp(), context)) {
        this.showServiceError(error);
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
    if (this.supplementaryOrganizationScene()) {
      // Only fresh organization evidence can finish supplementary consent.
      if (!forceSync && this._lastOrganizationCheck && Date.now() - this._lastOrganizationCheck < 30000) return null;
      this._lastOrganizationCheck = Date.now();
      return request({ url: `${url}/sync`, method: 'POST', withCompany: false, token, timeout: 15000 });
    }
    const current = await request({ url, withCompany: false, token, timeout: 15000 });
    if (this._unloaded || token !== getApp().globalData.token || !current
        || ['FAILED', 'NOT_STARTED'].includes(current.status)
        || (current.status === 'VERIFIED' && !(forceSync && current.providerEnabled))) return current;
    if (!forceSync && this._lastProviderSync && Date.now() - this._lastProviderSync < 30000) return current;
    this._lastProviderSync = Date.now();
    try {
      return await request({ url: `${url}/sync`, method: 'POST', withCompany: false, token, timeout: 15000 });
    } catch (error) {
      // A callback may have completed the identity while the provider query failed.
      const latest = await request({ url, withCompany: false, token, timeout: 15000 });
      if (latest && latest.status === 'VERIFIED' && !(forceSync && latest.providerEnabled)) return latest;
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
      context: captureCompanyContext(getApp()),
      issuedAt: Date.now() };
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
    this.mountServiceUrl(pending.url, pending.context, { issuedAt: pending.issuedAt, faceContinuation: true });
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
    if (this.data.scene === 'abolish') return this.showLocalVoidNotice();
    if (this._loadingServiceUrl || this._unloaded) return;
    this._loadingServiceUrl = true;
    const token = getApp().globalData.token;
    const context = captureCompanyContext(getApp());
    const { scene, options } = this.data;
    const config = SCENES[scene];
    this.pauseWebViewWatchdog();
    this._webViewSession = null;
    this.setData({ loading: true, serviceUrl: '', errorMessage: '', serviceCancelled: false,
      serviceResultReady: false, serviceResultTitle: '', serviceResultMessage: '', preparationAction: '' });
    try {
      if (!this.isPageContextCurrent()) throw new Error('登录或企业已变化，请返回当前企业重新发起');
      if (['member', 'sealGrant'].includes(scene) && String(options.companyId || '') !== context.companyId) {
        throw new Error('当前企业已变化，请返回当前企业重新办理');
      }
      if (scene === 'organization' && !getApp().globalData.isDesktopWechat) {
        throw new Error('电子签成员管理仅支持电脑端。请企业电子签超管在电脑端审批加入企业申请并分配用印权限，完成后返回合同重试。');
      }
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
      if (scene === 'organization') endpoint = `/fadada/companies/${options.companyId}/organization-manage-url`;
      if (scene === 'member') {
        if (!options.companyId) throw new Error('缺少本次同步的企业信息，请返回重试');
        endpoint = `/fadada/companies/${options.companyId}/signing-member/sync`;
      }
      if (scene === 'sealGrant') {
        if (!options.companyId || !options.userId) throw new Error('缺少本次授权的企业或成员信息，请返回重试');
        endpoint = options.contractId ? `/contracts/${options.contractId}/members/${options.userId}/seal-grant-url`
          : `/fadada/companies/${options.companyId}/members/${options.userId}/seal-grant-url`;
      }
      if (scene === 'contract') endpoint = `/contracts/${options.contractId}/sign-url`;
      if (!endpoint) throw new Error('服务参数不完整');
      const result = await request({
        url: endpoint,
        method: 'POST',
        token,
        data: {},
        withCompany: (scene === 'sealGrant' && !!options.contractId) || config.withCompany !== false,
        companyId: context.companyId,
        timeout: 30000
      });
      if (this._unloaded || token !== getApp().globalData.token
          || !isCompanyContextCurrent(getApp(), context)) return;
      const serviceUrl = result && (result.url || result.authUrl);
      const status = result && (result.status || (result.identity && result.identity.status));
      if (!serviceUrl && ['member', 'sealGrant'].includes(scene)) {
        if (status !== 'READY') throw new Error(scene === 'member'
          ? '成员激活尚未完成，请稍后重新同步' : '签署授权尚未完成，请返回成员列表重新办理');
        clearServiceRecovery(getApp(), scene, options);
        if (this.finishSigningPrerequisite()) return;
        this.setData({ serviceResultReady: true,
          serviceResultTitle: scene === 'member' ? '电子签成员已同步' : '签署授权已就绪',
          serviceResultMessage: scene === 'member'
            ? '本人已加入当前电子签企业。签署合同仍需有效用印授权，可请有印章管理权限的管理员在“组织成员 → 授权签署”办理。'
            : options.contractId ? '该成员已具备这份合同所用印章的有效授权，可返回原合同继续签署。授权有效期内可复用。'
              : '该成员已有有效用印授权，可在授权有效期内重复签署。每次签署仍会核验当前权限。' });
        clearServiceRecovery(getApp(), scene, options);
        return;
      }
      if (!serviceUrl && scene === 'company' && status === 'AUTHORIZATION_REQUIRED') {
        this.setData({ options: { ...options, renewOrganization: '1' } });
        this.showServiceError({ code: 46101,
          message: '企业认证已保留，请电子签平台企业超管完成对商签通的一次签署授权，其他员工无需逐人重复办理企业授权。' });
        return;
      }
      if (!serviceUrl && scene === 'company' && status === 'IDENTITY_VERIFICATION_REQUIRED') {
        let identity = {};
        try {
          identity = await request({ url: `/fadada/companies/${options.companyId}/identity`,
            withCompany: false, token, timeout: 15000 });
        } catch (error) {
          // The preflight already confirmed reusable company authorization.
          // A failed detail read must not reopen the provider authorization page.
        }
        if (this._unloaded || token !== getApp().globalData.token
            || !isCompanyContextCurrent(getApp(), context)) return;
        if (identity && identity.status === 'VERIFIED') {
          this.openReturnPage();
          return;
        }
        this.showCompanyIdentityReview(identity || {});
        return;
      }
      if (!serviceUrl && status && ['personal', 'company', 'legal'].includes(scene)) {
        this.openReturnPage();
        return;
      }
      if (!serviceUrl) throw new Error('未获取到服务地址');
      this.mountServiceUrl(serviceUrl, context);
      this.startStatusPolling();
    } catch (error) {
      if (!this._unloaded && isCompanyContextCurrent(getApp(), context)) {
        this.showServiceError(error);
      }
    } finally {
      this._loadingServiceUrl = false;
      if (!this._unloaded) this.setData({ loading: false });
    }
  },

  mountServiceUrl(url, context = captureCompanyContext(getApp()), ticket = {}) {
    if (this.data.scene === 'abolish') return this.showLocalVoidNotice();
    this.pauseWebViewWatchdog();
    const generation = (this._webViewGeneration || 0) + 1;
    this._webViewGeneration = generation;
    this._webViewSession = { generation, url, context, token: getApp().globalData.token,
      remaining: WEB_VIEW_LOAD_TIMEOUT, loaded: false,
      issuedAt: ticket.issuedAt == null ? Date.now() : ticket.issuedAt,
      faceContinuation: !!ticket.faceContinuation };
    rememberServiceRecovery(getApp(), this.data.scene, this.data.options);
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
    // Resource editors stay open; an existing resource does not mean editing is complete.
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
    if (!this.isPollingCurrent(generation) || !['personal', 'company', 'legal'].includes(this.data.scene)) return;
    this.pollTimer = null;
    const token = getApp().globalData.token;
    const context = captureCompanyContext(getApp());
    try {
      const result = await this.readAuthStatus();
      if (!this.isPollingCurrent(generation) || !isCompanyContextCurrent(getApp(), context) || !this.isPageContextCurrent()) return;
      // Missing authorization is expected before the user finishes this form.
      // failureReason can also contain cached query errors; it is not completion.
      const completed = this.supplementaryOrganizationScene()
        ? !!result && result.organizationAuthorized === true
        : !!(result && (['VERIFIED', 'FAILED'].includes(result.status)
          || (this.data.scene === 'legal' && result.status === 'REVIEW_REQUIRED')));
      if (completed) {
        this.openReturnPage();
        return;
      }
    } catch (error) {
      // Keep the provider page open while transient status queries fail.
    }
    if (!this.isPollingCurrent(generation) || token !== getApp().globalData.token || !this.isPageContextCurrent()) return;
    this.pollAttempts = Math.min((this.pollAttempts || 0) + 1, 120);
    this.scheduleStatusPoll(generation);
  },

  openReturnPage() {
    if (this._unloaded || this._visible === false || this._returning) return;
    if (!this.isPageContextCurrent()) return this.showServiceError(new Error('登录或企业已变化，请返回当前企业重新发起'));
    this._returning = true;
    this.stopStatusPolling();
    this.pauseWebViewWatchdog();
    const token = getApp().globalData.token;
    const { scene, options } = this.data;
    const query = [`scene=${scene}`];
    if (this.supplementaryOrganizationScene()) query.push('renewOrganization=1');
    if (options.flow === 'company-create') query.push('flow=company-create');
    if (options.companyId) query.push(`companyId=${encodeURIComponent(options.companyId)}`);
    if (options.contractId) query.push(`contractId=${encodeURIComponent(options.contractId)}`);
    if (options.continuationId) query.push(`continuationId=${encodeURIComponent(options.continuationId)}`);
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
    if (this._reloadingWebView || this._pendingFaceReturn || this._faceRemounting) return;
    const session = this._webViewSession;
    if (!this.isWebViewSessionCurrent(session)) return this.prepareService();
    const shortTicket = ['contract', 'member', 'sealGrant'].includes(this.data.scene);
    const expired = shortTicket && Date.now() - session.issuedAt >= SHORT_TICKET_LIFETIME;
    const used = this.data.scene === 'contract' && session.loaded && !session.faceContinuation;
    if (expired || used) {
      this._webViewSession = null;
      return this.prepareService();
    }
    this._reloadingWebView = true;
    this.pauseWebViewWatchdog();
    // Recreate the failed container with the same URL; another enrollment URL can
    // restart a provider flow and contribute to its request-frequency limit.
    this.setData({ loading: true, serviceUrl: '', errorMessage: '' }, () => {
      this._reloadingWebView = false;
      if (this._unloaded || session !== this._webViewSession
          || session.token !== getApp().globalData.token
          || !isCompanyContextCurrent(getApp(), session.context)) return;
      this.mountServiceUrl(session.url, session.context, session);
      this.setData({ loading: false });
      this.startStatusPolling();
    });
  },
  continuePersonalIdentity() {
    if (this._openingPrerequisite || !this.isPageContextCurrent()) return;
    const continuationId = createSigningContinuation(getApp(), this.data.scene, this.data.options);
    if (!continuationId) {
      this.setData({ errorMessage: '登录或企业状态已变化，请返回重新办理' });
      return;
    }
    this._awaitingSigningPrerequisite = { id: continuationId, context: captureCompanyContext(getApp()) };
    this._openingPrerequisite = true;
    wx.navigateTo({ url: `/pages/personal-cert/personal-cert?continuationId=${encodeURIComponent(continuationId)}`,
      fail: () => { this._openingPrerequisite = false; this._awaitingSigningPrerequisite = null; } });
  },
  canManageContractSeal() {
    const permissions = (getApp().globalData.memberInfo || {}).permissions || [];
    return permissions.includes('all') || (permissions.includes('seal_manage')
      && (permissions.includes('member_manage') || permissions.includes('auth_manage')));
  },
  openContractSealAuthorization() {
    if (!this.data.options.contractId || !this.canManageContractSeal()) return;
    wx.navigateTo({ url: `/pages/auth-manage/auth-manage?contractId=${encodeURIComponent(this.data.options.contractId)}` });
  },
  checkResult() {
    if (['member', 'sealGrant'].includes(this.data.scene)) {
      return this.loadServiceUrl();
    }
    if (this.data.scene === 'organization') {
      wx.switchTab({ url: '/pages/company/company' });
      return;
    }
    this.openReturnPage();
  },
  goBack() {
    if (this.data.scene === 'abolish' && this.data.options.contractId && this.isPageContextCurrent()) {
      wx.redirectTo({ url: `/pages/contract-preview/contract-preview?contractId=${encodeURIComponent(this.data.options.contractId)}` });
      return;
    }
    if (this.data.serviceResultReady && this.finishSigningPrerequisite()) return;
    wx.navigateBack();
  }
});
