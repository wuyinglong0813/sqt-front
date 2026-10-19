const { captureCompanyContext, isCompanyContextCurrent } = require('./companyContext');

const SCENES = ['contract', 'abolish', 'member', 'sealGrant', 'company'];

function createSigningContinuation(app, scene, options = {}) {
  // A prerequisite can itself need authentication. Keep the first business
  // operation rather than replacing it with the intermediate prerequisite.
  if (options.continuationId) return signingContinuation(app, options.continuationId) ? options.continuationId : '';
  if (!SCENES.includes(scene)) return '';
  const context = captureCompanyContext(app);
  if (!context.token || (!context.companyId && scene !== 'company')) return '';
  const target = { scene };
  if (scene === 'company') {
    if (!options.companyId) return '';
    target.companyId = String(options.companyId);
    if (options.renewOrganization === '1') target.renewOrganization = '1';
  } else if (scene === 'member' || scene === 'sealGrant') {
    target.companyId = context.companyId;
    if (scene === 'sealGrant') {
      if (!options.userId) return '';
      target.userId = String(options.userId);
      if (options.contractId) target.contractId = String(options.contractId);
    }
  }
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

// The caller owns navigation. A waiting original page resumes onShow; otherwise
// recreate only our allow-listed business route, never a provider return URL.
function resumeSigningContinuation(app, id, pages = []) {
  const pending = signingContinuation(app, id);
  if (!pending) return null;
  const target = pending.target;
  let index = -1;
  for (let i = pages.length - 2; i >= 0; i--) {
    const page = pages[i];
    const waiting = page._awaitingSigningPrerequisite;
    if (page.route === 'pages/fadada-auth/fadada-auth' && page.data && page.data.scene === target.scene
        && page._sessionToken === pending.context.token && page._signingContext
        && isCompanyContextCurrent(app, page._signingContext)
        && waiting && waiting.id === id && isCompanyContextCurrent(app, waiting.context)
        && ['companyId', 'contractId', 'userId', 'reason', 'renewOrganization'].every(key =>
          String((page.data.options || {})[key] || '') === String(target[key] || ''))) {
      index = i;
      break;
    }
  }
  return { url: signingContinuationUrl(app, id), delta: index < 0 ? 0 : pages.length - 1 - index };
}

function clearSigningContinuation(app, id) {
  if (app._signingIdentityContinuation && app._signingIdentityContinuation.id === id) {
    delete app._signingIdentityContinuation;
  }
}

function rememberServiceRecovery(app, scene, options) {
  if (!['contract', 'abolish', 'member', 'sealGrant'].includes(scene)) return;
  const target = { scene };
  for (const key of ['companyId', 'contractId', 'userId', 'reason', 'continuationId']) {
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

module.exports = { createSigningContinuation, signingContinuation, signingContinuationUrl, resumeSigningContinuation,
  signingContinuationDestination: resumeSigningContinuation, clearSigningContinuation,
  rememberServiceRecovery, serviceRecovery, serviceRecoveryUrl, clearServiceRecovery };
