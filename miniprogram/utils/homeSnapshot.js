const SNAPSHOT_PREFIX = 'tradepass_home_snapshot_v1_';
const SNAPSHOT_INDEX_KEY = 'tradepass_home_snapshot_keys';
const USER_ID_KEY = 'tradepass_user_id';
const MAX_SNAPSHOT_AGE = 30 * 24 * 60 * 60 * 1000;
const MAX_SNAPSHOT_COUNT = 18;

function safePart(value) {
  return String(value || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
}

function normalizeContext(context = {}) {
  const role = context.role === 'buyer' ? 'buyer' : 'supplier';
  const period = ['year', 'month', 'last12'].includes(context.period)
    ? context.period : 'year';
  return {
    userId: String(context.userId || ''),
    companyId: String(context.companyId || ''),
    role,
    period
  };
}

function snapshotKey(context) {
  const value = normalizeContext(context);
  if (!value.userId || !value.companyId) return '';
  return SNAPSHOT_PREFIX
    + [value.userId, value.companyId, value.role, value.period].map(safePart).join('_');
}

function removeSnapshotKey(key) {
  if (!key) return;
  try { wx.removeStorageSync(key); } catch (error) {}
  try {
    const keys = wx.getStorageSync(SNAPSHOT_INDEX_KEY);
    if (Array.isArray(keys)) {
      wx.setStorageSync(SNAPSHOT_INDEX_KEY, keys.filter(item => item !== key));
    }
  } catch (error) {}
}

function readHomeSnapshot(context, now = Date.now()) {
  const expected = normalizeContext(context);
  const key = snapshotKey(expected);
  if (!key) return null;
  try {
    const snapshot = wx.getStorageSync(key);
    if (!snapshot || snapshot.version !== 1 || !snapshot.payload
      || String(snapshot.userId || '') !== expected.userId
      || String(snapshot.companyId || '') !== expected.companyId
      || snapshot.role !== expected.role || snapshot.period !== expected.period
      || !Number.isFinite(Number(snapshot.updatedAt))
      || now - Number(snapshot.updatedAt) > MAX_SNAPSHOT_AGE) {
      if (snapshot) removeSnapshotKey(key);
      return null;
    }
    return snapshot;
  } catch (error) {
    return null;
  }
}

function writeHomeSnapshot(context, payload, now = Date.now()) {
  const value = normalizeContext(context);
  const key = snapshotKey(value);
  if (!key || !payload) return null;
  const snapshot = {
    version: 1,
    ...value,
    updatedAt: now,
    payload
  };
  try {
    wx.setStorageSync(key, snapshot);
    const existing = wx.getStorageSync(SNAPSHOT_INDEX_KEY);
    const keys = [key, ...(Array.isArray(existing) ? existing : [])]
      .filter((item, index, list) => item && list.indexOf(item) === index);
    keys.slice(MAX_SNAPSHOT_COUNT).forEach(item => {
      try { wx.removeStorageSync(item); } catch (error) {}
    });
    wx.setStorageSync(SNAPSHOT_INDEX_KEY, keys.slice(0, MAX_SNAPSHOT_COUNT));
    return snapshot;
  } catch (error) {
    return null;
  }
}

function clearCompanyHomeSnapshots(userId, companyId) {
  try {
    const keys = wx.getStorageSync(SNAPSHOT_INDEX_KEY);
    (Array.isArray(keys) ? keys : []).forEach(key => {
      const snapshot = wx.getStorageSync(key);
      if (snapshot && String(snapshot.userId) === String(userId)
        && String(snapshot.companyId) === String(companyId)) removeSnapshotKey(key);
    });
  } catch (error) {}
}

function clearHomeSnapshots() {
  try {
    const keys = wx.getStorageSync(SNAPSHOT_INDEX_KEY);
    (Array.isArray(keys) ? keys : []).forEach(key => {
      try { wx.removeStorageSync(key); } catch (error) {}
    });
    wx.removeStorageSync(SNAPSHOT_INDEX_KEY);
  } catch (error) {}
}

module.exports = {
  USER_ID_KEY,
  clearCompanyHomeSnapshots,
  clearHomeSnapshots,
  normalizeContext,
  readHomeSnapshot,
  snapshotKey,
  writeHomeSnapshot
};
