const { request } = require('./request');

const saleTerms = {
  isPurchase: false, business: '零售', party: '客户', action: '销售', order: '销售单', returnOrder: '退货单',
  orderType: 'SALES_ORDER', returnType: 'RETURN_ORDER', address: '收货地址', directionParam: ''
};
const purchaseTerms = {
  isPurchase: true, business: '零采', party: '供应商', action: '采购', order: '采购单', returnOrder: '采购退货单',
  orderType: 'PURCHASE_ORDER', returnType: 'PURCHASE_RETURN_ORDER', address: '供应商地址', directionParam: '&direction=PURCHASE'
};
function retailTerms(direction) {
  return direction === 'PURCHASE' ? purchaseTerms : saleTerms;
}
function documentTerms(type) {
  return type === purchaseTerms.orderType || type === purchaseTerms.returnType ? purchaseTerms : saleTerms;
}

function context() {
  const app = getApp();
  return { companyId: String(app.getCurrentCompanyId() || ''), token: app.globalData.token,
    generation: app._companyAccessGeneration || 0 };
}
function sameContext(value) {
  const current = context();
  return value && value.companyId && value.companyId === current.companyId
    && value.token === current.token && value.generation === current.generation;
}
async function retailRequest(value, options) {
  if (!sameContext(value)) throw new Error('企业或登录状态已变化，请返回首页');
  const result = await request({ ...options, companyId: value.companyId, handleCompanyForbidden: false });
  if (!sameContext(value)) throw new Error('企业或登录状态已变化，请返回首页');
  return result;
}
function money(value) {
  const match = String(value == null ? '0' : value).match(/^(-?)(\d+)(?:\.(\d+))?$/);
  if (!match) return '0.00';
  return match[1] + match[2].replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + ((match[3] || '') + '00').slice(0, 2);
}
function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function addCents(left, right) {
  left = String(left); right = String(right);
  let carry = 0, result = '', i = left.length - 1, j = right.length - 1;
  while (i >= 0 || j >= 0 || carry) {
    const value = Number(left[i--] || 0) + Number(right[j--] || 0) + carry;
    result = String(value % 10) + result; carry = Math.floor(value / 10);
  }
  return result || '0';
}
// Calculate decimal line amounts in cents without floating-point rounding or BigInt requirements.
function lineCents(quantity, price) {
  const parse = value => {
    const match = String(value || '0').match(/^(\d+)(?:\.(\d*))?$/);
    return match ? { digits: (match[1] + (match[2] || '')).replace(/^0+/, '') || '0', scale: (match[2] || '').length } : { digits: '0', scale: 0 };
  };
  const a = parse(quantity), b = parse(price), digits = Array(a.digits.length + b.digits.length).fill(0);
  for (let i = a.digits.length - 1; i >= 0; i--) for (let j = b.digits.length - 1; j >= 0; j--)
    digits[i + j + 1] += Number(a.digits[i]) * Number(b.digits[j]);
  for (let i = digits.length - 1; i > 0; i--) { digits[i - 1] += Math.floor(digits[i] / 10); digits[i] %= 10; }
  const value = digits.join('').replace(/^0+/, '') || '0', shift = a.scale + b.scale - 2;
  if (shift <= 0) return (value + '0'.repeat(-shift)).replace(/^0+/, '') || '0';
  const padded = value.padStart(shift + 1, '0'), split = padded.length - shift;
  const cents = padded.slice(0, split).replace(/^0+/, '') || '0';
  return Number(padded[split]) >= 5 ? addCents(cents, '1') : cents;
}
function centsMoney(value) {
  const digits = String(value).padStart(3, '0');
  return money(digits.slice(0, -2) + '.' + digits.slice(-2));
}
function scaledDigits(value, scale) {
  const match = String(value || '0').match(/^(\d+)(?:\.(\d*))?$/);
  return match ? (match[1] + (match[2] || '').padEnd(scale, '0').slice(0, scale)).replace(/^0+/, '') || '0' : '0';
}
function subtractCents(left, right) {
  left = String(left).replace(/^0+/, '') || '0'; right = String(right).replace(/^0+/, '') || '0';
  if (left.length < right.length || (left.length === right.length && left < right)) return '0';
  let borrow = 0, result = '', j = right.length - 1;
  for (let i = left.length - 1; i >= 0; i--) {
    let value = Number(left[i]) - Number(right[j--] || 0) - borrow;
    borrow = value < 0 ? 1 : 0; if (borrow) value += 10; result = value + result;
  }
  return result.replace(/^0+/, '') || '0';
}
function refundCents(item) {
  const digits = addCents(scaledDigits(item.returnedQuantity, 4), scaledDigits(item.quantity, 4)).padStart(5, '0');
  const totalQuantity = digits.slice(0, -4) + '.' + digits.slice(-4);
  return subtractCents(lineCents(totalQuantity, item.unitPrice), scaledDigits(item.returnedAmount, 2));
}
function documentView(value) {
  const terms = documentTerms(value.documentType);
  const isReturn = value.documentType === terms.returnType;
  return { ...value, id: String(value.id), amountText: money(value.amount),
    isReturn, statusText: value.status === 'DRAFT' ? '草稿' : isReturn ? '已退货' : '已生效' };
}
function customerView(value) {
  const terms = retailTerms(value.direction);
  const { isPurchase } = terms;
  return { ...value, id: String(value.id), initial: String(value.name || terms.party).slice(0, 1),
    typeText: { COMPANY: '企业', INDIVIDUAL_BUSINESS: '个体工商户', PERSON: '个人' }[value.customerType] || terms.party,
    salesAmountText: money(value.salesAmount), netSalesAmountText: money(value.netSalesAmount),
    purchaseAmountText: money(value.purchaseAmount), netPurchaseAmountText: money(value.netPurchaseAmount),
    returnAmountText: money(value.returnAmount),
    tradeAmountText: money(isPurchase ? value.purchaseAmount : value.salesAmount),
    tradeOrderCount: isPurchase ? value.purchaseOrderCount : value.salesOrderCount,
    netTradeAmountText: money(isPurchase ? value.netPurchaseAmount : value.netSalesAmount) };
}
module.exports = { context, sameContext, retailRequest, money, today, documentView, customerView, retailTerms, documentTerms,
  lineCents, addCents, centsMoney, refundCents };
