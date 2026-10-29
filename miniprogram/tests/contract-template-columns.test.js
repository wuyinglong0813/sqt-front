'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const currency = require('../utils/chineseCurrency');

const plain = value => JSON.parse(JSON.stringify(value));
const event = (dataset, value) => ({ currentTarget: { dataset }, detail: { value } });
function harness(name) {
  let page;
  const calls = [], modals = [], notices = [], answers = [];
  const wx = {
    showToast: options => notices.push(options.title),
    showLoading() {}, hideLoading() {}, navigateBack() {}, redirectTo() {},
    showModal: options => { modals.push(options); options.success(answers.shift() || { confirm: true }); }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, `../pages/${name}/${name}.js`), 'utf8'), {
    Page: definition => { page = definition; }, wx, setTimeout() {},
    require: id => {
      if (id.endsWith('/chineseCurrency')) return currency;
      if (id.endsWith('/request')) return { request: async options => { calls.push(options); return { id: '99' }; } };
      throw new Error(`Unexpected require ${id}`);
    }
  });
  page.setData = (patch, callback) => {
    for (const [key, value] of Object.entries(patch)) {
      const keys = key.replace(/\[(\d+)\]/g, '.$1').split('.');
      let target = page.data;
      for (const part of keys.slice(0, -1)) target = target[part];
      target[keys.at(-1)] = value;
    }
    if (callback) callback();
  };
  page.measureTableScrollbar = () => {};
  return { page, calls, modals, notices, answers };
}

function template(columns, rows) {
  return { title: '定制合同', fields: [], sections: [{ title: '货品', type: 'table', columns, rows }] };
}

test('normalization preserves explicit deleted and custom columns through repeated loads', () => {
  const columns = ['产品名称', '规格型号', '单位', '数量', '单价(元)', '金额(元)'];
  const once = currency.normalizeContractTable(columns, [['电线', 'RVS', '米', '2', '3', '6']]);
  const twice = currency.normalizeContractTable(once.columns, once.rows);
  assert.deepEqual(twice.columns, columns);
  assert.equal(twice.rows[0].length, 6);
  assert.deepEqual(currency.normalizeContractTable(['品牌'], [['定制品牌']]), {
    columns: ['品牌'], rows: [['定制品牌']]
  });
  assert.equal(currency.normalizeContractTable().columns.length, 7);
});

test('totals follow named columns after deletion, accept manual amounts and keep custom text intact', () => {
  const reordered = currency.calcTableTotal([['加急', '3', '铜', '2', '']], ['说明', '单价', '材质', '数量', '金额']);
  assert.equal(reordered.totalAmount, 6);
  assert.deepEqual(reordered.rows[0], ['加急', '3', '铜', '2', '6']);
  const noAmount = currency.calcTableTotal([['电线', '2', '3.335', '品牌']], ['名称', '数量', '单价', '品牌']);
  assert.equal(noAmount.totalAmount, 6.67);
  assert.deepEqual(noAmount.rows[0], ['电线', '2', '3.335', '品牌']);
  const manual = currency.calcTableTotal([['内容', '12.5', '铜']], ['说明', '金额', '材质']);
  assert.equal(manual.totalAmount, 12.5);
  assert.deepEqual(manual.rows[0], ['内容', '12.5', '铜']);
  const custom = currency.calcTableTotal([['电线', '铜', '23', '品牌', '45', '说明']], ['名称', '材质', '批号', '品牌', '编码', '说明']);
  assert.equal(custom.totalAmount, 0);
  assert.deepEqual(custom.rows[0], ['电线', '铜', '23', '品牌', '45', '说明']);
});

test('template editor adds and deletes whole columns, saves exact layout and reloads matching values', async () => {
  const h = harness('contract-template-detail');
  h.page.initFromTemplate(template(['产品名称', '规格', '数量', '单价', '金额', '备注'], [['电线', 'RVS', '2', '3', '6', '加急']]));
  h.answers.push({ confirm: true, content: '品牌' });
  await h.page.addTableColumn();
  h.page.onTableCellChange(event({ row: 0, col: 6 }, '定制品牌'));
  await h.page.deleteTableColumn(event({ index: 1 }));
  await h.page.deleteTableColumn(event({ index: 4 }));
  assert.equal(h.page.data.quantityColumnIndex, 1);
  assert.equal(h.page.data.amountColumnIndex, 3);
  h.page.addTableRow();
  assert.equal(h.page.data.tableRows[1].length, 5);
  h.page.data.name = '企业自定义模板';
  await h.page.save();
  const saved = JSON.parse(h.calls[0].data.content);
  assert.deepEqual(saved.sections[0].columns, ['产品名称', '数量', '单价', '金额', '品牌']);
  assert.deepEqual(saved.sections[0].rows[0], ['电线', '2', '3', '6', '定制品牌']);
  const reloaded = harness('contract-template-detail');
  reloaded.page.initFromTemplate(saved);
  assert.deepEqual(plain(reloaded.page.data.tableSection.columns), saved.sections[0].columns);
  assert.deepEqual(plain(reloaded.page.data.tableRows), saved.sections[0].rows);
  assert.equal(reloaded.page.data.totalAmount, '6');
});

test('removing numeric columns never writes into another column or adds hidden negative indexes', async () => {
  const h = harness('contract-template-detail');
  h.page.initFromTemplate(template(['名称', '数量', '单价', '金额', '说明'], [['电线', '2', '3', '6', '加急']]));
  await h.page.deleteTableColumn(event({ index: 1 }));
  assert.equal(h.page.data.quantityColumnIndex, -1);
  assert.equal(h.page.data.amountAutoCalculated, false);
  h.page.onTableCellChange(event({ row: 0, col: 2 }, '012.5'));
  assert.equal(h.page.data.totalAmount, '12.5');
  h.page.addTableRow();
  assert.equal(Object.hasOwn(h.page.data.tableRows[1], '-1'), false);
  assert.deepEqual(plain(h.page.data.tableRows[0]), ['电线', '3', '12.5', '加急']);
  h.page.initFromTemplate(template(['说明'], [['约定内容']]));
  await h.page.deleteTableColumn(event({ index: 0 }));
  assert.equal(h.notices.at(-1), '至少保留一列');
});

test('cancelled deletions and duplicate column names preserve the original table', async () => {
  const h = harness('contract-template-detail');
  h.page.initFromTemplate(template(['数量', '单价', '金额'], [['2', '3', '6']]));
  h.answers.push({ confirm: false });
  await h.page.deleteTableColumn(event({ index: 0 }));
  h.answers.push({ confirm: true, content: '数量' });
  await h.page.addTableColumn();
  assert.equal(h.notices.at(-1), '已存在同名列');
  h.answers.push({ confirm: true, content: '含税单价' });
  await h.page.addTableColumn();
  assert.equal(h.notices.at(-1), '数量、单价、金额各保留一列');
  assert.deepEqual(plain(h.page.data.tableSection.columns), ['数量', '单价', '金额']);
});

test('goods contracts expose a model column immediately and retain custom columns and totals', async () => {
  const h = harness('sign-contract');
  const content = template(['产品名称', '数量', '单价', '品牌'], [['电线', '2', '3', '品牌A']]);
  h.page.data.templates = [{ id: '1', name: '定制版式', content: JSON.stringify(content) }];
  h.page.selectTemplate(0);
  assert.deepEqual(plain(h.page.data.tableSection.columns), ['产品名称', '型号', '数量', '单价', '品牌']);
  h.page.onTableCellChange(event({ row: 0, col: 1 }, 'RVVP'));
  h.page.onTableCellChange(event({ row: 0, col: 2 }, '4'));
  assert.equal(h.page.data.totalAmount, '12');
  await h.page.onSubmit();
  const write = h.calls.find(call => call.url === '/contracts');
  const saved = JSON.parse(write.data.terms).sections[0];
  assert.equal(write.data.amount, 12);
  assert.deepEqual(saved.columns, ['产品名称', '型号', '数量', '单价', '品牌']);
  assert.deepEqual(saved.rows[0], ['电线', 'RVVP', '4', '3', '品牌A']);
  assert.equal(saved.summary.totalAmount, '12');
});

test('contract creation allows manual amount when quantity or unit price was removed', async () => {
  const h = harness('sign-contract');
  const content = template(['说明', '金额', '交货日期'], [['定制服务', '18', '2026-10-24']]);
  h.page.data.templates = [{ id: '1', name: '服务模板', content: JSON.stringify(content) }];
  h.page.selectTemplate(0);
  assert.equal(h.page.data.productColumnIndex, -1);
  assert.equal(h.page.data.amountAutoCalculated, false);
  h.page.onTableCellChange(event({ row: 0, col: 1 }, '025.5'));
  assert.equal(h.page.data.totalAmount, '25.5');
  await h.page.onSubmit();
  const write = h.calls.find(call => call.url === '/contracts');
  assert.equal(write.data.amount, 25.5);
  assert.deepEqual(JSON.parse(write.data.terms).sections[0].rows[0], ['定制服务', '25.5', '2026-10-24']);
});

test('inventory selection distinguishes models with the same specification and saves both columns', async () => {
  const h = harness('sign-contract');
  const content = template(['产品名称', '型号', '规格', '单位', '数量', '单价', '金额'], [['闸阀', '旧型号', '旧规格', '件', '2', '3', '6']]);
  h.page.data.templates = [{ id: '1', name: '分列模板', content: JSON.stringify(content) }];
  h.page.selectTemplate(0);
  h.page.data.inventoryProducts = [
    { id: '11', productName: '闸阀', model: 'Z41H', specification: 'DN100', baseUnit: '台' },
    { id: '12', productName: '闸阀', model: 'Z42H', specification: 'DN100', baseUnit: '台' }
  ];
  h.page.selectInventoryProduct(event({ row: 0, name: '闸阀' }));
  assert.deepEqual(plain(h.page.data.tableRows[0]), ['闸阀', '', '', '', '2', '3', '6']);
  assert.equal(h.page.data.specificationSuggestions.length, 2);
  h.page.onTableCellChange(event({ row: 0, col: 1 }, 'z42'));
  assert.deepEqual(plain(h.page.data.specificationSuggestions).map(item => item.id), ['12']);
  h.page.selectInventorySpecification(event({ row: 0, id: '12' }));
  assert.deepEqual(plain(h.page.data.tableRows[0]), ['闸阀', 'Z42H', 'DN100', '台', '2', '3', '6']);
  assert.equal(h.page.data.quantityColumnIndex, 4);
  await h.page.onSubmit();
  const saved = JSON.parse(h.calls.find(call => call.url === '/contracts').data.terms).sections[0];
  assert.deepEqual(saved.columns, content.sections[0].columns);
  assert.deepEqual(saved.rows[0], ['闸阀', 'Z42H', 'DN100', '台', '2', '3', '6']);
});

test('selecting inventory with a model adds a separate column without reinterpreting legacy combined specifications', () => {
  const h = harness('sign-contract');
  const content = template(['产品名称', '规格型号', '单位', '数量', '单价', '金额'], [
    ['', '', '', '2', '3', '6'], ['原商品', '原合并规格', '件', '1', '5', '5']
  ]);
  h.page.data.templates = [{ id: '1', name: '历史模板', content: JSON.stringify(content) }];
  h.page.selectTemplate(0);
  h.page.data.inventoryProducts = [{ id: '11', productName: '电缆', model: 'YJV', specification: '3×2.5mm²', baseUnit: '米' }];
  h.page.selectInventoryProduct(event({ row: 0, name: '电缆' }));
  assert.deepEqual(plain(h.page.data.tableSection.columns), ['产品名称', '型号', '规格型号', '单位', '数量', '单价', '金额']);
  assert.deepEqual(plain(h.page.data.tableRows[0]), ['电缆', 'YJV', '3×2.5mm²', '米', '2', '3', '6']);
  assert.deepEqual(plain(h.page.data.tableRows[1]), ['原商品', '', '原合并规格', '件', '1', '5', '5']);
  h.page.onTableCellChange(event({ row: 0, col: 4 }, '4'));
  assert.equal(h.page.data.totalAmount, '17');
  h.page.selectInventorySpecification(event({ row: 0, id: '11' }));
  assert.equal(h.page.data.tableSection.columns.length, 7);
});

test('legacy inventory without a model keeps its specification in place beside an empty model', () => {
  const h = harness('sign-contract');
  const content = template(['产品名称', '规格型号', '单位', '数量', '单价', '金额'], [['', '', '', '2', '3', '6']]);
  h.page.data.templates = [{ id: '1', name: '历史模板', content: JSON.stringify(content) }];
  h.page.selectTemplate(0);
  h.page.data.inventoryProducts = [{ id: '11', productName: '电缆', specification: 'RVS 2×1.5', baseUnit: '米' }];
  h.page.selectInventoryProduct(event({ row: 0, name: '电缆' }));
  assert.equal(h.page.tableColumnIndex('model'), 1);
  assert.deepEqual(plain(h.page.data.tableSection.columns), ['产品名称', '型号', '规格型号', '单位', '数量', '单价', '金额']);
  assert.deepEqual(plain(h.page.data.tableRows[0]), ['电缆', '', 'RVS 2×1.5', '米', '2', '3', '6']);
});

test('inventory selection finds the real product name after product-prefixed model and specification columns', async () => {
  const h = harness('sign-contract');
  const columns = ['产品型号', '产品规格', '产品名称', '单位', '数量', '单价', '金额'];
  h.page.data.templates = [{ id: '1', name: '乱序产品列', content: JSON.stringify(template(columns, [['', '', '', '', '2', '30', '60']])) }];
  h.page.selectTemplate(0);
  h.page.data.inventoryProducts = [{ id: '11', productName: '闸阀', model: 'Z41H', specification: 'DN100', baseUnit: '台' }];
  assert.equal(h.page.data.productColumnIndex, 2);
  assert.equal(h.page.tableColumnIndex('product'), 2);
  assert.equal(h.page.tableColumnIndex('model'), 0);
  assert.equal(h.page.tableColumnIndex('specification'), 1);
  h.page.selectInventoryProduct(event({ row: 0, name: '闸阀' }));
  assert.deepEqual(plain(h.page.data.tableRows[0]), ['Z41H', 'DN100', '闸阀', '台', '2', '30', '60']);
  await h.page.onSubmit();
  assert.deepEqual(JSON.parse(h.calls.find(call => call.url === '/contracts').data.terms).sections[0].rows[0],
    ['Z41H', 'DN100', '闸阀', '台', '2', '30', '60']);
});
