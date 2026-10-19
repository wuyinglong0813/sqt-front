'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { reorderClauses } = require('../utils/chineseCurrency');

async function preview(terms) {
  let page;
  const notices = [];
  const request = async ({ url }) => {
    if (url === '/contracts/12') return { id: '12', status: 'PENDING', name: '购销合同', terms };
    return {};
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../pages/contract-preview/contract-preview.js'), 'utf8'), {
    Page: value => { page = value; },
    getApp: () => ({ globalData: { memberInfo: { permissions: ['all'] }, companies: [] },
      getCurrentCompanyId: () => '3' }),
    wx: { showToast: value => notices.push(value), setNavigationBarTitle() {} },
    setTimeout: () => 0, clearTimeout() {},
    require: name => name.endsWith('/request') ? { request }
      : name.endsWith('/signingContinuation') ? require('../utils/signingContinuation')
      : name.endsWith('/chineseCurrency') ? require('../utils/chineseCurrency')
      : name.endsWith('/retail') ? require('../utils/retail') : {}
  });
  page.data.contractId = '12';
  page.setData = value => Object.assign(page.data, value);
  ['loadContractMemo', 'loadSignedContractPreview', 'promptProjectLedgerIfNeeded',
    'loadBusinessDocuments', 'loadFulfillmentData'].forEach(name => { page[name] = () => {}; });
  await page.loadContractDetail();
  assert.equal(notices.length, 0, JSON.stringify(notices));
  return page.data;
}

test('preview uses exactly the selected template clauses in order starting at one', async () => {
  const clauses = [
    { type: 'clause', title: '2、质量要求', content: '产品质量执行双方约定标准' },
    { type: 'clause', title: '三、交货', content: '运输费用由供方承担' },
    { type: 'clause', title: '第四条 验收', content: '收货七日内提出异议' },
    { type: 'clause', title: '结算方式', content: '付清全款发货' },
    { type: 'clause', title: '违约责任', content: '按双方约定执行' },
    { type: 'clause', title: '争议解决', content: '向供方所在地人民法院起诉' },
    { type: 'clause', title: '其他约定', content: '双方签字盖章之日生效' }
  ];
  const data = await preview(JSON.stringify({ sections: [
    { type: 'table', title: '一、订购货品', columns: ['名称', '数量', '单价', '金额'], rows: [] },
    ...clauses
  ] }));
  assert.equal(data.contractTableTitle, '订购货品');
  assert.deepEqual(Array.from(data.contractClauses, item => item.label), [
    '一、质量要求', '二、交货', '三、验收', '四、结算方式', '五、违约责任', '六、争议解决', '七、其他约定'
  ]);
  assert.deepEqual(Array.from(data.contractClauses, item => item.content), clauses.map(item => item.content));
});

test('preview preserves legacy text and does not synthesize terms for an empty template', async () => {
  const empty = await preview('{"sections":[]}');
  assert.equal(empty.contractClauses.length, 0);
  const plain = await preview('双方约定：付清全款发货。');
  assert.equal(plain.contractClauses.length, 1);
  assert.equal(plain.contractClauses[0].label, '一、合同条款');
  assert.equal(plain.contractClauses[0].content, '双方约定：付清全款发货。');
  const blank = await preview('{"sections":[{"type":"clause","title":"定制条款","content":"  "}]}');
  assert.equal(blank.contractClauses[0].content, '（未约定）');
});

test('editor labels normalize existing Arabic and Chinese clause prefixes', () => {
  assert.deepEqual(reorderClauses([
    { title: ' 2、质量要求', content: '约定' },
    { title: '第四条：验收' },
    { title: '11. 争议解决' }
  ]).map(item => item.title), ['质量要求', '验收', '争议解决']);
});
