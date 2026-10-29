const PROCESSED_INVITES_KEY = 'tradepass_processed_invites';
const MEMBER_IDENTITY_INVITE_KEY = 'tradepass_member_identity_invite';
// Invitations are shared as message cards. Also allow explicitly reopened
// cards from favorites/history and links opened by scanning a code.
const INVITATION_SCENES = [1007, 1008, 1010, 1011, 1012, 1013, 1044, 1047, 1048, 1049, 1096];

function isMemberInviteRejected(error) {
  return [46202, 46203, 46204].includes(Number(error && error.code));
}

function memberInvitePrerequisite(error) {
  return [46103, 46201].includes(Number(error && error.code));
}

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
  const saved = memberIdentityInvite(app);
  if (sameInvite(saved, invite)) wx.removeStorageSync(MEMBER_IDENTITY_INVITE_KEY);
}

// Preserve the accepted invitation while the user leaves the mini program for
// real-name verification. Bind it to the account, never a callback's identity.
function memberIdentityInvite(app) {
  const user = app.globalData.userInfo;
  const saved = wx.getStorageSync(MEMBER_IDENTITY_INVITE_KEY);
  if (!user || !saved || String(saved.userId) !== String(user.id)
      || saved.type !== 'member' || !saved.code || !saved.savedAt
      || Date.now() - saved.savedAt > 24 * 60 * 60 * 1000) return null;
  return saved;
}

function restoreMemberIdentityInvite(app) {
  const pending = app.globalData.pendingInvite;
  const user = app.globalData.userInfo;
  if (pending && pending.identityUserId && (!user || String(pending.identityUserId) !== String(user.id))) {
    app.globalData.pendingInvite = null;
  }
  const saved = memberIdentityInvite(app);
  if (!app.globalData.pendingInvite && saved) app.globalData.pendingInvite = {
    code: saved.code, type: 'member', identityUserId: saved.userId
  };
  return app.globalData.pendingInvite;
}

function startMemberIdentity(app, code) {
  const user = app.globalData.userInfo;
  if (!user || !user.id || !code) return;
  const invite = { code: String(code), type: 'member', identityUserId: String(user.id) };
  app.globalData.pendingInvite = invite;
  wx.setStorageSync(MEMBER_IDENTITY_INVITE_KEY, { ...invite, userId: String(user.id), savedAt: Date.now() });
  wx.navigateTo({ url: '/pages/personal-cert/personal-cert?flow=member-join' });
}

function markInviteProcessed(app, invite, key = processedInviteKey(app, invite)) {
  if (key) {
    const history = processedInvites().filter(item => item !== key);
    try { wx.setStorageSync(PROCESSED_INVITES_KEY, [...history, key].slice(-100)); } catch (error) {}
  }
  dismissInvite(app, invite);
}

module.exports = { captureInviteEntry, dismissInvite, markInviteProcessed, processedInviteKey, wasInviteProcessed,
  memberIdentityInvite, restoreMemberIdentityInvite, startMemberIdentity,
  isMemberInviteRejected, memberInvitePrerequisite };
