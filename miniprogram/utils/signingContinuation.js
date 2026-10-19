const { captureCompanyContext, isCompanyContextCurrent } = require('./companyContext');

const SCENES = ['contract', 'abolish', 'member'];

function createSigningContinuation(app, scene, options) {
  if (!SCENES.includes(scene)) return '';
  const context = captureCompanyContext(app);
  if (!context.token || !context.companyId) return '';
  const target = { scene };
  if (scene === 'member') target.companyId = context.companyId;
  else {
    if (!options.contractId) return '';
    target.contractId = String(options.contractId);
    if (scene === 'abolish' && options.reason) target.reason = String(options.reason);
  }
  const id = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
  app._signingIdentityContinuation = { id, context, target };
  return id;
}

function signingContinuation(app, id) {
  const pending = app._signingIdentityContinuation;
  return pending && pending.id === id && SCENES.includes(pending.target.scene)
    && isCompanyContextCurrent(app, pending.context) ? pending : null;
}

function signingContinuationUrl(app, id) {
  const pending = signingContinuation(app, id);
  if (!pending) return '';
  return '/pages/fadada-auth/fadada-auth?' + Object.keys(pending.target)
    .map(key => `${key}=${encodeURIComponent(pending.target[key])}`).join('&');
}

function clearSigningContinuation(app, id) {
  if (app._signingIdentityContinuation && app._signingIdentityContinuation.id === id) {
    delete app._signingIdentityContinuation;
  }
}

function rememberServiceRecovery(app, scene, options) {
  if (!['contract', 'abolish', 'member', 'sealGrant'].includes(scene)) return;
  const target = { scene };
  for (const key of ['companyId', 'contractId', 'userId', 'reason']) {
    if (options[key]) target[key] = String(options[key]);
  }
  app._fadadaServiceRecovery = { context: captureCompanyContext(app), target };
}

function serviceRecovery(app) {
  const pending = app._fadadaServiceRecovery;
  return pending && isCompanyContextCurrent(app, pending.context) ? pending : null;
}

function serviceRecoveryUrl(app) {
  const pending = serviceRecovery(app);
  return pending ? '/pages/fadada-auth/fadada-auth?' + Object.keys(pending.target)
    .map(key => `${key}=${encodeURIComponent(pending.target[key])}`).join('&') : '';
}

function clearServiceRecovery(app, scene, options) {
  const pending = serviceRecovery(app);
  if (pending && pending.target.scene === scene
      && ['companyId', 'contractId', 'userId'].every(key => String(pending.target[key] || '') === String(options[key] || ''))) {
    delete app._fadadaServiceRecovery;
  }
}

module.exports = { createSigningContinuation, signingContinuation, signingContinuationUrl, clearSigningContinuation,
  rememberServiceRecovery, serviceRecovery, serviceRecoveryUrl, clearServiceRecovery };
