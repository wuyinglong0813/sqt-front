function formatDateTime(value) {
  const text = String(value || '').trim().replace('T', ' ').replace(/\.\d+/, '');
  const matched = text.match(/^(\d{4}-\d{2}-\d{2})(?: (\d{2}:\d{2})(?::(\d{2}))?)?/);
  if (!matched) return text.slice(0, 19);
  if (!matched[2]) return matched[1];
  return `${matched[1]} ${matched[2]}:${matched[3] || '00'}`;
}

function submissionText(createdAt, businessDate) {
  const submittedAt = formatDateTime(createdAt);
  const business = String(businessDate || '').trim().slice(0, 10);
  if (!submittedAt) return business;
  if (business && !submittedAt.startsWith(business)) return `${business} · ${submittedAt}`;
  return submittedAt;
}

module.exports = { formatDateTime, submissionText };
