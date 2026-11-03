'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function harness() {
  let page;
  const calls = [], modals = [], answers = [], notices = [];
  const records = {
    warehouses: [{ id: '101', name: '电线电缆', address: '一号库区' }, { id: 102, name: '阀门', address: '二号库区' }],
    overview: { warehouseCount: 2, productCount: 3, canManualInbound: true, balances: [
      { id: '1', warehouseId: 101, warehouseName: '电线电缆', productName: '电线', specification: 'RVS 2×1.5', baseUnit: '米', quantity: '1000.0001', unitPrice: '1', inventoryAmount: '1000.00' },
      { id: '2', warehouseId: '102', warehouseName: '阀门', productName: '闸阀', model: 'Z41H', specification: 'DN100', baseUnit: '台', quantity: '100', unitPrice: '100', inventoryAmount: '10000', remark: '客户预留批次，请保持原包装并在发货前联系仓管确认' },
      { id: '3', warehouseId: '102', warehouseName: '阀门', productName: '电线', specification: 'RVS 2×1.5', baseUnit: '米', quantity: '200', unitPrice: '1.5', inventoryAmount: '300' }
    ] }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../pages/inventory/inventory.js'), 'utf8'), {
    Page: definition => { page = definition; },
    wx: { showToast: options => notices.push(options.title), showModal: options => {
      modals.push(options);
      if (options.success) options.success(answers.shift() || { confirm: true });
    } },
    require: () => ({ request: async options => {
      calls.push(options);
      if (options.method === 'DELETE') {
        if (records.deleteError) throw new Error(records.deleteError);
        records.overview.balances = records.overview.balances.filter(item => `/inventory/balances/${item.id}` !== options.url);
        return true;
      }
      if (options.method === 'POST') return {};
      return options.url === '/warehouses' ? records.warehouses : records.overview;
    } })
  });
  page.setData = values => {
    Object.entries(values).forEach(([key, value]) => {
      const segments = key.split('.');
      const last = segments.pop();
      const target = segments.reduce((current, segment) => current[segment], page.data);
      target[last] = value;
    });
  };
  return { page, records, calls, modals, answers, notices };
}

test('inventory search combines with warehouse filtering without losing decimal quantities or original records', async () => {
  const h = harness();
  await h.page.loadData();
  assert.equal(h.page.data.visibleBalances.length, 3);
  assert.equal(h.page.data.visibleBalances[0].quantity, '1000.0001');
  assert.equal(h.page.data.visibleBalances[0].unitPriceText, '1.00');
  assert.equal(h.records.overview.balances[0].unitPriceText, undefined);

  h.page.selectFilterWarehouse({ currentTarget: { dataset: { id: 102 } } });
  h.page.onSearchInput({ detail: { value: ' rVs ' } });
  assert.equal(h.page.data.visibleBalances.length, 1);
  assert.equal(h.page.data.visibleBalances[0].id, '3');
  assert.equal(h.page.data.filterWarehouseAddress, '二号库区');

  h.page.onSearchInput({ detail: { value: ' z41h ' } });
  assert.equal(h.page.data.visibleBalances.length, 1);
  assert.equal(h.page.data.visibleBalances[0].specification, 'DN100');

  h.page.clearSearch();
  assert.equal(h.page.data.visibleBalances.length, 2);
  assert.equal(h.page.data.filterWarehouseId, '102');
  h.page.onSearchInput({ detail: { value: '不存在' } });
  assert.equal(h.page.data.visibleBalances.length, 0);
  h.page.clearFilters();
  assert.equal(h.page.data.visibleBalances.length, 3);
  assert.equal(h.page.data.filterWarehouseAddress, '');
});

test('reloading inventory preserves a valid selection and removes a warehouse filter that no longer exists', async () => {
  const h = harness();
  await h.page.loadData();
  h.page.selectFilterWarehouse({ currentTarget: { dataset: { id: '101' } } });
  h.page.onSearchInput({ detail: { value: '电线' } });
  await h.page.loadData();
  assert.equal(h.page.data.visibleBalances.length, 1);
  assert.equal(h.page.data.filterWarehouseId, '101');

  h.records.warehouses = h.records.warehouses.slice(1);
  h.records.overview = { ...h.records.overview, balances: h.records.overview.balances.slice(1) };
  await h.page.loadData();
  assert.equal(h.page.data.filterWarehouseId, '');
  assert.equal(h.page.data.searchKeyword, '电线');
  assert.equal(h.page.data.visibleBalances[0].id, '3');
});

test('stock row details use the displayed filtered row and keep every column available in full', async () => {
  const h = harness();
  await h.page.loadData();
  h.page.onSearchInput({ detail: { value: 'dn100' } });
  h.page.showBalanceDetail({ currentTarget: { dataset: { index: 0 } } });
  const modal = h.modals[0];
  assert.match(modal.content, /商品：闸阀/);
  assert.match(modal.content, /型号：Z41H/);
  assert.match(modal.content, /规格：DN100/);
  assert.match(modal.content, /仓库：阀门/);
  assert.match(modal.content, /库存数量：100 台/);
  assert.match(modal.content, /库存单价：¥100\.00 \/ 台/);
  assert.match(modal.content, /库存金额：¥10000\.00/);
  assert.ok(modal.content.endsWith(`备注：${h.records.overview.balances[1].remark}`));
  h.page.clearSearch();
  h.page.showBalanceDetail({ currentTarget: { dataset: { index: 0 } } });
  assert.ok(h.modals[1].content.endsWith('备注：—'));
});

test('manual inbound starts in the filtered warehouse and refreshes the table after saving', async () => {
  const h = harness();
  await h.page.loadData();
  h.page.selectFilterWarehouse({ currentTarget: { dataset: { id: '102' } } });
  h.page.openInbound();
  assert.equal(h.page.data.warehouseIndex, 1);
  assert.equal(h.page.data.inbound.model, '');
  h.page.onInboundInput({ currentTarget: { dataset: { field: 'model' } }, detail: { value: ' Z41H ' } });
  h.page.data.inbound = { ...h.page.data.inbound, productName: ' 闸阀 ', specification: ' DN100 ', baseUnit: '台', quantity: '2', unitPrice: '100', remark: ' 客户预留批次 ' };
  await h.page.saveInbound();
  const inbound = h.calls.find(options => options.method === 'POST');
  assert.equal(inbound.url, '/inventory/manual-inbound');
  assert.equal(inbound.data.warehouseId, 102);
  assert.equal(inbound.data.productName, '闸阀');
  assert.equal(inbound.data.model, 'Z41H');
  assert.equal(inbound.data.specification, 'DN100');
  assert.equal(inbound.data.quantity, '2');
  assert.equal(inbound.data.remark, '客户预留批次');
  assert.equal(h.page.data.showInbound, false);
  assert.equal(h.page.data.filterWarehouseId, '102');
  assert.equal(h.calls.filter(options => options.url === '/inventory/overview').length, 2);
});

test('manual inbound accepts optional model and specification while keeping decimal quantity and zero price', async () => {
  const h = harness();
  await h.page.loadData();
  h.page.openInbound();
  h.page.data.inbound = { ...h.page.data.inbound, productName: '包装箱', baseUnit: '件', quantity: '0.0001', unitPrice: '0' };
  await h.page.saveInbound();
  const inbound = h.calls.find(options => options.method === 'POST');
  assert.equal(inbound.data.model, '');
  assert.equal(inbound.data.specification, '');
  assert.equal(inbound.data.quantity, '0.0001');
  assert.equal(inbound.data.unitPrice, '0');
});

test('manual inbound accepts zero quantity and keeps zero stock visible after refreshing and filtering', async () => {
  const h = harness();
  await h.page.loadData();
  h.page.openInbound();
  h.page.data.inbound = { ...h.page.data.inbound, productName: '包装箱', model: 'A', baseUnit: '件', quantity: '0', unitPrice: '0' };
  h.records.overview.balances.push({ id: '4', warehouseId: '101', warehouseName: '电线电缆',
    productName: '包装箱', model: 'A', baseUnit: '件', quantity: '0', unitPrice: '0', inventoryAmount: '0' });
  await h.page.saveInbound();
  const inbound = h.calls.find(options => options.method === 'POST');
  assert.equal(inbound.data.quantity, '0');
  assert.equal(inbound.data.unitPrice, '0');
  assert.equal(h.page.data.visibleBalances.length, 4);
  h.page.selectFilterWarehouse({ currentTarget: { dataset: { id: '101' } } });
  h.page.onSearchInput({ detail: { value: '包装箱' } });
  assert.equal(h.page.data.visibleBalances.length, 1);
  assert.equal(h.page.data.visibleBalances[0].quantity, '0');
  h.page.showBalanceDetail({ currentTarget: { dataset: { index: 0 } } });
  assert.match(h.modals[0].content, /库存数量：0 件/);
});

test('manual inbound still rejects blank, negative and overprecision quantities or prices', async () => {
  for (const [quantity, unitPrice] of [['', '0'], ['-1', '0'], ['0.00001', '0'], ['0', ''], ['0', '-1'], ['0', '0.00001']]) {
    const h = harness();
    await h.page.loadData();
    h.page.openInbound();
    h.page.data.inbound = { ...h.page.data.inbound, productName: '包装箱', baseUnit: '件', quantity, unitPrice };
    await h.page.saveInbound();
    assert.equal(h.calls.some(options => options.method === 'POST'), false, `${quantity} / ${unitPrice}`);
    assert.equal(h.page.data.showInbound, true);
  }
});

test('deleting a filtered zero-stock item targets its balance and refreshes while preserving the selected warehouse', async () => {
  const h = harness();
  h.records.overview.canDeleteInventory = true;
  h.records.overview.balances[1].quantity = '0.0000';
  h.records.overview.balances[1].inventoryAmount = '0.00';
  await h.page.loadData();
  h.page.selectFilterWarehouse({ currentTarget: { dataset: { id: '102' } } });
  h.page.onSearchInput({ detail: { value: 'dn100' } });
  await h.page.deleteBalance({ currentTarget: { dataset: { index: 0 } } });
  assert.equal(h.calls.find(call => call.method === 'DELETE').url, '/inventory/balances/2');
  assert.equal(h.page.data.visibleBalances.length, 0);
  assert.equal(h.page.data.filterWarehouseId, '102');
  assert.equal(h.page.data.deletingBalanceId, '');
  assert.match(h.modals[0].content, /历史入出库流水会保留/);
});

test('stock deletion refuses remaining quantity or amount, cancellation, and missing permission', async () => {
  for (const [quantity, amount, permitted, answer] of [
    ['1', '0', true, true], ['0', '1', true, true], ['0', '0', false, true], ['0', '0', true, false]
  ]) {
    const h = harness();
    h.records.overview.canDeleteInventory = permitted;
    Object.assign(h.records.overview.balances[0], { quantity, inventoryAmount: amount });
    await h.page.loadData();
    h.answers.push({ confirm: answer });
    await h.page.deleteBalance({ currentTarget: { dataset: { index: 0 } } });
    assert.equal(h.calls.some(call => call.method === 'DELETE'), false);
    assert.equal(h.page.data.visibleBalances.length, 3);
  }
});

test('server rejection preserves stock and restores the delete action for retry', async () => {
  const h = harness();
  h.records.overview.canDeleteInventory = true;
  Object.assign(h.records.overview.balances[0], { quantity: '0', inventoryAmount: '0' });
  h.records.deleteError = '库存已变化，请刷新';
  await h.page.loadData();
  await h.page.deleteBalance({ currentTarget: { dataset: { index: 0 } } });
  assert.equal(h.page.data.visibleBalances.length, 3);
  assert.equal(h.page.data.deletingBalanceId, '');
  assert.equal(h.notices.at(-1), '库存已变化，请刷新');
});
