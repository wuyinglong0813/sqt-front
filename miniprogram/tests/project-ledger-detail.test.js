'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function harness(handler = async () => ({})) {
  let page;
  const calls = [], downloads = [], documents = [], toasts = [], modals = [];
  const app = { globalData: { token: 'token', currentCompanyId: '4' } };
  const wx = { env: { USER_DATA_PATH: '/user' }, showLoading() {}, hideLoading() {},
    showToast: options => toasts.push(options), showModal: options => modals.push(options),
    openDocument: options => documents.push(options) };
  const exports = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../pages/project-ledger/project-ledger.js'), 'utf8'), {
    Page: value => { page = value; }, wx, getApp: () => app, module: { exports }, setTimeout() {},
    require: id => id.endsWith('/request') ? { request: async options => { calls.push(options); return handler(options); } }
      : id.endsWith('/fileTransfer') ? { downloadApiFile: async (url, filePath) => {
        downloads.push({ url, filePath }); return { filePath };
      } } : id.endsWith('/companyContext') ? require('../utils/companyContext') : {}
  });
  page.setData = updates => Object.assign(page.data, updates);
  page.data.activeProject = { id: '51', name: '项目/A', contracts: [] };
  return { page, app, calls, downloads, documents, toasts, modals };
}

const ledger = () => ({ projectId: '51', groups: [{ key: '9:PURCHASE', counterpartyName: '光屿行',
  rows: [{ key: 'entry:1', date: '2026-09-01', name: '退货单', contractAmount: null,
    amount: '-1000.5', paymentAmount: 0, unpaidAmount: '-1000.5', invoiceAmount: null, unbilledAmount: 0 }],
  totals: { amount: '-1000.5', paymentAmount: 0, unpaidAmount: '-1000.5', invoiceAmount: 0, unbilledAmount: 0 }
}] });

test('loads ledger and distinguishes blank cells, zero transfers and negative returns', async () => {
  const env = harness(async () => ledger());
  await env.page.loadLedger('51');
  const row = env.page.data.ledger.groups[0].rows[0];
  assert.equal(row.contractAmountText, '');
  assert.equal(row.invoiceAmountText, '');
  assert.equal(row.paymentAmountText, '0.00');
  assert.equal(row.amountText, '-1000.50');
  assert.equal(row.dateText, '2026-09-01');
  assert.equal(env.page.data.ledgerLoading, false);
});

test('closing or changing the viewing company discards an in-flight ledger', async () => {
  let resolve;
  const env = harness(() => new Promise(done => { resolve = done; }));
  const first = env.page.loadLedger('51');
  env.page.closeProject();
  resolve(ledger());
  await first;
  assert.equal(env.page.data.ledger, null);
  env.page.data.activeProject = { id: '51' };
  const second = env.page.loadLedger('51');
  env.app.globalData.currentCompanyId = '9';
  resolve(ledger());
  await second;
  assert.equal(env.page.data.ledger, null);
});

test('a failed ledger request stays visible and can be retried', async () => {
  let failed = true;
  const env = harness(async () => { if (failed) throw new Error('台账读取失败'); return ledger(); });
  await env.page.loadLedger('51');
  assert.equal(env.page.data.ledgerError, '台账读取失败');
  assert.equal(env.page.data.ledgerLoading, false);
  failed = false;
  await env.page.retryLedger();
  assert.equal(env.page.data.ledgerError, '');
  assert.equal(env.page.data.ledger.groups.length, 1);
});

test('assigning and removing contracts refreshes the project ledger from server data', async () => {
  const env = harness(async options => {
    if (options.url.endsWith('/ledger')) return ledger();
    if (options.url === '/project-ledgers') return [];
    return { id: '51', contracts: [{ id: '12', amount: '10000' }] };
  });
  env.page.data.selectedContractIds = ['12'];
  env.page.data.projectTab = 'contracts';
  await env.page.assignContracts();
  assert.equal(env.page.data.projectTab, 'ledger');
  assert.equal(env.page.data.ledger.groups.length, 1);
  assert.equal(env.calls.filter(call => call.url.endsWith('/ledger')).length, 1);
  env.page.removeContract({ currentTarget: { dataset: { id: '12' } } });
  await env.modals[0].success({ confirm: true });
  assert.equal(env.calls.filter(call => call.url.endsWith('/ledger')).length, 2);
});

test('exports the current project as an Excel document with the sharing menu enabled', async () => {
  const env = harness();
  env.page.data.ledger = ledger();
  await env.page.exportLedger();
  assert.equal(env.downloads[0].url, '/project-ledgers/51/ledger/workbook-data');
  assert.equal(env.downloads[0].filePath, '/user/项目_A-51-台账明细.xlsx');
  assert.equal(env.documents[0].fileType, 'xlsx');
  assert.equal(env.documents[0].showMenu, true);
  assert.equal(env.page.data.exportingLedger, false);
});
