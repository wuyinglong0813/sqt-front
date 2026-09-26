'use strict';

const assert = require('assert');
const testTimers = require('node:timers');
const fs = require('fs');
const path = require('path');
const {
  numberToChineseCurrency,
  calcTableTotal,
  calcFeeTotal,
  normalizeContractTable,
  toChineseNum,
  reorderClauses
} = require('../utils/chineseCurrency');
const dict = require('../utils/dict');

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

test('numberToChineseCurrency handles invalid, integer and decimal amounts', () => {
  assert.strictEqual(numberToChineseCurrency(null), '零元整');
  assert.strictEqual(numberToChineseCurrency(-1), '零元整');
  assert.strictEqual(numberToChineseCurrency(0), '零元整');
  assert.strictEqual(numberToChineseCurrency(12345.67), '壹万贰仟叁佰肆拾伍元陆角柒分');
  assert.strictEqual(numberToChineseCurrency(10.05), '壹拾元零伍分');
});

test('calcTableTotal normalizes rows and rounds currency values', () => {
  const result = calcTableTotal([
    ['商品A', 'S', '件', '2', '3.335', ''],
    ['商品B', '', '', 'bad', '10', '']
  ]);
  assert.strictEqual(result.totalAmount, 6.67);
  assert.strictEqual(result.rows[0][5], '6.67');
  assert.strictEqual(result.rows[1][5], '0');
  assert.strictEqual(result.totalAmountCn, '陆元陆角柒分');
});

test('contract table appends remarks without losing them and keeps fees separate', () => {
  const normalized = normalizeContractTable(
    ['产品名称', '规格型号', '单位', '数量', '单价(元)', '金额(元)'],
    [['商品A', 'S', '件', '2', '3', '6']]
  );
  assert.deepStrictEqual(normalized.columns.slice(-2), ['金额(元)', '备注']);
  normalized.rows[0][6] = '加急送货';
  const calculated = calcTableTotal(normalized.rows, normalized.columns);
  assert.strictEqual(calculated.rows[0][6], '加急送货');
  assert.strictEqual(calcFeeTotal([{ amount: '12.30' }, { amount: 'bad' }]), 12.3);
});

test('clause helpers strip old prefixes and produce stable labels', () => {
  assert.strictEqual(toChineseNum(1), '一');
  assert.strictEqual(toChineseNum(11), '十一');
  assert.strictEqual(toChineseNum(31), '31');
  assert.deepStrictEqual(reorderClauses([
    { title: '一、 交付', content: '约定' },
    { title: '验收' }
  ]), [
    { title: '交付', content: '约定', _num: '一', _label: '一、' },
    { title: '验收', content: '', _num: '二', _label: '二、' }
  ]);
});

test('dict returns known semantic values and safe fallback', () => {
  assert.deepStrictEqual(dict.certification('VERIFIED'), { text: '已认证', color: '#2f86e6' });
  assert.deepStrictEqual(dict.member('UNKNOWN'), { text: 'UNKNOWN', color: '#9ca3af' });
  assert.deepStrictEqual(dict.step(), { text: '-', color: '#9ca3af' });
});

function loadComponent(relativePath) {
  let definition;
  global.Component = value => { definition = value; };
  const modulePath = require.resolve(relativePath);
  delete require.cache[modulePath];
  require(relativePath);
  return definition;
}

test('shared components emit stable UI events', () => {
  const searchBar = loadComponent('../components/search-bar/search-bar');
  const events = [];
  const context = { triggerEvent: (name, detail) => events.push({ name, detail }) };
  searchBar.methods.onInput.call(context, { detail: { value: '合同' } });
  searchBar.methods.onConfirm.call(context, { detail: { value: '合同' } });
  searchBar.methods.onClear.call(context);
  assert.deepStrictEqual(events, [
    { name: 'input', detail: { value: '合同' } },
    { name: 'confirm', detail: { value: '合同' } },
    { name: 'input', detail: { value: '' } },
    { name: 'clear', detail: undefined }
  ]);

  const emptyState = loadComponent('../components/empty-state/empty-state');
  let tapped = false;
  emptyState.methods.onTap.call({ triggerEvent: name => { tapped = name === 'tap'; } });
  assert.strictEqual(tapped, true);
});

function loadPage(relativePath) {
  let definition;
  global.Page = value => { definition = value; };
  const modulePath = require.resolve(relativePath);
  delete require.cache[modulePath];
  require(relativePath);
  return definition;
}

test('home approval polling refreshes while visible and stops across page exits', async () => {
  const testApp = getApp();
  const oldCompany = testApp.getCurrentCompanyId;
  testApp.getCurrentCompanyId = () => testApp.globalData.currentCompanyId;
  const page = loadPage('../pages/index/index');
  const timers = new Map(); let nextId = 0; let count = 0;
  const oldSet = global.setTimeout; const oldClear = global.clearTimeout;
  global.setTimeout = (callback, delay) => { assert.strictEqual(delay, 10000); timers.set(++nextId, callback); return nextId; };
  global.clearTimeout = id => timers.delete(id);
  const instance = { ...page, data: { showJoinForm: false }, loadApprovalIndicator: async () => { count++; } };
  try {
    instance.startApprovalPolling();
    const callback = timers.values().next().value; timers.clear(); await callback();
    assert.strictEqual(count, 1); assert.strictEqual(timers.size, 1);
    const stale = timers.values().next().value;
    instance.stopApprovalPolling(); assert.strictEqual(timers.size, 0);
    await stale(); assert.strictEqual(count, 1);
    instance.startApprovalPolling(); instance.stopApprovalPolling(); assert.strictEqual(timers.size, 0);
  } finally { global.setTimeout = oldSet; global.clearTimeout = oldClear; testApp.getCurrentCompanyId = oldCompany; }
});

test('logistics images get readable names and file sizes', () => {
  const contractPreview = loadPage('../pages/contract-preview/contract-preview');
  assert.match(
    contractPreview.buildLogisticsFileName('wxfile://tmp/photo.PNG'),
    /^物流单-\d{8}-\d{6}\.png$/
  );
  assert.strictEqual(contractPreview.formatFileSize(2048), '2.0KB');
  assert.strictEqual(contractPreview.formatFileSize(2 * 1024 * 1024), '2.0MB');
});

test('business document editor maps contract products into the selected template', () => {
  const contractPreview = loadPage('../pages/contract-preview/contract-preview');
  const context = {
    data: {
      sData: {
        sections: [{
          type: 'table',
          columns: ['产品名称', '规格型号', '单位', '数量', '单价(元)', '金额(元)'],
          rows: [['商品A', 'A-1', '件', '2', '3.5', '7']]
        }]
      }
    },
    valueForDocumentColumn: contractPreview.valueForDocumentColumn
  };
  const columns = ['序号', '品名', '规格', '单位', '数量', '单价', '金额', '备注'];
  const rows = contractPreview.buildDocumentRows.call(context, columns);

  assert.deepStrictEqual(rows, [['1', '商品A', 'A-1', '件', '2', '3.5', '7', '']]);
  assert.strictEqual(contractPreview.calculateDocumentTotal(columns, rows, 0), '7');
});

test('contract details and snapshots use the entered contract name', () => {
  const signScript = fs.readFileSync(
    path.join(__dirname, '..', 'pages', 'sign-contract', 'sign-contract.js'),
    'utf8'
  );
  const previewScript = fs.readFileSync(
    path.join(__dirname, '..', 'pages', 'contract-preview', 'contract-preview.js'),
    'utf8'
  );
  assert.ok(signScript.includes('title: contractName.trim()'));
  assert.ok(previewScript.includes(
    "const pdfTitle = contract.name || (sData && sData.title) || this.data.contractName || '购销合同'"
  ));
});

test('pending approval opens the structured contract preview instead of rendering raw JSON', () => {
  const approvalDir = path.join(__dirname, '..', 'pages', 'contract-approval');
  const approvalScript = fs.readFileSync(path.join(approvalDir, 'contract-approval.js'), 'utf8');
  const approvalTemplate = fs.readFileSync(path.join(approvalDir, 'contract-approval.wxml'), 'utf8');
  const previewTemplate = fs.readFileSync(
    path.join(__dirname, '..', 'pages', 'contract-preview', 'contract-preview.wxml'), 'utf8'
  );
  assert.ok(approvalScript.includes('/pages/contract-preview/contract-preview?contractId='));
  assert.ok(approvalTemplate.includes('查看合同'));
  assert.ok(!approvalTemplate.includes('{{item.terms}}'));
  assert.ok(previewTemplate.includes('contractTableRows'));
  assert.ok(previewTemplate.includes('contractClauses'));
});

test('experience build uses one native tab bar and size-safe file transfer', () => {
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'app.json'), 'utf8'));
  assert.strictEqual(config.tabBar.custom, false);
  const scripts = [
    'pages/contract-preview/contract-preview.js',
    'pages/sales-order-detail/sales-order-detail.js',
    'pages/reconciliation/reconciliation.js'
  ].map(relative => fs.readFileSync(path.join(__dirname, '..', relative), 'utf8')).join('\n');
  assert.ok(!scripts.includes('wx.downloadFile'));
  assert.ok(!scripts.includes('wx.uploadFile'));
  assert.ok(scripts.includes('downloadApiFile'));
  assert.ok(scripts.includes('uploadMultipartApiFile'));
  assert.ok(!scripts.includes('/attachments/base64'));
  const transfer = fs.readFileSync(path.join(__dirname, '..', 'utils', 'fileTransfer.js'), 'utf8');
  assert.ok(transfer.includes('wx.uploadFile'));
  assert.ok(transfer.includes("header['X-Company-Id']"));
  assert.ok(!transfer.includes('contentBase64 }'));
});

test('home exposes the ordered approval center with a message indicator', () => {
  const homeScript = fs.readFileSync(
    path.join(__dirname, '..', 'pages', 'index', 'index.js'), 'utf8'
  );
  const homeTemplate = fs.readFileSync(
    path.join(__dirname, '..', 'pages', 'index', 'index.wxml'), 'utf8'
  );
  assert.ok(!homeScript.includes("item.type === 'SALES_ORDER'"));
  assert.ok(!homeTemplate.includes('pendingSalesOrderTodo'));
  assert.ok(homeTemplate.includes('data-key="approval"'));
  assert.ok(homeTemplate.includes('data-key="inventory"'));
  assert.ok(homeTemplate.includes('审批中心'));
  assert.ok(homeTemplate.includes('approvalHasMessage'));
  assert.ok(homeScript.includes('/approvals/summary'));
  const workbenchKeys = [...homeTemplate.matchAll(/data-key="(contracts|approval|reconciliation|inventory)"/g)]
    .map(match => match[1]);
  assert.deepStrictEqual(workbenchKeys.slice(-4), [
    'contracts', 'approval', 'reconciliation', 'inventory'
  ]);
  const approvalScript = fs.readFileSync(
    path.join(__dirname, '..', 'pages', 'contract-approval', 'contract-approval.js'), 'utf8'
  );
  const approvalTemplate = fs.readFileSync(
    path.join(__dirname, '..', 'pages', 'contract-approval', 'contract-approval.wxml'), 'utf8'
  );
  assert.ok(approvalScript.includes('/approvals/fulfillment'));
  assert.ok(approvalScript.includes('/approvals/results'));
  assert.ok(approvalScript.includes("label: '待我处理'"));
  assert.ok(approvalScript.includes("label: '处理记录'"));
  assert.ok(approvalScript.includes('sales-order-detail'));
  assert.ok(approvalScript.includes("label: '合同'"));
  assert.ok(approvalScript.includes("label: '履约资料'"));
  assert.ok(approvalScript.includes('substring(0, 19)'));
  assert.ok(approvalTemplate.includes('result-reason'));
  assert.ok(!approvalTemplate.includes('approval-hero'));
  const approvalStyles = fs.readFileSync(
    path.join(__dirname, '..', 'pages', 'contract-approval', 'contract-approval.wxss'), 'utf8'
  );
  assert.ok(approvalStyles.includes('border-bottom-color: #2185e8'));
});

test('contract ledger gives each company group a distinct section boundary', () => {
  const styles = fs.readFileSync(
    path.join(__dirname, '..', 'pages', 'contract-center', 'contract-center.wxss'), 'utf8'
  );
  assert.ok(styles.includes('.company-group + .company-group'));
  assert.ok(styles.includes('border-left: 7rpx solid #2e91ea'));
  assert.ok(styles.includes('background: #e5f1fd'));
});

test('contract numeric cells clear zero on focus and normalize leading zeros', () => {
  const signContract = loadPage('../pages/sign-contract/sign-contract');
  let focusedPatch;
  signContract.onNumberCellFocus.call({
    data: { tableRows: [['商品', '', '件', '0', '0', '0']] },
    setData: patch => { focusedPatch = patch; }
  }, { currentTarget: { dataset: { row: 0, col: 3 } } });
  assert.deepStrictEqual(focusedPatch, { 'tableRows[0][3]': '' });

  let cellPatch;
  const tableContext = {
    data: {
      tableSection: { columns: ['产品名称', '规格型号', '单位', '数量', '单价(元)', '金额(元)'] },
      tableRows: [['商品', '', '件', '0', '0', '0']],
      inventoryProducts: []
    },
    tableColumnIndex: signContract.tableColumnIndex,
    setData: patch => { cellPatch = patch; }
  };
  const normalized = signContract.onTableCellChange.call(tableContext, {
    currentTarget: { dataset: { row: 0, col: 3 } },
    detail: { value: '0100' }
  });
  assert.strictEqual(normalized, '100');
  assert.strictEqual(cellPatch['tableRows[0][3]'], '100');

  const signTemplate = fs.readFileSync(
    path.join(__dirname, '..', 'pages', 'sign-contract', 'sign-contract.wxml'), 'utf8'
  );
  const templateEditor = fs.readFileSync(
    path.join(__dirname, '..', 'pages', 'contract-template-detail', 'contract-template-detail.wxml'), 'utf8'
  );
  assert.ok(signTemplate.includes('bindfocus="onNumberCellFocus"'));
  assert.ok(signTemplate.includes('bindblur="onNumberCellBlur"'));
  assert.ok(templateEditor.includes('bindfocus="onNumberCellFocus"'));
});

test('new company onboarding validates input and reaches confirmation without a search', () => {
  const page = loadPage('../pages/company-bind/company-bind');
  assert.strictEqual(page.data.mode, 'create');
  let navigation;
  let toast;
  wx.navigateTo = options => { navigation = options.url; };
  wx.showToast = options => { toast = options.title; };
  const context = {
    data: { companyName: '', creditCode: '', legalPersonName: '' },
    setData(values) { Object.assign(this.data, values); }
  };
  page.continueCreate.call(context);
  assert.strictEqual(navigation, undefined);
  assert.strictEqual(toast, '请完整填写企业信息');
  context.data = { companyName: ' 测试企业 & 商贸 ', creditCode: '123', legalPersonName: ' 张三 ' };
  page.continueCreate.call(context);
  assert.strictEqual(navigation, undefined);
  context.data.creditCode = ' 91130100ma12345678 ';
  page.continueCreate.call(context);
  const query = new URL(navigation, 'https://example.test').searchParams;
  assert.strictEqual(query.get('name'), '测试企业 & 商贸');
  assert.strictEqual(query.get('creditCode'), '91130100MA12345678');
  assert.strictEqual(query.get('legalPersonName'), '张三');
  const cert = loadPage('../pages/company-cert/company-cert');
  const confirmation = { data: {}, setData(values) { Object.assign(this.data, values); } };
  cert.onLoad.call(confirmation, {
    name: encodeURIComponent(query.get('name')),
    creditCode: query.get('creditCode'),
    legalPersonName: encodeURIComponent(query.get('legalPersonName'))
  });
  assert.strictEqual(confirmation.data.hasCompany, false);
  assert.strictEqual(confirmation.data.companyName, '测试企业 & 商贸');
});

test('company search confirmation does not depend on sensitive company fields', () => {
  const companyBind = loadPage('../pages/company-bind/company-bind');
  let modal;
  wx.showModal = options => { modal = options; };
  companyBind.confirmCompany.call({
    data: { selectedCompany: { id: '3', name: '测试企业', maskedCreditCode: '9113**********4567' } }
  });
  assert.strictEqual(modal.title, '企业已入驻');
  assert.match(modal.content, /企业管理员/);
  assert.strictEqual(modal.showCancel, false);
});

test('project ledger formats contract totals and remains an optional enterprise entry', () => {
  const projectLedger = require('../pages/project-ledger/project-ledger');
  assert.strictEqual(projectLedger.money('1288.5'), '1288.50');
  assert.strictEqual(projectLedger.money(null), '0.00');
  assert.deepStrictEqual(projectLedger.decorateProject({
    id: 1,
    purchaseCost: 300,
    salesIncome: 500,
    estimatedProfit: 200
  }), {
    id: 1,
    purchaseCost: 300,
    salesIncome: 500,
    estimatedProfit: 200,
    purchaseCostText: '300.00',
    salesIncomeText: '500.00',
    estimatedProfitText: '200.00'
  });
  const companyView = fs.readFileSync(
    path.join(__dirname, '..', 'pages', 'company', 'company.wxml'),
    'utf8'
  );
  assert.ok(companyView.includes('项目账套'));
  assert.ok(companyView.includes('bindtap="goProjectLedger"'));
});

test('signed contracts prompt managers to choose or create a project ledger', () => {
  const previewScript = fs.readFileSync(
    path.join(__dirname, '..', 'pages', 'contract-preview', 'contract-preview.js'),
    'utf8'
  );
  const previewTemplate = fs.readFileSync(
    path.join(__dirname, '..', 'pages', 'contract-preview', 'contract-preview.wxml'),
    'utf8'
  );
  const projectScript = fs.readFileSync(
    path.join(__dirname, '..', 'pages', 'project-ledger', 'project-ledger.js'),
    'utf8'
  );
  assert.ok(previewScript.includes('/project-ledgers/contracts/${contract.id || this.data.contractId}/assignment'));
  assert.ok(previewTemplate.includes('project-ledger-prompt'));
  assert.ok(previewTemplate.includes('加入已有项目账套'));
  assert.ok(previewTemplate.includes('新建账套并加入'));
  assert.ok(previewTemplate.includes('本合同不再提示'));
  assert.ok(previewScript.includes('/dismiss'));
  assert.ok(projectScript.includes('assignPendingContract(project.id)'));
});

test('signed contract detail renders the provider archive page instead of a fake completed seal', () => {
  const previewDir = path.join(__dirname, '..', 'pages', 'contract-preview');
  const previewScript = fs.readFileSync(path.join(previewDir, 'contract-preview.js'), 'utf8');
  const previewTemplate = fs.readFileSync(path.join(previewDir, 'contract-preview.wxml'), 'utf8');
  assert.ok(previewScript.includes('/signed-preview-chunk-data'));
  assert.ok(previewTemplate.includes('src="{{signedPreviewFilePath}}"'));
  assert.ok(previewTemplate.includes('真实签署文件'));
  assert.ok(!previewTemplate.includes('电子签章'));
  assert.ok(!previewTemplate.includes('已完成'));
});

const app = {
  globalData: {
    baseUrl: 'https://api.example.test',
    isLocalDevelopment: true,
    token: 'token-1',
    currentCompanyId: 'company-3'
  }
};
global.getApp = () => app;
global.wx = {};
const { request } = require('../utils/request');
const {
  downloadChunkedApiFile,
  localFileReady,
  uploadMultipartApiFile
} = require('../utils/fileTransfer');
const {
  clearHomeSnapshots,
  readHomeSnapshot,
  snapshotKey,
  writeHomeSnapshot
} = require('../utils/homeSnapshot');
const { setTabBarHidden, syncTabBar, tabIndicatorTransform } = require('../utils/tabBar');

test('signature upload uses authenticated API transport and bounds image size', async () => {
  const { uploadSignatureApiFile } = require('../utils/fileTransfer');
  const oldFs = wx.getFileSystemManager;
  const oldRequest = wx.request;
  const app = getApp();
  const oldLocal = app.globalData.isLocalDevelopment;
  app.globalData.isLocalDevelopment = false;
  let captured;
  wx.getFileSystemManager = () => ({
    statSync: () => ({ size: 3 }),
    readFile: o => o.success({ data: 'AQID' })
  });
  wx.request = o => { captured = o; o.success({ statusCode: 200, data: { code: 0, data: { status: 'APPROVED' } } }); };
  try {
    const result = await uploadSignatureApiFile('/trade-documents/7/receive', '/tmp/sign.png', { decision: 'APPROVE' });
    assert.strictEqual(result.status, 'APPROVED');
    assert.strictEqual(captured.url, 'https://api.example.test/trade-documents/7/receive');
    assert.strictEqual(captured.header.Authorization, 'token-1');
    assert.strictEqual(captured.header['X-Company-Id'], 'company-3');
    assert.deepStrictEqual(captured.data, { decision: 'APPROVE', signatureBase64: 'AQID' });
    wx.getFileSystemManager = () => ({ statSync: () => ({ size: 600 * 1024 }) });
    await assert.rejects(uploadSignatureApiFile('/trade-documents/7/receive', '/tmp/sign.png'), /过大/);
  } finally { wx.getFileSystemManager = oldFs; wx.request = oldRequest; app.globalData.isLocalDevelopment = oldLocal; }
});

test('multipart upload sends auth, tenant and form fields without base64 packaging', async () => {
  let captured;
  wx.getStorageSync = () => '';
  wx.uploadFile = options => {
    captured = options;
    options.success({ statusCode: 200, data: '{"code":0,"message":"ok","data":{"id":18}}' });
  };

  const result = await uploadMultipartApiFile(
    '/contracts/12/attachments', '/tmp/invoice.jpg',
    { category: 'INVOICE', invoiceAmount: 88.5, ignored: null }
  );

  assert.deepStrictEqual(result, { id: 18 });
  assert.strictEqual(captured.url, 'https://api.example.test/contracts/12/attachments');
  assert.strictEqual(captured.filePath, '/tmp/invoice.jpg');
  assert.strictEqual(captured.name, 'file');
  assert.deepStrictEqual(captured.header, {
    Authorization: 'token-1',
    'X-Company-Id': 'company-3'
  });
  assert.deepStrictEqual(captured.formData, { category: 'INVOICE', invoiceAmount: '88.5' });
  assert.ok(!Object.prototype.hasOwnProperty.call(captured.formData, 'contentBase64'));
});

test('large contract files download in bounded cloud-container chunks', async () => {
  const requestedUrls = [];
  const savedChunks = [];
  const source = Buffer.from('abcdefghij');
  let inFlight = 0;
  let maxInFlight = 0;
  wx.getStorageSync = () => '';
  wx.getFileSystemManager = () => ({
    writeFile: options => {
      savedChunks.length = 0;
      savedChunks.push(Buffer.from(options.data, 'base64'));
      options.success();
    },
    appendFile: options => {
      savedChunks.push(Buffer.from(options.data, 'base64'));
      options.success();
    }
  });
  wx.request = options => {
    requestedUrls.push(options.url);
    const offset = Number(options.url.match(/[?&]offset=(\d+)/)[1]);
    const size = Number(options.url.match(/[?&]size=(\d+)/)[1]);
    const chunk = source.subarray(offset, Math.min(source.length, offset + size));
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    setTimeout(() => {
      inFlight -= 1;
      options.success({ statusCode: 200, data: { code: 0, message: 'ok', data: {
        offset,
        length: chunk.length,
        totalSize: source.length,
        eof: offset + chunk.length === source.length,
        contentBase64: chunk.toString('base64')
      } } });
    }, offset === 3 ? 8 : 1);
  };

  const result = await downloadChunkedApiFile(
    '/contract-attachments/19/content-chunk-data', '/user-data/资料-19.pdf', 10, 3
  );

  assert.strictEqual(result.filePath, '/user-data/资料-19.pdf');
  assert.strictEqual(result.fileSize, 10);
  assert.strictEqual(Buffer.concat(savedChunks).toString(), 'abcdefghij');
  assert.strictEqual(maxInFlight, 3);
  assert.ok(requestedUrls[0].endsWith(
    '/contract-attachments/19/content-chunk-data?offset=0&size=3'));
  assert.ok(requestedUrls[1].endsWith(
    '/contract-attachments/19/content-chunk-data?offset=3&size=3'));
  assert.ok(requestedUrls[2].endsWith(
    '/contract-attachments/19/content-chunk-data?offset=6&size=3'));
  assert.ok(requestedUrls[3].endsWith(
    '/contract-attachments/19/content-chunk-data?offset=9&size=3'));
});

test('downloaded immutable files are reused only when their local size matches', () => {
  wx.getFileSystemManager = () => ({ statSync: () => ({ size: 8192 }) });
  assert.strictEqual(localFileReady('/user-data/file.pdf', 8192), true);
  assert.strictEqual(localFileReady('/user-data/file.pdf', 4096), false);
  wx.getFileSystemManager = () => ({ statSync: () => { throw new Error('missing'); } });
  assert.strictEqual(localFileReady('/user-data/missing.pdf', 8192), false);
});

test('home snapshots are isolated by user, company, role and period and expire safely', () => {
  const storage = {};
  wx.getStorageSync = key => storage[key] || '';
  wx.setStorageSync = (key, value) => { storage[key] = value; };
  wx.removeStorageSync = key => { delete storage[key]; };
  const now = 2_000_000_000_000;
  const context = { userId: '7', companyId: '8', role: 'supplier', period: 'year' };
  const snapshot = writeHomeSnapshot(context, {
    companyDisplayName: '测试企业',
    stats: { totalAmount: '99', totalOrders: 2, counterpartyCount: 1 }
  }, now);

  assert.ok(snapshotKey(context).includes('_7_8_supplier_year'));
  assert.strictEqual(readHomeSnapshot(context, now + 1000).payload.companyDisplayName, '测试企业');
  assert.strictEqual(readHomeSnapshot({ ...context, userId: '9' }, now + 1000), null);
  assert.strictEqual(readHomeSnapshot({ ...context, companyId: '10' }, now + 1000), null);
  assert.strictEqual(readHomeSnapshot({ ...context, role: 'buyer' }, now + 1000), null);
  assert.strictEqual(readHomeSnapshot({ ...context, period: 'month' }, now + 1000), null);
  assert.strictEqual(readHomeSnapshot(context, now + 31 * 24 * 60 * 60 * 1000), null);

  writeHomeSnapshot(context, { companyDisplayName: '测试企业' }, now);
  clearHomeSnapshots();
  assert.strictEqual(storage[snapshotKey(context)], undefined);
});

test('custom tab bar moves its indicator by one slot per navigation item', () => {
  assert.strictEqual(tabIndicatorTransform(0), 'translate3d(0%, 0, 0)');
  assert.strictEqual(tabIndicatorTransform(1), 'translate3d(100%, 0, 0)');
  assert.strictEqual(tabIndicatorTransform(2), 'translate3d(200%, 0, 0)');

  app.globalData.activeTabIndex = 2;
  let movement;
  syncTabBar({
    getTabBar: () => ({
      moveTo() {},
      moveFromTo: (from, to) => { movement = { from, to }; }
    })
  }, 1);
  assert.deepStrictEqual(movement, { from: 2, to: 1 });
  assert.strictEqual(app.globalData.activeTabIndex, 1);

  const componentScript = fs.readFileSync(
    path.join(__dirname, '..', 'custom-tab-bar', 'index.js'),
    'utf8'
  );
  assert.ok(!componentScript.includes('setTimeout'));
});

test('privacy prompt hides both native and custom tab bars', () => {
  let customHidden;
  let nativeHidden = false;
  let nativeShown = false;
  wx.hideTabBar = () => { nativeHidden = true; };
  wx.showTabBar = () => { nativeShown = true; };
  const page = {
    getTabBar: () => ({ setHidden: hidden => { customHidden = hidden; } })
  };

  setTabBarHidden(page, true);
  assert.strictEqual(app.globalData.tabBarHidden, true);
  assert.strictEqual(customHidden, true);
  assert.strictEqual(nativeHidden, true);

  setTabBarHidden(page, false);
  assert.strictEqual(app.globalData.tabBarHidden, false);
  assert.strictEqual(customHidden, false);
  assert.strictEqual(nativeShown, true);
});

test('payment voucher requires a manually entered amount before upload', () => {
  const contractPreview = loadPage('../pages/contract-preview/contract-preview');
  let uploaded;
  const context = {
    data: {
      attachmentUploading: false,
      paymentAmount: '',
      pendingPaymentAttachment: null
    },
    setData(changes, callback) {
      Object.assign(this.data, changes);
      if (callback) callback();
    },
    uploadAttachment: (category, filePath, originalName, metadata) => {
      uploaded = { category, filePath, originalName, metadata };
    }
  };

  contractPreview.prepareAttachmentUpload.call(
    context,
    'PAYMENT_VOUCHER',
    '/tmp/voucher.pdf',
    '转款凭证.pdf'
  );

  assert.strictEqual(context.data.showPaymentAmountEditor, true);
  assert.deepStrictEqual(context.data.pendingPaymentAttachment, {
    filePath: '/tmp/voucher.pdf',
    originalName: '转款凭证.pdf'
  });
  contractPreview.onPaymentAmountInput.call(context, { detail: { value: '1288.5' } });
  contractPreview.confirmPaymentAttachmentUpload.call(context);
  assert.deepStrictEqual(uploaded, {
    category: 'PAYMENT_VOUCHER',
    filePath: '/tmp/voucher.pdf',
    originalName: '转款凭证.pdf',
    metadata: { voucherAmount: '1288.50', voucherDate: context.data.paymentDate }
  });
  assert.strictEqual(context.data.showPaymentAmountEditor, false);
});

test('payment voucher viewing is separate from handwritten confirmation', () => {
  const approvalDir = path.join(__dirname, '..', 'pages', 'contract-approval');
  const approvalScript = fs.readFileSync(path.join(approvalDir, 'contract-approval.js'), 'utf8');
  const approvalTemplate = fs.readFileSync(path.join(approvalDir, 'contract-approval.wxml'), 'utf8');
  assert.ok(approvalScript.includes("if (item.approvalType === 'PAYMENT_VOUCHER')"));
  assert.ok(approvalScript.includes("'signature'"));
  assert.ok(approvalTemplate.includes('查看资料时不会要求签名'));
  assert.ok(approvalTemplate.includes('签字并确认通过'));
});

test('invoice requires date and amount while the server generates its number', () => {
  const contractPreview = loadPage('../pages/contract-preview/contract-preview');
  let uploaded;
  const context = {
    data: { attachmentUploading: false, pendingInvoiceAttachment: null },
    setData(changes, callback) {
      Object.assign(this.data, changes);
      if (callback) callback();
    },
    uploadAttachment: (category, filePath, originalName, metadata) => {
      uploaded = { category, filePath, originalName, metadata };
    }
  };
  contractPreview.prepareAttachmentUpload.call(context, 'INVOICE', '/tmp/invoice.pdf', '发票.pdf');
  assert.strictEqual(context.data.showInvoiceEditor, true);
  contractPreview.onInvoiceAmountInput.call(context, { detail: { value: '88.5' } });
  const invoiceDate = context.data.invoiceDate;
  contractPreview.confirmInvoiceUpload.call(context);
  assert.deepStrictEqual(uploaded, {
    category: 'INVOICE',
    filePath: '/tmp/invoice.pdf',
    originalName: '发票.pdf',
    metadata: { invoiceDate, invoiceAmount: '88.50' }
  });
  const template = fs.readFileSync(
    path.join(__dirname, '..', 'pages', 'contract-preview', 'contract-preview.wxml'), 'utf8'
  );
  assert.ok(!template.includes('发票号码'));
  assert.ok(!template.includes('无需录入发票号码'));
});

test('contract attachments download to a safe persistent path for every category', () => {
  const contractPreview = loadPage('../pages/contract-preview/contract-preview');
  wx.env = { USER_DATA_PATH: '/user-data' };

  assert.strictEqual(contractPreview.attachmentDownloadPath({
    id: 18,
    originalName: '../转款:凭证.pdf',
    contentType: 'application/pdf'
  }), '/user-data/_转款_凭证-18.pdf');
  assert.strictEqual(contractPreview.attachmentDownloadPath({
    id: 19,
    originalName: '其它资料',
    contentType: 'image/png'
  }), '/user-data/其它资料-19.png');

  const script = fs.readFileSync(
    path.join(__dirname, '..', 'pages', 'contract-preview', 'contract-preview.js'),
    'utf8'
  );
  assert.ok(!script.includes("download && attachment.category === 'INVOICE'"));
  assert.ok(script.includes('/contract-attachments/${attachment.id}/content-chunk-data'));
  assert.ok(script.includes('downloadChunkedApiFile'));
  assert.ok(script.includes('localFileReady(localFilePath, fileSize)'));
  assert.ok(!script.includes('downloadBinaryApiFile'));
});

test('contract detail renders first and defers fulfillment plus remote signing refresh', () => {
  const script = fs.readFileSync(
    path.join(__dirname, '..', 'pages', 'contract-preview', 'contract-preview.js'),
    'utf8'
  );
  assert.ok(script.includes("if (this.data.activeTab === 'fulfillment')"));
  assert.ok(script.includes('syncContractSigningInBackground()'));
  assert.ok(script.includes('页面先使用本地签署状态'));
  assert.ok(!script.includes("signing${syncSigning ? '/sync' : ''}"));
});

test('personal certification refreshes terminal results safely and formats Beijing time', () => {
  const pageDir = path.join(__dirname, '..', 'pages', 'personal-cert');
  const script = fs.readFileSync(path.join(pageDir, 'personal-cert.js'), 'utf8');
  const template = fs.readFileSync(path.join(pageDir, 'personal-cert.wxml'), 'utf8');
  assert.ok(script.includes("identity.status !== 'VERIFIED'"));
  assert.ok(script.includes('formatBeijingTime(identity.verifiedAt)'));
  assert.ok(script.includes("title: status === 'VERIFIED' ? '认证结果已更新'"));
  assert.ok(!template.includes('敏感信息安全处理'));
  assert.ok(!template.includes('商签通不保存完整证件号或人脸照片'));
});

test('profile exposes legal, help, about and safe account cancellation without a settings layer', () => {
  const appConfig = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'app.json'), 'utf8'));
  [
    'pages/legal-document/legal-document',
    'pages/help-center/help-center',
    'pages/about/about',
    'pages/account-cancel/account-cancel'
  ].forEach(page => assert.ok(appConfig.pages.includes(page)));
  assert.ok(!appConfig.pages.includes('pages/settings/settings'));

  const meScript = fs.readFileSync(path.join(__dirname, '..', 'pages', 'me', 'me.js'), 'utf8');
  const meTemplate = fs.readFileSync(path.join(__dirname, '..', 'pages', 'me', 'me.wxml'), 'utf8');
  assert.ok(!meScript.includes('/pages/settings/settings'));
  assert.ok(!meTemplate.includes('设置中心'));
  assert.ok(!meScript.includes("title: '关于商签通'"));
  assert.ok(!meScript.includes("title: '用户许可使用协议'"));
  assert.ok(meTemplate.includes('账号与身份'));
  assert.ok(meTemplate.includes('个人信息收集清单'));
  assert.ok(meTemplate.includes('第三方信息共享清单'));
  assert.ok(!meTemplate.includes('系统权限管理'));
  assert.ok(meTemplate.includes('帮助与反馈'));
  assert.ok(meTemplate.includes('账号注销'));
  assert.ok(meTemplate.includes('/images/icons/info-collection.svg'));
  assert.ok(meTemplate.includes('/images/icons/info-sharing.svg'));
  assert.ok(meTemplate.includes('/images/icons/account-cancel.svg'));
  assert.ok(!meTemplate.includes('setting-symbol'));

  const companyTemplate = fs.readFileSync(
    path.join(__dirname, '..', 'pages', 'company', 'company.wxml'), 'utf8'
  );
  assert.ok(!companyTemplate.includes('<view class="count-pill">{{todos.length}}</view>'));
  assert.ok(!companyTemplate.includes('state-pill attention'));
  assert.ok(companyTemplate.includes('<view class="state-pill" wx:if="{{item.count}}">'));

  const legalTemplate = fs.readFileSync(
    path.join(__dirname, '..', 'templates', 'legal-content.wxml'), 'utf8'
  );
  assert.ok(legalTemplate.includes('userAgreementContent'));
  assert.ok(legalTemplate.includes('collectionListContent'));
  assert.ok(legalTemplate.includes('sharingListContent'));
  assert.ok(legalTemplate.includes('法大大电子签服务'));

  const helpTemplate = fs.readFileSync(
    path.join(__dirname, '..', 'pages', 'help-center', 'help-center.wxml'), 'utf8'
  );
  assert.ok(helpTemplate.includes('open-type="contact"'));
  assert.ok(helpTemplate.includes('常见问题'));

  const cancelScript = fs.readFileSync(
    path.join(__dirname, '..', 'pages', 'account-cancel', 'account-cancel.js'), 'utf8'
  );
  const cancelTemplate = fs.readFileSync(
    path.join(__dirname, '..', 'pages', 'account-cancel', 'account-cancel.wxml'), 'utf8'
  );
  assert.ok(cancelTemplate.includes('联系平台支持申请注销'));
  assert.ok(cancelTemplate.includes('不提供一键删除'));
  assert.ok(!cancelScript.includes("method: 'DELETE'"));
  assert.ok(!cancelScript.includes('/account/cancel'));

  const aboutScript = fs.readFileSync(
    path.join(__dirname, '..', 'pages', 'about', 'about.js'), 'utf8'
  );
  const aboutTemplate = fs.readFileSync(
    path.join(__dirname, '..', 'pages', 'about', 'about.wxml'), 'utf8'
  );
  assert.ok(aboutScript.includes('wx.getAccountInfoSync()'));
  assert.ok(aboutTemplate.includes('当前版本'));
  assert.ok(!aboutTemplate.includes('核心能力'));
  assert.ok(!aboutTemplate.includes('用户服务协议'));
  assert.ok(!aboutTemplate.includes('帮助与反馈'));
});

test('login agreement links reuse the dedicated document reader', () => {
  ['login', 'phone-login'].forEach(pageName => {
    const pageDir = path.join(__dirname, '..', 'pages', pageName);
    const script = fs.readFileSync(path.join(pageDir, `${pageName}.js`), 'utf8');
    const template = fs.readFileSync(path.join(pageDir, `${pageName}.wxml`), 'utf8');
    assert.ok(script.includes('/pages/legal-document/legal-document?type=user'));
    assert.ok(script.includes('/pages/legal-document/legal-document?type=privacy'));
    assert.ok(!template.includes('agreementType'));
  });
});

test('request injects auth and tenant headers and unwraps API data', async () => {
  let captured;
  wx.getStorageSync = () => '';
  wx.request = options => {
    captured = options;
    options.success({ statusCode: 200, data: { code: 0, data: { id: 9 } } });
  };

  const result = await request({ url: '/orders', method: 'POST', data: { amount: 10 } });
  assert.deepStrictEqual(result, { id: 9 });
  assert.strictEqual(captured.url, 'https://api.example.test/orders');
  assert.strictEqual(captured.header.Authorization, 'token-1');
  assert.strictEqual(captured.header['X-Company-Id'], 'company-3');
  assert.strictEqual(captured.method, 'POST');
});

test('request exposes business and network failures', async () => {
  wx.getStorageSync = () => '';
  wx.request = options => options.success({ statusCode: 400, data: { code: 400, message: '参数错误' } });
  await assert.rejects(request({ url: '/orders' }), /参数错误/);

  wx.request = options => options.fail(new Error('offline'));
  await assert.rejects(request({ url: '/orders' }), /offline/);
});

test('authentication URL loading ignores concurrent taps and permits retry after failure', async () => {
  const page = loadPage('../pages/fadada-auth/fadada-auth');
  let calls = 0;
  let pending;
  wx.request = options => { calls += 1; pending = options; };
  const context = {
    data: { scene: 'personal', options: {} },
    setData(values) { Object.assign(this.data, values); }
  };
  const first = page.loadServiceUrl.call(context);
  await page.loadServiceUrl.call(context);
  assert.strictEqual(calls, 1);
  pending.success({ statusCode: 400, data: { code: 400, message: '认证暂不可用' } });
  await first;
  assert.strictEqual(context.data.errorMessage, '认证暂不可用');
  assert.strictEqual(context.data.loading, false);
  const retry = page.loadServiceUrl.call(context);
  assert.strictEqual(calls, 2);
  pending.fail(new Error('offline'));
  await retry;
  assert.strictEqual(context._loadingServiceUrl, false);
});

test('return page reuses verified company state and reconciles a concurrent successful callback', async () => {
  const page = loadPage('../pages/service-return/service-return');
  const context = { authenticationCompleted: page.authenticationCompleted };
  let calls = [];
  wx.request = options => {
    calls.push(options.method);
    options.success({ statusCode: 200, data: { code: 0, data: { status: 'VERIFIED' } } });
  };
  const url = '/fadada/companies/123/identity';
  assert.strictEqual((await page.readAuthenticationResult.call(context, url, 'company')).status, 'VERIFIED');
  assert.deepStrictEqual(calls, ['GET']);
  calls = [];
  wx.request = options => {
    calls.push(options.method);
    if (options.method === 'POST') options.fail(new Error('provider busy'));
    else options.success({ statusCode: 200, data: { code: 0, data: {
      status: calls.length === 1 ? 'IN_PROGRESS' : 'VERIFIED'
    } } });
  };
  assert.strictEqual((await page.readAuthenticationResult.call(context, url, 'company')).status, 'VERIFIED');
  assert.deepStrictEqual(calls, ['GET', 'POST', 'GET']);
  wx.request = options => {
    if (options.method === 'POST') options.fail(new Error('provider busy'));
    else options.success({ statusCode: 200, data: { code: 0, data: { status: 'IN_PROGRESS' } } });
  };
  await assert.rejects(page.readAuthenticationResult.call(context, url, 'company'), /provider busy/);
  assert.strictEqual(page.authenticationCompleted({ status: 'VERIFIED', enabledSealCount: 0 }, 'seal'), false);
});

test('verified company return switches the exact company before home and ignores a stale session refresh', async () => {
  const previousApp = global.getApp;
  const instance = appInstance(loadAppDefinition());
  instance.globalData.token = 'token';
  instance.setCurrentCompany('8');
  instance.checkMembershipNotices = () => {};
  global.getApp = () => instance;
  const storage = {};
  wx.setStorageSync = (key, value) => { storage[key] = value; };
  let refreshRequest;
  let switchRequest;
  const navigations = [];
  wx.switchTab = options => navigations.push(options.url);
  wx.redirectTo = options => navigations.push(options.url);
  wx.request = options => {
    if (options.url.endsWith('/me')) refreshRequest = options;
    else if (options.url.endsWith('/me/switch-company')) switchRequest = options;
    else {
      assert.ok(options.url.endsWith('/fadada/companies/9/identity'));
      assert.strictEqual(options.header['X-Company-Id'], undefined);
      options.success({ statusCode: 200, data: { code: 0, data: { status: 'VERIFIED' } } });
    }
  };
  try {
    const refresh = instance.loadMe();
    const page = pageInstance(loadPage('../pages/service-return/service-return'));
    page.data.options = { scene: 'company', companyId: '9' };
    const sync = page.syncResult();
    await Promise.resolve(); await Promise.resolve();
    page.goBusinessPage();
    assert.deepStrictEqual(navigations, []);
    assert.strictEqual(instance.getCurrentCompanyId(), '8');
    assert.strictEqual(switchRequest.header['X-Company-Id'], '9');
    assert.strictEqual(switchRequest.data.companyId, '9');
    switchRequest.success({ statusCode: 200, data: { code: 0, data: {
      user: { id: '7', currentCompanyId: '9' }, member: { roleCode: 'LEGAL' },
      companies: [{ companyId: '8' }, { companyId: '9' }]
    } } });
    await sync;
    assert.deepStrictEqual(navigations, []);
    assert.strictEqual(page.data.countdown, 5);
    page.goBusinessPage();
    assert.deepStrictEqual(navigations, ['/pages/index/index']);
    assert.strictEqual(storage.tradepass_company_id, '9');
    assert.strictEqual(instance.globalData.memberInfo.roleCode, 'LEGAL');
    refreshRequest.success({ statusCode: 200, data: { code: 0, data: {
      user: { id: '7', currentCompanyId: '8' }, member: { roleCode: 'ADMIN' }
    } } });
    await refresh;
    assert.strictEqual(instance.getCurrentCompanyId(), '9');
    assert.strictEqual(storage.tradepass_company_id, '9');
    assert.strictEqual(instance.globalData.memberInfo.roleCode, 'LEGAL');
  } finally { global.getApp = previousApp; }
});

test('company return keeps the target when pending or failed and retries a failed company switch', async () => {
  const previousSwitch = app.switchCompany;
  let switched = 0;
  let navigation;
  wx.switchTab = options => { navigation = options.url; };
  wx.redirectTo = options => { navigation = options.url; };
  app.switchCompany = async () => { switched++; throw new Error('切换暂不可用'); };
  try {
    for (const status of ['IN_PROGRESS', 'FAILED']) {
      const page = pageInstance(loadPage('../pages/service-return/service-return'));
      page.data.options = { scene: 'company', companyId: '9' };
      page.readAuthenticationResult = async () => ({ status });
      await page.syncResult();
      assert.strictEqual(switched, 0);
      assert.strictEqual(page.data.failed, true);
      page.goBusinessPage();
      assert.strictEqual(navigation, '/pages/company-cert/company-cert?companyId=9&autoSwitch=1');
    }
    navigation = undefined;
    const page = pageInstance(loadPage('../pages/service-return/service-return'));
    page.data.options = { scene: 'company', companyId: '9' };
    page.readAuthenticationResult = async () => ({ status: 'VERIFIED' });
    await page.syncResult();
    assert.strictEqual(navigation, undefined);
    assert.strictEqual(page.data.message, '切换暂不可用');
    assert.strictEqual(page.data.failed, true);
    app.switchCompany = async id => { assert.strictEqual(id, '9'); };
    await page.syncResult();
    assert.strictEqual(navigation, undefined);
    page.goBusinessPage();
    assert.strictEqual(navigation, '/pages/index/index');
    assert.strictEqual(page.data.failed, false);

    const missing = pageInstance(loadPage('../pages/service-return/service-return'));
    missing.data.options = { scene: 'company' };
    missing.readAuthenticationResult = async () => { throw new Error('must not query an unknown company'); };
    await missing.syncResult();
    assert.match(missing.data.message, /缺少本次认证的企业信息/);
  } finally { app.switchCompany = previousSwitch; }
});

test('company status loads the explicit pending company and opens confirmation once certification completes', async () => {
  const previousSwitch = app.switchCompany;
  let status = 'IN_PROGRESS';
  let switched;
  let navigation;
  const calls = [];
  app.switchCompany = async id => { switched = id; };
  wx.switchTab = options => { navigation = options.url; };
  wx.redirectTo = options => { navigation = options.url; };
  wx.request = options => {
    calls.push(options.url);
    assert.strictEqual(options.header['X-Company-Id'], undefined);
    const data = options.url.endsWith('/companies/9')
      ? { id: '9', name: '本次认证企业', creditCode: 'NEW-CREDIT', legalPersonName: '张三' }
      : { status, enabled: true, enabledSealCount: 0 };
    options.success({ statusCode: 200, data: { code: 0, data } });
  };
  try {
    const page = pageInstance(loadPage('../pages/company-cert/company-cert'));
    let initialSync;
    const loadCompany = page.loadCompany;
    page.loadCompany = sync => { initialSync = loadCompany.call(page, sync); return initialSync; };
    page.onLoad({ companyId: '9', autoSwitch: '1' });
    await initialSync;
    assert.strictEqual(page.data.companyName, '本次认证企业');
    assert.strictEqual(page.data.companyId, '9');
    assert.strictEqual(switched, undefined);
    assert.strictEqual(navigation, undefined);
    assert.ok(calls.every(url => !url.endsWith('/me')));
    status = 'VERIFIED';
    await page.loadCompany(true);
    assert.strictEqual(switched, undefined);
    assert.strictEqual(navigation, '/pages/service-return/service-return?scene=company&companyId=9');
  } finally { app.switchCompany = previousSwitch; }
});

test('seal return preserves its enterprise and a normal verified status refresh still synchronizes seals', async () => {
  let navigation;
  wx.redirectTo = options => { navigation = options.url; };
  const result = pageInstance(loadPage('../pages/service-return/service-return'));
  result.data.loading = false;
  result.data.options = { scene: 'seal', companyId: '9' };
  result.goBusinessPage();
  assert.strictEqual(navigation, '/pages/company-cert/company-cert?companyId=9');
  const page = pageInstance(loadPage('../pages/company-cert/company-cert'));
  page.data.companyId = '9';
  const calls = [];
  wx.request = options => {
    calls.push(options.url);
    options.success({ statusCode: 200, data: { code: 0, data: options.url.endsWith('/companies/9')
      ? { id: '9', name: '本次企业' }
      : { enabled: true, status: 'VERIFIED', enabledSealCount: options.method === 'POST' ? 1 : 0 }
    } });
  };
  await page.loadCompany(true);
  assert.ok(calls.some(url => url.endsWith('/identity/sync')));
  assert.strictEqual(page.data.actions[1].done, true);
  assert.strictEqual(navigation, '/pages/company-cert/company-cert?companyId=9');
});

test('company auth polling queries the target without the previous tenant and preserves the return ID', async () => {
  const page = pageInstance(loadPage('../pages/fadada-auth/fadada-auth'));
  page.data.scene = 'company';
  page.data.options = { companyId: '9' };
  let navigation;
  wx.redirectTo = options => { navigation = options.url; };
  wx.request = options => {
    assert.ok(options.url.endsWith('/fadada/companies/9/identity'));
    assert.strictEqual(options.header['X-Company-Id'], undefined);
    options.success({ statusCode: 200, data: { code: 0, data: { status: 'VERIFIED' } } });
  };
  await page.pollStatus();
  assert.strictEqual(navigation, '/pages/service-return/service-return?scene=company&companyId=9');
});

test('personal auth polling preserves provider page until backend verification', async () => {
  const page = loadPage('../pages/fadada-auth/fadada-auth');
  let status = 'IN_PROGRESS';
  let returned = 0;
  const calls = [];
  wx.request = options => {
    calls.push(options);
    options.success({ statusCode: 200, data: { code: 0, data: { status } } });
  };
  const context = {
    ...page,
    data: { scene: 'personal', options: {}, serviceUrl: 'https://example.test/auth' },
    scheduleStatusPoll() {},
    openReturnPage() { returned += 1; }
  };
  await page.pollStatus.call(context);
  assert.strictEqual(returned, 0);
  assert.strictEqual(context.data.serviceUrl, 'https://example.test/auth');
  assert.ok(calls[0].url.endsWith('/fadada/users/me/identity'));
  assert.strictEqual(calls[0].method, 'GET');
  status = 'VERIFIED';
  await page.pollStatus.call(context);
  assert.strictEqual(returned, 1);
  assert.strictEqual(context.data.serviceUrl, 'https://example.test/auth');
});

test('auth completion returns to result synchronization rather than reopening enrollment', () => {
  const page = loadPage('../pages/fadada-auth/fadada-auth');
  let url;
  wx.redirectTo = options => { url = options.url; };
  page.openReturnPage.call({ data: { scene: 'personal', options: {} }, stopStatusPolling() {} });
  assert.strictEqual(url, '/pages/service-return/service-return?scene=personal');
});

function pageInstance(page) {
  return { ...page, data: JSON.parse(JSON.stringify(page.data)),
    setData(values) { Object.assign(this.data, values); } };
}

test('member roles support multiple selections, permission union and removing one role', async () => {
  const context = pageInstance(loadPage('../pages/auth-manage/auth-manage'));
  const oldGetter = app.getCurrentCompanyId; const oldRefresh = app.refreshSession; const oldRequest = wx.request;
  app.getCurrentCompanyId = () => '123'; app.refreshSession = async () => {};
  const calls = [];
  wx.request = options => { calls.push(options); options.success({ statusCode: 200, data: { code: 0, data: null } }); };
  context.loadMembers = async () => {};
  context.data.authorizations = [{ id: '12', status: 'PENDING' },
    { id: '13', status: 'ACTIVE', roleCode: 'SALES', roles: [{ code: 'SALES' }, { code: 'FINANCE' }] }];
  context.data.approveRoles = [
    { code: 'SALES', permissions: [{ code: 'order_create' }, { code: 'contract_view' }] },
    { code: 'FINANCE', permissions: [{ code: 'invoice_view' }, { code: 'contract_view' }] }
  ];
  try {
    context.showApproveModal({ currentTarget: { dataset: { id: '12' } } });
    context.selectRole({ currentTarget: { dataset: { role: 'SALES' } } });
    context.selectRole({ currentTarget: { dataset: { role: 'FINANCE' } } });
    assert.strictEqual(calls.length, 0);
    assert.deepStrictEqual(context.data.combinedPermissions.map(p => p.code), ['order_create', 'contract_view', 'invoice_view']);
    await context.confirmApprove();
    assert.ok(calls[0].url.endsWith('/authorizations/12/approve?companyId=123'));
    assert.strictEqual(calls[0].method, 'POST');
    assert.deepStrictEqual(calls[0].data.roleCodes, ['SALES', 'FINANCE']);
    context.showApproveModal({ currentTarget: { dataset: { id: '13' } } });
    assert.deepStrictEqual(context.data.selectedRoleCodes, ['SALES', 'FINANCE']);
    context.selectRole({ currentTarget: { dataset: { role: 'SALES' } } });
    assert.deepStrictEqual(context.data.combinedPermissions.map(p => p.code), ['invoice_view', 'contract_view']);
    await context.confirmApprove();
    assert.ok(calls[1].url.endsWith('/authorizations/13/role?companyId=123'));
    assert.strictEqual(calls[1].method, 'PUT');
    assert.deepStrictEqual(calls[1].data, { roleCode: 'FINANCE', roleCodes: ['FINANCE'], customPermissions: [] });
    context.selectRole({ currentTarget: { dataset: { role: 'FINANCE' } } });
    await context.confirmApprove();
    assert.strictEqual(calls.length, 2);
  } finally { app.getCurrentCompanyId = oldGetter; app.refreshSession = oldRefresh; wx.request = oldRequest; }
});

test('default roles can be copied with reduced permissions without changing the source', () => {
  const context = pageInstance(loadPage('../pages/role-manage/role-manage'));
  context._permDefs = [{ code: 'order_view', label: '订单查看' }, { code: 'order_create', label: '订单创建' }];
  context.data.roles = [{ id: '1', name: '销售员', editable: true, systemRole: true, deletable: false, permissions: ['order_view', 'order_create'] }];
  context.editRole({ currentTarget: { dataset: { id: '1' } } });
  assert.strictEqual(context.data.systemRole, true);
  assert.strictEqual(context.data.deletable, false);
  context.copyRole({ currentTarget: { dataset: { id: '1' } } });
  context.togglePerm({ currentTarget: { dataset: { code: 'order_create' } } });
  assert.strictEqual(context.data.editRoleId, '');
  assert.strictEqual(context.data.systemRole, false);
  assert.deepStrictEqual(context.data.allPerms.filter(p => p.checked).map(p => p.code), ['order_view']);
  assert.deepStrictEqual(context.data.roles[0].permissions, ['order_view', 'order_create']);
});

test('enterprise management entries follow effective permissions including custom roles', async () => {
  const context = pageInstance(loadPage('../pages/company/company'));
  const previousRequest = wx.request; const previousApply = app.applyMePayload;
  let member = { roleCode: 'CUSTOM_MANAGER', permissions: ['member_manage'] };
  app.applyMePayload = () => {};
  context.loadTodos = async () => {}; context.loadEnterpriseMetrics = async () => {};
  wx.request = options => options.success({ statusCode: 200, data: { code: 0, data: options.url.endsWith('/me')
    ? { member, companies: [{ companyId: '123' }], user: { currentCompanyId: '123' } } : [] } });
  try {
    await context.loadData();
    assert.strictEqual(context.data.canManage, true);
    assert.strictEqual(context.data.canCompanyManage, false);
    member = { roleCode: 'ADMIN', permissions: ['contract_template'] };
    await context.loadData();
    assert.strictEqual(context.data.canManage, false);
    assert.strictEqual(context.data.canContractTemplate, true);
  } finally { wx.request = previousRequest; app.applyMePayload = previousApply; }
});

test('partner loading distinguishes failures from empty company bindings and can retry', async () => {
  const context = pageInstance(loadPage('../pages/index/index'));
  const oldGetter = app.getCurrentCompanyId; const oldRequest = wx.request;
  app.getCurrentCompanyId = () => '123';
  let fail = true;
  wx.request = options => options.success({ statusCode: 200, data: fail
    ? { code: 400, message: '无权执行该操作' }
    : { code: 0, data: [{ id: '1', counterpartyCompanyId: '456', counterpartyName: 'B公司', status: 'ACTIVE' }] } });
  try {
    context.data.homeHasSnapshot = true;
    context.data.relationCounterparties = [{ id: 'old', counterpartyCompanyId: '789', counterpartyName: '旧企业' }];
    assert.strictEqual(await context.loadCounterparties(), false);
    assert.strictEqual(context.data.counterpartiesError, '无权执行该操作');
    assert.deepStrictEqual(context.data.partnerCompanies, []);
    assert.strictEqual(context.data.counterpartiesLoading, false);
    fail = false;
    assert.strictEqual(await context.loadCounterparties(), true);
    assert.strictEqual(context.data.counterpartiesError, '');
    assert.strictEqual(context.data.partnerCompanies[0].counterpartyName, 'B公司');
  } finally { app.getCurrentCompanyId = oldGetter; wx.request = oldRequest; }
});

test('member invitation prepares on entry and ready button opens native sharing', async () => {
  const page = loadPage('../pages/auth-manage/auth-manage');
  const oldReady = app.ensureSessionReady; const oldGetter = app.getCurrentCompanyId;
  app.ensureSessionReady = async () => {}; app.getCurrentCompanyId = () => '123';
  const context = pageInstance(page); let prepared = 0;
  context.shareInvite = () => { prepared++; };
  context.loadMembers = () => {}; context.loadRoles = () => {};
  try {
    await context.onShow(); assert.strictEqual(prepared, 1);
    await context.onShow(); assert.strictEqual(prepared, 2);
    const template = fs.readFileSync(path.join(__dirname, '../pages/auth-manage/auth-manage.wxml'), 'utf8');
    assert.ok(template.includes('wx:if="{{inviteCode && !preparingInvite}}" open-type="share"'));
    assert.ok(!template.includes('生成成员邀请'));
    assert.ok(!template.includes('发送成员邀请给微信好友'));
  } finally { app.ensureSessionReady = oldReady; app.getCurrentCompanyId = oldGetter; }
});

test('member invitation waits for a code and cannot share across companies', async () => {
  const page = loadPage('../pages/auth-manage/auth-manage');
  const previousGetter = app.getCurrentCompanyId;
  const previousRequest = wx.request;
  let cid = '123'; let pending;
  app.getCurrentCompanyId = () => cid;
  wx.request = options => { pending = options; };
  const context = pageInstance(page);
  const event = { from: 'button', target: { dataset: { inviteType: 'member' } } };
  try {
    const generating = context.shareInvite();
    assert.strictEqual(context.data.preparingInvite, true);
    assert.strictEqual(context.onShareAppMessage(event).path, '/pages/index/index');
    pending.success({ statusCode: 200, data: { code: 0, data: { code: 'member+code' } } });
    await generating;
    const share = context.onShareAppMessage(event);
    assert.strictEqual(share.path, '/pages/index/index?inviteCode=member%2Bcode&type=member');
    assert.strictEqual(share.imageUrl, '/images/member-invite-cover.png');
    cid = '456';
    assert.strictEqual(context.onShareAppMessage(event).path, '/pages/index/index');
    const next = context.shareInvite(); cid = '789';
    pending.success({ statusCode: 200, data: { code: 0, data: { code: 'stale' } } });
    await next;
    assert.strictEqual(context.data.inviteCode, '');
  } finally { app.getCurrentCompanyId = previousGetter; wx.request = previousRequest; }
});

test('member invitation reaches confirmation for an account with no enterprise', async () => {
  const previous = { ...app }; const data = { ...app.globalData }; const oldModal = wx.showModal;
  app.globalData.token = 'member-token'; app.globalData.userInfo = { id: 'new-user' };
  app.globalData.memberInfo = null; app.globalData.pendingInvite = { type: 'member', code: 'join-code' };
  app.getCurrentCompanyId = () => ''; app.restoreStoredSession = () => {}; app.ensureSessionReady = async () => {};
  const context = pageInstance(loadPage('../pages/index/index'));
  context.startApprovalPolling = () => {}; context.clearSessionRestoreTimer = () => {};
  context.restoreHomeSnapshot = () => {}; context.initRoleFromMember = () => {};
  let modal; let accepted;
  wx.showModal = options => { modal = options; };
  context.processInvite = code => { accepted = code; };
  try {
    await context.onShow();
    assert.strictEqual(context.data.showJoinForm, true);
    assert.strictEqual(modal.title, '申请加入企业组织');
    modal.success({ confirm: true }); modal.complete();
    assert.strictEqual(accepted, 'join-code');
  } finally { Object.assign(app, previous); app.globalData = data; wx.showModal = oldModal; }
});

test('partner sharing waits for invite creation and rejects stale company context', async () => {
  const page = loadPage('../pages/index/index');
  const previousMember = app.globalData.memberInfo;
  const previousGetter = app.getCurrentCompanyId;
  app.globalData.memberInfo = { roleCode: 'LEGAL' };
  app.getCurrentCompanyId = () => '123';
  let pending;
  wx.request = options => { pending = options; };
  wx.showToast = () => {};
  const context = { data: { role: 'buyer', counterpartyInviteCode: '' },
    requireLogin: () => true, setData(values) { Object.assign(this.data, values); } };
  const event = { from: 'button', target: { dataset: { inviteType: 'counterparty' } } };
  try {
    const generating = page.addCounterparty.call(context);
    assert.strictEqual(context.data.preparingInvite, true);
    assert.strictEqual(page.onShareAppMessage.call(context, event).path, '/pages/index/index');
    pending.success({ statusCode: 200, data: { code: 0, data: { code: 'test-code' } } });
    await generating;
    assert.strictEqual(context.data.preparingInvite, false);
    assert.strictEqual(page.onShareAppMessage.call(context, event).path,
      '/pages/index/index?inviteCode=test-code&type=counterparty');
    context.data.role = 'supplier';
    assert.strictEqual(page.onShareAppMessage.call(context, event).path, '/pages/index/index');
  } finally {
    app.globalData.memberInfo = previousMember;
    app.getCurrentCompanyId = previousGetter;
  }
});

test('request clears session and redirects after unauthorized response', async () => {
  const removedKeys = [];
  let redirectUrl;
  wx.getStorageSync = () => '';
  wx.removeStorageSync = key => { removedKeys.push(key); };
  wx.reLaunch = options => { redirectUrl = options.url; };
  wx.request = options => options.success({ statusCode: 401, data: {} });

  await assert.rejects(request({ url: '/orders' }), /登录已失效/);
  assert.strictEqual(app.globalData.token, '');
  assert.strictEqual(app.globalData.currentCompanyId, '');
  assert.ok(removedKeys.includes('tradepass_token'));
  assert.ok(removedKeys.includes('tradepass_company_id'));
  assert.strictEqual(redirectUrl, '/pages/index/index');
});

function loadAppDefinition(platform = 'devtools') {
  let definition;
  global.App = value => { definition = value; };
  wx.getSystemInfoSync = () => ({ platform });
  const modulePath = require.resolve('../app');
  delete require.cache[modulePath];
  require('../app');
  return definition;
}

test('app detects desktop WeChat without treating it as local development', () => {
  const definition = loadAppDefinition('windows');
  assert.strictEqual(definition.globalData.isDesktopWechat, true);
  assert.strictEqual(definition.globalData.isLocalDevelopment, false);
});

function appInstance(definition) {
  return Object.assign({}, definition, { globalData: Object.assign({}, definition.globalData) });
}

test('app restores, switches and clears tenant-aware session state', async () => {
  const definition = loadAppDefinition();
  const instance = appInstance(definition);
  const storage = {
    tradepass_token: 'stored-token',
    tradepass_company_id: '8'
  };
  const removed = [];
  wx.getStorageSync = key => storage[key] || '';
  wx.setStorageSync = (key, value) => { storage[key] = value; };
  wx.removeStorageSync = key => { removed.push(key); delete storage[key]; };
  wx.reLaunch = () => {};
  instance.loadMe = () => Promise.resolve();

  instance.onLaunch.call(instance);
  assert.strictEqual(instance.globalData.token, 'stored-token');
  assert.strictEqual(instance.globalData.currentCompanyId, '8');

  instance.setCurrentCompany.call(instance, 9);
  assert.strictEqual(storage.tradepass_company_id, '9');
  instance.setCurrentCompany.call(instance, null);
  assert.strictEqual(instance.globalData.currentCompanyId, '');

  instance.globalData.userInfo = { id: 1 };
  instance.globalData.memberInfo = { roleCode: 'ADMIN' };
  instance.globalData.companies = [{ companyId: '8' }];
  global.getApp = () => instance;
  wx.request = options => options.success({ statusCode: 200, data: { code: 0, data: null } });
  await instance.logout.call(instance);
  assert.strictEqual(instance.globalData.token, '');
  assert.strictEqual(instance.globalData.userInfo, null);
  assert.deepStrictEqual(instance.globalData.companies, []);
  assert.ok(removed.includes('tradepass_token'));
});

test('app retries a failed cold-start profile restore before home decides company state', async () => {
  const instance = appInstance(loadAppDefinition());
  const storage = {
    tradepass_token: 'stored-token',
    tradepass_company_id: '8'
  };
  wx.getStorageSync = key => storage[key] || '';
  wx.setStorageSync = (key, value) => { storage[key] = value; };
  wx.removeStorageSync = key => { delete storage[key]; };
  let attempts = 0;
  instance.loadMe = () => {
    attempts += 1;
    if (attempts === 1) return Promise.reject(new Error('container cold start'));
    return Promise.resolve(instance.applyMePayload.call(instance, {
      user: { id: '7', currentCompanyId: '8' },
      member: { roleCode: 'ADMIN', memberStatus: 'ACTIVE' },
      companies: [{ companyId: '8', companyName: '测试企业' }]
    }));
  };

  instance.onLaunch.call(instance);
  assert.strictEqual(await instance.ensureSessionReady.call(instance), null);
  await instance.refreshSession.call(instance);
  assert.strictEqual(attempts, 2);
  assert.strictEqual(instance.globalData.userInfo.currentCompanyId, '8');
  assert.strictEqual(instance.globalData.memberInfo.roleCode, 'ADMIN');

  const indexScript = fs.readFileSync(
    path.join(__dirname, '..', 'pages', 'index', 'index.js'), 'utf8'
  );
  const indexTemplate = fs.readFileSync(
    path.join(__dirname, '..', 'pages', 'index', 'index.wxml'), 'utf8'
  );
  assert.ok(indexScript.includes('loggedIn && !user'));
  assert.ok(indexScript.includes('scheduleSessionRestore()'));
  assert.ok(indexTemplate.includes('wx:elif="{{sessionRestoring && !homeHasSnapshot}}"'));
  assert.ok(!indexTemplate.includes('home-snapshot-notice'));
  assert.ok(indexScript.indexOf('this.restoreHomeSnapshot()')
    < indexScript.indexOf('await app.ensureSessionReady()'));
});

test('app switchCompany sends target tenant header and updates global profile', async () => {
  const instance = appInstance(loadAppDefinition());
  global.getApp = () => instance;
  instance.globalData.token = 'token';
  wx.setStorageSync = () => {};
  wx.removeStorageSync = () => {};
  let captured;
  wx.request = options => {
    captured = options;
    options.success({ statusCode: 200, data: { code: 0, data: {
      user: { id: '7', currentCompanyId: '9' },
      member: { roleCode: 'ADMIN' },
      companies: [{ companyId: '9' }]
    } } });
  };

  const result = await instance.switchCompany.call(instance, 9);
  assert.strictEqual(captured.header['X-Company-Id'], '9');
  assert.strictEqual(captured.data.companyId, 9);
  assert.strictEqual(instance.globalData.currentCompanyId, '9');
  assert.strictEqual(result.member.roleCode, 'ADMIN');
});

test('removed company session recovers, clears only its snapshots and acknowledges notice after confirmation', async () => {
  const instance = appInstance(loadAppDefinition());
  const previousApp = global.getApp; const previousRequest = wx.request; const previousModal = wx.showModal;
  const previousGet = wx.getStorageSync; const previousSet = wx.setStorageSync;
  const previousRemove = wx.removeStorageSync; const previousLaunch = wx.reLaunch;
  const storage = { tradepass_token: 'token', tradepass_company_id: '8', tradepass_user_id: '7' };
  wx.getStorageSync = key => storage[key] || '';
  wx.setStorageSync = (key, value) => { storage[key] = value; };
  wx.removeStorageSync = key => { delete storage[key]; };
  global.getApp = () => instance;
  instance.globalData.token = 'token';
  instance.globalData.currentCompanyId = '8';
  instance.globalData.userInfo = { id: '7', currentCompanyId: '8' };
  instance.globalData.companies = [{ companyId: '8' }, { companyId: '9' }];
  const snapshots = require('../utils/homeSnapshot');
  const removedContext = { userId: '7', companyId: '8' };
  const keptContext = { userId: '7', companyId: '9' };
  snapshots.writeHomeSnapshot(removedContext, { companyName: '被移除企业' });
  snapshots.writeHomeSnapshot(keptContext, { companyName: '仍所属企业' });
  let modal; let modalCount = 0; let ackCount = 0; let relaunch;
  wx.showModal = options => { modal = options; modalCount += 1; };
  wx.reLaunch = options => { relaunch = options.url; };
  wx.request = options => {
    let data;
    if (options.url.endsWith('/me') && options.header['X-Company-Id'] === '8') {
      options.success({ statusCode: 403, data: { code: 403, message: '无权访问指定企业' } });
      return;
    }
    assert.strictEqual(options.header['X-Company-Id'], undefined);
    if (options.url.endsWith('/me')) data = {
      user: { id: '7', currentCompanyId: '9' }, member: { roleCode: 'SALES' }, companies: [{ companyId: '9' }]
    };
    else if (options.url.endsWith('/acknowledge')) {
      assert.deepStrictEqual(options.data.ids, ['9007199254740993']);
      ackCount += 1; data = null;
    } else data = ackCount ? [] : [{ id: '9007199254740993', companyId: '8', companyName: '被移除企业' }];
    options.success({ statusCode: 200, data: { code: 0, data } });
  };
  try {
    await instance.loadMe();
    await Promise.resolve();
    assert.strictEqual(instance.globalData.currentCompanyId, '9');
    assert.deepStrictEqual(instance.globalData.companies, [{ companyId: '9' }]);
    assert.strictEqual(snapshots.readHomeSnapshot(removedContext), null);
    assert.ok(snapshots.readHomeSnapshot(keptContext));
    assert.strictEqual(relaunch, '/pages/index/index');
    assert.ok(modal.content.includes('被移除企业'));
    assert.strictEqual(modal.showCancel, false);
    assert.strictEqual(ackCount, 0);
    const pending = instance.checkMembershipNotices();
    assert.strictEqual(modalCount, 1);
    modal.success({ confirm: true });
    await pending;
    assert.strictEqual(ackCount, 1);
    await instance.checkMembershipNotices();
    assert.strictEqual(modalCount, 1);
  } finally {
    global.getApp = previousApp; wx.request = previousRequest; wx.showModal = previousModal;
    wx.getStorageSync = previousGet; wx.setStorageSync = previousSet;
    wx.removeStorageSync = previousRemove; wx.reLaunch = previousLaunch;
  }
});

test('forbidden business request removes old company and restores an unbound account without logging out', async () => {
  const instance = appInstance(loadAppDefinition());
  const previousApp = global.getApp; const previousRequest = wx.request; const previousLaunch = wx.reLaunch;
  const previousGet = wx.getStorageSync; const previousSet = wx.setStorageSync; const previousRemove = wx.removeStorageSync;
  global.getApp = () => instance;
  wx.getStorageSync = () => ''; wx.setStorageSync = () => {}; wx.removeStorageSync = () => {};
  let launched = false;
  wx.reLaunch = () => { launched = true; };
  instance.globalData.token = 'token';
  instance.globalData.currentCompanyId = '8';
  instance.globalData.userInfo = { id: '7', currentCompanyId: '8' };
  instance.globalData.memberInfo = { roleCode: 'SALES' };
  instance.globalData.companies = [{ companyId: '8' }];
  wx.request = options => {
    if (options.url.endsWith('/contracts')) {
      options.success({ statusCode: 403, data: { code: 403, message: '无权访问指定企业' } });
    } else {
      assert.strictEqual(options.header['X-Company-Id'], undefined);
      const data = options.url.endsWith('/me')
        ? { user: { id: '7', currentCompanyId: null, currentRole: 'GUEST' }, member: null, companies: [] } : [];
      options.success({ statusCode: 200, data: { code: 0, data } });
    }
  };
  try {
    await assert.rejects(request({ url: '/contracts' }), /无权访问指定企业/);
    await instance._companyAccessRecovery;
    assert.strictEqual(instance.globalData.token, 'token');
    assert.strictEqual(instance.getCurrentCompanyId(), '');
    assert.strictEqual(instance.globalData.memberInfo, null);
    assert.deepStrictEqual(instance.globalData.companies, []);
    assert.strictEqual(launched, true);
  } finally {
    global.getApp = previousApp; wx.request = previousRequest; wx.reLaunch = previousLaunch;
    wx.getStorageSync = previousGet; wx.setStorageSync = previousSet; wx.removeStorageSync = previousRemove;
  }
});

test('membership notices from a previous login cannot be shown or acknowledged by the new account', async () => {
  const instance = appInstance(loadAppDefinition());
  const previousApp = global.getApp; const previousRequest = wx.request; const previousModal = wx.showModal;
  global.getApp = () => instance;
  instance.globalData.token = 'old-token';
  let respond; let modalCount = 0;
  wx.request = options => { respond = options.success; };
  wx.showModal = () => { modalCount += 1; };
  try {
    const pending = instance.checkMembershipNotices();
    instance.globalData.token = 'new-token';
    respond({ statusCode: 200, data: { code: 0, data: [{ id: '1', companyId: '8', companyName: '旧账号企业' }] } });
    await pending;
    assert.strictEqual(modalCount, 0);
  } finally { global.getApp = previousApp; wx.request = previousRequest; wx.showModal = previousModal; }
});

test('contract sales documents only show records bound to the current contract', () => {
  const pageDir = path.join(__dirname, '..', 'pages', 'contract-preview');
  const script = fs.readFileSync(path.join(pageDir, 'contract-preview.js'), 'utf8');
  const template = fs.readFileSync(path.join(pageDir, 'contract-preview.wxml'), 'utf8');

  assert.ok(script.includes('/contracts/${this.data.contractId}/documents'));
  assert.ok(!script.includes('/orders?counterpartyName'));
  assert.ok(!script.includes('loadSalesOrders'));
  assert.ok(!template.includes('关联销售订单'));
  assert.ok(!template.includes('salesList'));
});

test('business documents require an editable template flow and do not auto-open after creation', () => {
  const script = fs.readFileSync(
    path.join(__dirname, '..', 'pages', 'contract-preview', 'contract-preview.js'),
    'utf8'
  );
  assert.ok(script.includes('documentTemplateIndex: -1'));
  assert.ok(script.includes('showDocumentEditor: true'));
  assert.ok(script.includes('content: {'));
  assert.ok(!script.includes('this.downloadBusinessDocumentFile(document, false)'));
});

test('contract collaboration groups sales orders and uploadable invoices in fulfillment', () => {
  const pageDir = path.join(__dirname, '..', 'pages', 'contract-preview');
  const script = fs.readFileSync(path.join(pageDir, 'contract-preview.js'), 'utf8');
  const template = fs.readFileSync(path.join(pageDir, 'contract-preview.wxml'), 'utf8');
  assert.ok(script.includes("{ key: 'detail', label: '合同' }"));
  assert.ok(script.includes("{ key: 'fulfillment', label: '履约资料' }"));
  assert.ok(!script.includes("{ key: 'sales', label: '销售单' }"));
  assert.ok(!script.includes("{ key: 'payment'"));
  assert.ok(template.indexOf('>销售单<') < template.indexOf('>物流单<'));
  assert.ok(template.indexOf('>发票<') < template.indexOf('>其它<'));
  assert.ok(template.includes('data-category="INVOICE"'));
  assert.ok(script.includes('attachments?category=INVOICE'));
  assert.ok(script.includes('showPaymentAmountEditor: true'));
  assert.ok(script.includes('voucherAmount: normalizedAmount'));
  assert.ok(!script.includes('DELIVERY_NOTE'));
  assert.ok(!template.includes('送货单'));
  assert.ok(template.includes('我的进展'));
  assert.ok(template.includes('仅当前账号可见'));
});

test('all sales orders start as editable drafts before counterpart confirmation', () => {
  const contractPreview = fs.readFileSync(
    path.join(__dirname, '..', 'pages', 'contract-preview', 'contract-preview.js'), 'utf8'
  );
  const salesDetail = fs.readFileSync(
    path.join(__dirname, '..', 'pages', 'sales-order-detail', 'sales-order-detail.js'), 'utf8'
  );
  assert.ok(contractPreview.includes("contract.status === 'PENDING'"));
  assert.ok(contractPreview.includes("salesOrderCreateText: '创建草稿'"));
  assert.ok(contractPreview.includes('提交并经需方确认后才会进入对账'));
  assert.ok(salesDetail.includes('/trade-documents/${this.data.id}/draft'));
  assert.ok(salesDetail.includes('/trade-documents/${this.data.id}/publish'));
});

test('live reconciliation and sales-order confirmation pages are wired', () => {
  const appConfig = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'app.json'), 'utf8'));
  const reconciliation = fs.readFileSync(
    path.join(__dirname, '..', 'pages', 'reconciliation', 'reconciliation.js'), 'utf8'
  );
  const salesDetail = fs.readFileSync(
    path.join(__dirname, '..', 'pages', 'sales-order-detail', 'sales-order-detail.js'), 'utf8'
  );
  assert.ok(appConfig.pages.includes('pages/sales-order-detail/sales-order-detail'));
  assert.ok(appConfig.pages.includes('pages/inventory/inventory'));
  assert.ok(reconciliation.includes('/reconciliation-accounts'));
  assert.ok(reconciliation.includes('/pdf-data'));
  assert.ok(!reconciliation.includes('/workbook-data'));
  assert.ok(!reconciliation.includes('/reconciliation-statements'));
  assert.ok(salesDetail.includes("this.openSignatureEditor('RECEIVE_ONLY')"));
  assert.ok(salesDetail.includes("this.openSignatureEditor('INBOUND', warehouse.id)"));
  assert.ok(salesDetail.includes('`/trade-documents/${this.data.id}/receive`'));
  assert.ok(salesDetail.includes("this.submitReceive('REJECT'"));
  const template = fs.readFileSync(
    path.join(__dirname, '..', 'pages', 'sales-order-detail', 'sales-order-detail.wxml'), 'utf8'
  );
  assert.ok(template.includes('id="salesOrderSignatureCanvas"'));
  assert.ok(template.includes('签名会自动填写到{{documentLabel}} PDF'));
  const reconciliationTemplate = fs.readFileSync(
    path.join(__dirname, '..', 'pages', 'reconciliation', 'reconciliation.wxml'), 'utf8'
  );
  assert.ok(reconciliationTemplate.includes('查看明细'));
  assert.ok(reconciliationTemplate.includes('下载 PDF'));
});

test('inventory balance displays unit price and inventory amount', () => {
  const pageDir = path.join(__dirname, '..', 'pages', 'inventory');
  const script = fs.readFileSync(path.join(pageDir, 'inventory.js'), 'utf8');
  const template = fs.readFileSync(path.join(pageDir, 'inventory.wxml'), 'utf8');
  assert.ok(script.includes('unitPriceText'));
  assert.ok(script.includes('inventoryAmountText'));
  assert.ok(template.includes('库存单价'));
  assert.ok(template.includes('库存金额'));
});

test('home company switching uses the custom switcher instead of a native action sheet', () => {
  const script = fs.readFileSync(path.join(__dirname, '..', 'pages', 'index', 'index.js'), 'utf8');
  const template = fs.readFileSync(path.join(__dirname, '..', 'pages', 'index', 'index.wxml'), 'utf8');
  assert.ok(script.includes('showCompanySwitcher: true'));
  assert.ok(script.includes('if (companies.length === 0) return'));
  assert.ok(!script.includes('wx.showActionSheet'));
  assert.ok(template.includes('company-switch-sheet'));
  assert.ok(template.includes('company-switch-action primary'));
  assert.ok(template.includes('添加并管理另一家公司'));
  assert.ok(template.includes('输入邀请码加入'));
  assert.ok(template.includes('加入管理员邀请的企业空间'));
});

test('profile only displays the current company and cannot switch tenants', () => {
  const script = fs.readFileSync(path.join(__dirname, '..', 'pages', 'me', 'me.js'), 'utf8');
  const template = fs.readFileSync(path.join(__dirname, '..', 'pages', 'me', 'me.wxml'), 'utf8');
  assert.ok(!script.includes('openCompanySwitcher'));
  assert.ok(!template.includes('切换企业'));
  assert.ok(!template.includes('bindtap="openCompanySwitcher"'));
});

test('enterprise management owns company switching and has no duplicate member invite action', () => {
  const script = fs.readFileSync(path.join(__dirname, '..', 'pages', 'company', 'company.js'), 'utf8');
  const template = fs.readFileSync(path.join(__dirname, '..', 'pages', 'company', 'company.wxml'), 'utf8');
  assert.ok(script.includes('showCompanySwitcher: true'));
  assert.ok(!script.includes('wx.showActionSheet'));
  assert.ok(template.includes('enterprise-switch-sheet'));
  assert.ok(template.includes('enterprise-switch-action primary'));
  assert.ok(template.includes('加入管理员邀请的企业空间'));
  assert.ok(template.indexOf('企业管理') < template.indexOf('我的企业'));
  assert.ok(!template.includes('邀请企业成员'));
  assert.ok(!template.includes('switchCompanyFromRow'));
});

test('home partner list is driven only by bound enterprise relations', () => {
  const script = fs.readFileSync(path.join(__dirname, '..', 'pages', 'index', 'index.js'), 'utf8');
  const detail = fs.readFileSync(path.join(__dirname, '..', 'pages', 'order-detail', 'order-detail.js'), 'utf8');

  assert.ok(script.includes('relations.forEach(item =>'));
  assert.ok(!script.includes('relations.concat(ranking)'));
  assert.ok(!script.includes('ranking.concat(relations)'));
  assert.ok(script.includes("if (!name || !counterpartyCompanyId"));
  assert.ok(detail.includes("canSignContract: !!counterpartyCompanyId && hasPerm('contract_sign')"));
});

const largeIds = ['2098123456789012345', '2098123456789012346'];

async function withIdPage(relativePath, check) {
  const previousApp = global.getApp;
  const previousWx = global.wx;
  const idApp = { globalData: {
    baseUrl: 'https://api.example.test', isLocalDevelopment: true,
    token: 'id-test-token', currentCompanyId: largeIds[1]
  }, getCurrentCompanyId: () => largeIds[1] };
  global.getApp = () => idApp;
  global.wx = { getStorageSync: () => '', showToast: () => {} };
  try {
    const definition = loadPage(relativePath);
    const page = { ...definition, data: JSON.parse(JSON.stringify(definition.data)),
      setData(values) { Object.assign(this.data, values); } };
    await check(page);
  } finally {
    global.getApp = previousApp;
    global.wx = previousWx;
  }
}

for (const [file, method, collection] of [
  ['contract-center', 'loadContracts', 'contracts'],
  ['order-detail', 'loadContracts', 'contracts'],
  ['contract-template', 'loadTemplates', 'templates']
]) {
  test(`${file} keeps adjacent 19-digit IDs distinct when loading records`, async () => {
    await withIdPage(`../pages/${file}/${file}`, async page => {
      wx.request = options => options.success({ statusCode: 200, data: { code: 0, data:
        options.url.endsWith('/summary') ? {} : { items: largeIds.map(id => ({
          id, name: '大整数记录', status: 'ACTIVE', amount: 1, counterpartyName: '往来企业'
        })) }
      } });
      await page[method](true);
      assert.deepStrictEqual(page.data[collection].map(item => item.id), largeIds);
      let url;
      wx.navigateTo = options => { url = options.url; };
      if (file === 'contract-center') page.openContract({ currentTarget: { dataset: { item: page.data.contracts[0] } } });
      if (file === 'contract-template') page.onTemplateTap({ currentTarget: { dataset: { template: page.data.templates[0] } } });
      if (url) assert.ok(url.includes(largeIds[0]));
    });
  });
}

test('approval lists preserve contract, attachment and notification source IDs', async () => {
  await withIdPage('../pages/contract-approval/contract-approval', async page => {
    wx.request = options => options.success({ statusCode: 200, data: { code: 0,
      data: [{ id: largeIds[0], contractId: largeIds[1], sourceId: largeIds[1],
        approvalType: 'INVOICE', resultType: 'INVOICE', status: 'ACTIVE', isRead: true }]
    } });
    await page.loadPending();
    assert.strictEqual(page.data.contracts[0].id, largeIds[0]);
    assert.strictEqual(page.data.fulfillmentItems[0].id, largeIds[0]);
    assert.strictEqual(page.data.fulfillmentItems[0].contractId, largeIds[1]);
    assert.strictEqual(page.data.results[0].id, largeIds[0]);
    assert.strictEqual(page.data.results[0].sourceId, largeIds[1]);
    let url;
    wx.navigateTo = options => { url = options.url; };
    page.viewContract({ currentTarget: { dataset: { contract: page.data.contracts[0] } } });
    assert.ok(url.endsWith(`contractId=${largeIds[0]}`));
  });
});

test('contract submission sends the exact company ID and routes to the returned contract ID', async () => {
  await withIdPage('../pages/sign-contract/sign-contract', async page => {
    page.setData({ templates: [{ name: '测试模板' }], templateIndex: 0,
      contractName: '测试合同', counterpartyName: '往来企业', counterpartyCompanyId: largeIds[1] });
    wx.showModal = options => options.success({ confirm: true });
    wx.showLoading = () => {};
    wx.hideLoading = () => {};
    let sent;
    let url;
    wx.request = options => {
      sent = options;
      options.success({ statusCode: 200, data: { code: 0, data: { id: largeIds[0] } } });
    };
    wx.redirectTo = options => { url = options.url; };
    const previousTimeout = global.setTimeout;
    let redirect;
    global.setTimeout = callback => { redirect = callback; };
    try {
      await page.onSubmit();
      assert.strictEqual(sent.data.counterpartyCompanyId, largeIds[1]);
      assert.strictEqual(sent.header['X-Company-Id'], largeIds[1]);
      redirect();
      assert.ok(url.includes(`contractId=${largeIds[0]}&`));
    } finally { global.setTimeout = previousTimeout; }
  });
});

function onboardingEnvironment() {
  const previousApp = global.getApp;
  const previousWx = global.wx;
  const previousPages = global.getCurrentPages;
  const storage = {};
  const instance = { globalData: { baseUrl: 'https://api.example.test', isLocalDevelopment: true,
    token: 'onboarding-token', userInfo: { id: '7' }, currentCompanyId: 'old-company' },
    applyMePayload() {}, switchCompany: async () => {} };
  global.getApp = () => instance;
  global.getCurrentPages = () => [];
  global.wx = {
    getStorageSync: key => storage[key] || '',
    setStorageSync: (key, value) => { storage[key] = value; },
    removeStorageSync: key => { delete storage[key]; },
    showToast() {}, showModal() {}, navigateTo() {}, navigateBack() {}, redirectTo() {}, switchTab() {}
  };
  return { instance, storage, restore() {
    global.getApp = previousApp; global.wx = previousWx; global.getCurrentPages = previousPages;
  } };
}

test('verified personal identity resumes company onboarding with or without the original page stack', async () => {
  const env = onboardingEnvironment();
  try {
    let redirected;
    wx.redirectTo = options => { redirected = options.url; };
    wx.request = options => options.success({ statusCode: 200, data: { code: 0,
      data: { status: 'VERIFIED', providerEnabled: true } } });
    const personal = pageInstance(loadPage('../pages/personal-cert/personal-cert'));
    personal._companyFlow = true; personal._returnOptions = {};
    await personal.loadIdentity(false);
    assert.strictEqual(redirected, '/pages/company-cert/company-cert?resume=1');
    redirected = '';
    const standalone = pageInstance(loadPage('../pages/personal-cert/personal-cert'));
    await standalone.loadIdentity(false);
    assert.strictEqual(redirected, '');
    require('../utils/companyOnboarding').returnToCompany({ companyId: '9007199254740993' });
    assert.strictEqual(redirected, '/pages/company-cert/company-cert?companyId=9007199254740993&autoSwitch=1');
  } finally { env.restore(); }
});

test('home and profile expose pending onboarding and a failed status lookup is not an empty company list', async () => {
  const env = onboardingEnvironment();
  try {
    wx.request = options => options.success({ statusCode: 200, data: { code: 0, data:
      options.url.endsWith('/me/company-onboarding') ? [{ id: '9', name: '待认证公司' }]
        : options.url.endsWith('/me') ? { user: { id: '7' }, companies: [] } : { status: 'VERIFIED' }
    } });
    const home = pageInstance(loadPage('../pages/index/index'));
    await home.loadOnboardingSummary();
    assert.strictEqual(home.data.onboardingName, '待认证公司');
    assert.strictEqual(home.data.hasOnboarding, true);
    const profile = pageInstance(loadPage('../pages/me/me'));
    await profile.loadMe();
    assert.strictEqual(profile.data.onboardingName, '待认证公司');
    assert.strictEqual(profile.data.onboardingStatus, '企业认证待完成');
    wx.request = options => options.fail(new Error('offline'));
    await home.loadOnboardingSummary();
    assert.strictEqual(home.data.hasOnboarding, true);
    assert.strictEqual(home.data.onboardingStatus, '企业认证状态待确认');
  } finally { env.restore(); }
});

test('return during an unfinished company read still triggers a provider sync after that read completes', async () => {
  const env = onboardingEnvironment();
  try {
    const page = pageInstance(loadPage('../pages/company-cert/company-cert'));
    page.data.companyId = '9'; page._awaitingCompanyAuth = true;
    let firstRead;
    let synced = false;
    let complete;
    const switched = new Promise(resolve => { complete = resolve; });
    wx.redirectTo = options => {
      assert.strictEqual(options.url, '/pages/service-return/service-return?scene=company&companyId=9');
      complete();
    };
    wx.request = options => {
      if (!firstRead) { firstRead = options; return; }
      if (options.url.endsWith('/identity/sync')) synced = true;
      const data = options.url.endsWith('/companies/9') ? { id: '9', name: '新企业' }
        : { status: synced ? 'VERIFIED' : 'IN_PROGRESS', enabled: true };
      options.success({ statusCode: 200, data: { code: 0, data } });
    };
    const initial = page.loadCompany(false);
    await page.loadCompany(true);
    firstRead.success({ statusCode: 200, data: { code: 0, data: { id: '9', name: '新企业' } } });
    await initial;
    await switched;
    assert.strictEqual(synced, true);
  } finally { env.restore(); }
});

test('provider sync failure keeps the saved enterprise and authentication actions visible', async () => {
  const env = onboardingEnvironment();
  try {
    const page = pageInstance(loadPage('../pages/company-cert/company-cert'));
    page.data.companyId = '9'; page._awaitingCompanyAuth = true;
    wx.switchTab = () => { throw new Error('pending authentication must not enter the enterprise'); };
    wx.request = options => {
      if (options.url.endsWith('/identity/sync')) return options.fail(new Error('provider offline'));
      const data = options.url.endsWith('/companies/9') ? { id: '9', name: '已保存企业' }
        : { status: 'IN_PROGRESS', enabled: true, statusText: '认证中' };
      options.success({ statusCode: 200, data: { code: 0, data } });
    };
    await page.loadCompany(true);
    assert.strictEqual(page.data.companyName, '已保存企业');
    assert.strictEqual(page.data.identity.status, 'IN_PROGRESS');
    assert.strictEqual(page.data.actions[0].key, 'company');
    assert.strictEqual(page.data.actions[0].done, false);
  } finally { env.restore(); }
});

test('a saved created-company ID resumes the claim instead of submitting another enterprise', async () => {
  const env = onboardingEnvironment();
  try {
    require('../utils/companyOnboarding').saveDraft({ companyId: '9007199254740993', companyName: '已提交企业',
      creditCode: 'CODE', legalPersonName: '张三', agreed: true });
    const page = pageInstance(loadPage('../pages/company-cert/company-cert'));
    let resumed = 0;
    page.resumePendingCompany = () => { resumed++; };
    page.createAndAuthenticate = () => { throw new Error('must reuse the saved company ID'); };
    page.onLoad({ resume: '1' });
    page.onShow();
    assert.strictEqual(page.data.companyId, '9007199254740993');
    assert.strictEqual(page.data.hasCompany, true);
    assert.strictEqual(resumed, 1);
  } finally { env.restore(); }
});

test('personal verification returns to the original company draft and continues creation exactly once', async () => {
  const env = onboardingEnvironment();
  try {
    const draft = require('../utils/companyOnboarding');
    const company = pageInstance(loadPage('../pages/company-cert/company-cert'));
    company.setData({ companyName: '新企业', creditCode: '91330100TEST1234567', legalPersonName: '张三', agreed: true });
    let verified = false;
    const calls = [];
    const navigations = [];
    wx.navigateTo = options => navigations.push(options.url);
    wx.showModal = options => options.success({ confirm: true });
    wx.request = options => {
      calls.push(options);
      let data = [];
      if (options.url.endsWith('/users/me/identity')) data = { status: verified ? 'VERIFIED' : 'NOT_STARTED' };
      if (options.url.endsWith('/companies')) data = { id: '9007199254740993', name: '新企业', creditCode: company.data.creditCode, legalPersonName: '张三' };
      options.success({ statusCode: 200, data: { code: 0, data } });
    };
    await company.createAndAuthenticate();
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(draft.readDraft().companyName, '新企业');
    assert.strictEqual(navigations[0], '/pages/personal-cert/personal-cert?flow=company-create');
    const auth = pageInstance(loadPage('../pages/fadada-auth/fadada-auth'));
    auth.data.scene = 'personal'; auth.data.options = { flow: 'company-create' };
    let returnedUrl;
    wx.redirectTo = options => { returnedUrl = options.url; };
    auth.openReturnPage();
    assert.strictEqual(returnedUrl, '/pages/service-return/service-return?scene=personal&flow=company-create');
    global.getCurrentPages = () => [{ route: 'pages/index/index' },
      { route: 'pages/company-cert/company-cert' }, { route: 'pages/personal-cert/personal-cert' },
      { route: 'pages/service-return/service-return' }];
    let delta;
    wx.navigateBack = options => { delta = options.delta; };
    const result = pageInstance(loadPage('../pages/service-return/service-return'));
    result.data.options = { scene: 'personal', flow: 'company-create' };
    result.setData({ loading: false, failed: false });
    result.goBusinessPage();
    assert.strictEqual(delta, 2);
    verified = true;
    company.loadCompany = async () => {};
    await company.onShow();
    await company.onShow();
    assert.strictEqual(calls.filter(call => call.url.endsWith('/companies')).length, 1);
    assert.strictEqual(calls.filter(call => call.url.endsWith('/me/company')).length, 1);
    assert.ok(calls.every(call => call.header['X-Company-Id'] === undefined));
    assert.strictEqual(company.data.companyId, '9007199254740993');
    assert.strictEqual(draft.readDraft(), null);
    assert.strictEqual(navigations.at(-1), '/pages/fadada-auth/fadada-auth?scene=company&companyId=9007199254740993');
  } finally { env.restore(); }
});

test('cancelled personal auth keeps a recoverable draft and does not create a company or reopen auth', async () => {
  const env = onboardingEnvironment();
  try {
    const page = pageInstance(loadPage('../pages/company-cert/company-cert'));
    page.setData({ companyName: '待创建企业', creditCode: 'CREDIT', legalPersonName: '张三', agreed: true });
    page._awaitingPersonal = true;
    let requests = 0;
    wx.showModal = () => { throw new Error('must not reopen authentication on cancellation'); };
    wx.request = options => {
      requests++;
      assert.ok(options.url.endsWith('/users/me/identity'));
      options.success({ statusCode: 200, data: { code: 0, data: { status: 'IN_PROGRESS' } } });
    };
    await page.onShow();
    assert.strictEqual(requests, 1);
    assert.strictEqual(page.data.hasCompany, false);
    const drafts = require('../utils/companyOnboarding');
    assert.strictEqual(drafts.readDraft().companyName, '待创建企业');
    env.instance.globalData.userInfo = { id: '8' };
    assert.strictEqual(drafts.readDraft(), null);
    env.instance.globalData.userInfo = { id: '7' };
    const resumed = pageInstance(loadPage('../pages/company-cert/company-cert'));
    resumed.onLoad({ resume: '1' });
    assert.strictEqual(resumed.data.creditCode, 'CREDIT');
    assert.strictEqual(resumed.data.agreed, true);
  } finally { env.restore(); }
});

test('claim failures preserve the draft and re-entry recovers the existing enterprise before syncing', async () => {
  const env = onboardingEnvironment();
  try {
    const drafts = require('../utils/companyOnboarding');
    const page = pageInstance(loadPage('../pages/company-cert/company-cert'));
    const persisted = { id: '9007199254740993', name: '已提交企业', creditCode: 'CODE', legalPersonName: '张三' };
    page.setData({ companyName: persisted.name, creditCode: 'CODE', legalPersonName: '张三', agreed: true });
    wx.request = options => {
      if (options.url.endsWith('/me/company')) return options.fail(new Error('offline'));
      const data = options.url.endsWith('/companies') ? persisted : { status: 'VERIFIED' };
      options.success({ statusCode: 200, data: { code: 0, data } });
    };
    await page.createAndAuthenticate();
    assert.strictEqual(drafts.readDraft().companyName, persisted.name);
    assert.strictEqual(page.data.hasCompany, false);
    const calls = [];
    wx.request = options => {
      calls.push(options.url);
      assert.strictEqual(options.header['X-Company-Id'], undefined);
      const data = options.url.endsWith('/me/company-onboarding') ? [persisted]
        : options.url.endsWith('/me/company') ? {} : options.url.endsWith('/companies/' + persisted.id) ? persisted
          : { status: 'VERIFIED', enabled: true };
      options.success({ statusCode: 200, data: { code: 0, data } });
    };
    let switched;
    let resultPage;
    wx.redirectTo = options => { resultPage = options.url; };
    env.instance.switchCompany = async id => { switched = id; };
    const resumed = pageInstance(loadPage('../pages/company-cert/company-cert'));
    resumed.data.companyId = persisted.id;
    resumed._awaitingCompanyAuth = true;
    await resumed.resumePendingCompany();
    assert.strictEqual(switched, undefined);
    assert.strictEqual(resultPage, '/pages/service-return/service-return?scene=company&companyId=' + persisted.id);
    assert.ok(calls[0].endsWith('/me/company-onboarding'));
    assert.ok(calls[1].endsWith('/me/company'));
    assert.strictEqual(drafts.readDraft(), null);
    assert.ok(!calls.some(url => url.endsWith('/companies')));
  } finally { env.restore(); }
});

test('enterprise center lists unfinished companies separately from active memberships and reports load errors', async () => {
  const env = onboardingEnvironment();
  try {
    const page = pageInstance(loadPage('../pages/company/company'));
    page.loadTodos = async () => {}; page.loadEnterpriseMetrics = async () => {};
    wx.request = options => {
      const data = options.url.endsWith('/me') ? { user: { id: '7' }, companies: [] }
        : options.url.endsWith('/me/company-onboarding') ? [{ id: '9', name: '待认证企业', certificationStatus: 'PENDING_REVIEW' }] : [];
      options.success({ statusCode: 200, data: { code: 0, data } });
    };
    await page.loadData();
    assert.strictEqual(page.data.hasCompany, false);
    assert.strictEqual(page.data.onboardingCompanies[0].name, '待认证企业');
    assert.match(page.data.onboardingCompanies[0].statusText, /结果待确认/);
    let url;
    wx.navigateTo = options => { url = options.url; };
    page.resumeCompany({ currentTarget: { dataset: { companyId: '9' } } });
    assert.strictEqual(url, '/pages/company-cert/company-cert?companyId=9&autoSwitch=1&resumePending=1');
    wx.request = options => options.fail(new Error('offline'));
    await page.loadOnboarding();
    assert.strictEqual(page.data.onboardingError, true);
    assert.strictEqual(page.data.onboardingCompanies.length, 1);
  } finally { env.restore(); }
});

(async () => {
  let failed = 0;
  for (const { name, fn } of tests) {
    let timeout;
    try {
      await Promise.race([fn(), new Promise((_, reject) => {
        timeout = testTimers.setTimeout(() => reject(new Error('Test did not complete within 10 seconds')), 10000);
      })]);
      process.stdout.write(`✓ ${name}\n`);
    } catch (error) {
      failed += 1;
      process.stderr.write(`✗ ${name}\n${error.stack}\n`);
    } finally {
      testTimers.clearTimeout(timeout);
    }
  }
  process.stdout.write(`\n${tests.length - failed}/${tests.length} tests passed\n`);
  if (failed > 0) process.exitCode = 1;
})();
