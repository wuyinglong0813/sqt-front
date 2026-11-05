'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};
const tick = () => new Promise(resolve => setImmediate(resolve));
function startRestoration(app, promise) {
  const refresh = promise.finally(() => {
    if (app._sessionRefresh === refresh) app._sessionRefresh = null;
  });
  app._sessionReady = app._sessionRefresh = refresh;
  return refresh;
}
function profile(companyId = '3', permissions = ['all']) {
  return {
    user: { id: '7', currentCompanyId: companyId },
    member: { userId: '7', roleCode: 'ADMIN', roleText: '管理员', memberStatus: 'ACTIVE', permissions },
    company: { id: companyId, name: `企业${companyId}`, creditCode: '91330000TEST12345', certificationStatus: 'VERIFIED' },
    companies: [{ companyId, companyName: `企业${companyId}`, roleCode: 'ADMIN' }]
  };
}
function harness(handler) {
  let page;
  const calls = [], patches = [];
  const initial = profile();
  const app = {
    _sessionReady: Promise.resolve(initial.user),
    globalData: { token: 'session', currentCompanyId: '3', userInfo: initial.user,
      memberInfo: initial.member, companies: initial.companies },
    ensureSessionReady: () => app._sessionRefresh || Promise.resolve(app.globalData.userInfo),
    applyMePayload(payload) {
      Object.assign(this.globalData, { userInfo: payload.user, memberInfo: payload.member,
        currentCompanyId: String(payload.user.currentCompanyId || ''), companies: payload.companies || [] });
    }
  };
  const defaults = options => {
    if (options.url === '/me') return profile(app.globalData.currentCompanyId);
    if (options.url.startsWith('/authorizations')) return { total: 18 };
    if (options.url.startsWith('/roles')) return [{ id: 'role' }];
    if (options.url.startsWith('/contract-templates')) return { total: 5 };
    if (options.url.endsWith('/signing-readiness')) return { status: 'READY' };
    return [];
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../pages/company/company.js'), 'utf8'), {
    Page: value => { page = value; }, getApp: () => app,
    wx: { getStorageSync() {}, stopPullDownRefresh() {} },
    require: id => {
      if (id.endsWith('/request')) return { request: async options => { calls.push(options); return handler ? handler(options, defaults) : defaults(options); } };
      if (id.endsWith('/companyContext')) return require('../utils/companyContext');
      if (id.endsWith('/companyOnboarding')) return { readDraft: () => null };
      if (id.endsWith('/signingContinuation')) return { serviceRecovery: () => null };
      if (id.endsWith('/tabBar')) return { syncTabBar() {}, setTabBarHidden() {} };
      if (id.endsWith('/memberApplications')) return require('./member-applications-fixture');
      if (id.endsWith('/invitation')) return {};
      if (id.endsWith('/dict')) return { certification: status => ({ text: status === 'VERIFIED' ? '已认证' : '待认证' }) };
      throw new Error(id);
    }
  });
  page.setData = values => { patches.push(values); Object.assign(page.data, values); };
  return { page, app, calls, patches };
}

test('enterprise tab waits for a server-confirmed profile before restoring enterprise data', async () => {
  const me = deferred();
  const h = harness((options, defaults) => options.url === '/me' ? me.promise : defaults(options));
  assert.equal(h.page.data.companyInitializing, true);
  const pending = h.page.onShow();
  assert.equal(h.page.data.isLoggedIn, true);
  assert.equal(h.page.data.hasCompany, false);
  assert.equal(h.page.data.company.name, undefined);
  assert.equal(h.page.data.companySummaryOnly, false);
  assert.equal(h.page.data.companyInitializing, true);
  assert.equal(h.page.data.memberCount, null);
  assert.equal(h.page.data.canManage, false);
  await tick();
  me.resolve(profile());
  await pending;
  assert.equal(h.page.data.companySummaryOnly, false);
  assert.equal(h.page.data.certCompleted, true);
  assert.equal(h.page.data.memberCount, 18);
});

test('cold restoration keeps a loading view and shares the restored profile instead of issuing a second me request', async () => {
  const restoration = deferred();
  const side = deferred();
  const h = harness((options, defaults) => options.url === '/me/company-certification-applications' ? side.promise : defaults(options));
  h.app.globalData.userInfo = null; h.app.globalData.memberInfo = null; h.app.globalData.companies = [];
  startRestoration(h.app, restoration.promise);
  const pending = h.page.onShow();
  assert.equal(h.page.data.companyInitializing, true);
  assert.equal(h.page.data.companyReady, false);
  assert.equal(h.calls.length, 0);
  const restored = profile();
  h.app.applyMePayload(restored); restoration.resolve(restored);
  await tick();
  assert.equal(h.calls.some(options => options.url === '/me'), false);
  assert.equal(h.page.data.companyReady, true);
  assert.equal(h.page.data.company.name, '企业3');
  assert.equal(h.page.data.companySummaryOnly, false);
  assert.equal(h.page.data.memberCount, 18, 'slow applications do not block statistics or the enterprise card');
  side.resolve([]); await pending;
});

test('matching tab re-entry retains the complete view until background profile and auxiliary reads finish', async () => {
  const me = deferred(), auxiliary = deferred();
  let refresh = false;
  const initialTodos = [{ type: 'CONTRACT', title: '待办', target: 'contract-approval', count: 1 }];
  const readiness = { status: 'WAITING_SEAL_AUTHORIZATION', action: 'sealGrant', canManageSealAuthorization: true };
  const h = harness((options, defaults) => {
    if (!refresh) {
      if (options.url === '/me/todos') return initialTodos;
      if (options.url.endsWith('/signing-readiness')) return readiness;
      return defaults(options);
    }
    if (options.url === '/me') return me.promise;
    return auxiliary.promise.then(() => {
      if (options.url.startsWith('/authorizations')) return { total: 20 };
      if (options.url.startsWith('/roles')) return [{ id: 'role' }, { id: 'new-role' }];
      if (options.url.startsWith('/contract-templates')) return { total: 7 };
      if (options.url === '/me/todos') return [{ ...initialTodos[0], count: 2 }];
      return defaults(options);
    });
  });
  await h.page.onShow();
  const company = h.page.data.company, todos = h.page.data.todos;
  const signingReadiness = h.page.data.signingReadiness, readinessContext = h.page._readinessContext;
  h.patches.length = 0;
  refresh = true;
  const pending = h.page.onShow();
  const assertRetained = () => {
    assert.equal(h.page.data.companyInitializing, false);
    assert.equal(h.page.data.companyReady, true);
    assert.equal(h.page.data.companySummaryOnly, false);
    assert.equal(h.page.data.memberCount, 18);
    assert.equal(h.page.data.roleCount, 1);
    assert.equal(h.page.data.templateCount, 5);
    assert.equal(h.page.data.todos, todos);
    assert.equal(h.page.data.signingReadiness, signingReadiness);
    assert.equal(h.page.data.canManage, true);
    assert.equal(h.patches.some(patch => patch.companyReady === false || patch.companyInitializing === true
      || patch.memberCount === null || patch.roleCount === null || patch.templateCount === null
      || patch.todos && patch.todos.length === 0 || patch.signingReadiness === null), false,
    'background refresh must not send a transient reset to the view');
  };
  assertRetained();
  assert.equal(h.page.data.company, company);
  assert.equal(h.page._readinessContext, readinessContext, 'the retained signing action still has its validated context');
  await tick();
  assertRetained();
  assert.equal(h.page.data.companyRefreshing, true);
  assert.equal(h.calls.filter(options => options.url === '/me').length, 2, 'tab re-entry still refreshes the profile');
  me.resolve({ ...profile(), company: { ...profile().company, name: '企业3已更新' } });
  await tick();
  assertRetained();
  assert.equal(h.page.data.company.name, '企业3已更新');
  auxiliary.resolve();
  await pending;
  assert.equal(h.page.data.memberCount, 20);
  assert.equal(h.page.data.roleCount, 2);
  assert.equal(h.page.data.templateCount, 7);
  assert.equal(h.page.data.todos[0].count, 2);
  assert.equal(h.page.data.signingReadiness, null);
  assert.equal(h.page.data.companyRefreshing, false);
  assert.equal(h.page.data.companyLoadError, '');
});

test('matching tab re-entry retains statistics and todos when auxiliary refreshes fail', async () => {
  const me = deferred();
  let refresh = false;
  const h = harness((options, defaults) => {
    if (!refresh) return options.url === '/me/todos' ? [{ type: 'CONTRACT', title: '待办', target: 'contract-approval' }] : defaults(options);
    if (options.url === '/me') return me.promise;
    throw new Error('offline');
  });
  await h.page.onShow();
  refresh = true;
  const pending = h.page.onShow();
  assert.equal(h.page.data.companyInitializing, false);
  assert.equal(h.page.data.companySummaryOnly, false);
  assert.equal(h.page.data.memberCount, 18);
  assert.equal(h.page.data.todos.length, 1);
  await tick(); me.resolve(profile()); await pending;
  assert.equal(h.page.data.company.name, '企业3');
  assert.equal(h.page.data.memberCount, 18);
  assert.equal(h.page.data.roleCount, 1);
  assert.equal(h.page.data.templateCount, 5);
  assert.equal(h.page.data.todos.length, 1);
  assert.equal(h.page.data.companyLoadError, '部分企业信息暂未更新，请重试');
});

test('a failed background profile refresh keeps the view and a retry updates it without resetting', async () => {
  let phase = 'initial';
  const h = harness((options, defaults) => {
    if (options.url === '/me') {
      if (phase === 'offline') throw new Error('offline');
      if (phase === 'retry') return { ...profile(), company: { ...profile().company, name: '重试更新的企业' } };
    }
    if (phase === 'retry' && options.url.startsWith('/authorizations')) return { total: 22 };
    if (options.url === '/me/todos') return [{ type: 'CONTRACT', title: '待办', target: 'contract-approval' }];
    return defaults(options);
  });
  await h.page.onShow();
  h.patches.length = 0;
  phase = 'offline';
  await h.page.onShow();
  assert.equal(h.page.data.companyReady, true);
  assert.equal(h.page.data.companyInitializing, false);
  assert.equal(h.page.data.company.name, '企业3');
  assert.equal(h.page.data.memberCount, 18);
  assert.equal(h.page.data.roleCount, 1);
  assert.equal(h.page.data.templateCount, 5);
  assert.equal(h.page.data.todos.length, 1);
  assert.equal(h.page.data.canManage, true);
  assert.equal(h.page.data.companyLoadError, '企业信息更新失败，点击重试');
  phase = 'retry';
  await h.page.loadData();
  assert.equal(h.page.data.company.name, '重试更新的企业');
  assert.equal(h.page.data.memberCount, 22);
  assert.equal(h.page.data.companyLoadError, '');
  assert.equal(h.page.data.companyRefreshing, false);
  assert.equal(h.patches.some(patch => patch.companyReady === false || patch.memberCount === null
    || patch.todos && patch.todos.length === 0), false);
});

test('a profile request started before a newer session restoration cannot confirm that restoration', async () => {
  const oldMe = deferred(), currentMe = deferred();
  let phase = 'initial';
  const h = harness((options, defaults) => {
    if (options.url === '/me' && phase !== 'initial') return phase === 'old' ? oldMe.promise : currentMe.promise;
    return defaults(options);
  });
  await h.page.onShow();
  phase = 'old';
  const old = h.page.onShow();
  await tick();
  await startRestoration(h.app, Promise.resolve(null));
  oldMe.resolve(profile());
  await old;
  assert.equal(h.app._sessionRefresh, null);
  phase = 'current';
  const current = h.page.onShow();
  assert.equal(h.page.data.companyInitializing, true);
  assert.equal(h.page.data.companyReady, false, 'the pre-restoration request must not make old data reusable');
  assert.equal(h.page.data.company.name, undefined);
  assert.equal(h.page.data.canManage, false);
  await tick();
  currentMe.resolve(profile());
  await current;
  assert.equal(h.page.data.companyReady, true);
  assert.equal(h.page.data.memberCount, 18);
});

test('cancelling an older readiness refresh restores its action even when the next profile refresh fails', async () => {
  const oldReadiness = deferred();
  let phase = 'initial';
  const h = harness((options, defaults) => {
    if (options.url === '/me' && phase === 'offline') throw new Error('offline');
    if (options.url.endsWith('/signing-readiness')) {
      if (phase === 'pending-readiness') return oldReadiness.promise;
      if (phase === 'initial') return { status: 'PENDING', action: 'recheck' };
    }
    return defaults(options);
  });
  await h.page.onShow();
  const readiness = h.page.data.signingReadiness;
  phase = 'pending-readiness';
  const old = h.page.loadSigningReadiness();
  assert.equal(h.page.data.signingReadinessLoading, true);
  phase = 'offline';
  await h.page.onShow();
  assert.equal(h.page.data.signingReadiness, readiness);
  assert.equal(h.page.data.signingReadinessLoading, false, 'a cancelled request must not keep the retained action disabled');
  assert.equal(h.page.data.companyLoadError, '企业信息更新失败，点击重试');
  oldReadiness.resolve({ status: 'READY' });
  await old;
  assert.equal(h.page.data.signingReadiness, readiness, 'the cancelled response cannot replace the retained status');
  const callsBefore = h.calls.length;
  phase = 'retry';
  await h.page.handleSigningReadiness();
  assert.equal(h.calls.length, callsBefore + 1, 'the user can retry using the retained action');
  assert.equal(h.page.data.signingReadiness, null);
  assert.equal(h.page.data.signingReadinessLoading, false);
});

test('a background profile permission downgrade clears retained privileged data before auxiliary reads finish', async () => {
  const me = deferred(), auxiliary = deferred();
  let refresh = false;
  const h = harness((options, defaults) => {
    if (refresh) return options.url === '/me' ? me.promise : auxiliary.promise;
    if (options.url === '/me/todos') return [{ type: 'APPROVAL', title: '管理员待办', target: 'contract-approval' }];
    if (options.url.endsWith('/signing-readiness')) return { status: 'WAITING_SEAL_AUTHORIZATION', action: 'sealGrant', canManageSealAuthorization: true };
    return defaults(options);
  });
  await h.page.onShow();
  refresh = true;
  const pending = h.page.onShow();
  assert.equal(h.page.data.canManage, true);
  assert.equal(h.page.data.todos.length, 1);
  assert.ok(h.page.data.signingReadiness);
  await tick();
  me.resolve(profile('3', ['inventory_view']));
  await tick();
  assert.equal(h.page.data.companyReady, true);
  assert.equal(h.page.data.company.name, '企业3');
  assert.equal(h.page.data.canManage, false);
  assert.equal(h.page.data.canCompanyManage, false);
  assert.equal(h.page.data.canContractTemplate, false);
  assert.equal(h.page.data.canInventory, true);
  assert.equal(h.page.data.memberCount, null);
  assert.equal(h.page.data.roleCount, null);
  assert.equal(h.page.data.templateCount, null);
  assert.equal(h.page.data.todos.length, 0);
  assert.equal(h.page.data.signingReadiness, null);
  auxiliary.resolve([]);
  await pending;
  assert.equal(h.page.data.canManage, false);
});

for (const outcome of ['succeeded', 'failed']) {
  test(`a ${outcome} session restoration that already finished invalidates the retained view`, async () => {
    const me = deferred();
    let refresh = false;
    const h = harness((options, defaults) => refresh && options.url === '/me' ? me.promise : defaults(options));
    await h.page.onShow();
    refresh = true;
    await startRestoration(h.app, Promise.resolve(outcome === 'succeeded' ? profile() : null));
    assert.equal(h.app._sessionRefresh, null);
    const pending = h.page.onShow();
    assert.equal(h.page.data.companyInitializing, true);
    assert.equal(h.page.data.companyReady, false);
    assert.equal(h.page.data.company.name, undefined);
    assert.equal(h.page.data.memberCount, null);
    assert.equal(h.page.data.canManage, false);
    await tick();
    assert.equal(h.calls.filter(options => options.url === '/me').length, 2);
    me.resolve(profile());
    await pending;
    assert.equal(h.page.data.companyReady, true);
    assert.equal(h.page.data.company.name, '企业3');
    assert.equal(h.page.data.memberCount, 18);
  });
}

test('switching enterprise resets old values and does not reuse a member from a different selected company', async () => {
  let refresh = false;
  const me = deferred();
  const h = harness((options, defaults) => refresh && options.url === '/me' ? me.promise : defaults(options));
  await h.page.onShow();
  refresh = true;
  h.app.globalData.currentCompanyId = '4';
  h.app.globalData.companies.push({ companyId: '4', companyName: '企业4' });
  h.app._companyAccessGeneration = 1;
  const pending = h.page.onShow();
  assert.equal(h.page.data.companyReady, false, 'user profile still belongs to the previous company');
  assert.equal(h.page.data.canManage, false);
  assert.equal(h.page.data.memberCount, null);
  assert.equal(h.page.data.company.name, undefined);
  await tick(); me.resolve(profile('4', ['inventory_view'])); await pending;
  assert.equal(h.page.data.company.name, '企业4');
  assert.equal(h.page.data.canManage, false);
  assert.equal(h.page.data.canInventory, true);
  assert.equal(h.page.data.memberCount, null);
});

test('permission changes invalidate retained management values before the next response', async () => {
  let refresh = false;
  const me = deferred();
  const h = harness((options, defaults) => refresh && options.url === '/me' ? me.promise : defaults(options));
  await h.page.onShow();
  refresh = true;
  h.app.globalData.memberInfo = { ...h.app.globalData.memberInfo, permissions: ['inventory_view'] };
  const pending = h.page.onShow();
  assert.equal(h.page.data.canManage, false);
  assert.equal(h.page.data.memberCount, null);
  assert.equal(h.page.data.todos.length, 0);
  await tick(); me.resolve(profile('3', ['inventory_view'])); await pending;
  assert.equal(h.page.data.canManage, false);
});

test('changing accounts clears the previous enterprise even while global profile restoration is unfinished', async () => {
  const me = deferred();
  let refresh = false;
  const h = harness((options, defaults) => refresh && options.url === '/me' ? me.promise : defaults(options));
  await h.page.onShow(); refresh = true;
  h.app.globalData.token = 'new-session';
  const pending = h.page.onShow();
  assert.equal(h.page.data.companyReady, false);
  assert.equal(h.page.data.company.name, undefined);
  assert.equal(h.page.data.canManage, false);
  await tick();
  me.resolve({ user: { id: '8', currentCompanyId: '' }, member: { roleCode: 'GUEST', permissions: [] }, companies: [] });
  await pending;
  assert.equal(h.page.data.companyReady, true);
  assert.equal(h.page.data.hasCompany, false);
  assert.equal(h.page.data.currentCompanyId, '');
});

test('an old company response cannot replace the new company after switching away and back', async () => {
  const first = deferred();
  let delayed = true;
  const h = harness((options, defaults) => delayed && options.url === '/me' ? first.promise : defaults(options));
  const old = h.page.onShow(); await tick();
  h.app._companyAccessGeneration = 2;
  delayed = false;
  await h.page.onShow();
  first.resolve({ ...profile(), company: { ...profile().company, name: '过时企业' } }); await old;
  assert.equal(h.page.data.company.name, '企业3');
  assert.equal(h.page.data.memberCount, 18);
});

test('a restored profile cannot roll back a company switch while session restoration was pending', async () => {
  const restoration = deferred();
  const h = harness();
  startRestoration(h.app, restoration.promise);
  const pending = h.page.onShow();
  h.app._companyAccessGeneration = 1;
  h.app.applyMePayload(profile('4', ['inventory_view']));
  restoration.resolve(profile('3'));
  await pending;
  assert.equal(h.calls.filter(options => options.url === '/me').length, 1);
  assert.equal(h.app.globalData.currentCompanyId, '4');
  assert.equal(h.page.data.company.name, '企业4');
});

test('switching away and back while restoring invalidates the earlier session profile by generation', async () => {
  const restoration = deferred();
  const h = harness();
  startRestoration(h.app, restoration.promise);
  const pending = h.page.onShow();
  h.app._companyAccessGeneration = 2;
  restoration.resolve({ ...profile(), company: { ...profile().company, name: '过时摘要' } });
  await pending;
  assert.equal(h.calls.filter(options => options.url === '/me').length, 1);
  assert.equal(h.page.data.company.name, '企业3');
});

test('a restored profile with outdated permissions is reloaded before it can restore management entries', async () => {
  const restoration = deferred();
  const h = harness((options, defaults) => options.url === '/me' ? profile('3', ['inventory_view']) : defaults(options));
  startRestoration(h.app, restoration.promise);
  const pending = h.page.onShow();
  h.app.globalData.memberInfo = { ...h.app.globalData.memberInfo, permissions: ['inventory_view'] };
  restoration.resolve(profile());
  await pending;
  assert.equal(h.calls.filter(options => options.url === '/me').length, 1);
  assert.equal(h.page.data.canManage, false);
});

test('changing permissions invalidates old auxiliary responses before a delayed session refresh finishes', async () => {
  const oldTodos = deferred(), restoration = deferred();
  let phase = 'first';
  const h = harness((options, defaults) => phase === 'first' && options.url === '/me/todos' ? oldTodos.promise : defaults(options));
  const first = h.page.onShow(); await tick();
  h.app.globalData.memberInfo = { ...h.app.globalData.memberInfo, permissions: ['inventory_view'] };
  startRestoration(h.app, restoration.promise);
  phase = 'second';
  const second = h.page.onShow();
  oldTodos.resolve([{ type: 'APPROVAL', title: '旧管理员待办' }]);
  await first;
  assert.equal(h.page.data.todos.length, 0);
  assert.equal(h.page.data.canManage, false);
  restoration.resolve(profile('3', ['inventory_view']));
  await second;
  assert.equal(h.page.data.canManage, false);
});

test('an older me response cannot restore admin permissions while the downgraded session refresh is pending', async () => {
  const oldMe = deferred(), restoration = deferred();
  const h = harness((options, defaults) => options.url === '/me' ? oldMe.promise : defaults(options));
  const first = h.page.onShow(); await tick();
  h.app.globalData.memberInfo = { ...h.app.globalData.memberInfo, permissions: ['inventory_view'] };
  startRestoration(h.app, restoration.promise);
  const second = h.page.onShow();
  oldMe.resolve(profile()); await first;
  assert.equal(h.page.data.canManage, false);
  assert.deepEqual(h.app.globalData.memberInfo.permissions, ['inventory_view']);
  restoration.resolve(profile('3', ['inventory_view'])); await second;
  assert.equal(h.page.data.canManage, false);
});

test('first load failure stays distinct from a real empty enterprise state and can be retried', async () => {
  let failing = true;
  const empty = { user: { id: '7', currentCompanyId: '' }, member: { roleCode: 'GUEST', permissions: [] }, companies: [] };
  const h = harness((options, defaults) => {
    if (options.url === '/me') { if (failing) throw new Error('offline'); return empty; }
    return defaults(options);
  });
  h.app.applyMePayload(empty);
  await h.page.onShow();
  assert.equal(h.page.data.companyInitializing, false);
  assert.equal(h.page.data.companyReady, false);
  assert.ok(h.page.data.companyLoadError);
  failing = false;
  await h.page.loadData();
  assert.equal(h.page.data.companyReady, true);
  assert.equal(h.page.data.hasCompany, false);
  assert.equal(h.page.data.companyLoadError, '');
});

test('a confirmed guest renders the login view without business requests and clears retained state', async () => {
  const h = harness();
  await h.page.onShow();
  h.app.globalData.token = '';
  await h.page.onShow();
  assert.equal(h.page.data.companyInitializing, false);
  assert.equal(h.page.data.isLoggedIn, false);
  assert.equal(h.page.data.companyReady, false);
  assert.equal(h.page.data.canManage, false);
  assert.equal(h.page.data.memberCount, null);
});

test('an old ACTIVE profile cannot remain visible while the server restores an unverified unbound account', async () => {
  let unbound;
  const h = harness((options, defaults) => unbound && options.url === '/me' ? unbound : defaults(options));
  await h.page.onShow();
  assert.equal(h.page.data.company.name, '企业3');
  assert.equal(h.page.data.memberCount, 18);
  const restoration = deferred();
  startRestoration(h.app, restoration.promise);
  const callsBefore = h.calls.length;
  const restoring = h.page.onShow();
  assert.equal(h.page.data.companyInitializing, true);
  assert.equal(h.page.data.companyReady, false);
  assert.equal(h.page.data.hasCompany, false);
  assert.equal(h.page.data.company.name, undefined);
  assert.equal(h.page.data.memberCount, null);
  assert.equal(h.page.data.roleCount, null);
  assert.equal(h.page.data.templateCount, null);
  assert.equal(h.page.data.todos.length, 0);
  assert.equal(h.page.data.canManage, false);
  assert.equal(h.page.data.canInventory, false);

  unbound = { user: { id: '7', currentCompanyId: null },
    member: { roleCode: 'GUEST', memberStatus: 'NONE', permissions: [] }, company: null, companies: [] };
  h.app.applyMePayload(unbound);
  restoration.resolve(unbound);
  await restoring;
  assert.equal(h.page.data.companyInitializing, false);
  assert.equal(h.page.data.companyReady, true);
  assert.equal(h.page.data.hasCompany, false);
  assert.equal(h.page.data.company.name, undefined);
  assert.equal(h.page.data.memberCount, null);
  assert.equal(h.page.data.canManage, false);
  assert.equal(h.calls.slice(callsBefore).some(options => options.url.startsWith('/authorizations')
    || options.url.startsWith('/roles') || options.url.startsWith('/contract-templates')
    || options.url.endsWith('/signing-readiness')), false);
});

test('failed session restoration keeps old enterprise data hidden until a new confirmed profile arrives', async () => {
  const restoration = deferred();
  let failing = false;
  const h = harness((options, defaults) => {
    if (failing && options.url === '/me') throw new Error('offline');
    return defaults(options);
  });
  await h.page.onShow();
  assert.equal(h.page.data.memberCount, 18);
  startRestoration(h.app, restoration.promise);
  failing = true;
  const pending = h.page.onShow();
  assert.equal(h.page.data.companyInitializing, true);
  assert.equal(h.page.data.companyReady, false);
  restoration.resolve(null);
  await pending;
  assert.equal(h.page.data.companyInitializing, false);
  assert.equal(h.page.data.companyReady, false);
  assert.equal(h.page.data.company.name, undefined);
  assert.equal(h.page.data.memberCount, null);
  assert.equal(h.page.data.roleCount, null);
  assert.equal(h.page.data.templateCount, null);
  assert.equal(h.page.data.todos.length, 0);
  assert.equal(h.page.data.canManage, false);
  assert.equal(h.page.data.canInventory, false);
  assert.ok(h.page.data.companyLoadError);
  failing = false;
  await h.page.loadData();
  assert.equal(h.page.data.companyReady, true);
  assert.equal(h.page.data.company.name, '企业3');
  assert.equal(h.page.data.memberCount, 18);
  assert.equal(h.page.data.canManage, true);
});
