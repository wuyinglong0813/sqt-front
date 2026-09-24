// 状态枚举 → 中文文案 + 语义色，统一在各页面复用

const CERTIFICATION = {
  NOT_SUBMITTED: { text: '未提交', color: '#9ca3af' },
  PENDING: { text: '待完善', color: '#f59e0b' },
  PENDING_REVIEW: { text: '审核中', color: '#f59e0b' },
  VERIFIED: { text: '已认证', color: '#2f86e6' },
  REJECTED: { text: '已驳回', color: '#ef4444' }
};

const STEP = {
  NOT_STARTED: { text: '未开始', color: '#9ca3af' },
  NOT_SUBMITTED: { text: '未提交', color: '#9ca3af' },
  NOT_UPLOADED: { text: '未上传', color: '#9ca3af' },
  PENDING_REVIEW: { text: '审核中', color: '#f59e0b' },
  VERIFIED: { text: '已完成', color: '#2f86e6' },
  UPLOADED: { text: '已上传', color: '#2f86e6' }
};

const MEMBER = {
  ACTIVE: { text: '正常', color: '#2f86e6' },
  PENDING: { text: '待审批', color: '#f59e0b' },
  GUEST: { text: '访客', color: '#9ca3af' }
};

function pick(map, key, fallback) {
  return map[key] || fallback || { text: key || '-', color: '#9ca3af' };
}

module.exports = {
  certification: (k) => pick(CERTIFICATION, k),
  step: (k) => pick(STEP, k),
  member: (k) => pick(MEMBER, k)
};
