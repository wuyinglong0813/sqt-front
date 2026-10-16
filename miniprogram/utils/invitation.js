const PROCESSED_INVITES_KEY = 'tradepass_processed_invites';
// Invitations are shared as message cards. Also allow explicitly reopened
// cards from favorites/history and links opened by scanning a code.
const INVITATION_SCENES = [1007, 1008, 1010, 1011, 1012, 1013, 1044, 1047, 1048, 1049, 1096];

function sameInvite(first, second) {
  return !!first && !!second && first.code === second.code && first.type === second.type;
}

function captureInviteEntry(app, options = {}, pageEntry = false) {
  const query = pageEntry ? options : (options.query || {});
  const scene = pageEntry ? (app._lastInviteEntry && app._lastInviteEntry.scene) || 0 : Number(options.scene || 0);
  const invite = query.inviteCode
    ? { code: String(query.inviteCode), type: query.type === 'counterparty' ? 'counterparty' : 'member' } : null;
  const previous = app._lastInviteEntry;
  const entry = { scene, invite };
  if (!pageEntry) app._lastInviteEntry = entry;
  if (!invite) return;
  if (scene && !INVITATION_SCENES.includes(scene)
      && (!pageEntry || (previous && sameInvite(previous.invite, invite)))) return;
  // WeChat can retain the original query (and even share scene) on a resume.
  // A new page load or a changed entry identifies a fresh invitation opening.
  if (!pageEntry && previous && previous.scene === scene && sameInvite(previous.invite, invite)) return;
  if (!sameInvite(app.globalData.pendingInvite, invite)) app.globalData.pendingInvite = invite;
}

function processedInviteKey(app, invite) {
  const user = app.globalData.userInfo;
  return user && user.id && invite ? JSON.stringify([String(user.id), invite.type, invite.code]) : '';
}

function processedInvites() {
  try {
    const value = wx.getStorageSync(PROCESSED_INVITES_KEY);
    return Array.isArray(value) ? value : [];
  } catch (error) { return []; }
}

function wasInviteProcessed(app, invite) {
  const key = processedInviteKey(app, invite);
  return !!key && processedInvites().includes(key);
}

function dismissInvite(app, invite) {
  if (app.globalData.pendingInvite === invite) app.globalData.pendingInvite = null;
}

function markInviteProcessed(app, invite, key = processedInviteKey(app, invite)) {
  if (key) {
    const history = processedInvites().filter(item => item !== key);
    try { wx.setStorageSync(PROCESSED_INVITES_KEY, [...history, key].slice(-100)); } catch (error) {}
  }
  dismissInvite(app, invite);
}

module.exports = { captureInviteEntry, dismissInvite, markInviteProcessed, processedInviteKey, wasInviteProcessed };
