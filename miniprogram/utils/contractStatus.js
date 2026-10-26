const lifecycleText = {
  PENDING: '待签署', ACTIVE: '履约中', COMPLETED: '已结束',
  VOIDED: '已作废', REJECTED: '已拒绝', CANCELLED: '已撤回'
};

// The server resolves signing progress for the viewing company. Keep that
// perspective separate from the lifecycle used by counts and filters.
function contractStatus(contract) {
  const status = contract.status;
  if (status !== 'PENDING') {
    const terminal = ['COMPLETED', 'VOIDED', 'REJECTED', 'CANCELLED'].includes(status);
    return {
      statusText: (terminal && lifecycleText[status]) || contract.statusText || lifecycleText[status] || status,
      signingStage: ''
    };
  }

  const signingStatus = String(contract.signingStatus || '').toLowerCase();
  const stoppedText = {
    task_terminated: '签署已终止', expired: '签署已过期', task_expired: '签署已过期',
    create_failed: '签署任务准备失败'
  }[signingStatus];
  if (stoppedText) return { statusText: stoppedText, signingStage: 'STOPPED' };

  const processingText = {
    task_finished: '签署结果确认中', sign_completed: '双方已签署，正在归档',
    creating: '正在准备签署文件'
  }[signingStatus];
  if (processingText) return {
    statusText: signingStatus === 'task_finished' && contract.statusText === '签署结果待同步'
      ? contract.statusText : processingText,
    signingStage: 'PROCESSING'
  };

  const statusText = contract.statusText || (['sign_progress', 'finish_creation'].includes(signingStatus)
    ? '签署中' : lifecycleText.PENDING);
  if (['我方已签署，等待对方签署', '待对方签署'].includes(statusText)) {
    return { statusText: '待对方签署', signingStage: 'OTHER' };
  }
  if (['待我方签署', '待己方签署'].includes(statusText)) {
    return { statusText: '待我方签署', signingStage: 'SELF' };
  }
  if (['双方已签署，正在归档', '签署结果确认中', '签署结果待同步', '正在准备签署文件'].includes(statusText)) {
    return { statusText, signingStage: 'PROCESSING' };
  }
  return { statusText, signingStage: 'PENDING' };
}

module.exports = { contractStatus };
