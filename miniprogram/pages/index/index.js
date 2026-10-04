const { getUser, waitForUser } = require("../../utils/call");
const { ROLE } = require("../../utils/status");

Page({
  data: { isCaptain: false },
  async onShow() {
    this.setData({ isCaptain: false });
    try {
      await waitForUser();
      this.setData({ isCaptain: getUser().role === ROLE.CAPTAIN });
    } catch (_error) {
      // 身份未就绪时保持公开首页，队长入口不显示。
    }
  },
  onPublish() {
    if (getUser().role !== ROLE.CAPTAIN) return;
    wx.navigateTo({ url: "/pages/schedule-form/index" });
  },
  onManage() {
    if (getUser().role !== ROLE.CAPTAIN) return;
    wx.navigateTo({ url: "/pages/schedule-list/index" });
  },
});
