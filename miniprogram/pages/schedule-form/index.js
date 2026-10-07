/* global getCurrentPages */
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
    canCancel: false, confirmingCancel: false, cancelling: false, cancelRetryPending: false, cancelled: false,
    errorText: "", statusLabel: "", statusColor: "",
    shareReady: false, shareLoading: false, shareError: "", shareAvailable: false,
  },

  onLoad(options = {}) {
    this._matchId = options.matchId || "";
    this._pendingSave = null;
    this._pendingCancel = null;
    this._loaded = false;
    this._originalMatch = null;
    this._loadSequence = 0;
    this._shareSequence = 0;
    this._shareMatch = null;
    this._dirty = false;
    this.invalidateShare();
    this.setData({
      minDate: dateTimeFields(Date.now()).date,
      editing: Boolean(this._matchId), viewOnly: Boolean(this._matchId),
    });
    wx.setNavigationBarTitle({ title: this._matchId ? "编辑赛程" : "发布赛程" });
  },

  async onShow() {
    this._visible = true;
    // 返回页面不能覆盖尚未保存的输入，也不能丢失网络重试的原请求。
    const sequence = ++this._loadSequence;
    this.invalidateShare();
    this.setData({ ready: false, authorized: false });
    try {
      await waitForUser();
      if (sequence !== this._loadSequence) return;
      const authorized = getUser().role === ROLE.CAPTAIN;
      this.setData({ authorized });
      if (authorized && this._matchId && !this._loaded && !this._pendingSave) {
        this.setData({ viewOnly: true, canCancel: false });
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
        this._shareMatch = match;
        this._dirty = false;
        this.setData({
          form: {
            sport: match.sport, rival: match.rival, location: match.location,
            demands: [...match.demands], isTbd: match.isTbd,
            startDate: start.date, startTime: start.time, endDate: end.date, endTime: end.time,
          },
          demandOptions: demandOptions(match.demands),
          viewOnly: match.isArchived === true || !editableStatuses.includes(match.cellStatus)
            || (!match.isTbd && (match.matchTime <= Date.now() || match.endTime <= Date.now())),
          canCancel: match.isArchived !== true
            && [...editableStatuses, CELL_STATUS.DUTY_CANCELLED].includes(match.cellStatus)
            && (match.isTbd || match.endTime > Date.now()),
          cancelled: match.cellStatus === CELL_STATUS.CANCELLED,
          saved: false, conflict: false, errorText: "",
          statusLabel: meta.label || "", statusColor: meta.color || "#999999",
        });
        wx.setNavigationBarTitle({ title: this.data.viewOnly ? "赛程详情" : "编辑赛程" });
        this._loaded = true;
        this._savedForm = { ...this.data.form, demands: [...match.demands] };
      }
    } catch (error) {
      if (sequence === this._loadSequence) this.setData({
        errorText: error.message || "加载失败，请重试",
        ...([401, 403].includes(error.code) ? { authorized: false } : {}),
      });
    } finally {
      if (sequence === this._loadSequence) this.setData({ ready: true });
    }
    if (sequence === this._loadSequence && !this.data.errorText) await this.prefetchShare();
  },

  invalidateShare() {
    this._shareSequence += 1;
    this._shareCard = null;
    this._shareIdentity = null;
    this.setData({ shareReady: false, shareLoading: false, shareError: "", shareAvailable: false });
    wx.hideShareMenu({ menus: ["shareAppMessage", "shareTimeline"] });
  },

  canShare() {
    const match = this._shareMatch;
    return this._visible && this.data.ready && this.data.authorized && getUser().role === ROLE.CAPTAIN
      && !this._dirty && !this.data.saving && !this.data.retryPending && !this.data.conflict
      && !this.data.confirmingCancel && !this.data.cancelling && !this.data.cancelRetryPending
      && match && !match.isArchived && editableStatuses.includes(match.cellStatus)
      && (match.isTbd || match.endTime > Date.now());
  },

  async prefetchShare() {
    this.invalidateShare();
    if (!this.canShare()) return;
    const sequence = this._shareSequence;
    const matchId = this._shareMatch._id;
    const identity = JSON.stringify(getUser());
    this.setData({ shareLoading: true, shareAvailable: true });
    try {
      const card = await call("ScheduleManager", { action: "getShareCard", matchId }, { loading: false, toast: false });
      if (sequence !== this._shareSequence || !this.canShare() || identity !== JSON.stringify(getUser())) return;
      if (!card || typeof card.title !== "string" || !card.title.trim()
        || card.path !== `/pages/respond/index?matchId=${encodeURIComponent(matchId)}`) {
        throw new Error("分享信息不完整，请重试");
      }
      this._shareCard = { title: card.title, path: card.path };
      this._shareIdentity = identity;
      this.setData({ shareReady: true });
      wx.showShareMenu({ menus: ["shareAppMessage"] });
    } catch (error) {
      if (sequence !== this._shareSequence) return;
      this.setData({
        shareError: error.message || "分享信息加载失败，请重试",
        shareAvailable: ![401, 403, 404, 409].includes(error.code),
      });
    } finally {
      if (sequence === this._shareSequence) this.setData({ shareLoading: false });
    }
  },

  onShareAppMessage() {
    // 微信要求同步返回；菜单绕过禁用按钮时只分享首页，不发送过期比赛卡片。
    if (this.data.shareReady && this.canShare() && this._shareCard
      && this._shareIdentity === JSON.stringify(getUser())) return { ...this._shareCard };
    return { title: "雅力全开 · 赛事跟场", path: "/pages/index/index" };
  },

  onHide() {
    this._visible = false;
    // 丢弃隐藏期间到达的身份/编辑读取，返回时仍会重新加载；保留保存重试请求。
    this._loadSequence += 1;
    this.invalidateShare();
  },

  onUnload() {
    this._visible = false;
    this._loadSequence += 1;
    this.invalidateShare();
  },

  isLocked() {
    return !this.data.ready || !this.data.authorized || this.data.saving
      || this.data.confirmingCancel || this.data.cancelling || this.data.cancelRetryPending
      || this.data.retryPending || this.data.saved || this.data.viewOnly || this.data.conflict;
  },

  onFieldInput(event) {
    if (this.isLocked()) return;
    const field = event.currentTarget.dataset.field;
    if (!["sport", "rival", "location", "startDate", "startTime", "endDate", "endTime"].includes(field)) return;
    this._dirty = true;
    this.invalidateShare();
    this.setData({ [`form.${field}`]: event.detail.value, errorText: "" });
  },

  onTbdChange(event) {
    if (this.isLocked()) return;
    this._dirty = true;
    this.invalidateShare();
    this.setData({ "form.isTbd": event.detail.value, errorText: "" });
  },

  onDemandsChange(event) {
    if (this.isLocked()) return;
    this._dirty = true;
    this.invalidateShare();
    const selected = event.detail.value;
    this.setData({ "form.demands": selected, demandOptions: demandOptions(selected), errorText: "" });
  },

  async onSave() {
    if (!this.data.ready || this.data.saving || this.data.saved || this.data.viewOnly || this.data.conflict
      || this.data.confirmingCancel || this.data.cancelling || this.data.cancelRetryPending) return;
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
    this.invalidateShare();
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
      this._shareMatch = { ...submitted, _id: result.matchId, cellStatus: result.cellStatus };
      this._dirty = false;
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
    if (this.data.saved) await this.prefetchShare();
  },

  async onReload() {
    if (this.data.saving || this.data.retryPending || this.data.confirmingCancel
      || this.data.cancelling || this.data.cancelRetryPending) return;
    this._loaded = false;
    await this.onShow();
  },

  async onCancel() {
    if (!this.data.ready || !this.data.authorized || !this.data.canCancel || this.data.saved
      || this.data.saving || this.data.retryPending || this.data.conflict
      || this.data.confirmingCancel || this.data.cancelling) return;
    if (getUser().role !== ROLE.CAPTAIN) {
      this.setData({ authorized: false });
      return;
    }
    if (!this._pendingCancel) {
      this.setData({ confirmingCancel: true });
      let confirmed;
      try {
        confirmed = await new Promise((resolve) => wx.showModal({
          title: "确认取消比赛？",
          content: `${this._originalMatch.sport} · 对阵 ${this._originalMatch.rival}。取消后无法恢复，当前跟场确认将被清空，未保存的修改不会提交。`,
          confirmText: "取消比赛", cancelText: "保留比赛", confirmColor: "#b42318",
          success: (result) => resolve(result.confirm === true), fail: () => resolve(false),
        }));
      } finally {
        this.setData({ confirmingCancel: false });
      }
      if (!confirmed) return;
      if (getUser().role !== ROLE.CAPTAIN) {
        this.setData({ authorized: false });
        return;
      }
      this._pendingCancel = {
        action: "cancelMatch", matchId: this._matchId, version: this._originalMatch.version,
      };
    }
    this.invalidateShare();
    this.setData({ cancelling: true, errorText: "" });
    try {
      const result = await call("ScheduleManager", this._pendingCancel);
      if (!result || result.cellStatus !== CELL_STATUS.CANCELLED
        || !Number.isSafeInteger(result.version) || result.version < 1) {
        throw new Error("取消结果暂未确认，请重试");
      }
      this._pendingCancel = null;
      this._originalMatch = { ...this._originalMatch, cellStatus: result.cellStatus, version: result.version };
      this._shareMatch = this._originalMatch;
      const meta = STATUS_META[CELL_STATUS.CANCELLED];
      this.setData({
        cancelled: true, canCancel: false, viewOnly: true, cancelRetryPending: false,
        form: this._savedForm, demandOptions: demandOptions(this._savedForm.demands),
        statusLabel: meta.label, statusColor: meta.color,
      });
      // 重新读回已保存字段，避免把取消前未提交的草稿显示成云端详情。
      this._loaded = false;
      await this.onShow();
      wx.showToast({ title: "比赛已取消", icon: "success" });
    } catch (error) {
      const definiteFailure = [400, 401, 403, 404, 409, 501].includes(error.code);
      if (definiteFailure) this._pendingCancel = null;
      this.setData({
        cancelRetryPending: !definiteFailure,
        conflict: [404, 409].includes(error.code),
        errorText: error.message || "网络异常，请重试取消",
        ...([401, 403].includes(error.code) ? { authorized: false } : {}),
      });
    } finally {
      this.setData({ cancelling: false });
    }
  },

  onManage() {
    if (this.data.saving || this.data.retryPending || this.data.confirmingCancel
      || this.data.cancelling || this.data.cancelRetryPending || getUser().role !== ROLE.CAPTAIN) return;
    const pages = getCurrentPages();
    if (pages.length > 1 && pages[pages.length - 2].route === "pages/schedule-list/index") {
      wx.navigateBack({ delta: 1 });
    } else {
      wx.redirectTo({ url: "/pages/schedule-list/index" });
    }
  },

  onCreateAnother() {
    if (!this.data.saved || this.data.saving || this.data.editing) return;
    this._pendingSave = null;
    this._shareMatch = null;
    this._dirty = false;
    this.invalidateShare();
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
