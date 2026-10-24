'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function harness() {
  let page;
  const calls = [], modals = [];
  const records = {
    warehouses: [{ id: '101', name: '电线电缆', address: '一号库区' }, { id: 102, name: '阀门', address: '二号库区' }],
    overview: { warehouseCount: 2, productCount: 3, canManualInbound: true, balances: [
      { id: '1', warehouseId: 101, warehouseName: '电线电缆', productName: '电线', specification: 'RVS 2×1.5', baseUnit: '米', quantity: '1000.0001', unitPrice: '1', inventoryAmount: '1000.00' },
      { id: '2', warehouseId: '102', warehouseName: '阀门', productName: '闸阀', specification: 'DN100', baseUnit: '台', quantity: '100', unitPrice: '100', inventoryAmount: '10000' },
      { id: '3', warehouseId: '102', warehouseName: '阀门', productName: '电线', specification: 'RVS 2×1.5', baseUnit: '米', quantity: '200', unitPrice: '1.5', inventoryAmount: '300' }
    ] }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../pages/inventory/inventory.js'), 'utf8'), {
    Page: definition => { page = definition; },
    wx: { showToast() {}, showModal: options => modals.push(options) },
    require: () => ({ request: async options => {
      calls.push(options);
      if (options.method === 'POST') return {};
      return options.url === '/warehouses' ? records.warehouses : records.overview;
    } })
  });
  page.setData = values => Object.assign(page.data, values);
  return { page, records, calls, modals };
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
  assert.match(modal.content, /规格：DN100/);
  assert.match(modal.content, /仓库：阀门/);
  assert.match(modal.content, /库存数量：100 台/);
  assert.match(modal.content, /库存单价：¥100\.00 \/ 台/);
  assert.match(modal.content, /库存金额：¥10000\.00/);
});

test('manual inbound starts in the filtered warehouse and refreshes the table after saving', async () => {
  const h = harness();
  await h.page.loadData();
  h.page.selectFilterWarehouse({ currentTarget: { dataset: { id: '102' } } });
  h.page.openInbound();
  assert.equal(h.page.data.warehouseIndex, 1);
  h.page.data.inbound = { ...h.page.data.inbound, productName: '闸阀', specification: 'DN100', baseUnit: '台', quantity: '2', unitPrice: '100' };
  await h.page.saveInbound();
  const inbound = h.calls.find(options => options.method === 'POST');
  assert.equal(inbound.url, '/inventory/manual-inbound');
  assert.equal(inbound.data.warehouseId, 102);
  assert.equal(inbound.data.quantity, '2');
  assert.equal(h.page.data.showInbound, false);
  assert.equal(h.page.data.filterWarehouseId, '102');
  assert.equal(h.calls.filter(options => options.url === '/inventory/overview').length, 2);
});
