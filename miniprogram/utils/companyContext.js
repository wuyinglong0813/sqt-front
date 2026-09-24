// A response belongs to the session and company in which it was requested.
// A -> B -> A still invalidates the original A response through generation.
function captureCompanyContext(app) {
  const data = app.globalData;
  return {
    token: data.token || '',
    companyId: String(data.currentCompanyId || ''),
    generation: app._companyAccessGeneration || 0
  };
}

function isCompanyContextCurrent(app, context) {
  const current = captureCompanyContext(app);
  return context.token === current.token && context.companyId === current.companyId
    && context.generation === current.generation;
}

module.exports = { captureCompanyContext, isCompanyContextCurrent };
