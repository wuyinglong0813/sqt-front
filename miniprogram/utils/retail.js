const { request } = require('./request');

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
  return { ...value, id: String(value.id), amountText: money(value.amount),
    statusText: value.status === 'DRAFT' ? '草稿' : value.documentType === 'RETURN_ORDER' ? '已退货' : '已生效' };
}
function customerView(value) {
  return { ...value, id: String(value.id), initial: String(value.name || '客').slice(0, 1),
    typeText: { COMPANY: '企业', INDIVIDUAL_BUSINESS: '个体工商户', PERSON: '个人' }[value.customerType] || '客户',
    salesAmountText: money(value.salesAmount), returnAmountText: money(value.returnAmount), netSalesAmountText: money(value.netSalesAmount) };
}
module.exports = { context, sameContext, retailRequest, money, today, documentView, customerView, lineCents, addCents, centsMoney, refundCents };
