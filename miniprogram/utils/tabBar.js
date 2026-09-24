function tabIndicatorTransform(index) {
  return `translate3d(${index * 100}%, 0, 0)`;
}

function setTabBarHidden(page, hidden) {
  const shouldHide = !!hidden;
  const app = getApp();
  app.globalData.tabBarHidden = shouldHide;

  if (page && typeof page.getTabBar === 'function') {
    const tabBar = page.getTabBar();
    if (tabBar && typeof tabBar.setHidden === 'function') {
      tabBar.setHidden(shouldHide);
    }
  }

  const method = shouldHide ? wx.hideTabBar : wx.showTabBar;
  if (typeof method === 'function') method({ animation: false });
}

function syncTabBar(page, nextIndex) {
  const app = getApp();
  const previousIndex = app.globalData.activeTabIndex;
  const pending = app.globalData.tabBarTransition;
  const hasPendingTransition = pending
    && pending.to === nextIndex
    && Date.now() - pending.startedAt < 1000;
  const fromIndex = hasPendingTransition ? pending.from : previousIndex;

  app.globalData.activeTabIndex = nextIndex;
  app.globalData.tabBarTransition = null;

  if (!page || typeof page.getTabBar !== 'function') return;
  const tabBar = page.getTabBar();
  if (!tabBar || typeof tabBar.moveTo !== 'function') return;
  if (typeof tabBar.setHidden === 'function') {
    tabBar.setHidden(!!app.globalData.tabBarHidden);
  }

  if (Number.isInteger(fromIndex) && fromIndex !== nextIndex && typeof tabBar.moveFromTo === 'function') {
    tabBar.moveFromTo(fromIndex, nextIndex);
    return;
  }
  tabBar.moveTo(nextIndex, false);
}

module.exports = { setTabBarHidden, syncTabBar, tabIndicatorTransform };
