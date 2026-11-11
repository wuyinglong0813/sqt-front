const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
function harness(request) {
  const app = { globalData: { token: 'session' }, _companyAccessGeneration: 0, companyId: '19-digit-company', getCurrentCompanyId() { return this.companyId; } };
  const notices = [], routes = [], calls = [];
  const wx = { setNavigationBarTitle() {}, showToast: o => notices.push(o.title), redirectTo: o => routes.push(o.url), navigateTo: o => routes.push(o.url) };
  const tracked = async options => { calls.push(options); return request(options); };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../utils/retail.js'), 'utf8'), {
    module, getApp: () => app, require: () => ({ request: tracked })
  });
  function page(file) {
    let definition;
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), {
      Page: d => { definition = d; }, getApp: () => app, wx,
      require: id => id.endsWith('/retail') ? module.exports : {}
    });
    const p = { ...definition, data: structuredClone(definition.data) };
    p.setData = values => Object.entries(values).forEach(([key, value]) => {
      const parts = key.replace(/\[(\d+)\]/g, '.$1').split('.');
      let destination = p.data;
      for (const part of parts.slice(0, -1)) destination = destination[part];
      destination[parts.at(-1)] = value;
    });
    p.companyContext = module.exports.context(); return p;
  }
  return { app, page, notices, routes, calls, retail: module.exports };
}
const saleForm = env => {
  const p = env.page('pages/retail-order-form/retail-order-form.js');
  Object.assign(p.data, { customerId: '2098123456789012345', customer: { name: '线下客户' },
    orderDate: '2026-10-08', requestId: 'retail-test-stable-request', items: [{ lineType: 'PRODUCT',
      productName: '电缆', specification: '', baseUnit: '米', quantity: '2', unitPrice: '3.335', remark: '' }] });
  return p;
};
test('retail creates and confirms a sale without any contract or partnership API', async () => {
  const id = '2098123456789012346';
  const env = harness(async () => ({ id, status: 'DRAFT' })); const page = saleForm(env);
  page.recalculate(); assert.equal(page.data.totalText, '6.67');
  await page.save({ currentTarget: { dataset: { confirm: '1' } } });
  assert.equal(env.calls.length, 2);
  assert.equal(env.calls[0].url, '/retail/customers/2098123456789012345/documents');
  assert.equal(env.calls[1].url, `/retail/documents/${id}/confirm`);
  assert.equal(env.calls[1].data.warehouseId, null);
  assert.match(env.routes[0], new RegExp(id));
  assert.equal(env.calls.some(o => o.url.includes('/contracts') || o.url.includes('/counterparties')), false);
});
test('saving a draft does not call confirmation', async () => {
  const env = harness(async () => ({ id: '42' }));
  await saleForm(env).save({ currentTarget: { dataset: {} } });
  assert.equal(env.calls.length, 1);
  assert.equal(env.calls[0].data.requestId, 'retail-test-stable-request');
  assert.equal(env.calls[0].data.items[0].model, '');
});
test('retail editing and submission keep model separate from specification', async () => {
  const env = harness(async () => ({ id: '42' }));
  const page = saleForm(env);
  page.onItemInput({ currentTarget: { dataset: { index: 0, field: 'model' } }, detail: { value: ' YJV ' } });
  page.onItemInput({ currentTarget: { dataset: { index: 0, field: 'specification' } }, detail: { value: '3×2.5mm²' } });
  await page.save({ currentTarget: { dataset: {} } });
  const item = env.calls[0].data.items[0];
  assert.equal(item.model, 'YJV');
  assert.equal(item.specification, '3×2.5mm²');
});
test('a failed confirmation retains the draft and retries the same document', async () => {
  let attempts = 0;
  const env = harness(async o => {
    if (o.url.endsWith('/confirm') && ++attempts === 1) throw new Error('库存不足');
    return { id: '42', status: 'DRAFT' };
  });
  const page = saleForm(env);
  await page.save({ currentTarget: { dataset: { confirm: '1' } } });
  assert.equal(page.data.id, '42'); assert.match(page.data.error, /草稿已保留/);
  await page.save({ currentTarget: { dataset: { confirm: '1' } } });
  assert.equal(env.calls.filter(o => o.url.endsWith('/customers/2098123456789012345/documents')).length, 1);
  assert.equal(env.calls.filter(o => o.url.endsWith('/42/draft')).length, 1);
});
test('return quantities are bounded and preserve the original item ID and price', async () => {
  const originalItem = '2098123456789012347';
  const env = harness(async o => o.method ? { id: '43' } : { documentNo: '原销售单', items: [{ id: originalItem,
    productName: '电缆', model: 'YJV', specification: '3×2.5mm²', baseUnit: '米', unitPrice: '2.50', returnableQuantity: '5', lineType: 'PRODUCT' }] });
  const page = saleForm(env); Object.assign(page.data, { isReturn: true, documentType: 'RETURN_ORDER', remark: '多余材料退回' });
  await page.loadOriginal('42');
  page.onItemInput({ currentTarget: { dataset: { index: 0, field: 'unitPrice' } }, detail: { value: '999' } });
  page.onItemInput({ currentTarget: { dataset: { index: 0, field: 'model' } }, detail: { value: '其他型号' } });
  assert.equal(page.data.items[0].unitPrice, '2.50');
  assert.equal(page.data.items[0].model, 'YJV');
  page.onItemInput({ currentTarget: { dataset: { index: 0, field: 'quantity' } }, detail: { value: '6' } });
  await page.save({ currentTarget: { dataset: {} } });
  assert.equal(env.calls.some(o => o.method === 'POST'), false);
  assert.match(env.notices[0], /超过可退数量/);
  page.onItemInput({ currentTarget: { dataset: { index: 0, field: 'quantity' } }, detail: { value: '2' } });
  await page.save({ currentTarget: { dataset: {} } });
  const body = env.calls.find(o => o.method === 'POST').data;
  assert.equal(body.originalDocumentId, '42'); assert.equal(body.items[0].originalItemId, originalItem);
  assert.equal(body.items[0].unitPrice, '2.50'); assert.equal(page.data.totalText, '5.00');
  assert.equal(body.items[0].model, 'YJV');
  assert.equal(body.items[0].specification, '3×2.5mm²');
});
test('a company switch discards an in-flight customer read and prevents submission', async () => {
  let finish; const pending = new Promise(resolve => { finish = resolve; });
  const env = harness(() => pending); const page = saleForm(env); page.data.customer = null;
  const load = page.loadData(); env.app.companyId = 'another-company'; env.app._companyAccessGeneration++;
  finish({ name: '旧公司的客户', canManageStock: false }); await load;
  assert.equal(page.data.customer, null); assert.match(page.data.error, /企业或登录状态已变化/);
  await page.save({ currentTarget: { dataset: { confirm: '1' } } });
  assert.equal(env.calls.length, 1);
});
test('currency display keeps large decimal values and neighboring customer IDs intact', () => {
  const env = harness(async () => ({}));
  assert.equal(env.retail.money('9999999999999999.99'), '9,999,999,999,999,999.99');
  assert.equal(env.retail.customerView({ id: '2098123456789012345', name: '甲', salesAmount: '12.50' }).id, '2098123456789012345');
  assert.equal(env.retail.centsMoney(env.retail.lineCents('1', '1.005')), '1.01');
  assert.equal(env.retail.centsMoney(env.retail.lineCents('3', '3.335')), '10.01');
  assert.equal(env.retail.centsMoney(env.retail.lineCents('1000000000000.0001', '0.999999')), '999,999,000,000.00');
  assert.equal(env.retail.centsMoney(env.retail.refundCents({ quantity: '1', unitPrice: '3.335', returnedQuantity: '1', returnedAmount: '3.34' })), '3.33');
  assert.equal(env.retail.centsMoney(env.retail.refundCents({ quantity: '1', unitPrice: '3.335', returnedQuantity: '2', returnedAmount: '6.67' })), '3.34');
});

test('a zero-purchase supplier can be created and used to confirm a purchase into a warehouse', async () => {
  const supplierId = '2098123456789012345';
  const documentId = '2098123456789012346';
  const warehouseId = '2098123456789012347';
  const supplier = { id: supplierId, direction: 'PURCHASE', name: '线下门店', canManageStock: true };
  const env = harness(async options => {
    if (options.url === '/warehouses') return [{ id: warehouseId, name: '主仓' }];
    if (options.url === '/retail/customers?direction=PURCHASE' || options.url === `/retail/customers/${supplierId}`) return supplier;
    return { id: documentId, documentType: 'PURCHASE_ORDER' };
  });
  const profiles = env.page('pages/retail-customers/retail-customers.js');
  profiles.onLoad({ create: '1', direction: 'PURCHASE' });
  profiles.onInput({ currentTarget: { dataset: { field: 'name' } }, detail: { value: supplier.name } });
  await profiles.save({ currentTarget: { dataset: { sale: '1' } } });
  assert.equal(env.calls[0].url, '/retail/customers?direction=PURCHASE');
  assert.match(env.routes[0], new RegExp(`customerId=${supplierId}&type=PURCHASE_ORDER&direction=PURCHASE$`));

  const form = env.page('pages/retail-order-form/retail-order-form.js');
  await form.onLoad({ customerId: supplierId, direction: 'PURCHASE', type: 'PURCHASE_ORDER' });
  for (const [field, value] of Object.entries({ productName: '新购电缆', baseUnit: '米', quantity: '2', unitPrice: '3.335' })) {
    form.onItemInput({ currentTarget: { dataset: { index: 0, field } }, detail: { value } });
  }
  form.toggleStock({ detail: { value: true } });
  await form.save({ currentTarget: { dataset: { confirm: '1' } } });
  const order = env.calls.find(call => call.url === `/retail/customers/${supplierId}/documents`);
  const confirmation = env.calls.find(call => call.url === `/retail/documents/${documentId}/confirm`);
  assert.equal(order.data.documentType, 'PURCHASE_ORDER');
  assert.equal(order.data.items[0].productName, '新购电缆');
  assert.equal(confirmation.data.warehouseId, warehouseId);
  assert.equal(form.data.totalText, '6.67');
  assert.match(env.routes.at(-1), new RegExp(`id=${documentId}&direction=PURCHASE$`));
});

test('a purchase return selects confirmed purchases and preserves the original line', async () => {
  const supplierId = '42';
  const originalId = '84';
  const originalLine = { id: '96', lineType: 'PRODUCT', productName: '电缆', model: 'YJV', baseUnit: '米',
    unitPrice: '3.335', returnableQuantity: '2' };
  const env = harness(async options => {
    if (options.url === `/retail/customers/${supplierId}`) return { id: supplierId, direction: 'PURCHASE', name: '线下门店' };
    if (options.url.includes('status=CONFIRMED')) return { items: [{ id: originalId, documentType: 'PURCHASE_ORDER' }] };
    if (options.url === `/retail/documents/${originalId}`) return { id: originalId, documentNo: '原采购单', items: [originalLine] };
    return { id: '100', documentType: 'PURCHASE_RETURN_ORDER' };
  });
  const form = env.page('pages/retail-order-form/retail-order-form.js');
  await form.onLoad({ customerId: supplierId, direction: 'PURCHASE', type: 'PURCHASE_RETURN_ORDER' });
  assert.match(env.calls.at(-1).url, /documentType=PURCHASE_ORDER&status=CONFIRMED/);
  await form.selectOriginal({ currentTarget: { dataset: { id: originalId } } });
  form.onInput({ currentTarget: { dataset: { field: 'remark' } }, detail: { value: '退回多购商品' } });
  form.onItemInput({ currentTarget: { dataset: { index: 0, field: 'quantity' } }, detail: { value: '1' } });
  await form.save({ currentTarget: { dataset: {} } });
  const body = env.calls.at(-1).data;
  assert.equal(body.documentType, 'PURCHASE_RETURN_ORDER');
  assert.equal(body.originalDocumentId, originalId);
  assert.equal(body.items[0].originalItemId, originalLine.id);
  assert.equal(body.items[0].unitPrice, originalLine.unitPrice);
  assert.equal(form.data.totalText, '3.34');
});
