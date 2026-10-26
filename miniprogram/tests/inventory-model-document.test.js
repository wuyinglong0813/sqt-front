'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const plain = value => JSON.parse(JSON.stringify(value));

function harness(sourceColumns, sourceRows, targetColumns) {
  let page;
  const requests = [];
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../pages/contract-preview/contract-preview.js'), 'utf8'), {
    Page: value => { page = value; },
    wx: { showToast() {}, showLoading() {}, hideLoading() {}, showModal: options => options.success({ confirm: true }) },
    require: id => id.endsWith('/request') ? { request: async options => { requests.push(options); return {}; } } : {}
  });
  page.setData = update => Object.assign(page.data, update);
  page.currentCompanyName = () => '供方企业';
  page.todayText = () => '2026-10-26';
  page.loadBusinessDocuments = async () => {};
  Object.assign(page.data, {
    contractId: '12', contract: { id: '12', contractNo: 'HT-12', amount: '60', counterpartyName: '需方企业' },
    sData: { sections: [{ type: 'table', columns: sourceColumns, rows: sourceRows }] },
    documentEditorLabel: '销售单', documentEditorType: 'SALES_ORDER',
    documentTemplates: [{ id: '9', name: '旧销售单模板', content: JSON.stringify({ columns: targetColumns }) }]
  });
  return { page, requests };
}

test('a contract model is inserted before specification in an old document template and survives draft submission', async () => {
  const sourceColumns = ['产品名称', '型号', '规格', '单位', '数量', '单价', '金额'];
  const sourceRows = [['阀门', 'Z41H', 'DN100', '个', '2', '30', '60']];
  const h = harness(sourceColumns, sourceRows, ['序号', '品名', '规格', '数量', '单价', '金额']);
  h.page.applyDocumentTemplate(0);
  assert.deepEqual(plain(h.page.data.documentColumns), ['序号', '品名', '型号', '规格', '数量', '单价', '金额']);
  assert.deepEqual(plain(h.page.data.documentRows), [['1', '阀门', 'Z41H', 'DN100', '2', '30', '60']]);
  assert.equal(h.page.data.documentTotalAmount, '60');
  await h.page.submitBusinessDocument();
  assert.equal(h.requests[0].url, '/contracts/12/documents');
  assert.deepEqual(plain(h.requests[0].data.content.columns), plain(h.page.data.documentColumns));
  assert.deepEqual(plain(h.requests[0].data.content.rows[0]), ['1', '阀门', 'Z41H', 'DN100', '2', '30', '60']);
  assert.equal(JSON.parse(h.page.data.documentTemplates[0].content).columns.includes('型号'), false);
  assert.deepEqual(sourceRows[0], ['阀门', 'Z41H', 'DN100', '个', '2', '30', '60']);
});

test('independent model and specification map by meaning regardless of source or target order', () => {
  const h = harness(['产品名称', '规格', '商品型号'], [['阀门', 'DN100', 'Z41H']], ['商品型号', '品名', '规格']);
  h.page.applyDocumentTemplate(0);
  assert.deepEqual(plain(h.page.data.documentColumns), ['商品型号', '品名', '规格']);
  assert.deepEqual(plain(h.page.data.documentRows), [['Z41H', '阀门', 'DN100']]);
});

test('legacy combined specification remains specification and is never duplicated into an independent model', () => {
  const h = harness(['产品名称', '规格型号'], [['电线', 'RVS 2×1.5']], ['品名', '型号', '规格']);
  h.page.applyDocumentTemplate(0);
  assert.deepEqual(plain(h.page.data.documentRows), [['电线', '', 'RVS 2×1.5']]);
  const old = harness(['产品名称', '规格型号'], [['电线', 'RVS 2×1.5']], ['品名', '规格型号']);
  old.page.applyDocumentTemplate(0);
  assert.deepEqual(plain(old.page.data.documentColumns), ['品名', '规格型号']);
  assert.deepEqual(plain(old.page.data.documentRows), [['电线', 'RVS 2×1.5']]);
});

test('blank optional models do not change document templates and model-only products do not become specifications', () => {
  const blank = harness(['产品名称', '型号', '规格'], [['阀门', '', 'DN100']], ['品名', '规格']);
  blank.page.applyDocumentTemplate(0);
  assert.deepEqual(plain(blank.page.data.documentColumns), ['品名', '规格']);
  const model = harness(['产品名称', '型号'], [['阀门', 'Z41H']], ['品名', '规格']);
  model.page.applyDocumentTemplate(0);
  assert.deepEqual(plain(model.page.data.documentColumns), ['品名', '型号', '规格']);
  assert.deepEqual(plain(model.page.data.documentRows), [['阀门', 'Z41H', '']]);
});

test('product-prefixed model and specification columns take precedence over generic product-name aliases', async () => {
  const h = harness(['产品型号', '产品规格', '产品名称', '数量', '单价', '金额'],
    [['Z41H', 'DN100', '闸阀', '2', '30', '60']],
    ['产品型号', '产品规格', '产品名称', '数量', '单价', '金额']);
  h.page.data.sData.sections.push({ type: 'fees', items: [{ feeType: '运费', amount: '5' }] });
  h.page.applyDocumentTemplate(0);
  assert.deepEqual(plain(h.page.data.documentColumns), ['产品型号', '产品规格', '产品名称', '数量', '单价', '金额']);
  assert.deepEqual(plain(h.page.data.documentRows), [
    ['Z41H', 'DN100', '闸阀', '2', '30', '60'], ['', '', '运费', '1', '5', '5']
  ]);
  await h.page.submitBusinessDocument();
  assert.deepEqual(plain(h.requests[0].data.content.rows[0]), ['Z41H', 'DN100', '闸阀', '2', '30', '60']);
  const old = harness(['产品型号', '产品规格', '产品名称'], [['Z41H', 'DN100', '闸阀']], ['产品规格', '产品名称']);
  old.page.applyDocumentTemplate(0);
  assert.deepEqual(plain(old.page.data.documentColumns), ['型号', '产品规格', '产品名称']);
  assert.deepEqual(plain(old.page.data.documentRows), [['Z41H', 'DN100', '闸阀']]);
});
