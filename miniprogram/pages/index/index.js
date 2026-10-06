const { call, getUser, waitForUser } = require("../../utils/call");
const { ROLE } = require("../../utils/status");
const { calendarView, shiftMonth } = require("../../utils/calendar");

Page({
  data: {
    isCaptain: false, mode: "upcoming", selectedDate: "", month: "", days: [],
    weekdays: ["日", "一", "二", "三", "四", "五", "六"], rangeLabel: "",
    matches: [], tbdMatches: [], loading: false, errorText: "",
    expandedId: "", detail: null, detailLoading: false, detailError: "",
  },
  onLoad() {
    this.setData(calendarView("upcoming"));
  },
  onShow() {
    this._active = true;
    const identitySeq = this._identitySeq = (this._identitySeq || 0) + 1;
    this.setData({ isCaptain: false });
    // 公开读取不等待静默登录；身份失败也不阻塞日历。
    const identity = (async () => {
      try {
        await waitForUser();
        if (this._active && identitySeq === this._identitySeq) {
          this.setData({ isCaptain: getUser().role === ROLE.CAPTAIN });
        }
      } catch (_error) { /* 保持公开首页 */ }
    })();
    return Promise.all([identity, this.loadCalendar()]);
  },
  onHide() { this.invalidate(); },
  onUnload() { this.invalidate(); },
  invalidate() {
    this._active = false;
    this._calendarSeq = (this._calendarSeq || 0) + 1;
    this._identitySeq = (this._identitySeq || 0) + 1;
    this.resetDetail();
    wx.stopPullDownRefresh();
  },
  resetDetail() {
    this._detailSeq = (this._detailSeq || 0) + 1;
    this.setData({ expandedId: "", detail: null, detailLoading: false, detailError: "" });
  },
  async loadCalendar() {
    const seq = this._calendarSeq = (this._calendarSeq || 0) + 1;
    const view = calendarView(this.data.mode, this.data.selectedDate);
    this.resetDetail();
    this.setData({ ...view, loading: true, errorText: "", matches: [], tbdMatches: [] });
    try {
      const result = await call("CalendarManager", {
        action: "getCalendar", fromTs: view.fromTs, toTs: view.toTs,
      }, { loading: false, toast: false });
      if (!this._active || seq !== this._calendarSeq) return;
      if (!result || !Array.isArray(result.matches) || !Array.isArray(result.tbdMatches)) {
        throw new Error("赛程数据异常，请重试");
      }
      this.setData({ matches: result.matches, tbdMatches: result.tbdMatches });
    } catch (error) {
      if (this._active && seq === this._calendarSeq) {
        this.setData({ errorText: error.message || "赛程加载失败，请检查网络后重试" });
      }
    } finally {
      if (this._active && seq === this._calendarSeq) {
        this.setData({ loading: false });
        wx.stopPullDownRefresh();
      }
    }
  },
  onRetry() { return this.loadCalendar(); },
  onPullDownRefresh() { return this.loadCalendar(); },
  onSelectDay(event) {
    const date = event.currentTarget.dataset.date;
    if (!date) return;
    this.setData({ mode: "day", selectedDate: date });
    return this.loadCalendar();
  },
  onMonthChange(event) {
    this.setData({ mode: "month", selectedDate: `${event.detail.value}-01` });
    return this.loadCalendar();
  },
  onShiftMonth(event) {
    const month = shiftMonth(this.data.month, Number(event.currentTarget.dataset.offset));
    this.setData({ mode: "month", selectedDate: `${month}-01` });
    return this.loadCalendar();
  },
  onWholeMonth() {
    this.setData({ mode: "month", selectedDate: `${this.data.month}-01` });
    return this.loadCalendar();
  },
  onToday() {
    this.setData({ mode: "upcoming" });
    return this.loadCalendar();
  },
  onToggleMatch(event) {
    const id = event.detail.id;
    if (this.data.expandedId === id) { this.resetDetail(); return; }
    if (![...this.data.matches, ...this.data.tbdMatches].some((match) => match._id === id)) return;
    this.resetDetail();
    this.setData({ expandedId: id });
    return this.loadDetail();
  },
  async loadDetail() {
    const matchId = this.data.expandedId;
    if (!matchId) return;
    const seq = this._detailSeq = (this._detailSeq || 0) + 1;
    this.setData({ detail: null, detailLoading: true, detailError: "" });
    try {
      const result = await call("CalendarManager", { action: "getMatchDetail", matchId }, { loading: false, toast: false });
      if (!this._active || seq !== this._detailSeq) return;
      if (!result || !result.match || result.match._id !== matchId) throw new Error("比赛详情异常，请重试");
      this.setData({ detail: result.match });
    } catch (error) {
      if (this._active && seq === this._detailSeq) {
        this.setData({ detailError: error.code === 404 ? "比赛已不存在，请刷新赛程" : error.message || "详情加载失败，请重试" });
      }
    } finally {
      if (this._active && seq === this._detailSeq) this.setData({ detailLoading: false });
    }
  },
  onRetryDetail() { return this.loadDetail(); },
  onPublish() {
    if (getUser().role !== ROLE.CAPTAIN) return;
    wx.navigateTo({ url: "/pages/schedule-form/index" });
  },
  onManage() {
    if (getUser().role !== ROLE.CAPTAIN) return;
    wx.navigateTo({ url: "/pages/schedule-list/index" });
  },
});
