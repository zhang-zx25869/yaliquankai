const { call, getUser, waitForUser } = require("../../utils/call");
const { ROLE, STATUS_META } = require("../../utils/status");
const { dateTimeFields, buildCreatePayload, createRequestId } = require("../../utils/schedule-form");

const blankForm = () => ({
  sport: "", rival: "", location: "", demands: [], isTbd: false,
  startDate: "", startTime: "", endDate: "", endTime: "",
});
const demandOptions = (selected = []) => ["饮用水", "记分", "摄影"].map((value) => ({
  value, checked: selected.includes(value),
}));

Page({
  data: {
    form: blankForm(),
    demandOptions: demandOptions(),
    minDate: "",
    ready: false,
    authorized: false,
    saving: false,
    retryPending: false,
    saved: false,
    viewOnly: false,
    errorText: "",
    statusLabel: "",
    statusColor: "",
  },

  onLoad(options = {}) {
    this._matchId = options.matchId || "";
    this._pendingSave = null;
    this.setData({ minDate: dateTimeFields(Date.now()).date, viewOnly: Boolean(this._matchId) });
    wx.setNavigationBarTitle({ title: this._matchId ? "赛程详情" : "发布赛程" });
  },

  async onShow() {
    this.setData({ ready: false, authorized: false, errorText: "" });
    try {
      await waitForUser();
      const authorized = getUser().role === ROLE.CAPTAIN;
      this.setData({ authorized });
      if (authorized && this._matchId) {
        const { match } = await call("ScheduleManager", {
          action: "getMatchForEdit", matchId: this._matchId,
        });
        const start = match.isTbd ? { date: "", time: "" } : dateTimeFields(match.matchTime);
        const end = match.isTbd ? { date: "", time: "" } : dateTimeFields(match.endTime);
        const meta = STATUS_META[match.cellStatus] || {};
        this.setData({
          form: {
            sport: match.sport, rival: match.rival, location: match.location,
            demands: match.demands, isTbd: match.isTbd,
            startDate: start.date, startTime: start.time, endDate: end.date, endTime: end.time,
          },
          demandOptions: demandOptions(match.demands),
          statusLabel: meta.label || "", statusColor: meta.color || "#999999",
        });
      }
    } catch (error) {
      this.setData({ errorText: error.message || "加载失败，请重试" });
    } finally {
      this.setData({ ready: true });
    }
  },

  isLocked() {
    return !this.data.ready || !this.data.authorized || this.data.saving
      || this.data.retryPending || this.data.saved || this.data.viewOnly;
  },

  onFieldInput(event) {
    if (this.isLocked()) return;
    const field = event.currentTarget.dataset.field;
    if (!["sport", "rival", "location", "startDate", "startTime", "endDate", "endTime"].includes(field)) return;
    this.setData({ [`form.${field}`]: event.detail.value, errorText: "" });
  },

  onTbdChange(event) {
    if (this.isLocked()) return;
    this.setData({ "form.isTbd": event.detail.value, errorText: "" });
  },

  onDemandsChange(event) {
    if (this.isLocked()) return;
    const selected = event.detail.value;
    this.setData({ "form.demands": selected, demandOptions: demandOptions(selected), errorText: "" });
  },

  async onSave() {
    if (!this.data.ready || this.data.saving || this.data.saved || this.data.viewOnly) return;
    if (!this.data.authorized || getUser().role !== ROLE.CAPTAIN) {
      this.setData({ authorized: false });
      return;
    }
    if (!this._pendingSave) {
      try {
        this._pendingSave = {
          action: "saveMatch", ...buildCreatePayload(this.data.form), requestId: createRequestId(),
        };
      } catch (error) {
        this.setData({ errorText: error.message });
        wx.showToast({ title: error.message, icon: "none" });
        return;
      }
    }
    this.setData({ saving: true, errorText: "" });
    try {
      const result = await call("ScheduleManager", this._pendingSave);
      if (!result || !result.matchId || !STATUS_META[result.cellStatus] || !Number.isInteger(result.version)) {
        throw new Error("发布结果暂未确认，请重试");
      }
      const meta = STATUS_META[result.cellStatus];
      this._pendingSave = null;
      this.setData({
        saved: true, retryPending: false,
        statusLabel: meta.label || "", statusColor: meta.color || "#999999",
      });
      wx.showToast({ title: "发布成功", icon: "success" });
    } catch (error) {
      // 不确定是否已落库的失败保留原 payload/requestId，重试期间锁住表单。
      const definiteFailure = [400, 401, 403, 404, 409, 501].includes(error.code);
      if (definiteFailure) this._pendingSave = null;
      this.setData({
        retryPending: !definiteFailure,
        errorText: error.message || "网络异常，请重试发布",
        ...([401, 403].includes(error.code) ? { authorized: false } : {}),
      });
    } finally {
      this.setData({ saving: false });
    }
  },

  onCreateAnother() {
    if (!this.data.saved || this.data.saving) return;
    this._pendingSave = null;
    this.setData({
      form: blankForm(), demandOptions: demandOptions(),
      saved: false, retryPending: false, errorText: "", statusLabel: "", statusColor: "",
      minDate: dateTimeFields(Date.now()).date,
    });
  },

  onBindIdentity() {
    wx.switchTab({ url: "/pages/profile/index" });
  },
});
