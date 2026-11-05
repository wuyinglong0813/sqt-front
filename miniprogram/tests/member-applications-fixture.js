// Non-invitation page tests isolate their own network traffic from progress polling.
module.exports = {
  memberApplicationData: { memberApplications: [], memberApplicationsLoading: false, memberApplicationsError: '' },
  memberApplicationMethods: { async loadMemberApplications() {}, resetMemberApplicationContext() {} },
  startMemberApplicationIdentity() {}
};
