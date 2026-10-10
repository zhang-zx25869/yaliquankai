const { call, getUser, waitForUser } = require("./call");
const { CELL_STATUS, STATUS_META, ROLE, HOURS } = require("./status");
const { createRequestId } = require("./schedule-form");
const identityKey = () => JSON.stringify(getUser());
const isMember = () => [ROLE.MEMBER, ROLE.ADMIN].includes(getUser().role);
const homeCard = () => ({ title: "雅力全开 · 赛事跟场", path: "/pages/index/index" });
const activeMatch = (match) => match && !match.isArchived && !match.isTbd
  && [CELL_STATUS.PENDING, CELL_STATUS.CONFIRMED, CELL_STATUS.HELP].includes(match.cellStatus)
  && match.matchTime > Date.now() && match.endTime > Date.now();
function formatMatch(raw) {
  const meta = raw.isArchived ? { color: "#777777", label: "已归档" } : STATUS_META[raw.cellStatus] || {};
  return { ...raw, statusMeta: meta, confirmerName: raw.confirmerNickname || "",
    started: !activeMatch(raw), myConfirmed: raw.cellStatus === CELL_STATUS.CONFIRMED && activeMatch(raw) };
}
const confirmModal = (match, action) => {
  const cancelling = action === "cancelMyDuty";
  const urgent = cancelling && match.matchTime - Date.now() < HOURS.FORCE_RED * 3600000;
  return {
    title: urgent ? "距开赛不足48小时！" : cancelling ? "取消我的跟场" : action === "declineDuty" ? "暂时没空" : action === "rescueDuty" ? "确认救场" : "确认跟场",
    content: urgent ? "取消后可能需要他人补位，请及时转发求助卡片并私聊部长报备。确定取消吗？"
      : cancelling ? "确定取消本次跟场吗？" : `确定${action === "declineDuty" ? "登记没空" : "跟场"}：${match.teamName} vs ${match.rival}？`,
    confirmText: "确认", cancelText: "再想想",
  };
};

// 两个详情页共享生命周期、请求保护与同步分享规则。
function createDutyPage(mode) {
  return {
    data: {
      role: ROLE.GUEST, roleMember: ROLE.MEMBER, roleAdmin: ROLE.ADMIN,
      cellStatusPending: CELL_STATUS.PENDING, cellStatusConfirmed: CELL_STATUS.CONFIRMED,
      cellStatusHelp: CELL_STATUS.HELP, cellStatusSettle: CELL_STATUS.SETTLE,
      myStatusNone: "none", myStatusConfirmed: "confirmed", myStatusDeclined: "declined",
      match: null, myStatus: "none", stats: [], remainingCount: 0, canHelp: false, redTip: "",
      bannerTitle: "", bannerReason: "", needBind: false, loading: false, errorText: "",
      busy: false, retryPending: false, actionError: "", shareReady: false, shareLoading: false, shareError: "",
    },
    onLoad(options = {}) {
      this.matchId = typeof options.matchId === "string" ? options.matchId : "";
      this._seq = 0; this._shareSeq = 0;
    },
    onShow() {
      this._active = true;
      this.setData({ busy: Boolean(this._busy), retryPending: Boolean(this._pending), actionError: this._actionError || "" });
      return this.fetchData();
    },
    onHide() { this.invalidate(); },
    onUnload() { this.invalidate(); },
    invalidate() {
      this._active = false;
      this._seq += 1;
      this.invalidateShare();
      wx.stopPullDownRefresh();
    },
    invalidateShare() {
      this._shareSeq += 1; this._helpCard = null; this._shareIdentity = null;
      this.setData({ shareReady: false, shareLoading: false, shareError: "" });
      wx.hideShareMenu({ menus: ["shareAppMessage", "shareTimeline"] });
    },
    async fetchData() {
      const seq = ++this._seq;
      this.invalidateShare();
      this.setData({ loading: true, match: null, errorText: "", needBind: false, canHelp: false });
      let identity;
      const current = () => this._active && seq === this._seq && (!identity || identity === identityKey());
      try {
        await waitForUser();
        if (!current()) return;
        identity = identityKey();
        this.setData({ role: getUser().role });
        if (this._pending && this._pending.identity !== identity) {
          this._pending = null; this._actionError = ""; this.setData({ retryPending: false, actionError: "" });
        }
        if (!this.matchId) throw new Error("缺少比赛参数");
        const data = await call("DutyManager", { action: mode === "respond" ? "getRespondPage" : "getRescuePage", matchId: this.matchId }, { loading: false, toast: false });
        if (!current()) return;
        if (!data?.match || data.match._id !== this.matchId) throw new Error("比赛数据异常，请重试");
        const match = formatMatch(data.match);
        const help = Boolean(data.canHelp) && activeMatch(match);
        this.setData({ match, myStatus: data.myStatus || "none", stats: data.stats || [],
          remainingCount: data.remainingCount || 0, canHelp: help,
          redTip: match.cellStatus === CELL_STATUS.HELP ? "本场暂无跟场人，需要部员补位。" : "",
          bannerTitle: match.cellStatus === CELL_STATUS.HELP ? "⚠️ 本场跟场急需支援" : "本场已有人跟场",
          bannerReason: match.cellStatus === CELL_STATUS.HELP ? "本场暂无跟场人，等待有空的部员补位。" : `${match.confirmerNickname || "已有部员"} 已确认`,
        });
      } catch (error) {
        if (current()) this.setData({ needBind: error.code === 401, errorText: error.message || "加载失败，请重试" });
      } finally {
        if (this._active && seq === this._seq) { this.setData({ loading: false }); wx.stopPullDownRefresh(); }
      }
      if (current() && this.data.match) await this.prefetchHelpCard();
    },
    onRetry() { return this.fetchData(); },
    onPullDownRefresh() { return this.fetchData(); },
    onGoBind() { wx.switchTab({ url: "/pages/profile/index" }); },
    canShare() {
      return this._active && !this.data.loading && !this.data.busy && !this.data.retryPending
        && isMember() && activeMatch(this.data.match);
    },
    async prefetchHelpCard() {
      this.invalidateShare();
      if (!this.canShare()) return;
      if (mode === "respond" && [CELL_STATUS.PENDING, CELL_STATUS.CONFIRMED].includes(this.data.match.cellStatus)) {
        this._shareIdentity = identityKey();
        this.setData({ shareReady: true }); wx.showShareMenu({ menus: ["shareAppMessage"] });
        return;
      }
      if (!this.data.canHelp || this.data.match.cellStatus !== CELL_STATUS.HELP) return;
      const seq = this._shareSeq, identity = identityKey(), matchId = this.matchId;
      this.setData({ shareLoading: true });
      try {
        const card = await call("DutyManager", { action: "generateHelpCard", matchId }, { loading: false, toast: false });
        if (seq !== this._shareSeq || identity !== identityKey() || !this.canShare()) return;
        if (!card || typeof card.title !== "string" || !card.title.trim() || card.path !== `/pages/rescue/index?matchId=${encodeURIComponent(matchId)}`) throw new Error("分享信息异常，请重试");
        this._helpCard = { title: card.title, path: card.path }; this._shareIdentity = identity;
        this.setData({ shareReady: true }); wx.showShareMenu({ menus: ["shareAppMessage"] });
      } catch (error) {
        if (seq === this._shareSeq && this._active) this.setData({ shareError: error.message || "分享加载失败，请重试" });
      } finally {
        if (seq === this._shareSeq && this._active) this.setData({ shareLoading: false });
      }
    },
    onShareAppMessage() {
      if (!this.canShare() || !this.data.shareReady || this._shareIdentity !== identityKey()) return homeCard();
      const m = this.data.match;
      if (m.cellStatus === CELL_STATUS.HELP) return this._helpCard ? { ...this._helpCard } : homeCard();
      if (mode === "respond") return { title: `【跟场确认】${m.teamName} vs ${m.rival} ${m.timeText}`, path: `/pages/respond/index?matchId=${encodeURIComponent(m._id)}` };
      return homeCard();
    },
    onConfirm() { return this.performAction("confirmDuty"); },
    onDecline() { return this.performAction("declineDuty"); },
    onRescue() { return this.performAction("rescueDuty"); },
    onCancelDuty() { return this.performAction("cancelMyDuty"); },
    onCancelRescue() { return this.performAction("cancelMyDuty"); },
    onRetryAction() { return this._pending ? this.performAction(this._pending.payload.action, true) : undefined; },
    async performAction(action, retry = false) {
      if (!this._active || this._busy || !isMember() || (this._pending && !retry)) return;
      const identity = identityKey(), seq = this._seq;
      const visible = () => this._active && seq === this._seq && identity === identityKey();
      const sameIdentity = () => this._active && identity === identityKey();
      if (retry && this._pending?.identity !== identity) return;
      if (!retry) {
        const match = this.data.match;
        if (this.data.loading || !activeMatch(match)) return;
        if (action === "cancelMyDuty" && this.data.myStatus !== "confirmed") return;
        if (action === "declineDuty" && match.cellStatus !== CELL_STATUS.PENDING) return;
        if (action === "rescueDuty" && match.cellStatus !== CELL_STATUS.HELP) return;
        if (action === "confirmDuty" && ![CELL_STATUS.PENDING, CELL_STATUS.HELP].includes(match.cellStatus)) return;
      }
      this._busy = true; this._actionError = "";
      this.setData({ busy: true, actionError: "" });
      this.invalidateShare();
      try {
        if (!retry) {
          const { confirm } = await wx.showModal(confirmModal(this.data.match, action));
          if (!confirm || !visible() || !activeMatch(this.data.match)) return;
          this._pending = { identity, payload: { action, matchId: this.matchId, requestId: createRequestId(), dutyToken: this.data.match.dutyToken } };
        }
        const result = await call("DutyManager", this._pending.payload, { loading: false, toast: false });
        if (!result || !Object.values(CELL_STATUS).includes(result.cellStatus)) throw new Error("操作结果暂未确认，请重试");
        this._pending = null;
        if (sameIdentity()) this.setData({ retryPending: false });
        if (sameIdentity()) {
          wx.showToast({ title: action === "cancelMyDuty" ? "已取消跟场" : "操作成功", icon: "success" });
          if (result.canHelp) wx.showModal({ title: "本场需要补位", content: "请刷新后转发求助卡片，并私聊部长报备。", showCancel: false });
        }
      } catch (error) {
        const definite = [400, 401, 403, 404, 409].includes(error.code);
        if (definite) this._pending = null;
        this._actionError = identity === identityKey() ? error.message || "网络异常，请重试同一次操作" : "";
      } finally {
        this._busy = false;
        if (identity !== identityKey()) { this._pending = null; this._actionError = ""; }
        if (this._active) {
          this.setData({ busy: false, retryPending: Boolean(this._pending), actionError: this._actionError });
          await this.fetchData();
        }
      }
    },
  };
}
module.exports = { createDutyPage, formatMatch, activeMatch, identityKey, isMember, confirmModal };
