const SOURCE_TEXT = { SPECIAL_UNLIMITED: '专属无限签', SPECIAL_QUOTA: '专属免费额度', TRIAL: '上线体验额度', PAID: '已购额度' };
const STATUS_TEXT = { RESERVED: '处理中', UNCERTAIN: '结果待核实', CONSUMED: '已使用', RELEASED: '已释放' };

function presentMembership(value) {
  const status = value || {};
  const blocked = status.signingMode === 'BLOCKED';
  return {
    ...status,
    quotaText: blocked ? '暂停新发起' : status.unlimited ? '不限份数' : Number(status.remaining || 0) + ' 份',
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
module.exports = { presentMembership, presentUsage };
