const { request } = require('../../utils/request');
const { returnToCompany } = require('../../utils/companyOnboarding');
const { captureCompanyContext, isCompanyContextCurrent } = require('../../utils/companyContext');
const { signingContinuation, resumeSigningContinuation, clearSigningContinuation, clearServiceRecovery } = require('../../utils/signingContinuation');

// Existing identity responses put temporary provider-query errors in failureReason.
// They can remain cached for 30 seconds after successful provider authorization.
const AUTH_QUERY_PENDING = {
  personal: [
    '尚未查询到个人授权，请完成认证页面的全部步骤后再刷新',
    '认证查询过于频繁，请稍后再刷新'
  ],
  company: [
    '尚未查询到当前企业的授权记录，请稍后刷新；如已开通，请联系管理员核对授权关联',
    '认证查询过于频繁，请至少等待30秒后刷新'
  ]
};
const MAX_SYNC_ATTEMPTS = 24;
const MAX_SIGNATURE_SYNC_ATTEMPTS = 6;

function contractSigningReturned(result) {
  if (!result) return false;
  const status = String(result.status || '').toLowerCase();
  if (['sign_completed', 'task_finished', 'task_terminated', 'expired', 'task_expired',
    'revoked', 'voided_local'].includes(status)) return true;
  return result.canSign === false && [result.initiatorSignStatus, result.counterpartySignStatus]
    .some(value => ['signed', 'sign_completed', 'completed'].includes(String(value || '').toLowerCase()));
}

function supplementaryOrganization(options = {}) {
  return options.scene === 'company' && options.renewOrganization === '1';
}

Page({
  data: {
    title: '正在继续办理',
    message: '请稍候',
    loading: true,
    failed: false,
    reviewRequired: false,
    countdown: 1,
    options: {},
    continuingBusiness: false,
    supplementaryOrganization: false
  },

  onLoad(options) {
    const app = getApp();
    this._resultContext = captureCompanyContext(app);
    // The provider's fixed company route does not carry our prerequisite flags.
    // Recover them only from the current company's own authenticated page.
    if (options.scene === 'company' && options.companyId) {
      const source = getCurrentPages().slice(0, -1).reverse().find(page => {
        const original = page.data && page.data.options;
        return page.route === 'pages/fadada-auth/fadada-auth' && page.data && page.data.scene === 'company'
          && original && String(original.companyId || '') === String(options.companyId)
          && page._sessionToken === app.globalData.token && page._signingContext
          && isCompanyContextCurrent(app, page._signingContext);
      });
      if (source) {
        const original = source.data.options;
        if (original.renewOrganization === '1') options = { ...options, renewOrganization: '1' };
        // Keep an expired original nonce visible as expired rather than silently
        // treating its callback as a standalone enterprise onboarding result.
        if (original.continuationId) options = { ...options, continuationId: original.continuationId };
      }
    }
    // Fadada returns to a fixed personal result route. Recover company continuation
    // from our own page stack, never from the provider's claimed auth result.
    if (options.scene === 'personal' && !options.flow) {
      const source = getCurrentPages().slice(0, -1).reverse().find(page =>
        page.route === 'pages/personal-cert/personal-cert');
      if (source && source._companyFlow && source._flowToken === getApp().globalData.token) {
        options = { ...options, flow: 'company-create',
          companyId: (source._returnOptions || {}).companyId || '' };
      } else if (source && source._legalClaimCompanyId && source._flowToken === app.globalData.token) {
        options = { ...options, flow: 'legal-claim', companyId: source._legalClaimCompanyId };
      }
      if (source && source._identityContinuationId
          && signingContinuation(getApp(), source._identityContinuationId)) {
        options = { ...options, continuationId: source._identityContinuationId };
      }
    }
    this.setData({ options, continuingBusiness: !!options.continuationId,
      supplementaryOrganization: options.scene === 'company' && options.renewOrganization === '1' });
    this.syncResult();
  },

  supplementaryOrganizationScene() {
    return supplementaryOrganization(this.data.options);
  },

  resultContextCurrent() {
    if (this._unloaded || (this._resultToken !== undefined && this._resultToken !== getApp().globalData.token)) return false;
    const options = this.data.options || {};
    return !this._resultContext || (!options.continuationId && !this.supplementaryOrganizationScene()
      && !['contract', 'abolish', 'member', 'sealGrant'].includes(options.scene))
      || isCompanyContextCurrent(getApp(), this._resultContext);
  },

  onUnload() {
    this._unloaded = true;
    if (this.returnTimer) clearTimeout(this.returnTimer);
    if (this.syncTimer) clearTimeout(this.syncTimer);
  },

  onHide() {
    this._hidden = true;
    if (this.returnTimer) clearTimeout(this.returnTimer);
    if (this.syncTimer) clearTimeout(this.syncTimer);
  },

  onShow() {
    this._hidden = false;
    if (this._successReady && !this._navigating) this.startCountdown();
    if (this._awaitingResult) this.scheduleResultSync();
  },

  scheduleResultSync() {
    if (this.syncTimer) clearTimeout(this.syncTimer);
    if (this._hidden || !this.resultContextCurrent()) return;
    this.syncTimer = setTimeout(() => {
      if (this._hidden || !this.resultContextCurrent()) return;
      return this.syncResult();
    }, 2500);
  },

  retrySync() {
    if (this._syncing || this._unloaded) return;
    this._syncAttempts = 0;
    this._signatureSyncAttempts = 0;
    return this.syncResult();
  },

  startCountdown() {
    if (this.returnTimer) clearTimeout(this.returnTimer);
    this._successReady = true;
    if (this._hidden || !this.resultContextCurrent()) return;
    if ((this.data.options || {}).continuationId || ['personal', 'company', 'contract'].includes((this.data.options || {}).scene)) {
      // The server has confirmed the result; continue without a second success screen.
      this._successReady = false;
      this.goBusinessPage();
      return;
    }
    this.returnTimer = setTimeout(() => {
      if (this._hidden || !this.resultContextCurrent()) return;
      const countdown = this.data.countdown - 1;
      this.setData({ countdown });
      if (countdown <= 0) this.goBusinessPage();
      else this.startCountdown();
    }, 1000);
  },

  async syncResult() {
    if (this._syncing || this._unloaded) return;
    if (!this._resultContext) this._resultContext = captureCompanyContext(getApp());
    if (!this.resultContextCurrent()) {
      this.setData({ loading: false, failed: true, title: '原办理会话已失效',
        message: '登录或企业已变化，请返回当前企业重新发起' });
      return;
    }
    if ((this.data.options || {}).scene === 'abolish') {
      const { continuationId, ...options } = this.data.options;
      clearSigningContinuation(getApp(), continuationId);
      clearServiceRecovery(getApp(), 'abolish', options);
      this._awaitingResult = false;
      if (this.syncTimer) clearTimeout(this.syncTimer);
      this.setData({ options, continuingBusiness: false, loading: false, failed: false, countdown: 5,
        title: '合同作废流程已更新', message: '请返回合同详情查看作废申请和处理结果。' });
      this.startCountdown();
      return;
    }
    this._syncing = true;
    const token = this._resultToken = getApp().globalData.token;
    const current = () => token === getApp().globalData.token && this.resultContextCurrent();
    this._successReady = false;
    this._awaitingResult = false;
    if (this.returnTimer) clearTimeout(this.returnTimer);
    if (this.syncTimer) clearTimeout(this.syncTimer);
    const options = this.data.options || {};
    this.setData({ loading: true, reviewRequired: false, countdown: ['personal', 'company'].includes(options.scene) ? 1 : 5 });
    try {
      const continuation = options.continuationId && signingContinuation(getApp(), options.continuationId);
      if (options.continuationId && !continuation) {
        throw new Error('原办理会话已失效，登录或企业已变化，请返回当前企业重新发起');
      }
      if (options.scene === 'company' && continuation
          && String(options.companyId || '') !== continuation.context.companyId) {
        throw new Error('当前企业已变化，请返回当前企业重新办理');
      }
      let result;
      if (options.scene === 'personal') {
        result = await this.readAuthenticationResult('/fadada/users/me/identity', options.scene, token);
      } else if (options.scene === 'legal') {
        if (!options.companyId) throw new Error('缺少本次核验的企业信息，请返回重试');
        result = await request({ url: `/fadada/companies/${options.companyId}/legal-representative/sync`,
          method: 'POST', withCompany: false, token });
      } else if (options.scene === 'company' || options.scene === 'seal') {
        if (!options.companyId) throw new Error('缺少本次认证的企业信息，请返回企业认证页面重试');
        result = await this.readAuthenticationResult(
          `/fadada/companies/${options.companyId}/identity`, options.scene, token);
      } else if (options.scene === 'contract') {
        result = await request({ url: `/contracts/${options.contractId}/signing/sync`, method: 'POST', token });
      }
      if (!current()) return;
      if (options.scene === 'contract' && !contractSigningReturned(result)) {
        // The provider can return before its signed callback arrives. Confirm
        // the exact contract instead of accepting a generic success parameter.
        if ((this._signatureSyncAttempts || 0) < MAX_SIGNATURE_SYNC_ATTEMPTS) {
          this._signatureSyncAttempts = (this._signatureSyncAttempts || 0) + 1;
          this._awaitingResult = true;
          this.setData({ loading: true, failed: false, title: '正在确认合同签署状态',
            message: '正在核对当前合同的签署记录，请稍候' });
          this.scheduleResultSync();
          return;
        }
        this.setData({ loading: false, failed: true, title: '签署状态待确认',
          message: '当前合同尚未收到我方签署完成记录。若已在服务页面完成签署，可重新同步，或返回合同查看双方签署进度。' });
        return;
      }
      if (this.supplementaryOrganizationScene() && !this.authenticationCompleted(result, options.scene)) {
        this.setData({ loading: false, failed: true, title: '企业授权尚未确认',
          message: (result && result.failureReason)
            || '尚未确认电子签成员授权，请确认已完成授权后重新核验。原业务已保留，无需重复创建企业或合同。' });
        return;
      }
      if (options.scene === 'legal' && result && result.status === 'REVIEW_REQUIRED') {
        this.setData({ loading: false, failed: true, reviewRequired: true,
          title: '需补充法人身份核验',
          message: result.message || '尚未确认本人法人身份，请返回法人身份记录页联系平台支持补充核验。' });
        return;
      }
      if (['personal', 'company', 'seal', 'legal'].includes(options.scene)
          && !this.authenticationCompleted(result, options.scene)) {
        // The native redirect may arrive before the signed callback has been applied.
        // Wait briefly for server confirmation; query parameters never prove success.
        const queryPending = result && result.status === 'IN_PROGRESS'
          && (AUTH_QUERY_PENDING[options.scene] || []).includes(result.failureReason);
        if (['personal', 'company'].includes(options.scene) && result
            && result.status === 'IN_PROGRESS' && (!result.failureReason || queryPending)
            && (this._syncAttempts || 0) < MAX_SYNC_ATTEMPTS) {
          this._syncAttempts = (this._syncAttempts || 0) + 1;
          this._awaitingResult = true;
          this.setData({ loading: true, failed: false, title: '正在接收认证结果',
            message: '收到结果后将自动继续，无需重复认证' });
          this.scheduleResultSync();
          return;
        }
        this.setData({ loading: false, failed: true,
          title: result && result.status === 'FAILED' ? '认证未通过' : '处理结果待确认',
          message: queryPending
            ? (options.scene === 'company'
              ? '企业授权结果仍未同步。系统会先核对可复用的企业授权及本人的企业身份依据；确实缺少授权时，按服务页面提供的方式办理。已完成授权可稍后重新同步，也可从“企业 → 待完成企业认证”继续办理，无需重新创建企业。'
              : '个人授权结果仍未同步。如认证页面已显示开通成功，请稍后重新同步，无需反复提交认证；持续未恢复请联系管理员核验')
            : (result && (result.failureReason || result.message || result.statusText)) || '结果尚未更新，请稍后刷新' });
        return;
      }
      if (options.scene === 'company' && options.continuationId) {
        this.setData({ loading: false, failed: false, title: '企业授权已完成',
          message: '授权已确认，正在继续原业务' });
        this.startCountdown();
        return;
      }
      if (this.supplementaryOrganizationScene()) {
        // Standalone onboarding may still have no active enterprise, or a
        // different one. Only a signing continuation must avoid switching.
        if (String(options.companyId) !== String(getApp().globalData.currentCompanyId || '')) {
          await getApp().switchCompany(options.companyId);
          if (this._unloaded || token !== getApp().globalData.token) return;
          this._resultContext = captureCompanyContext(getApp());
        }
        this.setData({ loading: false, failed: false, title: '企业授权已完成',
          message: '授权已确认，即将返回企业中心' });
        this.startCountdown();
        return;
      }
      if (options.scene === 'company') {
        await getApp().switchCompany(options.companyId);
        if (!current()) return;
        this._companyCompleted = true;
        this.setData({ loading: false, failed: false, title: '企业认证成功', message: '已切换到本次认证企业，即将进入企业中心' });
        this.startCountdown();
        return;
      }
      if (options.scene === 'legal') {
        await getApp().loadMe();
        if (!current()) return;
      }
      if (options.scene === 'contract' && result
          && ['task_finished', 'revoked'].includes(result.status)) clearServiceRecovery(getApp(), options.scene, options);
      this.setData({
        loading: false,
        failed: false,
        title: options.scene === 'personal' ? '个人认证成功' : '处理结果已同步',
        message: options.scene === 'personal' ? (options.flow === 'company-create'
          ? '实名身份已确认，即将继续企业开通流程' : options.flow === 'legal-claim'
            ? '实名身份已确认，即将继续法人认领' : '实名身份已确认，即将进入首页') : (result && (result.statusText || result.status)) || '你可以返回业务页面继续操作'
      });
      if (current()) this.startCountdown();
    } catch (error) {
      if (!current()) return;
      this.setData({
        loading: false,
        failed: true,
        title: '结果同步暂未完成',
        message: error.message || '稍后返回业务页面刷新即可'
      });
    } finally {
      this._syncing = false;
    }
  },

  authenticationCompleted(result, scene) {
    if (scene === 'company' && supplementaryOrganization(this.data && this.data.options)) {
      return !!result && result.status === 'VERIFIED' && result.organizationAuthorized === true;
    }
    return scene === 'seal'
      ? Number(result && result.enabledSealCount || 0) > 0
      : !!result && result.status === 'VERIFIED';
  },

  async readAuthenticationResult(url, scene, token = getApp().globalData.token) {
    // These endpoints authorize the user against the company in the URL, including pending claims.
    const options = { url, withCompany: false, token };
    // A stored VERIFIED identity can predate the organization permission.
    // Always ask the provider through the server; do not fall back to cached success.
    if (scene === 'company' && supplementaryOrganization(this.data && this.data.options)) {
      return request({ ...options, url: `${url}/sync`, method: 'POST' });
    }
    const current = await request(options);
    if (this._unloaded || token !== getApp().globalData.token) return null;
    if (this.authenticationCompleted(current, scene)) return current;
    try {
      return await request({ ...options, url: `${url}/sync`, method: 'POST' });
    } catch (error) {
      if (this._unloaded || token !== getApp().globalData.token) return null;
      // A callback or another request may have committed success while this sync failed.
      try {
        const latest = await request(options);
        if (this.authenticationCompleted(latest, scene)) return latest;
      } catch (readError) {}
      throw error;
    }
  },

  goBusinessPage() {
    if (this.data.loading || this._navigating || !this.resultContextCurrent()) return;
    if (this.returnTimer) clearTimeout(this.returnTimer);
    const options = this.data.options || {};
    if (options.continuationId && (!this.data.failed || this.supplementaryOrganizationScene())) {
      this.continueOriginalBusiness();
      return;
    }
    if (options.scene === 'legal') {
      wx.redirectTo({ url: `/pages/legal-representative/legal-representative?companyId=${encodeURIComponent(options.companyId || '')}` });
      return;
    }
    if (options.scene === 'personal') {
      if (options.flow === 'legal-claim' && options.companyId && !this.data.failed) {
        wx.redirectTo({ url: `/pages/legal-representative/legal-representative?companyId=${encodeURIComponent(options.companyId)}&claim=1` });
        return;
      }
      if (!this.data.failed && options.flow !== 'company-create') {
        wx.switchTab({ url: '/pages/index/index' });
        return;
      }
      if (options.flow === 'company-create' && !this.data.failed) {
        returnToCompany(options);
        return;
      }
      const query = ['company-create', 'legal-claim'].includes(options.flow)
        ? `?flow=${options.flow}${options.companyId ? '&companyId=' + encodeURIComponent(options.companyId) : ''}`
        : options.continuationId && signingContinuation(getApp(), options.continuationId)
          ? `?continuationId=${encodeURIComponent(options.continuationId)}` : '';
      wx.redirectTo({ url: `/pages/personal-cert/personal-cert${query}` });
      return;
    }
    if (options.scene === 'company' || options.scene === 'seal') {
      if (this.supplementaryOrganizationScene()) {
        wx.switchTab({ url: '/pages/company/company' });
        return;
      }
      if (this._companyCompleted) {
        wx.switchTab({ url: '/pages/company/company' });
        return;
      }
      if (!options.companyId) {
        wx.switchTab({ url: '/pages/index/index' });
        return;
      }
      const query = `companyId=${encodeURIComponent(options.companyId)}`;
      wx.redirectTo({ url: `/pages/company-cert/company-cert?${query}${options.scene === 'company' ? '&autoSwitch=1' : ''}` });
      return;
    }
    if (options.contractId) {
      wx.redirectTo({ url: `/pages/contract-preview/contract-preview?contractId=${options.contractId}` });
      return;
    }
    wx.switchTab({ url: '/pages/index/index' });
  },

  continueOriginalBusiness() {
    const id = (this.data.options || {}).continuationId;
    const destination = resumeSigningContinuation(getApp(), id, getCurrentPages());
    if (!destination) {
      this.setData({ loading: false, failed: true, title: '原办理会话已失效',
        message: '登录或企业已变化，请返回当前企业重新发起' });
      return;
    }
    this._navigating = true;
    const navigation = {
      success: () => { if (!destination.delta) clearSigningContinuation(getApp(), id); },
      fail: () => {
        this._navigating = false;
        this.setData({ loading: false, failed: true, title: '继续办理暂未完成',
          message: '原业务已保留，请重试继续办理' });
      }
    };
    if (destination.delta) wx.navigateBack({ ...navigation, delta: destination.delta });
    else wx.redirectTo({ ...navigation, url: destination.url });
  }
});
