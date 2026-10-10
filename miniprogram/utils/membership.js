const SOURCE_TEXT = { SPECIAL_UNLIMITED: '专属无限签', SPECIAL_QUOTA: '专属免费额度', TRIAL: '上线体验额度', PAID: '已购额度' };
const STATUS_TEXT = { RESERVED: '处理中', UNCERTAIN: '结果待核实', CONSUMED: '已使用', RELEASED: '已释放' };

function presentMembership(value, platform = paymentPlatform()) {
  const status = value || {};
  const blocked = status.signingMode === 'BLOCKED';
  return {
    ...status,
    canPurchaseHere: !!status.purchaseEnabled && Array.isArray(status.purchasePlatforms)
      && status.purchasePlatforms.includes(platform),
    quotaLabel: blocked ? '新发起签署状态' : status.unlimited ? '企业专属签署权益' : '剩余免费签署额度',
    quotaText: blocked ? '暂停新发起' : status.unlimited ? '不限份数' : Number(status.remaining || 0) + ' 份',
    overviewNote: !status.canInitiate ? status.reason || '暂无可用签署额度'
      : status.unlimited ? '当前企业可免费无限签署。'
      : Number(status.remaining || 0) > 0 ? '每成功发起一份新合同使用1份免费额度，双方签署只计1份。'
      : '可使用独立已购额度发起电子签署，每份新合同使用1份。',
    validityText: status.validUntil ? '有效至 ' + status.validUntil + '（北京时间）'
      : status.vip ? '长期有效' : '基础协作继续可用',
    modeText: blocked ? '签署已暂停' : status.unlimited ? '免费无限签'
      : status.signingMode === 'QUOTA' ? '企业专属免费份额' : '企业签署额度'
  };
}
function presentUsage(rows) {
  return (Array.isArray(rows) ? rows : []).map(row => ({
    ...row, sourceText: SOURCE_TEXT[row.source] || row.source,
    statusText: STATUS_TEXT[row.status] || row.status
  }));
}
function paymentPlatform(api = typeof wx === 'undefined' ? null : wx) {
  try {
    const info = api && (typeof api.getDeviceInfo === 'function' ? api.getDeviceInfo() : api.getSystemInfoSync());
    const platform = String(info && info.platform || '').toLowerCase();
    return ['android', 'ios', 'windows', 'mac', 'devtools', 'harmony'].includes(platform) ? platform : 'unknown';
  } catch (e) { return 'unknown'; }
}
function money(fen) { return (Number(fen || 0) / 100).toFixed(2); }
function presentProduct(product) {
  return { ...product, priceText: money(product.amountFen), standardPriceText: money(product.standardAmountFen),
    rightsText: product.type === 'VIP' ? '会员 ' + product.vipDays + ' 天，含 ' + product.signQuota + ' 份电子签'
      : product.signQuota + ' 份电子签署额度',
    expiryText: '签署额度到账起 ' + product.quotaDays + ' 天有效' };
}
function presentOrder(order) {
  return { ...order, priceText: money(order.amountFen),
    rightsText: order.productType === 'VIP' ? 'VIP ' + order.vipDays + ' 天，含 ' + order.signQuota + ' 份电子签'
      : order.signQuota + ' 份电子签署额度' };
}
module.exports = { presentMembership, presentUsage, paymentPlatform, presentProduct, presentOrder };
