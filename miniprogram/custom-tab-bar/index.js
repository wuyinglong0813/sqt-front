const { tabIndicatorTransform } = require('../utils/tabBar');

Component({
  data: {
    hidden: false,
    selected: 0,
    animateIndicator: false,
    indicatorTransform: tabIndicatorTransform(0),
    list: [
      {
        pagePath: '/pages/index/index',
        text: '首页',
        iconPath: '/images/tab/tab_home.png',
        selectedIconPath: '/images/tab/tab_home_on.png'
      },
      {
        pagePath: '/pages/company/company',
        text: '企业',
        iconPath: '/images/tab/tab_company.png',
        selectedIconPath: '/images/tab/tab_company_on.png'
      },
      {
        pagePath: '/pages/me/me',
        text: '我的',
        iconPath: '/images/tab/tab_me.png',
        selectedIconPath: '/images/tab/tab_me_on.png'
      }
    ]
  },

  lifetimes: {
    attached() {
      const app = getApp();
      const pending = app.globalData.tabBarTransition;
      const selected = pending && Number.isInteger(pending.from)
        ? pending.from
        : Number.isInteger(app.globalData.activeTabIndex)
          ? app.globalData.activeTabIndex
          : 0;
      this.setHidden(!!app.globalData.tabBarHidden);
      this.moveTo(selected, false);
    }
  },

  methods: {
    setHidden(hidden) {
      this.setData({ hidden: !!hidden });
    },

    moveTo(index, animate = true) {
      this.setData({
        selected: index,
        animateIndicator: animate,
        indicatorTransform: tabIndicatorTransform(index)
      });
    },

    moveFromTo(fromIndex, nextIndex) {
      this.moveTo(fromIndex, false);
      wx.nextTick(() => this.moveTo(nextIndex, true));
    },

    switchTab(event) {
      const nextIndex = Number(event.currentTarget.dataset.index);
      if (!Number.isInteger(nextIndex) || nextIndex === this.data.selected || this._switching) return;

      const item = this.data.list[nextIndex];
      if (!item) return;

      this._switching = true;
      const app = getApp();
      app.globalData.tabBarTransition = {
        from: this.data.selected,
        to: nextIndex,
        startedAt: Date.now()
      };
      app.globalData.activeTabIndex = nextIndex;

      // 页面立即切换，滑块在目标页用更短动画补完，不再等待动画结束。
      wx.switchTab({
        url: item.pagePath,
        complete: () => { this._switching = false; }
      });
    }
  }
});
