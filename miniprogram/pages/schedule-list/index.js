const { call, getUser, waitForUser } = require("../../utils/call");
const { CELL_STATUS, ROLE, STATUS_META } = require("../../utils/status");

Page({
  data: { ready: false, authorized: false, list: [], errorText: "" },

  onLoad() {
    this._loadSequence = 0;
  },

  async onShow() {
    const sequence = ++this._loadSequence;
    this.setData({ ready: false, authorized: false, list: [], errorText: "" });
    try {
      await waitForUser();
      if (sequence !== this._loadSequence) return;
      if (getUser().role !== ROLE.CAPTAIN) return;
      this.setData({ authorized: true });
      const { list } = await call("ScheduleManager", { action: "getMyMatches" });
      if (sequence !== this._loadSequence) return;
      if (getUser().role !== ROLE.CAPTAIN) {
        this.setData({ authorized: false });
        return;
      }
      this.setData({ list: list.map((match) => {
        const meta = STATUS_META[match.cellStatus] || {};
        return {
          ...match, statusLabel: meta.label || "未知状态", statusColor: meta.color || "#999999",
          actionLabel: match.cellStatus === CELL_STATUS.CANCELLED ? "查看已取消赛程" : "查看 / 管理",
        };
      }) });
    } catch (error) {
      if (sequence === this._loadSequence) this.setData({
        errorText: error.message || "赛程加载失败，请重试",
        ...([401, 403].includes(error.code) ? { authorized: false } : {}),
      });
    } finally {
      if (sequence === this._loadSequence) {
        this.setData({ ready: true });
        wx.stopPullDownRefresh();
      }
    }
  },

  onHide() { this.invalidateLoad(); },

  onUnload() { this.invalidateLoad(); },

  invalidateLoad() {
    this._loadSequence += 1;
    wx.stopPullDownRefresh();
  },

  onPullDownRefresh() {
    return this.onShow();
  },

  onRetry() {
    return this.onShow();
  },

  onOpenMatch(event) {
    if (!this.data.ready || !this.data.authorized || getUser().role !== ROLE.CAPTAIN) return;
    const matchId = event.currentTarget.dataset.id;
    if (!this.data.list.some((match) => match._id === matchId)) return;
    wx.navigateTo({ url: `/pages/schedule-form/index?matchId=${encodeURIComponent(matchId)}` });
  },

  onPublish() {
    if (!this.data.authorized || getUser().role !== ROLE.CAPTAIN) return;
    wx.navigateTo({ url: "/pages/schedule-form/index" });
  },

  onBindIdentity() {
    wx.switchTab({ url: "/pages/profile/index" });
  },
});
