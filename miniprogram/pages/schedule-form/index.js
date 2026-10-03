const { call, getUser, waitForUser } = require("../../utils/call");
const { CELL_STATUS, ROLE, STATUS_META } = require("../../utils/status");
const { dateTimeFields, buildCreatePayload, createRequestId } = require("../../utils/schedule-form");

const blankForm = () => ({
  sport: "", rival: "", location: "", demands: [], isTbd: false,
  startDate: "", startTime: "", endDate: "", endTime: "",
});
const demandOptions = (selected = []) => [...new Set(["饮用水", "记分", "摄影", ...selected])].map((value) => ({
  value, checked: selected.includes(value),
}));
const editableStatuses = [CELL_STATUS.PENDING, CELL_STATUS.CONFIRMED, CELL_STATUS.HELP, CELL_STATUS.TBD];
const sameDemands = (a, b) => a.length === b.length && a.every((value) => b.includes(value));

Page({
  data: {
    form: blankForm(), demandOptions: demandOptions(), minDate: "",
    ready: false, authorized: false, saving: false, retryPending: false,
    saved: false, editing: false, viewOnly: false, conflict: false,
    errorText: "", statusLabel: "", statusColor: "",
  },

  onLoad(options = {}) {
    this._matchId = options.matchId || "";
    this._pendingSave = null;
    this._loaded = false;
    this._originalMatch = null;
    this._loadSequence = 0;
    this.setData({
      minDate: dateTimeFields(Date.now()).date,
      editing: Boolean(this._matchId), viewOnly: Boolean(this._matchId),
    });
    wx.setNavigationBarTitle({ title: this._matchId ? "编辑赛程" : "发布赛程" });
  },

  async onShow() {
    // 返回页面不能覆盖尚未保存的输入，也不能丢失网络重试的原请求。
    const sequence = ++this._loadSequence;
    this.setData({ ready: false, authorized: false });
    try {
      await waitForUser();
      if (sequence !== this._loadSequence) return;
      const authorized = getUser().role === ROLE.CAPTAIN;
      this.setData({ authorized });
      if (authorized && this._matchId && !this._loaded && !this._pendingSave) {
        this.setData({ viewOnly: true });
        const { match } = await call("ScheduleManager", {
          action: "getMatchForEdit", matchId: this._matchId,
        });
        if (sequence !== this._loadSequence) return;
        if (!match || match._id !== this._matchId || !Number.isSafeInteger(match.version) || match.version < 1) {
          throw new Error("赛程数据不完整，请重新加载");
        }
        const start = match.isTbd ? { date: "", time: "" } : dateTimeFields(match.matchTime);
        const end = match.isTbd ? { date: "", time: "" } : dateTimeFields(match.endTime);
        const meta = STATUS_META[match.cellStatus] || {};
        this._originalMatch = match;
        this.setData({
          form: {
            sport: match.sport, rival: match.rival, location: match.location,
            demands: [...match.demands], isTbd: match.isTbd,
            startDate: start.date, startTime: start.time, endDate: end.date, endTime: end.time,
          },
          demandOptions: demandOptions(match.demands),
          viewOnly: match.isArchived === true || !editableStatuses.includes(match.cellStatus)
            || (!match.isTbd && (match.matchTime <= Date.now() || match.endTime <= Date.now())),
          saved: false, conflict: false, errorText: "",
          statusLabel: meta.label || "", statusColor: meta.color || "#999999",
        });
        this._loaded = true;
      }
    } catch (error) {
      if (sequence === this._loadSequence) this.setData({
        errorText: error.message || "加载失败，请重试",
        ...([401, 403].includes(error.code) ? { authorized: false } : {}),
      });
    } finally {
      if (sequence === this._loadSequence) this.setData({ ready: true });
    }
  },

  isLocked() {
    return !this.data.ready || !this.data.authorized || this.data.saving
      || this.data.retryPending || this.data.saved || this.data.viewOnly || this.data.conflict;
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
    if (!this.data.ready || this.data.saving || this.data.saved || this.data.viewOnly || this.data.conflict) return;
    if (!this.data.authorized || getUser().role !== ROLE.CAPTAIN) {
      this.setData({ authorized: false });
      return;
    }
    if (!this._pendingSave) {
      try {
        this._pendingSave = {
          action: "saveMatch", ...buildCreatePayload(this.data.form, Date.now(), this._originalMatch),
          requestId: createRequestId(),
          ...(this._matchId ? { matchId: this._matchId, version: this._originalMatch.version } : {}),
        };
      } catch (error) {
        this.setData({ errorText: error.message });
        wx.showToast({ title: error.message, icon: "none" });
        return;
      }
    }
    this.setData({ saving: true, errorText: "" });
    try {
      const submitted = this._pendingSave;
      const result = await call("ScheduleManager", submitted);
      if (!result || !result.matchId || (this._matchId && result.matchId !== this._matchId)
        || !STATUS_META[result.cellStatus] || !Number.isSafeInteger(result.version) || result.version < 1) {
        throw new Error("保存结果暂未确认，请重试");
      }
      const demandsChanged = this._originalMatch && !sameDemands(this._originalMatch.demands, submitted.demands);
      const meta = STATUS_META[result.cellStatus];
      this._pendingSave = null;
      this.setData({
        saved: true, retryPending: false,
        statusLabel: meta.label || "", statusColor: meta.color || "#999999",
      });
      wx.showToast({ title: this.data.editing ? "修改成功" : "发布成功", icon: "success" });
      if (demandsChanged) wx.showModal({
        title: "后勤需求已更新", content: "请私聊跟场经理人，告知本次后勤需求的变化。", showCancel: false,
      });
    } catch (error) {
      // 不确定是否已落库的失败保留原 payload/requestId，重试期间锁住表单。
      const definiteFailure = [400, 401, 403, 404, 409, 501].includes(error.code);
      if (definiteFailure) this._pendingSave = null;
      this.setData({
        retryPending: !definiteFailure,
        conflict: Boolean(this._matchId && [404, 409].includes(error.code)),
        errorText: error.message || "网络异常，请重试保存",
        ...([401, 403].includes(error.code) ? { authorized: false } : {}),
      });
    } finally {
      this.setData({ saving: false });
    }
  },

  async onReload() {
    if (this.data.saving || this.data.retryPending) return;
    this._loaded = false;
    await this.onShow();
  },

  onCreateAnother() {
    if (!this.data.saved || this.data.saving || this.data.editing) return;
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
